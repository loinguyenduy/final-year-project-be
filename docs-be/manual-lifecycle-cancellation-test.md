# Hướng dẫn kiểm thử thủ công cancellation lifecycle

## 1. Mục tiêu và dữ liệu chuẩn bị

Tài liệu này kiểm tra cancellation tại `EN_ROUTE`, `ARRIVED` và `QUOTE_PENDING`. Không chạy trên production và không dùng dữ liệu ví thật.

Chuẩn bị:

- `BASE_URL=http://localhost:5000/api/v1/matchmaking`
- `CUSTOMER_TOKEN`, `HANDYMAN_TOKEN`, `OUTSIDER_TOKEN`, `ADMIN_TOKEN`
- Một Job riêng cho từng test, có `acceptance_cycle >= 1`, selected Bid `WON`, deposit `HELD`, deposit transaction `DEPOSIT_10/SUCCESS` và hai participant active.
- Ghi lại trước test: Job, Bid, deposit, wallet Customer/Handyman/SYSTEM_ESCROW, Transaction, Arrival Request, Quote, Evidence và Conversation.
- Không dùng lại Job đã resolve cho test mutation khác, trừ test retry/idempotency.

Response chuẩn có dạng `{ EM, EC, code, DT }`. Amount trong cancellation DTO là chuỗi VND nguyên.

## 2. Đồng bộ schema development đúng một lần

### Test S1 — Backup và sync alter

- Steps: backup database; dừng backend; đặt `DB_SYNC_ALTER=true`; khởi động đúng một lần; chờ log `Cancellation indexes verified successfully`; đặt lại `false`; restart.
- Request: N/A.
- Expected HTTP/envelope: N/A.
- Expected database: enum Job có `CANCELLATION_REVIEW`; deposit có `DISTRIBUTED`; cancellation/transaction có cột và index mới.
- Expected realtime: không có event.
- Common failures: duplicate active cancellation hoặc duplicate idempotency key; quên tắt alter; PostgreSQL enum chưa cập nhật.

### Test S2 — Kiểm tra cột và index

- Steps: chạy SQL bằng account chỉ đọc.
- Request: N/A.
- Expected database: các cột nullable mới tồn tại; hai unique index đúng điều kiện.
- Common failures: chạy nhầm schema hoặc bỏ dấu ngoặc kép ở tên bảng chữ hoa.

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('Jobs', 'Job_Cancellations', 'Transactions')
ORDER BY table_name, ordinal_position;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'job_cancellations_one_active_per_cycle',
    'job_cancellations_job_cycle_status',
    'transactions_idempotency_key_unique',
    'transactions_cancellation_type'
  );

