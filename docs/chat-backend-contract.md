# Đặc tả backend chat Customer – Handyman

## 1. Mục tiêu và phạm vi

Chức năng này cung cấp chat văn bản một-một giữa:

- customer sở hữu job;
- handyman đang được chọn trong acceptance cycle hiện tại của job.

Chat chỉ là chức năng phụ của nghiệp vụ nhận việc. Việc tạo hoặc đóng conversation không được làm rollback thanh toán, hoàn tiền hay transition trạng thái job. PostgreSQL là nguồn dữ liệu chuẩn; Socket.IO chỉ đảm nhiệm kết nối và truyền sự kiện realtime. REST API dùng để tạo/lấy conversation và tải lịch sử tin nhắn.

MVP chưa có inbox tổng hợp. Người dùng mở chat từ trang chi tiết job.

Các trạng thái job được phép chat:

```text
ACCEPTED
EN_ROUTE
ARRIVED
IN_PROGRESS
WARRANTY
```

Các trạng thái như `POSTED`, `BIDDING`, `PENDING_DEPOSIT`, `CANCELLED`, `CLOSED` không được chat.

## 2. Acceptance cycle

### 2.1. Ý nghĩa

`Jobs.acceptance_cycle` phân biệt các lần một job được nhận việc:

- job mới bắt đầu với cycle `0`, nghĩa là chưa từng chuyển sang `ACCEPTED`;
- transition thật sự đầu tiên sang `ACCEPTED` đổi cycle từ `0` thành `1`;
- nếu job quay lại bidding rồi được nhận lại, cycle tăng từ `1` thành `2`;
- chọn lại đúng handyman cũ vẫn là cycle mới và phải dùng conversation mới.

Cycle chỉ tăng trong cùng transaction với transition sang `ACCEPTED`. Nếu transaction rollback thì trạng thái job và cycle đều rollback. Callback gateway hoặc request wallet bị gửi lặp không được tăng cycle lần nữa.

Job đang `ACCEPTED` nhưng cycle vẫn bằng `0` được xem là dữ liệu legacy chưa hợp lệ. Backend không tự đoán; phải chạy script backfill có kiểm tra invariant.

### 2.2. Conversation thuộc cycle nào

Mỗi conversation lưu snapshot:

```text
job_id
acceptance_cycle
customer_id
handyman_id
selected_bid_id
```

Hai tầng bảo vệ ở database:

```text
UNIQUE(job_id, acceptance_cycle)
UNIQUE(job_id) WHERE status = 'ACTIVE'
```

Constraint đầu tiên bắt buộc mỗi cycle chỉ có một conversation. Partial unique index thứ hai là defense-in-depth, không cho một job có hai conversation `ACTIVE`. Service vẫn luôn lock Job row và reconcile conversation cũ trước khi tạo mới.

## 3. Trạng thái conversation

Conversation chỉ có:

```text
ACTIVE
CLOSED
```

`CLOSED` là trạng thái vĩnh viễn của cycle đó. Không được tạo conversation thứ hai trong cùng cycle và participant không được đọc lại history của conversation đã đóng.

Các lý do đóng:

| `closed_reason` | Ý nghĩa |
|---|---|
| `CUSTOMER_REOPEN_BIDDING` | Customer đưa job quay lại bidding |
| `CUSTOMER_CANCELLED_JOB` | Customer hủy job |
| `HANDYMAN_CANCELLED` | Handyman rút khỏi job đã nhận |
| `JOB_CANCELLED` | Reconcile thấy job đã hủy nhưng không xác định được actor cụ thể |
| `JOB_CLOSED` | Job đã kết thúc |
| `JOB_RETURNED_TO_BIDDING` | Reconcile thấy lifecycle không còn hợp lệ nhưng không nên đoán actor |
| `ACCEPTANCE_CYCLE_SUPERSEDED` | Conversation thuộc cycle cũ |

Thông tin audit được lưu trong:

```text
closed_at
closed_reason
closed_by_user_id
```

