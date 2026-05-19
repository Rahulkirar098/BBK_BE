import express from "express";
import { app } from "../app.js";
import { upload, uploadImage } from "../controllers/index.js";

const uploadImageRoutes = express.Router();

// Add your routes here
uploadImageRoutes.route("/single").post(upload.single("image"), uploadImage);


export const uploadImageRoute = app.use("/upload-image", uploadImageRoutes);

