# Hướng dẫn kiểm thử thủ công EN_ROUTE → ARRIVED

Tài liệu này kiểm tra backend cho luồng `ACCEPTED → EN_ROUTE → ARRIVED`. Toàn bộ thao tác là kiểm thử thủ công bằng PostgreSQL, Postman và Socket.IO client. Task không thêm migration hoặc automated test.

## 1. Quy tắc an toàn trước khi test

1. Sao lưu database development.
2. Không chạy các case tài chính trên database production.
3. Chỉ bật `DB_SYNC_ALTER=true` trong một lần khởi động để đồng bộ schema.
4. Sau khi schema hoàn tất, đặt lại `DB_SYNC_ALTER=false` và restart backend.
5. Không sửa trực tiếp trạng thái Job trong lúc test concurrency, trừ bước chuẩn bị dữ liệu được ghi rõ.
6. Customer reject Arrival Request chỉ là chưa xác nhận Handyman đã đến. Reject không được hủy Job, refund/chia cọc, đóng chat, thay selected Handyman hoặc đưa Job về `BIDDING`.

Các biến lifecycle cần có trong `.env`:

```env
HANDYMAN_ESTIMATED_SPEED_KMH=25
HANDYMAN_ETA_BUFFER_MINUTES=5
HANDYMAN_MAX_ETA_MINUTES=1440
ARRIVAL_DISTANCE_WARNING_METERS=500
ARRIVAL_REQUEST_COOLDOWN_SECONDS=60
ARRIVAL_MAX_REJECTIONS_PER_CYCLE=3
```

## 2. Đồng bộ và kiểm tra schema

### 2.1. Đồng bộ một lần

Các bước:

1. Đặt `DB_SYNC_ALTER=true`.
2. Chạy backend bằng `npm start` hoặc `npm run dev`.
3. Chờ log `All models were synchronized successfully with alter mode.`.
4. Xác nhận log `Arrival request indexes verified successfully.`.
5. Dừng server, đặt `DB_SYNC_ALTER=false`, sau đó khởi động lại.

Kết quả mong đợi:

- Server khởi động thành công.
- Không có migration file mới.
- Không để `DB_SYNC_ALTER=true` trong các lần chạy bình thường.

Nguyên nhân lỗi thường gặp:

- Database user không có quyền `ALTER/CREATE`.
- Database chưa backup.
- Partial unique index không được tạo hoặc tên table sai.
- Có schema cũ không tương thích với enum mới.

### 2.2. Kiểm tra cột Jobs

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'Jobs'
  AND column_name IN (
    'en_route_at',
    'en_route_gps_lat',
    'en_route_gps_long',
    'en_route_gps_accuracy_meters',
    'en_route_distance_meters',
    'en_route_estimated_arrival_minutes',
    'arrived_at',
    'arrival_confirmed_by_user_id'
  )
ORDER BY column_name;
```

Mong đợi: có đủ tám cột; các cột mới nullable để hỗ trợ Job legacy.

### 2.3. Kiểm tra bảng và index Arrival Request

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'Job_Arrival_Requests'
ORDER BY ordinal_position;
```

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND tablename = 'Job_Arrival_Requests'
ORDER BY indexname;
```

Mong đợi:

- Có index `job_arrival_requests_one_pending_per_cycle`.
- Index là `UNIQUE`, gồm `job_id`, `acceptance_cycle` và có điều kiện `status = 'PENDING'`.

Kiểm tra không có duplicate pending:

```sql
SELECT job_id, acceptance_cycle, COUNT(*)
FROM "Job_Arrival_Requests"
WHERE status = 'PENDING'
GROUP BY job_id, acceptance_cycle
HAVING COUNT(*) > 1;
```

Mong đợi: không có row.

## 3. Chuẩn bị tài khoản và dữ liệu

Tạo Postman Environment:

```text
base_url=http://localhost:5000/api/v1
customer_token=<access token Customer owner>
handyman_token=<access token selected Handyman>
outsider_token=<access token Handyman khác>
admin_token=<access token Admin>
job_id=<Job ACCEPTED>
arrival_request_id=<điền sau khi tạo request>
conversation_id=<conversation hiện tại>
```

Job chính phải có:

- `current_status='ACCEPTED'`;
- `acceptance_cycle >= 1`;
- `selected_handyman_id` đúng Handyman test;
- `selected_bid_id` trỏ tới Bid `WON`;
- `deposit_status='HELD'`;
- deposit transaction `DEPOSIT_10/SUCCESS` và tiền nằm ở `SYSTEM_ESCROW`;
- Customer và Handyman active;
- conversation của cycle hiện tại đang `ACTIVE` nếu đã mở chat.

SQL kiểm tra:

```sql
SELECT
  j.id,
  j.current_status,
  j.acceptance_cycle,
  j.customer_id,
  j.selected_handyman_id,
  j.selected_bid_id,
  j.deposit_status,
  j.deposit_transaction_id,
  j.gps_lat,
  j.gps_long,
  b.status AS bid_status,
  t.transaction_type,
  t.status AS transaction_status,
  t.amount AS transaction_amount
