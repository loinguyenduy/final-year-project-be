import express from 'express';
import { handleTopUpWallet, handlePayOSWebhook, handleGetSystemWallets } from '../controllers/Wallet.controller.js';
import {checkUserJWT, checkUserRole} from '../../../core/middlewares/auth.middleware.js';
import { handleVNPayIPN } from '../controllers/Wallet.controller.js';

const router = express.Router();

router.post('/wallets/top-up', checkUserJWT, handleTopUpWallet);
router.get('/wallets/system', checkUserJWT, checkUserRole(['ADMIN']), handleGetSystemWallets);

router.post('/payos-webhook', handlePayOSWebhook);
router.get('/vnpay-ipn', handleVNPayIPN);

export default router;
