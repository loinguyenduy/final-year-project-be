# Phase 3 implementation — Admin Users, Wallets and Services

## Outcome

Phase 3 adds canonical Admin User, Wallet, Transaction and Service management while preserving the modular monolith and existing lifecycle/settlement systems. All read models are whitelisted; all financial views are read-only; Socket.IO remains signal-only.

## Gate traceability

### Gate 1 — User read model

- Added page-first Admin User search/filter/sort and batch hydration for profiles, ratings, Job counts, Wallet summaries and latest account action.
- Added aggregate User detail with saved addresses stripped of GPS, canonical KYC submission metadata, recent Jobs, all-review rating aggregate, recent Reviews and active-job impact.
- Added lazy paginated User Jobs endpoint.
- Added responsive Users list and detail workspace. KYC documents remain on-demand through the existing KYC access flow.

Techniques: Sequelize database filters/aggregates, page-first hydration to avoid N+1, DTO allowlists, lazy child collection and abortable Axios requests.

### Gate 2 — account status and session revocation

- Added additive `User.auth_version INTEGER NOT NULL DEFAULT 0`.
- Added canonical version to password/Admin/social access and refresh JWTs.
- REST middleware, refresh rotation and Socket handshake reload User and enforce role, active state and version.
- Deactivation locks User, increments version, revokes all refresh rows and inserts Audit in one transaction; after commit it emits `ACCOUNT_DEACTIVATED` and disconnects the User room.
- Reactivation preserves version and creates/restores no session.
- Chat event-time revalidation closes the race between handshake and forced disconnect.
- Axios bypasses refresh for inactive/revoked codes and sends one local invalidation signal; participant layouts release Socket leases and clear auth.

Legacy JWTs without a version map to `0` only while the canonical User remains version `0`. Once incremented, the old session can never become valid again.

### Gate 3 — Admin Wallets and Transactions

- Added read-only Admin Wallet list with owner/type/status/currency/balance filters, server-side filtered-scope summaries and per-Wallet ledger aggregates.
- Added numbered, stable Admin Transaction list/detail with party summaries, safe provider reference and batch Contract derivation.
- Sanitized the compatibility system-Wallet endpoint so it no longer returns Wallet IDs.
- Added structured security read logs without amounts, Wallet IDs, content or provider payloads.

Techniques: decimal-string API contract, SQL SUM/COUNT, stable `createdAt,id` ordering, batch relation hydration and DTO privacy allowlists.

### Gate 4 — participant Wallet history

- Added canonical `/fintech/wallets/me` and cursor `/fintech/wallets/me/transactions`.
- Enforced authenticated Wallet ownership; arbitrary `user_id` is not accepted.
- Internal transfers render once and counterparties are masked.
- Replaced Customer and Handyman mock/history figures with canonical balances, ledger summary and load-more history.

### Gate 5 — Service Management

- Added Service list/detail/create/edit/activate/deactivate APIs and Admin page/modal UX.
- `service_code` is normalized, validated, unique and immutable.
- Service name is case-insensitive unique within serialized Admin mutations; icon URL is HTTPS-only.
- Added usage counts and immutable Admin Audit actions.
- New Job/service association flows require an active Service. Existing Jobs keep matching, bidding and lifecycle behavior; historical references still resolve and expose inactive state.

### Gate 6 — verification and documentation

- Added startup verification for `auth_version` and additive indexes.
- Added guarded read-only/disposable-user integration script.
- Added this traceability document and the manual test guide.
- Verification results are recorded in “Executed checks” below; unexecuted DB/manual/browser checks are not labelled passed.

