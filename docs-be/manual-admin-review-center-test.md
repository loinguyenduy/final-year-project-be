# Admin Review Center — manual test and rollout guide

## Safety and preconditions

- Use a backed-up development database and development Cloudinary account. Never run the mutation script in production.
- Run schema rollout on exactly one backend instance with `DB_SYNC_ALTER=true`, verify startup, then disable it before scaling.
- Do not backfill legacy cancellations whose `status` is `NULL`; they intentionally remain outside Pending and Resolved Review Center results.
- Prepare financial cases through the existing participant lifecycle APIs. Do not insert Wallet balances or settlement Transactions manually.
- Required actors: one active Admin, one Customer and one selected Handyman. Credentials are supplied only through environment variables.

## Schema rollout verification

After the one-instance additive sync, startup verifies:

- `Admin_Audit_Logs.idempotency_key`, `request_fingerprint` and scoped partial unique index;
- `Job_Warranties.warranty_refunded_amount`, `refunded_at`, `refund_transaction_id` and partial unique index;
- `Warranty_Claims.resolved_by_admin_id`;
- actionable queue indexes for Claim, Rework and Cancellation;
- `WARRANTY_REFUND` plus legacy `PLATFORM_FEE_10`, `WARRANTY_HOLD_20`, `DISBURSE_80` transaction enum labels.

Rollback redeploys the prior application while retaining additive columns, indexes and audit rows. Do not drop enum labels or financial history during emergency rollback.

## Canonical state/action matrix

| Case | Source state | Admin action | Canonical result |
|---|---|---|---|
| Claim | Claim `PENDING_REVIEW`, Warranty `CLAIM_PENDING`, Job `WARRANTY` | `APPROVE_REWORK` | Claim `APPROVED_REWORK_REQUIRED`, Warranty `REWORK_REQUIRED`; initial review metadata set; reserve held |
| Claim before expiry | same | `REJECT_CLAIM` | Claim `REJECTED` with terminal resolution metadata, Warranty `ACTIVE`, Job `WARRANTY`; reserve held and Customer may submit a new valid Claim |
| Claim after expiry | same | `REJECT_CLAIM` | Claim `REJECTED`, Warranty/Contract `COMPLETED`, Job `CLOSED`; full remaining reserve released to Handyman; Chat history-only |
| Rework cycle 1 rejected | latest Request sequence 1 `REJECTED`, Claim/Warranty `REVIEW_REQUIRED` | `ALLOW_ANOTHER_REWORK` | Claim `APPROVED_REWORK_REQUIRED`, Warranty `REWORK_REQUIRED`; sequence 2 may be created |
| Rework cycle 2 rejected | latest Request sequence 2 `REJECTED` | allow another | forbidden with `REWORK_CYCLE_LIMIT_REACHED` |
| Rework review | actionable sequence 1 or 2 | `RELEASE_WARRANTY_RESERVE` | full remaining reserve to `HANDYMAN_MAIN`; Claim resolved, Warranty/Contract completed, Job closed, Chat history-only |
| Rework review | actionable sequence 1 or 2 | `REFUND_WARRANTY_RESERVE` | full remaining reserve to `CUSTOMER_MAIN`; Claim resolved, Warranty/Contract completed, Job closed, Chat history-only |
| Cancellation | status `REVIEW_REQUIRED`, Job `CANCELLATION_REVIEW` | one of three fault actions | server derives distribution from `status_when_cancelled`; Cancellation resolved, Job cancelled, lifecycle artifacts superseded/cancelled, Chat history-only |

`reviewed_by_admin_id/reviewed_at` represent the first Claim review. `resolved_by_admin_id/resolved_at` are set only by an Admin action that makes the Claim terminal. Rework approval does not overwrite either initial review field.

## Financial matrix

All amounts are calculated server-side with integer/BigInt arithmetic. The frontend never sends amount or percentage.

