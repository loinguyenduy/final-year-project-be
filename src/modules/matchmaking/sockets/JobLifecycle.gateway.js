import { randomUUID } from 'node:crypto';
import { emitToRole, emitToUsers } from '../../../core/realtime/realtime.gateway.js';

const JOB_LIFECYCLE_EVENTS = Object.freeze({
    BID_SUBMITTED: 'JOB_BID_SUBMITTED',
    BID_UPDATED: 'JOB_BID_UPDATED',
    BID_WITHDRAWN: 'JOB_BID_WITHDRAWN',
    ACCEPTED: 'JOB_ACCEPTED',
    EN_ROUTE: 'JOB_EN_ROUTE',
    ARRIVAL_REQUESTED: 'JOB_ARRIVAL_REQUESTED',
    ARRIVAL_REJECTED: 'JOB_ARRIVAL_REJECTED',
    ARRIVED: 'JOB_ARRIVED',
    QUOTE_SUBMITTED: 'JOB_QUOTE_SUBMITTED',
    QUOTE_ACCEPTED: 'JOB_QUOTE_ACCEPTED',
    QUOTE_REJECTED: 'JOB_QUOTE_REJECTED',
    PAYMENT_REQUIRED: 'JOB_PAYMENT_REQUIRED',
    PAYMENT_COMPLETED: 'JOB_PAYMENT_COMPLETED',
    IN_PROGRESS: 'JOB_IN_PROGRESS',
    COMPLETION_REQUESTED: 'JOB_COMPLETION_REQUESTED',
    COMPLETION_REJECTED: 'JOB_COMPLETION_REJECTED',
    COMPLETION_CONFIRMED: 'JOB_COMPLETION_CONFIRMED',
    WARRANTY_STARTED: 'JOB_WARRANTY_STARTED',
    WARRANTY_CLAIM_CREATED: 'JOB_WARRANTY_CLAIM_CREATED',
    WARRANTY_REWORK_REQUIRED: 'JOB_WARRANTY_REWORK_REQUIRED',
    WARRANTY_COMPLETION_REQUESTED: 'JOB_WARRANTY_COMPLETION_REQUESTED',
    WARRANTY_REWORK_CONFIRMED: 'JOB_WARRANTY_REWORK_CONFIRMED',
    WARRANTY_REWORK_REJECTED: 'JOB_WARRANTY_REWORK_REJECTED',
    WARRANTY_RELEASED: 'JOB_WARRANTY_RELEASED',
    COMPLETED: 'JOB_COMPLETED',
    CANCELLATION_REQUESTED: 'JOB_CANCELLATION_REQUESTED',
    CANCELLATION_REVIEW_REQUIRED: 'JOB_CANCELLATION_REVIEW_REQUIRED',
    CANCELLATION_REJECTED: 'JOB_CANCELLATION_REJECTED',
    CANCELLED: 'JOB_CANCELLED',
    REVIEW_SUBMITTED: 'JOB_REVIEW_SUBMITTED'
});

const ADMIN_JOB_UPDATED = 'ADMIN_JOB_UPDATED';
const recentAdminSignals = new Map();
const ADMIN_SIGNAL_TTL_MS = 5000;

const normalizeOccurredAt = (value) => {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const emitAdminJobUpdated = ({ jobId, occurredAt, eventId = null, dedupeKey = null }) => {
    if (!jobId) return null;
    const normalizedAt = normalizeOccurredAt(occurredAt);
    const key = dedupeKey || `${jobId}:${normalizedAt}`;
    const existing = recentAdminSignals.get(key);
    if (existing) return existing;
    const signalId = eventId || randomUUID();
    recentAdminSignals.set(key, signalId);
    const timer = setTimeout(() => recentAdminSignals.delete(key), ADMIN_SIGNAL_TTL_MS);
    timer.unref?.();
    emitToRole('ADMIN', ADMIN_JOB_UPDATED, {
        event_id: signalId,
        occurred_at: normalizedAt,
        resource: { job_id: jobId }
    });
    return signalId;
};

const emitJobLifecycleEvent = ({ event, userIds, payload }) => {
    try {
        const eventId = emitAdminJobUpdated({
            jobId: payload?.job_id,
            occurredAt: payload?.occurred_at,
            eventId: payload?.event_id,
            dedupeKey: payload?.admin_dedupe_key
        });
        return emitToUsers(userIds, event, {
            ...payload,
            ...(eventId ? { event_id: eventId } : {})
        });
    } catch (error) {
        console.error('[matchmaking] Failed to emit lifecycle event.', {
            event,
            job_id: payload?.job_id,
            error: error?.message || 'Unknown error'
        });
        return false;
    }
};

export {
    ADMIN_JOB_UPDATED,
    JOB_LIFECYCLE_EVENTS,
    emitAdminJobUpdated,
    emitJobLifecycleEvent
};
