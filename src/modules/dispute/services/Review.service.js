import { Op, UniqueConstraintError } from 'sequelize';
import db from '../../../core/database/connection.js';
import Review from '../models/Review.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import Service from '../../matchmaking/models/Service.model.js';
import User from '../../identity/models/User.model.js';
import { canonicalReviewWhere } from './Rating.service.js';
import { emitJobLifecycleEvent } from '../../matchmaking/sockets/JobLifecycle.gateway.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_EVENT = 'JOB_REVIEW_SUBMITTED';

class ReviewError extends Error {
  constructor(message, status = 400, code = 'JOB_REVIEW_INVALID') {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.code = code;
  }
}

const safeReviewer = (reviewer, storedRole) => ({
  display_name: reviewer?.full_name || 'Participant',
  avatar_url: reviewer?.avatar_url || null,
  role: storedRole
});

const reviewDto = (review, { publicView = false } = {}) => ({
  review_id: review.id,
  rating: Number(review.rating_stars),
  comment: review.comment || null,
  created_at: review.createdAt,
  verified_job: true,
  ...(publicView ? {
    reviewer: safeReviewer(review.Reviewer, review.reviewer_role),
    service: review.Job?.Service ? { name: review.Job.Service.name } : null
  } : {})
});

const resolveParties = (job, actor) => {
  if (actor.role === 'CUSTOMER' && actor.id === job.customer_id) {
    return { reviewerId: actor.id, reviewerRole: 'CUSTOMER', revieweeId: job.selected_handyman_id, revieweeRole: 'HANDYMAN' };
  }
  if (actor.role === 'HANDYMAN' && actor.id === job.selected_handyman_id) {
    return { reviewerId: actor.id, reviewerRole: 'HANDYMAN', revieweeId: job.customer_id, revieweeRole: 'CUSTOMER' };
  }
  return null;
};

const validateComment = (value) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new ReviewError('comment must be a string.');
  const comment = value.normalize('NFC').trim();
  if (!comment) return null;
  if (comment.length > 1000 || /<[^>]*>|\p{Cc}/u.test(comment)) {
    throw new ReviewError('comment must be plain text and no longer than 1000 characters.');
  }
  return comment;
};

const getReviewState = async ({ job, actor, transaction = null }) => {
  const cycle = Number(job?.acceptance_cycle);
  const parties = resolveParties(job, actor);
  if (job?.current_status !== 'CLOSED' || !Number.isInteger(cycle) || cycle < 1 || !parties?.revieweeId) {
    return { status: 'NOT_AVAILABLE', eligible: false, allowed_actions: [], review: null, reviewee: null };
  }
  const [existing, reviewee] = await Promise.all([
    Review.findOne({
      where: canonicalReviewWhere({ job_id: job.id, acceptance_cycle: cycle, reviewer_id: parties.reviewerId, reviewee_id: parties.revieweeId }),
      transaction
    }),
    User.findByPk(parties.revieweeId, { attributes: ['id', 'full_name', 'avatar_url', 'role'], transaction })
  ]);
  return {
    status: existing ? 'SUBMITTED' : 'PENDING',
    eligible: !existing,
    allowed_actions: existing ? [] : ['SUBMIT_REVIEW'],
    review: existing ? reviewDto(existing) : null,
    reviewee: reviewee ? { user_id: reviewee.id, display_name: reviewee.full_name, avatar_url: reviewee.avatar_url, role: reviewee.role } : null
  };
};

const getReviewStateMap = async ({ jobs, actor }) => {
  const result = new Map(jobs.map((job) => [job.id, { status: 'NOT_AVAILABLE', eligible: false }]));
  const eligibleJobs = jobs.filter((job) => job.current_status === 'CLOSED'
    && Number.isInteger(Number(job.acceptance_cycle)) && Number(job.acceptance_cycle) >= 1
    && resolveParties(job, actor)?.revieweeId);
  if (!eligibleJobs.length) return result;
  const existing = await Review.findAll({
    where: canonicalReviewWhere({
      reviewer_id: actor.id,
      [Op.or]: eligibleJobs.map((job) => {
        const parties = resolveParties(job, actor);
        return { job_id: job.id, acceptance_cycle: Number(job.acceptance_cycle), reviewee_id: parties.revieweeId };
      })
    }),
    attributes: ['job_id', 'acceptance_cycle']
  });
  const submitted = new Set(existing.map((entry) => `${entry.job_id}:${entry.acceptance_cycle}`));
  eligibleJobs.forEach((job) => {
    const done = submitted.has(`${job.id}:${Number(job.acceptance_cycle)}`);
    result.set(job.id, { status: done ? 'SUBMITTED' : 'PENDING', eligible: !done });
  });
  return result;
};