FROM "Jobs" j
LEFT JOIN "Bids" b ON b.id = j.selected_bid_id
LEFT JOIN "Transactions" t ON t.id = j.deposit_transaction_id
WHERE j.id = '<job_id>';
```

Chụp snapshot trước test reject/cancellation:

```sql
SELECT id, current_status, acceptance_cycle, selected_handyman_id,
       selected_bid_id, deposit_status, deposit_amount
FROM "Jobs"
WHERE id = '<job_id>';

SELECT id, wallet_type, balance, is_blocked
FROM "Wallets"
WHERE wallet_type = 'SYSTEM_ESCROW' AND user_id IS NULL;

SELECT COUNT(*) AS refund_count
FROM "Transactions"
WHERE job_id = '<job_id>'
  AND transaction_type IN ('REFUND', 'DEPOSIT_REFUND');

SELECT id, acceptance_cycle, status, last_message_at,
       customer_last_read_message_id, handyman_last_read_message_id
FROM "Conversations"
WHERE job_id = '<job_id>'
ORDER BY acceptance_cycle;

SELECT COUNT(*) AS message_count
FROM "Messages"
WHERE conversation_id = '<conversation_id>';
```

## 4. Start Moving

### Case SM-01 — Selected Handyman bắt đầu di chuyển

Request:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/start-moving
Authorization: Bearer {{handyman_token}}
Content-Type: application/json

{
  "gps_lat": 21.028511,
  "gps_long": 105.804817,
  "gps_accuracy_meters": 25
}
```

Mong đợi HTTP/envelope:

- HTTP `200`, `EC=0`, `code=EN_ROUTE_STARTED`.
- `DT.status=EN_ROUTE`.
- Có `en_route.started_at`, distance meters/km, ETA và accuracy.

Mong đợi database:

- Job chuyển `EN_ROUTE` đúng một lần.
- GPS snapshot, distance, ETA và `en_route_at` được lưu.
- Có đúng một history `ACCEPTED → EN_ROUTE`, changed by Handyman.
- Deposit vẫn `HELD`, Bid vẫn `WON`, acceptance cycle không đổi.

Realtime: Customer nhận đúng một event `JOB_EN_ROUTE`, không có raw GPS.

Nguyên nhân lỗi thường gặp: token không thuộc selected Handyman, Bid/deposit không nhất quán, participant inactive hoặc Job chưa `ACCEPTED`.

### Case SM-02 — Kiểm tra công thức ETA

Các bước:

1. Lấy `en_route_distance_meters` từ DB.
2. Tính tay:

```text
ceil((distance_meters / 1000) / 25 * 60) + 5
```

3. Clamp tối đa 1.440 phút.

Mong đợi: kết quả bằng `en_route_estimated_arrival_minutes`. Distance 0 cho ETA 5 phút.

### Case SM-03 — Job có tọa độ nhưng thiếu GPS Handyman

Request body `{}`.

Mong đợi:

- HTTP `400`, code `HANDYMAN_LOCATION_REQUIRED`.
- Job vẫn `ACCEPTED`; không có history/event mới.

### Case SM-04 — Job ADDRESS_ONLY không có tọa độ

Dùng một Job ACCEPTED có `gps_lat/gps_long=NULL`, gọi Start Moving với `{}`.

Mong đợi:

- HTTP `200 EN_ROUTE_STARTED`.
- GPS, distance và ETA snapshot là `NULL`.
- Job vẫn chuyển `EN_ROUTE` và có history.

### Case SM-05 — Validation GPS

Lần lượt gửi:

- chỉ có latitude;
- chuỗi rỗng;
- `NaN`/`Infinity` qua client có khả năng gửi;
- latitude ngoài `[-90,90]`;
- longitude ngoài `[-180,180]`;
- accuracy âm;
- accuracy nhưng không có cặp tọa độ;
- tọa độ bằng `0`.

