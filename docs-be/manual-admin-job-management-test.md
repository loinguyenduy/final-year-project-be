# Manual Test Guide — Admin Job Management Phase 2

## 1. Preconditions and safety

- Use a development or disposable staging database. Do not run financial decisions against production data.
- Prepare Jobs through canonical services for pre-acceptance, accepted, in-progress, warranty, closed, cancelled and cancellation-review states.
- Never edit Wallet balances to manufacture a fixture.
- Apply additive indexes only after backup: run one instance with `DB_SYNC_ALTER=true`, verify, then disable the flag.
- Record `X-Correlation-ID` for every sensitive read and Admin decision.

## 2. Authentication and authorization

| Test | Steps | Expected |
|---|---|---|
| Active Admin | Login at `/admin/login`, open `/admin/jobs` | List renders; API returns `ADMIN_JOBS_RETRIEVED`. |
| Unauthenticated | Remove access token and request `/api/v1/admin/jobs` | 401 canonical Admin auth error. |
| Wrong role | Use Customer/Handyman access token | 403 `ADMIN_ROLE_REQUIRED`; no Job data. |
| Inactive Admin | Deactivate an authenticated Admin, call detail again | 403 `ADMIN_NOT_ACTIVE`; frontend clears session. |
| Deep link | Reload `/admin/jobs/:jobId?section=finance&cycle=1` | Session gate completes before content; section/cycle is preserved. |

## 3. Job List

Call `GET /api/v1/admin/jobs` and verify:

1. Defaults: `page=1`, `page_size=20`, `status=ALL`, `sort=CREATED_DESC`.
2. Search separately by Job ID, issue, Service, participant name/email/phone.
3. Test every status and sort option.
4. Test Service, date range, selected-Handyman, participant ID/role and acceptance cycle.
5. Test `needs_review=true` with each `review_type`; compare to canonical case states and queue count.
6. Test `needs_review=false`; reject `needs_review=false&review_type=WARRANTY_CLAIM`.
7. Verify stable ID ordering when timestamps tie.
8. Confirm no GPS, Wallet ID, Chat, Transaction or media URL in list items.
9. Confirm Bid/current Contract/Warranty/Cancellation hydration does not query once per Job.

## 4. Aggregate Job Detail

- Initial load calls `GET /admin/jobs/:jobId` once; child sections must not repeat it.
- Derived title is Service plus normalized/truncated issue description; no title is persisted.
- Participant contact, KYC, saved addresses and Wallet summary render correctly.
- Saved addresses contain no `gps_lat/gps_long`.
- Wallet summary contains only `wallet_type`, `currency`, `available_balance`, `status`.
- Job/en-route/arrival GPS appears only in Location.
- Aggregate contains no `media_url`, `pdf_url`, Chat messages or Transaction rows.
- Current/historical cycles are correctly marked and grouped.
- Collection caps expose correct `total_count`, `has_more` and cursor/page behavior.

Timeline assignment:

| Source | Expected value |
|---|---|
| Persisted `acceptance_cycle` | `CANONICAL` |
| JobStatusHistory after an `ACCEPTED` boundary | `INFERRED_FROM_ACCEPTED_BOUNDARY` |
| Pre-acceptance/non-cycle event | `JOB_LEVEL` |

No timeline event may repeat raw GPS. Dedupe keys must remain stable after refetch.

## 5. Overflow and sensitive reads

| Endpoint | Test | Expected |
|---|---|---|
| `/bids` | Page past 100 | Stable order; selected Bid marked. |
| `/cycles` and `/cycles/:cycle` | Historical cycle | Correct resources/current marker. |
| `/evidence` | Load more | Metadata only; bound cursor. |
| `/timeline` | Load earlier | No duplicate; wrong-filter cursor rejected. |
| `/audits` | Load older | Related Job cases only; safe snapshot. |
| `/chat` | Cycle/load earlier | No mark-read, join or send. |
| `/transactions` | Filter cycle/type/status | No Wallet ID; Contract ID derived or null. |
| Evidence access | Open item | URL on demand; log excludes URL. |
| Job image access | Open opaque key | Key revalidated against current `Job.images`. |

