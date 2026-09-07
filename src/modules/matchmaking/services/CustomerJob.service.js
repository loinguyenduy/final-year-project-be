import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import db from '../../../core/database/connection.js';
import { reverseGeocodeService } from './Geocoding.service.js';
import { LOCATION_SOURCES, coordinatesMatch } from '../utils/location.util.js';
import Bid from '../models/Bid.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import { buildCancellationDto } from '../utils/cancellationPolicy.util.js';
import {
    cleanupRemovedJobImages,
    cleanupUploadedJobImages
} from '../utils/jobImage.util.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import { Op } from 'sequelize';
import { getReviewStateMap } from '../../dispute/services/Review.service.js';
import { actionForStatus, ACTIVE_STATUSES } from '../../identity/services/ParticipantRead.service.js';
import AiError from '../../ai/utils/AiError.js';
import {
    createJobAiSnapshot,
    lockApplicableAiSession
} from '../../ai/services/AiJobIntegration.service.js';

const EARLY_CANCELLATION_REASONS = Object.freeze([
    'NO_LONGER_NEEDED',
    'POSTED_BY_MISTAKE',
    'JOB_DETAILS_CHANGED',
    'FOUND_OTHER_HELP',
    'OTHER'
]);

const serviceError = (EM, EC, code, DT = '') => ({ EM, EC, code, DT });

const normalizeBudget = (value) => (
    value === undefined || value === '' || value === null ? null : value
);

const validateBudgetRange = (minimum, maximum) => {
    const normalizedMinimum = normalizeBudget(minimum);
    const normalizedMaximum = normalizeBudget(maximum);
    if (normalizedMinimum !== null
        && (!Number.isFinite(Number(normalizedMinimum)) || Number(normalizedMinimum) < 0)) {
        return serviceError('Minimum budget must be a non-negative number.', 400, 'INVALID_BUDGET');
    }
    if (normalizedMaximum !== null
        && (!Number.isFinite(Number(normalizedMaximum)) || Number(normalizedMaximum) < 0)) {
        return serviceError('Maximum budget must be a non-negative number.', 400, 'INVALID_BUDGET');
    }
    if (normalizedMinimum !== null
        && normalizedMaximum !== null
        && Number(normalizedMinimum) > Number(normalizedMaximum)) {
        return serviceError(
            'Minimum budget cannot be greater than maximum budget.',
            400,
            'INVALID_BUDGET'
        );
    }
    return null;
};

const validateEarlyCancellationPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { error: serviceError('Cancellation body must be an object.', 400, 'VALIDATION_ERROR') };
    }
    const unknownFields = Object.keys(payload).filter(
        (field) => !['reason', 'reason_text'].includes(field)
    );
    if (unknownFields.length > 0) {
        return {
            error: serviceError(
                `Unsupported cancellation fields: ${unknownFields.join(', ')}.`,
                400,
                'VALIDATION_ERROR'
            )
        };
    }
    if (!EARLY_CANCELLATION_REASONS.includes(payload.reason)) {
        return { error: serviceError('Cancellation reason is invalid.', 400, 'INVALID_CANCELLATION_REASON') };
    }
    if (payload.reason_text !== undefined
        && payload.reason_text !== null
        && typeof payload.reason_text !== 'string') {
        return { error: serviceError('reason_text must be a string.', 400, 'VALIDATION_ERROR') };
    }
    const reasonText = typeof payload.reason_text === 'string' ? payload.reason_text.trim() : null;
    if (reasonText && reasonText.length > 500) {
        return { error: serviceError('reason_text must not exceed 500 characters.', 400, 'VALIDATION_ERROR') };
    }
    if (payload.reason === 'OTHER' && !reasonText) {
        return { error: serviceError('reason_text is required for OTHER.', 400, 'CANCELLATION_REASON_TEXT_REQUIRED') };
    }
    return { reason: payload.reason, reasonText: reasonText || null };
};

