# Manual backend test: IN_PROGRESS, Completion, Warranty, Claim và Rework

Tài liệu này dành cho development/staging. Không chạy các SQL mutation hoặc wallet test trên dữ liệu thật.
Backend trả envelope `{ EM, EC, code, DT }`; mọi amount trong phần này là VND nguyên và không lấy từ client khi settlement.

## 1. Contract và quyết định đã áp dụng

- Job đi theo `IN_PROGRESS -> WARRANTY -> CLOSED`.
- Customer không được fetch `BEFORE`, `DURING`, `AFTER` hoặc `WARRANTY` rework Evidence trong các API mới, kể cả khi request đang `PENDING`. Customer chỉ thấy metadata/note của Completion Request và Warranty Completion Request.
- Claim Evidence do Customer submit được Customer, selected Handyman và Admin đọc qua snapshot của Claim.
- Mỗi stage cho phép tối đa 5 ảnh chưa bị snapshot trong một attempt. Evidence đã snapshot bất biến; sau khi Completion Request bị reject, request tiếp theo snapshot lũy kế toàn bộ Evidence cũ và mới, đồng thời bắt buộc có ít nhất một ảnh mới.
- Customer phải tạo Claim tại thời điểm `now < ends_at`; đúng `ends_at` là hết hạn.
- Confirm Completion chia canonical Contract total thành 70% Handyman, 15% platform, phần còn lại 15% Warranty Reserve. Reserve vẫn ở `SYSTEM_ESCROW`.
- Sau split, `Jobs.deposit_status = DISTRIBUTED`.
- Job `CLOSED` có Chat history read-only; không có action gửi tin.
- Admin Claim decision chưa có API/CLI. Phần 11 cung cấp SQL development có transaction.

## 2. Environment và khởi động

Các biến mới/tái sử dụng:

```dotenv
JOB_EVIDENCE_MAX_SIZE_MB=5
JOB_EVIDENCE_MAX_FILES_PER_STAGE=5
JOB_STANDARD_WARRANTY_DAYS=10
JOB_WARRANTY_CRON_ENABLED=true
JOB_WARRANTY_CRON_SCHEDULE=* * * * *
JOB_WARRANTY_RELEASE_BATCH_SIZE=50

# Chỉ được áp dụng khi NODE_ENV=development hoặc test.
JOB_WARRANTY_TEST_DELAY_MINUTES=1
```

Production phải bỏ `JOB_WARRANTY_TEST_DELAY_MINUTES`. Warranty thực tế lấy `warranty_days` từ immutable Contract snapshot; Contract có `warranty_days <= 0` bị chặn trước khi Customer thanh toán phần còn lại.

### Rollout schema một lần

1. Backup PostgreSQL và dừng các instance backend khác.
2. Kiểm tra không có request/warranty/claim trùng khóa unique.
3. Đặt `DB_SYNC_ALTER=true`, khởi động đúng một backend instance và chờ log `Completion and Warranty schema verified successfully.`
4. Dừng backend, đặt `DB_SYNC_ALTER=false`, khởi động lại bình thường.
5. Không để nhiều instance cùng chạy `sync({ alter: true })`.

Các bảng mới:

- `Job_Completion_Requests`, `Job_Completion_Request_Evidences`
- `Job_Warranties`
- `Warranty_Claims`, `Warranty_Claim_Evidences`
- `Warranty_Completion_Requests`, `Warranty_Completion_Request_Evidences`

`Evidence_Vaults.stage` thêm `DURING`, `AFTER`, `WARRANTY_CLAIM`, `WARRANTY`. `Transactions` thêm ba reference và các semantic type:

- `HANDYMAN_PARTIAL_RELEASE`
- `PLATFORM_SERVICE_FEE`
- `WARRANTY_RESERVE_HOLD`
- `WARRANTY_RELEASE`

