import { Request, Response } from "express";
import multer from "multer";
import { bucket } from "../services/firebase.js";
import { randomUUID } from "crypto";

export const upload = multer({ storage: multer.memoryStorage() });

export const uploadImage = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const { path } = req.body;

    if (!file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    if (!path) {
      return res.status(400).json({ success: false, message: "Path is required" });
    }

    const destination = `${path}/${Date.now()}_${file.originalname}`;

    const token = randomUUID();

    const fileRef = bucket.file(destination);
    await fileRef.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destination)}?alt=media&token=${token}`;

    res.status(200).json({
      success: true,
      url,
    });
  } catch (error: any) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
