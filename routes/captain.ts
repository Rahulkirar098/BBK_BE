import express from "express";
import { app } from "../app.ts";
import { createCaptain, editCaptain, deleteCaptain } from "../controllers/index.ts";

const captainRoutes = express.Router();

// Add your routes here
captainRoutes.route("/create-captain").post(createCaptain);
captainRoutes.route("/edit-captain/:id").put(editCaptain);
captainRoutes.route("/delete-captain/:id").delete(deleteCaptain);

export const captain = app.use("/captain", captainRoutes);

