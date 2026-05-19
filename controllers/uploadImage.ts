import { Request, Response } from "express";
import multer from "multer";
import { bucket } from "../services/firebase.ts";
import { randomUUID } from "crypto";
import fs from "fs";

export const upload = multer({ dest: "uploads/" });

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

    await bucket.upload(file.path, {
      destination,
      metadata: {
        contentType: file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    // Clean up temp file
    fs.unlinkSync(file.path);

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