### SQL verify chỉ đọc

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN (
    'Job_Completion_Requests', 'Job_Completion_Request_Evidences',
    'Job_Warranties', 'Warranty_Claims', 'Warranty_Claim_Evidences',
    'Warranty_Completion_Requests', 'Warranty_Completion_Request_Evidences'
  )
ORDER BY table_name;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'completion_requests_job_cycle_sequence_unique',
    'completion_requests_one_pending_per_cycle',
    'completion_request_evidence_unique',
    'job_warranties_job_cycle_unique',
    'job_warranties_completion_request_unique',
    'job_warranties_release_transaction_unique',
    'warranty_claims_one_active_per_warranty',
    'warranty_claim_evidence_unique',
    'warranty_claim_evidence_one_claim_per_evidence',
    'warranty_completion_requests_sequence_unique',
    'warranty_completion_requests_one_pending',
    'warranty_completion_request_evidence_unique',
    'warranty_completion_evidence_one_request_per_evidence',
    'transactions_idempotency_key_unique'
  )
ORDER BY indexname;

SELECT e.enumlabel
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'enum_Transactions_transaction_type'
ORDER BY e.enumsortorder;
```

## 3. Postman variables và dữ liệu chuẩn

Collection variables:

```text
baseUrl=http://localhost:5000/api/v1/matchmaking
customerToken=<JWT Customer của Job>
handymanToken=<JWT selected Handyman>
outsiderToken=<JWT user không thuộc Job>
adminToken=<JWT Admin>
jobId=<Job IN_PROGRESS đã thanh toán đủ>
completionRequestId=
warrantyId=
claimId=
warrantyCompletionRequestId=
```

Header JSON: `Authorization: Bearer {{token}}`, `Content-Type: application/json`.
Upload ảnh dùng `form-data`, key `image`, đúng một JPEG/PNG thật. Chuẩn bị ít nhất bốn ảnh khác nhau.

Precondition Job chuẩn:

- `Jobs.current_status = IN_PROGRESS`, `deposit_status = HELD`, đúng Customer/selected Handyman/Bid `WON`.
- Quote `ACCEPTED`, Contract `ACTIVE`, canonical totals bằng nhau và `warranty_days > 0`.
- `DEPOSIT_10` và `SERVICE_REMAINING_PAYMENT` (nếu amount > 0) đều `SUCCESS` và tiền đang ở `SYSTEM_ESCROW`.
- Conversation của acceptance cycle là `ACTIVE`.

Snapshot trước mutation:

```sql
SELECT id, current_status, deposit_status, acceptance_cycle, final_agreed_price
FROM "Jobs" WHERE id = '<jobId>';

SELECT wallet_type, user_id, balance
FROM "Wallets"
WHERE wallet_type IN ('SYSTEM_ESCROW', 'SYSTEM_PROFIT', 'HANDYMAN_MAIN')
ORDER BY wallet_type, user_id;

