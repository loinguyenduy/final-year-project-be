import { Op } from 'sequelize';
import KycRequest from '../../identity/models/KycRequest.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';

const getAdminQueueCounts = async () => {
  const [kycPending, warrantyClaimPending, reviewWarranties, cancellationReviewRequired] = await Promise.all([
    KycRequest.count({
      distinct: true,
      col: 'submission_id',
      where: { submission_id: { [Op.ne]: null }, status: 'PENDING' }
    }),
    WarrantyClaim.count({
      distinct: true,
      col: 'id',
      where: { status: 'PENDING_REVIEW' },
      include: [
        { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'CLAIM_PENDING', released_at: null, refunded_at: null } },
        { model: Job, required: true, where: { current_status: 'WARRANTY' } }
      ]
    }),
    JobWarranty.findAll({
      attributes: ['id'],
      where: { status: 'REVIEW_REQUIRED', released_at: null, refunded_at: null },
      include: [
        { model: Job, required: true, where: { current_status: 'WARRANTY' }, attributes: [] },
        { model: WarrantyClaim, as: 'Claims', required: true, where: { status: 'REVIEW_REQUIRED' }, attributes: [] },
        { model: WarrantyCompletionRequest, as: 'CompletionRequests', required: true, where: { status: 'REJECTED' }, attributes: [] }
      ],
      group: ['Job_Warranty.id'],
      raw: true
    }),
    JobCancellation.count({
      distinct: true,
      col: 'id',
      where: {
        status: 'REVIEW_REQUIRED',
        status_when_cancelled: { [Op.in]: ['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'] }
      },
      include: [{ model: Job, required: true, where: { current_status: 'CANCELLATION_REVIEW' } }]
    })
  ]);
  const counts = {
    kyc_pending: Number(kycPending) || 0,
    warranty_claim_pending: Number(warrantyClaimPending) || 0,
    warranty_rework_review_required: reviewWarranties.length,
    cancellation_review_required: Number(cancellationReviewRequired) || 0
  };
  counts.review_pending_total = counts.warranty_claim_pending
    + counts.warranty_rework_review_required
    + counts.cancellation_review_required;
  return counts;
};

export { getAdminQueueCounts };
