import express from 'express';
import passport from '../../../core/middlewares/passport.middleware.js';
import {
    handleGoogleCallback,
    handleGoogleLinkInitiate,
    handleFacebookCallback,
    handleFacebookLinkInitiate
} from '../controllers/SocialAuth.controller.js';

const router = express.Router();

// ─── GOOGLE ───────────────────────────────────────────────────────────────────

// Login / register
router.get('/google', passport.authenticate('google',
    { scope: ['profile', 'email'], session: false }));

router.get('/google/callback', passport.authenticate('google',
    { session: false, failureRedirect: '/login' }), handleGoogleCallback);

// Link existing account to Google (browser redirect with ?token=<access_token>)
router.get('/google/link', handleGoogleLinkInitiate);

// ─── FACEBOOK ─────────────────────────────────────────────────────────────────

// Login / register
router.get('/facebook', passport.authenticate('facebook',
    { scope: ['public_profile', 'email'], session: false }));

router.get('/facebook/callback', passport.authenticate('facebook',
    { session: false, failureRedirect: '/login' }), handleFacebookCallback);

// Link existing account to Facebook (browser redirect with ?token=<access_token>)
router.get('/facebook/link', handleFacebookLinkInitiate);

export default router;
