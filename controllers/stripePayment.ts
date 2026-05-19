import { stripe } from "../app.js";
import { SESSION_STATUS, SessionStatus } from "../types/index.js";
import { db } from "../services/firebase.js";


const isFinalStatus = (status: SessionStatus) => {
    return (
        status === SESSION_STATUS.CLAIMED ||
        status === SESSION_STATUS.CANCELLED
    );
};

export const createPaymentIntent = async (req: any, res: any) => {
    try {
        const { sessionId, operatorUid, riderUid, operatorStripeAccountId, seatsCount } = req.body;

        if (!sessionId || !operatorUid || !riderUid || !operatorStripeAccountId) {
            return res.status(400).json({
                status: false,
                message: "Parameters are missing"
            });
        }

        const requestedSeats = Math.max(1, Math.min(parseInt(seatsCount) || 1, 10)); // max 10 seats per booking

        const sessionRef = db.collection("slots").doc(sessionId);
        const snap = await sessionRef.get();
        if (!snap.exists) {
            return res.status(404).json({ status: false, message: "Session not found" });
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
            return res.status(400).json({ status: false, message: "Session not bookable" });
        }

        const availableSeats = session.totalSeats - session.bookedSeats;
        if (requestedSeats > availableSeats) {
            return res.status(400).json({ status: false, message: `Only ${availableSeats} seats available` });
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

        return res.status(200).json({
            status: true,
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            seatsCount: requestedSeats,
            totalAmount: totalAmount / 100, // in AED for display
        });


    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
}