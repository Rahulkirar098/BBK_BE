import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { sendBookingSMS, sendPaymentConfirmationSMS } from "./twilio.js";

dotenv.config();

/* =========================================================
   TYPES
========================================================= */

export const SESSION_STATUS = {
  OPEN: "open",
  MIN_REACHED: "min_reached",
  FULL: "full",
  CLAIMED: "claimed",
  CANCELLED: "cancelled",
} as const;

export type SessionStatus =
  typeof SESSION_STATUS[keyof typeof SESSION_STATUS];

export const RIDER_PAYMENT_STATUS = {
  AUTHORIZED: "authorized", // hold
  CAPTURED: "captured",     // success
  CANCELLED: "cancelled"   // released
} as const;

export type RiderPaymentStatus =
  typeof RIDER_PAYMENT_STATUS[keyof typeof RIDER_PAYMENT_STATUS];

/* =========================================================
   INIT
========================================================= */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2026-01-28.clover",
});

const db = admin.firestore();

/* =========================================================
   HELPERS
========================================================= */

const isFinalStatus = (status: SessionStatus) => {
  return (
    status === SESSION_STATUS.CLAIMED ||
    status === SESSION_STATUS.CANCELLED
  );
};

const canClaim = (status: SessionStatus) => {
  return (
    status === SESSION_STATUS.MIN_REACHED ||
    status === SESSION_STATUS.FULL
  );
};

//////////////

app.get('/', (req, res) => {
  res.send('Welcome to the API!...');
});

