# Phase 5 manual test guide

Run only on a backed-up non-production database. The guarded script is read-only:

`ALLOW_MANUAL_PARTICIPANT_READ_TEST=true npm run participant:phase5:test:manual`

## Rollout

1. Record total/canonical/missing-cycle/missing-role/invalid-rating Review counts.
2. Back up PostgreSQL. Start one instance with `DB_SYNC_ALTER=true` and verify `Password_Action_Tokens`, the three additive Review columns and partial/supporting indexes.
3. Disable alter before starting any other instance. Re-run the guarded script and retain its output.

## Password matrix

- Submit existing-local, unknown, inactive, Admin and social-only emails to Forgot Password. Every response is the same; only an eligible local participant receives mail.
- Open a fragment action link. Confirm `replaceState` removes the token before the POST validate call and that Redux/local/session storage never contains it.
- Test random, expired, consumed, revoked, wrong-purpose and old-auth-version tokens.
- Test wrong/current Change Password and concurrent Set Password completion for a social-only participant.
- Force mail failure: the undelivered token is revoked best-effort and no token/link appears in logs.
- Preserve access/refresh/socket A, complete reset/change/set, retry A, then log in as B. A remains rejected; B succeeds.

## Profile, Overview and My Jobs

Regression-test login, refresh, Redux hydration, layouts, KYC gating/realtime, profile edit and Customer Create Job for both roles. `/identity/profile` must have canonical flat identity plus whitelisted groups; no GPS, Wallet/provider IDs, password data or KYC media URLs.

Test Overview with empty users and users having active/CLOSED Jobs and bids. Recent Jobs cap at five. For My Jobs exercise every role view, valid status/sort, page boundaries, reload/back navigation and Review state before/after submission.

## Review and Bayesian

- On a real CLOSED Job, test Customer to selected Handyman and selected Handyman to Customer.
- Reject outsider, bid-only Handyman, self, wrong role and non-CLOSED/CANCELLED Job.
- Backend derives cycle/roles. Two concurrent requests create one row; loser gets `JOB_REVIEW_ALREADY_SUBMITTED`.
- Review remains public/rated after reviewer deactivation. Legacy incomplete rows never appear.
- Check `JOB_REVIEW_SUBMITTED` contains only event ID, timestamp and Job ID.
- For each role test target counts 0, prior pool 0, 1–4, exactly 5 and above 5. Target Reviews are excluded from its prior; inactive-reviewer rows count; legacy/invalid rows do not.
- Compare Profile, Overview, Bid, Admin User and Job Detail: all summaries must match. No UI substitutes 5.0 or ranks with raw average when Bayesian is unavailable.

## Regression and cleanup

Smoke registration/email verification, password/social auth, Wallet/PayOS, both My Jobs pages, complete Job lifecycle, Chat/Socket and Admin Dashboard/KYC/Jobs/Users/Audit. Never adjust Wallet or financial Transaction data to prepare or clean up this test.
