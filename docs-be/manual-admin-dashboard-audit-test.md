# Manual Test — Admin Dashboard and Global Audit Viewer

## 1. Preconditions

- Non-production backend and frontend are running.
- Database schema from Phase 1–3 is available.
- An active Admin account exists.
- Use real disposable/non-production records; do not edit Wallet balances to prepare data.
- API base URL defaults to `http://localhost:5000/api/v1`.

The guarded read smoke can be run with an existing access token:

```powershell
$env:NODE_ENV='development'
$env:ENABLE_ADMIN_PHASE4_MANUAL_TEST='true'
$env:ADMIN_ACCESS_TOKEN='<active-admin-access-token>'
npm run admin:phase4:test:manual
```

Credential fallback accepts `ADMIN_EMAIL` and `ADMIN_PASSWORD`, but creates an immutable login Audit. The script never creates fixtures or mutates Job/Wallet/domain records.

## 2. Dashboard API

For each `7D`, `30D`, `90D`, `12M`, call `GET /admin/dashboard?period=<period>`.

Expected:

- HTTP 200, envelope code `ADMIN_DASHBOARD_RETRIEVED`.
- `Cache-Control: private, no-store`.
- Timezone is `Asia/Ho_Chi_Minh`; `7D/30D/90D` use day buckets and `12M` uses month buckets.
- Empty buckets are present with zero values.
- User metrics exclude Admin accounts.
- `pending_kyc` counts distinct non-legacy submissions.
- `pending_review_cases.total_cases` counts cases; `distinct_jobs_needing_review` counts Jobs and may differ.
- `all_time_status_distribution` and `created_in_period_current_status_distribution` remain separate.
- Platform fees include only successful `PLATFORM_SERVICE_FEE` Transactions whose destination is `SYSTEM_PROFIT` in VND.
- `PLATFORM_FEE_10` is not included.
- Global Warranty Reserve is `UNAVAILABLE/GLOBAL_RECONCILIATION_NOT_AVAILABLE`.
- No participant contact, GPS, Chat, media, Wallet ID or Transaction rows appear.

Negative tests:

- `period=1Y` returns HTTP 400 `VALIDATION_ERROR`.
- Customer/Handyman token is rejected.
- Inactive Admin is rejected by the canonical Admin middleware.
- Missing System Wallet makes that metric unavailable; it does not create a Wallet.
- A real database error must return HTTP 500 rather than a fabricated unavailable metric.

## 3. Dashboard UI

Open `/admin/dashboard?period=30D`.

- Change every period and refresh the browser; selected period remains in the URL.
- Confirm initial loading, background refreshing, error/retry and empty charts.
- Confirm every Action Queue count states its unit: submissions, cases, Jobs or participants.
- Open KYC, Jobs, Users, Wallets and Transactions links.
- Trigger several Admin Job/KYC/review socket signals quickly. Network panel should show a debounced Dashboard refresh, not one request per signal.
- Focus the window and verify a canonical refetch without polling.
- For a deliberately oversized money series, verify exact textual amounts remain visible and the chart uses its safe fallback.

## 4. Audit API

Call:

- `GET /admin/audit-logs?page=1&page_size=20`
- `GET /admin/audit-logs/filter-options`
- `GET /admin/audit-logs/:auditId`

Expected for every endpoint:

- Active Admin only.
- `Cache-Control: private, no-store`.
- List does not contain `before_state`, `after_state`, IP, user-agent, idempotency key or fingerprint.
- Detail contains only structured `previous_state` and `new_state` built by the sanitizer.
- Filter options include `OTHER`.
- An unknown action appears in list as `OTHER`, and detail is `SUMMARY_ONLY` with empty structured states.

Exercise list filters independently and together:

- Search by Audit UUID, action, Admin name/email, target UUID and correlation UUID.
- Category, action, Admin, target type/ID and correlation ID.
- Date range using Vietnam calendar dates.
- Newest/oldest sort and Previous/Next page.
- Invalid UUID/date/range and missing Audit ID.

Inspect responses recursively and confirm they do not contain password/token/cookie, Chat/media/GPS, Wallet ID or provider/webhook payload fields.

## 5. Audit UI

Open `/admin/audit` and a direct `/admin/audit/:auditId` deep link.

- Filter options are fetched once when the list page mounts, not after each filter/page change.
- Search is debounced; filters and page persist in the URL.
- Active chips remove one filter; Reset clears all filters.
- Back from a detail opened by the list restores the list query.
- F5 on detail loads independently.
- IDs truncate without breaking layout and copy buttons copy the complete value.
- Detail renders definition/transition sections, never a raw JSON dump.
- There are no edit/delete/restore/replay controls.

## 6. Responsive and accessibility

Test Dashboard, Audit list and Audit detail at:

- 1440×900
- 1366×768
- 1024×768
- 768×1024
- 390×844
- 320×800

Confirm no page-level horizontal overflow, charts remain inside containers, filters are usable, long IDs wrap/truncate safely, focus-visible is present, copy/open buttons have accessible names and status is not conveyed by color alone.

## 7. Regression and cleanup

- Smoke Admin KYC, Jobs, Users, Wallets, Transactions and Services navigation.
- Confirm sidebar/topbar queue badges still use `/admin/queue-counts`.
- Confirm participant lifecycle and Socket clients are unchanged.
- No financial/domain cleanup is required because Phase 4 tests are read-only. Credential fallback login Audit is immutable and intentionally retained.

