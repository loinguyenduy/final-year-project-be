import cron from "node-cron";
import { cleanupUnverifiedUsers } from "../../modules/identity/jobs/CleanupUnverified.job.js";

const initCronJobs = () => {
  console.log("[CronJob] Initializing cron jobs...");

  // Để TEST: Chạy mỗi 1 phút -> "* * * * *"
  cron.schedule("0 2 * * *", async () => {
    await cleanupUnverifiedUsers();
  });
};

export { initCronJobs };
