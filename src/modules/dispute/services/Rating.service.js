import { Op, fn, col, literal } from 'sequelize';
import Review from '../models/Review.model.js';
import User from '../../identity/models/User.model.js';

const PARTICIPANT_ROLES = ['CUSTOMER', 'HANDYMAN'];

const canonicalReviewWhere = (extra = {}) => ({
  job_id: { [Op.ne]: null },
  reviewer_id: { [Op.ne]: null },
  reviewee_id: { [Op.ne]: null },
  acceptance_cycle: { [Op.gte]: 1 },
  reviewer_role: { [Op.in]: PARTICIPANT_ROLES },
  reviewee_role: { [Op.in]: PARTICIPANT_ROLES },
  rating_stars: { [Op.between]: [1, 5] },
  [Op.and]: [
    literal('"reviewer_id" <> "reviewee_id"'),
    literal('"reviewer_role" <> "reviewee_role"')
  ],
  ...extra
});

const formatRatio = (numerator, denominator, decimals = 2) => {
  if (!denominator || denominator === 0n) return null;
  const scale = 10n ** BigInt(decimals);
  const rounded = (numerator * scale + denominator / 2n) / denominator;
  const whole = rounded / scale;
  const fraction = String(rounded % scale).padStart(decimals, '0');
  return `${whole}.${fraction}`;
};

const emptySummary = () => ({
  review_count: 0,
  average_rating: null,
  distribution: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }
});

const getRatingSummaries = async (targets = []) => {
  const normalized = targets.filter((target) => target?.id && PARTICIPANT_ROLES.includes(target.role));
  const result = new Map(normalized.map((target) => [target.id, emptySummary()]));
  if (!normalized.length) return result;
  const targetScope = {
    [Op.or]: normalized.map((target) => ({ reviewee_id: target.id, reviewee_role: target.role }))
  };
  const [userTotals, distributions] = await Promise.all([
    Review.findAll({
      attributes: ['reviewee_id', [fn('COUNT', col('id')), 'count'], [fn('SUM', col('rating_stars')), 'sum']],
      where: canonicalReviewWhere(targetScope), group: ['reviewee_id'], raw: true
    }),
    Review.findAll({
      attributes: ['reviewee_id', 'rating_stars', [fn('COUNT', col('id')), 'count']],
      where: canonicalReviewWhere(targetScope), group: ['reviewee_id', 'rating_stars'], raw: true
    })
  ]);
  const byUser = new Map(userTotals.map((entry) => [entry.reviewee_id, { count: BigInt(entry.count || 0), sum: BigInt(entry.sum || 0) }]));
  const distributionByUser = new Map();
  distributions.forEach((entry) => {
    if (!distributionByUser.has(entry.reviewee_id)) distributionByUser.set(entry.reviewee_id, { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 });
    distributionByUser.get(entry.reviewee_id)[String(entry.rating_stars)] = Number(entry.count || 0);
  });

  normalized.forEach((target) => {
    const own = byUser.get(target.id);
    if (!own?.count) return;
    const summary = {
      review_count: Number(own.count),
      average_rating: formatRatio(own.sum, own.count),
      distribution: distributionByUser.get(target.id) || emptySummary().distribution
    };
    result.set(target.id, summary);
  });
  return result;
};

const getRatingSummary = async (userId, knownRole = null) => {
  const role = knownRole || (await User.findByPk(userId, { attributes: ['role'], raw: true }))?.role;
  const summaries = await getRatingSummaries([{ id: userId, role }]);
  return summaries.get(userId) || emptySummary();
};

export { canonicalReviewWhere, emptySummary, getRatingSummaries, getRatingSummary };