SELECT id, transaction_type, status, amount, idempotency_key
FROM "Transactions" WHERE job_id = '<jobId>' ORDER BY "createdAt";
```

## 4. Work Evidence và privacy

### E1 — Handyman upload DURING

- Actor: selected Handyman.
- `POST {{baseUrl}}/jobs/{{jobId}}/evidence/during`, form-data `image`.
- Expected: HTTP 201, `code=DURING_EVIDENCE_CREATED`; row `Evidence_Vaults` đúng Job/cycle/uploader/stage.
- Failure: Customer/outsider nhận 403 từ role/ownership; Job không `IN_PROGRESS` nhận `JOB_NOT_IN_PROGRESS`.

### E2 — Handyman upload AFTER

- `POST {{baseUrl}}/jobs/{{jobId}}/evidence/after`.
- Expected: HTTP 201, `AFTER_EVIDENCE_CREATED`.

### E3 — fetch/delete trước snapshot

- Handyman: `GET .../evidence/during` và `GET .../evidence/after` trả ảnh của đúng Job/cycle.
- Customer không có quyền route và không được nhận URL.
- `DELETE .../evidence/{during|after}/:evidenceId` thành công khi ảnh chưa snapshot.
- Upload ảnh thay thế để vẫn có ít nhất một DURING và một AFTER.

### E4 — giới hạn và file validation

- Ảnh thứ 6 chưa snapshot cùng stage: `EVIDENCE_LIMIT_REACHED`.
- File không phải JPEG/PNG: HTTP 415 `INVALID_IMAGE_TYPE`.
- File vượt size: HTTP 413 `IMAGE_TOO_LARGE`.
- MIME giả nhưng signature sai: HTTP 415.

### E5 — BEFORE privacy regression

- Với Job `IN_PROGRESS`, Customer gọi `GET .../evidence/before`: 404 `EVIDENCE_NOT_FOUND`.
- Selected Handyman/Admin vẫn đọc được lịch sử BEFORE.

## 5. Completion Request

### C1 — readiness và allowed actions

- `GET {{baseUrl}}/jobs/{{jobId}}/accepted-details` bằng Handyman.
- Expected: `DT.completion.readiness` có count, blocking reasons và `ready_to_request_completion`.
- Khi đủ DURING/AFTER và không pending: có `REQUEST_COMPLETION`; không có cancellation action.
- Customer chỉ thấy `latest_request` metadata và `readiness=null`; không có Evidence URL/count.

### C2 — thiếu Evidence

- Job riêng chỉ có AFTER: create request trả `DURING_EVIDENCE_REQUIRED`.
- Job riêng chỉ có DURING: trả `AFTER_EVIDENCE_REQUIRED`.

### C3 — tạo request

```http
POST {{baseUrl}}/jobs/{{jobId}}/completion-requests
Authorization: Bearer {{handymanToken}}
Content-Type: application/json

{"completion_note":"Work completed and tested."}
```

Expected:

- HTTP 201 `COMPLETION_REQUEST_CREATED`; lưu `DT.request.id` vào `completionRequestId`.
- Job vẫn `IN_PROGRESS`; request `PENDING`, sequence 1; snapshot links chứa toàn bộ DURING/AFTER hiện có.
- Realtime `JOB_COMPLETION_REQUESTED` gửi signal sau commit, không có Evidence URL/wallet data.
- Double click trả success idempotent `COMPLETION_REQUEST_ALREADY_PENDING`; không tạo row thứ hai.
- Upload/delete DURING/AFTER lúc pending trả `COMPLETION_EVIDENCE_LOCKED`.

### C4 — quyền đọc request và Evidence

- Customer/Handyman/Admin: `GET .../completion-requests` đọc metadata.
- Handyman/Admin: `GET .../completion-requests/{{completionRequestId}}/evidence` đọc snapshot.
- Customer/outsider gọi Evidence endpoint: bị chặn; service cũng trả 404 nếu đi qua lớp route khác.

### C5 — reject và retry

```http
POST {{baseUrl}}/jobs/{{jobId}}/completion-requests/{{completionRequestId}}/reject
Authorization: Bearer {{customerToken}}
Content-Type: application/json

{"reason":"RESULT_NOT_AS_AGREED","note":"The repaired unit is still not functioning correctly."}
```

Expected: `COMPLETION_REJECTED`; Job vẫn `IN_PROGRESS`; không có Transaction settlement; ảnh snapshot cũ không xóa được; event `JOB_COMPLETION_REJECTED`.

Sau reject:

1. Gửi request lại ngay, chưa upload ảnh mới: `NEW_COMPLETION_EVIDENCE_REQUIRED`.
2. Upload ít nhất một ảnh DURING hoặc AFTER mới.
3. Gửi request lần 2: sequence 2 và snapshot lũy kế ảnh cũ + mới.
4. Snapshot request 1 không thay đổi.

### C6 — confirm validation

- Body phải là `{}`; body có amount/field khác nhận `VALIDATION_ERROR`.
- Customer khác/Handyman không confirm được.
- Request stale/rejected nhận `COMPLETION_REQUEST_NOT_PENDING`.

## 6. Financial settlement 70/15/15

### F1 — total 1,000,000

Ghi balance trước, sau đó:

```http
POST {{baseUrl}}/jobs/{{jobId}}/completion-requests/{{completionRequestId}}/confirm
Authorization: Bearer {{customerToken}}
Content-Type: application/json

