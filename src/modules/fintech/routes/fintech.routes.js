import express from 'express';
import {
  handleTopUpWallet,
  handlePayOSWebhook,
  handlePayOSReturn,
  handlePayOSCancel,
  handleGetSystemWallets
} from '../controllers/Wallet.controller.js';
import {checkUserJWT, checkUserRole} from '../../../core/middlewares/auth.middleware.js';
import { getCurrentUserTransactions, getCurrentUserWallets } from '../controllers/TransactionRead.controller.js';

const router = express.Router();

router.post('/wallets/top-up', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN']), handleTopUpWallet);
router.get('/wallets/me', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN']), getCurrentUserWallets);
router.get('/wallets/me/transactions', checkUserJWT, checkUserRole(['CUSTOMER', 'HANDYMAN']), getCurrentUserTransactions);
router.get('/wallets/system', checkUserJWT, checkUserRole(['ADMIN']), handleGetSystemWallets);

router.post('/payos-webhook', handlePayOSWebhook);
router.get('/payos-return', handlePayOSReturn);
router.get('/payos-cancel', handlePayOSCancel);

export default router;
