import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { initDatabase } from "./core/database/setup.js";
import { initCronJobs } from "./core/cron/index.js";
import v1Routes from "./core/routes/v1.routes.js";
import passport from "./core/middlewares/passport.middleware.js";
import { initializeSystemWallets } from "./modules/fintech/services/Wallet.service.js";
import { initializeChatSocket } from "./modules/chat/sockets/chat.socket.js";
import seedAdmin from './core/database/seedAdmin.js';
import { correlationIdMiddleware } from './core/middlewares/correlationId.middleware.js';
import { getRefreshCookieOptions } from './modules/identity/utils/authCookie.util.js';
// import seedServices from "./core/database/seedServices.js";

dotenv.config();
getRefreshCookieOptions();

const app = express();
const httpServer = createServer(app);

const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy && !['false', '0'].includes(trustProxy.toLowerCase())) {
  const parsedTrustProxy = trustProxy.toLowerCase() === 'true'
    ? true
    : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
  app.set('trust proxy', parsedTrustProxy);
}

// Middlewares
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
    exposedHeaders: ["X-Correlation-ID"],
    credentials: true, // Allow cookies to be sent in cross-origin requests
  }),
);
app.use(cookieParser());
app.use(passport.initialize());
app.use(correlationIdMiddleware);

// Import routes
app.use("/api/v1", v1Routes);

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send("Trusted Handyman API is running");
});

initDatabase().then(() => {
  return seedAdmin();
}).then(() => {
  return initializeSystemWallets();
}).then(() => {
  initCronJobs();
  initializeChatSocket(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  // Seed the mock services
  // seedServices();
}).catch(err => {
  console.error("Failed to initialize database:", err);
});
