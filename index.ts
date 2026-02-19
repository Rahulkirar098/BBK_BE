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
  AUTHORIZED: "authorized",
  CAPTURED: "captured",
  CANCELLED: "cancelled",
} as const;

export type RiderPaymentStatus =
  typeof RIDER_PAYMENT_STATUS[keyof typeof RIDER_PAYMENT_STATUS];

/* =========================================================
   INIT
========================================================= */

admin.initializeApp();

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

/* =========================================================
   1️⃣ CREATE PAYMENT INTENT (HOLD FUNDS)
========================================================= */

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { sessionId, operatorUid, riderUid } = req.body;

    if (!sessionId || !operatorUid || !riderUid) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.doc(`slots/${operatorUid}/slots/${sessionId}`);
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
    });

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

    const sessionRef = db.doc(`slots/${operatorUid}/slots/${sessionId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);

      if (!snap.exists) {
        throw new Error("Session not found");
      }

      const session: any = snap.data();
      const status: SessionStatus =
        session.status || SESSION_STATUS.OPEN;

      if (isFinalStatus(status)) {
        throw new Error("Session not bookable");
      }

      if (session.bookedSeats >= session.totalSeats) {
        throw new Error("Session full");
      }

      const alreadyBooked = session.ridersProfile?.some(
        (r: any) => r.uid === riderUid
      );

      if (alreadyBooked) {
        throw new Error("Already booked");
      }

      const newBookedSeats = session.bookedSeats + 1;

      const updatedRiders = [
        ...(session.ridersProfile || []),
        {
          uid: riderUid,
          paymentIntentId,
          status: RIDER_PAYMENT_STATUS.AUTHORIZED,
        },
      ];

      let newStatus: SessionStatus = SESSION_STATUS.OPEN;

      if (newBookedSeats >= session.totalSeats) {
        newStatus = SESSION_STATUS.FULL;
      } else if (newBookedSeats >= session.minRidersToConfirm) {
        newStatus = SESSION_STATUS.MIN_REACHED;
      }

      tx.update(sessionRef, {
        bookedSeats: newBookedSeats,
        ridersProfile: updatedRiders,
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
   3️⃣ OPERATOR CLAIM (CAPTURE FUNDS)
========================================================= */

app.post("/claim-session", async (req, res) => {
  try {
    const { sessionId, operatorUid } = req.body;

    if (!sessionId || !operatorUid) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.doc(`slots/${operatorUid}/slots/${sessionId}`);
    const snap = await sessionRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session: any = snap.data();
    const status: SessionStatus = session.status;

    if (!canClaim(status)) {
      return res.status(400).json({ error: "Not ready to claim" });
    }

    const riders = session.ridersProfile || [];

    for (const rider of riders) {
      if (
        rider.paymentIntentId &&
        rider.status === RIDER_PAYMENT_STATUS.AUTHORIZED
      ) {
        await stripe.paymentIntents.capture(rider.paymentIntentId);
        rider.status = RIDER_PAYMENT_STATUS.CAPTURED;
      }
    }

    await sessionRef.update({
      status: SESSION_STATUS.CLAIMED,
      ridersProfile: riders,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Claim error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   4️⃣ CANCEL SESSION (RELEASE HOLDS)
========================================================= */

app.post("/cancel-session", async (req, res) => {
  try {
    const { sessionId, operatorUid } = req.body;

    const sessionRef = db.doc(`slots/${operatorUid}/slots/${sessionId}`);
    const snap = await sessionRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session: any = snap.data();
    const riders = session.ridersProfile || [];

    for (const rider of riders) {
      if (
        rider.paymentIntentId &&
        rider.status === RIDER_PAYMENT_STATUS.AUTHORIZED
      ) {
        await stripe.paymentIntents.cancel(rider.paymentIntentId);
        rider.status = RIDER_PAYMENT_STATUS.CANCELLED;
      }
    }

    await sessionRef.update({
      status: SESSION_STATUS.CANCELLED,
      ridersProfile: riders,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Cancel error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   SERVER
========================================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
