# Hướng dẫn kiểm thử toàn bộ backend chat

## 1. Mục đích và cảnh báo

`manualChatTest` là script xác minh development, không phải automated test framework. Script sử dụng server và dữ liệu PostgreSQL thật.

Không chạy trong production và không dùng job/account development quan trọng. Bước lifecycle cuối có thể:

- đổi job từ `ACCEPTED` về `BIDDING`;
- hủy bid đang chọn;
- tạo giao dịch refund;
- đóng conversation vĩnh viễn của cycle đó.

Nên backup database trước lần sync schema đầu tiên.

## 2. Tổng quan thứ tự thực hiện

Thực hiện đúng thứ tự:

1. Kiểm tra package chat đã cài.
2. Backup database.
3. Bật `DB_SYNC_ALTER=true` và khởi động server một lần để đồng bộ model.
4. Kiểm tra indexes.
5. Chạy backfill cho job legacy.
6. Tắt `DB_SYNC_ALTER`.
7. Chuẩn bị account, token và hai job test.
8. Test REST bằng Postman.
9. Test Socket.IO bằng script tự động hoặc Postman Desktop.
10. Chạy tùy chọn inactive-account.
11. Chạy tùy chọn lifecycle/refund cuối cùng.
12. Audit database bằng SQL.

## 3. Đồng bộ schema

Chat sử dụng:

```text
socket.io          dependency runtime
socket.io-client   devDependency cho manualChatTest
```

Kiểm tra:

```powershell
npm ls socket.io socket.io-client --depth=0
```

Backup PostgreSQL, sau đó sửa `.env` tạm thời:

```env
DB_SYNC_ALTER=true
```

Khởi động:

```powershell
npm start
```

Kết quả mong đợi trong log:

```text
Connection to PostgreSQL has been established successfully.
DB_SYNC_ALTER=true: synchronizing model changes with alter mode.
All models were synchronized successfully with alter mode.
Chat conversation indexes verified successfully.
Server running on port ...
```

Startup sẽ dừng nếu thiếu unique `(job_id, acceptance_cycle)`. Nếu partial unique ACTIVE không được tạo, server ghi cảnh báo rõ:

```text
conversations_one_active_per_job
```

Không bỏ qua lỗi unique bắt buộc. Nếu partial index lỗi do dữ liệu trùng, audit và xử lý conversation development bị trùng trước khi chạy lại. Không tạo migration SQL trong task này.

Sau khi sync thành công, dừng server và đổi lại:

```env
DB_SYNC_ALTER=false
```

Khởi động lại server bình thường. Startup vẫn kiểm tra indexes chat ngay cả khi alter đã tắt.

### 3.1. Kiểm tra columns

Chạy trong pgAdmin/DBeaver:

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('Jobs', 'Conversations', 'Messages')
  AND column_name IN (
    'acceptance_cycle', 'job_id', 'customer_id', 'handyman_id',
    'selected_bid_id', 'status', 'closed_at', 'closed_reason',
    'closed_by_user_id', 'last_message_at',
    'customer_last_read_message_id', 'customer_last_read_at',
    'handyman_last_read_message_id', 'handyman_last_read_at',
    'conversation_id', 'sender_id', 'client_message_id', 'content'
  )