## Final API contracts

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/users` | Participant list, numbered pagination |
| GET | `/admin/users/:userId` | Aggregate Admin User detail |
| GET | `/admin/users/:userId/jobs` | Lazy User Jobs |
| POST | `/admin/users/:userId/deactivate` | Atomic deactivate/version increment/session revoke |
| POST | `/admin/users/:userId/reactivate` | Reactivate without restoring session |
| GET | `/admin/wallets` | Read-only Wallet list and filtered-scope summary |
| GET | `/admin/transactions` | Read-only stable numbered Transaction list |
| GET | `/admin/transactions/:transactionId` | Sanitized Transaction detail |
| GET | `/fintech/wallets/me` | Participant canonical balances/summary |
| GET | `/fintech/wallets/me/transactions` | Participant owned cursor history |
| GET | `/admin/services` | Service list and usage |
| GET | `/admin/services/:serviceId` | Service detail |
| POST | `/admin/services` | Create Service |
| PATCH | `/admin/services/:serviceId` | Update name/icon only |
| POST | `/admin/services/:serviceId/activate` | Activate Service |
| POST | `/admin/services/:serviceId/deactivate` | Deactivate Service |

All endpoints keep `{ EM, EC, code, DT }`. Admin reads and participant financial reads use `Cache-Control: private, no-store`.

## Account revocation matrix

| Canonical state | Token version | REST/Socket result |
|---|---:|---|
| Active, version 0 | legacy/missing (=0) | Accepted during rollout compatibility |
| Inactive, version 1+ | any old token | `ACCOUNT_INACTIVE` / inactive Socket error |
| Reactivated, version 1+ | old 0/version | `SESSION_REVOKED` |
| Reactivated, version 1+ | new login current version | Accepted |

Refresh mismatch revokes the presented/all remaining User refresh sessions and does not rotate. Axios never refreshes `ACCOUNT_INACTIVE` or `SESSION_REVOKED`.

## Account action matrix

| Action | Source | Result | Audit |
|---|---|---|---|
| Deactivate | Active participant | inactive, version +1, all refresh revoked | `ADMIN_USER_DEACTIVATED` |
| Deactivate | Inactive participant | 409, unchanged | none |
| Reactivate | Inactive participant | active, version unchanged, no session | `ADMIN_USER_REACTIVATED` |
| Reactivate | Active participant | 409, unchanged | none |
| Either | Admin target | forbidden | none |

Neither action changes Job, Contract, Wallet, Transaction or settlement state.

## Financial read model

- Amounts/balances are decimal strings from PostgreSQL DECIMAL fields.
- Admin Wallet scope summary is SQL `SUM/COUNT` over the entire filtered scope, not only the current page.
- Successful incoming/outgoing and status counts are server-side aggregates.
- Transaction direction is meaningful only in a User scope; `direction` therefore requires `user_id`.
- Contract is derived from canonical Quote/Warranty references and is `null` for unresolved legacy entries.
- No balance adjustment, ledger repair, transaction mutation or partial split endpoint was added.

## Service integration matrix

Inactive Services are rejected for new catalogue choices and new Handyman associations. A POSTED Job may keep its existing inactive Service while editing unrelated fields. Existing Job discovery, Bid and lifecycle flows do not filter the Job out merely because its historical Service was deactivated.

## Schema and indexes

- `Users.auth_version` additive integer, not null, default `0`.
- User: `users_role_active_created`, `users_kyc_created`.
- Refresh: `refresh_tokens_user_revoked`.
- Wallet: `wallets_type_blocked_created` plus existing owner/type unique lookup.
- Transaction: type/status, from-Wallet, to-Wallet and payer stable-created indexes.
- Service: `services_active_name`.
- Review: `reviews_reviewee_created_id`.

No column was dropped or backfilled manually. No DB alter command is run by implementation verification.

## Realtime matrix

| Trigger | Event/action | Client behavior |
|---|---|---|
| Account deactivated after commit | `ACCOUNT_DEACTIVATED` to `user:{id}`, then room disconnect | Clear auth, release Socket, redirect login |
| Socket reconnect with stale token | Handshake `SESSION_REVOKED` | Clear auth; no refresh |
| REST stale/inactive response | local `session:invalidated` signal | Shared cleanup with toast dedupe |

No second Socket server/client was introduced.

## Privacy and security controls

- Saved addresses exclude GPS; KYC detail excludes URLs; Wallet IDs/session/token/provider payloads are excluded.
- Admin Wallet/Transaction views are read-only.
- Sensitive read logger records only Admin/User/Transaction/Job identifiers, resource type and correlation ID.
- Admin account/service mutations lock canonical rows and write immutable Audit in the same transaction.
- Service body validators reject unknown fields; account reasons reject HTML/control characters.

## Files created

Backend:

- `src/modules/admin/constants/adminManagement.constants.js`
- `src/modules/admin/utils/adminManagementValidation.util.js`
- `src/modules/admin/services/AdminUser.service.js`
- `src/modules/admin/controllers/AdminUser.controller.js`
- `src/modules/admin/services/AdminFinance.service.js`
- `src/modules/admin/controllers/AdminFinance.controller.js`
- `src/modules/admin/services/AdminService.service.js`
- `src/modules/admin/controllers/AdminService.controller.js`
- `src/modules/fintech/services/TransactionRead.service.js`
- `src/modules/fintech/controllers/TransactionRead.controller.js`
- `scripts/admin/manualAdminUsersWalletsServicesTest.js`
- `docs/manual-admin-users-wallets-services-test.md`
- `docs/admin-users-wallets-services-phase-3-implementation.md`

Frontend:

- `docs/visual-regression/phase-3/README.md`
- `src/modules/admin/features/finance/pages/AdminFinance.scss`
- `src/modules/admin/features/finance/pages/AdminTransactionDetailPage.jsx`
- `src/modules/admin/features/finance/pages/AdminTransactionsPage.jsx`
- `src/modules/admin/features/finance/pages/AdminWalletsPage.jsx`
- `src/modules/admin/features/services/pages/AdminServices.scss`
- `src/modules/admin/features/services/pages/AdminServicesPage.jsx`
- `src/modules/admin/features/users/pages/AdminUserDetailPage.jsx`
- `src/modules/admin/features/users/pages/AdminUsers.scss`
- `src/modules/admin/features/users/pages/AdminUsersPage.jsx`
- `src/modules/admin/services/adminFinanceService.js`
- `src/modules/admin/services/adminServiceService.js`
- `src/modules/admin/services/adminUserService.js`
- `src/modules/fintech/components/ParticipantTransactionHistory.jsx`
- `src/modules/fintech/components/ParticipantTransactionHistory.scss`
- `src/modules/identity/hooks/useAccountSessionRealtime.js`

## Files modified

Backend:

- `package.json`
- `src/core/database/setup.js`
- `src/core/middlewares/auth.middleware.js`
- `src/core/realtime/realtime.gateway.js`
- `src/modules/admin/constants/admin.constants.js`
- `src/modules/admin/middlewares/adminAuth.middleware.js`
- `src/modules/admin/routes/Admin.routes.js`
- `src/modules/admin/services/AdminAudit.service.js`
- `src/modules/admin/services/AdminSecurityReadLog.service.js`
- `src/modules/chat/sockets/chat.socket.js`
- `src/modules/chat/sockets/socketAuth.middleware.js`
- `src/modules/dispute/models/Review.model.js`
- `src/modules/fintech/models/Transaction.model.js`
- `src/modules/fintech/models/Wallet.model.js`
- `src/modules/fintech/routes/fintech.routes.js`
- `src/modules/fintech/services/Wallet.service.js`
- `src/modules/identity/controllers/Auth.controller.js`
- `src/modules/identity/models/RefreshToken.model.js`
- `src/modules/identity/models/User.model.js`
- `src/modules/identity/services/Auth.service.js`
- `src/modules/identity/services/Profile.service.js`
- `src/modules/identity/services/SocialAuth.service.js`
- `src/modules/matchmaking/models/Service.model.js`
- `src/modules/matchmaking/services/CustomerJob.service.js`

Frontend:

- `src/App.jsx`
- `src/core/api/axiosInstance.js`
- `src/modules/admin/layouts/AdminLayout.jsx`
- `src/modules/chat/socket/chatSocket.js`
- `src/modules/customer/features/dashboard/components/CustomerLayout.jsx`
- `src/modules/customer/features/wallet/components/WalletOverview.jsx`
- `src/modules/customer/features/wallet/pages/CustomerWalletPage.jsx`
- `src/modules/customer/services/walletService.js`
- `src/modules/handyman/features/dashboard/components/HandymanLayout.jsx`
- `src/modules/handyman/features/wallet/pages/HandymanWalletPage.jsx`
- `src/modules/handyman/services/walletService.js`
- Deleted: `src/modules/customer/features/wallet/components/TransactionHistory.jsx`

Workspace root:

- `PROJECT_CONTEXT_AND_GUIDELINES.md`

## Mock-data removal

Handyman fake `mockTransactions`, Customer legacy Transaction history and hard-coded financial headline values were removed. Participant history now comes only from `/fintech/wallets/me*`.

## Visual breakpoint checklist

Target screenshot directory is `final-year-project-fe/docs/visual-regression/phase-3/`:

- 1440×900
- 1366×768
- 1024×768
- 768×1024
- 390×844
- 320×800

No screenshots were generated in this execution: the browser runtime reported no available browser backend. These six authenticated visual checks remain explicitly not executed; fake financial data was not introduced as a substitute.

## Executed checks

Update at final handoff with exact commands and results:

- Backend `node --check`: passed for 34 changed/new JavaScript files.
- Backend route import smoke: passed for Admin and Fintech route modules.
- Guarded script safe-mode: passed; no data changed.
- Frontend `npm run lint`: passed.
- Frontend `npm run build`: passed (Vite warns that the existing main chunk exceeds 500 kB).
- Backend and frontend `git diff --check`: passed (line-ending conversion warnings only).
- Database schema rollout/API account mutation/full payment regression: not executed because no backed-up disposable database fixture was authorized.
- Visual authenticated checks: not executed because the browser runtime exposed no browser backend.

## Known limitations

- Access token remains in Redux Persist/localStorage as accepted in earlier phases.
- No automatic ledger repair, Wallet mutation, Finance Dashboard or persisted Notification Center.
- No Service media upload or Service description/timestamps were added.
- Manual visual/API flows require a running backend, migrated database and prepared users; the codebase has no broad automated test framework.

## Deviations

- No business-scope deviation. Schema rollout remains additive and is deliberately not executed automatically during source verification.
