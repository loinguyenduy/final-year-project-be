import cron from "node-cron";
import { cleanupUnverifiedUsers } from "../../modules/identity/jobs/CleanupUnverified.job.js";
import { cleanupExpiredTransactions } from "../../modules/fintech/jobs/CleanupPayment.job.js"; 
import { releaseExpiredWarranties } from "../../modules/fintech/jobs/ReleaseWarranty.job.js";
import { getQuoteConfig } from "../../modules/matchmaking/utils/quote.util.js";

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

  const warrantyCronEnabled = String(
    process.env.JOB_WARRANTY_CRON_ENABLED
    ?? process.env.WARRANTY_RELEASE_CRON_ENABLED
    ?? 'true'
  ).toLowerCase() !== 'false';
  const warrantySchedule = process.env.JOB_WARRANTY_CRON_SCHEDULE
    || process.env.WARRANTY_RELEASE_CRON_SCHEDULE
    || '* * * * *';
  if (!warrantyCronEnabled) {
    console.log('[CronJob] Warranty release scheduler is disabled.');
  } else if (!cron.validate(warrantySchedule)) {
    console.error('[CronJob] Invalid Job Warranty cron schedule; scheduler was not started.');
  } else {
    const environment = String(process.env.NODE_ENV || 'development').toLowerCase();
    const testDelay = ['development', 'test'].includes(environment)
      ? process.env.JOB_WARRANTY_TEST_DELAY_MINUTES || null
      : null;
    console.log('[CronJob] Warranty release scheduler enabled.', {
      schedule: warrantySchedule,
      standard_warranty_days: getQuoteConfig().standardWarrantyDays,
      development_override_minutes: testDelay
    });
    cron.schedule(warrantySchedule, async () => {
      try {
        const summary = await releaseExpiredWarranties();
        if (summary.candidates > 0) console.log('[CronJob] Warranty release run completed.', summary);
      } catch (error) {
        console.error('[CronJob] Warranty release run failed.', error);
      }
    });
  }
};

export { initCronJobs };
