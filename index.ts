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
    const { sessionId, operatorUid, riderUid, operatorStripeAccountId } = req.body;

    if (!sessionId || !operatorUid || !riderUid || !operatorStripeAccountId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.collection("slots").doc(sessionId);
    const snap = await sessionRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session: any = snap.data();

    const status: SessionStatus =
      session.status || SESSION_STATUS.OPEN;

    if (isFinalStatus(status)) {
      return res.status(400).json({ error: "Session not bookable" });
    }

    if (session.bookedSeats >= session.totalSeats) {
      return res.status(400).json({ error: "Session full" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: session.pricePerSeat * 100,
      currency: "aed",
      capture_method: "manual",
      metadata: {
        sessionId,
        operatorUid,
        riderUid,
      },
    },
      {
        stripeAccount: operatorStripeAccountId,
      }
    );

    return res.json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
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
    const { sessionId, operatorUid, riderUid, paymentIntentId } =
      req.body;

    if (!sessionId || !operatorUid || !riderUid || !paymentIntentId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.collection("slots").doc(sessionId);
    const riderRef = db.collection("users").doc(riderUid);

    const bookingRef = sessionRef
      .collection("booking")
      .doc(riderUid);

    const bookingGlobalRef = db.collection("bookings").doc();

    // 🔥 Chat refs
    const chatRef = db.collection("chats").doc(sessionId);
    const membersRef = chatRef.collection("members");
    const messageRef = chatRef.collection("messages").doc();

    await db.runTransaction(async (tx) => {
      /* =========================================================
         🔥 STEP 1: ALL READS FIRST (VERY IMPORTANT)
      ========================================================= */

      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) {
        throw new Error("Session not found");
      }

      const riderSnap = await tx.get(riderRef);
      if (!riderSnap.exists) {
        throw new Error("Rider not found");
      }

      const existingBooking = await tx.get(bookingRef);
      if (existingBooking.exists) {
        throw new Error("Already booked");
      }

      const chatSnap = await tx.get(chatRef); // ✅ moved BEFORE writes

      /* =========================================================
         🔥 STEP 2: PREP DATA
      ========================================================= */

      const session: any = sessionSnap.data();
      const rider: any = riderSnap.data();

      const riderData = {
        name: rider.userProfile?.name ?? rider.displayName ?? null,
        phone: rider.userProfile?.phone_no ?? null,
        photoURL: rider.photoURL ?? null,
        email: rider.email ?? null,
      };

      const currentStatus =
        session.status || SESSION_STATUS.OPEN;

      // ❌ Block invalid states
      if (
        currentStatus === SESSION_STATUS.CANCELLED ||
        currentStatus === SESSION_STATUS.CLAIMED
      ) {
        throw new Error("Session not bookable");
      }

      if (session.bookedSeats >= session.totalSeats) {
        throw new Error("Seats are full");
      }

      const newBookedSeats = session.bookedSeats + 1;

      let newStatus = currentStatus;

      if (newBookedSeats >= session.totalSeats) {
        newStatus = SESSION_STATUS.FULL;
      } else if (
        newBookedSeats >= session.minRidersToConfirm &&
        currentStatus === SESSION_STATUS.OPEN
      ) {
        newStatus = SESSION_STATUS.MIN_REACHED;
      }

      /* =========================================================
         🔥 STEP 3: WRITES START HERE
      ========================================================= */

      // ✅ Session-level booking
      tx.set(bookingRef, {
        riderUid,
        ...riderData,
        paymentIntentId,
        globalBookingId: bookingGlobalRef.id,
        status: RIDER_PAYMENT_STATUS.AUTHORIZED,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ Global booking
      tx.set(bookingGlobalRef, {
        // relations
        riderId: riderUid,
        operatorId: operatorUid,
        slotId: sessionId,

        // rider snapshot
        rider: riderData,

        // session snapshot
        ...session,

        // booking
        seatsBooked: 1,

        // payment
        paymentIntentId,
        paymentStatus: "authorized",
        captureStatus: "pending",

        // status
        status: "booked",

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ✅ Update session seats + status
      tx.update(sessionRef, {
        bookedSeats: newBookedSeats,
        status: newStatus,
      });

      // ✅ Create chat ONLY once
      if (!chatSnap.exists) {
        tx.set(chatRef, {
          sessionId,
          operatorId: operatorUid,
          membersIds: [operatorUid], // initial
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessage: null,
        });
      }

      // ✅ Add rider to members
      tx.set(
        membersRef.doc(riderUid),
        {
          userId: riderUid,
          role: "rider",
          name: riderData.name,
          photoURL: riderData.photoURL,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // ✅ Ensure operator in members
      tx.set(
        membersRef.doc(operatorUid),
        {
          userId: operatorUid,
          role: "operator",
          name: session?.operator?.name,
          photoURL: session?.operator?.photoURL,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // ✅ Update membersIds array (fast query)
      tx.set(
        chatRef,
        {
          membersIds: admin.firestore.FieldValue.arrayUnion(riderUid),
        },
        { merge: true }
      );

      // ✅ System message
      tx.set(messageRef, {
        type: "system",
        text: `${riderData.name || "A rider"} joined the chat`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 🚀 Send SMS notification after successful booking
    // Re-fetch the data to get access outside transaction
    const finalSessionSnap = await sessionRef.get();
    const finalSession = finalSessionSnap.data() as any;
    const finalRiderSnap = await riderRef.get();
    const finalRider = finalRiderSnap.data() as any;

    const finalRiderData = {
      name: finalRider.displayName,
      phone: finalRider.userProfile?.phone_no ?? null,
    };

    if (finalRiderData.phone) {
      // Send SMS asynchronously (don't block the response)
      sendBookingSMS(finalRiderData.phone, finalSession, finalRiderData.name || "Rider").catch(console.error);
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Finalize booking error:", err);
    return res.status(400).json({ error: err.message });
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
    const { sessionId, riderUid } = req.body;

    if (!sessionId || !riderUid) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.collection("slots").doc(sessionId);
    const bookingRef = sessionRef.collection("booking").doc(riderUid);

    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionSnap.data();
    const operatorStripeAccountId = session?.stripeAccountId;

    if (!operatorStripeAccountId) {
      return res.status(400).json({ error: "Missing Stripe account" });
    }

    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking: any = bookingSnap.data();

    if (booking.status === "captured") {
      return res.status(400).json({ error: "Already captured" });
    }

    if (!booking.paymentIntentId) {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    // 🔥 CAPTURE PAYMENT
    await stripe.paymentIntents.capture(
      booking.paymentIntentId,
      {},
      {
        stripeAccount: operatorStripeAccountId,
      }
    );

    // ✅ Update booking status
    await bookingRef.update({
      status: "captured",
      capturedAt: new Date(),
    });

    // 🚀 Send payment confirmation SMS
    const riderSnap = await db.collection("users").doc(riderUid).get();
    const rider = riderSnap.data() as any;
    const riderData = {
      name: rider.userProfile?.name ?? rider.displayName ?? null,
      phone: rider.userProfile?.phone_no ?? null,
    };

    if (riderData.phone) {
      // Send SMS asynchronously (don't block the response)
      sendPaymentConfirmationSMS(riderData.phone, session, riderData.name || "Rider").catch(console.error);
    }

    return res.status(200).json({
      success: true,
      message: "Payment captured successfully",
    });
  } catch (err: any) {
    console.error("Capture error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
 CAPTURE All AMOUNT
========================================================= */

app.post("/capture-all", async (req, res) => {
  try {
    const { sessionId } = req.body;

    const sessionRef = db.collection("slots").doc(sessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const operatorStripeAccountId = sessionSnap.data()?.stripeAccountId;

    const bookingsSnap = await sessionRef.collection("booking").get();

    const captured = [];
    const failed = [];

    // 🔥 STEP 1: Try capturing all
    for (const doc of bookingsSnap.docs) {
      const booking = doc.data();

      if (booking.status !== "authorized") continue;

      try {
        await stripe.paymentIntents.capture(
          booking.paymentIntentId,
          {},
          {
            stripeAccount: operatorStripeAccountId,
          }
        );

        await doc.ref.update({
          status: "captured",
          capturedAt: new Date(),
        });

        captured.push(doc.id);

      } catch (err: any) {
        console.error("Capture failed:", booking.paymentIntentId, err.message);

        failed.push({
          riderUid: doc.id,
          paymentIntentId: booking.paymentIntentId,
        });
      }
    }

    // 🔥 STEP 2: Handle failure → cancel remaining
    if (failed.length > 0) {
      for (const doc of bookingsSnap.docs) {
        const booking = doc.data();

        if (booking.status !== "authorized") continue;

        try {
          await stripe.paymentIntents.cancel(
            booking.paymentIntentId,
            {
              stripeAccount: operatorStripeAccountId,
            }
          );

          await doc.ref.update({
            status: "cancelled",
            cancelledAt: new Date(),
          });

        } catch (err: any) {
          console.error("Cancel failed:", booking.paymentIntentId, err.message);
        }
      }

      // ❌ Update session status (FAILED / PARTIAL)
      await sessionRef.update({
        paymentStatus: "failed", // or "partial"
        updatedAt: new Date(),
      });

      return res.status(400).json({
        success: false,
        message: "Some payments failed. Remaining payments cancelled.",
        captured,
        failed,
      });
    }

    // ✅ STEP 3: All captured → update session
    await sessionRef.update({
      paymentStatus: "captured",
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "All payments captured successfully",
      captured,
    });

  } catch (err: any) {
    console.error("Capture-all error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   CANCEL AMOUNT
========================================================= */

app.post("/cancel-payment", async (req, res) => {
  try {
    const { sessionId, riderUid } = req.body;

    if (!sessionId || !riderUid) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.collection("slots").doc(sessionId);
    const bookingRef = sessionRef.collection("booking").doc(riderUid);

    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionSnap.data();
    const operatorStripeAccountId = session?.stripeAccountId;

    if (!operatorStripeAccountId) {
      return res.status(400).json({ error: "Missing Stripe account" });
    }

    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking: any = bookingSnap.data();

    if (booking.status === "cancelled") {
      return res.status(400).json({ error: "Already cancelled" });
    }

    if (!booking.paymentIntentId) {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    // 🔥 CANCEL PAYMENT (release hold)
    await stripe.paymentIntents.cancel(
      booking.paymentIntentId,
      {
        stripeAccount: operatorStripeAccountId,
      }
    );

    // ✅ Update booking status
    await bookingRef.update({
      status: "cancelled",
      cancelledAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Payment cancelled successfully",
    });
  } catch (err: any) {
    console.error("Cancel error:", err);
    return res.status(500).json({ error: err.message });
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