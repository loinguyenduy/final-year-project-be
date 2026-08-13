# Admin Job Management Phase 2 — Implementation and Traceability

## 1. Delivery checklist

| Gate | Capability | Technique | Result |
|---|---|---|---|
| 1 | Job List, filters/search/sort, derived title, review flags | Database filtering and page-first batch hydration | Implemented; DB read smoke passed |
| 2 | Aggregate workspace, capped collections, lazy sensitive reads | Whitelisted DTO, bound cursor, on-demand URL | Implemented; service smoke/build passed |
| 3 | Review actions inside Job Detail | Existing canonical mutations plus backend requirements | Implemented; mutation services unchanged |
| 4 | Legacy Review replacement and Job realtime | Compatibility redirect and gateway dedupe | Implemented; signal smoke passed |
| 5 | Responsive/accessibility, docs and regression | New Sass workspace, shared accessible modal | Implemented; six required detail breakpoints inspected and captured |

## 2. Function and technique matrix

| Function | Implementation | Controls |
|---|---|---|
| Job List | `GET /admin/jobs`, URL filters, numbered pages | PostgreSQL search; no sensitive detail; no list N+1 |
| Derived title | Service + normalized 80-character issue summary | No title schema |
| Job Detail | One owner aggregate request | Child receives props; bounded collections |
| Location | Dedicated authorized section with Job/en-route/arrival snapshots | Raw GPS never renders in Overview, Timeline or Audit |
| Cycles | Index, recent bundles and lazy cycle detail | Current marker; persisted cycle grouping |
| Timeline | Normalized heterogeneous events | Stable key; explicit assignment; no raw GPS |
| Participants | Contact, saved addresses, Wallet summary | No address GPS, Wallet ID or history |
| Bids | First 100 plus pages | Stable `createdAt,id`; selected marker |
| Evidence/images | Metadata/opaque key plus access-on-click | URL not persisted/logged/emitted |
| Chat | Cycle-scoped cursor | No room join, send or mark-read |
| Transactions | Lazy filter/cursor | Party summary; no Wallet ID; nullable Contract ID |
| Finance | Read-only Quote/Contract/Completion/Warranty/ledger reconciliation using BigInt | Reports only; no repair/mutation |
| Admin Review | Existing endpoints from Job Detail | Backend owns actions/reasons/idempotency requirements |
| Realtime | Central `ADMIN_JOB_UPDATED` | Post-commit; one Admin signal per transaction identity |
| Legacy links | One compatibility resolution call | New UI never renders legacy Review Center |

## 3. Final API contracts

All responses retain `{ EM, EC, code, DT }`. Admin Job reads set `Cache-Control: private, no-store`.

### List and aggregate

- `GET /admin/jobs`
- `GET /admin/jobs/:jobId`

List supports `page`, `page_size`, `search`, `status`, `service_id`, `created_from`, `created_to`, `has_selected_handyman`, `needs_review`, `review_type`, `participant_user_id`, `participant_role`, `acceptance_cycle`, `sort`.

### Overflow and lazy reads

- `GET /admin/jobs/:jobId/bids`
- `GET /admin/jobs/:jobId/cycles`
- `GET /admin/jobs/:jobId/cycles/:acceptanceCycle`
- `GET /admin/jobs/:jobId/evidence`
- `GET /admin/jobs/:jobId/timeline`
- `GET /admin/jobs/:jobId/audits`
- `GET /admin/jobs/:jobId/chat`
- `GET /admin/jobs/:jobId/transactions`
- `GET /admin/jobs/:jobId/evidence/:evidenceId/access`
- `GET /admin/jobs/:jobId/images/:imageKey/access`

### Canonical mutations retained

- `POST /admin/reviews/warranty-claims/:claimId/decision`
- `POST /admin/reviews/warranty-reworks/:requestId/decision`
- `POST /admin/reviews/cancellations/:cancellationId/decision`

## 4. Limits, timeline and finance

| Collection | Aggregate | Overflow |
|---|---:|---|
| Bids | 100 | Page, max 100 |
| Cycle index | 50 | Cursor, max 50 |
| Embedded cycles | 20 | Cycle detail |
| Evidence | 100/cycle | Cursor, max 100 |
| Timeline | Latest 200 | Cursor, max 100 |
| Admin decisions | Latest 100 | Cursor, max 100 |
| Chat | Excluded | Cursor, 30 default/100 max |
| Transactions | Excluded | Cursor, 50 default/100 max |

