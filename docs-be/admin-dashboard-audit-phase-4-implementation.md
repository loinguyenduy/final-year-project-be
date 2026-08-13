# Phase 4 Implementation — Admin Dashboard and Global Audit Viewer

## 1. Gate checklist

- [x] Gate 1: canonical Dashboard backend aggregate, action queues, charts and activity.
- [x] Gate 2: real Dashboard UI, Recharts, URL period and debounced canonical refetch.
- [x] Gate 3: Audit list/options/detail with server filters and whitelist sanitization.
- [x] Gate 4: Audit routes, list/detail UI, URL filters and responsive states.
- [x] Gate 5: manual script/guide, context update and quality checks.

## 2. Dashboard implementation

`GET /api/v1/admin/dashboard` is the only Dashboard data endpoint. Independent database aggregates run concurrently. Recent Jobs, registrations and business Audits are individually bounded before merge; no large association graph is hydrated.

Period boundaries use Vietnam local calendar time and are returned as UTC instants. Day/month series are aggregated in PostgreSQL and zero-filled against the bounded expected bucket list.

Implemented metrics:

- Participant total/active/new counts.
- KYC, verification, Handyman level and paid bond counts.
- All/active/closed/cancelled/period Job counts.
- Separate pending case counts and distinct Jobs needing review.
- System Wallet balances, successful Transaction count and canonical platform fee revenue.
- Operational Action Queue and bounded Recent Activity.

Job distributions are deliberately separate:

- `all_time_status_distribution`: current status of all Jobs.
- `created_in_period_current_status_distribution`: current status of Jobs created in the selected period.

Platform fee revenue includes only `PLATFORM_SERVICE_FEE` with `SUCCESS`, destination `SYSTEM_PROFIT` and VND. `PLATFORM_FEE_10` remains a legacy enum/read label without a confirmed canonical writer and is excluded.

Global Warranty Reserve remains explicitly unavailable because there is no global cross-source reconciliation query. No metadata-only approximation or financial inconsistency queue was added.

## 3. Audit implementation

Public read-only APIs:

- `GET /api/v1/admin/audit-logs`
- `GET /api/v1/admin/audit-logs/filter-options`
- `GET /api/v1/admin/audit-logs/:auditId`

Categories are derived from action: Authentication, KYC, Job Review, User Management, Service Management and Other. Unknown actions are retained in the list, categorized as `OTHER`, and expose summary-only detail.

The presentation service constructs every DTO from an allowlist. It never copies a raw snapshot and removes keys afterward. Arrays and nested state use explicit schemas: KYC document types and known Job statuses with safe non-negative counts. List responses never include snapshots.

All Dashboard/Audit endpoints send `Cache-Control: private, no-store`. There are no Audit mutation routes.

## 4. Frontend implementation

Dashboard owns its Axios request and uses request identity plus AbortController. Socket singleton signals are received through the existing Admin custom events, coalesced within 450 ms and followed by REST refetch. Focus uses the same path; no polling was added.

Recharts 3.10.0 is the sole chart library and supports React 19. Money remains a string in API/state. Conversion to Number occurs only after BigInt validation against `Number.MAX_SAFE_INTEGER`; otherwise the chart renders a safe textual fallback.

Dashboard and both Audit pages are route-level lazy chunks, keeping Recharts out of the initial Admin/application route bundle until Dashboard is opened.

Audit filter options load once per list-page mount into local state. List filters/search/sort/page are URL-backed. Detail is deep-linkable and renders safe definition lists rather than serialized JSON.

## 5. Realtime/refetch matrix

| Signal | Dashboard | Audit Viewer |
|---|---|---|
| `ADMIN_KYC_QUEUE_UPDATED` | Debounced refetch | No action |
| `ADMIN_REVIEW_QUEUE_UPDATED` | Debounced refetch | No action |
| `ADMIN_JOB_UPDATED` | Debounced refetch | No action |
| Window focus | Debounced refetch | Manual refresh only |

## 6. Privacy and security controls

- Active Admin middleware on every endpoint.
- No GPS, Chat, media URL/public ID, Wallet ID, token/session/provider payload in DTOs.
- Recent activity permits a null actor and does not fabricate an Administrator.
- Financial amounts use VND integer parsing and decimal strings.
- Missing/invalid optional source creates a scoped availability result; real database/system errors remain HTTP 500.

## 7. Files and dependency changes

Backend adds Dashboard controller/service, Audit presentation logic, expanded Audit controller/service/routes, a guarded manual script and Phase 4 documentation. Queue queries are shared between the legacy badge endpoint and Dashboard.

Frontend adds Dashboard/Audit services, Dashboard/Audit pages and feature-local Sass, enables Audit navigation/routes and replaces the Dashboard placeholder. `recharts@3.10.0` and its lockfile entries are the only new visualization dependency.

No schema column, index, mutation endpoint, Socket event or second cache system was added.

## 8. Verification record

- Backend syntax/import smoke: passed for Phase 4 services/controllers/routes.
- Live database read smoke: Dashboard 7D, Audit list/options/detail and response privacy passed.
- Frontend lint: passed after resolving hook dependency warning.
- Frontend production build: passed; Vite reports the pre-existing/combined large-chunk optimization warning.
- Full final `node --check`, lint/build and `git diff --check`: recorded again at final delivery.
- Responsive browser screenshots: not captured in this execution because no Browser/Chrome control surface was available. Static responsive CSS review and production build passed; the six manual viewports remain explicitly listed in the manual guide.
- `npm install` reported 9 dependency audit findings (3 low, 6 high). No broad `npm audit fix` was applied because it could mutate unrelated dependency versions outside Phase 4.

## 9. Known limitations

- `PLATFORM_FEE_10` is excluded from platform revenue.
- Global Warranty Reserve and financial inconsistency counts are unavailable.
- Unknown Audit actions intentionally expose summary-only detail.
- Audit Viewer has no realtime, export or mutation controls.
- The project still has no automated unit/E2E framework; verification remains syntax/build/read-smoke/manual.
