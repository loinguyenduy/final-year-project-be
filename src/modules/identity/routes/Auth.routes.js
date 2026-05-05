import express from "express";
import { registerNewUser, loginUser, requestRefreshToken, logoutUser, verifyEmail, resendVerifyEmail } from "../controllers/Auth.controller.js";

const router = express.Router();

router.post("/register", registerNewUser);
router.post("/login", loginUser); 
router.post("/refresh", requestRefreshToken);
router.post("/logout", logoutUser);
router.get("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerifyEmail);

export default router;