Cursor fingerprints bind Job and relevant filters.

Timeline values:

- `CANONICAL`: source persists cycle.
- `INFERRED_FROM_ACCEPTED_BOUNDARY`: legacy status history partitioned by ordered `ACCEPTED` boundaries.
- `JOB_LEVEL`: pre-acceptance or non-cycle history.

Finance values:

- `NOT_APPLICABLE`: no applicable sources.
- `PARTIAL_LEGACY`: source missing without direct contradiction.
- `CONSISTENT`: accepted Quote, Contract split, confirmed Completion, Warranty snapshot and successful ledger agree.
- `INCONSISTENT`: direct amount/reference/snapshot conflict, duplicate/dual final settlement or metadata/timestamp mismatch.

Diagnostic execution never repairs data.

## 5. Review and realtime matrices

| Case | Source state | Actions |
|---|---|---|
| Warranty Claim | Claim pending, Warranty claim-pending, current Job Warranty | Approve rework; reject claim |
| Rework cycle 1 | Latest rejected request, Claim/Warranty review-required | Another rework; full release; full refund |
| Rework cycle 2 | Same canonical source | Full release/refund; no third cycle |
| Cancellation | Review-required case, Job cancellation-review | Customer fault; Handyman fault; neutral |

Reason requirements come from backend constants. Existing row locks, idempotency, BigInt settlement, immutable Audit and rollback are unchanged.

| Source | Admin signal | Queue signal |
|---|---|---|
| Lifecycle/Bid/Quote/Payment/Completion/Warranty/Cancellation gateway | `ADMIN_JOB_UPDATED` | Existing specialized signal |
| Claim/Rework Admin decision | `ADMIN_JOB_UPDATED` | `ADMIN_REVIEW_QUEUE_UPDATED` |
| Cancellation Admin decision | Lifecycle gateway emits Job signal once | `ADMIN_REVIEW_QUEUE_UPDATED` |
| Read-only operations | None | None |

Signal payload contains only `event_id`, `occurred_at`, `resource.job_id`.

## 6. Schema, files and security

Additive indexes:

- `jobs_status_created_id`
- `jobs_service_created_id`
- `jobs_created_id`
- `bids_job_created_id`
- `job_status_history_job_created_id`
- `evidence_vaults_job_cycle_uploaded_id`
- `transactions_job_created_id`

No columns/enums/data were migrated. Local inspection found these indexes absent before rollout. Apply them on one backed-up instance with `DB_SYNC_ALTER=true`; startup verification refuses missing indexes.

Backend changes:

- Created `src/modules/admin/constants/adminJob.constants.js`.
- Created `src/modules/admin/controllers/AdminJob.controller.js`.
- Created `src/modules/admin/services/AdminJob.service.js`.
- Modified `src/modules/admin/routes/Admin.routes.js`.
- Modified `src/modules/admin/services/AdminReviewRealtime.service.js`.
- Modified `src/modules/admin/services/AdminSecurityReadLog.service.js`.
- Modified `src/modules/admin/services/AdminWarrantyReview.service.js`.
- Modified `src/core/database/setup.js`.
- Modified `src/modules/matchmaking/models/Job.model.js`.
- Modified `src/modules/matchmaking/models/Bid.model.js`.
- Modified `src/modules/matchmaking/models/JobStatusHistory.model.js`.
- Modified `src/modules/fintech/models/EvidenceVault.model.js`.
- Modified `src/modules/fintech/models/Transaction.model.js`.
- Modified `src/modules/matchmaking/sockets/JobLifecycle.gateway.js`.
- Created this traceability document and `docs/manual-admin-job-management-test.md`.

Frontend changes:

