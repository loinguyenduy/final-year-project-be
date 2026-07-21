# Manual test — Admin Users, Wallets and Services (Phase 3)

## 1. Safety and prerequisites

- Never run account-mutation checks in production.
- Back up PostgreSQL before the additive rollout.
- Run exactly one backend instance with `DB_SYNC_ALTER=true`, verify `Users.auth_version` and Phase 3 indexes, then turn the flag off before scaling.
- Use an Admin account and a disposable active Customer or Handyman. The disposable account must have known password credentials; the test intentionally invalidates all of its existing sessions.
- Do not create financial fixtures by editing `Wallet.balance` or inserting Transaction rows directly.

## 2. Automated guarded smoke script

Read-only checks:

```powershell
$env:NODE_ENV='development'
$env:ADMIN_PHASE3_TEST_EMAIL='admin@example.com'
$env:ADMIN_PHASE3_TEST_PASSWORD='admin-password'
npm run admin:phase3:test:manual
```

The read-only mode checks Admin login, Users, Wallets, Transactions and Services, including forbidden DTO fields.

Disposable account revocation matrix:

```powershell
$env:ADMIN_PHASE3_TEST_ALLOW_ACCOUNT_MUTATION='true'
$env:ADMIN_PHASE3_TEST_USER_ID='disposable-user-uuid'
$env:ADMIN_PHASE3_TEST_CONFIRM_DISPOSABLE_USER_ID='disposable-user-uuid'
$env:ADMIN_PHASE3_TEST_PARTICIPANT_EMAIL='disposable@example.com'
$env:ADMIN_PHASE3_TEST_PARTICIPANT_PASSWORD='disposable-password'
npm run admin:phase3:test:manual
```

The script uses canonical REST/Auth/Socket services only. It does not write Wallet or Transaction data. It restores the disposable account to active if an interruption occurs after deactivation; its old sessions remain permanently invalid because `auth_version` is never reset.

## 3. Schema rollout verification

After the single-instance alter run, verify:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'Users' AND column_name = 'auth_version';

SELECT indexname
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'users_role_active_created', 'users_kyc_created',
    'refresh_tokens_user_revoked', 'wallets_type_blocked_created',
    'transactions_type_status_created_id', 'transactions_from_wallet_created_id',
    'transactions_to_wallet_created_id', 'transactions_payer_created_id',
    'services_active_name', 'reviews_reviewee_created_id'
  );