| Source phase | Classification | Customer | Handyman | Platform |
|---|---:|---:|---:|---:|
| EN_ROUTE | CUSTOMER_FAULT | 50% | 50% | 0% |
| EN_ROUTE | HANDYMAN_FAULT | 100% | 0% | 0% |
| EN_ROUTE | NEUTRAL | 100% | 0% | 0% |
| ARRIVED / QUOTE_PENDING / PAYMENT_PENDING | CUSTOMER_FAULT | 30% | 70% | 0% |
| ARRIVED / QUOTE_PENDING / PAYMENT_PENDING | HANDYMAN_FAULT | 100% | 0% | 0% |
| ARRIVED / QUOTE_PENDING / PAYMENT_PENDING | NEUTRAL | 50% | 50% | 0% |

Warranty settlement reconciles accepted Contract totals, calculated 15% snapshot, the one successful `WARRANTY_RESERVE_HOLD`, Warranty metadata and all successful release/refund Transactions. Any mismatch returns `FINANCIAL_DATA_INCONSISTENT`; Admin mutation never repairs it.

## API checks

1. `GET /api/v1/admin/queue-counts`: verify KYC and all three Review counts plus total.
2. `GET /api/v1/admin/reviews`: test `status`, `case_type`, bounded `search`, `date_from`, `date_to`, `sort`, `page_size` and opaque `cursor`.
3. Reuse a cursor with a changed filter and expect `400 VALIDATION_ERROR`.
4. Verify one row per `case_type + case_id` in Resolved results and the latest relevant Audit timestamp/action.
5. `GET /admin/reviews/:caseType/:caseId`: verify masked address, no raw GPS, metadata-only Evidence and canonical allowed actions.
6. Open one Evidence item through its access endpoint; verify `Cache-Control: no-store` and a security log without URL/content.
7. Read Chat pages; verify no read cursor changes, no room join, no send API and a content-free security log.
8. Decision request requires action-specific `reason_code`, UUID `idempotency_key`, and text under the approved rules. Test whitespace, HTML/control characters and 501 characters.
9. Same scoped key and fingerprint returns `ADMIN_DECISION_REPLAYED`; same key/different payload returns `409 IDEMPOTENCY_CONFLICT`; a new key after mutation returns `409 SOURCE_STATE_CHANGED`.
10. Fire two concurrent different-key decisions. Exactly one commits, one returns 409 and only one business Audit exists.

## Warranty and cron races

- Submit a Claim immediately before `ends_at`, then race expired-Warranty cron with Admin rejection. Verify exactly one `WARRANTY_RELEASE`, one terminal state and no partial mutation.
- Force an inconsistent hold amount or metadata only in a disposable DB and verify release/refund fails without Wallet or domain updates.
- Reject before expiry and submit a new Claim through the normal Customer API with new Evidence.
- Complete cycle 1 and reject it, allow cycle 2, then reject cycle 2. Verify no third cycle action/API creation is possible.

## Cancellation regression

For all 12 phase/classification combinations, verify Customer + Handyman + Platform equals the held deposit, platform is zero, Transactions reference the original deposit, and participant auto-resolution produces the same ledger structure as Admin resolution. Race a late payment callback with an Admin decision; row locks and source validation must permit only one canonical outcome.

## UI, realtime and accessibility

Test 1440×900, 1024×768, 768×1024, 390×844 and 320×800. Check sidebar badge, topbar menu, queue Load more, filter reset, detail tabs, sticky actions, modal focus trap/Escape/focus restore, Evidence lightbox and no horizontal page overflow. Participant and Admin events carry signal IDs only; reconnect and focus refetch canonical state.

## Guarded script

Run the pure cancellation matrix check:

```powershell
npm run admin:review:test:manual
```

Add Admin credentials for read-only API checks. For a mutation, additionally set `ADMIN_REVIEW_TEST_ALLOW_DB_MUTATION=true` and all case/decision/reason environment variables documented by the script. The script deliberately refuses to construct financial fixtures or edit Wallet balances. It performs no cleanup because committed Audit and settlement history are immutable; use a disposable fixture database.
