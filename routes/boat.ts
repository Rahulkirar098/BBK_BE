import express from "express";
import { app } from "../app.ts";
import { createBoat, editBoat, deleteBoat } from "../controllers/index.ts";

const boatRoutes = express.Router();

// Add your routes here
boatRoutes.route("/create-boat").post(createBoat);
boatRoutes.route("/edit-boat/:id").put(editBoat);
boatRoutes.route("/delete-boat/:id").delete(deleteBoat);

export const boat = app.use("/boat", boatRoutes);