- Created `src/modules/admin/services/adminJobService.js`.
- Created `src/modules/admin/features/jobs/pages/AdminJobsPage.jsx`.
- Created `src/modules/admin/features/jobs/pages/AdminJobDetailPage.jsx`.
- Created `src/modules/admin/features/jobs/pages/AdminJobs.scss`.
- Created `src/modules/admin/features/jobs/pages/LegacyReviewRedirect.jsx`.
- Created `src/modules/admin/features/jobs/components/AdminJobDecisionModal.jsx`.
- Modified `src/App.jsx`, `src/modules/admin/layouts/AdminLayout.jsx`, `src/modules/admin/hooks/useAdminRealtime.js` and `src/modules/admin/services/adminReviewService.js`.
- Modified `src/modules/matchmaking/components/LocationPickerMap.jsx` to support an accessible read-only map.
- Removed `src/modules/admin/features/reviews/pages/AdminReviewCenterPage.jsx`.
- Removed `src/modules/admin/features/reviews/pages/AdminReviewCenterPage.scss`.
- Removed `src/modules/admin/features/reviews/pages/AdminReviewCasePage.jsx`.
- Removed `src/modules/admin/features/reviews/pages/AdminReviewCasePage.scss`.
- Removed `src/modules/admin/features/reviews/components/AdminReviewDecisionModal.jsx`.
- Added eight Phase 2 screenshots under `docs/visual-regression/`.
- Updated root `PROJECT_CONTEXT_AND_GUIDELINES.md` with the canonical Admin Job architecture.

Security:

- Every endpoint uses active-Admin middleware.
- Sensitive logs exclude content, URL, GPS, amount, Wallet ID and token.
- Aggregate excludes media/PDF URL, Chat messages and Transaction rows.
- Saved-address GPS and internal Wallet metadata are omitted.
- Frontend does not persist Job/Chat/Transaction/media state.

## 7. Verification and test mapping

Completed locally:

- Backend syntax check for 14 changed/created JavaScript files: passed.
- Admin route module import: passed.
- Read-only Job List smoke: passed against 29 Jobs.
- Aggregate Job Detail smoke: passed.
- Bids/cycles/Evidence/Timeline/Audit/Chat/Transaction smoke: passed.
- Aggregate privacy check: passed for media/PDF URL, Wallet ID, saved GPS, messages and Transaction rows.
- Pending Review smoke: correct Claim actions and backend requirements.
- Real Warranty finance smoke: Quote/Contract/Completion/Warranty/hold ledger reconciled to `CONSISTENT` with BigInt amounts.
- Gateway dedupe smoke: two participant events, one Admin signal, one shared event ID.
- Legacy Review bookmark smoke: one compatibility read, redirect bound to Job/cycle/case, targeted case highlighted.
- Existing cancellation policy matrix: passed; guarded API/mutation checks correctly skipped without disposable credentials/fixture.
- Frontend ESLint: passed.
- Frontend production build: passed; existing large-chunk warning remains.
- Visual inspection: passed at 1440x900, 1366x768, 1024x768, 768x1024, 390x844 and 320x800.
- Horizontal page-overflow measurement: false at all six breakpoints after the 1024px compact-workspace adjustment.

Visual artifacts:

- `final-year-project-fe/docs/visual-regression/admin-jobs-list-1440x900.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-1440x900.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-1366x768.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-1024x768.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-768x1024.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-390x844.png`
- `final-year-project-fe/docs/visual-regression/admin-job-detail-320x800.png`
- `final-year-project-fe/docs/visual-regression/admin-job-location-1440x900.png`

Sensitive local identifiers, participant/address fields, coordinates and map details were visually blurred for documentation capture. The 1024px inspection found and fixed a real content overflow by switching the inner workspace to the compact horizontal section rail at widths up to 1099px. A separate Location capture verifies that raw Job/en-route/arrival coordinates remain in their authorized section rather than Overview or Timeline.

Environment-dependent checks not automatically claimed:

- Financial/Admin mutation matrix: requires an authorized disposable fixture.
- Database index rollout: requires the planned backup first.

See `manual-admin-job-management-test.md` for test steps and expected state.

## 8. Known limitations and deviations

- Legacy Cloudinary URL remains public after authorized access; no media migration.
- Legacy JobStatusHistory cycle is inferred but labeled explicitly.
- Legacy Review detail stays only for bookmark resolution and can be removed after link retirement.
- No generic Job mutation, Finance Dashboard, global Evidence Vault, notification center or ledger repair.
- Service icon URL remains non-sensitive Service metadata; Job/Evidence media URLs remain gated.
- Schema rollout and destructive financial mutation tests are intentionally not marked complete without their safeguards.
