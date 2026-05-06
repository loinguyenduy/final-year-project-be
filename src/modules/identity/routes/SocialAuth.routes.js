import express from "express";
import passport from "../../../core/middlewares/passport.middleware.js";
import { handleGoogleCallback, handleFacebookCallback } from "../controllers/SocialAuth.controller.js";
const router = express.Router();

// 1. Endpoint gọi để bắt đầu chuyển hướng sang Google
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false })
);

// 2. Endpoint Google gọi lại sau khi người dùng đồng ý
router.get("/google/callback", passport.authenticate("google", { session: false, failureRedirect: "/login" }), handleGoogleCallback);

// --- FACEBOOK ---
// Bắt buộc phải có scope email để Meta biết mình cần xin thông tin này
router.get("/facebook", passport.authenticate("facebook", { scope: ["public_profile", "email"], session: false }));
router.get("/facebook/callback", passport.authenticate("facebook", { session: false, failureRedirect: "/login" }), handleFacebookCallback);

export default router;