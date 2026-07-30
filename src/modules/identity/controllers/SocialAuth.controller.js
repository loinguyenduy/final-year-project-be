import jwt from 'jsonwebtoken';
import passport from '../../../core/middlewares/passport.middleware.js';
import {
    upsertGoogleUser,
    upsertFacebookUser,
    linkGoogleProvider,
    linkFacebookProvider
} from '../services/SocialAuth.service.js';
import dotenv from 'dotenv';
import { setRefreshCookie } from '../utils/authCookie.util.js';

dotenv.config();

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const backendUrl  = process.env.BACKEND_URL  || 'http://localhost:5000';

// ─── Helper: decode a link-state JWT ─────────────────────────────────────────
const decodeLinkState = (state, expectedAction) => {
    if (!state) return null;
    try {
        const decoded = jwt.verify(state, process.env.JWT_ACCESS_SECRET);
        if (decoded.action !== expectedAction) return null;
        return decoded;
    } catch {
        return null;
    }
};

// ─── GOOGLE LOGIN/REGISTER (unchanged behaviour) ──────────────────────────────
const handleGoogleCallback = async (req, res) => {
    try {
        const googleProfile = req.user;
        if (!googleProfile) {
            return res.redirect(`${frontendUrl}/login?error=google_auth_failed`);
        }

        // Check if this is a link-account flow
        const linkState = decodeLinkState(req.query.state, 'link_google');

        if (linkState) {
            // ── Link flow ──
            const result = await linkGoogleProvider(linkState.userId, googleProfile);
            if (result.EC === 0) {
                return res.redirect(`${frontendUrl}/social-link-callback?linked=google`);
            }
            const errorMsg = encodeURIComponent(result.EM);
            return res.redirect(`${frontendUrl}/social-link-callback?error=${errorMsg}`);
        }

        // ── Login / register flow ──
        const data = await upsertGoogleUser(googleProfile);
        if (data.EC === 0) {
            setRefreshCookie(res, data.DT.refresh_token);
            delete data.DT.refresh_token;
            return res.redirect(`${frontendUrl}/social-callback?token=${data.DT.access_token}`);
        }

        if (data.code === 'ADMIN_PORTAL_REQUIRED') {
            return res.redirect(`${frontendUrl}/login?error=admin_portal_required`);
        }

        return res.redirect(`${frontendUrl}/login?error=social_auth_failed`);
    } catch (error) {
        console.error('Error in handleGoogleCallback: ', error);
        return res.redirect(`${frontendUrl}/login?error=server_error`);
    }
};

// ─── GOOGLE LINK INITIATE ─────────────────────────────────────────────────────
// Browser redirect: GET /api/v1/auth/google/link?token=<access_token>
const handleGoogleLinkInitiate = (req, res, next) => {
    const token = req.query.token;

    if (!token) {
        return res.redirect(`${frontendUrl}/social-link-callback?error=no_token`);
    }

    let userId, role;
    try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        userId = decoded.id;
        role   = decoded.role;
    } catch {
        return res.redirect(`${frontendUrl}/social-link-callback?error=invalid_token`);
    }

    if (role === 'ADMIN') {
        return res.redirect(`${frontendUrl}/social-link-callback?error=admin_portal_required`);
    }

    const state = jwt.sign(
        { userId, role, action: 'link_google' },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '10m' }
    );

    passport.authenticate('google', {
        scope: ['profile', 'email'],
        session: false,
        state
    })(req, res, next);
};

// ─── FACEBOOK LOGIN/REGISTER (unchanged behaviour) ────────────────────────────
const handleFacebookCallback = async (req, res) => {
    try {
        if (!req.user) {
            return res.redirect(`${frontendUrl}/login?error=facebook_auth_failed`);
        }

        // Check if this is a link-account flow
        const linkState = decodeLinkState(req.query.state, 'link_facebook');

        if (linkState) {
            // ── Link flow ──
            const result = await linkFacebookProvider(linkState.userId, req.user);
            if (result.EC === 0) {
                return res.redirect(`${frontendUrl}/social-link-callback?linked=facebook`);
            }
            const errorMsg = encodeURIComponent(result.EM);
            return res.redirect(`${frontendUrl}/social-link-callback?error=${errorMsg}`);
        }

        // ── Login / register flow ──
        const data = await upsertFacebookUser(req.user);
        if (data.EC === 0) {
            setRefreshCookie(res, data.DT.refresh_token);
            delete data.DT.refresh_token;
            return res.redirect(`${frontendUrl}/social-callback?token=${data.DT.access_token}`);
        }

        if (data.code === 'ADMIN_PORTAL_REQUIRED') {
            return res.redirect(`${frontendUrl}/login?error=admin_portal_required`);
        }

        return res.redirect(`${frontendUrl}/login?error=facebook_auth_failed`);
    } catch (error) {
        console.error('Error in handleFacebookCallback: ', error);
        return res.redirect(`${frontendUrl}/login?error=server_error`);
    }
};

// ─── FACEBOOK LINK INITIATE ───────────────────────────────────────────────────
// Browser redirect: GET /api/v1/auth/facebook/link?token=<access_token>
const handleFacebookLinkInitiate = (req, res, next) => {
    const token = req.query.token;

    if (!token) {
        return res.redirect(`${frontendUrl}/social-link-callback?error=no_token`);
    }

    let userId, role;
    try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        userId = decoded.id;
        role   = decoded.role;
    } catch {
        return res.redirect(`${frontendUrl}/social-link-callback?error=invalid_token`);
    }

    if (role === 'ADMIN') {
        return res.redirect(`${frontendUrl}/social-link-callback?error=admin_portal_required`);
    }

    const state = jwt.sign(
        { userId, role, action: 'link_facebook' },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '10m' }
    );

    passport.authenticate('facebook', {
        scope: ['public_profile', 'email'],
        session: false,
        state
    })(req, res, next);
};

export {
    handleGoogleCallback,
    handleGoogleLinkInitiate,
    handleFacebookCallback,
    handleFacebookLinkInitiate
};
