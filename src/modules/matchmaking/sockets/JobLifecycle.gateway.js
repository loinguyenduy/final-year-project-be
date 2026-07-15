import { emitToUsers } from '../../../core/realtime/realtime.gateway.js';

const JOB_LIFECYCLE_EVENTS = Object.freeze({
    EN_ROUTE: 'JOB_EN_ROUTE',
    ARRIVAL_REQUESTED: 'JOB_ARRIVAL_REQUESTED',
    ARRIVAL_REJECTED: 'JOB_ARRIVAL_REJECTED',
    ARRIVED: 'JOB_ARRIVED',
    QUOTE_SUBMITTED: 'JOB_QUOTE_SUBMITTED',
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