const submitReview = async ({ jobId, actor, payload }) => {
  if (!UUID.test(String(jobId || ''))) throw new ReviewError('jobId must be a valid UUID.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ReviewError('Review body must be an object.');
  const unknown = Object.keys(payload).filter((key) => !['rating', 'comment'].includes(key));
  if (unknown.length) throw new ReviewError(`Unsupported fields: ${unknown.join(', ')}.`);
  const rating = Number(payload.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ReviewError('rating must be an integer between 1 and 5.');
  const comment = validateComment(payload.comment);
  const transaction = await db.transaction();
  let created;
  let signal;
  try {
    const job = await Job.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!job) throw new ReviewError('Job was not found.', 404, 'JOB_NOT_FOUND');
    if (job.current_status !== 'CLOSED') throw new ReviewError('Reviews are available only after the Job is closed.', 409, 'JOB_REVIEW_NOT_AVAILABLE');
    const cycle = Number(job.acceptance_cycle);
    if (!Number.isInteger(cycle) || cycle < 1 || !job.customer_id || !job.selected_handyman_id) {
      throw new ReviewError('The completed acceptance cycle is inconsistent.', 409, 'ACCEPTANCE_CYCLE_INCONSISTENT');
    }
    const parties = resolveParties(job, actor);
    if (!parties) throw new ReviewError('You are not allowed to review this Job.', 403, 'JOB_REVIEW_NOT_ALLOWED');
    const existing = await Review.findOne({
      where: canonicalReviewWhere({ job_id: job.id, acceptance_cycle: cycle, reviewer_id: parties.reviewerId, reviewee_id: parties.revieweeId }),
      transaction
    });
    if (existing) throw new ReviewError('You already reviewed this Job.', 409, 'JOB_REVIEW_ALREADY_SUBMITTED');
    created = await Review.create({
      job_id: job.id,
      acceptance_cycle: cycle,
      reviewer_id: parties.reviewerId,
      reviewee_id: parties.revieweeId,
      reviewer_role: parties.reviewerRole,
      reviewee_role: parties.revieweeRole,
      rating_stars: rating,
      comment,
      is_job_successful: true
    }, { transaction });
    await transaction.commit();
    signal = { job, userIds: [job.customer_id, job.selected_handyman_id] };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    if (error instanceof UniqueConstraintError) throw new ReviewError('You already reviewed this Job.', 409, 'JOB_REVIEW_ALREADY_SUBMITTED');
    throw error;
  }
  emitJobLifecycleEvent({
    event: REVIEW_EVENT,
    userIds: signal.userIds,
    payload: { job_id: signal.job.id, occurred_at: new Date() }
  });
  return reviewDto(created);
};

const listPublicReviews = async ({ userId, query = {} }) => {
  if (!UUID.test(String(userId || ''))) throw new ReviewError('userId must be a valid UUID.');
  const target = await User.findOne({ where: { id: userId, role: { [Op.in]: ['CUSTOMER', 'HANDYMAN'] }, is_active: true }, attributes: ['id'] });
  if (!target) throw new ReviewError('Participant profile was not found.', 404, 'PUBLIC_PROFILE_NOT_FOUND');
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(query.page_size || '10', 10) || 10));
  const rating = query.rating == null || query.rating === '' ? null : Number(query.rating);
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new ReviewError('rating filter is invalid.');
  const sort = String(query.sort || 'NEWEST').toUpperCase();
  const orderBy = {
    NEWEST: [['createdAt', 'DESC'], ['id', 'DESC']],
    OLDEST: [['createdAt', 'ASC'], ['id', 'ASC']],
    HIGHEST: [['rating_stars', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']],
    LOWEST: [['rating_stars', 'ASC'], ['createdAt', 'DESC'], ['id', 'DESC']]
  }[sort];
  if (!orderBy) throw new ReviewError('sort is invalid.');
  const where = canonicalReviewWhere({ reviewee_id: userId, ...(rating ? { rating_stars: rating } : {}) });
  const { rows, count } = await Review.findAndCountAll({
    where,
    include: [
      { model: User, as: 'Reviewer', attributes: ['full_name', 'avatar_url'], required: false },
      { model: Job, attributes: ['id'], include: [{ model: Service, attributes: ['name'], required: false }], required: false }
    ],
    order: orderBy,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true
  });
  return {
    items: rows.map((entry) => reviewDto(entry, { publicView: true })),
    pagination: { page, page_size: pageSize, total_items: count, total_pages: Math.ceil(count / pageSize) }
  };
};

export { REVIEW_EVENT, ReviewError, getReviewState, getReviewStateMap, listPublicReviews, reviewDto, submitReview };