Mong đợi: dữ liệu sai trả `400 INVALID_COORDINATES`; tọa độ `0` được chấp nhận.

### Case SM-06 — Retry và concurrent request

Các bước:

1. Gửi lại request SM-01 sau khi Job đã `EN_ROUTE`.
2. Với Job ACCEPTED mới, mở hai Postman tab và gửi gần như đồng thời.

Mong đợi:

- Retry: `200 EN_ROUTE_ALREADY_STARTED`, snapshot không đổi và không emit lại.
- Concurrent: một request transition; request còn lại nhận idempotent success.
- Chỉ một history EN_ROUTE.

### Case SM-07 — Actor/status/invariant sai

Test Customer token, outsider token, Job BIDDING/ARRIVED, Bid không WON, deposit không HELD và participant inactive.

Mong đợi: `403` cho actor sai; `409` cho lifecycle/invariant; không mutation và không event.

## 5. Arrival Request

### Case AR-01 — Tạo request hợp lệ

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/arrival-requests
Authorization: Bearer {{handyman_token}}
Content-Type: application/json

{
  "gps_lat": 21.028700,
  "gps_long": 105.805100,
  "gps_accuracy_meters": 30
}
```

Mong đợi:

- HTTP `201`, code `ARRIVAL_REQUEST_CREATED`.
- Job vẫn `EN_ROUTE`.
- Có một request `PENDING` đúng Job/cycle/participants.
- Distance và warning được lưu; khoảng cách trên 500 m là `FAR_FROM_JOB` nhưng không bị chặn.
- Customer nhận `JOB_ARRIVAL_REQUESTED`; event không có raw GPS.

Lưu `DT.arrival_request.id` vào `arrival_request_id`.

### Case AR-02 — Duplicate pending

Gửi lại AR-01 khi request còn PENDING.

Mong đợi:

- HTTP `200 ARRIVAL_REQUEST_EXISTS`.
- Trả request cũ, không ghi đè GPS/timestamp.
- Không tạo row/event thứ hai.

### Case AR-03 — GPS và Job legacy

- Job có tọa độ, body `{}`: `400 HANDYMAN_LOCATION_REQUIRED`.
- Job không tọa độ, body `{}`: tạo thành công, distance `NULL`, warning `LOCATION_UNAVAILABLE`.
- Job EN_ROUTE cũ thiếu snapshot ETA/distance: vẫn được tạo Arrival Request nếu các invariant còn đúng.

### Case AR-04 — Actor/status sai

Customer, outsider, Job chưa EN_ROUTE hoặc participant inactive gọi endpoint.

Mong đợi: `403` hoặc `409`; không tạo request/event.

## 6. Customer reject và giới hạn reject

### Case RJ-01 — Reject hợp lệ

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/arrival-requests/{{arrival_request_id}}/reject
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{
  "reason": "HANDYMAN_NOT_PRESENT"
}
```

Mong đợi:

- HTTP `200`, code `ARRIVAL_REJECTED`.
- Request thành `REJECTED`, có `responded_at/responded_by_user_id`.
- `arrival_policy.rejection_count=1`, cooldown khoảng 60 giây.
- Handyman nhận `JOB_ARRIVAL_REJECTED`.
- Không có Job Status History mới.

SQL chứng minh reject không ảnh hưởng nghiệp vụ:

```sql
SELECT current_status, acceptance_cycle, selected_handyman_id,
       selected_bid_id, deposit_status, arrived_at
FROM "Jobs"
WHERE id = '<job_id>';
```

Mong đợi: `EN_ROUTE`, cycle/selected IDs giữ nguyên, deposit `HELD`, `arrived_at=NULL`.

Chạy lại các SQL snapshot Wallet/Transaction/Conversation/Message ở mục 3. Mong đợi:

- balance escrow không đổi;
- không có refund transaction mới;
- Bid vẫn `WON`;
- conversation vẫn `ACTIVE`, ID/cycle/read cursor/message count không đổi;
- Customer và Handyman vẫn gửi/nhận chat được.

### Case RJ-02 — Reason validation

Test bốn reason hợp lệ. Với `OTHER`, thiếu/rỗng hoặc note dài hơn 500 ký tự phải trả `400 VALIDATION_ERROR`. Reason `ARRIVAL_REQUEST_SENT_BY_MISTAKE` cũ phải bị từ chối.

### Case RJ-03 — Retry reject

Gửi lại đúng endpoint/request đã reject.

Mong đợi:

