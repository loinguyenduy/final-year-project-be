import express from "express";
import passport from "../../../core/middlewares/passport.middleware.js";
import { handleGoogleCallback, handleFacebookCallback } from "../controllers/SocialAuth.controller.js";
const router = express.Router();
// --- GOOGLE ---
// Route to initiate Google OAuth flow
router.get("/google", passport.authenticate("google", 
  { scope: ["profile", "email"], session: false }));

// Route to handle Google OAuth callback
router.get("/google/callback", passport.authenticate("google", 
  { session: false, failureRedirect: "/login" }), handleGoogleCallback);

// --- FACEBOOK ---
router.get("/facebook", passport.authenticate("facebook", 
  { scope: ["public_profile", "email"], session: false }));
router.get("/facebook/callback", passport.authenticate("facebook", 
  { session: false, failureRedirect: "/login" }), handleFacebookCallback);

export default router;