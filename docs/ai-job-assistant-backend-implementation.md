# AI Job Assistant Backend Implementation

## Summary

The backend adds an optional Customer AI assistant that resolves an active
Service, prepares a safe Job form draft, and calculates historical price
guidance from real selected/won Bids. Gemini never queries the database,
calculates money, or creates a Job.

Manual `POST /api/v1/matchmaking/jobs` requests without
`ai_assistant_session_id` do not query AI tables and retain their existing
behavior.

## Gate results

| Gate | Implementation | Verification |
|---|---|---|
| 1 | `@google/genai@2.13.0`, config, provider, structured output, smoke | Syntax passed. Current environment has an API key but no model; smoke returned `AI_PROVIDER_NOT_CONFIGURED` without exposing the key. |
| 2 | Session/message schema, Customer-only API, ownership, expiry, revision and failed-row retry | Syntax, route import and association smoke passed. Database rollout was not run because it requires a backup and explicit one-instance alter procedure. |
| 3 | Canonical CLOSED Job query, text-only similarity and BigInt estimator | Pure similarity/estimator checks passed. |
| 4 | Accept, recalculate, own budget, continue-without-estimate and form draft | Static/import checks passed; live provider flow requires `GEMINI_MODEL`. |
| 5 | Atomic Job snapshot/session apply and safe Job DTO projection | Static/import/association checks passed; live DB integration remains a rollout/manual test. |
| 6 | Smoke/manual scripts, environment example and documentation | See command results below. |

## Public API

Prefix: `/api/v1/ai/job-assistant`

- `POST /sessions`
- `GET /sessions/:sessionId`
- `POST /sessions/:sessionId/messages`
- `POST /sessions/:sessionId/price-decision`
- `POST /sessions/:sessionId/abandon`

All endpoints require an active Customer access token, apply IP and Customer
rate limits, return `Cache-Control: private, no-store`, and use the existing
`{ EM, EC, code, DT }` envelope.

## Files changed

Created under `src/modules/ai`:

- Config/constants/error and request/response validators.
- `Gemini.provider.js`.
- Session, message and Job price-snapshot models.
- Session orchestration, price decision, historical retrieval and Job
  integration services.
- Similarity/BigInt estimator utilities.
- Controller and route.

Integration files modified:

- `src/core/database/setup.js`
- `src/core/middlewares/rateLimit.middleware.js`
- `src/core/routes/v1.routes.js`
- `src/modules/matchmaking/controllers/CustomerJob.controller.js`
- `src/modules/matchmaking/services/CustomerJob.service.js`
- `src/modules/matchmaking/services/Job.service.js`
- `src/modules/matchmaking/services/HandymanJob.service.js`
- `package.json` and `package-lock.json`

Operational artifacts:

- `.env.example`
- `scripts/ai/geminiSmoke.js`
- `scripts/ai/manualAiJobAssistantTest.js`
- This implementation document and the manual test guide.
- Workspace `PROJECT_CONTEXT_AND_GUIDELINES.md`.

## Environment

```text
GEMINI_API_KEY
GEMINI_MODEL
AI_REQUEST_TIMEOUT_MS=20000
AI_MAX_TURNS=8
AI_MAX_RECALCULATIONS=2
AI_SESSION_TTL_MINUTES=1440
AI_MAX_ACTIVE_SESSIONS_PER_CUSTOMER=3
AI_RATE_LIMIT_WINDOW_MS=900000
AI_RATE_LIMIT_MAX=20
AI_PROMPT_VERSION=job-diagnosis-v1
AI_ESTIMATOR_VERSION=historical-bid-v1
AI_MIN_PRICE_SAMPLES=3
AI_MAX_HISTORICAL_CANDIDATES=100
AI_MAX_COMPARABLE_RESULTS=30
```

Message mutation requires `expected_revision`; `client_message_id` is optional
for transport compatibility. A future frontend must generate a stable UUID
before the first request to obtain exact replay semantics.

## Gemini boundary

- SDK and model calls exist only in `Gemini.provider.js`.
- The current Customer message appears once in one ordered conversation array.
- Prior context contains only completed turns; failed/stale messages are excluded.
- Structured output uses a small JSON Schema subset and is independently
  rebuilt by a strict backend whitelist.
- Gemini output cannot contain price, database IDs, address, GPS, identity,
  Wallet, payment or arbitrary properties.
- Invalid structured output receives one retry. Quota, timeout and missing
  configuration do not retry.
- Production logs contain no Customer free text, prompt, raw response or key.

## Session state and idempotency

State flow:

