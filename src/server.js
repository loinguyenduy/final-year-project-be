import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import { initDatabase } from "./core/database/setup.js";
import { initCronJobs } from "./core/cron/index.js";
import v1Routes from "./core/routes/v1.routes.js";
import passport from "./core/middlewares/passport.middleware.js";
import seedAdmin from "./core/database/seedAdmin.js";

dotenv.config();

const app = express();

// Middlewares
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Allow cookies to be sent in cross-origin requests
  }),
);
app.use(cookieParser());
app.use(passport.initialize());

// Import routes
app.use("/api/v1", v1Routes);

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send("Trusted Handyman API is running");
});

initDatabase().then(() => {
  initCronJobs();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  // Seed the admin user
  // seedAdmin();
}).catch(err => {
  console.error("Failed to initialize database:", err);
});