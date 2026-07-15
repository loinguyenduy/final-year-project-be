# Hướng dẫn kiểm thử thủ công Quote Response → Payment → Contract → In Progress

## 1. Mục tiêu và dữ liệu chuẩn bị

Tài liệu này kiểm tra backend từ lúc Quote đã `SUBMITTED` cho đến khi Job vào
`IN_PROGRESS`. Chỉ chạy trên development/staging và không dùng ví tiền thật.

Chuẩn bị:

- `BASE_URL=http://localhost:5000/api/v1/matchmaking`.
- `CUSTOMER_TOKEN`, `HANDYMAN_TOKEN`, `OUTSIDER_TOKEN`, `ADMIN_TOKEN`.
- Mỗi mutation test dùng một Job riêng, trừ test retry/concurrency.
- Job chuẩn có `QUOTE_PENDING`, Quote `SUBMITTED`, Bid `WON`, deposit `HELD`,
  transaction `DEPOSIT_10/SUCCESS`, Customer/Handyman active và conversation `ACTIVE`.
- Ghi snapshot trước test: Job, Quote, Quote Items, Bid, deposit transaction, bốn ví,
  Job Status History, Job Cancellation, Conversation, Transaction và E Contract.
- Amount trong API mới phải là chuỗi VND nguyên. Response dùng envelope
  `{ EM, EC, code, DT }`.

## 2. Đồng bộ schema development đúng một lần

### Test S1 — Backup và sync alter

- Steps: backup database; dừng backend; đặt `DB_SYNC_ALTER=true`; khởi động đúng một
  lần; đợi log xác nhận Quote payment/Contract indexes; đặt lại `false`; restart.
- Request: N/A.
- Expected HTTP/envelope: N/A.
- Expected database: Job có `PAYMENT_PENDING` và `in_progress_at`; Quote/Transaction/
  E Contract có các cột mới; index bắt buộc tồn tại.
- Expected realtime: không có event.
- Common failures: quên backup; duplicate Contract/remaining payment; quên tắt alter;
  PostgreSQL enum chưa được cập nhật.

### Test S2 — Kiểm tra cột, enum và index

- Steps: chạy SQL dưới đây bằng account chỉ đọc.
- Request: N/A.
- Expected database: ba unique Contract index và hai lớp idempotency payment đều đúng.
- Common failures: chạy nhầm schema hoặc sai chữ hoa tên bảng Sequelize.

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('Jobs', 'Job_Quotes', 'Transactions', 'E_Contracts')
ORDER BY table_name, ordinal_position;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'transactions_idempotency_key_unique',
    'transactions_one_successful_remaining_payment_per_quote',
    'e_contracts_job_cycle_unique',
    'e_contracts_quote_unique',
    'e_contracts_contract_number_unique'
  );