const createJobService = async (userId, jobData) => {
    const { 
        service_id, issue_description, scheduled_at, images,
        address_option, province_code, ward_code, detail_address, 
        gps_lat, gps_long, location_source, location_confirmed,
        estimated_budget_min, estimated_budget_max,
        ai_assistant_session_id
    } = jobData;

    let trans;
    try {
        // Preflight reads and external geocoding happen before a database transaction is opened.
        const [user, service] = await Promise.all([
            User.findByPk(userId),
            Service.findByPk(service_id)
        ]);

        if (!user) {
            return { EM: "User not found.", EC: 404, DT: "" };
        }
        if (user.kyc_status !== 'VERIFIED') {
            return {
                EM: "Your account is not KYC verified. Please complete KYC verification to post jobs.",
                EC: 403,
                DT: ""
            };
        }
        if (!service) {
            return { EM: "Selected service does not exist.", EC: 404, DT: "" };
        }
        if (!service.is_active) {
            return { EM: "Selected service is no longer available for new Jobs.", EC: 409, code: "SERVICE_INACTIVE", DT: "" };
        }

        // Build the address snapshot without allowing geocoder output to overwrite local address data.
        let final_service_address = "";
        let final_province_code = null;
        let final_ward_code = null;
        let final_detail_address = null;
        const final_gps_lat = gps_lat ?? null;
        const final_gps_long = gps_long ?? null;
        let profileAddress = null;

        if (address_option === 1) {
            const normalizedDetailAddress = String(detail_address || '').trim();
            const [province, ward] = await Promise.all([
                Province.findOne({ where: { province_code } }),
                Ward.findOne({ where: { ward_code, province_code } })
            ]);

            if (!province) {
                return { EM: "Invalid province selected.", EC: 400, DT: "" };
            }
            if (!ward) {
                return { EM: "Invalid ward selected or ward does not belong to the selected province.", EC: 400, DT: "" };
            }

            final_province_code = province_code;
            final_ward_code = ward_code;
            final_detail_address = normalizedDetailAddress;
            final_service_address = `${normalizedDetailAddress}, ${ward.name}, ${province.name}`;
        } else if (address_option === 2) {
            profileAddress = await UserAddress.findOne({
                where: { user_id: userId, is_default: true }
            });

            if (!profileAddress) {
                return { EM: "No default address found in your profile. Please add one or use another option.", EC: 400, DT: "" };
            }
            if (
                location_source === LOCATION_SOURCES.PROFILE_ADDRESS
                && !coordinatesMatch(
                    final_gps_lat,
                    final_gps_long,
                    profileAddress.gps_lat,
                    profileAddress.gps_long
                )
            ) {
                return {
                    EM: "PROFILE_ADDRESS coordinates must match the saved profile coordinates. Use MANUAL_MAP_PIN after changing the pin.",
                    EC: 400,
                    DT: ""
                };
            }

            final_service_address = profileAddress.full_address;
            final_province_code = profileAddress.province_code;
            final_ward_code = profileAddress.ward_code;
            final_detail_address = profileAddress.detail_address;
        } else if (address_option === 3) {
            // Reverse geocoding is deliberately completed before opening the transaction.
            const reverseResult = await reverseGeocodeService({
                gpsLat: final_gps_lat,
                gpsLong: final_gps_long
            });
            final_service_address = reverseResult.EC === 0
                ? reverseResult.DT.service_address
                : 'Selected map location';
            // Option 3 did not use the authoritative local dropdowns, so codes stay null.
            final_province_code = null;
            final_ward_code = null;
            final_detail_address = null;
        }

        trans = await db.transaction();

        // Nếu có phiên AI được liên kết, khóa phiên AI 
        const aiSession = ai_assistant_session_id
            ? await lockApplicableAiSession({
                sessionId: ai_assistant_session_id,
                customerId: userId,
                serviceId: service_id,
                transaction: trans
            })
            : null;

        const newJob = await Job.create({
            customer_id: userId,
            service_id,
            issue_description,
            province_code: final_province_code,
            ward_code: final_ward_code,
            detail_address: final_detail_address,
            service_address: final_service_address,
            gps_lat: final_gps_lat,
            gps_long: final_gps_long,
            location_source,
            location_confirmed,
            location_confirmed_at: location_confirmed ? new Date() : null,
            estimated_budget_min: estimated_budget_min === undefined || estimated_budget_min === ''
                ? null
                : estimated_budget_min,
            estimated_budget_max: estimated_budget_max === undefined || estimated_budget_max === ''
                ? null
                : estimated_budget_max,
            scheduled_at,
            images: images || [],
            current_status: 'POSTED'
        }, { transaction: trans });

        let profileCoordinatesUpdated = false;
        if (address_option === 2 && final_gps_lat !== null && final_gps_long !== null) {
            const [updatedRows] = await UserAddress.update(
                { gps_lat: final_gps_lat, gps_long: final_gps_long },
                {
                    where: {
                        id: profileAddress.id,
                        user_id: userId,
                        is_default: true,
                        province_code: profileAddress.province_code,
                        ward_code: profileAddress.ward_code,
                        detail_address: profileAddress.detail_address
                    },
                    transaction: trans
                }
            );
            if (updatedRows !== 1) {
                throw new Error('Default profile address changed before coordinates could be saved.');
            }
            profileCoordinatesUpdated = true;
        }

        await JobStatusHistory.create({
            job_id: newJob.id,
            old_status: null,
            new_status: 'POSTED',
            changed_by_user_id: userId,
            trigger_gps_lat: final_gps_lat,
            trigger_gps_long: final_gps_long
        }, { transaction: trans });

        if (aiSession) {
            await createJobAiSnapshot({
                session: aiSession,
                job: newJob,
                transaction: trans
            });
        }

        await trans.commit();
        const responseJob = newJob.toJSON();
        responseJob.profile_coordinates_updated = profileCoordinatesUpdated;
        return { 
          EM: "Job posted successfully!", 
          EC: 0, 
          DT: responseJob
        };

    } catch (error) {
        if (trans && !trans.finished) await trans.rollback();
        if (error instanceof AiError) {
            return {
                EM: error.message,
                EC: error.httpStatus,
                code: error.code,
                DT: error.details
            };
        }
        console.log(">>> Error in createJobService: ", error);
        return { 
          EM: "Internal server error while posting job.", 
          EC: 500, 
          DT: "" 
        };
    }
};