- HTTP `200 ARRIVAL_ALREADY_REJECTED`.
- Rejection count không tăng, reason/timestamp không bị ghi đè.
- Không emit lần hai.

### Case RJ-04 — Cooldown

Handyman gửi request mới ngay sau reject.

Mong đợi: HTTP `409 ARRIVAL_REQUEST_COOLDOWN`, có `retry_after_seconds`; không tạo row/event. Sau 60 giây request mới được tạo.

### Case RJ-05 — Ba lần reject và review required

Lặp quy trình tạo request → Customer reject ba lần trong cùng cycle, chờ cooldown giữa các lần.

Mong đợi sau lần thứ ba:

- Job vẫn `EN_ROUTE`, deposit `HELD`, Bid `WON`, chat `ACTIVE`.
- `rejection_count=3`, `max_rejections=3`, `review_required=true`.
- Không tự động cancellation/refund/penalty/dispute.
- Lifecycle details của Handyman có `WAIT_ARRIVAL_REVIEW`, không có `REQUEST_ARRIVAL`.

Request thứ tư:

- HTTP `409 ARRIVAL_REVIEW_REQUIRED`.
- Không có row/event mới.

### Case RJ-06 — Count độc lập theo acceptance cycle

Sau khi có cycle mới bằng flow hợp lệ trong tương lai/dev fixture:

- request PENDING cycle cũ thành `SUPERSEDED`;
- rejection count cycle mới bắt đầu từ 0;
- snapshot EN_ROUTE/ARRIVED cũ được reset;
- không xóa lịch sử cycle cũ.

## 7. Customer confirm

### Case CF-01 — Confirm hợp lệ

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/arrival-requests/{{arrival_request_id}}/confirm
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{}
```

Mong đợi:

- HTTP `200 ARRIVAL_CONFIRMED`.
- Request thành `CONFIRMED`.
- Job chuyển `ARRIVED`, có `arrived_at` và `arrival_confirmed_by_user_id`.
- Có đúng một history `EN_ROUTE → ARRIVED` do Customer thực hiện.
- Deposit/Bid/selected IDs/cycle không đổi.
- Customer và Handyman nhận `JOB_ARRIVED`.
- Conversation vẫn ACTIVE và chat tiếp tục hoạt động.

### Case CF-02 — Retry confirm

Mong đợi `200 ARRIVAL_ALREADY_CONFIRMED`, không đổi timestamp/history và không emit lại.

### Case CF-03 — Request sai

Test Handyman/outsider, request thuộc Job khác, cycle cũ, request REJECTED và participant inactive.

Mong đợi: `403`, `404` hoặc `409`; không chuyển ARRIVED.

### Case CF-04 — Confirm và reject đồng thời

Gửi confirm/reject cùng request gần như đồng thời.

Mong đợi:

- Chỉ một action commit.
- Nếu confirm thắng: Job ARRIVED, request CONFIRMED.
- Nếu reject thắng: Job EN_ROUTE, request REJECTED.
- Action còn lại nhận lifecycle conflict; không có trạng thái lai.

## 8. Cancellation bị khóa tại EN_ROUTE/ARRIVED

### Case CA-01 — Customer cancellation tại EN_ROUTE

Gọi cả action `REOPEN_BIDDING` và `CANCEL_JOB` trên endpoint cancellation hiện có.

Mong đợi:

```json
{
  "EC": 409,
  "code": "CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS",
  "DT": { "current_status": "EN_ROUTE" }
}
```

### Case CA-02 — Handyman cancellation tại EN_ROUTE

Mong đợi cùng error ổn định. Không refund, không Job Cancellation, không history, không đóng chat.

### Case CA-03 — Cancellation tại ARRIVED

Lặp lại với Customer và Handyman sau confirm.

Mong đợi `409 CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS` với `current_status=ARRIVED`.

Sau mỗi case, chạy lại snapshot mục 3 để chứng minh Job, deposit, selected IDs, escrow, conversation và messages không đổi.

## 9. Lifecycle details, allowed actions và privacy

```http
GET {{base_url}}/matchmaking/jobs/{{job_id}}/accepted-details
Authorization: Bearer <token>
```

Kiểm tra:

- Handyman ACCEPTED: `START_MOVING`, `CANCEL_ACCEPTED_JOB`.
- Customer ACCEPTED: `REOPEN_BIDDING`, `CANCEL_JOB`.
- Handyman EN_ROUTE không pending/cooldown/review: `REQUEST_ARRIVAL`.
- Handyman pending: `WAIT_ARRIVAL_CONFIRMATION`.
- Customer pending: `CONFIRM_ARRIVAL`, `REJECT_ARRIVAL`.
- Handyman cooldown: `WAIT_ARRIVAL_COOLDOWN`.
- Handyman đủ ba reject: `WAIT_ARRIVAL_REVIEW`.
- EN_ROUTE/ARRIVED không trả action cancellation.
- ARRIVED: không có arrival action.
- Admin: `allowed_actions=[]`.

Privacy:

- Selected Handyman và Admin thấy raw EN_ROUTE/arrival GPS.
- Customer chỉ thấy distance, accuracy, timestamp, warning; không thấy raw Handyman GPS.
- Outsider không đọc accepted-details.
- Customer Job list và generic Job Details không lộ `en_route_gps_lat/long`.
- History `HANDYMAN_STARTED_MOVING` không lộ trigger GPS cho Customer/outsider.
- Find Job không lộ bất kỳ GPS Handyman nào.

## 10. Realtime và chat

Kết nối Socket.IO bằng access token trong auth payload:

```json
{
  "token": "<access token>"
}
```

Server tự join `user:<userId>`; client không cần emit join cho lifecycle event. Đăng ký listener:

```text
JOB_EN_ROUTE
JOB_ARRIVAL_REQUESTED
JOB_ARRIVAL_REJECTED
JOB_ARRIVED
```

Mong đợi:

- Chỉ đúng participant nhận event.
- Không event nào có raw GPS.
- Retry idempotent không emit lại.
- Ngắt Socket.IO hoặc giả lập gateway chưa khởi tạo không rollback DB.
- Chat room hiện tại không bị leave/evict khi EN_ROUTE, reject hoặc ARRIVED.

Nếu Postman Socket.IO không hỗ trợ `auth.token`, dùng Socket.IO client hiện có của dự án để kết nối; Bearer header hoặc query token không thay thế đúng contract socket hiện tại.

## 11. Kiểm tra rollback và audit cuối

Kiểm tra history:

```sql
SELECT id, old_status, new_status, reason, changed_by_user_id,
       trigger_gps_lat, trigger_gps_long, "createdAt"
