import { emitToUsers } from '../../../core/realtime/realtime.gateway.js';

const JOB_LIFECYCLE_EVENTS = Object.freeze({
    EN_ROUTE: 'JOB_EN_ROUTE',
    ARRIVAL_REQUESTED: 'JOB_ARRIVAL_REQUESTED',
    ARRIVAL_REJECTED: 'JOB_ARRIVAL_REJECTED',
    ARRIVED: 'JOB_ARRIVED'
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
