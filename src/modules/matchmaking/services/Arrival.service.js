import db from '../../../core/database/connection.js';
import Job from '../models/Job.model.js';
import JobArrivalRequest from '../models/JobArrivalRequest.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import { parseCoordinatePair } from '../utils/location.util.js';
import {
    buildArrivalRequestDto,
    buildDistanceSnapshot,
    getArrivalLocationWarning,
    getCooldownRemainingSeconds,
    getJobLifecycleConfig,
    validateGpsEvidence
} from '../utils/jobLifecycle.util.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import {
    isValidUuid,
    serviceError,
    validateAcceptedJobInvariants
} from './AcceptedJob.service.js';

const REJECTION_REASONS = Object.freeze([
    'HANDYMAN_NOT_PRESENT',
    'WRONG_LOCATION',
    'ARRIVAL_REQUEST_SENT_TOO_EARLY',
    'OTHER'
]);

const validateArrivalPayload = (payload = {}) => {
    const validation = validateGpsEvidence(payload);
    if (!validation.valid) {
        return { error: serviceError(validation.error, 400, 'INVALID_COORDINATES') };
    }
    return validation;
};

const validateRejectPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { error: serviceError('Request body must be a JSON object.', 400, 'VALIDATION_ERROR') };
    }
    const unknownFields = Object.keys(payload).filter(
        field => !['reason', 'reason_text'].includes(field)
    );
    if (unknownFields.length > 0) {
        return {
            error: serviceError(
                `Unsupported request fields: ${unknownFields.join(', ')}.`,
                400,
                'VALIDATION_ERROR'
            )
        };
    }
    if (!REJECTION_REASONS.includes(payload.reason)) {
        return {
            error: serviceError(
                `reason must be one of: ${REJECTION_REASONS.join(', ')}.`,
                400,
                'VALIDATION_ERROR'
            )
        };
    }
    if (payload.reason_text !== undefined
        && payload.reason_text !== null
        && typeof payload.reason_text !== 'string') {
        return { error: serviceError('reason_text must be a string.', 400, 'VALIDATION_ERROR') };
    }

    const reasonText = typeof payload.reason_text === 'string'
        ? payload.reason_text.trim()
        : null;
    if (payload.reason === 'OTHER' && !reasonText) {
        return {
            error: serviceError(
                'reason_text is required when reason is OTHER.',
                400,
                'VALIDATION_ERROR'
            )
        };
    }
    if (reasonText && reasonText.length > 500) {
        return {
            error: serviceError(
                'reason_text must not exceed 500 characters.',
                400,
                'VALIDATION_ERROR'
            )
        };
    }
    return { reason: payload.reason, reasonText };
};

const validateRequestContext = (job, request) => {
    if (request.job_id !== job.id
        || Number(request.acceptance_cycle) !== Number(job.acceptance_cycle)) {
        return serviceError(
            'Arrival request does not belong to the current acceptance cycle.',
            409,
            'ACCEPTANCE_CYCLE_INCONSISTENT'
        );
    }
    if (request.customer_id !== job.customer_id
        || request.handyman_id !== job.selected_handyman_id) {
        return serviceError(
            'Arrival request participant data is inconsistent.',
            409,
            'ACCEPTED_DATA_INCONSISTENT'
        );
    }
    return null;
};

const countRejections = (job, transaction) => JobArrivalRequest.count({
    where: {
        job_id: job.id,
        acceptance_cycle: job.acceptance_cycle,
        status: 'REJECTED'
    },
    transaction
});

const buildArrivalPolicy = ({ rejectionCount, config, retryAfterSeconds = 0 }) => ({
    rejection_count: rejectionCount,
    max_rejections: config.maxRejectionsPerCycle,
    review_required: rejectionCount >= config.maxRejectionsPerCycle,
    retry_after_seconds: retryAfterSeconds > 0 ? retryAfterSeconds : null
});

