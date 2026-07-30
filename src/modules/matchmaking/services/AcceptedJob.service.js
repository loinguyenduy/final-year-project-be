import { Op } from 'sequelize';
import db from '../../../core/database/connection.js';
import { getRatingSummary } from '../../dispute/services/Rating.service.js';
import { getReviewState } from '../../dispute/services/Review.service.js';
import EvidenceVault from '../../fintech/models/EvidenceVault.model.js';
import EContract from '../../fintech/models/EContract.model.js';
import Transaction from '../../fintech/models/Transaction.model.js';
import Wallet from '../../fintech/models/Wallet.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import User from '../../identity/models/User.model.js';
import Bid from '../models/Bid.model.js';
import Job from '../models/Job.model.js';
import JobCancellation from '../models/JobCancellation.model.js';
import JobArrivalRequest from '../models/JobArrivalRequest.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import JobQuote from '../models/JobQuote.model.js';
import JobQuoteItem from '../models/JobQuoteItem.model.js';
import JobCompletionRequest from '../models/JobCompletionRequest.model.js';
import JobCompletionRequestEvidence from '../models/JobCompletionRequestEvidence.model.js';
import JobWarranty from '../models/JobWarranty.model.js';
import WarrantyClaim from '../models/WarrantyClaim.model.js';
import WarrantyClaimEvidence from '../models/WarrantyClaimEvidence.model.js';
import WarrantyCompletionRequest from '../models/WarrantyCompletionRequest.model.js';
import WarrantyCompletionRequestEvidence from '../models/WarrantyCompletionRequestEvidence.model.js';
import Service from '../models/Service.model.js';
import { getEvidenceConfig } from '../utils/evidence.util.js';
import { parseCoordinatePair } from '../utils/location.util.js';
import {
    buildArrivalRequestDto,
    buildDistanceSnapshot,
    buildEnRouteDto,
    calculateEstimatedArrivalMinutes,
    getCooldownRemainingSeconds,
    getJobLifecycleConfig,
    validateGpsEvidence
} from '../utils/jobLifecycle.util.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import {
    buildSubmitReadiness,
    getQuoteConfig,
    normalizeStoredQuote,
    toCanonicalMoneyString
} from '../utils/quote.util.js';
import {
    ACTIVE_CANCELLATION_STATUSES,
    buildCancellationDto
} from '../utils/cancellationPolicy.util.js';
import {
    buildContractSummaryDto,
    buildPaymentSummaryDto,
    calculateQuotePaymentAmounts
} from '../utils/quotePayment.util.js';

const serviceError = (EM, EC, code, DT = '') => ({ EM, EC, code, DT });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUuid = (value) => UUID_PATTERN.test(String(value || ''));

const toNumber = (value) => Number(value || 0);

const getPartnerMetrics = async (userId, role, options = {}) => {
    const ratingSummary = await getRatingSummary(userId, role);

    let completedCount = 0;
    let cancelledCount = 0;

    if (role === 'HANDYMAN') {
        [completedCount, cancelledCount] = await Promise.all([
            Job.count({
                where: { selected_handyman_id: userId, current_status: 'CLOSED' },
                ...options
            }),
            JobCancellation.count({
                where: {
                    cancelled_by_user_id: userId,
                    cancelled_by_role: 'HANDYMAN',
                    cancellation_action: 'HANDYMAN_WITHDRAW'
                },
                ...options
            })
        ]);
    } else {
        [completedCount, cancelledCount] = await Promise.all([
            Job.count({
                where: { customer_id: userId, current_status: 'CLOSED' },
                ...options
            }),
            JobCancellation.count({
                where: {
                    cancelled_by_user_id: userId,
                    cancelled_by_role: 'CUSTOMER',
                    cancellation_action: 'CANCEL_JOB'
                },
                ...options
            })
        ]);
    }

    const outcomeCount = completedCount + cancelledCount;
    const completionRate = outcomeCount > 0
        ? Number(((completedCount / outcomeCount) * 100).toFixed(2))
        : null;

    return {
        rating: ratingSummary.average_rating,
        review_count: ratingSummary.review_count,
        rating_summary: ratingSummary,
        completion_rate: completionRate
    };
};

