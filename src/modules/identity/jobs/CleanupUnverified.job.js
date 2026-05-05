import { Op } from "sequelize";
import db from "../../../core/database/connection.js";
import User from "../models/User.model.js";
import AuthProvider from "../models/AuthProvider.model.js";
import VerificationToken from "../models/VerificationToken.model.js";

const cleanupUnverifiedUsers = async () => {
  console.log("[CronJob] Running cleanup for unverified users...");
  const t = await db.transaction();

  try {
    const timeLimit = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all unverified users created more than 24 hours ago
    const spamUsers = await User.findAll({
      where: {
        is_email_verified: false,
        createdAt: { [Op.lt]: timeLimit }, // createdAt < timeLimit
      },
    });

    if (spamUsers.length === 0) {
      console.log("[CronJob] No unverified users found for cleanup.");
      await t.rollback();
      return;
    }

    const userIds = spamUsers.map((user) => user.id); //get all user id to delete related data

    // Delete user data in AuthProvider
    await AuthProvider.destroy({
      where: { user_id: { [Op.in]: userIds } },
      transaction: t,
    });
    //Delete old token in VerificationToken
    await VerificationToken.destroy({
      where: { user_id: { [Op.in]: userIds } },
      transaction: t,
    });

    // Delete the unverified users
    await User.destroy({ where: { id: { [Op.in]: userIds } }, transaction: t });

    await t.commit();
    console.log(`[CronJob] Deleted ${spamUsers.length} unverified users and their related data.`);
  } catch (error) {
    await t.rollback();
    console.log("[CronJob] Error occurred while cleaning up unverified users: ", error);
  }
};

export { cleanupUnverifiedUsers };
