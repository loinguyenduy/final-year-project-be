import express from 'express';
import {
  handleTopUpWallet,
  handlePayOSWebhook,
  handlePayOSReturn,
  handlePayOSCancel,
  handleGetSystemWallets
} from '../controllers/Wallet.controller.js';
import {checkUserJWT, checkUserRole} from '../../../core/middlewares/auth.middleware.js';
import { handleVNPayIPN, handleVNPayReturn } from '../controllers/Wallet.controller.js';

const router = express.Router();

router.post('/wallets/top-up', checkUserJWT, handleTopUpWallet);
router.get('/wallets/system', checkUserJWT, checkUserRole(['ADMIN']), handleGetSystemWallets);

router.post('/payos-webhook', handlePayOSWebhook);
router.get('/payos-return', handlePayOSReturn);
router.get('/payos-cancel', handlePayOSCancel);
router.get('/payos-deposit-return', handlePayOSReturn);
router.get('/payos-deposit-cancel', handlePayOSCancel);
router.get('/vnpay-ipn', handleVNPayIPN);
router.get('/vnpay-return', handleVNPayReturn);
router.get('/vnpay-deposit-return', handleVNPayReturn);

export default router;
