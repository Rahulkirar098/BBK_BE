import { Request, Response } from "express";
import { CAPTION_STATUS } from "../types/index.js";
import { FieldValue } from "firebase-admin/firestore";

// Firebase
import { db } from "../services/firebase.js";

const captains = db.collection("captains");

export const createCaptain = async (req: Request, res: Response) => {
    try {
        const { name, language, imageUrl, operator_id, phone_no, status } = req.body;

        const captain = {
            name,
            language,
            imageUrl,
            operator_id,
            phone_no,
            status: status || CAPTION_STATUS.PENDING,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };

        await captains.add(captain);

        return res.status(201).json({
            status: true,
            message: "Captain created successfully",
            data: captain
        });

    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};

export const editCaptain = async (req: Request, res: Response) => {
    try {
        const { name, language, imageUrl, operator_id, phone_no, createdAt, status } = req.body;
        const { id } = req.params;

        const captain = {
            name,
            language,
            imageUrl,
            operator_id,
            phone_no,
            createdAt,
            status,
            updatedAt: FieldValue.serverTimestamp()
        };

        await captains.doc(id as string).update(captain);

        return res.status(201).json({
            status: true,
            message: "Captain updated successfully",
            data: captain
        });

    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};

export const deleteCaptain = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await captains.doc(id as string).delete();
        return res.status(200).json({
            status: true,
            message: "Captain deleted successfully",
        });
    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};