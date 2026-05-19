import { Request, Response } from "express";
import { CAPTION_STATUS } from "../types/index.js";
import { FieldValue } from "firebase-admin/firestore";

// Firebase
import { db } from "../services/firebase.js";

const boats = db.collection("boats");

export const createBoat = async (req: Request, res: Response) => {
    try {
        const { boatCapacity, boatCompany, boatModel, boatName, imageUrl, operator_id, status } = req.body;

        const boat = {
            boatCapacity,
            boatCompany,
            boatModel,
            boatName,
            imageUrl,
            operator_id,
            status: status || CAPTION_STATUS.PENDING,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };

        await boats.add(boat);

        return res.status(201).json({
            status: true,
            message: "Boat created successfully",
            data: boat
        });

    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};

export const editBoat = async (req: Request, res: Response) => {
    try {
        const { boatCapacity, boatCompany, boatModel, boatName, createdAt, imageUrl, operator_id, status } = req.body;
        const { id } = req.params;

        const boat = {
            boatCapacity,
            boatCompany,
            boatModel,
            boatName,
            imageUrl,
            operator_id,
            createdAt,
            status,
            updatedAt: FieldValue.serverTimestamp()
        };

        await boats.doc(id as string).update(boat);

        return res.status(201).json({
            status: true,
            message: "Boat updated successfully",
            data: boat
        });

    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};

export const deleteBoat = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await boats.doc(id as string).delete();
        return res.status(200).json({
            status: true,
            message: "Boat deleted successfully",
        });
    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};
