import cron from 'node-cron';
import { cleanupUnverifiedUsers } from '../../modules/identity/jobs/CleanupUnverified.job.js';
import { cleanupExpiredTransactions } from '../../modules/fintech/jobs/CleanupPayment.job.js';
import { releaseExpiredWarranties } from '../../modules/fintech/jobs/ReleaseWarranty.job.js';
import { getQuoteConfig } from '../../modules/matchmaking/utils/quote.util.js';

let scheduledTasks = [];

const scheduleOptions = () => {
  const timezone = String(process.env.CRON_TIMEZONE || '').trim();
  return timezone ? { noOverlap: true, timezone } : { noOverlap: true };
};

const initCronJobs = () => {
  if (scheduledTasks.length > 0) {
    throw new Error('Cron jobs have already been registered in this process.');
  }
  console.log('[CronJob] Initializing cron jobs...');
  const options = scheduleOptions();

  scheduledTasks.push(cron.schedule('0 2 * * *', async () => {
    await cleanupUnverifiedUsers();
  }, options));

  scheduledTasks.push(cron.schedule('* * * * *', async () => {
    await cleanupExpiredTransactions();
  }, options));

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
      timezone: process.env.CRON_TIMEZONE ? 'configured' : 'system default',
      standard_warranty_days: getQuoteConfig().standardWarrantyDays,
      development_override_minutes: testDelay,
    });
    scheduledTasks.push(cron.schedule(warrantySchedule, async () => {
      try {
        const summary = await releaseExpiredWarranties();
        if (summary.candidates > 0) console.log('[CronJob] Warranty release run completed.', summary);
      } catch (error) {
        console.error('[CronJob] Warranty release run failed:', error?.message || 'unknown error');
      }
    }, options));
  }
  return [...scheduledTasks];
};

const stopCronJobs = async () => {
  const tasks = scheduledTasks;
  scheduledTasks = [];
  await Promise.all(tasks.map((task) => task.stop()));
};

export { initCronJobs, stopCronJobs };