const preflightEditableJobService = async (userId, jobId) => {
    try {
        const job = await Job.findByPk(jobId, {
            attributes: ['id', 'customer_id', 'current_status']
        });
        if (!job) return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        if (job.customer_id !== userId) {
            return serviceError('You do not have permission to edit this Job.', 403, 'FORBIDDEN_JOB_ACCESS');
        }
        if (job.current_status !== 'POSTED') {
            return serviceError(
                'Only a POSTED Job can be edited.',
                409,
                'JOB_NOT_EDITABLE',
                { current_status: job.current_status }
            );
        }
        return { EM: 'Job can be edited.', EC: 0, code: 'JOB_EDIT_PREFLIGHT_OK', DT: '' };
    } catch (error) {
        console.error('[matchmaking] Failed to preflight Job edit.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to validate Job edit.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const updatePostedJobService = async (userId, jobId, jobData, uploadedFiles = []) => {
    let transaction;
    const abort = (result) => {
        const error = new Error(result.EM);
        error.serviceResult = result;
        throw error;
    };

    try {
        const {
            service_id,
            issue_description,
            scheduled_at,
            estimated_budget_min,
            estimated_budget_max,
            expected_updated_at,
            retained_images,
            location_changed,
            address_option,
            province_code,
            ward_code,
            detail_address,
            gps_lat,
            gps_long,
            location_source,
            location_confirmed
        } = jobData;

        const expectedTimestamp = new Date(expected_updated_at);
        if (!expected_updated_at || Number.isNaN(expectedTimestamp.getTime())) {
            abort(serviceError('expected_updated_at must be a valid timestamp.', 400, 'VALIDATION_ERROR'));
        }
        if (!service_id || typeof issue_description !== 'string' || !issue_description.trim() || !scheduled_at) {
            abort(serviceError(
                'service_id, issue_description and scheduled_at are required.',
                400,
                'VALIDATION_ERROR'
            ));
        }
        const scheduledAt = new Date(scheduled_at);
        if (Number.isNaN(scheduledAt.getTime())) {
            abort(serviceError('scheduled_at must be a valid timestamp.', 400, 'VALIDATION_ERROR'));
        }
        const budgetError = validateBudgetRange(estimated_budget_min, estimated_budget_max);
        if (budgetError) abort(budgetError);
        if (!Array.isArray(retained_images) || retained_images.some((url) => typeof url !== 'string')) {
            abort(serviceError('retained_images must be an array of image URLs.', 400, 'VALIDATION_ERROR'));
        }

        const [user, service, currentJob] = await Promise.all([
            User.findByPk(userId),
            Service.findByPk(service_id),
            Job.findByPk(jobId)
        ]);
        if (!currentJob) abort(serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (currentJob.customer_id !== userId) {
            abort(serviceError('You do not have permission to edit this Job.', 403, 'FORBIDDEN_JOB_ACCESS'));
        }
        if (currentJob.current_status !== 'POSTED') {
            abort(serviceError(
                'Only a POSTED Job can be edited.',
                409,
                'JOB_NOT_EDITABLE',
                { current_status: currentJob.current_status }
            ));
        }
        if (!user || user.kyc_status !== 'VERIFIED') {
            abort(serviceError('Your account must be KYC verified to edit a Job.', 403, 'KYC_REQUIRED'));
        }
        if (!service) abort(serviceError('Selected service does not exist.', 404, 'SERVICE_NOT_FOUND'));
        if (!service.is_active && currentJob.service_id !== service.id) {
            abort(serviceError('Selected service is no longer available for new selections.', 409, 'SERVICE_INACTIVE'));
        }

        let locationSnapshot = null;
        let profileAddress = null;
        if (location_changed) {
            const finalGpsLat = gps_lat ?? null;
            const finalGpsLong = gps_long ?? null;
            if (address_option === 1) {
                const normalizedDetailAddress = String(detail_address || '').trim();
                if (!normalizedDetailAddress || !province_code || !ward_code) {
                    abort(serviceError(
                        'detail_address, province_code and ward_code are required.',
                        400,
                        'VALIDATION_ERROR'
                    ));
                }
                const [province, ward] = await Promise.all([
                    Province.findOne({ where: { province_code } }),
                    Ward.findOne({ where: { ward_code, province_code } })
                ]);
                if (!province || !ward) {
                    abort(serviceError('The selected province or ward is invalid.', 400, 'INVALID_ADMINISTRATIVE_AREA'));
                }
                locationSnapshot = {
                    service_address: `${normalizedDetailAddress}, ${ward.name}, ${province.name}`,
                    province_code,
                    ward_code,
                    detail_address: normalizedDetailAddress
                };
            } else if (address_option === 2) {
                profileAddress = await UserAddress.findOne({
                    where: { user_id: userId, is_default: true }
                });
                if (!profileAddress) {
                    abort(serviceError('No default profile address was found.', 400, 'DEFAULT_ADDRESS_NOT_FOUND'));
                }
                if (location_source === LOCATION_SOURCES.PROFILE_ADDRESS
                    && !coordinatesMatch(
                        finalGpsLat,
                        finalGpsLong,
                        profileAddress.gps_lat,
                        profileAddress.gps_long
                    )) {
                    abort(serviceError(
                        'PROFILE_ADDRESS coordinates must match the saved profile coordinates.',
                        400,
                        'PROFILE_COORDINATES_MISMATCH'
                    ));
                }
                locationSnapshot = {
                    service_address: profileAddress.full_address,
                    province_code: profileAddress.province_code,
                    ward_code: profileAddress.ward_code,
                    detail_address: profileAddress.detail_address
                };
            } else if (address_option === 3) {
                const reverseResult = await reverseGeocodeService({
                    gpsLat: finalGpsLat,
                    gpsLong: finalGpsLong
                });
                locationSnapshot = {
                    service_address: reverseResult.EC === 0
                        ? reverseResult.DT.service_address
                        : 'Selected map location',
                    province_code: null,
                    ward_code: null,
                    detail_address: null
                };
            } else {
                abort(serviceError('address_option must be 1, 2 or 3.', 400, 'VALIDATION_ERROR'));
            }
            Object.assign(locationSnapshot, {
                gps_lat: finalGpsLat,
                gps_long: finalGpsLong,
                location_source,
                location_confirmed,
                location_confirmed_at: location_confirmed ? new Date() : null
            });
        }

        transaction = await db.transaction();
        const job = await Job.findByPk(jobId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!job) abort(serviceError('Job not found.', 404, 'JOB_NOT_FOUND'));
        if (job.customer_id !== userId) {
            abort(serviceError('You do not have permission to edit this Job.', 403, 'FORBIDDEN_JOB_ACCESS'));
        }
        if (job.current_status !== 'POSTED') {
            abort(serviceError(
                'Only a POSTED Job can be edited.',
                409,
                'JOB_NOT_EDITABLE',
                { current_status: job.current_status }
            ));
        }
        if (new Date(job.updatedAt).getTime() !== expectedTimestamp.getTime()) {
            abort(serviceError(
                'The Job changed after the edit form was opened.',
                409,
                'JOB_EDIT_CONFLICT',
                { current_updated_at: job.updatedAt }
            ));
        }

        const currentImages = Array.isArray(job.images) ? job.images : [];
        const uniqueRetainedImages = [...new Set(retained_images)];
        if (uniqueRetainedImages.some((url) => !currentImages.includes(url))) {
            abort(serviceError(
                'retained_images contains an image that does not belong to this Job.',
                400,
                'INVALID_RETAINED_IMAGE'
            ));
        }
        const uploadedUrls = uploadedFiles.map((file) => file.path).filter(Boolean);
        const finalImages = [...uniqueRetainedImages, ...uploadedUrls];
        if (finalImages.length > 5) {
            abort(serviceError('A Job can contain at most 5 images.', 400, 'JOB_IMAGE_LIMIT_EXCEEDED'));
        }

        const updatePayload = {
            service_id,
            issue_description: issue_description.trim(),
            scheduled_at: scheduledAt,
            estimated_budget_min: normalizeBudget(estimated_budget_min),
            estimated_budget_max: normalizeBudget(estimated_budget_max),
            images: finalImages,
            ...(locationSnapshot || {})
        };
        await job.update(updatePayload, { transaction });

        let profileCoordinatesUpdated = false;
        if (location_changed
            && address_option === 2
            && gps_lat !== null
            && gps_long !== null) {
            const [updatedRows] = await UserAddress.update(
                { gps_lat, gps_long },
                {
                    where: {
                        id: profileAddress.id,
                        user_id: userId,
                        is_default: true,
                        province_code: profileAddress.province_code,
                        ward_code: profileAddress.ward_code,
                        detail_address: profileAddress.detail_address
                    },
                    transaction
                }
            );
            if (updatedRows !== 1) throw new Error('Default profile address changed during Job edit.');
            profileCoordinatesUpdated = true;
        }

        await transaction.commit();
        transaction = null;
        const removedImages = currentImages.filter((url) => !uniqueRetainedImages.includes(url));
        void cleanupRemovedJobImages(removedImages, { job_id: job.id, operation: 'edit' });

        return {
            EM: 'Job updated successfully.',
            EC: 0,
            code: 'JOB_UPDATED',
            DT: {
                job: job.toJSON(),
                profile_coordinates_updated: profileCoordinatesUpdated
            }
        };
    } catch (error) {
        if (transaction && !transaction.finished) await transaction.rollback();
        await cleanupUploadedJobImages(uploadedFiles, { job_id: jobId, operation: 'edit_rollback' });
        if (error?.serviceResult) return error.serviceResult;
        console.error('[matchmaking] Failed to update POSTED Job.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to update Job.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const cancelPreAcceptanceJobService = async (userId, jobId, payload) => {
    const validated = validateEarlyCancellationPayload(payload);
    if (validated.error) return validated.error;

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
        if (job.customer_id !== userId) {
            await transaction.rollback();
            return serviceError('You do not have permission to cancel this Job.', 403, 'FORBIDDEN_JOB_ACCESS');
        }

        if (job.current_status === 'CANCELLED') {
            const existing = await JobCancellation.findOne({
                where: {
                    job_id: job.id,
                    cancelled_by_user_id: userId,
                    acceptance_cycle: null,
                    cancellation_action: 'CANCEL_JOB'
                },
                order: [['createdAt', 'DESC']],
                transaction
            });
            await transaction.rollback();
            if (existing) {
                return {
                    EM: 'Job was already cancelled.',
                    EC: 0,
                    code: 'JOB_ALREADY_CANCELLED',
                    DT: { job_id: job.id, status: 'CANCELLED', cancellation: buildCancellationDto(existing) }
                };
            }
            return serviceError('Job is already cancelled.', 409, 'JOB_NOT_CANCELLABLE');
        }
        if (!['POSTED', 'BIDDING'].includes(job.current_status)) {
            await transaction.rollback();
            return serviceError(
                'Only a POSTED or BIDDING Job can use pre-acceptance cancellation.',
                409,
                'JOB_NOT_CANCELLABLE',
                { current_status: job.current_status }
            );
        }
        if (job.deposit_status === 'HELD' || job.selected_bid_id || job.selected_handyman_id) {
            await transaction.rollback();
            return serviceError(
                'Pre-acceptance financial or selection data is inconsistent.',
                409,
                'PRE_ACCEPTANCE_DATA_INCONSISTENT'
            );
        }

        const originalStatus = job.current_status;
        const bidderRows = await Bid.findAll({
            where: { job_id: job.id },
            attributes: ['handyman_id'],
            transaction
        });
        await Bid.update(
            { status: 'EXPIRED' },
            { where: { job_id: job.id, status: 'PENDING' }, transaction }
        );
        const now = new Date();
        const cancellation = await JobCancellation.create({
            job_id: job.id,
            cancelled_by_user_id: userId,
            cancelled_by_role: 'CUSTOMER',
            status_when_cancelled: originalStatus,
            cancellation_action: 'CANCEL_JOB',
            reason_code: validated.reason,
            reason_text: validated.reasonText,
            acceptance_cycle: null,
            classification: 'NEUTRAL',
            resolution_mode: 'AUTO_RESOLVE',
            status: 'RESOLVED',
            requested_at: now,
            resolved_at: now,
            resolved_by_user_id: userId,
            resolution_note: 'PRE_ACCEPTANCE_CUSTOMER_CANCELLATION',
            penalty_amount: 0
        }, { transaction });
        await job.update({ current_status: 'CANCELLED', cancelled_at: now }, { transaction });
        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: userId,
            old_status: originalStatus,
            new_status: 'CANCELLED',
            reason: `PRE_ACCEPTANCE_CANCEL:${validated.reason}`
        }, { transaction });

        await transaction.commit();
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.CANCELLED,
            userIds: [job.customer_id, ...bidderRows.map((bid) => bid.handyman_id)],
            payload: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle || 0),
                previous_status: originalStatus,
                current_status: 'CANCELLED',
                cancellation_id: cancellation.id,
                occurred_at: now
            }
        });
        return {
            EM: 'Job cancelled successfully.',
            EC: 0,
            code: 'JOB_CANCELLED',
            DT: {
                job_id: job.id,
                status: 'CANCELLED',
                cancellation: buildCancellationDto(cancellation)
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('[matchmaking] Failed to cancel pre-acceptance Job.', {
            job_id: jobId,
            error: error?.message || 'Unknown error'
        });
        return serviceError('Unable to cancel Job.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const getCustomerJobsService = async (userId, query = {}) => {
    try {
        const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
        const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size || '20', 10) || 20));
        const view = String(query.view || 'ALL').toUpperCase();
        const status = String(query.status || 'ALL').toUpperCase();
        const sort = String(query.sort || 'UPDATED_DESC').toUpperCase();
        const validViews = ['ALL', 'NEEDS_ACTION', 'ACTIVE', 'CLOSED', 'CANCELLED'];
        const validSorts = ['UPDATED_DESC', 'CREATED_DESC', 'CREATED_ASC', 'SCHEDULED_ASC', 'SCHEDULED_DESC'];
        const statuses = Job.rawAttributes.current_status.values;
        if (!validViews.includes(view) || !validSorts.includes(sort) || (status !== 'ALL' && !statuses.includes(status))) {
            return serviceError('My Jobs filters are invalid.', 400, 'VALIDATION_ERROR');
        }
        const statusWhere = status !== 'ALL' ? status
            : view === 'ACTIVE' ? { [Op.in]: ACTIVE_STATUSES }
                : view === 'CLOSED' ? 'CLOSED'
                    : view === 'CANCELLED' ? 'CANCELLED'
                        : undefined;
        const order = {
            UPDATED_DESC: [['updatedAt', 'DESC'], ['id', 'DESC']], CREATED_DESC: [['createdAt', 'DESC'], ['id', 'DESC']],
            CREATED_ASC: [['createdAt', 'ASC'], ['id', 'ASC']], SCHEDULED_ASC: [['scheduled_at', 'ASC'], ['id', 'ASC']],
            SCHEDULED_DESC: [['scheduled_at', 'DESC'], ['id', 'DESC']]
        }[sort];
        let needsActionTotal = null;
        let needsActionPageIds = null;
        if (view === 'NEEDS_ACTION') {
            const actionStatuses = statuses.filter((entry) => actionForStatus(entry, 'CUSTOMER'));
            const candidates = await Job.findAll({
                where: {
                    customer_id: userId,
                    current_status: status !== 'ALL' ? status : { [Op.in]: [...new Set([...actionStatuses, 'CLOSED'])] }
                },
                attributes: ['id', 'current_status', 'acceptance_cycle', 'customer_id', 'selected_handyman_id', 'createdAt', 'updatedAt', 'scheduled_at'],
                order
            });
            const candidateStates = await getReviewStateMap({ jobs: candidates, actor: { id: userId, role: 'CUSTOMER' } });
            const actionable = candidates.filter((entry) => candidateStates.get(entry.id)?.status === 'PENDING'
                || Boolean(actionForStatus(entry.current_status, 'CUSTOMER')));
            needsActionTotal = actionable.length;
            needsActionPageIds = actionable
                .slice((page - 1) * pageSize, page * pageSize)
                .map((entry) => entry.id);
            if (!needsActionPageIds.length) {
                return { EM: 'Customer jobs retrieved successfully.', EC: 0, DT: { items: [], pagination: { page, page_size: pageSize, total_items: needsActionTotal, total_pages: Math.ceil(needsActionTotal / pageSize) }, filters: { view, status, sort } } };
            }
        }
        const { rows: jobs, count } = await Job.findAndCountAll({
            where: {
                customer_id: userId,
                ...(statusWhere ? { current_status: statusWhere } : {}),
                ...(needsActionPageIds ? { id: { [Op.in]: needsActionPageIds } } : {})
            },
            attributes: {
                exclude: ['en_route_gps_lat', 'en_route_gps_long']
            },
            include: [
                {
                    model: Service,
                    attributes: ['id', 'name', 'service_code', 'icon_url']
                },
                {
                    model: User,
                    as: 'SelectedHandyman',
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number'],
                    include: [
                        {
                            model: UserAddress,
                            attributes: [
                                'id', 'province_code', 'ward_code',
                                'detail_address', 'full_address', 'is_default'
                            ],
                            required: false
                        }
                    ]
                }
            ],
            order,
            limit: pageSize,
            offset: needsActionPageIds ? 0 : (page - 1) * pageSize,
            distinct: true
        });
        const actor = { id: userId, role: 'CUSTOMER' };
        const reviewStates = await getReviewStateMap({ jobs, actor });
        const items = jobs.map((job) => {
            const data = job.get({ plain: true });
            const review = reviewStates.get(job.id) || { status: 'NOT_AVAILABLE' };
            const actionLabel = review.status === 'PENDING' ? 'Rate your handyman' : actionForStatus(job.current_status, 'CUSTOMER');
            return { ...data, needs_action: Boolean(actionLabel), action_summary: actionLabel ? { label: actionLabel, destination: `/customer/my-jobs/${job.id}` } : null, review_state: review.status };
        });
        const filtered = view === 'NEEDS_ACTION' ? items.filter((item) => item.needs_action) : items;
        return { 
          EM: "Customer jobs retrieved successfully.", 
          EC: 0, 
          DT: { items: filtered, pagination: { page, page_size: pageSize, total_items: needsActionTotal ?? count, total_pages: Math.ceil((needsActionTotal ?? count) / pageSize) }, filters: { view, status, sort } }
        };
    } catch (error) {
        console.log(">>> Error in getCustomerJobsService: ", error);
        return { 
          EM: "Internal server error while retrieving customer jobs.", 
          EC: 500, 
          DT: "" 
        };
    }
};

export {
    EARLY_CANCELLATION_REASONS,
    cancelPreAcceptanceJobService,
    createJobService,
    getCustomerJobsService,
    preflightEditableJobService,
    updatePostedJobService
};
