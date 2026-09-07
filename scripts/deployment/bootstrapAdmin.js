import 'dotenv/config';
import { validatePassword } from '../../src/modules/identity/constants/password.constants.js';

const CONFIRMATION = 'CREATE_PRODUCTION_ADMIN';
const hasValidateOnly = process.argv.includes('--validate-only')
  || String(process.env.npm_config_validate_only || '').toLowerCase() === 'true';

const fail = (message) => {
  throw new Error(message);
};

const validateInputs = () => {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
    fail('NODE_ENV must be production.');
  }
  if (String(process.env.DB_SYNC_ALTER || '').trim().toLowerCase() !== 'false') {
    fail('DB_SYNC_ALTER must be false.');
  }
  if (process.env.BOOTSTRAP_ADMIN_CONFIRM !== CONFIRMATION) {
    fail(`BOOTSTRAP_ADMIN_CONFIRM must equal ${CONFIRMATION}.`);
  }

  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  const fullName = String(process.env.BOOTSTRAP_ADMIN_NAME || '').trim();
  const missing = [];
  if (!email) missing.push('BOOTSTRAP_ADMIN_EMAIL');
  if (!password) missing.push('BOOTSTRAP_ADMIN_PASSWORD');
  if (!fullName) missing.push('BOOTSTRAP_ADMIN_NAME');
  if (missing.length) fail(`Missing required variables: ${missing.join(', ')}.`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
    fail('BOOTSTRAP_ADMIN_EMAIL must be a valid email address.');
  }
  if (fullName.length > 100) {
    fail('BOOTSTRAP_ADMIN_NAME must not exceed 100 characters.');
  }
  const passwordError = validatePassword(password);
  if (passwordError) fail(passwordError);
  return { email, password, fullName };
};

const run = async () => {
  const inputs = validateInputs();
  if (hasValidateOnly) {
    console.log('Admin bootstrap configuration is valid; no database connection was made.');
    return;
  }

  const [
    { default: db },
    { default: User },
    { default: AuthProvider },
    { hashUserPassword },
  ] = await Promise.all([
    import('../../src/core/database/connection.js'),
    import('../../src/modules/identity/models/User.model.js'),
    import('../../src/modules/identity/models/AuthProvider.model.js'),
    import('../../src/modules/identity/services/Auth.service.js'),
  ]);

  await db.authenticate();
  const transaction = await db.transaction();
  let outcome = 'existing';
  try {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('trusted-handyman-bootstrap-admin'))",
      { transaction },
    );
    const admins = await User.findAll({ where: { role: 'ADMIN' }, transaction });
    const matchingUser = await User.findOne({ where: { email: inputs.email }, transaction });

    if (matchingUser && matchingUser.role !== 'ADMIN') {
      fail('The requested email belongs to a participant account.');
    }
    if (matchingUser && !matchingUser.is_active) {
      fail('The matching Admin is inactive and will not be modified.');
    }
    if (admins.some((admin) => !matchingUser || admin.id !== matchingUser.id)) {
      fail('A different Admin already exists; refusing to create another.');
    }

    if (!matchingUser) {
      const passwordHash = await hashUserPassword(inputs.password);
      const admin = await User.create({
        full_name: inputs.fullName,
        email: inputs.email,
        role: 'ADMIN',
        is_active: true,
        is_email_verified: true,
        kyc_status: 'VERIFIED',
      }, { transaction });
      await AuthProvider.create({
        user_id: admin.id,
        provider: 'LOCAL',
        password_hash: passwordHash,
      }, { transaction });
      outcome = 'created';
    } else {
      const localProvider = await AuthProvider.findOne({
        where: { user_id: matchingUser.id, provider: 'LOCAL' },
        transaction,
      });
      if (!localProvider) {
        const passwordHash = await hashUserPassword(inputs.password);
        await AuthProvider.create({
          user_id: matchingUser.id,
          provider: 'LOCAL',
          password_hash: passwordHash,
        }, { transaction });
        outcome = 'local-provider-created';
      } else if (!localProvider.password_hash) {
        fail('The existing LOCAL provider has no password hash and will not be overwritten.');
      }
    }
    await transaction.commit();
    console.log(`Admin bootstrap completed: ${outcome}. No credentials were printed.`);
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  } finally {
    await db.close();
  }
};

run().catch((error) => {
  console.error(`Admin bootstrap failed: ${error?.message || 'unknown error'}`);
  process.exitCode = 1;
});
