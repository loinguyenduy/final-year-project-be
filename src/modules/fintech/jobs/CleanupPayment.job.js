import { Op } from 'sequelize';
import moment from 'moment';
import Transaction from '../models/Transaction.model.js';
import { expireTransactionByIdService } from '../services/PaymentSettlement.service.js';

const cleanupExpiredTransactions = async () => {
  try {
    const fifteenMinutesAgo = moment().subtract(15, 'minutes').toDate();
    const now = new Date();

    const [expiredTopUpCount] = await Transaction.update(
      { status: 'EXPIRED' },
      {
        where: {
          status: 'PENDING',
          transaction_type: 'TOP_UP',
          createdAt: {
            [Op.lt]: fifteenMinutesAgo
          }
        }
      }
    );

    const expiredDeposits = await Transaction.findAll({
      where: {
        status: 'PENDING',
        transaction_type: 'DEPOSIT_10',
        [Op.or]: [
          { expires_at: { [Op.lte]: now } },
          {
            expires_at: null,
            createdAt: { [Op.lt]: fifteenMinutesAgo }
          }
        ]
      },
      attributes: ['id']
    });

    let expiredDepositCount = 0;
    for (const deposit of expiredDeposits) {
      const result = await expireTransactionByIdService(deposit.id);
      if (result.EC === 0 && !result.DT?.already_processed) {
        expiredDepositCount += 1;
      }
    }

    if (expiredTopUpCount > 0 || expiredDepositCount > 0) {
      console.log(
        `[CronJob] Expired ${expiredTopUpCount} top-up(s) and ${expiredDepositCount} deposit(s).`
      );
    }
  } catch (error) {
    console.error("[CronJob] Error in cleanupExpiredTransactions:", error);
  }
};

export { cleanupExpiredTransactions };
