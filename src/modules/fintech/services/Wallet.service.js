import Wallet from '../models/Wallet.model.js';

const SYSTEM_WALLET_TYPES = ['SYSTEM_PROFIT', 'SYSTEM_ESCROW'];

const initializeSystemWallets = async (transaction = null) => {
  const options = transaction ? { transaction } : {};
  const summary = { created: 0, existing: 0 };

  for (const walletType of SYSTEM_WALLET_TYPES) {
    const [, created] = await Wallet.findOrCreate({
      where: { wallet_type: walletType },
      defaults: {
        user_id: null,
        wallet_type: walletType,
        balance: 0
      },
      ...options
    });
    summary[created ? 'created' : 'existing'] += 1;
  }
  return summary;
};

const initializeUserWallets = async (userId, role, transaction = null) => {
  try {
    const options = transaction ? { transaction } : {};

    if (role === "ADMIN") {
      await initializeSystemWallets(transaction);
      return {
        EM: "Shared system wallets are ready.",
        EC: 0,
        DT: ""
      };
    }

    let walletTypes = [];

    if (role === "CUSTOMER") {
      walletTypes = ["CUSTOMER_MAIN"];
    } else if (role === "HANDYMAN") {
      walletTypes = ["HANDYMAN_MAIN", "HANDYMAN_ESCROW"];
    }

    for (const walletType of walletTypes) {
      await Wallet.findOrCreate({
        where: {
          user_id: userId,
          wallet_type: walletType
        },
        defaults: {
          user_id: userId,
          wallet_type: walletType,
          balance: 0
        },
        ...options
      });
    }

    return {
      EM: "Wallets initialized successfully.", 
      EC: 0, 
      DT: "" 
    };
  } catch (error) {
    console.error(">>> Error in initializeUserWallets:", error);
    return { 
      EM: "An error occurred while initializing wallets.", 
      EC: 500, 
      DT: "" 
    };
  }
};

const getSystemWalletsService = async () => {
  try {
    await initializeSystemWallets();

    const wallets = await Wallet.findAll({
      where: { wallet_type: SYSTEM_WALLET_TYPES },
      attributes: ['wallet_type', 'balance', 'currency', 'is_blocked', 'updatedAt'],
      order: [['wallet_type', 'ASC']]
    });

    return {
      EM: "System wallets retrieved successfully.",
      EC: 0,
      DT: wallets.map((wallet) => ({
        wallet_type: wallet.wallet_type,
        currency: wallet.currency,
        available_balance: String(wallet.balance ?? '0.00'),
        status: wallet.is_blocked ? 'BLOCKED' : 'ACTIVE',
        updated_at: wallet.updatedAt
      }))
    };
  } catch (error) {
    console.error(">>> Error in getSystemWalletsService:", error);
    return {
      EM: "Unable to retrieve system wallets.",
      EC: 500,
      DT: []
    };
  }
};

export {
  initializeUserWallets,
  initializeSystemWallets,
  getSystemWalletsService
};
