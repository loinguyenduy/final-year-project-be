const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
  'bị', 'cái', 'cần', 'cho', 'có', 'của', 'đang', 'được', 'khi', 'là', 'một',
  'nhà', 'nhưng', 'ở', 'tôi', 'trong', 'và', 'với'
]);

const tokenize = (value) => {
  if (typeof value !== 'string') return [];
  const matches = value
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN')
    .match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(matches.filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
};

const tokenSetFromArray = (values) => new Set(
  (Array.isArray(values) ? values : []).flatMap((value) => tokenize(value))
);

const intersectionSize = (left, right) => {
  let count = 0;
  left.forEach((entry) => {
    if (right.has(entry)) count += 1;
  });
  return count;
};

const ratioScore = (numerator, denominator) => (
  denominator > 0 ? Math.floor((numerator * 10000) / denominator) : null
);

const buildCurrentTokenComponents = ({
  issueDescription,
  problemSummary,
  keywords,
  symptoms
}) => {
  const keywordTokens = tokenSetFromArray(keywords);
  const symptomTokens = tokenSetFromArray(symptoms);
  keywordTokens.forEach((token) => symptomTokens.delete(token));

  const descriptionTokens = new Set(tokenize(
    [issueDescription, problemSummary].filter(Boolean).join(' ')
  ));
  keywordTokens.forEach((token) => descriptionTokens.delete(token));
  symptomTokens.forEach((token) => descriptionTokens.delete(token));

  return {
    descriptionTokens,
    keywordTokens,
    symptomTokens
  };
};

const scoreHistoricalDescription = (components, historicalDescription) => {
  const historicalTokens = new Set(tokenize(historicalDescription));
  const definitions = [
    {
      set: components.descriptionTokens,
      weight: 5000,
      value: components.descriptionTokens.size > 0
        ? ratioScore(
          2 * intersectionSize(components.descriptionTokens, historicalTokens),
          components.descriptionTokens.size + historicalTokens.size
        )
        : null
    },
    {
      set: components.keywordTokens,
      weight: 3000,
      value: components.keywordTokens.size > 0
        ? ratioScore(
          intersectionSize(components.keywordTokens, historicalTokens),
          components.keywordTokens.size
        )
        : null
    },
    {
      set: components.symptomTokens,
      weight: 2000,
      value: components.symptomTokens.size > 0
        ? ratioScore(
          intersectionSize(components.symptomTokens, historicalTokens),
          components.symptomTokens.size
        )
        : null
    }
  ].filter((entry) => entry.value !== null);

  if (definitions.length === 0) return 0;
  const activeWeight = definitions.reduce((sum, entry) => sum + entry.weight, 0);
  return Math.floor(
    definitions.reduce((sum, entry) => sum + (entry.value * entry.weight), 0)
      / activeWeight
  );
};

// Chuyển structured thành token
const rankHistoricalCandidates = (candidates, currentState) => {
  const components = buildCurrentTokenComponents({
    issueDescription: currentState.issue_description,
    problemSummary: currentState.problem_summary,
    keywords: currentState.keywords,
    symptoms: currentState.symptoms
  });
  return candidates
    .map((candidate) => ({
      ...candidate,
      similarity_score: scoreHistoricalDescription(
        components,
        candidate.issue_description
      )
    }))
    .sort((left, right) => (
      right.similarity_score - left.similarity_score
      || new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      || String(right.id).localeCompare(String(left.id))
    ));
};

export {
  buildCurrentTokenComponents,
  rankHistoricalCandidates,
  scoreHistoricalDescription,
  tokenize
};
