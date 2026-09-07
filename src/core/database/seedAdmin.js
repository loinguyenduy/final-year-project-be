import User from "../../modules/identity/models/User.model.js";
import AuthProvider from "../../modules/identity/models/AuthProvider.model.js";
import bcrypt from "bcryptjs";
import db from './connection.js';

const seedAdmin = async () => {
  const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
  const enabled = String(process.env.ENABLE_ADMIN_SEED || '').toLowerCase() === 'true';
  if (!enabled) return { created: false, reason: 'disabled' };
  if (environment !== 'development') {
    throw new Error('Admin seed is only allowed when NODE_ENV=development.');
  }

  const email = String(process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || '');
  const fullName = String(process.env.SEED_ADMIN_NAME || 'System Admin').trim();
  if (!email || !fullName || password.length < 6) {
    throw new Error('SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, and a password of at least 6 characters are required.');
  }

  const existingAdmin = await User.findOne({ where: { email } });
  if (existingAdmin) {
    if (existingAdmin.role !== 'ADMIN') {
      throw new Error('SEED_ADMIN_EMAIL belongs to a non-admin account.');
    }
    return { created: false, reason: 'already_exists' };
  }

  const hashPassword = await bcrypt.hash(password, 10);
  const transaction = await db.transaction();
  let admin;
  try {
    admin = await User.create({
      full_name: fullName,
      email,
      role: 'ADMIN',
      is_email_verified: true,
      kyc_status: 'VERIFIED'
    }, { transaction });
    await AuthProvider.create({
      user_id: admin.id,
      provider: 'LOCAL',
      password_hash: hashPassword
    }, { transaction });
    await transaction.commit();
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
  console.info('[seed] Administrator account created.', { admin_id: admin.id, email });
  return { created: true };
};

export default seedAdmin;