Every Admin Job read response must include `Cache-Control: private, no-store`.

## 6. Finance diagnostic

| Fixture | Expected |
|---|---|
| No applicable financial lifecycle | `NOT_APPLICABLE` |
| Missing legacy source without contradiction | `PARTIAL_LEGACY` |
| Contract/Warranty/ledger agree | `CONSISTENT` |
| Amount/reference/snapshot conflicts | `INCONSISTENT` |

Verify Wallet, Transaction, Contract and Warranty remain unchanged after every diagnostic read.

## 7. Admin Review parity

Use `allowed_actions` and `decision_requirements` from Job Detail; the frontend must not own a duplicate reason table.

- Claim approve/reject, including post-expiry rejection messaging.
- Rework cycle 1 and 2; no third cycle.
- Full Warranty release/refund.
- Cancellation four phases × three classifications; platform receives 0%.
- Same key/payload replays without another mutation/Audit.
- Same key/different payload conflicts.
- Concurrent requests produce one mutation.
- Inconsistent finance returns `FINANCIAL_DATA_INCONSISTENT` and changes nothing.
- Success/stale/replay refetches detail and queue count.

Existing guarded test command:

```powershell
npm run admin:review:test:manual
```

Mutation stays disabled unless a disposable case and every `ADMIN_REVIEW_TEST_*` variable plus `ADMIN_REVIEW_TEST_ALLOW_DB_MUTATION=true` are supplied.

## 8. Realtime and compatibility

1. Important lifecycle mutations emit one `ADMIN_JOB_UPDATED` per business transaction.
2. Multiple participant signals reuse the Admin dedupe identity/event ID.
3. Media/Chat/Transaction/diagnostic reads emit nothing.
4. List refetches when mounted; detail refetches only for its Job.
5. Focus/reconnect refetch; unmount/logout removes listeners.
6. `/admin/reviews` redirects to review-filtered Jobs.
7. `/admin/reviews/:caseType/:caseId` resolves Job once then redirects.

## 9. Responsive and accessibility

Capture 1440×900, 1366×768, 1024×768, 768×1024, 390×844 and 320×800.

- No horizontal page overflow at 320px.
- Sidebar, section navigation, cards/tables and modal remain usable.
- Modal traps focus, blocks Escape while submitting and restores focus.
- Icon buttons have labels and keyboard focus is visible.
- Workspace has clear hierarchy and no raw JSON/repeated field boxes.

Captured artifacts and measured result:

| Viewport | Artifact | Horizontal page overflow |
|---|---|---|
| 1440x900 | `final-year-project-fe/docs/visual-regression/admin-job-detail-1440x900.png` | No |
| 1366x768 | `final-year-project-fe/docs/visual-regression/admin-job-detail-1366x768.png` | No |
| 1024x768 | `final-year-project-fe/docs/visual-regression/admin-job-detail-1024x768.png` | No; section rail scrolls internally by design |
| 768x1024 | `final-year-project-fe/docs/visual-regression/admin-job-detail-768x1024.png` | No |
| 390x844 | `final-year-project-fe/docs/visual-regression/admin-job-detail-390x844.png` | No |
| 320x800 | `final-year-project-fe/docs/visual-regression/admin-job-detail-320x800.png` | No |

The List desktop reference is `final-year-project-fe/docs/visual-regression/admin-jobs-list-1440x900.png`. The dedicated authorized Location reference is `final-year-project-fe/docs/visual-regression/admin-job-location-1440x900.png`. Sensitive values and map details are blurred in documentation screenshots; this does not change application rendering.

## 10. Cleanup

- Read tests require no cleanup.
- Decisions and ledger are immutable; do not automatically clean them up.
- Use a disposable database for mutations.
- On failure record correlation ID, HTTP code, DB state, Audit count and Socket signals before retrying.
