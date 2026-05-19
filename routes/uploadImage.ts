import express from "express";
import { app } from "../app.ts";
import { upload, uploadImage } from "../controllers/index.ts";

const uploadImageRoutes = express.Router();

// Add your routes here
uploadImageRoutes.route("/single").post(upload.single("image"), uploadImage);


export const uploadImageRoute = app.use("/upload-image", uploadImageRoutes);