```text
ACTIVE/COLLECTING_PROBLEM
  -> ACTIVE/CLARIFYING
  -> ESTIMATE_PRESENTED
  -> DRAFT_READY
  -> APPLIED_TO_JOB
```

Terminal alternatives are `ABANDONED` and `EXPIRED`.

Customer messages are reserved in a short transaction, Gemini is called
without a database lock, and the result commits only when the reserved revision
is still current.

For the same `client_message_id`:

- same normalized text and `COMPLETED`: replay;
- same normalized text and `FAILED`: reuse the row and retry;
- different text: conflict;
- failed retry does not insert another Customer row or increment the logical
  turn count again.

Expiry blocks mutation but does not delete messages. Retention cleanup is future
work; no cleanup cron was added.

## Historical selected-Bid invariant

A candidate is accepted only when:

- Job Service matches;
- Job status is `CLOSED`;
- Job acceptance cycle is at least 1;
- `Job.selected_bid_id` references the joined Bid;
- Bid belongs to that Job and `Job.selected_handyman_id`;
- Bid status is `WON`;
- `proposed_price` is a positive integer VND value.

Bid has no acceptance-cycle column. Therefore the implementation can verify the
selected Bid for the final CLOSED cycle, not independently reconstruct every
historical cycle.

## Similarity

Historical data uses only normalized `Job.issue_description`.

Current tokens are disjoint:

- `K`: Gemini keywords;
- `S`: Gemini symptom tokens excluding `K`;
- `D`: current issue-description/problem-summary tokens excluding `K` and `S`.

Scores:

- 50% Dice similarity of `D` against historical text;
- 30% keyword coverage of `K`;
- 20% symptom coverage of `S`.

Empty components are removed and remaining weights are normalized. Historical
Jobs are never sent to Gemini and no nonexistent historical structured fields
are inferred.

## Estimator

- Integer VND and `BigInt`.
- Median typical value, nearest-rank P25/P75.
- IQR fence only with at least 8 samples.
- 0–2 samples: `INSUFFICIENT_DATA`.
- 3–5: `LOW`.
- 6+: `MEDIUM` only when IQR is no greater than the median.
- Directional 10,000 VND rounding with Job budget storage bounds.
- No `HIGH` confidence and no fallback price.

## Create Job integration

`ai_assistant_session_id` is optional in the existing multipart request.

When supplied, the existing Job transaction locks and validates the session,
creates Job/JobStatusHistory, inserts one immutable application-layer snapshot,
and marks the session `APPLIED_TO_JOB` before one commit.

Service mismatch returns `AI_SESSION_SERVICE_MISMATCH`; the Customer must omit
the session ID to continue manually. Reuse returns
`AI_SESSION_ALREADY_APPLIED`. Rejected create requests clean newly uploaded
images best-effort.

Participant Job reads select only safe snapshot columns. They never include the
AI session/messages or call Gemini/retrieval/estimator. Manual Jobs without a
snapshot retain their normal DTO.

## Schema and rollout

Additive tables:

- `AI_Assistant_Sessions`
- `AI_Assistant_Messages`
- `Job_AI_Price_Suggestions`

The schema verifier checks required columns and unique indexes. Snapshot
immutability is enforced by service boundaries and Sequelize hooks, not a
database trigger.

Rollout requires:

1. PostgreSQL backup.
2. Exactly one instance with `DB_SYNC_ALTER=true`.
3. Verify tables, FKs and indexes.
4. Disable alter.
5. Restart normally.

No seed or historical backfill is used.

## Commands and actual results

- AI/module and integration `node --check`: passed.
- V1 route import: passed.
- AI model association smoke: passed.
- Pure similarity/estimator smoke: passed.
- Read-only historical SQL smoke: passed against active Service `ELECTRICAL`;
  one canonical candidate was returned and no data was mutated.
- Gemini smoke: missing-config path passed with `AI_PROVIDER_NOT_CONFIGURED`;
  real provider call not run because `GEMINI_MODEL` is absent.
- Read-only schema inspection found none of the three new tables. Schema rollout
  was deliberately not applied because it requires a backup and explicit
  one-instance `DB_SYNC_ALTER=true` operation.
- Live session/Create Job API tests: not run because the additive schema has not
  been rolled out and no guarded Customer token was supplied.

## Known limitations

- Backend only; no AI/image UI.
- Historical Job complexity is unavailable.
- Session expiry does not delete message history.
- No message-retention job.
- Backend-generated client IDs cannot make two initial requests without a
  stable client UUID exactly idempotent.
- Rate-limit counters use the existing per-instance in-memory store.
- Small datasets legitimately return `LOW` or `INSUFFICIENT_DATA`.
