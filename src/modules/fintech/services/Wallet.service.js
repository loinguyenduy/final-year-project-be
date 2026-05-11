import Wallet from '../models/Wallet.model.js';

const initializeUserWallets = async (userId, role, transaction = null) => {
  try {
    // Use the provided transaction if available, otherwise proceed without it
    const options = transaction ? { transaction } : {};

    const existingWallet = await Wallet.findOne({
      where: { user_id: userId },
      ...options,
    });

    if (existingWallet) {
      return { 
        EM: "Wallets already exist for this user.", 
        EC: 400, 
        DT: "" 
      };
    }

    const walletsToCreate = [];

    if (role === "CUSTOMER") {
      walletsToCreate.push({ 
        user_id: userId, 
        wallet_type: "CUSTOMER_MAIN", 
        balance: 0.0 
      });

    } else if (role === "HANDYMAN") {
      walletsToCreate.push(
        { user_id: userId, wallet_type: "HANDYMAN_MAIN", balance: 0.0 },
        { user_id: userId, wallet_type: "HANDYMAN_ESCROW", balance: 0.0 }
      );

    } else if (role === "ADMIN") {
      walletsToCreate.push(
        { user_id: userId, wallet_type: "SYSTEM_PROFIT", balance: 0.0 },
        { user_id: userId, wallet_type: "SYSTEM_ESCROW", balance: 0.0 }
      );
    }

    if (walletsToCreate.length > 0) {
      await Wallet.bulkCreate(walletsToCreate, options);
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



export { initializeUserWallets };