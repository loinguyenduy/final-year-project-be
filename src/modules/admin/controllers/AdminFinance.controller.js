import { getAdminTransactionDetail, listAdminTransactions, listAdminWallets } from '../services/AdminFinance.service.js';
import { handleAdminManagementError } from './AdminUser.controller.js';

const respond = (res, code, message, data) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ EM: message, EC: 0, code, DT: data });
};
const getAdminWallets = async (req, res) => {
  try { return respond(res, 'ADMIN_WALLETS_RETRIEVED', 'Admin Wallets retrieved successfully.', await listAdminWallets({ query: req.query, admin: req.admin, correlationId: req.correlationId })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const getAdminTransactions = async (req, res) => {
  try { return respond(res, 'ADMIN_TRANSACTIONS_RETRIEVED', 'Admin Transactions retrieved successfully.', await listAdminTransactions({ query: req.query, admin: req.admin, correlationId: req.correlationId })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
const getAdminTransaction = async (req, res) => {
  try { return respond(res, 'ADMIN_TRANSACTION_RETRIEVED', 'Admin Transaction detail retrieved successfully.', await getAdminTransactionDetail({ transactionId: req.params.transactionId, admin: req.admin, correlationId: req.correlationId })); }
  catch (error) { return handleAdminManagementError(req, res, error); }
};
export { getAdminTransaction, getAdminTransactions, getAdminWallets };
