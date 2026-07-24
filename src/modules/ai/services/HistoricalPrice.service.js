import { QueryTypes } from 'sequelize';
import db from '../../../core/database/connection.js';
import { getAiConfig } from '../config/ai.config.js';
import { rankHistoricalCandidates } from '../utils/historicalSimilarity.util.js';
import {
  buildHistoricalEstimate,
  parsePositiveVndInteger
} from '../utils/vndEstimator.util.js';

const retrieveHistoricalCandidates = async ({ serviceId, currentState }) => {
  const config = getAiConfig();
  const rows = await db.query(`
    SELECT
      job.id,
      job.issue_description,
      job."updatedAt" AS updated_at,
      bid.proposed_price
    FROM "Jobs" AS job
    INNER JOIN "Bids" AS bid
      ON bid.id = job.selected_bid_id
      AND bid.job_id = job.id
      AND bid.handyman_id = job.selected_handyman_id
      AND bid.status = 'WON'
    WHERE job.service_id = :serviceId
      AND job.current_status = 'CLOSED'
      AND job.acceptance_cycle >= 1
      AND bid.proposed_price > 0
    ORDER BY job."updatedAt" DESC, job.id DESC
    LIMIT :candidateLimit
  `, {
    replacements: {
      serviceId,
      candidateLimit: config.maxHistoricalCandidates
    },
    type: QueryTypes.SELECT
  });

  const validCandidates = rows.filter(
    (row) => parsePositiveVndInteger(row.proposed_price) !== null
  );
  const ranked = rankHistoricalCandidates(validCandidates, currentState);
  return {
    candidateCount: validCandidates.length,
    comparable: ranked.slice(0, config.maxComparableResults)
  };
};

const estimateHistoricalPrice = async ({ serviceId, currentState }) => {
  const config = getAiConfig();
  const retrieval = await retrieveHistoricalCandidates({ serviceId, currentState });
  return buildHistoricalEstimate({
    amounts: retrieval.comparable.map((entry) => entry.proposed_price),
    candidateCount: retrieval.candidateCount,
    minimumSamples: config.minPriceSamples,
    estimatorVersion: config.estimatorVersion
  });
};

export { estimateHistoricalPrice, retrieveHistoricalCandidates };