`PARTICIPANT_INACTIVE` không phải lý do đóng. Khi một trong hai tài khoản bị khóa, conversation vẫn `ACTIVE` nhưng toàn bộ quyền truy cập chat tạm thời bị từ chối. Nếu tài khoản được kích hoạt lại trong cùng cycle, chat hoạt động trở lại.

## 4. Envelope dùng chung

REST response và socket acknowledgement dùng cùng cấu trúc:

```json
{
  "EM": "Mô tả kết quả",
  "EC": 0,
  "code": "MACHINE_READABLE_CODE",
  "DT": {}
}
```

- `EM`: thông báo để đọc hoặc ghi log.
- `EC`: `0` nếu thành công; khi lỗi là HTTP-like error code như `400`, `404`, `409`, `429`.
- `code`: mã ổn định để frontend xử lý.
- `DT`: dữ liệu trả về hoặc metadata của lỗi.

`chat:error` chỉ dùng cho lỗi giao thức không gắn được với callback hoặc lỗi socket-level bất ngờ. Các event `join`, `send`, `read`, `leave` phải truyền acknowledgement callback và nhận lỗi qua callback đó.

## 5. REST API

Mọi endpoint chat yêu cầu access token hợp lệ và role `CUSTOMER` hoặc `HANDYMAN`.

### 5.1. Tạo hoặc lấy conversation của cycle hiện tại

```http
POST /api/v1/chat/jobs/:jobId/conversation
Authorization: Bearer <access-token>
Content-Type: application/json

{}
```

Backend thực hiện trong transaction:

1. Lock Job row.
2. Kiểm tra job tồn tại và user là customer/selected handyman hiện tại.
3. Reconcile conversation `ACTIVE` thuộc cycle cũ.
4. Kiểm tra trạng thái job, acceptance cycle, selected bid và dữ liệu deposit.
5. Kiểm tra cả hai participant còn active.
6. Lấy conversation của cycle hiện tại hoặc tạo mới.

Kết quả:

- `201 CONVERSATION_CREATED`: tạo mới.
- `200 CONVERSATION_EXISTS`: đã tồn tại; trả đúng record cũ.
- `409 CONVERSATION_CLOSED`: cycle hiện tại đã có conversation đóng; không tạo record thứ hai.
- `409 PARTICIPANT_INACTIVE`: một participant bị khóa; không tạo và không đóng conversation.
- `409 CHAT_NOT_ALLOWED_FOR_JOB_STATUS`: trạng thái job không cho phép chat và chưa có conversation cần reconcile.
- `409 ACCEPTANCE_CYCLE_INCONSISTENT`: job ở luồng chat nhưng cycle không hợp lệ.
- `404 CONVERSATION_NOT_FOUND`: caller không thuộc acceptance cycle, dùng 404 để tránh lộ dữ liệu.

POST này idempotent nhưng không dùng `GET` để tạo dữ liệu.

### 5.2. Lấy conversation mà không tạo

```http
GET /api/v1/chat/jobs/:jobId/conversation
Authorization: Bearer <access-token>
```

Nếu cycle hiện tại chưa có conversation, trả:

```json
{
  "EM": "Conversation not found.",
  "EC": 404,
  "code": "CONVERSATION_NOT_FOUND",
  "DT": ""
}
```

GET không tạo dữ liệu và không tự đánh dấu đã đọc.

### 5.3. DTO conversation

Ví dụ rút gọn:

```json
{
  "id": "conversation-uuid",
  "job_id": "job-uuid",
  "acceptance_cycle": 2,
  "selected_bid_id": "bid-uuid",
  "status": "ACTIVE",
  "created_at": "2026-07-15T08:00:00.000Z",
  "last_message_at": "2026-07-15T08:05:00.000Z",
  "current_user_last_read_message_id": "message-uuid",
  "current_user_last_read_at": "2026-07-15T08:06:00.000Z",
  "partner_last_read_message_id": null,
  "partner_last_read_at": null,
  "unread_count": 3,
  "partner": {
    "id": "user-uuid",
    "full_name": "Nguyễn Văn A",
    "avatar_url": null,
    "role": "HANDYMAN"
  },
  "allowed_actions": ["JOIN", "SEND", "READ", "HISTORY"]
}
```