const requestArrivalService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }
    const handymanCoordinates = validateArrivalPayload(payload);
    if (handymanCoordinates.error) return handymanCoordinates.error;

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        if (job.selected_handyman_id !== handymanId) {
            await transaction.rollback();
            return serviceError(
                'Only the selected handyman can request arrival confirmation.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        if (job.current_status === 'ARRIVED') {
            const confirmedRequest = await JobArrivalRequest.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: 'CONFIRMED'
                },
                transaction
            });
            await transaction.rollback();
            if (confirmedRequest) {
                const contextError = validateRequestContext(job, confirmedRequest);
                if (contextError) return contextError;
                return {
                    EM: 'Job arrival has already been confirmed.',
                    EC: 0,
                    code: 'JOB_ALREADY_ARRIVED',
                    DT: {
                        job_id: job.id,
                        status: job.current_status,
                        arrival_request: buildArrivalRequestDto(confirmedRequest, {
                            includeRawGps: true
                        })
                    }
                };
            }
            return serviceError(
                'Job is ARRIVED without a matching confirmed arrival request.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            );
        }
        if (job.current_status !== 'EN_ROUTE') {
            await transaction.rollback();
            return serviceError(
                'Job is not in EN_ROUTE status.',
                409,
                'JOB_NOT_EN_ROUTE',
                { current_status: job.current_status }
            );
        }

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) {
            await transaction.rollback();
            return invariant.error;
        }
        if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
            await transaction.rollback();
            return serviceError(
                'Customer and selected handyman must both be active.',
                409,
                'PARTICIPANT_INACTIVE'
            );
        }

        const jobCoordinates = parseCoordinatePair(job.gps_lat, job.gps_long);
        if (!jobCoordinates.valid) {
            await transaction.rollback();
            return serviceError(
                'Job location data is inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            );
        }
        if (jobCoordinates.hasCoordinates && !handymanCoordinates.hasCoordinates) {
            await transaction.rollback();
            return serviceError(
                'Handyman GPS is required because this job has coordinates.',
                400,
                'HANDYMAN_LOCATION_REQUIRED'
            );
        }

        const config = getJobLifecycleConfig();
        const rejectionCount = await countRejections(job, transaction);
        if (rejectionCount >= config.maxRejectionsPerCycle) {
            await transaction.rollback();
            return serviceError(
                'Arrival review is required before another request can be sent.',
                409,
                'ARRIVAL_REVIEW_REQUIRED',
                buildArrivalPolicy({ rejectionCount, config })
            );
        }

        const pendingRequest = await JobArrivalRequest.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                status: 'PENDING'
            },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (pendingRequest) {
            await transaction.rollback();
            return {
                EM: 'An arrival request is already pending.',
                EC: 0,
                code: 'ARRIVAL_REQUEST_EXISTS',
                DT: {
                    job_id: job.id,
                    status: job.current_status,
                    arrival_request: buildArrivalRequestDto(pendingRequest, {
                        includeRawGps: true
                    }),
                    arrival_policy: buildArrivalPolicy({ rejectionCount, config })
                }
            };
        }

        const latestRejectedRequest = await JobArrivalRequest.findOne({
            where: {
                job_id: job.id,
                acceptance_cycle: job.acceptance_cycle,
                status: 'REJECTED'
            },
            order: [['responded_at', 'DESC'], ['updatedAt', 'DESC']],
            transaction
        });
        const retryAfterSeconds = getCooldownRemainingSeconds(
            latestRejectedRequest?.responded_at,
            new Date(),
            config.arrivalCooldownSeconds
        );
        if (retryAfterSeconds > 0) {
            await transaction.rollback();
            return serviceError(
                'Please wait before sending another arrival request.',
                409,
                'ARRIVAL_REQUEST_COOLDOWN',
                {
                    ...buildArrivalPolicy({ rejectionCount, config, retryAfterSeconds })
                }
            );
        }

        const distance = buildDistanceSnapshot({
            handymanCoordinates,
            jobCoordinates
        });
        const requestedAt = new Date();
        const arrivalRequest = await JobArrivalRequest.create({
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: handymanId,
            status: 'PENDING',
            request_gps_lat: handymanCoordinates.latitude,
            request_gps_long: handymanCoordinates.longitude,
            request_gps_accuracy_meters: handymanCoordinates.accuracyMeters,
            distance_to_job_meters: distance.distanceMeters,
            location_warning: getArrivalLocationWarning(distance.distanceMeters, config),
            requested_at: requestedAt
        }, { transaction });

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.ARRIVAL_REQUESTED,
            userIds: [job.customer_id],
            payload: {
                job_id: job.id,
                arrival_request_id: arrivalRequest.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                requested_at: requestedAt,
                distance_to_job_meters: distance.distanceMeters,
                location_warning: arrivalRequest.location_warning
            }
        });
        return {
            EM: 'Arrival request created successfully.',
            EC: 0,
            code: 'ARRIVAL_REQUEST_CREATED',
            DT: {
                job_id: job.id,
                status: job.current_status,
                arrival_request: buildArrivalRequestDto(arrivalRequest, {
                    includeRawGps: true
                }),
                arrival_policy: buildArrivalPolicy({ rejectionCount, config })
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in requestArrivalService:', error?.message || 'Unknown error');
        return serviceError('Unable to create arrival request.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const confirmArrivalService = async (jobId, requestId, customerId) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid job or arrival request id.', 400, 'VALIDATION_ERROR');
    }

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        if (job.customer_id !== customerId) {
            await transaction.rollback();
            return serviceError(
                'Only the job customer can confirm arrival.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const arrivalRequest = await JobArrivalRequest.findOne({
            where: { id: requestId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!arrivalRequest) {
            await transaction.rollback();
            return serviceError(
                'Arrival request not found.',
                404,
                'ARRIVAL_REQUEST_NOT_FOUND'
            );
        }
        const contextError = validateRequestContext(job, arrivalRequest);
        if (contextError) {
            await transaction.rollback();
            return contextError;
        }

        if (arrivalRequest.status === 'CONFIRMED' && job.current_status === 'ARRIVED') {
            await transaction.rollback();
            return {
                EM: 'Arrival was already confirmed.',
                EC: 0,
                code: 'ARRIVAL_ALREADY_CONFIRMED',
                DT: {
                    job_id: job.id,
                    status: job.current_status,
                    arrived_at: job.arrived_at,
                    arrival_request: buildArrivalRequestDto(arrivalRequest)
                }
            };
        }
        if (job.current_status !== 'EN_ROUTE') {
            await transaction.rollback();
            return serviceError(
                'Job is not in EN_ROUTE status.',
                409,
                'JOB_NOT_EN_ROUTE',
                { current_status: job.current_status }
            );
        }
        if (arrivalRequest.status !== 'PENDING') {
            await transaction.rollback();
            return serviceError(
                'Arrival request is not pending.',
                409,
                'ARRIVAL_REQUEST_NOT_PENDING',
                { request_status: arrivalRequest.status }
            );
        }

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) {
            await transaction.rollback();
            return invariant.error;
        }
        if (!invariant.customer.is_active || !invariant.selectedHandyman.is_active) {
            await transaction.rollback();
            return serviceError(
                'Customer and selected handyman must both be active.',
                409,
                'PARTICIPANT_INACTIVE'
            );
        }

        const respondedAt = new Date();
        await arrivalRequest.update({
            status: 'CONFIRMED',
            responded_at: respondedAt,
            responded_by_user_id: customerId,
            rejection_reason: null,
            rejection_reason_text: null
        }, { transaction });
        await job.update({
            current_status: 'ARRIVED',
            arrived_at: respondedAt,
            arrival_confirmed_by_user_id: customerId
        }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: customerId,
            old_status: 'EN_ROUTE',
            new_status: 'ARRIVED',
            reason: `CUSTOMER_CONFIRMED_ARRIVAL:${arrivalRequest.id}`
        }, { transaction });

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.ARRIVED,
            userIds: [job.customer_id, job.selected_handyman_id],
            payload: {
                job_id: job.id,
                arrival_request_id: arrivalRequest.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                status: 'ARRIVED',
                arrived_at: respondedAt,
                confirmed_by_user_id: customerId
            }
        });
        return {
            EM: 'Arrival confirmed successfully.',
            EC: 0,
            code: 'ARRIVAL_CONFIRMED',
            DT: {
                job_id: job.id,
                status: 'ARRIVED',
                arrived_at: respondedAt,
                arrival_request: buildArrivalRequestDto(arrivalRequest)
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in confirmArrivalService:', error?.message || 'Unknown error');
        return serviceError('Unable to confirm arrival.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const rejectArrivalService = async (jobId, requestId, customerId, payload = {}) => {
    if (!isValidUuid(jobId) || !isValidUuid(requestId)) {
        return serviceError('Invalid job or arrival request id.', 400, 'VALIDATION_ERROR');
    }
    const rejection = validateRejectPayload(payload);
    if (rejection.error) return rejection.error;

    const transaction = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) {
            await transaction.rollback();
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }
        if (job.customer_id !== customerId) {
            await transaction.rollback();
            return serviceError(
                'Only the job customer can reject arrival.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const arrivalRequest = await JobArrivalRequest.findOne({
            where: { id: requestId, job_id: job.id },
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!arrivalRequest) {
            await transaction.rollback();
            return serviceError(
                'Arrival request not found.',
                404,
                'ARRIVAL_REQUEST_NOT_FOUND'
            );
        }
        const contextError = validateRequestContext(job, arrivalRequest);
        if (contextError) {
            await transaction.rollback();
            return contextError;
        }
        if (job.current_status !== 'EN_ROUTE') {
            await transaction.rollback();
            return serviceError(
                'Job is not in EN_ROUTE status.',
                409,
                'JOB_NOT_EN_ROUTE',
                { current_status: job.current_status }
            );
        }

        const config = getJobLifecycleConfig();
        if (arrivalRequest.status === 'REJECTED') {
            const rejectionCount = await countRejections(job, transaction);
            const retryAfterSeconds = rejectionCount >= config.maxRejectionsPerCycle
                ? 0
                : getCooldownRemainingSeconds(
                    arrivalRequest.responded_at,
                    new Date(),
                    config.arrivalCooldownSeconds
                );
            await transaction.rollback();
            return {
                EM: 'Arrival request was already rejected.',
                EC: 0,
                code: 'ARRIVAL_ALREADY_REJECTED',
                DT: {
                    job_id: job.id,
                    status: job.current_status,
                    arrival_request: buildArrivalRequestDto(arrivalRequest),
                    arrival_policy: buildArrivalPolicy({
                        rejectionCount,
                        config,
                        retryAfterSeconds
                    })
                }
            };
        }
        if (arrivalRequest.status !== 'PENDING') {
            await transaction.rollback();
            return serviceError(
                'Arrival request is not pending.',
                409,
                'ARRIVAL_REQUEST_NOT_PENDING',
                { request_status: arrivalRequest.status }
            );
        }

        const invariant = await validateAcceptedJobInvariants(job, { transaction });
        if (invariant.error) {
            await transaction.rollback();
            return invariant.error;
        }
        if (!invariant.customer.is_active) {
            await transaction.rollback();
            return serviceError(
                'The job customer must be active to reject arrival.',
                409,
                'PARTICIPANT_INACTIVE'
            );
        }

        const respondedAt = new Date();
        await arrivalRequest.update({
            status: 'REJECTED',
            responded_at: respondedAt,
            responded_by_user_id: customerId,
            rejection_reason: rejection.reason,
            rejection_reason_text: rejection.reasonText
        }, { transaction });
        const rejectionCount = await countRejections(job, transaction);
        const arrivalPolicy = buildArrivalPolicy({
            rejectionCount,
            config,
            retryAfterSeconds: rejectionCount >= config.maxRejectionsPerCycle
                ? 0
                : config.arrivalCooldownSeconds
        });

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.ARRIVAL_REJECTED,
            userIds: [job.selected_handyman_id],
            payload: {
                job_id: job.id,
                arrival_request_id: arrivalRequest.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                rejection_count: rejectionCount,
                max_rejections: config.maxRejectionsPerCycle,
                review_required: arrivalPolicy.review_required,
                rejection_reason: arrivalRequest.rejection_reason,
                responded_at: respondedAt
            }
        });
        return {
            EM: 'Arrival request rejected. The job remains EN_ROUTE.',
            EC: 0,
            code: 'ARRIVAL_REJECTED',
            DT: {
                job_id: job.id,
                status: job.current_status,
                arrival_request: buildArrivalRequestDto(arrivalRequest),
                arrival_policy: arrivalPolicy
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in rejectArrivalService:', error?.message || 'Unknown error');
        return serviceError('Unable to reject arrival.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    confirmArrivalService,
    rejectArrivalService,
    requestArrivalService
};