```

Expected: `auth_version` is integer, not nullable and defaults to `0`; every index exists exactly once.

## 4. Gate 1 — User read model

### List

1. Open `/admin/users` and exercise search, role, active, KYC, Handyman level, bond and sort filters.
2. Reload and use browser Back/Forward.
3. Inspect `GET /api/v1/admin/users`.

Expected:

- Only Customer/Handyman rows appear.
- Search covers UUID, name, email and phone at database level.
- Page metadata is stable and filters remain in the URL.
- Wallet summary has no Wallet ID; no session, password, provider secret, KYC URL or GPS is returned.

### Detail and lazy Jobs

1. Open `/admin/users/:userId`.
2. Inspect Overview/Profile/KYC/Wallet/Ratings/History.
3. Open Jobs and paginate.
4. Open a KYC submission through KYC Management and a Job through Admin Jobs.

Expected:

- Saved addresses contain no GPS.
- KYC detail contains metadata only; document access remains on demand.
- Aggregate ratings use all Reviews; only ten recent Reviews are returned.
- Jobs are fetched from `/admin/users/:userId/jobs` only after opening the section.
- Active-job impact treats every status except `CLOSED`/`CANCELLED` as active.

## 5. Gate 2 — session revocation matrix

1. Login as the disposable participant and save access token/cookie A; connect Socket A.
2. Admin deactivates the account with a valid reason.
3. Call a protected REST endpoint with token A.
4. Confirm Socket A is force-disconnected.
5. Admin reactivates the account.
6. Call REST and reconnect Socket with token A.
7. Call `/auth/refresh` with cookie A.
8. Login again to receive token/cookie B; call REST and connect Socket B.

Expected matrix:

| Check | Expected |
|---|---|
| Token A while inactive | `ACCOUNT_INACTIVE` |
| Existing Socket A | Server disconnect after commit |
| Token A after reactivate | `SESSION_REVOKED` |
| Socket reconnect with A | `SESSION_REVOKED` |
| Refresh cookie A | Rejected; no rotation |
| Token/Socket B | Accepted |
| Reactivate effect | Does not reset `auth_version` or create a session |

Also verify one `ADMIN_USER_DEACTIVATED` and one `ADMIN_USER_REACTIVATED` Audit row. Repeating either state mutation returns HTTP 409 `ACCOUNT_STATUS_ALREADY_SET` and creates no Audit. Admin targets return `ADMIN_USER_TARGET_FORBIDDEN`. No Job, Wallet, Contract or Transaction changes are allowed.

## 6. Gate 3 — Admin Wallets and Transactions

Test:

- `/admin/wallets`: owner role, Wallet type, status, currency, balance and sort.
- `/admin/transactions`: ID/user/role/type/status/Wallet/Job/Contract/cycle/date/amount/direction.
- `/admin/transactions/:transactionId` and links to User/Job.

Expected:

- Money values are decimal strings; filtered scope totals are calculated server-side.
- Direction requires `user_id`.
- Numbered pagination uses stable ordering.
- DTOs do not contain Wallet IDs, idempotency key, provider/webhook payload or arbitrary metadata.
- Detail exposes only whitelisted business references and safe party summaries.
- Read actions never mutate or repair the ledger.

## 7. Gate 4 — Participant Wallet history

Test both Customer and Handyman:

1. Open Wallet page and reload.
2. Filter type/status and Load more.
3. Verify empty/loading/error states.
4. Exercise existing Top-up/PayOS and prepared lifecycle payments.

Expected:

- `/fintech/wallets/me` supplies canonical balances and ledger aggregates.
- `/fintech/wallets/me/transactions` accepts no arbitrary user ID and uses cursor pagination.
- A transfer between two Wallets owned by the same participant is one `INTERNAL` item.
- No hard-coded transaction, “In Escrow”, “Total Paid”, monthly income or system-fee figure remains.

Regression cases: Top-up, deposit, remaining payment, completion, warranty release/refund, cancellation, security bond and PayOS callbacks.

## 8. Gate 5 — Service Management

Test create/edit/activate/deactivate at `/admin/services`:

- Code accepts only normalized uppercase letters, digits and underscore, length 2–50.
- Name is NFC-trimmed, length 2–100 and case-insensitive unique.
- Icon is empty or HTTPS and at most 2048 characters.
- PATCH rejects `service_code`, `is_active` and unknown fields.
- Repeated status change returns HTTP 409 and no Audit.
- There is no DELETE endpoint.

Integration matrix:

| Flow | Active Service | Inactive Service |
|---|---|---|
| Public/new Job selection | Allowed | Hidden/rejected |
| Change a Job to this Service | Allowed | Rejected |
| Edit other fields on an existing Job already using it | Allowed | Allowed |
| Add new Handyman association | Allowed | Rejected |
| Historical Job/Profile display | Shown | Shown with inactive state |
| Existing matching/Bid/lifecycle | Continues | Continues |

Verify Audit actions `ADMIN_SERVICE_CREATED`, `ADMIN_SERVICE_UPDATED`, `ADMIN_SERVICE_ACTIVATED`, and `ADMIN_SERVICE_DEACTIVATED`.

## 9. Responsive and accessibility

Inspect Users list/detail, Wallets, Transactions/detail, Services, Customer Wallet and Handyman Wallet at 1440×900, 1366×768, 1024×768, 768×1024, 390×844 and 320×800.

Verify no page-level horizontal overflow, keyboard-accessible controls, visible focus, modal focus trap/Escape/restore focus, labelled filters and readable mobile cards.

## 10. Cleanup and failure diagnosis

- Ensure the disposable participant ends active; do not reset `auth_version`.
- Remove only disposable structural data through normal application flows.
- Do not delete Audit rows or edit Wallet/Transaction records.
- `SESSION_REVOKED` after reactivate is expected for token A.
- `FINANCIAL_DATA_INCONSISTENT` in an existing settlement flow must be investigated, never repaired by this test.
