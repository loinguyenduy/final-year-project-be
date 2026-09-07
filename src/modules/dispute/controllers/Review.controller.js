import { ReviewError, listPublicReviews, submitReview } from '../services/Review.service.js';

const fail = (req, res, error) => {
  if (error instanceof ReviewError) return res.status(error.status).json({ EM: error.message, EC: error.status, code: error.code, DT: '' });
  console.error('[review] Request failed.', { correlation_id: req.correlationId || null, error: error?.message || 'Unknown error' });
  return res.status(500).json({ EM: 'Unable to process the Review request.', EC: 500, code: 'INTERNAL_SERVER_ERROR', DT: '' });
};

const createReview = async (req, res) => {
  try {
    const data = await submitReview({ jobId: req.params.jobId, actor: req.user, payload: req.body });
    return res.status(201).json({ EM: 'Review submitted successfully.', EC: 0, code: 'JOB_REVIEW_SUBMITTED', DT: data });
  } catch (error) { return fail(req, res, error); }
};

const getPublicReviews = async (req, res) => {
  try {
    return res.status(200).json({ EM: 'Public Reviews retrieved successfully.', EC: 0, code: 'PUBLIC_REVIEWS_RETRIEVED', DT: await listPublicReviews({ userId: req.params.userId, query: req.query }) });
  } catch (error) { return fail(req, res, error); }
};

export { createReview, getPublicReviews };
