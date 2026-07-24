# Manual Test — AI Job Assistant Backend

## Preconditions

1. Back up PostgreSQL.
2. Run one instance with `DB_SYNC_ALTER=true`, verify the three AI tables and
   seven required indexes, then disable alter.
3. Prepare an active, KYC-verified Customer access token.
4. For a real Gemini test, configure both `GEMINI_API_KEY` and `GEMINI_MODEL`.
5. Do not create fake Job, Bid, Contract, Wallet or Transaction rows.

## Commands

```bash
npm run ai:gemini:smoke
npm run ai:assistant:test:manual
```

The manual script always runs pure similarity/estimator checks. API mutation
requires:

```text
AI_TEST_CUSTOMER_TOKEN=...
AI_TEST_ALLOW_SESSION_MUTATION=true
AI_TEST_MESSAGES_JSON=["The kitchen sink leaks while the tap is running."]
```

Disposable Job creation additionally requires:

```text
AI_TEST_ALLOW_DISPOSABLE_JOB=true
AI_TEST_JOB_PAYLOAD_JSON={"service_id":"...","issue_description":"...","scheduled_at":"...","address_option":"1","province_code":"...","ward_code":"...","detail_address":"..."}
```

This calls the canonical Create Job endpoint. Cleanup uses the canonical
pre-acceptance cancellation endpoint; never delete or edit financial rows.

## Provider tests

- Missing key/model returns 503 `AI_PROVIDER_NOT_CONFIGURED`; server stays up.
- Invalid model returns safe provider error without raw SDK details.
- Timeout returns `AI_PROVIDER_TIMEOUT`.
- Quota returns `AI_PROVIDER_RATE_LIMITED`.
- Invalid structured output retries once, then `AI_RESPONSE_INVALID`.
- Inspect logs: no key, prompt, Customer message or raw response.

## Language consistency and marketplace wording

Run separate disposable sessions for:

- Vietnamese first meaningful message;
- English first meaningful message;
- ambiguous/mixed message;
- VI session followed by English technical terms without a switch request;
- explicit “continue in English” and “tiếp tục bằng tiếng Việt”;
- provider retry after a failed message.

Expected:

- DTO exposes only `conversation_language=VI|EN`;
- ambiguous first text defaults to VI;
- ordinary mixed-language text does not change a locked language;
- explicit switch changes the canonical language and all later Assistant/UI
  copy follows it;
- failed provider calls do not lose the language selected when the Customer
  message was reserved;
- no response says the platform assigned/will send a technician or states a
  definite diagnosis;
- wording remains uncertain and explains that Handymen may submit Bids only
  after the Customer posts the Job.

## Authorization and session

- Customer succeeds; Handyman/Admin/inactive participant is denied.
- Cross-Customer session ID returns 404.
- Fourth active session returns `AI_ACTIVE_SESSION_LIMIT_REACHED`.
- Expired session can be read as `EXPIRED` but cannot mutate.
- Abandon is safe and terminal.

## Message concurrency/idempotency

- Send with stable UUID and current revision.
- Replay same UUID/text after success: no provider call or new row.
- Retry same UUID/text after provider failure: same Customer row, no second
  logical turn.
- Same UUID with different text: 409 conflict.
- Two different simultaneous messages: only one reserves; the other gets busy
  or revision conflict.
- Abandon while provider runs: provider result is marked stale and not committed.
- Verify current message appears only once in provider request construction.

## Historical retrieval

Using prepared real data, verify:

- Same Service CLOSED selected/won Bid is included.
- Other Service, CANCELLED Job, missing selected Bid, losing/withdrawn Bid,
  wrong Handyman and fractional/invalid amount are excluded.
- Candidate query is capped.
- No historical Job ID/description appears in API payload or logs.
- No Gemini call occurs per historical Job.

## Similarity and estimator

- Keywords, symptoms and description token sets are disjoint.
- Historical side uses only `issue_description`.
- Empty score components renormalize remaining weights.
- 0–2 samples return null range.
- 3–5 return LOW.
- 6+ return MEDIUM only for acceptable IQR.
- Test odd/even median, P25/P75, repeated amounts, outlier fence and 10,000 VND
  rounding.
- Repeated input produces the same range.

## Price decisions

- A complete provider result first exposes `stage=REVIEW_DIAGNOSIS`,
  `diagnosis_review.confirmation_status=PENDING` and no `latest_estimate`.
- `CONFIRM_DIAGNOSIS` changes the session to `ESTIMATE_PRESENTED` and is the
  first point where historical retrieval/estimation may run.
- `CORRECT_DIAGNOSIS` returns the session to `ACTIVE/CLARIFYING`, clears stale
  estimate/budget, keeps the composer available and accepts another message.
- Typing directly while review is pending is treated as a correction; it must
  not return a premature “draft locked” state.
- Concurrent confirmations produce one canonical transition; the stale request
  receives a revision/state conflict.
- Accept valid range.
- Reject accept when estimate is insufficient.
- Recalculate with current revision and stable client UUID.
- Enforce recalculation/turn limits.
- Accept valid own integer budget; reject zero, fractional, overflow and max<min.
- Continue without estimate produces no invented amount.
- Repeated same terminal decision replays; different terminal decision conflicts.

The guarded manual script confirms diagnosis automatically when it reaches
`REVIEW_DIAGNOSIS`, then continues with the configured price decision.

## Create Job and DTO

- Manual request without AI session is unchanged and creates no snapshot.
- AI-assisted request creates Job, history, one snapshot and APPLIED session in
  one transaction.
- Wrong owner, expired/not-ready session and Service mismatch create no Job.
- Reusing a session creates no second Job or snapshot.
- Force snapshot insert failure and verify Job/history rollback.
- Confirm uploaded assets are cleaned after rejected AI integration.
- Customer/Handyman POSTED/BIDDING DTO contains only safe guidance.
- Manual Job has no AI field and renders normally.
- Later lifecycle statuses do not expose guidance.
- Handyman Bid below/inside/above guidance still follows the existing validator.

## Privacy scan

Recursively reject any AI Job DTO containing:

- AI messages or session structured state;
- prompts, provider response/token usage;
- historical Job IDs/descriptions;
- address/GPS/contact/Wallet/payment data introduced by the AI module.

## Regression

- Service catalog.
- Manual Job create with and without images.
- Location/GPS validation.
- Customer My Jobs and Job Detail.
- Handyman available list/detail.
- Bid submit/update/withdraw.
- Accept/deposit and later lifecycle flows.

Record every unexecuted test as not run; do not infer a pass.
