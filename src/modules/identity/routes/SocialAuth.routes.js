import express from 'express';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import {
  authenticateOAuthCallback,
  beginOAuth,
  handleFacebookCallback,
  handleFacebookLinkInitiate,
  handleFacebookLinkState,
  handleGoogleCallback,
  handleGoogleLinkInitiate,
  handleGoogleLinkState,
  requireOAuthProvider,
} from '../controllers/SocialAuth.controller.js';

const router = express.Router();
const participantOnly = checkUserRole(['CUSTOMER', 'HANDYMAN']);

router.get(
  '/google',
  requireOAuthProvider('google'),
  beginOAuth('google'),
);
router.get(
  '/google/callback',
  requireOAuthProvider('google', { callback: true }),
  authenticateOAuthCallback('google'),
  handleGoogleCallback,
);
router.post(
  '/google/link-state',
  checkUserJWT,
  participantOnly,
  requireOAuthProvider('google'),
  handleGoogleLinkState,
);
router.get(
  '/google/link',
  requireOAuthProvider('google'),
  handleGoogleLinkInitiate,
);

router.get(
  '/facebook',
  requireOAuthProvider('facebook'),
  beginOAuth('facebook'),
);
router.get(
  '/facebook/callback',
  requireOAuthProvider('facebook', { callback: true }),
  authenticateOAuthCallback('facebook'),
  handleFacebookCallback,
);
router.post(
  '/facebook/link-state',
  checkUserJWT,
  participantOnly,
  requireOAuthProvider('facebook'),
  handleFacebookLinkState,
);
router.get(
  '/facebook/link',
  requireOAuthProvider('facebook'),
  handleFacebookLinkInitiate,
);

export default router;
