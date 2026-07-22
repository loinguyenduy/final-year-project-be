import { Op } from 'sequelize';
import KycRequest from '../../identity/models/KycRequest.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import JobCancellation from '../../matchmaking/models/JobCancellation.model.js';
import JobWarranty from '../../matchmaking/models/JobWarranty.model.js';
import WarrantyClaim from '../../matchmaking/models/WarrantyClaim.model.js';
import WarrantyCompletionRequest from '../../matchmaking/models/WarrantyCompletionRequest.model.js';

const getAdminOperationalQueueSnapshot = async () => {
  const [kycPending, warrantyClaims, reviewWarranties, cancellationReviews] = await Promise.all([
    KycRequest.count({
      distinct: true,
      col: 'submission_id',
      where: { submission_id: { [Op.ne]: null }, status: 'PENDING' }
    }),
    WarrantyClaim.findAll({
      attributes: ['id', 'job_id'],
      where: { status: 'PENDING_REVIEW' },
      include: [
        { model: JobWarranty, as: 'Warranty', required: true, where: { status: 'CLAIM_PENDING', released_at: null, refunded_at: null } },
        { model: Job, required: true, where: { current_status: 'WARRANTY' } }
      ],
      raw: true
    }),
    JobWarranty.findAll({
      attributes: ['id', 'job_id'],
      where: { status: 'REVIEW_REQUIRED', released_at: null, refunded_at: null },
      include: [
        { model: Job, required: true, where: { current_status: 'WARRANTY' }, attributes: [] },
        { model: WarrantyClaim, as: 'Claims', required: true, where: { status: 'REVIEW_REQUIRED' }, attributes: [] },
        { model: WarrantyCompletionRequest, as: 'CompletionRequests', required: true, where: { status: 'REJECTED' }, attributes: [] }
      ],
      group: ['Job_Warranty.id'],
      raw: true
    }),
    JobCancellation.findAll({
      attributes: ['id', 'job_id'],
      where: {
        status: 'REVIEW_REQUIRED',
        status_when_cancelled: { [Op.in]: ['EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING'] }
      },
      include: [{ model: Job, required: true, where: { current_status: 'CANCELLATION_REVIEW' }, attributes: [] }],
      raw: true
    })
  ]);
  const pendingJobIds = new Set([
    ...warrantyClaims.map((entry) => entry.job_id),
    ...reviewWarranties.map((entry) => entry.job_id),
    ...cancellationReviews.map((entry) => entry.job_id)
  ].filter(Boolean));
  const counts = {
    kyc_pending: Number(kycPending) || 0,
    warranty_claim_pending: warrantyClaims.length,
    warranty_rework_review_required: reviewWarranties.length,
    cancellation_review_required: cancellationReviews.length
  };
  counts.review_pending_total = counts.warranty_claim_pending
    + counts.warranty_rework_review_required
    + counts.cancellation_review_required;
  return { counts, distinct_jobs_needing_review: pendingJobIds.size };
};

const getAdminQueueCounts = async () => {
  const { counts } = await getAdminOperationalQueueSnapshot();
  return counts;
};

export { getAdminOperationalQueueSnapshot, getAdminQueueCounts };