const validateAcceptedParticipantInvariants = async (job, options = {}) => {
    const acceptanceCycle = Number(job?.acceptance_cycle);
    if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
        return {
            error: serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            )
        };
    }

    if (typeof job?.service_address !== 'string' || !job.service_address.trim()) {
        return {
            error: serviceError(
                'Accepted job service address is missing.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    if (!job.selected_bid_id || !job.selected_handyman_id || !job.customer_id) {
        return {
            error: serviceError(
                'Accepted job data is incomplete.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    const queryOptions = options.transaction
        ? { transaction: options.transaction }
        : {};

    const [selectedBid, customer, selectedHandyman] = await Promise.all([
        Bid.findByPk(job.selected_bid_id, queryOptions),
        User.findByPk(job.customer_id, queryOptions),
        User.findByPk(job.selected_handyman_id, queryOptions)
    ]);
    const bidMatches = selectedBid
        && selectedBid.job_id === job.id
        && selectedBid.handyman_id === job.selected_handyman_id
        && selectedBid.status === 'WON';

    if (!customer
        || customer.role !== 'CUSTOMER'
        || !selectedHandyman
        || selectedHandyman.role !== 'HANDYMAN'
        || !bidMatches) {
        return {
            error: serviceError(
                'Accepted job relationships are inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }

    return {
        selectedBid,
        customer,
        selectedHandyman
    };
};

const validateAcceptedJobInvariants = async (job, options = {}) => {
    const participantValidation = await validateAcceptedParticipantInvariants(job, options);
    if (participantValidation.error) return participantValidation;
    if (!job.deposit_transaction_id
        || !job.deposit_amount
        || !job.deposit_paid_at
        || !job.deposit_status) {
        return {
            error: serviceError(
                'Accepted job data is incomplete.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }
    if (job.deposit_status !== 'HELD') {
        return {
            error: serviceError(
                'The job deposit is not being held.',
                409,
                'DEPOSIT_NOT_HELD',
                { deposit_status: job.deposit_status }
            )
        };
    }
    const queryOptions = options.transaction ? { transaction: options.transaction } : {};
    const [depositTransaction, systemEscrowWallet] = await Promise.all([
        Transaction.findByPk(job.deposit_transaction_id, queryOptions),
        Wallet.findOne({
            where: { wallet_type: 'SYSTEM_ESCROW', user_id: null },
            ...queryOptions
        })
    ]);
    const depositAmount = toNumber(job.deposit_amount);
    const depositMatches = depositTransaction
        && depositTransaction.job_id === job.id
        && depositTransaction.transaction_type === 'DEPOSIT_10'
        && depositTransaction.status === 'SUCCESS'
        && systemEscrowWallet
        && depositTransaction.to_wallet_id === systemEscrowWallet.id
        && toNumber(depositTransaction.amount) === depositAmount;
    if (!depositMatches || depositAmount <= 0) {
        return {
            error: serviceError(
                'Accepted job relationships are inconsistent.',
                409,
                'ACCEPTED_DATA_INCONSISTENT'
            )
        };
    }
    return {
        ...participantValidation,
        depositTransaction,
        systemEscrowWallet
    };
};

const buildCompletionRequestDto = (request) => request ? ({
    id: request.id,
    status: request.status,
    request_sequence: Number(request.request_sequence),
    completion_note: request.completion_note,
    requested_at: request.requested_at,
    responded_at: request.responded_at,
    rejection_reason: request.rejection_reason,
    rejection_note: request.rejection_note
}) : null;

const buildWarrantyClaimDto = (claim, includeAdmin = false) => claim ? ({
    id: claim.id,
    status: claim.status,
    reason: claim.reason,
    description: claim.description,
    submitted_at: claim.submitted_at,
    reviewed_at: claim.reviewed_at,
    resolved_at: claim.resolved_at,
    ...(includeAdmin ? {
        reviewed_by_admin_id: claim.reviewed_by_admin_id,
        admin_note: claim.admin_note
    } : {})
}) : null;

const buildWarrantyCompletionRequestDto = (request) => request ? ({
    id: request.id,
    status: request.status,
    request_sequence: Number(request.request_sequence),
    completion_note: request.completion_note,
    requested_at: request.requested_at,
    responded_at: request.responded_at,
    rejection_reason: request.rejection_reason,
    rejection_note: request.rejection_note
}) : null;

const buildWarrantyDto = (warranty, lifecycle = {}, visibility = {}) => warranty ? ({
    id: warranty.id,
    status: warranty.status,
    warranty_days: Number(warranty.warranty_days),
    started_at: warranty.started_at,
    ends_at: warranty.ends_at,
    expiry_override_minutes: warranty.expiry_override_minutes,
    total_amount: String(warranty.total_amount),
    handyman_immediate_amount: String(warranty.handyman_immediate_amount),
    platform_fee_amount: String(warranty.platform_fee_amount),
    held_amount: String(warranty.warranty_held_amount),
    released_amount: String(warranty.warranty_released_amount),
    released_at: warranty.released_at,
    refunded_amount: String(warranty.warranty_refunded_amount || 0),
    refunded_at: warranty.refunded_at,
    participant_resolution: lifecycle.latestClaim?.status === 'REJECTED'
        && warranty.status === 'COMPLETED'
        && warranty.released_at
        ? {
            claim_decision: 'REJECTED',
            warranty_resolution: 'EXPIRED_RELEASE_TO_HANDYMAN',
            message: 'The warranty claim was not approved. The warranty period has ended, so the remaining warranty reserve has been released according to policy.'
        }
        : null,
    claim_window_open: warranty.status === 'ACTIVE'
        && !warranty.released_at
        && !warranty.refunded_at
        && new Date() < new Date(warranty.ends_at),
    latest_claim: buildWarrantyClaimDto(lifecycle.latestClaim, visibility.includeAdmin),
    latest_rework_request: buildWarrantyCompletionRequestDto(lifecycle.latestReworkRequest),
    readiness: {
        ...(visibility.isCustomer || visibility.includeAdmin ? {
            claim_evidence_count: lifecycle.claimEvidenceCount || 0,
            ready_to_submit_claim: warranty.status === 'ACTIVE'
                && !warranty.released_at
                && new Date() < new Date(warranty.ends_at)
                && (lifecycle.claimEvidenceCount || 0) > 0
        } : {}),
        ...(visibility.isSelectedHandyman || visibility.includeAdmin ? {
            warranty_evidence_count: lifecycle.reworkEvidenceCount || 0,
            ready_to_request_rework_completion: warranty.status === 'REWORK_REQUIRED'
                && lifecycle.latestClaim?.status === 'APPROVED_REWORK_REQUIRED'
                && (lifecycle.reworkEvidenceCount || 0) > 0
        } : {})
    }
}) : null;

const countUnlockedEvidence = async (job, stage) => {
    const evidence = await EvidenceVault.findAll({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            selected_bid_id: job.selected_bid_id,
            stage,
            media_type: 'IMAGE'
        },
        attributes: ['id']
    });
    if (evidence.length === 0) return 0;
    const ids = evidence.map((item) => item.id);
    const [completion, claims, rework] = await Promise.all([
        JobCompletionRequestEvidence.findAll({ where: { evidence_id: { [Op.in]: ids } }, attributes: ['evidence_id'] }),
        WarrantyClaimEvidence.findAll({ where: { evidence_id: { [Op.in]: ids } }, attributes: ['evidence_id'] }),
        WarrantyCompletionRequestEvidence.findAll({ where: { evidence_id: { [Op.in]: ids } }, attributes: ['evidence_id'] })
    ]);
    const linked = new Set([...completion, ...claims, ...rework].map((item) => item.evidence_id));
    return evidence.filter((item) => !linked.has(item.id)).length;
};

const loadCompletionLifecycle = async (job) => {
    const evidence = await EvidenceVault.findAll({
        where: {
            job_id: job.id,
            acceptance_cycle: job.acceptance_cycle,
            customer_id: job.customer_id,
            handyman_id: job.selected_handyman_id,
            selected_bid_id: job.selected_bid_id,
            uploader_id: job.selected_handyman_id,
            stage: { [Op.in]: ['DURING', 'AFTER'] },
            media_type: 'IMAGE'
        },
        attributes: ['id', 'stage']
    });
    const requests = await JobCompletionRequest.findAll({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
        order: [['request_sequence', 'DESC']]
    });
    const linked = evidence.length === 0 ? [] : await JobCompletionRequestEvidence.findAll({
        where: { evidence_id: { [Op.in]: evidence.map((item) => item.id) } },
        attributes: ['evidence_id']
    });
    const linkedIds = new Set(linked.map((item) => item.evidence_id));
    const pendingRequest = requests.find((item) => item.status === 'PENDING') || null;
    const duringCount = evidence.filter((item) => item.stage === 'DURING').length;
    const afterCount = evidence.filter((item) => item.stage === 'AFTER').length;
    const newEvidenceCount = evidence.filter((item) => !linkedIds.has(item.id)).length;
    const unlockedDuringCount = evidence.filter((item) => item.stage === 'DURING' && !linkedIds.has(item.id)).length;
    const unlockedAfterCount = evidence.filter((item) => item.stage === 'AFTER' && !linkedIds.has(item.id)).length;
    const blockingReasons = [];
    if (duringCount < 1) blockingReasons.push('DURING_EVIDENCE_REQUIRED');
    if (afterCount < 1) blockingReasons.push('AFTER_EVIDENCE_REQUIRED');
    if (pendingRequest) blockingReasons.push('COMPLETION_REQUEST_ALREADY_PENDING');
    if (requests.length > 0 && !pendingRequest && newEvidenceCount < 1) {
        blockingReasons.push('NEW_COMPLETION_EVIDENCE_REQUIRED');
    }
    return {
        latestRequest: requests[0] || null,
        pendingRequest,
        readiness: {
            during_evidence_count: duringCount,
            after_evidence_count: afterCount,
            unlocked_during_evidence_count: unlockedDuringCount,
            unlocked_after_evidence_count: unlockedAfterCount,
            new_evidence_count: newEvidenceCount,
            ready_to_request_completion: job.current_status === 'IN_PROGRESS'
                && blockingReasons.length === 0,
            blocking_reasons: blockingReasons
        }
    };
};

const loadWarrantyLifecycle = async (job) => {
    const warranty = await JobWarranty.findOne({
        where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle }
    });
    if (!warranty) return { warranty: null };
    const [latestClaim, latestReworkRequest, claimEvidenceCount, reworkEvidenceCount] = await Promise.all([
        WarrantyClaim.findOne({ where: { warranty_id: warranty.id }, order: [['submitted_at', 'DESC']] }),
        WarrantyCompletionRequest.findOne({ where: { warranty_id: warranty.id }, order: [['request_sequence', 'DESC']] }),
        countUnlockedEvidence(job, 'WARRANTY_CLAIM'),
        countUnlockedEvidence(job, 'WARRANTY')
    ]);
    return { warranty, latestClaim, latestReworkRequest, claimEvidenceCount, reworkEvidenceCount };
};

const buildAllowedActions = ({
    job,
    isCustomer,
    isSelectedHandyman,
    isAdmin,
    pendingRequest,
    reviewRequired,
    retryAfterSeconds,
    currentQuote,
    beforeEvidenceCount,
    quoteReadiness,
    quoteConfig,
    currentCancellation,
    currentUserId,
    completionLifecycle,
    warrantyLifecycle
}) => {
    if (isAdmin) return [];
    if (job.current_status === 'CANCELLATION_REVIEW') {
        if (!currentCancellation) return [];
        if (currentCancellation.status === 'AWAITING_COUNTERPARTY') {
            return currentCancellation.cancelled_by_user_id === currentUserId
                ? ['WAIT_CANCELLATION_RESPONSE']
                : ['CONFIRM_CANCELLATION', 'REJECT_CANCELLATION'];
        }
        if (currentCancellation.status === 'REVIEW_REQUIRED') {
            return ['WAIT_CANCELLATION_REVIEW'];
        }
        return [];
    }
    if (job.current_status === 'ACCEPTED') {
        if (isCustomer) return ['REOPEN_BIDDING', 'CANCEL_JOB'];
        if (isSelectedHandyman) return ['START_MOVING', 'CANCEL_ACCEPTED_JOB'];
        return [];
    }
    if (job.current_status === 'ARRIVED') {
        if (isCustomer) return ['WAIT_FOR_QUOTE', 'REQUEST_CANCELLATION'];
        if (!isSelectedHandyman) return [];

        const actions = ['REQUEST_CANCELLATION'];
        const evidenceLocked = currentQuote && currentQuote.status !== 'DRAFT';
        if (!evidenceLocked) {
            if (beforeEvidenceCount < quoteConfig.beforeEvidenceMaxFiles) {
                actions.push('UPLOAD_BEFORE_EVIDENCE');
            }
            if (beforeEvidenceCount > 0) actions.push('DELETE_BEFORE_EVIDENCE');
        }
        if (!currentQuote) {
            actions.push('CREATE_QUOTE_DRAFT');
        } else if (currentQuote.status === 'DRAFT') {
            actions.push('UPDATE_QUOTE_DRAFT');
            if (quoteReadiness?.ready) actions.push('SUBMIT_QUOTE');
        }
        return actions;
    }
    if (job.current_status === 'QUOTE_PENDING') {
        if (isCustomer) {
            return ['VIEW_QUOTE', 'ACCEPT_QUOTE', 'REJECT_QUOTE', 'REQUEST_CANCELLATION'];
        }
        if (isSelectedHandyman) {
            return ['WAIT_FOR_CUSTOMER_QUOTE_RESPONSE', 'REQUEST_CANCELLATION'];
        }
        return [];
    }
    if (job.current_status === 'PAYMENT_PENDING') {
        if (isCustomer) {
            return ['VIEW_PAYMENT_SUMMARY', 'PAY_REMAINING_AMOUNT', 'REQUEST_CANCELLATION'];
        }
        if (isSelectedHandyman) {
            return ['WAIT_FOR_CUSTOMER_PAYMENT', 'REQUEST_CANCELLATION'];
        }
        return [];
    }
    if (job.current_status === 'IN_PROGRESS') {
        if (isCustomer) {
            return completionLifecycle?.pendingRequest
                ? ['VIEW_ACTIVE_CONTRACT', 'CONFIRM_COMPLETION', 'REJECT_COMPLETION']
                : ['VIEW_ACTIVE_CONTRACT', 'WAIT_COMPLETION_REQUEST'];
        }
        if (!isSelectedHandyman) return [];
        if (completionLifecycle?.pendingRequest) {
            return ['VIEW_ACTIVE_CONTRACT', 'WAIT_COMPLETION_CONFIRMATION'];
        }
        const actions = ['VIEW_ACTIVE_CONTRACT'];
        const evidenceLimit = getEvidenceConfig().maxFilesPerStage;
        if ((completionLifecycle?.readiness?.unlocked_during_evidence_count || 0) < evidenceLimit) {
            actions.push('UPLOAD_DURING_EVIDENCE');
        }
        if ((completionLifecycle?.readiness?.unlocked_after_evidence_count || 0) < evidenceLimit) {
            actions.push('UPLOAD_AFTER_EVIDENCE');
        }
        if ((completionLifecycle?.readiness?.unlocked_during_evidence_count || 0) > 0) {
            actions.push('DELETE_DURING_EVIDENCE');
        }
        if ((completionLifecycle?.readiness?.unlocked_after_evidence_count || 0) > 0) {
            actions.push('DELETE_AFTER_EVIDENCE');
        }
        if (completionLifecycle?.readiness?.ready_to_request_completion) {
            actions.push('REQUEST_COMPLETION');
        }
        return actions;
    }
    if (job.current_status === 'WARRANTY') {
        const warranty = warrantyLifecycle?.warranty;
        if (!warranty) return [];
        if (warranty.status === 'ACTIVE') {
            if (isCustomer && new Date() < new Date(warranty.ends_at)) {
                const actions = [];
                if ((warrantyLifecycle.claimEvidenceCount || 0) < getEvidenceConfig().maxFilesPerStage) {
                    actions.push('UPLOAD_WARRANTY_CLAIM_EVIDENCE');
                }
                if ((warrantyLifecycle.claimEvidenceCount || 0) > 0) {
                    actions.push('DELETE_WARRANTY_CLAIM_EVIDENCE', 'CREATE_WARRANTY_CLAIM');
                }
                return actions;
            }
            return isSelectedHandyman ? ['WAIT_WARRANTY_EXPIRY'] : [];
        }
        if (warranty.status === 'CLAIM_PENDING') return ['WAIT_CLAIM_REVIEW'];
        if (warranty.status === 'REWORK_REQUIRED') {
            if (isCustomer) return ['WAIT_WARRANTY_REWORK_COMPLETION'];
            if (!isSelectedHandyman) return [];
            if (warrantyLifecycle.latestClaim?.status !== 'APPROVED_REWORK_REQUIRED') {
                return ['WAIT_WARRANTY_REVIEW'];
            }
            const actions = [];
            if ((warrantyLifecycle.reworkEvidenceCount || 0) < getEvidenceConfig().maxFilesPerStage) {
                actions.push('UPLOAD_WARRANTY_EVIDENCE');
            }
            if ((warrantyLifecycle.reworkEvidenceCount || 0) > 0) {
                actions.push('DELETE_WARRANTY_EVIDENCE', 'REQUEST_WARRANTY_COMPLETION');
            }
            return actions;
        }
        if (warranty.status === 'REWORK_CONFIRMATION_PENDING') {
            return isCustomer
                ? ['CONFIRM_WARRANTY_COMPLETION', 'REJECT_WARRANTY_COMPLETION']
                : ['WAIT_WARRANTY_COMPLETION_CONFIRMATION'];
        }
        if (warranty.status === 'REVIEW_REQUIRED') return ['WAIT_WARRANTY_REVIEW'];
        return [];
    }
    if (job.current_status === 'CLOSED') return [];
    if (job.current_status !== 'EN_ROUTE') return [];

    if (pendingRequest) {
        return isCustomer
            ? ['CONFIRM_ARRIVAL', 'REJECT_ARRIVAL', 'REQUEST_CANCELLATION']
            : ['WAIT_ARRIVAL_CONFIRMATION', 'REQUEST_CANCELLATION'];
    }
    if (isCustomer) return ['REQUEST_CANCELLATION'];
    if (!isSelectedHandyman) return [];
    if (reviewRequired) return ['WAIT_ARRIVAL_REVIEW', 'REQUEST_CANCELLATION'];
    if (retryAfterSeconds > 0) return ['WAIT_ARRIVAL_COOLDOWN', 'REQUEST_CANCELLATION'];
    return ['REQUEST_ARRIVAL', 'REQUEST_CANCELLATION'];
};

const getAcceptedDetailsService = async (jobId, currentUser) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    try {
        const job = await Job.findByPk(jobId, {
            include: [{ model: Service, attributes: ['id', 'name'] }]
        });

        if (!job) {
            return serviceError('Job not found.', 404, 'JOB_NOT_FOUND');
        }

        const isAdmin = currentUser.role === 'ADMIN';
        const isCustomer = currentUser.role === 'CUSTOMER' && job.customer_id === currentUser.id;
        const isSelectedHandyman = currentUser.role === 'HANDYMAN'
            && job.selected_handyman_id === currentUser.id;

        if (!isAdmin && !isCustomer && !isSelectedHandyman) {
            return serviceError(
                'You do not have permission to view this accepted job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        if (![
            'ACCEPTED',
            'EN_ROUTE',
            'ARRIVED',
            'QUOTE_PENDING',
            'PAYMENT_PENDING',
            'CANCELLATION_REVIEW',
            'IN_PROGRESS',
            'WARRANTY',
            'CLOSED'
        ].includes(job.current_status)) {
            return serviceError(
                'Job is not in an accepted lifecycle status.',
                409,
                'INVALID_JOB_STATUS',
                { current_status: job.current_status }
            );
        }

        const depositAlreadyDistributed = ['WARRANTY', 'CLOSED'].includes(job.current_status);
        const validation = depositAlreadyDistributed
            ? await validateAcceptedParticipantInvariants(job)
            : await validateAcceptedJobInvariants(job);
        if (validation.error) return validation.error;
        if (depositAlreadyDistributed && job.deposit_status !== 'DISTRIBUTED') {
            return serviceError(
                'Completion settlement state is inconsistent.',
                409,
                'FINANCIAL_DATA_INCONSISTENT',
                { deposit_status: job.deposit_status }
            );
        }

        const { selectedBid, customer, selectedHandyman } = validation;
        let partner = null;
        if (!isAdmin) {
            const partnerUser = isCustomer ? selectedHandyman : customer;
            const partnerRole = isCustomer ? 'HANDYMAN' : 'CUSTOMER';
            const partnerMetrics = await getPartnerMetrics(partnerUser.id, partnerRole);

            partner = {
                role: partnerRole,
                id: partnerUser.id,
                full_name: partnerUser.full_name,
                avatar_url: partnerUser.avatar_url,
                phone_number: partnerUser.phone_number,
                ...partnerMetrics
            };

            if (partnerRole === 'HANDYMAN') {
                const profile = await HandymanProfile.findOne({
                    where: { user_id: partnerUser.id },
                    attributes: ['total_jobs_completed']
                });
                partner = {
                    ...partner,
                    total_jobs_completed: profile?.total_jobs_completed || 0,
                    kyc_status: partnerUser.kyc_status
                };
            }
        }

        const lifecycleConfig = getJobLifecycleConfig();
        const quoteConfig = getQuoteConfig();
        const [
            latestArrivalRequest,
            rejectionCount,
            latestRejectedRequest,
            currentQuote,
            beforeEvidenceCount,
            currentCancellation,
            currentContract
        ] = await Promise.all([
            JobArrivalRequest.findOne({
                where: { job_id: job.id, acceptance_cycle: job.acceptance_cycle },
                order: [['requested_at', 'DESC'], ['createdAt', 'DESC']]
            }),
            JobArrivalRequest.count({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: 'REJECTED'
                }
            }),
            JobArrivalRequest.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: 'REJECTED'
                },
                order: [['responded_at', 'DESC'], ['updatedAt', 'DESC']]
            }),
            JobQuote.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    version: 1
                }
            }),
            EvidenceVault.count({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    customer_id: job.customer_id,
                    handyman_id: job.selected_handyman_id,
                    selected_bid_id: job.selected_bid_id,
                    uploader_id: job.selected_handyman_id,
                    stage: 'BEFORE',
                    media_type: 'IMAGE'
                }
            }),
            JobCancellation.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle,
                    status: { [Op.in]: ACTIVE_CANCELLATION_STATUSES }
                },
                order: [['createdAt', 'DESC']]
            }),
            EContract.findOne({
                where: {
                    job_id: job.id,
                    acceptance_cycle: job.acceptance_cycle
                }
            })
        ]);
        const [completionLifecycle, warrantyLifecycle] = await Promise.all([
            ['IN_PROGRESS', 'WARRANTY', 'CLOSED'].includes(job.current_status)
                ? loadCompletionLifecycle(job)
                : Promise.resolve(null),
            ['WARRANTY', 'CLOSED'].includes(job.current_status)
                ? loadWarrantyLifecycle(job)
                : Promise.resolve(null)
        ]);
        const reviewState = isAdmin
            ? { status: 'NOT_AVAILABLE', eligible: false, allowed_actions: [], review: null, reviewee: null }
            : await getReviewState({ job, actor: currentUser });
        if (job.current_status === 'WARRANTY' && !warrantyLifecycle?.warranty) {
            return serviceError(
                'Warranty lifecycle data is inconsistent.',
                409,
                'FINANCIAL_DATA_INCONSISTENT'
            );
        }
        const quoteItems = currentQuote
            ? await JobQuoteItem.findAll({
                where: { quote_id: currentQuote.id },
                order: [['sort_order', 'ASC']]
            })
            : [];
        const normalizedQuote = currentQuote
            ? normalizeStoredQuote(currentQuote, quoteItems, selectedBid.proposed_price)
            : null;
        const quoteReadiness = !currentQuote
            ? null
            : normalizedQuote.valid
                ? buildSubmitReadiness({
                    normalized: normalizedQuote,
                    evidenceCount: beforeEvidenceCount,
                    heldDepositAmount: job.deposit_amount
                })
                : {
                    ready: false,
                    missing_requirements: ['INVALID_DRAFT_DATA'],
                    before_evidence_count: beforeEvidenceCount,
                    variance_reason_required: false
                };
        const pendingRequest = latestArrivalRequest?.status === 'PENDING'
            ? latestArrivalRequest
            : null;
        const reviewRequired = rejectionCount >= lifecycleConfig.maxRejectionsPerCycle;
        const retryAfterSeconds = job.current_status !== 'EN_ROUTE'
            || pendingRequest
            || reviewRequired
            ? 0
            : getCooldownRemainingSeconds(
                latestRejectedRequest?.responded_at,
                new Date(),
                lifecycleConfig.arrivalCooldownSeconds
            );
        const canSeeHandymanRawGps = isAdmin || isSelectedHandyman;
        const canSeeDraftQuote = isAdmin || isSelectedHandyman;
        const participantVisibleQuoteStatuses = ['SUBMITTED', 'ACCEPTED', 'REJECTED'];
        const inspectionQuote = currentQuote
            && (participantVisibleQuoteStatuses.includes(currentQuote.status) || canSeeDraftQuote)
            ? {
                id: currentQuote.id,
                status: currentQuote.status,
                version: Number(currentQuote.version),
                ...(canSeeDraftQuote
                    ? { draft_revision: Number(currentQuote.draft_revision) }
                    : {}),
                total_amount: toCanonicalMoneyString(currentQuote.total_amount),
                currency: currentQuote.currency,
                submitted_at: currentQuote.submitted_at,
                accepted_at: currentQuote.accepted_at,
                rejected_at: currentQuote.rejected_at,
                rejection_reason: currentQuote.rejection_reason,
                before_evidence_count: beforeEvidenceCount,
                ...(canSeeDraftQuote ? { readiness: quoteReadiness } : {})
            }
            : null;
        let payment = null;
        if (currentQuote?.status === 'ACCEPTED' && normalizedQuote?.valid) {
            const paymentAmounts = calculateQuotePaymentAmounts({
                quoteTotalAmount: normalizedQuote.total,
                jobDepositAmount: job.deposit_amount,
                depositTransactionAmount: validation.depositTransaction?.amount || job.deposit_amount
            });
            if (!paymentAmounts.valid) {
                return serviceError(paymentAmounts.message, 409, paymentAmounts.code);
            }
            payment = buildPaymentSummaryDto({
                job,
                quote: currentQuote,
                contract: currentContract,
                amounts: paymentAmounts
            });
        }

        const deposit = (isCustomer || isAdmin)
            ? {
                amount: toNumber(job.deposit_amount),
                percentage: 10,
                status: job.deposit_status,
                paid_at: job.deposit_paid_at,
                label: job.deposit_status === 'DISTRIBUTED'
                    ? 'Tiền cọc đã được phân bổ trong settlement'
                    : 'Tiền cọc đang được hệ thống tạm giữ'
            }
            : {
                amount: toNumber(job.deposit_amount),
                status: job.deposit_status,
                label: job.deposit_status === 'DISTRIBUTED'
                    ? 'Tiền cọc đã được phân bổ trong settlement'
                    : 'Khách hàng đã đặt cọc thành công'
            };

        return {
            EM: 'Accepted job details retrieved successfully.',
            EC: 0,
            DT: {
                job: {
                    id: job.id,
                    status: job.current_status,
                    service: job.Service
                        ? { id: job.Service.id, name: job.Service.name }
                        : null,
                    issue_description: job.issue_description,
                    images: job.images || [],
                    scheduled_at: job.scheduled_at,
                    service_address: job.service_address,
                    gps_lat: job.gps_lat == null ? null : Number(job.gps_lat),
                    gps_long: job.gps_long == null ? null : Number(job.gps_long),
                    accepted_at: job.accepted_at,
                    acceptance_cycle: Number(job.acceptance_cycle),
                    arrived_at: job.arrived_at,
                    in_progress_at: job.in_progress_at
                },
                selected_bid: {
                    id: selectedBid.id,
                    proposed_price: toNumber(selectedBid.proposed_price),
                    message: selectedBid.message,
                    status: selectedBid.status
                },
                deposit,
                partner,
                participants: isAdmin
                    ? {
                        customer: {
                            id: customer.id,
                            full_name: customer.full_name,
                            role: customer.role,
                            is_active: customer.is_active
                        },
                        handyman: {
                            id: selectedHandyman.id,
                            full_name: selectedHandyman.full_name,
                            role: selectedHandyman.role,
                            is_active: selectedHandyman.is_active
                        }
                    }
                    : undefined,
                en_route: buildEnRouteDto(job, { includeRawGps: canSeeHandymanRawGps }),
                arrival_request: buildArrivalRequestDto(latestArrivalRequest, {
                    includeRawGps: canSeeHandymanRawGps
                }),
                arrival_policy: {
                    rejection_count: rejectionCount,
                    max_rejections: lifecycleConfig.maxRejectionsPerCycle,
                    review_required: reviewRequired,
                    retry_after_seconds: retryAfterSeconds || null
                },
                inspection_quote: inspectionQuote,
                quote: inspectionQuote,
                payment,
                contract: buildContractSummaryDto(currentContract),
                completion: completionLifecycle ? {
                    latest_request: buildCompletionRequestDto(completionLifecycle.latestRequest),
                    readiness: job.current_status === 'IN_PROGRESS'
                        && (isSelectedHandyman || isAdmin)
                        ? completionLifecycle.readiness
                        : null
                } : null,
                warranty: buildWarrantyDto(
                    warrantyLifecycle?.warranty,
                    warrantyLifecycle,
                    { includeAdmin: isAdmin, isCustomer, isSelectedHandyman }
                ),
                cancellation: buildCancellationDto(currentCancellation),
                review_state: reviewState,
                allowed_actions: buildAllowedActions({
                    job,
                    isCustomer,
                    isSelectedHandyman,
                    isAdmin,
                    pendingRequest,
                    reviewRequired,
                    retryAfterSeconds,
                    currentQuote,
                    beforeEvidenceCount,
                    quoteReadiness,
                    quoteConfig,
                    currentCancellation,
                    currentUserId: currentUser.id,
                    completionLifecycle,
                    warrantyLifecycle
                })
            }
        };
    } catch (error) {
        console.error('>>> Error in getAcceptedDetailsService:', error?.message || 'Unknown error');
        return serviceError('Unable to retrieve accepted job details.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

const validateMovingPayload = (payload = {}) => {
    const validation = validateGpsEvidence(payload);
    if (!validation.valid) {
        return serviceError(validation.error, 400, 'INVALID_COORDINATES');
    }
    return validation;
};

const startMovingService = async (jobId, handymanId, payload = {}) => {
    if (!isValidUuid(jobId)) {
        return serviceError('Invalid job id.', 400, 'VALIDATION_ERROR');
    }

    const handymanCoordinates = validateMovingPayload(payload);
    if (handymanCoordinates.EC) return handymanCoordinates;

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
                'Only the selected handyman can start moving for this job.',
                403,
                'FORBIDDEN_JOB_ACCESS'
            );
        }

        const acceptanceCycle = Number(job.acceptance_cycle);
        if (!Number.isInteger(acceptanceCycle) || acceptanceCycle < 1) {
            await transaction.rollback();
            return serviceError(
                'Job acceptance cycle is inconsistent.',
                409,
                'ACCEPTANCE_CYCLE_INCONSISTENT'
            );
        }

        if (job.current_status === 'EN_ROUTE') {
            await transaction.rollback();
            return {
                EM: 'Handyman has already started moving for this job.',
                EC: 0,
                code: 'EN_ROUTE_ALREADY_STARTED',
                DT: {
                    job_id: job.id,
                    acceptance_cycle: Number(job.acceptance_cycle),
                    status: job.current_status,
                    en_route: buildEnRouteDto(job, { includeRawGps: true })
                }
            };
        }

        if (job.current_status !== 'ACCEPTED') {
            await transaction.rollback();
            return serviceError(
                'Job is not in ACCEPTED status.',
                409,
                'INVALID_JOB_STATUS',
                { current_status: job.current_status }
            );
        }

        const validation = await validateAcceptedJobInvariants(job, { transaction });
        if (validation.error) {
            await transaction.rollback();
            return validation.error;
        }

        if (!validation.customer.is_active || !validation.selectedHandyman.is_active) {
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

        const lifecycleConfig = getJobLifecycleConfig();
        const distance = buildDistanceSnapshot({
            handymanCoordinates,
            jobCoordinates
        });
        const estimatedArrivalMinutes = calculateEstimatedArrivalMinutes(
            distance.distanceMeters,
            lifecycleConfig
        );
        const enRouteAt = new Date();
        await job.update({
            current_status: 'EN_ROUTE',
            en_route_at: enRouteAt,
            en_route_gps_lat: handymanCoordinates.latitude,
            en_route_gps_long: handymanCoordinates.longitude,
            en_route_gps_accuracy_meters: handymanCoordinates.accuracyMeters,
            en_route_distance_meters: distance.distanceMeters,
            en_route_estimated_arrival_minutes: estimatedArrivalMinutes
        }, { transaction });

        await JobStatusHistory.create({
            job_id: job.id,
            changed_by_user_id: handymanId,
            old_status: 'ACCEPTED',
            new_status: 'EN_ROUTE',
            reason: 'HANDYMAN_STARTED_MOVING',
            trigger_gps_lat: handymanCoordinates.latitude,
            trigger_gps_long: handymanCoordinates.longitude
        }, { transaction });

        await transaction.commit();
        const eventPayload = {
            job_id: job.id,
            acceptance_cycle: Number(job.acceptance_cycle),
            status: 'EN_ROUTE',
            started_at: enRouteAt,
            distance_meters: distance.distanceMeters,
            distance_km: distance.distanceKm,
            estimated_arrival_minutes: estimatedArrivalMinutes
        };
        emitJobLifecycleEvent({
            event: JOB_LIFECYCLE_EVENTS.EN_ROUTE,
            userIds: [job.customer_id],
            payload: eventPayload
        });
        return {
            EM: 'Handyman started moving.',
            EC: 0,
            code: 'EN_ROUTE_STARTED',
            DT: {
                job_id: job.id,
                acceptance_cycle: Number(job.acceptance_cycle),
                status: 'EN_ROUTE',
                en_route: buildEnRouteDto(job, { includeRawGps: true })
            }
        };
    } catch (error) {
        if (!transaction.finished) await transaction.rollback();
        console.error('>>> Error in startMovingService:', error?.message || 'Unknown error');
        return serviceError('Unable to start moving.', 500, 'INTERNAL_SERVER_ERROR');
    }
};

export {
    getAcceptedDetailsService,
    startMovingService,
    validateAcceptedJobInvariants,
    validateAcceptedParticipantInvariants,
    serviceError,
    isValidUuid
};
