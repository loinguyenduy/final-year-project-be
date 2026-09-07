import Job from '../models/Job.model.js';
import JobWarranty from '../models/JobWarranty.model.js';
import WarrantyClaim from '../models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../models/WarrantyCompletionRequest.model.js';
import { buildWarrantyDto } from '../../fintech/services/WarrantySettlement.service.js';
import { buildWarrantyClaimDto } from './WarrantyClaim.service.js';
import { buildWarrantyCompletionRequestDto } from './WarrantyRework.service.js';
import { countUnlockedStageEvidence } from './WorkEvidence.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUuid = (value) => UUID_PATTERN.test(String(value || ''));
const serviceError = (EM, EC, code, DT = '') => ({ EM, EC, code, DT });

const canReadWarranty = (job, user) => user?.role === 'ADMIN'
    || (user?.role === 'CUSTOMER' && job.customer_id === user.id)
    || (user?.role === 'HANDYMAN' && job.selected_handyman_id === user.id);

const loadWarrantyLifecycleState = async (job, options = {}) => {
    const queryOptions = options.transaction ? { transaction: options.transaction } : {};
    const warranty = await JobWarranty.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        ...queryOptions
    });
    if (!warranty) {
        return {
            warranty: null,
            latestClaim: null,
            latestReworkRequest: null,
            claimEvidenceCount: 0,
            reworkEvidenceCount: 0
        };
    }
    const [latestClaim, latestReworkRequest, claimEvidenceCount, reworkEvidenceCount] = await Promise.all([
        WarrantyClaim.findOne({
            where: { warranty_id: warranty.id },
            order: [['submitted_at', 'DESC'], ['createdAt', 'DESC']],
            ...queryOptions
        }),
        WarrantyCompletionRequest.findOne({
            where: { warranty_id: warranty.id },
            order: [['request_sequence', 'DESC']],
            ...queryOptions
        }),
        countUnlockedStageEvidence(job, 'WARRANTY_CLAIM', options),
        countUnlockedStageEvidence(job, 'WARRANTY', options)
    ]);
    return {
        warranty,
        latestClaim,
        latestReworkRequest,
        claimEvidenceCount,
        reworkEvidenceCount
    };
};

const buildWarrantyLifecycleDto = (state, {
    includeAdmin = false,
    isCustomer = false,
    isSelectedHandyman = false,
    now = new Date()
} = {}) => {
    if (!state?.warranty) return null;
    const claimWindowOpen = state.warranty.status === 'ACTIVE'
        && !state.warranty.released_at
        && now < new Date(state.warranty.ends_at);
    return {
        ...buildWarrantyDto(state.warranty),
        claim_window_open: claimWindowOpen,
        latest_claim: buildWarrantyClaimDto(state.latestClaim, { includeAdmin }),
        latest_rework_request: buildWarrantyCompletionRequestDto(state.latestReworkRequest),
        readiness: {
            ...(isCustomer || includeAdmin ? {
                claim_evidence_count: state.claimEvidenceCount,
                ready_to_submit_claim: claimWindowOpen && state.claimEvidenceCount > 0
            } : {}),
            ...(isSelectedHandyman || includeAdmin ? {
                warranty_evidence_count: state.reworkEvidenceCount,
                ready_to_request_rework_completion: state.warranty.status === 'REWORK_REQUIRED'
                    && state.reworkEvidenceCount > 0
            } : {})
        }
    };
};

const getWarrantyDetailsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) return serviceError('Invalid Job id.', 400, 'VALIDATION_ERROR');
    try {
        const job = await Job.findByPk(jobId);
        if (!job || !canReadWarranty(job, currentUser)) {
            return serviceError('Warranty not found.', 404, 'WARRANTY_NOT_FOUND');
        }
        const state = await loadWarrantyLifecycleState(job);
        if (!state.warranty) return serviceError('Warranty not found.', 404, 'WARRANTY_NOT_FOUND');
        return {
            EM: 'Warranty retrieved successfully.',
            EC: 0,
            code: 'WARRANTY_RETRIEVED',
            DT: {
                warranty: buildWarrantyLifecycleDto(state, {
                    includeAdmin: currentUser.role === 'ADMIN',
                    isCustomer: currentUser.role === 'CUSTOMER',
                    isSelectedHandyman: currentUser.role === 'HANDYMAN'
                        && job.selected_handyman_id === currentUser.id
                })
            }
        };
    } catch (error) {
        console.error('[warranty] Get Warranty failed.', { job_id: jobId, error: error?.message });
        return serviceError('Unable to retrieve Warranty.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    buildWarrantyLifecycleDto,
    canReadWarranty,
    getWarrantyDetailsService,
    loadWarrantyLifecycleState
};