{}
```

Expected atomic state:

- Handyman Main `+700000`.
- System Profit `+150000`.
- System Escrow `-850000`; `150000` reserve còn nằm trong escrow.
- Ba row `SUCCESS`: `HANDYMAN_PARTIAL_RELEASE=700000`, `PLATFORM_SERVICE_FEE=150000`, `WARRANTY_RESERVE_HOLD=150000`.
- Hold row không tạo self-transfer giả (`to_wallet_id` null).
- Tổng ba ledger amount đúng `1000000`.
- request `CONFIRMED`; Job `WARRANTY`, deposit `DISTRIBUTED`; Warranty `ACTIVE`; history `IN_PROGRESS -> WARRANTY`.
- event `JOB_COMPLETION_CONFIRMED` và `JOB_WARRANTY_STARTED` chỉ emit sau commit.

### F2 — rounding

Với total `1000001`: Handyman `700000`, platform `150000`, reserve `150001`; tổng luôn bằng total.

### F3 — concurrency/idempotency

- Gửi hai confirm đồng thời bằng Postman Runner: chỉ một split; retry trả `COMPLETION_ALREADY_CONFIRMED`.
- Confirm và reject đồng thời: Job/request row lock đảm bảo chỉ một response thắng.
- Chặn/bỏ wallet hoặc làm escrow thiếu trong DB development: toàn bộ trả rollback, không có partial balance/ledger/status/event.
- Sửa canonical Quote/Contract/deposit ledger sai: `FINANCIAL_DATA_INCONSISTENT`.

Verify:

```sql
SELECT transaction_type, amount, status, completion_request_id, warranty_id, idempotency_key
FROM "Transactions"
WHERE job_id = '<jobId>'
  AND transaction_type IN (
    'HANDYMAN_PARTIAL_RELEASE', 'PLATFORM_SERVICE_FEE', 'WARRANTY_RESERVE_HOLD'
  )
ORDER BY "createdAt";

SELECT status, warranty_days, started_at, ends_at, total_amount,
       handyman_immediate_amount, platform_fee_amount, warranty_held_amount,
       warranty_released_amount, released_at
FROM "Job_Warranties" WHERE job_id = '<jobId>';
```

## 7. Warranty normal path và scheduler

### W1 — DTO

- `GET .../jobs/{{jobId}}/warranty` và accepted-details bằng hai participant.
- Customer thấy Claim readiness của mình, không thấy Warranty rework Evidence count.
- Handyman thấy rework readiness khi applicable, không thấy Customer draft Claim Evidence.

### W2 — chưa đến hạn

- Cron chạy trước `ends_at`: không ledger `WARRANTY_RELEASE`; Warranty `ACTIVE`, Job `WARRANTY`.

### W3 — development override 1 phút

- Với `NODE_ENV=development` và `JOB_WARRANTY_TEST_DELAY_MINUTES=1`, tạo Warranty mới.
- Expected `expiry_override_minutes=1`; chờ đến `ends_at`, cron tạo đúng một `WARRANTY_RELEASE`.
- Handyman Main `+held_amount`, System Escrow `-held_amount`.
- Warranty `COMPLETED`, `released_at`/`release_transaction_id` có giá trị; Job `CLOSED`; Contract `COMPLETED`.
- History `WARRANTY -> CLOSED`; events `JOB_WARRANTY_RELEASED`, `JOB_COMPLETED`.

### W4 — double cron/multi-instance

- Cho hai instance cùng quét một Warranty: row lock/idempotency key đảm bảo một release.
- Lần quét sau skip `WARRANTY_ALREADY_RELEASED`/không còn candidate.

### W5 — Chat CLOSED read-only

- `GET /api/v1/chat/jobs/{{jobId}}/conversation`: conversation `CLOSED`, `allowed_actions=["HISTORY"]`.
- `GET /api/v1/chat/conversations/:conversationId/messages` vẫn đọc lịch sử.
- Socket join/send/read mutation không được phép trên conversation đã đóng.

## 8. Warranty Claim

### CL1 — upload draft Claim Evidence

- Customer: `POST .../evidence/warranty-claim`, sau đó `GET`/`DELETE` cùng path.
- Handyman không được đọc draft endpoint.
- Claim window đóng khi `now >= ends_at`; upload/submit trả `WARRANTY_CLAIM_WINDOW_EXPIRED`.

### CL2 — submit Claim

```http
POST {{baseUrl}}/jobs/{{jobId}}/warranty/claims
Authorization: Bearer {{customerToken}}
Content-Type: application/json

