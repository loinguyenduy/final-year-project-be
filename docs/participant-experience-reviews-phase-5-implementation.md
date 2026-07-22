# Phase 5 implementation traceability

## Six gates

1. Password: additive hashed action tokens, fragment-to-memory transport, POST-only validate/complete, LOCAL ownership and complete session invalidation.
2. Read models: bounded role Overview and normalized compatible `/identity/profile`.
3. My Jobs: server-side views/status/sort/page plus canonical needs-action and Review state.
4. Reviews: additive cycle/role metadata, shared canonical scope, transactional mutual eligibility/concurrency and Bayesian aggregation.
5. Frontend: password/security pages, real dashboards, CLOSED-Job Review panel and public profile/Review list.
6. Delivery: guarded read-only rollout script, manual matrix, context update and honest verification results.

## Password architecture

Only SHA-256 token hashes are persisted. Links carry the raw token in a frontend fragment; the page stores it in component memory and immediately removes it with `history.replaceState` before a POST body is sent. Tokens are single-use, default to 15 minutes, use a database-backed per-user/purpose resend cooldown and revoke prior outstanding tokens.

Reset/Set/Change lock canonical rows, update/create LOCAL credentials, increment `User.auth_version`, revoke RefreshToken and outstanding password-action tokens in one transaction. Sockets are disconnected after commit. Security email failure does not roll back a completed mutation; action-email failure revokes the undelivered token best-effort and logs safe identifiers only.

## Profile contract

Flat auth identity fields remain. Whitelisted groups are profile, saved addresses, services/areas/work times, Wallet summary, rating/job summary, password capability, provider names and KYC submission summaries. GPS, Wallet/provider IDs, password data and KYC media are excluded.

## Canonical Review and legacy safety

Canonical means: all party/Job IDs; integer cycle at least one; opposing participant roles; integer rating 1–5; reviewer differs from reviewee. `Rating.service` owns the shared condition for Profile, Overview, Bid/selection, participant Job and Admin consumers. Reviewer active state is deliberately not a predicate. Legacy rows are retained untouched and excluded safely.

## Bayesian

The design formula is `B=(vR+mC)/(v+m)`, default `m=5` with positive-integer ENV override. The role prior excludes all Reviews of the target. No target Reviews returns `NO_REVIEWS`; independent prior below five returns raw statistics but null Bayesian with `INSUFFICIENT_PRIOR_SAMPLE`; five or more returns `AVAILABLE`. BigInt ratio formatting yields decimal strings.

## APIs, limits and realtime

Password adds seven POST routes under `/auth`. Read models add role Overview and canonical Profile. Review endpoints are POST `/matchmaking/jobs/:jobId/reviews`, GET `/identity/users/:userId/public-profile` and GET `/identity/users/:userId/reviews`. Recent Overview Jobs cap at five; public Reviews default to ten and cap at fifty. `JOB_REVIEW_SUBMITTED` uses the existing post-commit gateway and contains no rating/comment/profile.

## Files changed

Backend created: `PasswordActionToken.model.js`, `password.constants.js`, `Password.controller.js`, `Password.service.js`, `ParticipantRead.service.js`, `Review.controller.js`, `Review.service.js`, `Rating.service.js`, the guarded participant script and both Phase 5 documents.

Backend modified: `package.json`; database setup; rate limiter and mail utility; Auth/Profile/SocialAuth services, controllers and routes; Review model; Admin User/Job read services; Matchmaking routes/controllers; Customer Job, Bid, Handyman Job, generic Job, accepted lifecycle and handyman-selection services; and the existing lifecycle realtime gateway.

Frontend created: Forgot/Reset/Set Password UI and styles, `PasswordSecurityPanel`, participant API service, Public Profile page/styles, real participant overview styles, `ReviewPanel`, and the Phase 5 visual checklist.

Frontend modified: app routes; identity auth service/reducer; Customer/Handyman Dashboard, Profile, My Jobs and Job Detail surfaces/services; bid comparison/public-profile UI; accepted lifecycle partner/stage/socket/realtime components and styles; Admin Job rating display. The unused mocked Customer dashboard component/styles were removed.

Root modified: `PROJECT_CONTEXT_AND_GUIDELINES.md`.

## Rollout and limitations

Use one-instance `DB_SYNC_ALTER`; do not backfill/delete legacy Reviews. SMTP and authenticated visual flows require prepared external state and are not claimed without execution. Bayesian is intentionally unavailable before five independent prior Reviews. Review edit/delete/moderation, polling, new cache/Socket systems and lifecycle/financial mutations remain out of scope.

## Verification results (2026-07-23)

- Backend `node --check`: passed for all 31 changed/new JavaScript files.
- Backend Identity/Matchmaking route import smoke: passed.
- Guarded read-only rollout script: passed; current database has 0 Review rows and has not yet received the additive Phase 5 schema. Authenticated endpoint smoke was skipped because no participant access token was supplied.
- Frontend `npm run lint`: passed without errors.
- Frontend `npm run build`: passed (967 modules); Vite reported the pre-existing large main-chunk advisory.
- Backend and frontend `git diff --check`: passed; only Git line-ending conversion warnings were emitted.
- SMTP delivery, password mutation/session matrix, concurrent Review mutation, prepared lifecycle regression and six authenticated breakpoint screenshots were not executed because their required external/prepared state was not available. They remain explicit manual rollout gates and are not reported as passed.