FROM "Job_Status_Histories"
WHERE job_id = '<job_id>'
ORDER BY "createdAt";
```

Kiểm tra Arrival Requests:

```sql
SELECT id, acceptance_cycle, status, handyman_id, customer_id,
       distance_to_job_meters, location_warning,
       requested_at, responded_at, responded_by_user_id,
       rejection_reason, rejection_reason_text
FROM "Job_Arrival_Requests"
WHERE job_id = '<job_id>'
ORDER BY requested_at;
```

Failure cases cần thực hiện:

- participant bị inactive;
- cycle/request cũ;
- selected Handyman thay đổi;
- deposit/Bid inconsistent;
- database error trước commit;
- socket emit lỗi sau commit;
- server restart khi request đang PENDING;
- retry HTTP sau timeout mạng.

Mong đợi chung:

- Lỗi trước commit rollback toàn bộ mutation.
- Emit lỗi sau commit không rollback nghiệp vụ.
- Server restart không mất pending request/cooldown/rejection count.
- Không có duplicate transition hoặc duplicate pending request.
- Không có refund/cancellation/penalty ngoài các task được phép.

## 12. Checklist nghiệm thu

- [ ] Schema mới và partial unique index đã được tạo; `DB_SYNC_ALTER=false`.
- [ ] Start Moving lưu GPS/accuracy/distance/ETA đúng một lần.
- [ ] Job không tọa độ vẫn EN_ROUTE với distance/ETA null.
- [ ] Duplicate/concurrent Start Moving idempotent.
- [ ] Arrival Request giữ Job EN_ROUTE khi PENDING/REJECTED.
- [ ] Confirm là action duy nhất chuyển Job ARRIVED.
- [ ] Reject không đổi Job/deposit/Bid/selected participants/chat.
- [ ] Sau ba reject, request thứ tư bị chặn bởi `ARRIVAL_REVIEW_REQUIRED`.
- [ ] Cancellation EN_ROUTE/ARRIVED luôn trả lifecycle error ổn định và không mutation.
- [ ] Realtime chỉ emit sau commit và không chứa raw GPS.
- [ ] Raw GPS Handyman được mask đúng role.
- [ ] Conversation ID/cycle/history/read cursor không đổi.
- [ ] Không có frontend, migration hoặc automated test mới.
