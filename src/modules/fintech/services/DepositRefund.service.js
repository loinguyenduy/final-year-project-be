import Transaction from '../models/Transaction.model.js';
import Wallet from '../models/Wallet.model.js';

const refundError = (EM, code, DT = '') => ({ EM, EC: 409, code, DT });

const refundHeldDeposit = async (job, transaction) => {
    const originalDeposit = await Transaction.findOne({
        where: {
            id: job.deposit_transaction_id,
            job_id: job.id,
            transaction_type: 'DEPOSIT_10',
            status: 'SUCCESS'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });

    if (!originalDeposit || Number(originalDeposit.amount) !== Number(job.deposit_amount)) {
        return {
            error: refundError(
                'Original deposit transaction is missing or inconsistent.',
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const existingRefund = await Transaction.findOne({
        where: {
            reference_transaction_id: originalDeposit.id,
            transaction_type: 'DEPOSIT_REFUND',
            status: 'SUCCESS'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });

    if (existingRefund) {
        return {
            error: refundError(
                'This deposit has already been refunded.',
                'DEPOSIT_ALREADY_REFUNDED'
            )
        };
    }

    const customerWallet = await Wallet.findOne({
        where: {
            user_id: job.customer_id,
            wallet_type: 'CUSTOMER_MAIN'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });

    if (!customerWallet) {
        return {
            error: {
                EM: 'Customer main wallet not found.',
                EC: 404,
                code: 'CUSTOMER_WALLET_NOT_FOUND',
                DT: ''
            }
        };
    }

    const systemEscrowWallet = await Wallet.findOne({
        where: {
            wallet_type: 'SYSTEM_ESCROW',
            user_id: null
        },
        transaction,
        lock: transaction.LOCK.UPDATE
    });

    if (!systemEscrowWallet) {
        return {
            error: {
                EM: 'SYSTEM_ESCROW wallet not found.',
                EC: 404,
                code: 'SYSTEM_ESCROW_WALLET_NOT_FOUND',
                DT: ''
            }
        };
    }

    if (systemEscrowWallet.is_blocked) {
        return {
            error: refundError(
                'SYSTEM_ESCROW wallet is blocked.',
                'SYSTEM_ESCROW_WALLET_BLOCKED'
            )
        };
    }

    if (originalDeposit.to_wallet_id !== systemEscrowWallet.id) {
        return {
            error: refundError(
                'Original deposit was not paid into SYSTEM_ESCROW.',
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const refundAmount = Number(job.deposit_amount);
    if (Number(systemEscrowWallet.balance) < refundAmount) {
        return {
            error: refundError(
                'SYSTEM_ESCROW does not have enough balance for this refund.',
                'ESCROW_INSUFFICIENT_BALANCE',
                { available_balance: Number(systemEscrowWallet.balance), required_amount: refundAmount }
            )
        };
    }

    await systemEscrowWallet.decrement('balance', { by: refundAmount, transaction });
    await customerWallet.increment('balance', { by: refundAmount, transaction });

    const refundTransaction = await Transaction.create({
        amount: refundAmount,
        transaction_type: 'DEPOSIT_REFUND',
        status: 'SUCCESS',
        payment_method: 'INTERNAL',
        payment_gateway_code: null,
        description: `Refund held deposit for job ${job.id}`,
        from_wallet_id: systemEscrowWallet.id,
        to_wallet_id: customerWallet.id,
        job_id: job.id,
        reference_transaction_id: originalDeposit.id,
        expires_at: null
    }, { transaction });

    return {
        refund_transaction: refundTransaction,
        refunded_amount: refundAmount
    };
};

export { refundHeldDeposit };
