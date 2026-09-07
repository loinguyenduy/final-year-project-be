import 'dotenv/config';

const run = async () => {
  const [{ default: db }, { default: Wallet }] = await Promise.all([
    import('../../src/core/database/connection.js'),
    import('../../src/modules/fintech/models/Wallet.model.js'),
  ]);
  try {
    await db.authenticate();
    const [profitCount, escrowCount] = await Promise.all([
      Wallet.count({ where: { wallet_type: 'SYSTEM_PROFIT' } }),
      Wallet.count({ where: { wallet_type: 'SYSTEM_ESCROW' } }),
    ]);
    if (profitCount !== 1 || escrowCount !== 1) {
      throw new Error('Expected exactly one SYSTEM_PROFIT and one SYSTEM_ESCROW Wallet.');
    }
    console.log('System Wallet verification passed: SYSTEM_PROFIT=1, SYSTEM_ESCROW=1.');
  } finally {
    await db.close();
  }
};

run().catch((error) => {
  console.error(`System Wallet verification failed: ${error?.message || 'unknown error'}`);
  process.exitCode = 1;
});
