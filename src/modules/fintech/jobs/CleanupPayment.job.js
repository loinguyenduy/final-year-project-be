import { Op } from 'sequelize';
import moment from 'moment';
import Transaction from '../models/Transaction.model.js';

const cleanupExpiredTransactions = async () => {
  try {
    const thirtyMinutesAgo = moment().subtract(15, 'minutes').toDate();

    const [updatedCount] = await Transaction.update(
      { status: 'EXPIRED' },
      {
        where: {
          status: 'PENDING',
          transaction_type: 'TOP_UP',
          createdAt: {
            [Op.lt]: thirtyMinutesAgo 
          }
        }
      }
    );

    if (updatedCount > 0) {
      console.log(`[CronJob] Cleaned up ${updatedCount} expired transactions.`);
    }
  } catch (error) {
    console.error("[CronJob] Error in cleanupExpiredTransactions:", error);
  }
};

export { cleanupExpiredTransactions };