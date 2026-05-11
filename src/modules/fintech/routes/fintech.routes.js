import express from 'express';
import { handleTopUpWallet, handlePayOSWebhook } from '../controllers/Wallet.controller.js';
import {checkUserJWT} from '../../../core/middlewares/auth.middleware.js';
import { handleVNPayIPN } from '../controllers/Wallet.controller.js';

const router = express.Router();

router.post('/wallets/top-up', checkUserJWT, handleTopUpWallet);

router.post('/payos-webhook', handlePayOSWebhook);
router.get('/vnpay-ipn', handleVNPayIPN);

export default router;