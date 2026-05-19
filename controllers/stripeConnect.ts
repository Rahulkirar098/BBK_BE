
import { Request, Response } from "express";
import { stripe } from "../app.ts";
import { db } from "../services/firebase.ts";

export const createConnectAccount = async (req: Request, res: Response) => {
    try {
        const { operatorUid, email } = req.body;

        if (!operatorUid || !email) {
            return res.status(400).json({
                status: false,
                message: "Parameters is missing"
            });
        }

        const operatorRef = db.doc(`users/${operatorUid}`);
        const snap = await operatorRef.get();

        // If already created
        if (snap.exists && snap.data()?.stripeAccountId) {
            return res.status(200).json({
                status: true,
                message: "Connect account already exists",
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

        return res.status(200).json({
            status: true,
            message: "Connect account created successfully",
            stripeAccountId: account.id,
        });

    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};

export const createConnectAccountLink = async (req: Request, res: Response) => {
    try {
        const { operatorUid } = req.body;

        const operatorRef = db.doc(`users/${operatorUid}`);
        const snap = await operatorRef.get();

        if (!snap.exists || !snap.data()?.stripeAccountId) {
            return res.status(400).json({
                status: false,
                message: "Connect account not found"
            });
        }

        const accountLink = await stripe.accountLinks.create({
            account: snap.data()?.stripeAccountId,
            refresh_url: "https://bbk-be-1smn.vercel.app/reauth",
            return_url: "https://bbk-be-1smn.vercel.app/success",
            type: "account_onboarding",
        });

        return res.status(200).json({
            status: true,
            message: "Connect account link created successfully",
            url: accountLink.url,
        });
    } catch (error: any) {
        console.error(error, "=== error from create connect account link ===");
        return res.status(500).json({
            status: false,
            message: error.message
        });
    }
};

export const reauth = async (req: Request, res: Response) => {
    try {
        return res.send("Re-auth required. Please try onboarding again.");
    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message
        });
    }
};

export const success = async (req: Request, res: Response) => {
    try {
        return res.send("Onboarding completed successfully ✅");
    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message
        });
    }
};

export const checkOnboardingStatus = async (req: Request, res: Response) => {
    try {
        const { operatorUid } = req.params;

        const operatorRef = db.doc(`users/${operatorUid}`);
        const snap = await operatorRef.get();

        if (!snap.exists || !snap.data()?.stripeAccountId) {
            return res.status(400).json({
                status: false,
                message: "Account not found"
            });
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
            status: true,
            onboardingComplete: isComplete,
        });
    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message
        });
    }
};
