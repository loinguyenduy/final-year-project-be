import express from 'express';
import {
  handleTopUpWallet,
  handlePayOSWebhook,
  handlePayOSReturn,
  handlePayOSCancel,
  handleGetSystemWallets
} from '../controllers/Wallet.controller.js';
import {checkUserJWT, checkUserRole} from '../../../core/middlewares/auth.middleware.js';

const router = express.Router();

router.post('/wallets/top-up', checkUserJWT, handleTopUpWallet);
router.get('/wallets/system', checkUserJWT, checkUserRole(['ADMIN']), handleGetSystemWallets);

router.post('/payos-webhook', handlePayOSWebhook);
router.get('/payos-return', handlePayOSReturn);
router.get('/payos-cancel', handlePayOSCancel);

export default router;
