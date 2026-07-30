import { getMyTransactions, getMyWallets } from '../services/TransactionRead.service.js';
import { AdminManagementError } from '../../admin/utils/adminManagementValidation.util.js';

const handleError = (req, res, error) => {
  if (error instanceof AdminManagementError) return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: error.data });
  console.error('[wallet-read] Unexpected error.', { correlation_id: req.correlationId, error: error.message });
  return res.status(500).json({ EM: 'Internal server error.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};
const getCurrentUserWallets = async (req, res) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); return res.status(200).json({ EM: 'Wallets retrieved successfully.', EC: 0, code: 'MY_WALLETS_RETRIEVED', DT: await getMyWallets(req.user.id) }); }
  catch (error) { return handleError(req, res, error); }
};
const getCurrentUserTransactions = async (req, res) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); return res.status(200).json({ EM: 'Transactions retrieved successfully.', EC: 0, code: 'MY_TRANSACTIONS_RETRIEVED', DT: await getMyTransactions({ userId: req.user.id, query: req.query }) }); }
  catch (error) { return handleError(req, res, error); }
};
export { getCurrentUserTransactions, getCurrentUserWallets };
