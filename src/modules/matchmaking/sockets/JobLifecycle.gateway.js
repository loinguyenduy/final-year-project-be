import { emitToUsers } from '../../../core/realtime/realtime.gateway.js';

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
    CANCELLATION_REQUESTED: 'JOB_CANCELLATION_REQUESTED',
    CANCELLATION_REVIEW_REQUIRED: 'JOB_CANCELLATION_REVIEW_REQUIRED',
    CANCELLATION_REJECTED: 'JOB_CANCELLATION_REJECTED',
    CANCELLED: 'JOB_CANCELLED'
});

const emitJobLifecycleEvent = ({ event, userIds, payload }) => {
    try {
        return emitToUsers(userIds, event, payload);
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
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
};
