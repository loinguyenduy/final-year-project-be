import { AI_PRICING_BASIS } from '../constants/ai.constants.js';

const ROUNDING_STEP = 10000n;
const MAX_JOB_BUDGET = 9999999999n;

const parsePositiveVndInteger = (value) => {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\.0+)?$/);
  if (!match) return null;
  const amount = BigInt(match[1]);
  return amount > 0n && amount <= MAX_JOB_BUDGET ? amount : null;
};

const nearestRank = (sorted, percentile) => {
  const rank = Math.max(1, Math.ceil((percentile * sorted.length) / 100));
  return sorted[rank - 1];
};

const median = (sorted) => {
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint] + 1n) / 2n;
};

const removeOutliers = (sorted, minimumSamples) => {
  if (sorted.length < 8) return { values: sorted, removed: 0, usedFence: false };
  const q1 = nearestRank(sorted, 25);
  const q3 = nearestRank(sorted, 75);
  const iqr = q3 - q1;
  const lowerDoubled = (2n * q1) - (3n * iqr);
  const upperDoubled = (2n * q3) + (3n * iqr);
  const filtered = sorted.filter((value) => {
    const doubled = 2n * value;
    return doubled >= lowerDoubled && doubled <= upperDoubled;
  });
  if (filtered.length < minimumSamples) {
    return { values: sorted, removed: 0, usedFence: false };
  }
  return {
    values: filtered,
    removed: sorted.length - filtered.length,
    usedFence: true
  };
};

const roundDown = (value) => (value / ROUNDING_STEP) * ROUNDING_STEP;
const roundNearest = (value) => (
  ((value + (ROUNDING_STEP / 2n)) / ROUNDING_STEP) * ROUNDING_STEP
);
const roundUp = (value) => (
  ((value + ROUNDING_STEP - 1n) / ROUNDING_STEP) * ROUNDING_STEP
);

const buildHistoricalEstimate = ({
  amounts,
  candidateCount,
  minimumSamples,
  estimatorVersion
}) => {
  const parsed = amounts
    .map(parsePositiveVndInteger)
    .filter((entry) => entry !== null)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (parsed.length < minimumSamples) {
    return {
      suggested_min_amount: null,
      suggested_typical_amount: null,
      suggested_max_amount: null,
      confidence: 'INSUFFICIENT_DATA',
      sample_count: parsed.length,
      candidate_count: candidateCount,
      pricing_basis: AI_PRICING_BASIS,
      explanation_code: 'NOT_ENOUGH_COMPARABLE_JOBS',
      outlier_count: 0,
      estimator_version: estimatorVersion,
      generated_at: new Date().toISOString()
    };
  }

  const outlierResult = removeOutliers(parsed, minimumSamples);
  const sample = outlierResult.values;
  const rawMinimum = nearestRank(sample, 25);
  const rawTypical = median(sample);
  const rawMaximum = nearestRank(sample, 75);
  const iqr = rawMaximum - rawMinimum;

  let minimum = roundDown(rawMinimum);
  let typical = roundNearest(rawTypical);
  let maximum = roundUp(rawMaximum);
  minimum = minimum <= 0n ? ROUNDING_STEP : minimum;
  maximum = maximum > MAX_JOB_BUDGET ? MAX_JOB_BUDGET : maximum;
  typical = typical < minimum ? minimum : typical;
  typical = typical > maximum ? maximum : typical;
  minimum = minimum > typical ? typical : minimum;
  maximum = maximum < typical ? typical : maximum;

  const confidence = sample.length >= 6 && iqr <= rawTypical ? 'MEDIUM' : 'LOW';
  return {
    suggested_min_amount: minimum.toString(),
    suggested_typical_amount: typical.toString(),
    suggested_max_amount: maximum.toString(),
    confidence,
    sample_count: sample.length,
    candidate_count: candidateCount,
    pricing_basis: AI_PRICING_BASIS,
    explanation_code: confidence === 'MEDIUM'
      ? 'ENOUGH_COMPARABLE_JOBS'
      : 'LIMITED_OR_WIDE_COMPARABLE_JOBS',
    outlier_count: outlierResult.removed,
    estimator_version: estimatorVersion,
    generated_at: new Date().toISOString()
  };
};

export {
  MAX_JOB_BUDGET,
  buildHistoricalEstimate,
  median,
  nearestRank,
  parsePositiveVndInteger,
  removeOutliers
};
