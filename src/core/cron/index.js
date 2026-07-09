import cron from "node-cron";
import { cleanupUnverifiedUsers } from "../../modules/identity/jobs/CleanupUnverified.job.js";
import { cleanupExpiredTransactions } from "../../modules/fintech/jobs/CleanupPayment.job.js"; 

const initCronJobs = () => {
  console.log("[CronJob] Initializing cron jobs...");

  // Chạy mỗi 1 phút -> "* * * * *"
  cron.schedule("0 2 * * *", async () => {
    await cleanupUnverifiedUsers();
  });

  // Dọn dẹp giao dịch treo mỗi 15 phút một lần
  cron.schedule("* * * * *", async () => {
    await cleanupExpiredTransactions();
  });
};

export { initCronJobs };
