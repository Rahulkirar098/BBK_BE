import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

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
  CANCELLED: "cancelled",   // released
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
      .doc(riderUid); // 👈 deterministic

    const historyRef = riderRef
      .collection("history")
      .doc(sessionId); // 👈 deterministic

    await db.runTransaction(async (tx) => {
      // 🔥 Get session
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) {
        throw new Error("Session not found");
      }

      const session: any = sessionSnap.data();
      const status: SessionStatus =
        session.status || SESSION_STATUS.OPEN;

      if (isFinalStatus(status)) {
        throw new Error("Session not bookable");
      }

      if (session.bookedSeats >= session.totalSeats) {
        throw new Error("Session full");
      }

      // 🔥 Prevent duplicate booking
      const existingBooking = await tx.get(bookingRef);
      if (existingBooking.exists) {
        throw new Error("Already booked");
      }

      // 🔥 Fetch rider
      const riderSnap = await tx.get(riderRef);
      if (!riderSnap.exists) {
        throw new Error("Rider not found");
      }

      const rider = riderSnap.data() as any;

      // 🔥 Minimal rider snapshot (IMPORTANT)
      const riderData = {
        name: rider.userProfile?.name ?? rider.displayName ?? null,
        phone: rider.userProfile?.phone_no ?? null,
        photoURL: rider.photoURL ?? null,
        email: rider.email ?? null,
      };

      // 🔥 Create booking (session side)
      tx.set(bookingRef, {
        riderUid,
        ...riderData,
        paymentIntentId,
        status: RIDER_PAYMENT_STATUS.AUTHORIZED,
        createdAt: new Date(),
      });

      // 🔥 Create history (rider side)
      tx.set(historyRef, {
        sessionId,
        operatorUid,
        paymentIntentId,
        status: RIDER_PAYMENT_STATUS.AUTHORIZED,
        sessionDate: session.date || null,
        createdAt: new Date(),
      });

      // 🔥 Update session counters
      const newBookedSeats = session.bookedSeats + 1;

      let newStatus: SessionStatus = SESSION_STATUS.OPEN;

      if (newBookedSeats >= session.totalSeats) {
        newStatus = SESSION_STATUS.FULL;
      } else if (newBookedSeats >= session.minRidersToConfirm) {
        newStatus = SESSION_STATUS.MIN_REACHED;
      }

      tx.update(sessionRef, {
        bookedSeats: newBookedSeats,
        status: newStatus,
      });
    });

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

      } catch (err:any) {
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

        } catch (err:any) {
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

  } catch (err:any) {
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