ORDER BY table_name, ordinal_position;
```

### 3.2. Kiểm tra indexes

```sql
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND tablename IN ('Conversations', 'Messages')
ORDER BY tablename, indexname;
```

Bắt buộc thấy:

```text
conversations_job_acceptance_cycle_unique
conversations_one_active_per_job
messages_idempotency_unique
messages_conversation_page_idx
```

Trong `indexdef`:

- cycle index phải có `UNIQUE (job_id, acceptance_cycle)`;
- ACTIVE index phải có `UNIQUE (job_id)` và `WHERE ... status ... ACTIVE`;
- message idempotency phải gồm `(conversation_id, sender_id, client_message_id)`.

## 4. Backfill job legacy

Script chỉ xem xét job có:

- `acceptance_cycle=0`;
- trạng thái `ACCEPTED`, `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS` hoặc `WARRANTY`;
- customer và selected handyman đúng role;
- selected bid tồn tại, thuộc job, handyman khớp và status `WON`;
- deposit transaction thành công, thuộc job và đúng số tiền;
- tiền cọc đang `HELD` trong system escrow.

Script không sửa dữ liệu tài chính và không suy đoán dữ liệu thiếu.

Chạy trong PowerShell:

```powershell
$env:BACKFILL_ACCEPTANCE_CYCLE_CONFIRM='true'
npm run chat:backfill-cycle
Remove-Item Env:BACKFILL_ACCEPTANCE_CYCLE_CONFIRM
```

Output:

```text
[UPDATED] job_id=... acceptance_cycle=1 conversations=...
[SKIPPED] job_id=... reason=...
[SUMMARY] candidates=... updated=... skipped=...
```

Chạy lại lần hai phải không tăng cycle thêm. Script chỉ update record còn cycle `0` và từ chối chạy khi `NODE_ENV=production`.

Audit nhanh:

```sql
SELECT id, current_status, acceptance_cycle, customer_id,
       selected_handyman_id, selected_bid_id, deposit_transaction_id
