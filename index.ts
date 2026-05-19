import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
import { sendBookingSMS, sendPaymentConfirmationSMS } from "./services/twilio.ts";
import admin from "firebase-admin";
import { app } from "./app.ts";
import {
  checkOnboardingStatus,
  createConnectAccount,
  createConnectAccountLink,
  createPaymentIntent,
  reauth,
  success,
  upload,
  uploadImage
} from "./controllers/index.ts";
import { SESSION_STATUS, RIDER_PAYMENT_STATUS, type SessionStatus } from "./types/index.ts";

import { db } from './services/firebase.ts';

import "./routes/index.ts";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2026-01-28.clover",
});

/* =========================================================
   HELPERS
========================================================= */

const canClaim = (status: SessionStatus) => {
  return (
    status === SESSION_STATUS.MIN_REACHED ||
    status === SESSION_STATUS.FULL
  );
};

//////////////

app.get('/', (_, res) => {
  res.send('Welcome to the API!...');
});

/* =========================================================
   1️⃣ CREATE PAYMENT INTENT (HOLD FUNDS)
========================================================= */

app.post("/create-payment-intent", createPaymentIntent);

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
        status: false,
        message: "Missing parameters",
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

          timeStart: session.timeStart,

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
        bookingId: bookingGlobalRef.id,
        captureStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        operatorId: operatorUid,
        // payment
        paymentIntentId,
        paymentStatus: RIDER_PAYMENT_STATUS.AUTHORIZED,
        // rider snapshot
        riderId: riderUid,
        rider: riderData,
        // booking
        seatsBooked: requestedSeats,
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
        slotId: sessionId,
        // booking status
        status: "booked",
        timeStart: session.timeStart,
        totalAmount:
          (session.pricePerSeat || 0) *
          requestedSeats,
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

    console.log("Rider phone for SMS:", finalRiderData.phone);

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
      status: true,
      bookingId:
        bookingGlobalRef.id,

      seatsBooked:
        requestedSeats,
    });
  } catch (error: any) {
    console.error(
      "Finalize booking error:",
      error
    );

    return res.status(400).json({
      status: false,
      message: error.message,
    });
  }
});

/* =========================================================
    CONNECT ACCOUNT 
========================================================= */
app.post("/create-connect-account", createConnectAccount);

app.post("/create-account-link", createConnectAccountLink);

app.get("/reauth", reauth);

app.get("/success", success);

app.get("/check-onboarding-status/:operatorUid", checkOnboardingStatus);

/* =========================================================
   CAPTURE AMOUNT
========================================================= */

app.post("/capture-payment", async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({
        status: false,
        message: "Missing bookingId",
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
        status: false,
        message: "Booking not found",
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
        status: false,
        message: "Already captured",
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
        status: false,
        message: "Session not found",
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
      status: true,
      message:
        "Payment captured successfully",
    });
  } catch (err: any) {
    console.error(
      "Capture payment error:",
      err
    );

    return res.status(500).json({
      status: false,
      message: `Hello ${err.message}`
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
        status: false,
        message: "Missing sessionId",
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
        status: false,
        message: "Session not found",
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
        status: false,
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
      status: true,
      message:
        "All payments captured successfully",

      captured,
    });
  } catch (error: any) {
    console.error(
      "Capture all error:",
      error
    );

    return res.status(500).json({
      status: false,
      message: error.message,
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
        status: false,
        message: "Missing bookingId",
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
        status: false,
        message: "Booking not found",
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
        status: false,
        message: "Already cancelled",
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
        status: false,
        message: "Session not found",
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
      status: true,
      message: "Payment cancelled successfully",
    });
  } catch (error: any) {
    console.error(
      "Cancel payment error:",
      error
    );

    return res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

/* =========================================================
   SERVER
========================================================= */

app.get("/checkTwilo", (req, res) => {
  sendBookingSMS("+918602926908", { activity: "Surfing", timeStart: new Date(), location: "JBR", durationMinutes: 60, pricePerSeat: 100 }, "Rahul Kirar").catch(console.error)
  res.send({ status: true });
});

// ✅ Vercel serverless export
export default app;

// Only listen locally (not on Vercel)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  server.on("error", (err: any) => {
    console.error("Server error:", err.message);
  });
}