SELECT t.typname, e.enumlabel
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE e.enumlabel IN (
  'CANCELLATION_REVIEW', 'DISTRIBUTED', 'LIFECYCLE_CANCEL',
  'AWAITING_COUNTERPARTY', 'REVIEW_REQUIRED', 'RESOLVED', 'SUPERSEDED',
  'CANCELLATION_REFUND', 'CANCELLATION_COMPENSATION',
  'CANCELLATION_PLATFORM_FEE'
)
ORDER BY t.typname, e.enumsortorder;
```

## 3. Validation role, phase và payload

### Test V1 — Reason hợp lệ theo role/phase

- Steps: tạo Job mới cho từng nhóm và gửi reason dưới đây.
- Request: `POST /jobs/:jobId/cancellations` với body `{"reason":"<REASON>","reason_text":null}`.
- Expected HTTP/envelope: reason đúng trả `201`; reason sai phase/role trả `400 VALIDATION_ERROR`.
- Expected database: request sai không tạo cancellation/history/transaction và không đổi Job.
- Expected realtime: request sai không emit.
- Common failures: dùng token không phải selected Handyman; tái sử dụng Job đã cancel; gửi reason của API ACCEPTED cũ.

Ma trận cần kiểm tra:

- Customer, cả ba phase: `NO_LONGER_NEEDED`, `WRONG_JOB_INFORMATION`, `HANDYMAN_UNPROFESSIONAL`, `EXTERNAL_CIRCUMSTANCE`, `MUTUAL_AGREEMENT`, `OTHER`.
- Customer, ARRIVED/QUOTE_PENDING: `SCOPE_CHANGED`.
- Customer, QUOTE_PENDING: `FINAL_QUOTE_TOO_HIGH`, `FINAL_QUOTE_NOT_ACCEPTABLE`.
- Customer, EN_ROUTE/ARRIVED: `HANDYMAN_NOT_PROGRESSING`; riêng EN_ROUTE: `HANDYMAN_NOT_PRESENT`.
- Handyman, cả ba phase: `JOB_OUTSIDE_SKILL`, `EXTERNAL_CIRCUMSTANCE`, `MUTUAL_AGREEMENT`, `OTHER`.
- Handyman, ARRIVED/QUOTE_PENDING: `EQUIPMENT_OR_PART_UNAVAILABLE`, `UNSAFE_WORKING_CONDITION`, `JOB_SCOPE_MISMATCH`, `CUSTOMER_CHANGED_SCOPE`.
- Handyman, EN_ROUTE/ARRIVED: `CUSTOMER_UNAVAILABLE`, `WRONG_ADDRESS`, `CUSTOMER_REFUSED_ACCESS`.

### Test V2 — OTHER và text validation

- Steps: gửi `OTHER` thiếu/rỗng note; note 501 ký tự; sau đó note hợp lệ.
- Request: `{"reason":"OTHER","reason_text":"..."}`.
- Expected HTTP/envelope: hai request đầu `400 VALIDATION_ERROR`; request hợp lệ `201 CANCELLATION_REVIEW_REQUIRED`.
- Expected database: text hợp lệ được trim; Job chuyển `CANCELLATION_REVIEW`; deposit vẫn `HELD`.
- Expected realtime: chỉ request hợp lệ emit `JOB_CANCELLATION_REVIEW_REQUIRED`.
- Common failures: khoảng trắng được tính nhầm là nội dung; đếm ký tự trước khi trim.

### Test V3 — Client giả mạo policy

- Steps: lần lượt thêm `classification`, `resolution_mode`, `acceptance_cycle`, `refund_amount` hoặc `platform_amount` vào body.
- Request: POST create cancellation.
- Expected HTTP/envelope: `400 VALIDATION_ERROR`, nêu field không hỗ trợ.
- Expected database/wallet/chat: hoàn toàn không mutation.
- Expected realtime: không emit.
- Common failures: controller bỏ qua field lạ thay vì từ chối.

### Test V4 — Quyền và participant inactive

- Steps: outsider, Handyman không được chọn và Customer khác gọi API; sau đó deactivate một participant trên Job test khác.
- Expected HTTP/envelope: caller không thuộc Job nhận `403` khi create; GET current của outsider nhận `404`; participant inactive nhận `409 ACCEPTED_DATA_INCONSISTENT`.
- Expected database: không tạo cancellation/payout.
- Common failures: dùng Job mở BIDDING hoặc Bid không còn `WON`.

## 4. Auto-resolve và ma trận tiền

### Test A1 — Các nhánh auto-resolve

- Steps: dùng Job riêng và reason đại diện cho từng dòng; snapshot balance/transaction trước và sau.
- Request: POST create cancellation.
- Expected HTTP/envelope: `201 CANCELLATION_RESOLVED`; DTO `status=RESOLVED`, platform `0`.
- Expected database:
  - Job `CANCELLED`, selected IDs/cycle/giá giữ nguyên.
  - Bid thành `CANCELLED_BY_CUSTOMER` hoặc `CANCELLED_BY_HANDYMAN` theo requester.
  - Đúng một history sang `CANCELLED`.
  - SYSTEM_ESCROW giảm đúng toàn bộ deposit.
  - Transaction payout có `cancellation_id`, reference tới deposit gốc và idempotency key riêng.
- Expected chat: Conversation `CLOSED`, reason `JOB_CANCELLED`; ID, message và read cursors không đổi.
- Expected realtime: đúng một `JOB_CANCELLED` cho hai participant.
- Common failures: kiểm tra nhầm proposed price thay vì deposit; wallet Handyman MAIN chưa được tạo.

Các case bắt buộc:

| Phase/reason | Customer | Handyman | Deposit status |
|---|---:|---:|---|
| EN_ROUTE Customer `NO_LONGER_NEEDED` | 50% | 50% | DISTRIBUTED |
| EN_ROUTE Handyman `JOB_OUTSIDE_SKILL` | 100% | 0% | REFUNDED |
| EN_ROUTE `EXTERNAL_CIRCUMSTANCE` | 100% | 0% | REFUNDED |
| ARRIVED Customer fault | 30% | 70% | DISTRIBUTED |
| ARRIVED Handyman fault | 100% | 0% | REFUNDED |
| ARRIVED neutral | 50% | 50% | DISTRIBUTED |
| QUOTE_PENDING Customer fault | 30% | 70% | DISTRIBUTED |
| QUOTE_PENDING quote rejection | 70% | 30% | DISTRIBUTED |
| QUOTE_PENDING neutral | 50% | 50% | DISTRIBUTED |

### Test A2 — Làm tròn half-up

- Steps: chuẩn bị deposit `10001 VND` và chạy các policy.
- Expected database/DTO:
  - 50/50: Customer `5001`, Handyman `5000`.
  - 30/70: Customer `3000`, Handyman `7001`.
  - 70/30: Customer `7001`, Handyman `3000`.
  - Tổng luôn bằng `10001`; không có số thập phân hoặc platform amount khác 0.
- Common failures: dùng JavaScript floating-point, chia đồng lẻ cho platform hoặc làm tròn từng bên độc lập.

### Test A3 — Escrow/wallet lỗi phải rollback

- Steps: trên database test, lần lượt block wallet, xóa wallet đích hoặc đặt escrow thấp hơn deposit; gọi auto cancellation.
- Expected HTTP/envelope: `404` wallet-not-found hoặc `409 CANCELLATION_WALLET_BLOCKED`/`ESCROW_INSUFFICIENT_BALANCE`.
- Expected database: Job/Bid/cancellation/history/transaction/balance không đổi vì cùng transaction.
- Expected realtime: không emit.
- Common failures: quên phục hồi fixture hoặc chỉnh nhầm SYSTEM_ESCROW dùng chung.

## 5. Review và mutual agreement

### Test R1 — Disputed reason giữ cọc

- Steps: Customer gửi `HANDYMAN_NOT_PRESENT` tại EN_ROUTE hoặc Handyman gửi `UNSAFE_WORKING_CONDITION` tại ARRIVED.
- Expected HTTP/envelope: `201 CANCELLATION_REVIEW_REQUIRED`.
- Expected database: cancellation `REVIEW_REQUIRED/DISPUTED/ADMIN_REVIEW`; Job `CANCELLATION_REVIEW`; deposit `HELD`; Bid `WON`; không có payout transaction.
- Expected chat: Conversation vẫn `ACTIVE`, gửi tin nhắn được.
- Expected realtime: một `JOB_CANCELLATION_REVIEW_REQUIRED`, không chứa GPS/evidence/wallet.
- Common failures: vô tình gọi refund service cũ hoặc đóng conversation qua reconcile vì thiếu chat-valid status.

### Test R2 — Không có Admin resolve trong task này

- Steps: thử `POST /jobs/:jobId/cancellations/:id/admin-resolve` bằng Admin.
- Expected HTTP/envelope: `404` route not found.
- Expected database: review case giữ nguyên vô thời hạn; không có payout.
- Expected realtime: không emit.
- Common failures: nhầm GET audit của Admin với quyền resolve.

### Test M1 — Mutual confirm

- Steps: một participant tạo `MUTUAL_AGREEMENT`; xác nhận allowed actions; đối phương gọi confirm.
- Request: `POST /jobs/:jobId/cancellations/:id/confirm`, body rỗng.
- Expected create: `201 CANCELLATION_AWAITING_COUNTERPARTY`; Job `CANCELLATION_REVIEW`, deposit `HELD`, event `JOB_CANCELLATION_REQUESTED`.
- Expected confirm: `200 CANCELLATION_CONFIRMED`; neutral split của phase gốc; Job `CANCELLED`; conversation đóng; event `JOB_CANCELLED`.
- Expected database: hai history `phase → CANCELLATION_REVIEW → CANCELLED`; `cancelled_from_status` không đổi.
- Common failures: requester tự confirm; dùng status review thay cho phase gốc để tra policy.

### Test M2 — Mutual reject

- Steps: đối phương gọi reject với `{"response_note":"Không đồng ý điều kiện hủy"}`.
- Expected HTTP/envelope: `200 CANCELLATION_REJECTED_FOR_REVIEW`.
- Expected database: status `REVIEW_REQUIRED`, response `REJECTED`, note được trim; Job/cọc/Bid/chat giữ trạng thái review.
- Expected realtime: `JOB_CANCELLATION_REJECTED` và `JOB_CANCELLATION_REVIEW_REQUIRED`; không có `JOB_CANCELLED`.
- Common failures: reject trả Job về phase cũ hoặc đóng chat.

## 6. Idempotency và concurrency

### Test I1 — Double-click/retry create

- Steps: gửi hai request giống hệt gần đồng thời; sau commit gửi lại lần ba.
- Expected HTTP/envelope: một request tạo `201`; retry trả `200 CANCELLATION_ALREADY_EXISTS` với cùng ID.
- Expected database: một cancellation; tối đa một transaction cho mỗi transfer type; một lần thay đổi balance/history/event.
- Common failures: hai process chưa có partial index hoặc request dùng khác reason.

### Test I2 — Retry confirm/reject và action ngược

- Steps: confirm hai lần; ở Job khác reject hai lần; sau đó thử action ngược.
- Expected HTTP/envelope: retry cùng kết quả `200`; action ngược `409 CANCELLATION_RESPONSE_CONFLICT`.
- Expected database: response timestamp, payout và history không đổi ở retry.
- Expected realtime: retry không emit lại.
- Common failures: dùng lại cancellation của Job khác hoặc requester gọi response.

### Test I3 — Hai bên cancel đồng thời

- Steps: Customer và Handyman gửi cancellation đồng thời trên cùng Job/cycle.
- Expected HTTP/envelope: một request thắng; request còn lại `409 CANCELLATION_ALREADY_ACTIVE/RESOLVED`.
- Expected database: không duplicate payout; unique active index hợp lệ.
- Common failures: test tuần tự thay vì thực sự concurrent.

### Test I4 — Race với Arrival Confirm/Quote Submit

- Steps: gửi cancel đồng thời với Arrival Confirm; trên Job khác gửi cancel đồng thời Quote Submit.
- Expected: Job lock tuần tự hóa. Chỉ transition thắng được commit; action thua revalidate phase/status và trả lifecycle/validation conflict.
- Expected database: không có tổ hợp bất khả thi như Job CANCELLED nhưng Quote submit history/event mới, hoặc Job ARRIVED với cancellation active.
- Common failures: dùng hai Job khác nhau hoặc client retry làm nhiễu kết quả.

### Test I5 — Timeout sau commit

- Steps: mô phỏng client timeout sau khi backend commit rồi gửi lại cùng payload.
- Expected HTTP/envelope: retry `200` cùng cancellation ID.
- Expected database: idempotency key ngăn payout thứ hai; escrow chỉ giảm một lần.
- Common failures: timeout trước commit thực sự sẽ rollback và lần sau hợp lệ là create mới.

## 7. Arrival, Quote, Evidence, chat và privacy

### Test L1 — Pending Arrival Request

- Steps: tạo Arrival Request `PENDING` rồi request cancellation ở EN_ROUTE.
- Expected database: Arrival Request thành `SUPERSEDED`; lịch sử rejected/confirmed cũ giữ nguyên.
- Expected API: confirm Arrival cũ không thể chuyển Job khỏi `CANCELLATION_REVIEW/CANCELLED`.
- Common failures: xóa record thay vì supersede.

### Test L2 — Draft và Submitted Quote

- Steps: cancel/review Job ARRIVED có Draft; cancel Job QUOTE_PENDING có Submitted Quote.
- Expected database: review giữ Draft nhưng không update/submit được; resolve chuyển Draft thành `SUPERSEDED`; Submitted Quote/Items giữ nguyên.
- Expected read: selected Handyman/Admin vẫn đọc Draft audit; Customer chỉ đọc Submitted Quote.
- Common failures: supersede Draft ngay khi còn chờ mutual/review hoặc xóa items.

### Test L3 — Evidence và Cloudinary

- Steps: kiểm tra evidence trước/sau review và resolve.
- Expected database/Cloudinary: Evidence rows, hash, URL và asset không bị xóa; upload/delete mới bị khóa do Job không còn ARRIVED.
- Expected read: Customer chỉ thấy BEFORE khi Quote đã `SUBMITTED`; selected Handyman/Admin giữ quyền audit.
- Common failures: gọi Cloudinary destroy trong cancellation.

### Test C1 — Chat review và history sau cancel

- Steps: gửi message khi Job `CANCELLATION_REVIEW`; resolve ở Job mutual khác; lấy conversation và message history sau cancel; thử gửi message mới.
- Expected: review vẫn gửi được; sau resolve conversation DTO/history vẫn đọc được nhưng gửi/join mới trả `CONVERSATION_CLOSED`; message/read cursor không đổi.
- Common failures: thiếu `CANCELLATION_REVIEW` trong chat-valid status hoặc history dùng access check dành cho write.

### Test P1 — Privacy và audit

- Steps: gọi GET current/accepted-details/job details bằng Customer, selected Handyman, outsider và Admin.
- Expected:
  - Participant/Admin đọc cancellation hiện tại; outsider nhận 404.
  - Admin `allowed_actions=[]`.
  - Event/DTO không có wallet balance, transaction IDs, raw GPS, Cloudinary public ID hoặc metadata evidence nội bộ.
  - Raw Handyman GPS tiếp tục chỉ selected Handyman/Admin xem theo policy hiện tại.
- Common failures: generic Job include toàn bộ Cancellation model hoặc socket emit nguyên Sequelize instance.

## 8. Regression ACCEPTED và kiểm tra cuối

### Test G1 — Cancellation ACCEPTED cũ

- Steps: chạy lại Customer `cancel-by-customer` với `REOPEN_BIDDING/CANCEL_JOB` và Handyman `cancel-by-handyman`.
- Expected: endpoint, reason list, refund `DEPOSIT_REFUND`, reopen Bid và counter hiện tại không đổi.
- Expected new API: POST `/cancellations` ở ACCEPTED trả `409 CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS`.
- Common failures: record legacy không insert được vì cột mới vô tình `NOT NULL` hoặc unique index áp vào cycle null.

### Test G2 — Kiểm tra tĩnh

- Steps:

```powershell
git diff --check
$files = git diff --name-only -- '*.js'
foreach ($file in $files) { node --check $file }
```

- Expected: tất cả exit code 0.
- Expected database/realtime: không mutation/event.
- Common failures: chạy từ sai repository hoặc gồm file JavaScript đã xóa.

Sau khi hoàn tất, giữ `DB_SYNC_ALTER=false`. Không backfill cancellation legacy và không tạo migration/automated test trong task này.
