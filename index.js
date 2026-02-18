import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

// Initialize Firebase Admin
admin.initializeApp();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-08-16",
});

// Create PaymentIntent endpoint
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { sessionId, operatorUid, riderUid } = req.body;

    if (!sessionId || !operatorUid || !riderUid) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Get session from Firestore
    const sessionRef = admin
      .firestore()
      .doc(`slots/${operatorUid}/slots/${sessionId}`);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessionSnap.data();

    if (!session) {
      return res.status(404).json({ error: "Session data missing" });
    }

    if (session.bookedSeats >= session.totalSeats) {
      return res.status(400).json({ error: "Session full" });
    }

    // Create Stripe PaymentIntent (manual capture)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: session.pricePerSeat * 100, // in cents
      currency: "aed",
      payment_method_types: ["card"],
      capture_method: "manual", // HOLD funds
      metadata: {
        sessionId,
        riderUid,
        operatorUid,
      },
    });


    res.json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error("Error creating PaymentIntent:", error);
    res.status(500).json({ error: "Failed to create PaymentIntent" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