{"reason":"ISSUE_RETURNED","description":"The original issue returned during Warranty."}
```

Expected:

- HTTP 201 `WARRANTY_CLAIM_CREATED`; Claim `PENDING_REVIEW`, Warranty `CLAIM_PENDING`, Job vẫn `WARRANTY`.
- Claim snapshot bất biến; event `JOB_WARRANTY_CLAIM_CREATED`.
- Duplicate cùng payload trả row hiện có; payload khác nhận `WARRANTY_CLAIM_ALREADY_ACTIVE`.
- Thiếu ảnh: `WARRANTY_CLAIM_EVIDENCE_REQUIRED`; `OTHER` thiếu description: `VALIDATION_ERROR`.
- Cron không release khi Claim active/Warranty không còn `ACTIVE`.

### CL3 — quyền snapshot

- Customer, selected Handyman, Admin: `GET .../warranty/claims/{{claimId}}/evidence`.
- Outsider: 404.
- Handyman chỉ thấy đúng ảnh đã snapshot, không thấy ảnh draft upload về sau.

## 9. Warranty rework

Sau khi chạy SQL approve ở phần 11, refetch accepted-details. Warranty phải `REWORK_REQUIRED`, Claim `APPROVED_REWORK_REQUIRED`; Chat cũ vẫn `ACTIVE`, không tạo conversation mới.

### R1 — Evidence và request

- Chỉ selected Handyman upload/list/delete `POST|GET|DELETE .../evidence/warranty`.
- Trước approve: `WARRANTY_REWORK_NOT_REQUIRED`.
- Tạo request:

```http
POST {{baseUrl}}/jobs/{{jobId}}/warranty/completion-requests
Authorization: Bearer {{handymanToken}}
Content-Type: application/json

{"completion_note":"Warranty rework completed and tested."}
```

Expected: request `PENDING`; Warranty `REWORK_CONFIRMATION_PENDING`; snapshot được khóa; event `JOB_WARRANTY_COMPLETION_REQUESTED`.
Customer chỉ đọc request metadata, không đọc endpoint Evidence.

### R2 — Customer confirm

```http
POST {{baseUrl}}/jobs/{{jobId}}/warranty/completion-requests/{{warrantyCompletionRequestId}}/confirm
Authorization: Bearer {{customerToken}}
Content-Type: application/json

{}
```

Expected atomic state: reserve release đúng một lần; request `CONFIRMED`; Claim `RESOLVED`; Warranty `COMPLETED`; Job `CLOSED`; Contract `COMPLETED`; Chat đóng read-only; history/event đầy đủ.

### R3 — Customer reject

```http
POST {{baseUrl}}/jobs/{{jobId}}/warranty/completion-requests/{{warrantyCompletionRequestId}}/reject
Authorization: Bearer {{customerToken}}
Content-Type: application/json