Partner chỉ chứa `id`, `full_name`, `avatar_url`, `role`. Chat API không lặp lại số điện thoại, địa chỉ, rating hoặc hồ sơ chi tiết.

### 5.4. Lấy lịch sử tin nhắn

```http
GET /api/v1/chat/conversations/:conversationId/messages?limit=30&cursor=<opaque>
Authorization: Bearer <access-token>
```

Quy tắc phân trang:

- mặc định `limit=30`;
- tối đa `50`;
- mỗi page trả tin nhắn theo thứ tự cũ → mới;
- `next_cursor` dùng để tải page cũ hơn và prepend vào đầu danh sách;
- cursor encode tuple `(createdAt, id)` và frontend không được tự phân tích;
- cursor sai format, bị sửa, thuộc conversation khác hoặc trỏ tới message không tồn tại trả `400 INVALID_CURSOR`;
- tải history không tự đánh dấu đã đọc.

Response:

```json
{
  "EM": "Message history retrieved successfully.",
  "EC": 0,
  "code": "MESSAGE_HISTORY_RETRIEVED",
  "DT": {
    "messages": [],
    "next_cursor": null,
    "has_more": false
  }
}
```

Outsider nhận `404 CONVERSATION_NOT_FOUND`, không nhận `403`. Participant của conversation đã đóng nhận `409 CONVERSATION_CLOSED`.

## 6. Kết nối Socket.IO

