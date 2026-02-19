import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

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
   1️⃣ CREATE PAYMENT INTENT (HOLD ONLY)
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

    const session = snap.data()!;

    if (session.status === "confirmed") {
      return res.status(400).json({ error: "Session already confirmed" });
    }

    if (session.bookedSeats >= session.totalSeats) {
      return res.status(400).json({ error: "Session full" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: session.pricePerSeat * 100,
      currency: "aed",
      capture_method: "manual", // 🔥 HOLD FUNDS
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
   2️⃣ FINALIZE BOOKING (After Stripe Confirm)
========================================================= */

app.post("/finalize-booking", async (req, res) => {
  try {
    const { sessionId, operatorUid, riderUid, paymentIntentId } = req.body;

    if (!sessionId || !operatorUid || !riderUid || !paymentIntentId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const sessionRef = db.doc(`slots/${operatorUid}/slots/${sessionId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);

      if (!snap.exists) {
        throw new Error("Session not found");
      }

      const session = snap.data()!;

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
          status: "authorized",
        },
      ];

      const updatePayload: any = {
        bookedSeats: newBookedSeats,
        ridersProfile: updatedRiders,
      };

      if (newBookedSeats >= session.minRidersToConfirm) {
        updatePayload.status = "ready_for_claim";
      }

      tx.update(sessionRef, updatePayload);
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

    const session = snap.data()!;

    if (session.status === "confirmed") {
      return res.status(400).json({ error: "Already claimed" });
    }

    if (session.bookedSeats < session.minRidersToConfirm) {
      return res.status(400).json({ error: "Minimum riders not reached" });
    }

    const riders = session.ridersProfile || [];

    for (const rider of riders) {
      if (rider.paymentIntentId) {
        await stripe.paymentIntents.capture(rider.paymentIntentId);
      }
    }

    await sessionRef.update({
      status: "confirmed",
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      ridersProfile: riders.map((r: any) => ({
        ...r,
        status: "captured",
      })),
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

    const session = snap.data()!;
    const riders = session.ridersProfile || [];

    for (const rider of riders) {
      if (rider.paymentIntentId) {
        await stripe.paymentIntents.cancel(rider.paymentIntentId);
      }
    }

    await sessionRef.update({
      status: "cancelled",
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