{"reason":"FUNCTION_NOT_WORKING","note":"The issue remains after rework."}
```

Expected: request `REJECTED`; Claim và Warranty `REVIEW_REQUIRED`; Job vẫn `WARRANTY`; reserve không release; event `JOB_WARRANTY_REWORK_REJECTED`. Không có retry vô hạn cho đến khi Admin quyết định bằng SQL.

## 10. Canonical allowed_actions checklist

- Admin: `[]`.
- `IN_PROGRESS` Handyman: upload/delete Evidence phù hợp; `REQUEST_COMPLETION` chỉ khi readiness ready; pending thì wait.
- `IN_PROGRESS` Customer: wait; khi pending chỉ confirm/reject + view contract. Không cancellation/contact-support giả.
- `WARRANTY/ACTIVE` Customer: Claim upload/delete/submit khi còn hạn; Handyman wait expiry.
- `CLAIM_PENDING`: wait Admin review.
- `REWORK_REQUIRED`: Handyman quản lý Warranty Evidence/request; Customer wait.
- `REWORK_CONFIRMATION_PENDING`: Customer confirm/reject; Handyman wait.
- `REVIEW_REQUIRED`: wait Admin review.
- `CLOSED`: `[]`; Chat DTO riêng chỉ `HISTORY`.

## 11. SQL Admin decision — development only

Raw SQL không emit Socket.IO event. Sau commit, hai client phải canonical refetch. Dùng đúng Admin UUID và kiểm tra mỗi statement trả đúng một row. Nếu không đúng, `ROLLBACK`.

> Không được chỉ đổi `Warranty_Claims.status`. Một approval hợp lệ luôn phải cập nhật **cả hai** row trong
> cùng transaction: Claim thành `APPROVED_REWORK_REQUIRED` và Job Warranty thành `REWORK_REQUIRED`.
> Nếu Claim đã approve nhưng Warranty vẫn là `CLAIM_PENDING`, `accepted-details` sẽ không cấp action cho
> Handyman và các endpoint Evidence/Completion cũng chủ động trả `WARRANTY_REWORK_NOT_REQUIRED`.

### Approve Claim cho rework

```sql
BEGIN;

SELECT id, warranty_id, status
FROM "Warranty_Claims"
WHERE id = '<claimId>'
FOR UPDATE;

SELECT id, status, released_at
FROM "Job_Warranties"
WHERE id = '<warrantyId>'
FOR UPDATE;

UPDATE "Warranty_Claims"
SET status = 'APPROVED_REWORK_REQUIRED',
    reviewed_at = NOW(),
    reviewed_by_admin_id = '<adminUserId>',
    admin_note = 'Development approval for rework',
    "updatedAt" = NOW()
WHERE id = '<claimId>' AND warranty_id = '<warrantyId>' AND status = 'PENDING_REVIEW'
RETURNING id, status;

UPDATE "Job_Warranties"
SET status = 'REWORK_REQUIRED',
    rework_cycle_count = rework_cycle_count + 1,
    "updatedAt" = NOW()
WHERE id = '<warrantyId>' AND status = 'CLAIM_PENDING' AND released_at IS NULL
RETURNING id, status, rework_cycle_count;

SELECT wc.id AS claim_id, wc.status AS claim_status,
       jw.id AS warranty_id, jw.status AS warranty_status
FROM "Warranty_Claims" wc
JOIN "Job_Warranties" jw ON jw.id = wc.warranty_id
WHERE wc.id = '<claimId>'
  AND wc.status = 'APPROVED_REWORK_REQUIRED'
  AND jw.status = 'REWORK_REQUIRED';