/* =========================================================
   1️⃣ CREATE PAYMENT INTENT (HOLD FUNDS)
========================================================= */

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { sessionId, operatorUid, riderUid, operatorStripeAccountId, seatsCount } = req.body;

    if (!sessionId || !operatorUid || !riderUid || !operatorStripeAccountId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const requestedSeats = Math.max(1, Math.min(parseInt(seatsCount) || 1, 10)); // max 10 seats per booking

    const sessionRef = db.collection("slots").doc(sessionId);
    const snap = await sessionRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session: any = snap.data();

    const status: SessionStatus =
      session.status || SESSION_STATUS.OPEN;

    // ❌ Block booking if activity already started/ended
    if (
      session.activityStatus === 'started' ||
      session.activityStatus === 'ended'
    ) {
      throw new Error(
        'Booking closed. Session already started or ended.'
      );
    }

    if (isFinalStatus(status)) {
      return res.status(400).json({ error: "Session not bookable" });
    }

    const availableSeats = session.totalSeats - session.bookedSeats;
    if (requestedSeats > availableSeats) {
      return res.status(400).json({ error: `Only ${availableSeats} seats available` });
    }

    const totalAmount = session.pricePerSeat * requestedSeats * 100; // in cents

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: "aed",
      capture_method: "manual",
      metadata: {
        sessionId,
        operatorUid,
        riderUid,
        seatsCount: requestedSeats.toString(),
      },
    },
      {
        stripeAccount: operatorStripeAccountId,
      }
    );

    return res.json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      seatsCount: requestedSeats,
      totalAmount: totalAmount / 100, // in AED for display
    });
  } catch (err: any) {
    console.error("Create PaymentIntent error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   2️⃣ FINALIZE BOOKING
========================================================= */

app.post("/finalize-booking", async (req, res) => {
  try {
    const {
      sessionId,
      operatorUid,
      riderUid,
      paymentIntentId,
      seatsCount,
    } = req.body;

    // =====================================================
    // VALIDATION
    // =====================================================

    if (
      !sessionId ||
      !operatorUid ||
      !riderUid ||
      !paymentIntentId
    ) {
      return res.status(400).json({
        error: "Missing parameters",
      });
    }

    const requestedSeats = Math.max(
      1,
      Math.min(parseInt(seatsCount) || 1, 10)
    );

    // =====================================================
    // REFS
    // =====================================================

    const sessionRef =
      db.collection("slots").doc(sessionId);

    const riderRef =
      db.collection("users").doc(riderUid);

    // aggregate doc
    const bookingRef = sessionRef
      .collection("booking")
      .doc(riderUid);

    // immutable booking record
    const bookingGlobalRef =
      db.collection("bookings").doc();

    // chat
    const chatRef =
      db.collection("chats").doc(sessionId);

    const membersRef =
      chatRef.collection("members");

    const messageRef =
      chatRef.collection("messages").doc();

    // =====================================================
    // TRANSACTION
    // =====================================================

    await db.runTransaction(async (tx) => {
      // ---------------------------------------------------
      // READS
      // ---------------------------------------------------

      const [
        sessionSnap,
        riderSnap,
        existingBookingSnap,
        chatSnap,
      ] = await Promise.all([
        tx.get(sessionRef),
        tx.get(riderRef),
        tx.get(bookingRef),
        tx.get(chatRef),
      ]);

      // ---------------------------------------------------
      // VALIDATE DOCUMENTS
      // ---------------------------------------------------

      if (!sessionSnap.exists) {
        throw new Error("Session not found");
      }

      if (!riderSnap.exists) {
        throw new Error("Rider not found");
      }

      // ---------------------------------------------------
      // DATA
      // ---------------------------------------------------

      const session: any = sessionSnap.data();

      const rider: any = riderSnap.data();

      const currentStatus: SessionStatus =
        session.status || SESSION_STATUS.OPEN;

      // ---------------------------------------------------
      // SESSION STATE VALIDATION
      // ---------------------------------------------------

      if (
        session.activityStatus === "started" ||
        session.activityStatus === "ended"
      ) {
        throw new Error(
          "Booking closed. Session already started or ended."
        );
      }

      if (
        currentStatus === SESSION_STATUS.CANCELLED ||
        currentStatus === SESSION_STATUS.CLAIMED
      ) {
        throw new Error("Session not bookable");
      }

      // ---------------------------------------------------
      // SEAT VALIDATION
      // ---------------------------------------------------

      const availableSeats =
        session.totalSeats - session.bookedSeats;

      if (requestedSeats > availableSeats) {
        throw new Error(
          `Only ${availableSeats} seats available`
        );
      }

      // ---------------------------------------------------
      // EXISTING AGGREGATE BOOKING
      // ---------------------------------------------------

      const existingBooking =
        existingBookingSnap.exists
          ? existingBookingSnap.data()
          : null;

      const existingSeats =
        existingBooking?.seatsBooked || 0;

      const newTotalSeats =
        existingSeats + requestedSeats;

      // ---------------------------------------------------
      // RIDER SNAPSHOT
      // ---------------------------------------------------

      const riderData = {
        name:
          rider.userProfile?.name ??
          rider.displayName ??
          null,

        phone:
          rider.userProfile?.phone_no ??
          null,

        photoURL:
          rider.photoURL ?? null,

        email:
          rider.email ?? null,
      };

      // ---------------------------------------------------
      // SESSION STATUS CALCULATION
      // ---------------------------------------------------

      const newBookedSeats =
        session.bookedSeats + requestedSeats;

      let newStatus = currentStatus;

      if (
        newBookedSeats >= session.totalSeats
      ) {
        newStatus = SESSION_STATUS.FULL;
      } else if (
        newBookedSeats >=
        session.minRidersToConfirm &&
        currentStatus ===
        SESSION_STATUS.OPEN
      ) {
        newStatus =
          SESSION_STATUS.MIN_REACHED;
      }

      // ===================================================
      // AGGREGATE RIDER BOOKING DOC
      // ===================================================

      tx.set(
        bookingRef,
        {
          riderUid,

          rider: riderData,

          // total seats across all attempts
          seatsBooked: newTotalSeats,

          // latest booking status
          status:
            RIDER_PAYMENT_STATUS.AUTHORIZED,

          // all booking ids
          bookingIds:
            admin.firestore.FieldValue.arrayUnion(
              bookingGlobalRef.id
            ),

          lastPaymentIntentId:
            paymentIntentId,

          lastBookingId:
            bookingGlobalRef.id,

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          createdAt:
            existingBookingSnap.exists
              ? existingBooking?.createdAt
              : admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // ===================================================
      // GLOBAL IMMUTABLE BOOKING RECORD
      // ===================================================

      tx.set(bookingGlobalRef, {
        // ids
        bookingId:
          bookingGlobalRef.id,

        slotId: sessionId,

        riderId: riderUid,

        operatorId: operatorUid,

        // rider snapshot
        rider: riderData,

        // session snapshot
        sessionSnapshot: {
          title:
            session.title ?? null,

          date:
            session.date ?? null,

          startTime:
            session.startTime ?? null,

          endTime:
            session.endTime ?? null,

          pickup:
            session.pickup ?? null,

          dropoff:
            session.dropoff ?? null,

          operator:
            session.operator ?? null,

          pricePerSeat:
            session.pricePerSeat ??
            null,
        },

        // booking
        seatsBooked:
          requestedSeats,

        totalAmount:
          (session.pricePerSeat || 0) *
          requestedSeats,

        // payment
        paymentIntentId,

        paymentStatus:
          RIDER_PAYMENT_STATUS.AUTHORIZED,

        captureStatus: "pending",

        // booking status
        status: "booked",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // ===================================================
      // UPDATE SESSION
      // ===================================================

      tx.update(sessionRef, {
        bookedSeats:
          newBookedSeats,

        status: newStatus,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // ===================================================
      // CREATE CHAT ONCE
      // ===================================================

      if (!chatSnap.exists) {
        tx.set(chatRef, {
          sessionId,

          operatorId:
            operatorUid,

          membersIds: [
            operatorUid,
          ],

          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),

          lastMessage: null,
        });
      }

      // ===================================================
      // ADD RIDER MEMBER
      // ===================================================

      tx.set(
        membersRef.doc(riderUid),
        {
          userId: riderUid,

          role: "rider",

          name:
            riderData.name,

          photoURL:
            riderData.photoURL,

          joinedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // ===================================================
      // ENSURE OPERATOR MEMBER
      // ===================================================

      tx.set(
        membersRef.doc(operatorUid),
        {
          userId: operatorUid,

          role: "operator",

          name:
            session?.operator
              ?.name ?? null,

          photoURL:
            session?.operator
              ?.photoURL ??
            null,

          joinedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // ===================================================
      // FAST QUERY MEMBERS IDS
      // ===================================================

      tx.set(
        chatRef,
        {
          membersIds:
            admin.firestore.FieldValue.arrayUnion(
              riderUid
            ),
        },
        { merge: true }
      );

      // ===================================================
      // SYSTEM MESSAGE
      // ===================================================

      tx.set(messageRef, {
        type: "system",

        text: `${riderData.name ||
          "A rider"
          } joined the chat`,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // =====================================================
    // SMS AFTER TRANSACTION
    // =====================================================

    const [
      finalSessionSnap,
      finalRiderSnap,
    ] = await Promise.all([
      sessionRef.get(),
      riderRef.get(),
    ]);

    const finalSession =
      finalSessionSnap.data() as any;

    const finalRider =
      finalRiderSnap.data() as any;

    const finalRiderData = {
      name:
        finalRider.displayName ||
        "Rider",

      phone:
        finalRider.userProfile
          ?.phone_no ?? null,
    };

    if (finalRiderData.phone) {
      sendBookingSMS(
        finalRiderData.phone,
        finalSession,
        finalRiderData.name,
        requestedSeats
      ).catch(console.error);
    }

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,

      bookingId:
        bookingGlobalRef.id,

      seatsBooked:
        requestedSeats,
    });
  } catch (err: any) {
    console.error(
      "Finalize booking error:",
      err
    );

    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

/* =========================================================
    CONNECT ACCOUNT 
========================================================= */
app.post("/create-connect-account", async (req, res) => {
  try {
    const { operatorUid, email } = req.body;

    if (!operatorUid || !email) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const operatorRef = db.doc(`users/${operatorUid}`);
    const snap = await operatorRef.get();

    // If already created
    if (snap.exists && snap.data()?.stripeAccountId) {
      return res.json({
        stripeAccountId: snap.data()?.stripeAccountId,
      });
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "AE",
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });


    await operatorRef.set(
      {
        stripeAccountId: account.id,
        onboardingComplete: false,
      },
      { merge: true }
    );

    return res.json({
      stripeAccountId: account.id,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: `Hello ${err.message}` });
  }
});

app.post("/create-account-link", async (req, res) => {
  try {
    const { operatorUid } = req.body;

    const operatorRef = db.doc(`users/${operatorUid}`);
    const snap = await operatorRef.get();

    if (!snap.exists || !snap.data()?.stripeAccountId) {
      return res.status(400).json({ error: "Connect account not found" });
    }

    const accountLink = await stripe.accountLinks.create({
      account: snap.data()?.stripeAccountId,
      refresh_url: "https://bbk-be-1smn.vercel.app/reauth",
      return_url: "https://bbk-be-1smn.vercel.app/success",
      type: "account_onboarding",
    });

    return res.json({
      url: accountLink.url,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/reauth", (req, res) => {
  res.send("Re-auth required. Please try onboarding again.");
});

app.get("/success", (req, res) => {
  res.send("Onboarding completed successfully ✅");
});

app.get("/check-onboarding-status/:operatorUid", async (req, res) => {
  try {
    const { operatorUid } = req.params;

    const operatorRef = db.doc(`users/${operatorUid}`);
    const snap = await operatorRef.get();

    if (!snap.exists || !snap.data()?.stripeAccountId) {
      return res.status(400).json({ error: "Account not found" });
    }

    const account = await stripe.accounts.retrieve(
      snap.data()?.stripeAccountId
    );

    const isComplete =
      account.details_submitted &&
      account.charges_enabled &&
      account.payouts_enabled;

    await operatorRef.update({
      onboardingComplete: isComplete,
    });

    return res.status(200).json({
      onboardingComplete: isComplete,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   CAPTURE AMOUNT
========================================================= */

app.post("/capture-payment", async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        error: "Missing bookingId",
      });
    }

    // =====================================================
    // GLOBAL BOOKING
    // =====================================================

    const bookingRef =
      db.collection("bookings").doc(bookingId);

    const bookingSnap =
      await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({
        error: "Booking not found",
      });
    }

    const booking: any =
      bookingSnap.data();

    // =====================================================
    // ALREADY CAPTURED
    // =====================================================

    if (
      booking.paymentStatus ===
      RIDER_PAYMENT_STATUS.CAPTURED
    ) {
      return res.status(400).json({
        error: "Already captured",
      });
    }

    // =====================================================
    // SESSION
    // =====================================================

    const sessionRef = db
      .collection("slots")
      .doc(booking.slotId);

    const sessionSnap =
      await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    const session: any =
      sessionSnap.data();

    const operatorStripeAccountId =
      session.stripeAccountId;

    // =====================================================
    // STRIPE CAPTURE
    // =====================================================

    await stripe.paymentIntents.capture(
      booking.paymentIntentId,
      {},
      {
        stripeAccount:
          operatorStripeAccountId,
      }
    );

    // =====================================================
    // UPDATE GLOBAL BOOKING
    // =====================================================

    await bookingRef.update({
      paymentStatus:
        RIDER_PAYMENT_STATUS.CAPTURED,

      capturedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    // =====================================================
    // UPDATE AGGREGATE BOOKING
    // =====================================================

    const aggregateBookingRef =
      sessionRef
        .collection("booking")
        .doc(booking.riderId);

    const aggregateSnap =
      await aggregateBookingRef.get();

    if (aggregateSnap.exists) {
      const aggregate: any =
        aggregateSnap.data();

      const updatedAttempts =
        (
          aggregate.bookingAttempts || []
        ).map((attempt: any) => {
          if (
            attempt.bookingId === bookingId
          ) {
            return {
              ...attempt,
              paymentStatus:
                RIDER_PAYMENT_STATUS.CAPTURED,

              capturedAt: new Date(),
            };
          }

          return attempt;
        });

      await aggregateBookingRef.update({
        bookingAttempts:
          updatedAttempts,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // =====================================================
    // SMS
    // =====================================================

    const riderPhone =
      booking?.rider?.phone;

    if (riderPhone) {
      sendPaymentConfirmationSMS(
        riderPhone,
        session,
        booking?.rider?.name || "Rider"
      ).catch(console.error);
    }

    return res.status(200).json({
      success: true,
      message:
        "Payment captured successfully",
    });
  } catch (err: any) {
    console.error(
      "Capture payment error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/* =========================================================
 CAPTURE All AMOUNT
========================================================= */

app.post("/capture-all", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: "Missing sessionId",
      });
    }

    // =====================================================
    // SESSION
    // =====================================================

    const sessionRef =
      db.collection("slots").doc(sessionId);

    const sessionSnap =
      await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    const session: any =
      sessionSnap.data();

    const operatorStripeAccountId =
      session.stripeAccountId;

    // =====================================================
    // ALL AUTHORIZED BOOKINGS
    // =====================================================

    const bookingsSnap =
      await db
        .collection("bookings")
        .where("slotId", "==", sessionId)
        .where(
          "paymentStatus",
          "==",
          RIDER_PAYMENT_STATUS.AUTHORIZED
        )
        .get();

    const captured: string[] = [];

    const failed: any[] = [];

    // =====================================================
    // CAPTURE LOOP
    // =====================================================

    for (const doc of bookingsSnap.docs) {
      const booking: any =
        doc.data();

      try {
        // ================================================
        // STRIPE CAPTURE
        // ================================================

        await stripe.paymentIntents.capture(
          booking.paymentIntentId,
          {},
          {
            stripeAccount:
              operatorStripeAccountId,
          }
        );

        // ================================================
        // UPDATE GLOBAL BOOKING
        // ================================================

        await doc.ref.update({
          paymentStatus:
            RIDER_PAYMENT_STATUS.CAPTURED,

          capturedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });

        // ================================================
        // UPDATE AGGREGATE BOOKING
        // ================================================

        const aggregateBookingRef =
          sessionRef
            .collection("booking")
            .doc(booking.riderId);

        const aggregateSnap =
          await aggregateBookingRef.get();

        if (aggregateSnap.exists) {
          const aggregate: any =
            aggregateSnap.data();

          const updatedAttempts =
            (
              aggregate.bookingAttempts ||
              []
            ).map((attempt: any) => {
              if (
                attempt.bookingId ===
                booking.bookingId
              ) {
                return {
                  ...attempt,
                  paymentStatus:
                    RIDER_PAYMENT_STATUS.CAPTURED,

                  capturedAt:
                    new Date(),
                };
              }

              return attempt;
            });

          await aggregateBookingRef.update({
            bookingAttempts:
              updatedAttempts,

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        captured.push(
          booking.bookingId
        );
      } catch (err: any) {
        console.error(
          "Capture failed:",
          booking.paymentIntentId,
          err.message
        );

        failed.push({
          bookingId:
            booking.bookingId,

          paymentIntentId:
            booking.paymentIntentId,
        });
      }
    }

    // =====================================================
    // HANDLE FAILURE
    // =====================================================

    if (failed.length > 0) {
      return res.status(400).json({
        success: false,

        message:
          "Some payments failed",

        captured,

        failed,
      });
    }

    // =====================================================
    // SESSION UPDATE
    // =====================================================

    await sessionRef.update({
      paymentStatus: "captured",

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,

      message:
        "All payments captured successfully",

      captured,
    });
  } catch (err: any) {
    console.error(
      "Capture all error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/* =========================================================
   CANCEL AMOUNT
========================================================= */
app.post("/cancel-payment", async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        error: "Missing bookingId",
      });
    }

    // =====================================================
    // GLOBAL BOOKING
    // =====================================================

    const bookingRef =
      db.collection("bookings").doc(bookingId);

    const bookingSnap =
      await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({
        error: "Booking not found",
      });
    }

    const booking: any =
      bookingSnap.data();

    // =====================================================
    // ALREADY CANCELLED
    // =====================================================

    if (
      booking.paymentStatus ===
      RIDER_PAYMENT_STATUS.CANCELLED
    ) {
      return res.status(400).json({
        error: "Already cancelled",
      });
    }

    // =====================================================
    // SESSION
    // =====================================================

    const sessionRef = db
      .collection("slots")
      .doc(booking.slotId);

    const sessionSnap =
      await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({
        error: "Session not found",
      });
    }

    const session: any =
      sessionSnap.data();

    const operatorStripeAccountId =
      session.stripeAccountId;

    // =====================================================
    // STRIPE CANCEL
    // =====================================================

    await stripe.paymentIntents.cancel(
      booking.paymentIntentId,
      {
        stripeAccount:
          operatorStripeAccountId,
      }
    );

    // =====================================================
    // UPDATE GLOBAL BOOKING
    // =====================================================

    await bookingRef.update({
      paymentStatus:
        RIDER_PAYMENT_STATUS.CANCELLED,

      cancelledAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    // =====================================================
    // UPDATE AGGREGATE BOOKING
    // =====================================================

    const aggregateBookingRef =
      sessionRef
        .collection("booking")
        .doc(booking.riderId);

    const aggregateSnap =
      await aggregateBookingRef.get();

    if (aggregateSnap.exists) {
      const aggregate: any =
        aggregateSnap.data();

      const updatedAttempts =
        (
          aggregate.bookingAttempts || []
        ).map((attempt: any) => {
          if (
            attempt.bookingId === bookingId
          ) {
            return {
              ...attempt,
              paymentStatus:
                RIDER_PAYMENT_STATUS.CANCELLED,

              cancelledAt: new Date(),
            };
          }

          return attempt;
        });

      await aggregateBookingRef.update({
        bookingAttempts:
          updatedAttempts,

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Payment cancelled successfully",
    });
  } catch (err: any) {
    console.error(
      "Cancel payment error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/* =========================================================
   SERVER
========================================================= */

app.get("/checkTwilo", (req, res) => {
  sendBookingSMS("+918602926908", { activity: "Surfing", timeStart: new Date(), location: "JBR", durationMinutes: 60, pricePerSeat: 100 }, "Rahul Kirar").catch(console.error)
  res.send({ success: true });
});


const PORT = process.env.PORT || 3000;

// ✅ Local
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`🚀 Local server running on port ${PORT}`);
  });
}

// ✅ Vercel
export default function handler(req: any, res: any) {
  return app(req, res);
}