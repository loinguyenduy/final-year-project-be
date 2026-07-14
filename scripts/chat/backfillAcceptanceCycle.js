import dotenv from 'dotenv';
import { Op } from 'sequelize';
import { db } from '../../src/core/database/setup.js';
import Conversation from '../../src/modules/chat/models/Conversation.model.js';
import { CHAT_ALLOWED_JOB_STATUSES } from '../../src/modules/chat/constants/chat.constants.js';
import Job from '../../src/modules/matchmaking/models/Job.model.js';
import { validateAcceptedJobInvariants } from '../../src/modules/matchmaking/services/AcceptedJob.service.js';

dotenv.config();

const logSkipped = (jobId, reason) => {
  console.warn(`[SKIPPED] job_id=${jobId} reason=${reason}`);
};

const assertSafeEnvironment = () => {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Backfill is disabled in production.');
  }
  if (String(process.env.BACKFILL_ACCEPTANCE_CYCLE_CONFIRM || '').toLowerCase() !== 'true') {
    throw new Error('Set BACKFILL_ACCEPTANCE_CYCLE_CONFIRM=true to run this development backfill.');
  }
};

const run = async () => {
  assertSafeEnvironment();
  await db.authenticate();

  const candidateIds = await Job.findAll({
    where: {
      acceptance_cycle: 0,
      current_status: { [Op.in]: CHAT_ALLOWED_JOB_STATUSES }
    },
    attributes: ['id'],
    raw: true
  });

  let updated = 0;
  let skipped = 0;

  for (const candidate of candidateIds) {
    const transaction = await db.transaction();
    try {
      const job = await Job.findByPk(candidate.id, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (!job || Number(job.acceptance_cycle) !== 0) {
        await transaction.rollback();
        skipped += 1;
        logSkipped(candidate.id, 'already_processed_or_missing');
        continue;
      }
      if (!CHAT_ALLOWED_JOB_STATUSES.includes(job.current_status)) {
        await transaction.rollback();
        skipped += 1;
        logSkipped(candidate.id, `status_changed_to_${job.current_status}`);
        continue;
      }

      const invariant = await validateAcceptedJobInvariants(job, { transaction });
      if (invariant.error) {
        await transaction.rollback();
        skipped += 1;
        logSkipped(candidate.id, `${invariant.error.code || 'ACCEPTED_DATA_INCONSISTENT'}:${invariant.error.EM}`);
        continue;
      }

      const cycleZeroConversations = await Conversation.findAll({
        where: { job_id: job.id, acceptance_cycle: 0 },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      const inconsistentConversation = cycleZeroConversations.find((conversation) => (
        conversation.customer_id !== job.customer_id
        || conversation.handyman_id !== job.selected_handyman_id
        || conversation.selected_bid_id !== job.selected_bid_id
      ));
      if (inconsistentConversation) {
        await transaction.rollback();
        skipped += 1;
        logSkipped(candidate.id, `conversation_${inconsistentConversation.id}_does_not_match_job`);
        continue;
      }

      await job.update({ acceptance_cycle: 1 }, { transaction });
      for (const conversation of cycleZeroConversations) {
        await conversation.update({ acceptance_cycle: 1 }, { transaction });
      }
      await transaction.commit();

      updated += 1;
      console.log(`[UPDATED] job_id=${job.id} acceptance_cycle=1 conversations=${cycleZeroConversations.length}`);
    } catch (error) {
      if (!transaction.finished) await transaction.rollback();
      skipped += 1;
      logSkipped(candidate.id, error.message);
    }
  }

  console.log(`[SUMMARY] candidates=${candidateIds.length} updated=${updated} skipped=${skipped}`);
};

run()
  .catch((error) => {
    console.error('[FAILED] acceptance cycle backfill:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