FROM "Jobs"
WHERE current_status IN ('ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'WARRANTY')
ORDER BY "updatedAt" DESC;
```

Job hợp lệ trong các trạng thái trên không được còn cycle `0`.

## 5. Chuẩn bị dữ liệu test

Chuẩn bị ba account active:

| Tài khoản | Mục đích |
|---|---|
| Customer A | Chủ job và participant chat |
| Handyman B | Selected handyman của job |
| Outsider C | Customer/handyman không thuộc job, dùng kiểm tra chống lộ dữ liệu |

Chuẩn bị hai job:

### 5.1. Main job

- thuộc Customer A;
- selected handyman là Handyman B;
- trạng thái nằm trong danh sách cho phép chat;
- `acceptance_cycle >= 1`;
- selected bid `WON` và deposit hợp lệ;
- dùng để test conversation, message, duplicate, conflict, read, rate-limit và inactive.

Không hủy main job nếu muốn giữ conversation để frontend tiếp tục phát triển.

### 5.2. Lifecycle job

- là job disposable riêng;
- thuộc cùng Customer A và Handyman B để dùng lại token;
- nên đang `ACCEPTED`;
- có deposit `HELD` hợp lệ;
- không có dữ liệu development quan trọng.

Job này chỉ dùng ở bước cuối để test refund, `conversation:closed` và room eviction.

Có thể dùng luồng trong `docs/accepted-job-postman.md` để tạo job, bid, chọn bid và thanh toán cọc.

## 6. Biến môi trường cho manualChatTest

Bắt buộc:

```env
CHAT_TEST_SERVER_URL=http://localhost:5000
CHAT_TEST_CUSTOMER_TOKEN=<access-token-customer-a>
CHAT_TEST_HANDYMAN_TOKEN=<access-token-handyman-b>
CHAT_TEST_OUTSIDER_TOKEN=<access-token-outsider-c>
CHAT_TEST_JOB_ID=<main-job-uuid>
```

Tùy chọn test inactive bằng DB mutation:

```env
CHAT_TEST_ALLOW_DB_MUTATION=true
CHAT_TEST_INACTIVE_USER_ID=<uuid-customer-a-hoặc-handyman-b>
```

Tùy chọn test lifecycle/refund:

```env
CHAT_TEST_CONFIRM_LIFECYCLE_MUTATION=true
CHAT_TEST_LIFECYCLE_JOB_ID=<disposable-lifecycle-job-uuid>
```

Không commit token vào Git. Script không in token ra console.

## 7. Test REST thủ công bằng Postman

Giả sử Postman environment có:

```text
base_url = http://localhost:5000/api/v1
customer_token
handyman_token
outsider_token
job_id
conversation_id
```

### Case REST-01: GET không tạo conversation

Gọi trước khi POST:

```http
GET {{base_url}}/chat/jobs/{{job_id}}/conversation
Authorization: Bearer {{customer_token}}
```

Nếu chưa có conversation, mong đợi `404 CONVERSATION_NOT_FOUND`. Kiểm tra database không xuất hiện record mới.

### Case REST-02: Customer tạo conversation

```http
POST {{base_url}}/chat/jobs/{{job_id}}/conversation
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{}
```

Mong đợi:

```text
HTTP 201
EC=0
code=CONVERSATION_CREATED
DT.created=true
```

Lưu `DT.conversation.id` vào `conversation_id`.

### Case REST-03: Idempotent retry

Gửi lại đúng POST bằng customer rồi handyman.

Mong đợi cả hai lần:

```text
HTTP 200
code=CONVERSATION_EXISTS
DT.created=false
conversation ID không đổi
```

SQL phải chỉ có một record cho `(job_id, acceptance_cycle)`.

### Case REST-04: DTO và unread count

```http
GET {{base_url}}/chat/jobs/{{job_id}}/conversation
Authorization: Bearer {{handyman_token}}
```

Kiểm tra partner chỉ có `id`, `full_name`, `avatar_url`, `role`. `unread_count` ban đầu thường bằng `0`; GET không thay đổi read cursor.

### Case REST-05: Outsider không được biết conversation tồn tại

Gọi POST/GET job và GET history bằng `outsider_token`.

```http
GET {{base_url}}/chat/conversations/{{conversation_id}}/messages?limit=30
Authorization: Bearer {{outsider_token}}
```

Mong đợi `404 CONVERSATION_NOT_FOUND`, không phải `403`.

### Case REST-06: Validation history

```http
GET {{base_url}}/chat/conversations/{{conversation_id}}/messages?limit=0
GET {{base_url}}/chat/conversations/{{conversation_id}}/messages?limit=51
GET {{base_url}}/chat/conversations/{{conversation_id}}/messages?cursor=not-valid
```

Mong đợi:

- limit ngoài `1..50`: `400 VALIDATION_ERROR`;
- cursor giả: `400 INVALID_CURSOR`.

### Case REST-07: Pagination

Sau khi đã có trên 30 message:

1. GET `?limit=30`.
2. Kiểm tra message trong page theo cũ → mới.
3. Lấy `next_cursor` trả về, không decode hoặc sửa nó.
4. GET `?limit=30&cursor={{next_cursor}}`.
5. Page thứ hai phải chứa các message cũ hơn page thứ nhất và không trùng ID.

## 8. Postman Desktop và giới hạn của handshake hiện tại

Postman Desktop có request type Socket.IO. Theo tài liệu chính thức, chọn New → Socket.IO, dùng URL bắt đầu bằng `ws://` hoặc `wss://`, nhập event name, thêm argument và bật tùy chọn **Ack** để xem acknowledgement.

```text
ws://localhost:5000
```

Tuy nhiên contract của project bắt buộc token nằm chính xác tại:

```js
socket.handshake.auth.token
```

Tài liệu Postman hiện mô tả Params, Headers và Settings nhưng không đảm bảo mọi phiên bản Postman có thể cấu hình object `auth` giống `socket.io-client`. Bearer header hoặc query parameter không thỏa contract backend này. Vì vậy:

- dùng Postman cho toàn bộ REST API;
- dùng `npm run chat:test:manual` làm cách kiểm thử Socket.IO chuẩn;
- chỉ dùng Postman Socket.IO nếu phiên bản bạn đang dùng thực sự có mục cho Socket.IO auth payload và server xác nhận kết nối thành công;
- không sửa backend để nhận token từ query/header chỉ nhằm phục vụ công cụ test.

Nếu Postman hỗ trợ auth payload, giá trị cần truyền là:

```json
{
  "token": "<access-token>"
}
```

Sau khi kết nối thành công, có thể tạo bốn request/socket riêng cho customer tab 1, customer tab 2, handyman và outsider. Với mỗi event, nhập event name, thêm một JSON argument và bật **Ack**. Postman không hỗ trợ Socket.IO long-polling, nên kết nối test phải dùng WebSocket.

Tài liệu Postman tham khảo:

- <https://learning.postman.com/v11/docs/use/send-requests/protocols/websocket/create-a-socketio-request>
- <https://learning.postman.com/v11/docs/use/send-requests/protocols/websocket/work-with-websocket-messages>

## 9. Chạy manualChatTest chuẩn của project

Khởi động backend với:

```env
DB_SYNC_ALTER=false
NODE_ENV=development
```

Terminal 1:

```powershell
npm start
```

Terminal 2:

```powershell
npm run chat:test:manual
```

Script tự chạy theo thứ tự:

1. POST create/get conversation và GET read-only.
2. Từ chối socket có token giả.
3. Kết nối customer tab 1, customer tab 2, handyman và outsider.
4. Join hợp lệ và outsider non-disclosure.
5. Gửi message, kiểm tra recipient và tab khác của sender nhận realtime.
6. GET history để chứng minh message đã commit PostgreSQL.
7. Retry cùng `client_message_id` và nội dung normalized giống nhau.
8. Kiểm tra duplicate không emit lần hai.
9. Gửi cùng ID nhưng nội dung khác để nhận `CLIENT_MESSAGE_ID_CONFLICT`.
10. Handyman đánh dấu read và customer nhận `conversation:read_updated`.
11. Gửi burst để nhận `RATE_LIMITED`.
12. Nếu bật flag: khóa account tạm thời, test REST, reconnect, send/read rồi restore trong `finally`.
13. Nếu bật flag: chạy lifecycle/refund cuối cùng.

Output:

```text
PASS
FAIL
EXPECTED ERROR
ACTUAL RESPONSE
```

Exit code khác `0` nghĩa là có ít nhất một case thất bại.

## 10. Các case socket quan trọng cần hiểu

### SOCKET-01: Phải join trước send/read

Kết nối socket nhưng chưa join, sau đó emit:

```json
{
  "conversation_id": "...",
  "client_message_id": "...",
  "content": "Test"
}
```

Mong đợi `409 SOCKET_NOT_JOINED`.

### SOCKET-02: Duplicate và conflict

Dùng một UUID cố định làm `client_message_id`.

- Lần 1: content `"  Xin chào\r\nBạn  "` → tạo message.
- Lần 2: content `"Xin chào\nBạn"` → duplicate vì normalize giống nhau.
- Lần 3: cùng ID, content `"Nội dung khác"` → `CLIENT_MESSAGE_ID_CONFLICT`.

Sau ba lần, database chỉ có một message với UUID đó.

### SOCKET-03: Multi-tab sender

Hai socket dùng cùng customer token cùng join room. Tab 1 gửi message:

- tab 1 nhận acknowledgement;
- tab 2 nhận `message:new`;
- handyman nhận `message:new`;
- tab 1 không nhận thêm `message:new` cho chính lần gửi đó.

### SOCKET-04: Read cursor không lùi

Gửi ít nhất hai message `M1`, `M2` theo thứ tự.

1. Emit read tới `M2`: cursor tiến tới M2.
2. Emit read tới `M1`: acknowledgement thành công nhưng `advanced=false`, cursor vẫn ở M2.
3. Kiểm tra database không quay lại M1.

Nếu hai message có cùng timestamp, backend dùng UUID `id` làm tie-breaker.

### SOCKET-05: Rate limit

Gửi nhanh hơn burst capacity. Trong các acknowledgement phải có ít nhất một:

```text
EC=429
code=RATE_LIMITED
DT.retry_after_ms > 0
```

Rate limit áp dụng theo user, nên nhiều tab cùng token dùng chung quota.

## 11. Test participant inactive

Chỉ bật trên development:

```env
CHAT_TEST_ALLOW_DB_MUTATION=true
CHAT_TEST_INACTIVE_USER_ID=<participant-id>
```

Script đổi `Users.is_active=false`, test và restore giá trị cũ trong `finally`.

Trong thời gian inactive, các thao tác sau đều phải nhận `409 PARTICIPANT_INACTIVE`:

```text
POST conversation
GET conversation
GET history
socket join
message send
conversation read
socket reconnect của account bị khóa
```

Script hiện tự động kiểm tra POST, GET, history, reconnect, send và read. Điều kiện `join` được backend áp dụng cùng access service; nếu muốn quan sát riêng case này, trong lúc participant đang inactive hãy cho socket active còn lại `conversation:leave`, rồi thử `conversation:join` lại. Kết quả phải là `PARTICIPANT_INACTIVE`, không được join room. Sau khi restore account, join lại phải thành công.

Conversation vẫn phải là `ACTIVE`, `closed_at` và `closed_reason` không đổi. Sau restore, participant có thể reconnect và chat lại trong cùng cycle.

Nếu restore thất bại, script in cảnh báo `FAIL CRITICAL` kèm user ID. Phải sửa lại account thủ công trước khi tiếp tục.

## 12. Test lifecycle/refund — luôn chạy cuối

Chỉ bật khi lifecycle job là dữ liệu disposable:

```env
CHAT_TEST_CONFIRM_LIFECYCLE_MUTATION=true
CHAT_TEST_LIFECYCLE_JOB_ID=<disposable-job-id>
```

Script:

1. Tạo/lấy conversation của lifecycle job.
2. Customer và handyman join room.
3. Customer gọi `REOPEN_BIDDING`.
4. Nghiệp vụ hoàn tiền và chuyển trạng thái job phải thành công.
5. Handyman nhận `conversation:closed` với reason `CUSTOMER_REOPEN_BIDDING`.
6. Socket bị đẩy khỏi room.
7. Send tiếp theo nhận `SOCKET_NOT_JOINED`.

Sau đó test thêm bằng REST:

```http
POST /api/v1/chat/jobs/<lifecycle-job-id>/conversation
GET  /api/v1/chat/jobs/<lifecycle-job-id>/conversation
GET  /api/v1/chat/conversations/<lifecycle-conversation-id>/messages
```

Conversation cycle cũ không được mở lại. Nếu job chưa được accept lại thì trạng thái job không cho phép chat. Nếu job được accept lại, `acceptance_cycle` phải tăng đúng một và POST phải tạo conversation mới có ID mới; conversation cũ vẫn `CLOSED`.

## 13. Audit database sau test

### 13.1. Job và acceptance cycle

```sql
SELECT id, current_status, acceptance_cycle, customer_id,
       selected_handyman_id, selected_bid_id, deposit_status,
       deposit_transaction_id, accepted_at, "updatedAt"
FROM "Jobs"
WHERE id IN ('<main-job-id>', '<lifecycle-job-id>');
```

### 13.2. Conversation

```sql
SELECT id, job_id, acceptance_cycle, customer_id, handyman_id,
       selected_bid_id, status, closed_reason, closed_by_user_id,
       closed_at, last_message_at,
       customer_last_read_message_id, customer_last_read_at,
       handyman_last_read_message_id, handyman_last_read_at,
       "createdAt", "updatedAt"
FROM "Conversations"
WHERE job_id IN ('<main-job-id>', '<lifecycle-job-id>')
ORDER BY job_id, acceptance_cycle;
```

Kiểm tra:

- main conversation vẫn `ACTIVE` nếu không đổi lifecycle;
- lifecycle conversation là `CLOSED`;
- reason là `CUSTOMER_REOPEN_BIDDING`;
- không có hai record cùng `(job_id, acceptance_cycle)`;
- không có hai conversation `ACTIVE` cho cùng job.

### 13.3. Message và idempotency

```sql
SELECT id, conversation_id, sender_id, client_message_id,
       message_type, content, "createdAt", "updatedAt"
FROM "Messages"
WHERE conversation_id = '<main-conversation-id>'
ORDER BY "createdAt", id;
```

Kiểm tra duplicate retry chỉ tạo một row.

### 13.4. Kiểm tra uniqueness bằng query

```sql
SELECT job_id, acceptance_cycle, COUNT(*)
FROM "Conversations"
GROUP BY job_id, acceptance_cycle
HAVING COUNT(*) > 1;

SELECT job_id, COUNT(*)
FROM "Conversations"
WHERE status = 'ACTIVE'
GROUP BY job_id
HAVING COUNT(*) > 1;

SELECT conversation_id, sender_id, client_message_id, COUNT(*)
FROM "Messages"
GROUP BY conversation_id, sender_id, client_message_id
HAVING COUNT(*) > 1;
```

Cả ba query phải trả `0 rows`.

## 14. Checklist hoàn tất

- [ ] Schema sync thành công và đã tắt `DB_SYNC_ALTER`.
- [ ] Unique cycle index và partial ACTIVE index tồn tại.
- [ ] Backfill chạy thành công; job chat-valid không còn cycle 0.
- [ ] POST conversation trả 201 rồi 200 với cùng ID.
- [ ] GET conversation không tạo dữ liệu.
- [ ] Outsider nhận 404.
- [ ] Customer và handyman join được.
- [ ] Sender tab khác và recipient nhận realtime.
- [ ] Duplicate không tạo/emit lần hai.
- [ ] Conflict trả 409.
- [ ] History phân trang cũ → mới, cursor sai trả 400.
- [ ] Read cursor tiến theo tuple và không lùi.
- [ ] `unread_count`, `is_seen`, `seen_at` đúng.
- [ ] Rate limit trả 429 khi vượt burst.
- [ ] Inactive khóa tạm thời nhưng không đóng conversation.
- [ ] Lifecycle/refund vẫn thành công nếu chat close gặp lỗi.
- [ ] `conversation:closed` có đủ metadata và room bị evict.
- [ ] Cycle mới tạo conversation mới, không trả conversation cũ.
- [ ] SQL uniqueness audit trả 0 rows.

Tài liệu contract chi tiết nằm tại `docs/chat-backend-contract.md`.

## 15. Xử lý lỗi thường gặp

| Hiện tượng | Nguyên nhân nên kiểm tra | Cách xử lý |
|---|---|---|
| Startup dừng vì thiếu cycle index | Schema chưa sync hoặc sync lỗi | Backup DB, bật `DB_SYNC_ALTER=true`, đọc lỗi PostgreSQL và chạy lại |
| Partial ACTIVE index không tạo được | Có nhiều conversation `ACTIVE` cho cùng job | Audit bằng query uniqueness; chỉ sửa dữ liệu development sau khi xác định đúng cycle |
| `ACCEPTANCE_CYCLE_INCONSISTENT` | Job chat-valid vẫn có cycle 0 | Chạy backfill có flag và xem log record bị skip |
| `ACCEPTED_DATA_INCONSISTENT` | Selected bid, handyman hoặc deposit không khớp | Kiểm tra Job, Bid, Transaction và system escrow; không tự sửa tài chính để vượt test |
| `PARTICIPANT_INACTIVE` | Customer hoặc handyman bị khóa | Kiểm tra cả hai record User, không chỉ caller |
| `CONVERSATION_NOT_FOUND` với outsider | Hành vi bảo mật đúng thiết kế | Dùng token customer/selected handyman của đúng cycle |
| `CONVERSATION_CLOSED` | Lifecycle/cycle đã kết thúc | Không mở lại record cũ; accept job ở cycle mới nếu nghiệp vụ cho phép |
| `SOCKET_ACK_REQUIRED` | Client emit event không truyền callback | Thêm callback ở argument cuối hoặc bật Ack trong công cụ test |
| `SOCKET_NOT_JOINED` | Socket chưa join hoặc vừa bị evict | Emit `conversation:join` lại; nếu conversation đóng thì join vẫn bị từ chối |
| `CLIENT_MESSAGE_ID_CONFLICT` | Tái sử dụng UUID với nội dung khác | Mỗi message logic mới phải dùng UUID mới |
| `RATE_LIMITED` xuất hiện sớm | Nhiều tab cùng user dùng chung token bucket | Chờ `retry_after_ms`; không retry liên tục |
| Postman Socket.IO không connect có auth | Postman không truyền được `auth.token` đúng contract | Dùng `npm run chat:test:manual` |
| Manual test timeout | Server URL sai, server chưa chạy, token hết hạn hoặc event không ack | Kiểm tra terminal server, refresh token thành access token mới và chạy lại |
| Restore inactive thất bại | DB lỗi trong `finally` | Khôi phục `Users.is_active` thủ công ngay và không tiếp tục lifecycle test |
