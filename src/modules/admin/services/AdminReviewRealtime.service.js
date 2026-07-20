import { randomUUID } from 'node:crypto';
import { emitToRole, emitToUsers } from '../../../core/realtime/realtime.gateway.js';

const emitAdminReviewSignals = ({ caseType, caseId, userIds = [] }) => {
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
};

export { emitAdminReviewSignals };
