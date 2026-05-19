import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import './services/firebase.js';

dotenv.config();

export const app = express();

app.use(cors());
app.use(express.json());


export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
    apiVersion: "2026-01-28.clover",
});