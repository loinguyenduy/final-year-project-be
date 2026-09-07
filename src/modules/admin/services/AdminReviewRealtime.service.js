import { randomUUID } from 'node:crypto';
import { emitToRole, emitToUsers } from '../../../core/realtime/realtime.gateway.js';
import { emitAdminJobUpdated } from '../../matchmaking/sockets/JobLifecycle.gateway.js';

const emitAdminReviewSignals = ({ caseType, caseId, jobId = null, userIds = [] }) => {
  const occurredAt = new Date().toISOString();
  emitToRole('ADMIN', 'ADMIN_REVIEW_QUEUE_UPDATED', {
    event_id: randomUUID(),
    occurred_at: occurredAt,
    queue: 'ADMIN_REVIEW'
  });
  if (userIds.length) {
    emitToUsers(userIds, 'REVIEW_CASE_UPDATED', {
      event_id: randomUUID(),
      occurred_at: occurredAt,
      resource: { case_type: caseType, case_id: caseId }
    });
  }
  if (jobId) {
    emitAdminJobUpdated({
      jobId,
      occurredAt,
      dedupeKey: `ADMIN_REVIEW:${caseType}:${caseId}`
    });
  }
};

export { emitAdminReviewSignals };