Backend dùng default namespace và default Socket.IO path.

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:5000', {
  auth: {
    token: accessToken
  }
});
```

Handshake chỉ tin `auth.token`. Backend tự lấy `user_id` và `role` từ token/database; không nhận refresh token, sender ID hoặc role do client khai báo.

Kết nối bị từ chối nếu token hết hạn, account không tồn tại, account inactive hoặc role không phải participant chat.

## 7. Socket events

### 7.1. `conversation:join`

Payload:

```json
{
  "conversation_id": "conversation-uuid"
}
```

Ví dụ client:

```js
socket.emit('conversation:join', {
  conversation_id: conversationId
}, (response) => {
  console.log(response);
});
```

Trước khi join room, backend kiểm tra lại:

- authentication và account active;
- membership;
- conversation `ACTIVE`;
- job/cycle còn hợp lệ;
- customer, handyman, selected bid vẫn khớp;
- cả hai participant active.

Room nội bộ có dạng `conversation:{conversation_id}`. Đã ở trong room không đồng nghĩa đã được authorize vĩnh viễn; send/read vẫn kiểm tra lại database.

### 7.2. `conversation:leave`

```json
{
  "conversation_id": "conversation-uuid"
}
```

Leave không yêu cầu account còn active vì socket phải luôn có khả năng rời room.

### 7.3. `message:send`

```json
{
  "conversation_id": "conversation-uuid",
  "client_message_id": "uuid-do-client-tu-tao",
  "content": "Nội dung plain text"
}
```

Socket bắt buộc join đúng room trước. Backend không nhận `sender_id`; sender luôn lấy từ access token.

Chuẩn hóa nội dung theo thứ tự:

1. Đổi CRLF và CR thành LF.
2. Unicode normalize về NFC.
3. Trim khoảng trắng đầu/cuối.
4. Giữ nguyên khoảng trắng và xuống dòng bên trong.
5. Từ chối nội dung rỗng hoặc dài hơn 2.000 Unicode characters.

HTML chỉ là text. Frontend không được render bằng `innerHTML`, `dangerouslySetInnerHTML` hoặc cơ chế raw HTML tương tự.

Idempotency:

```text
UNIQUE(conversation_id, sender_id, client_message_id)
```

- cùng ID + cùng nội dung sau normalize: trả message cũ với `duplicate=true`, không emit lại;
- cùng ID + nội dung khác: `409 CLIENT_MESSAGE_ID_CONFLICT`;
- cùng UUID ở conversation khác không bị xem là duplicate.

Tin nhắn được commit trước acknowledgement. Sau đó backend emit `message:new` tới toàn room trừ socket gửi ban đầu. Vì vậy:

- tab gửi ban đầu nhận acknowledgement;
- tab khác của chính sender nhận `message:new`;
- recipient nhận `message:new`.

Rate limit dùng token bucket in-memory theo user:

```text
Refill: 5 message/giây
Burst capacity: 10 message
```

Vượt giới hạn trả `429 RATE_LIMITED` và `DT.retry_after_ms`. MVP chạy một Node.js instance; logic rate-limit đã được tách để có thể thay bằng Redis sau này.

### 7.4. DTO message

```json
{
  "id": "message-uuid",
  "conversation_id": "conversation-uuid",
  "sender_id": "user-uuid",
  "client_message_id": "client-uuid",
  "message_type": "TEXT",
  "content": "Xin chào",
  "sent_at": "2026-07-15T08:05:00.000Z",
  "is_seen": false,
  "seen_at": null
}
```

Shape luôn có `is_seen` và `seen_at`:

- nếu requester là sender, backend tính trạng thái seen bằng read cursor của partner;
- nếu requester là người nhận, luôn trả `false/null`;
- không lưu seen riêng trên từng message.

### 7.5. `conversation:read`

Frontend chỉ emit sau khi message đã render, tab đang visible và conversation thực sự đang được xem.

```json
{
  "conversation_id": "conversation-uuid",
  "last_message_id": "message-uuid"
}
```

Socket phải join room trước. Backend xác minh message tồn tại và thuộc đúng conversation. Cursor chỉ tiến về phía trước theo tuple `(createdAt, id)`, không chỉ timestamp và không cho lùi.

Khi cursor tiến, các socket khác trong room nhận `conversation:read_updated`:

```json
{
  "conversation_id": "conversation-uuid",
  "user_id": "user-uuid",
  "role": "CUSTOMER",
  "last_read_message_id": "message-uuid",
  "read_at": "2026-07-15T08:06:00.000Z"
}
```

Join và GET history không làm cursor thay đổi.

### 7.6. `conversation:closed`

```json
{
  "conversation_id": "conversation-uuid",
  "job_id": "job-uuid",
  "acceptance_cycle": 2,
  "reason": "CUSTOMER_REOPEN_BIDDING",
  "closed_at": "2026-07-15T08:10:00.000Z"
}
```

Sau khi lifecycle transaction chính thành công, backend best-effort:

1. Lưu trạng thái đóng và metadata.
2. Emit `conversation:closed` vào room.
3. Buộc toàn bộ socket rời room.

Nếu emit thất bại, nghiệp vụ hủy/refund vẫn thành công. Mọi request sau đó vẫn đọc database và bị từ chối. Trong race giữa reconcile và lifecycle hook, reason chung sẽ được nâng cấp thành reason cụ thể để audit chính xác hơn.

## 8. Reconciliation và tính nhất quán

Mọi thao tác create/get/history/join/send/read đều đối chiếu lại database.

- Cycle conversation khác cycle job: đóng bằng `ACCEPTANCE_CYCLE_SUPERSEDED`.
- Job không còn ở trạng thái chat: đóng bằng reason cụ thể hoặc fallback lifecycle.
- Participant inactive: chỉ trả `PARTICIPANT_INACTIVE`, không đóng.
- Conversation đã `CLOSED`: không mở lại và không tạo record khác cùng cycle.
- Job row được lock trước Conversation row để giữ thứ tự lock nhất quán.

## 9. Retention MVP

Message và conversation được giữ vô thời hạn trong PostgreSQL để audit. Task này không tạo cleanup job. Retention period, anonymization và deletion policy sẽ được xác định ở giai đoạn production/compliance.