COMMIT;
```

Expected: câu `SELECT` cuối trả đúng một row. Nếu trả zero row, chạy `ROLLBACK` thay cho `COMMIT` và sửa
đúng ID/state nguồn trước khi thử lại.

### Reject Claim và mở lại automatic expiry

```sql
BEGIN;
SELECT id FROM "Warranty_Claims" WHERE id = '<claimId>' FOR UPDATE;
SELECT id FROM "Job_Warranties" WHERE id = '<warrantyId>' FOR UPDATE;

UPDATE "Warranty_Claims"
SET status = 'REJECTED', reviewed_at = NOW(), resolved_at = NOW(),
    reviewed_by_admin_id = '<adminUserId>', admin_note = 'Claim rejected in development',
    "updatedAt" = NOW()
WHERE id = '<claimId>' AND warranty_id = '<warrantyId>' AND status = 'PENDING_REVIEW'
RETURNING id, status;

UPDATE "Job_Warranties"
SET status = 'ACTIVE', "updatedAt" = NOW()
WHERE id = '<warrantyId>' AND status = 'CLAIM_PENDING' AND released_at IS NULL
RETURNING id, status;
COMMIT;
```

Nếu Warranty đã hết hạn, cron có thể release ở lần quét kế tiếp sau khi Claim bị reject.

### Sau Customer reject rework: cho phép một rework cycle mới

```sql
BEGIN;
SELECT id FROM "Warranty_Claims" WHERE id = '<claimId>' FOR UPDATE;
SELECT id FROM "Job_Warranties" WHERE id = '<warrantyId>' FOR UPDATE;

UPDATE "Warranty_Claims"
SET status = 'APPROVED_REWORK_REQUIRED', reviewed_at = NOW(),
    reviewed_by_admin_id = '<adminUserId>', admin_note = 'One additional rework cycle',
    "updatedAt" = NOW()
WHERE id = '<claimId>' AND status = 'REVIEW_REQUIRED'
RETURNING id, status;

UPDATE "Job_Warranties"
SET status = 'REWORK_REQUIRED', rework_cycle_count = rework_cycle_count + 1,
    "updatedAt" = NOW()
WHERE id = '<warrantyId>' AND status = 'REVIEW_REQUIRED' AND released_at IS NULL
RETURNING id, status, rework_cycle_count;
COMMIT;
```

## 12. Failure/rollback và cleanup

- Cloudinary upload thành công nhưng DB transaction fail: backend best-effort xóa ảnh vừa upload.
- Không xóa Evidence đã snapshot hoặc ledger tài chính để “test lại”; dùng Job development mới.
- Khi settlement fail, so sánh snapshot wallet/Transaction/Job/Request để xác nhận không có partial mutation.
- Khi cần rollback code trước khi production có settlement mới: deploy commit cũ và để các bảng mới tồn tại; không drop enum/table tự động.
- Nếu đã có Transaction bằng semantic type mới, code cũ có thể không hiểu chúng. Trước emergency rollback phải backup, dừng writers và lập kế hoạch map dữ liệu mới về type cũ; không chạy update hàng loạt khi chưa preview count.
- Cleanup development nên xóa toàn bộ Job fixture theo FK order trong một transaction riêng. Luôn chạy `SELECT COUNT(*)` trước và kiểm tra `current_database()`; tài liệu này không cung cấp lệnh xóa dữ liệu thật.

Kiểm tra cuối:

```sql
SELECT current_status, deposit_status FROM "Jobs" WHERE id = '<jobId>';
SELECT status, released_at, warranty_held_amount, warranty_released_amount
FROM "Job_Warranties" WHERE job_id = '<jobId>';
SELECT old_status, new_status, changed_by_user_id, reason, "createdAt"
FROM "Job_Status_Histories" WHERE job_id = '<jobId>' ORDER BY "createdAt";
SELECT transaction_type, amount, status, idempotency_key
FROM "Transactions" WHERE job_id = '<jobId>' ORDER BY "createdAt";
```