SELECT t.typname, e.enumlabel
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE e.enumlabel IN (
  'PAYMENT_PENDING', 'SERVICE_REMAINING_PAYMENT',
  'FINAL_QUOTE_TOO_HIGH', 'FINAL_QUOTE_NOT_ACCEPTABLE',
  'ACTIVE', 'IN_PROGRESS'
)
ORDER BY t.typname, e.enumsortorder;
```

## 3. Đọc Quote và phân quyền

### Test Q1 — Customer/Handyman/Admin đọc Quote

- Steps: gọi API bằng ba participant hợp lệ khi Quote lần lượt là `SUBMITTED`,
  `ACCEPTED`, `REJECTED`.
- Request: `GET /jobs/:jobId/quotes/current`.
- Expected HTTP/envelope: `200 CURRENT_QUOTE_RETRIEVED`; Customer không nhận
  `draft_revision` hoặc participant IDs nội bộ.
- Expected database: không đổi.
- Expected realtime: không emit.
- Common failures: token Handyman không phải selected Handyman; dùng Quote cycle cũ.

### Test Q2 — Outsider không biết Quote tồn tại

- Steps: gọi Q1 bằng `OUTSIDER_TOKEN`.
- Request: như Q1.
- Expected HTTP/envelope: `404 QUOTE_NOT_FOUND`.
- Expected database/realtime: không đổi, không emit.
- Common failures: dùng nhầm Customer owner token.

## 4. Customer accept Quote

### Test A1 — Accept thành công

- Steps: lưu Quote total, deposit, Bid, conversation và history count; gọi accept.
- Request: `POST /jobs/:jobId/quotes/:quoteId/accept`, body `{}`.
- Expected HTTP/envelope: `200 QUOTE_ACCEPTED`; `DT.status=PAYMENT_PENDING`;
  `remaining_amount=quote_total_amount-deposit_amount`.
- Expected database: Quote `ACCEPTED` và đủ response timestamps/user; Job
  `PAYMENT_PENDING`; `final_agreed_price=Quote total`; đúng một history
  `QUOTE_PENDING → PAYMENT_PENDING`; deposit `HELD`, Bid `WON`, cycle/participants/
  conversation không đổi; chưa có remaining transaction và Contract.
- Expected realtime: đúng một `JOB_QUOTE_ACCEPTED` và một `JOB_PAYMENT_REQUIRED` cho
  hai participant; payload không có wallet balance.
- Common failures: Quote total/items lệch canonical; deposit transaction sai escrow;
  participant inactive; body không rỗng.

### Test A2 — Retry accept

- Steps: gọi lại đúng request A1.
- Request: như A1.
- Expected HTTP/envelope: `200 QUOTE_ALREADY_ACCEPTED`.
- Expected database: không đổi timestamp, history hoặc `final_agreed_price`.
- Expected realtime: không emit lại.
- Common failures: dùng Quote khác hoặc Quote đã `REJECTED`.

### Test A3 — Validation và privacy

- Steps: thử Handyman/Admin/outsider; body chứa `amount`, `cycle` hoặc field bất kỳ;
  Quote cycle cũ; Quote `DRAFT`; Job không `QUOTE_PENDING`.
- Request: như A1.
- Expected HTTP/envelope: middleware/404/400/409 phù hợp; Quote đã reject trả
  `409 QUOTE_RESPONSE_CONFLICT`.
- Expected database/realtime: không mutation, không emit.
- Common failures: nhầm lỗi role từ middleware với lỗi owner trong service.

### Test A4 — Accept và reject đồng thời

- Steps: gửi accept và reject gần như cùng lúc cho cùng Job/Quote.
- Request: A1 đồng thời với R1.
- Expected HTTP/envelope: đúng một action thành công; action thua trả lifecycle/response
  conflict.
- Expected database: không có trạng thái lai; không vừa `ACCEPTED` vừa có cancellation
  của reject.
- Expected realtime: chỉ event của action thắng.
- Common failures: test bằng hai Job khác nhau hoặc client tự retry request thua.

## 5. Customer reject Quote và cancellation nguyên tử

### Test R1 — Hai reason hợp lệ

- Steps: dùng Job mới cho từng reason.
- Request: `POST /jobs/:jobId/quotes/:quoteId/reject` với một trong hai body:

```json
{"reason":"FINAL_QUOTE_TOO_HIGH","reason_text":"Vượt ngân sách"}
```

```json
{"reason":"FINAL_QUOTE_NOT_ACCEPTABLE","reason_text":null}
```

- Expected HTTP/envelope: `201 QUOTE_REJECTED`; cancellation DTO có classification
  `NEUTRAL_QUOTE_REJECTION`, status `RESOLVED` và tỷ lệ Customer/Handyman 70/30.
- Expected database: Quote `REJECTED`; Job `CANCELLED`; deposit `DISTRIBUTED`; Bid
  `CANCELLED_BY_CUSTOMER`; payout tổng đúng deposit; conversation đóng `JOB_CANCELLED`;
  evidence/items/Quote giữ lại.
- Expected realtime: `JOB_QUOTE_REJECTED` và `JOB_CANCELLED`, không có balance/GPS.
- Common failures: thiếu Handyman wallet; escrow thiếu tiền; deposit đã release.

### Test R2 — Reason/payload sai

- Steps: thử `OTHER`, reason Task 2 khác, reason_text >500, field classification/amount.
- Request: như R1.
- Expected HTTP/envelope: `400 VALIDATION_ERROR`.
- Expected database: Quote vẫn `SUBMITTED`; không cancellation/payout/history/chat close.
- Expected realtime: không emit.
- Common failures: gọi nhầm endpoint cancellation thống nhất, nơi policy rộng hơn.

### Test R3 — Retry reject

- Steps: gọi lại đúng requester/reason của R1.
- Request: như R1.
- Expected HTTP/envelope: `200 QUOTE_ALREADY_REJECTED`.
- Expected database: không payout/history/chat close lần hai; timestamps giữ nguyên.
- Expected realtime: không emit lại.
- Common failures: đổi reason giữa hai lần gọi.

### Test R4 — Chứng minh rollback nguyên tử

- Steps: trên DB test, chủ động làm thiếu Handyman MAIN hoặc thiếu escrow rồi reject.
- Request: như R1.
- Expected HTTP/envelope: 404/409 theo lỗi wallet/escrow.
- Expected database: Quote vẫn `SUBMITTED`, Job vẫn `QUOTE_PENDING`, không transaction,
  Bid/history/conversation không đổi.
- Expected realtime: không emit.
- Common failures: kiểm tra Quote bằng instance/cache cũ thay vì query lại DB.

## 6. Payment summary

### Test P1 — Participant/Admin đọc summary

- Steps: sau A1, gọi bằng Customer, selected Handyman và Admin.
- Request: `GET /jobs/:jobId/payment-summary`.
- Expected HTTP/envelope: `200 PAYMENT_SUMMARY_RETRIEVED`; status `PENDING`; amount
  là chuỗi canonical.
- Expected database/realtime: không đổi, không emit.
- Common failures: Quote chưa accept hoặc deposit không còn `HELD`.

### Test P2 — Privacy summary

- Steps: gọi bằng outsider; kiểm tra DTO participant.
- Request: như P1.
- Expected HTTP/envelope: outsider `404 PAYMENT_SUMMARY_NOT_FOUND`.
- Expected database: không đổi; DTO hợp lệ không có wallet balance, global escrow balance,
  gateway code, idempotency key hay transaction ID.
- Expected realtime: không emit.
- Common failures: nhầm `missing_amount` của error thanh toán với dữ liệu summary.

## 7. Thanh toán remaining và kích hoạt Contract

### Test M1 — Remaining dương, đủ balance

- Steps: bảo đảm Customer MAIN đủ tiền; ghi balance Customer/SYSTEM_ESCROW; gọi pay.
- Request: `POST /jobs/:jobId/payments/remaining`, body `{}`.
- Expected HTTP/envelope: `200 PAYMENT_COMPLETED`; payment `COMPLETED`; Contract
  `ACTIVE`; Job `IN_PROGRESS`.
- Expected database: Customer giảm đúng remaining; escrow tăng đúng remaining; một
  `SERVICE_REMAINING_PAYMENT/SUCCESS`; Contract snapshot được tạo; Job có
  `in_progress_at`; đúng một history `PAYMENT_PENDING → IN_PROGRESS`; deposit vẫn
  `HELD`, Bid `WON`, cycle/participants/Quote/conversation không đổi.
- Expected realtime: đúng một `JOB_PAYMENT_COMPLETED` và `JOB_IN_PROGRESS`.
- Common failures: Customer wallet blocked; currency không phải VND; amount client gửi
  khiến body không còn rỗng.

### Test M2 — Remaining bằng 0

- Steps: chuẩn bị deposit bằng Quote total và accept Quote; gọi pay.
- Request: như M1.
- Expected HTTP/envelope: `200 PAYMENT_COMPLETED`, remaining `"0"`.
- Expected database: không tạo transaction 0 đồng; wallet không đổi; Contract `ACTIVE`;
  Job `IN_PROGRESS`; liability theo Job bằng Quote total từ deposit.
- Expected realtime: hai event như M1.
- Common failures: tìm transaction bằng contract ID rồi hiểu nhầm null là lỗi.

### Test M3 — Deposit lớn hơn Quote

- Steps: chuẩn bị dữ liệu bất nhất trên DB test rồi accept hoặc pay.
- Request: A1 hoặc M1.
- Expected HTTP/envelope: `409 FINANCIAL_DATA_INCONSISTENT`.
- Expected database/realtime: không refund, không wallet mutation, không Contract/history/event.
- Common failures: vô tình dùng Quote total bằng deposit do rounding.

### Test M4 — Không đủ balance

- Steps: Customer balance nhỏ hơn remaining.
- Request: như M1.
- Expected HTTP/envelope: `409 INSUFFICIENT_BALANCE`, có required/missing amount của
  chính Customer nhưng không có global escrow balance.
- Expected database: Job vẫn `PAYMENT_PENDING`, Quote `ACCEPTED`, không successful
  payment/Contract/history; cả hai wallet không đổi.
- Expected realtime: không emit.
- Common failures: top-up chạy đồng thời hoặc đọc balance trước khi transaction rollback.

### Test M5 — Retry và timeout sau commit

- Steps: hoàn thành M1; giả lập client không nhận response rồi gọi lại.
- Request: như M1.
- Expected HTTP/envelope: `200 PAYMENT_ALREADY_COMPLETED`.
- Expected database: đúng một payment, Contract, history và một lần debit/credit.
- Expected realtime: retry không emit.
- Common failures: xóa Contract thủ công sau lần đầu làm state cố ý inconsistent.

### Test M6 — Double click/concurrent payment

- Steps: gửi 2–5 request M1 đồng thời.
- Request: như M1.
- Expected HTTP/envelope: một `PAYMENT_COMPLETED`, các request sau
  `PAYMENT_ALREADY_COMPLETED`.
- Expected database: unique payment theo Job/cycle/Quote và unique Contract đều giữ;
  tổng debit chỉ bằng remaining.
- Expected realtime: mỗi loại event đúng một lần.
- Common failures: tool test không thực sự chạy song song.

### Test M7 — Rollback giữa transaction

- Steps: trên DB test gây lỗi tạo Contract/index sau bước wallet update.
- Request: như M1.
- Expected HTTP/envelope: lỗi 409/500 phù hợp.
- Expected database: wallet, Transaction, Contract, Job và history đều rollback.
- Expected realtime: không emit.
- Common failures: dùng lỗi xảy ra sau commit thay vì trong transaction.

## 8. Contract snapshot và privacy

### Test C1 — Đọc Contract

- Steps: sau M1, gọi bằng Customer, selected Handyman và Admin.
- Request: `GET /jobs/:jobId/contract`.
- Expected HTTP/envelope: `200 CONTRACT_RETRIEVED`.
- Expected database: không đổi; contract number khớp `TTC-YYYY-XXXXXXXXXXXX` và duy nhất.
- Expected realtime: không emit.
- Common failures: đọc Contract trước payment hoặc dùng cycle cũ.

### Test C2 — Outsider/Contract chưa tồn tại

- Steps: gọi C1 bằng outsider và trên Job `PAYMENT_PENDING`.
- Request: như C1.
- Expected HTTP/envelope: `404 CONTRACT_NOT_FOUND` trong cả hai trường hợp.
- Expected database/realtime: không đổi, không emit.
- Common failures: phân biệt message để suy luận Contract tồn tại; API cố ý dùng cùng 404.

### Test C3 — Snapshot bất biến

- Steps: lưu Contract DTO; trên DB test đổi User name, Job service address và dữ liệu
  Quote nguồn; đọc Contract lại.
- Request: như C1.
- Expected HTTP/envelope: `200`; snapshot tên/address/report/items/amount không đổi.
- Expected database: Contract không bị update; không có endpoint PUT/DELETE Contract.
- Expected realtime: không emit.
- Common failures: so sánh với generic Job Details thay vì Contract DTO.

### Test C4 — Contract number concurrency

- Steps: thanh toán nhiều Job khác nhau đồng thời trong cùng năm.
- Request: M1 cho từng Job.
- Expected database: mọi number có UUID suffix khác nhau; không dùng `COUNT(*)+1`;
  unique index không vi phạm.
- Common failures: tái sử dụng cùng Job chỉ đang test payment idempotency.

## 9. Cancellation tại PAYMENT_PENDING

### Test X1 — Auto resolve

- Steps: accept Quote; gọi cancellation bằng reason hợp lệ của Customer hoặc Handyman.
- Request: `POST /jobs/:jobId/cancellations` với policy giống `QUOTE_PENDING`.
- Expected HTTP/envelope: `201 CANCELLATION_RESOLVED`.
- Expected database: chỉ deposit được phân bổ; không remaining payment/Contract; Quote
  vẫn `ACCEPTED`; Job `CANCELLED`; conversation đóng.
- Expected realtime: event cancellation Task 2; không payment event.
- Common failures: mong payout theo Quote total thay vì deposit.

### Test X2 — Mutual/review

- Steps: thử `MUTUAL_AGREEMENT`, `OTHER` và reason disputed hợp lệ ở phase này.
- Request: như X1.
- Expected HTTP/envelope: awaiting/review theo Task 2.
- Expected database: Job `CANCELLATION_REVIEW`, deposit `HELD`, Bid `WON`, Quote
  `ACCEPTED`, Contract null, chat `ACTIVE`, không wallet transaction.
- Expected realtime: requested/review event phù hợp.
- Common failures: dùng reason chỉ hợp lệ ở EN_ROUTE.

### Test X3 — Payment và cancellation đồng thời

- Steps: gửi M1 và X1 đồng thời.
- Request: hai endpoint tương ứng.
- Expected HTTP/envelope: Job lock cho đúng một action thắng.
- Expected database: hoặc `IN_PROGRESS` với full escrow/Contract, hoặc cancellation state
  không có remaining payment; không có hybrid.
- Expected realtime: chỉ event của nhánh thắng.
- Common failures: client tự retry action thua sau khi Job đã đổi phase.

## 10. Lifecycle details, chat và regression

### Test L1 — accepted-details và allowed actions

- Steps: gọi details ở `QUOTE_PENDING`, `PAYMENT_PENDING`, `CANCELLATION_REVIEW`,
  `IN_PROGRESS` bằng hai participant và Admin.
- Request: `GET /jobs/:jobId/accepted-details`.
- Expected HTTP/envelope: `200`; Quote/payment/Contract summary đúng; Customer và
  Handyman nhận actions theo phase; active cancellation override; Admin luôn `[]`.
- Expected database/realtime: không đổi, không emit.
- Common failures: dùng Job `CANCELLED`, vốn không thuộc accepted-details.

### Test L2 — Chat giữ nguyên

- Steps: ghi conversation ID/cycle/message count/read cursors; accept rồi pay; gửi tin ở
  `PAYMENT_PENDING` và `IN_PROGRESS`.
- Request: dùng API/socket chat hiện tại.
- Expected HTTP/envelope: chat hợp lệ; conversation không được tạo lại.
- Expected database: ID, cycle, lịch sử và cursors giữ nguyên; status `ACTIVE`.
- Expected realtime: chat event bình thường, độc lập lifecycle event.
- Common failures: cancellation resolve đã đóng chat là hành vi đúng.

### Test L3 — Privacy và audit tiền

- Steps: so sánh generic Job Details, accepted-details, payment summary, Contract và
  lifecycle event của bốn role.
- Expected: không lộ wallet bên kia, global escrow, payment gateway secret, idempotency
  key, raw GPS/evidence metadata; Admin chỉ đọc.
- Expected database: full escrow liability theo Job bằng deposit + remaining = Quote total;
  không payout Handyman; deposit vẫn `HELD`; Bid vẫn `WON`.
- Common failures: cộng global SYSTEM_ESCROW thay vì ledger riêng của Job.

### Test L4 — Regression Task 1/2

- Steps: submit Quote mới; cancellation tại EN_ROUTE/ARRIVED/QUOTE_PENDING; mutual
  confirm/reject; đọc evidence sau submit.
- Expected: contract/API cũ giữ nguyên; Customer vẫn xem BEFORE evidence khi Quote ở
  `SUBMITTED`, `ACCEPTED` hoặc `REJECTED`.
- Common failures: chỉ test happy path Task 3 mà bỏ qua refactor cancellation nội bộ.

## 11. Kiểm tra mã nguồn cuối

```powershell
Get-ChildItem -Recurse -Filter *.js src | ForEach-Object { node --check $_.FullName }
git diff --check
```

Không chạy `DB_SYNC_ALTER=true` nhiều lần. Task này không có migration, automated test,
frontend, PDF/OTP Contract, Quote revision, completion payout hay cancellation tại
`IN_PROGRESS`.
