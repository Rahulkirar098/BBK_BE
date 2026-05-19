
import { Request, Response } from "express";
    
export const createSlot = (req: Request, res: Response) => {
    try {
        const { } = req.body;





    } catch (error: any) {
        return res.status(500).json({
            status: false,
            message: error.message,
            error: error
        });
    }
};
