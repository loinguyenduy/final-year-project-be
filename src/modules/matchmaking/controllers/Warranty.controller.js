import {
    createWarrantyClaimService,
    getWarrantyClaimEvidenceService,
    listWarrantyClaimsService
} from '../services/WarrantyClaim.service.js';
import { getWarrantyDetailsService } from '../services/WarrantyLifecycle.service.js';
import {
    confirmWarrantyCompletionRequestService,
    createWarrantyCompletionRequestService,
    getWarrantyCompletionEvidenceService,
    listWarrantyCompletionRequestsService,
    rejectWarrantyCompletionRequestService
} from '../services/WarrantyRework.service.js';

const getHttpStatus = (result, successStatus = 200) => {
    if (result.EC === 0) return successStatus;
    return [400, 401, 403, 404, 409].includes(result.EC) ? result.EC : 500;
};

const run = (operation, successStatus = 200) => async (req, res) => {
    try {
        const result = await operation(req);
        const status = result.EC === 0 && !String(result.code || '').includes('ALREADY')
            ? successStatus
            : 200;
        return res.status(getHttpStatus(result, status)).json(result);
    } catch (error) {
        console.error('[warranty] Controller operation failed.', error);
        return res.status(500).json({
            EM: 'Internal server error.',
            EC: 500,
            code: 'INTERNAL_SERVER_ERROR',
            DT: ''
        });
    }
};

const handleGetWarranty = run((req) => getWarrantyDetailsService(req.params.jobId, req.user));
const handleCreateWarrantyClaim = run(
    (req) => createWarrantyClaimService(req.params.jobId, req.user, req.body),
    201
);
const handleListWarrantyClaims = run(
    (req) => listWarrantyClaimsService(req.params.jobId, req.user)
);
const handleGetWarrantyClaimEvidence = run(
    (req) => getWarrantyClaimEvidenceService(req.params.jobId, req.params.claimId, req.user)
);
const handleCreateWarrantyCompletionRequest = run(
    (req) => createWarrantyCompletionRequestService(req.params.jobId, req.user.id, req.body),
    201
);
const handleListWarrantyCompletionRequests = run(
    (req) => listWarrantyCompletionRequestsService(req.params.jobId, req.user)
);
const handleGetWarrantyCompletionEvidence = run(
    (req) => getWarrantyCompletionEvidenceService(req.params.jobId, req.params.requestId, req.user)
);
const handleConfirmWarrantyCompletionRequest = async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length > 0) {
        return res.status(400).json({
            EM: 'Confirm Warranty Completion body must be an empty JSON object.',
            EC: 400,
            code: 'VALIDATION_ERROR',
            DT: ''
        });
    }
    return run(
        (request) => confirmWarrantyCompletionRequestService(
            request.params.jobId,
            request.params.requestId,
            request.user
        )
    )(req, res);
};
const handleRejectWarrantyCompletionRequest = run(
    (req) => rejectWarrantyCompletionRequestService(
        req.params.jobId,
        req.params.requestId,
        req.user,
        req.body
    )
);

export {
    handleConfirmWarrantyCompletionRequest,
    handleCreateWarrantyClaim,
    handleCreateWarrantyCompletionRequest,
    handleGetWarranty,
    handleGetWarrantyClaimEvidence,
    handleGetWarrantyCompletionEvidence,
    handleListWarrantyClaims,
    handleListWarrantyCompletionRequests,
    handleRejectWarrantyCompletionRequest
};
