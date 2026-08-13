# Hướng dẫn kiểm thử giai đoạn ACCEPTED bằng Postman

Tài liệu này kiểm thử các API dưới prefix:

```text
{{base_url}} = http://localhost:5000/api/v1
```

Không dùng các job `ACCEPTED` được tạo trước khi schema mới được đồng bộ, vì các record đó không có `deposit_status` và `deposit_paid_at`.

## 1. Đồng bộ schema trước khi test

1. Backup PostgreSQL database hiện tại.
2. Trong `.env`, tạm đặt:

   ```env
   DB_SYNC_ALTER=true
   ```

3. Chạy backend một lần:

   ```powershell
   npm start
   ```

4. Khi log xuất hiện `All models were synchronized successfully with alter mode.`, dừng backend.
5. Đổi lại:

   ```env
   DB_SYNC_ALTER=false
   ```

6. Khởi động lại backend để test. Không để `DB_SYNC_ALTER=true` trong các lần start thông thường.

Có thể xác nhận nhanh schema bằng PostgreSQL:

```sql
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'Jobs',
    'Bids',
    'Transactions',
    'Job_Cancellations',
    'Job_Status_Histories',
    'Handyman_Profiles'
  )
ORDER BY table_name, ordinal_position;
```

## 2. Biến Postman và tài khoản cần có

Tạo Postman Environment với các biến:

| Biến | Ý nghĩa |
|---|---|
| `base_url` | `http://localhost:5000/api/v1` |
| `customer_token` | Access token của customer sở hữu job |
| `selected_handyman_token` | Access token của handyman được chọn |
| `other_handyman_token` | Access token của handyman khác |
| `outsider_customer_token` | Access token của customer khác |
| `admin_token` | Access token admin để test sai role |
| `job_id` | Job ACCEPTED dành cho test hiện tại |
| `selected_bid_id` | Bid WON của selected handyman |
| `other_bid_id` | Bid LOST của handyman khác |
| `deposit_amount` | Tiền cọc của job |
| `original_deposit_transaction_id` | Transaction DEPOSIT_10 gốc |

Mỗi request cần token sử dụng header:

```text
Authorization: Bearer {{customer_token}}
Content-Type: application/json
```

Đăng nhập bằng API hiện có:

```http
POST {{base_url}}/auth/login
Content-Type: application/json

{
  "valueLogin": "customer@example.com",
  "password": "your-password"
}
```

Lấy token từ `DT.access_token`. Lặp lại cho selected handyman, handyman khác, outsider customer và admin.

## 3. Chuẩn bị một job ACCEPTED mới

Mỗi test thay đổi trạng thái cần một job riêng. Nên chuẩn bị tối thiểu năm job:

- Job A: accepted-details và validation.
- Job B: customer `REOPEN_BIDDING` và tái kích hoạt bid.
- Job C: customer `CANCEL_JOB`.
- Job D: handyman hủy.
- Job E: start-moving.
- Job F/G/H: các test concurrency nếu muốn giữ kết quả độc lập.

### 3.1 Customer và KYC

Customer phải có `kyc_status=VERIFIED` mới tạo được job. Có thể kiểm tra bằng:

```http
GET {{base_url}}/identity/profile
Authorization: Bearer {{customer_token}}
```

Nếu chưa KYC, dùng flow upload hiện tại và admin review. API admin review hiện hữu vẫn dùng body legacy sau:

```http
POST {{base_url}}/admin/kyc/review
Authorization: Bearer {{admin_token}}
Content-Type: application/json

{
  "userId": "customer-user-id",
  "status": "VERIFIED",
  "notes": "Approved for ACCEPTED API testing"
}
```

### 3.2 Tạo job

Lấy service và địa chỉ hợp lệ:

```http
GET {{base_url}}/matchmaking/services
GET {{base_url}}/matchmaking/provinces
GET {{base_url}}/matchmaking/wards?province_code=<province_code>
```

Tạo job bằng `form-data`:

```http
POST {{base_url}}/matchmaking/jobs
Authorization: Bearer {{customer_token}}
Content-Type: multipart/form-data
```

Các field mẫu:

| Field | Giá trị mẫu |
|---|---|
| `service_id` | UUID service đang active |
| `issue_description` | `Vòi nước bị rò rỉ` |
| `scheduled_at` | Một thời điểm hợp lệ trong tương lai |
| `address_option` | `1` |
| `province_code` | Province code hợp lệ |
| `ward_code` | Ward code thuộc province |
| `detail_address` | `123 Đường kiểm thử` |
| `estimated_budget_min` | `150000` |
| `estimated_budget_max` | `300000` |
| `images` | Tùy chọn, tối đa 5 file |

Lưu `DT.id` thành `job_id`.

### 3.3 Tạo ít nhất hai bid

Selected handyman:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/bids
Authorization: Bearer {{selected_handyman_token}}
Content-Type: application/json

{
  "proposed_price": 200000,
  "message": "Tôi có thể đến kiểm tra vào buổi chiều",
  "eta": "2026-07-15T14:00:00+07:00",
  "estimated_duration_hours": 2
}
```

Kết quả mong đợi khi tạo mới: HTTP 201, `EC=0`, bid có `status=PENDING`. Lưu `DT.id` thành `selected_bid_id`.

Handyman khác gửi bid tương tự bằng `other_handyman_token`; lưu ID thành `other_bid_id`.

### 3.4 Nạp tiền và accept bid

Kiểm tra ví customer:

```http
GET {{base_url}}/identity/profile
Authorization: Bearer {{customer_token}}
```

Nếu thiếu tiền, tạo PayOS top-up:

```http
POST {{base_url}}/fintech/wallets/top-up
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{
  "amount": 100000,
  "payment_method": "PAYOS",
  "target_wallet": "MAIN"
}
```

Mở checkout URL trong `DT` và hoàn tất thanh toán trước khi tiếp tục.

Lấy deposit summary:

```http
GET {{base_url}}/matchmaking/jobs/{{job_id}}/bids/{{selected_bid_id}}/deposit-summary
Authorization: Bearer {{customer_token}}
```

Accept và trả cọc bằng ví:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/bids/{{selected_bid_id}}/accept-with-wallet-deposit
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{}
```

Kết quả mong đợi:

- HTTP 201, `EC=0`.
- `DT.job_status=ACCEPTED`.
- `DT.deposit_status=HELD`.
- `DT.deposit_paid_at` khác null.
- Selected bid là `WON`; bid còn lại là `LOST`.
- Customer wallet giảm đúng `deposit_amount`; SYSTEM_ESCROW tăng cùng số tiền.

## 4. GET accepted-details

### 4.1 Customer xem job của mình

```http
GET {{base_url}}/matchmaking/jobs/{{job_id}}/accepted-details
Authorization: Bearer {{customer_token}}
```

Mong đợi HTTP 200:

```json
{
  "EM": "Accepted job details retrieved successfully.",
  "EC": 0,
  "DT": {
    "job": {
      "id": "uuid",
      "status": "ACCEPTED",
      "service": {},
      "issue_description": "Vòi nước bị rò rỉ",
      "images": [],
      "scheduled_at": "timestamp",
      "service_address": "Địa chỉ thực hiện job",
      "gps_lat": null,
      "gps_long": null,
      "accepted_at": "timestamp"
    },
    "selected_bid": {
      "id": "uuid",
      "proposed_price": 200000,
      "message": "Tôi có thể đến kiểm tra vào buổi chiều",
      "status": "WON"
    },
    "deposit": {
      "amount": 20000,
      "percentage": 10,
      "status": "HELD",
      "paid_at": "timestamp",
      "label": "Tiền cọc đang được hệ thống tạm giữ"
    },
    "partner": {
      "role": "HANDYMAN",
      "rating": null,
      "review_count": 0,
      "completion_rate": null,
      "total_jobs_completed": 0
    },
    "allowed_actions": ["REOPEN_BIDDING", "CANCEL_JOB"]
  }
}
```

Nếu partner có review/outcome lịch sử thì `rating`, `review_count`, `completion_rate` thay đổi tương ứng. Response không được chứa balance, địa chỉ nhà handyman hoặc KYC documents.

### 4.2 Selected handyman xem job

Gửi cùng URL với `selected_handyman_token`.

Mong đợi HTTP 200:

- `partner.role=CUSTOMER`.
- `job.service_address` là địa chỉ của job, không phải địa chỉ profile customer.
- `deposit.status=HELD` và label xác nhận customer đã đặt cọc.
- `allowed_actions=["START_MOVING","CANCEL_ACCEPTED_JOB"]`.
- Không có customer wallet balance.

### 4.3 Các trường hợp từ chối

| Tình huống | Mong đợi |
|---|---|
| Không có token | HTTP 401 |
| `id` không phải UUID | HTTP 400, `code=VALIDATION_ERROR` |
| Customer khác | HTTP 403, `code=FORBIDDEN_JOB_ACCESS` |
| Handyman không được chọn | HTTP 403, `code=FORBIDDEN_JOB_ACCESS` |
| Admin | HTTP 403 từ role middleware |
| Job không tồn tại | HTTP 404, `code=JOB_NOT_FOUND` |
| Job không còn ACCEPTED | HTTP 409, `code=INVALID_JOB_STATUS` |
| Job legacy có deposit_status null | HTTP 409, `code=ACCEPTED_DATA_INCONSISTENT` |

## 5. Customer REOPEN_BIDDING

Sử dụng một job ACCEPTED mới:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/cancel-by-customer
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{
  "action": "REOPEN_BIDDING",
  "reason_code": "HANDYMAN_NOT_SUITABLE",
  "reason_text": "Muốn chọn thợ khác"
}
```

Mong đợi HTTP 200:

```json
{
  "EC": 0,
  "DT": {
    "job_id": "uuid",
    "status": "BIDDING",
    "refunded_amount": 20000,
    "deposit_status": "REFUNDED"
  }
}
```

Side effects mong đợi:

- Customer wallet tăng đúng toàn bộ cọc; escrow giảm cùng số tiền.
- `selected_handyman_id` và `selected_bid_id` được clear.
- Bid từng thắng thành `CANCELLED_BY_CUSTOMER`.
- Bid `LOST` của handyman khác còn active thành `PENDING`.
- Có đúng một `DEPOSIT_REFUND SUCCESS`, một cancellation và một history `ACCEPTED → BIDDING`.

### 5.1 Tái kích hoạt đúng record bid cũ

Selected handyman cũ chủ động gọi lại POST bid:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/bids
Authorization: Bearer {{selected_handyman_token}}
Content-Type: application/json

{
  "proposed_price": 210000,
  "message": "Tôi muốn ứng tuyển lại với lịch mới",
  "eta": "2026-07-15T15:00:00+07:00",
  "estimated_duration_hours": 2.5
}
```

Mong đợi:

- HTTP 200, không phải 201.
- `EC=0`, `DT.id` vẫn bằng `selected_bid_id` cũ.
- Status trở lại `PENDING` và nội dung bid được cập nhật.
- Tổng số record bid của handyman/job không tăng.

## 6. Customer CANCEL_JOB

Sử dụng job ACCEPTED khác:

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/cancel-by-customer
Authorization: Bearer {{customer_token}}
Content-Type: application/json

{
  "action": "CANCEL_JOB",
  "reason_code": "NO_LONGER_NEEDED",
  "reason_text": "Không còn nhu cầu"
}
```

Mong đợi:

- HTTP 200, `status=CANCELLED`, `deposit_status=REFUNDED`.
- Hoàn đúng 100% cọc.
- `cancelled_at` được đặt.
- Selected IDs được giữ nguyên để audit.
- Selected bid thành `CANCELLED_BY_CUSTOMER`.
- Các bid `LOST` khác giữ nguyên, không được mở lại.
- Gọi lại cùng request trả HTTP 409 `DEPOSIT_ALREADY_REFUNDED`.

## 7. Validation cancel-by-customer

| Body/tình huống | Mong đợi |
|---|---|
| Thiếu `action` | 400 `VALIDATION_ERROR` |
| Action ngoài danh sách | 400 `VALIDATION_ERROR` |
| Thiếu `reason_code` | 400 `VALIDATION_ERROR` |
| `reason_code=OTHER` nhưng thiếu/blank `reason_text` | 400 `VALIDATION_ERROR` |
| `reason_text` không phải string hoặc dài hơn 1000 ký tự | 400 `VALIDATION_ERROR` |
| Handyman token gọi customer endpoint | 403 từ role middleware |
| Customer khác gọi | 403 `FORBIDDEN_JOB_ACCESS` |
| Job không ACCEPTED | 409 `INVALID_JOB_STATUS` hoặc `DEPOSIT_ALREADY_REFUNDED` nếu đã refund |
| Cọc không HELD | 409 `DEPOSIT_NOT_HELD` |

## 8. Handyman hủy job ACCEPTED

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/cancel-by-handyman
Authorization: Bearer {{selected_handyman_token}}
Content-Type: application/json

{
  "reason_code": "SCHEDULE_CONFLICT",
  "reason_text": "Bị trùng lịch đột xuất"
}
```

Mong đợi:

- HTTP 200, job về `BIDDING`, deposit thành `REFUNDED`.
- Customer nhận lại 100% cọc.
- Selected IDs được clear.
- Bid selected thành `CANCELLED_BY_HANDYMAN`.
- Bid `LOST` hợp lệ khác thành `PENDING`.
- `accepted_cancellation_count` tăng 1; rating không thay đổi.
- Có cancellation action `HANDYMAN_WITHDRAW` và history `ACCEPTED → BIDDING`.

### 8.1 Không cho handyman đã tự hủy bid lại

Selected handyman cũ gọi lại POST bid cho cùng job. Mong đợi:

```json
{
  "EM": "You cannot bid again on a job you cancelled after acceptance.",
  "EC": 409,
  "code": "HANDYMAN_CANNOT_REBID_CANCELLED_JOB",
  "DT": ""
}
```

Gọi `GET /matchmaking/jobs/available` bằng handyman đó cũng không được thấy job này.

Các validation khác:

- Handyman khác gọi cancel: HTTP 403.
- Customer gọi endpoint handyman: HTTP 403 từ middleware.
- `OTHER` thiếu `reason_text`: HTTP 400.
- Reason code customer dùng nhầm cho handyman: HTTP 400.

## 9. Start moving

### 9.1 Body rỗng

```http
POST {{base_url}}/matchmaking/jobs/{{job_id}}/start-moving
Authorization: Bearer {{selected_handyman_token}}
Content-Type: application/json

{}
```

Mong đợi HTTP 200:

```json
{
  "EM": "Handyman started moving.",
  "EC": 0,
  "DT": {
    "job_id": "uuid",
    "status": "EN_ROUTE",
    "en_route_at": "timestamp"
  }
}
```

### 9.2 Có GPS

Với một job ACCEPTED mới:

```json
{
  "gps_lat": 21.0285,
  "gps_long": 105.8542
}
```

Mong đợi GPS được ghi ở `trigger_gps_lat/trigger_gps_long` của status history; GPS job không bị sửa.

### 9.3 Validation

| Tình huống | Mong đợi |
|---|---|
| Chỉ gửi một trong hai tọa độ | 400 `VALIDATION_ERROR` |
| Latitude ngoài `[-90,90]` | 400 `VALIDATION_ERROR` |
| Longitude ngoài `[-180,180]` | 400 `VALIDATION_ERROR` |
| Customer gọi | 403 từ middleware |
| Handyman khác gọi khi job ACCEPTED | 403 `FORBIDDEN_JOB_ACCESS` |
| Job không ACCEPTED | 409 `INVALID_JOB_STATUS` |
| Gọi lần hai bởi selected handyman | 409 `JOB_ALREADY_EN_ROUTE` |
| Customer/handyman bị inactive | 409 `PARTICIPANT_INACTIVE` |
| Deposit không HELD | 409 `DEPOSIT_NOT_HELD` |

Sau thành công, xác nhận bid vẫn `WON`, deposit vẫn `HELD`, customer wallet và escrow không thay đổi.

## 10. Kiểm thử concurrency

Mỗi kịch bản dùng một job ACCEPTED mới. Mở hai Postman tab, chuẩn bị sẵn request rồi gửi gần như đồng thời.

### 10.1 Customer cancel và handyman start-moving

- Tab 1: customer `REOPEN_BIDDING` hoặc `CANCEL_JOB`.
- Tab 2: selected handyman `start-moving`.
- Chỉ một request HTTP 200.
- Nếu start-moving thắng, job `EN_ROUTE` và cancel bị 409.
- Nếu cancel thắng, job `BIDDING/CANCELLED`; start-moving bị từ chối và không ghi `en_route_at`.

### 10.2 Hai customer cancel giống nhau

- Gửi cùng request cancel ở hai tab.
- Một request HTTP 200.
- Request còn lại HTTP 409.
- Chỉ có một refund transaction và wallet chỉ được cộng một lần.

### 10.3 Customer và handyman cùng cancel

- Một request dùng customer token, request kia dùng selected handyman token.
- Chỉ một cancellation/refund được commit.
- Request sau có thể nhận 403 hoặc 409 tùy request thắng có clear selected handyman ID hay không.

## 11. SQL audit chỉ đọc

Thay các placeholder UUID trước khi chạy.

### Job

```sql
SELECT
  id,
  customer_id,
  selected_handyman_id,
  selected_bid_id,
  current_status,
  deposit_amount,
  deposit_status,
  deposit_paid_at,
  accepted_at,
  en_route_at,
  cancelled_at,
  deposit_transaction_id,
  "updatedAt"
FROM "Jobs"
WHERE id = '<job_id>';
```

### Bids và kiểm tra không tạo bid trùng

```sql
SELECT id, job_id, handyman_id, proposed_price, status, "createdAt", "updatedAt"
FROM "Bids"
WHERE job_id = '<job_id>'
ORDER BY "createdAt";

SELECT handyman_id, COUNT(*)
FROM "Bids"
WHERE job_id = '<job_id>'
GROUP BY handyman_id;
```

Sau reactivation, bid ID phải giữ nguyên và count của handyman không tăng.

### Transaction cọc và refund

```sql
SELECT
  id,
  job_id,
  amount,
  transaction_type,
  status,
  from_wallet_id,
  to_wallet_id,
  reference_transaction_id,
  "createdAt"
FROM "Transactions"
WHERE job_id = '<job_id>'
ORDER BY "createdAt";
```

Mỗi lần đặt cọc có một `DEPOSIT_10 SUCCESS`. Nếu bị hủy trong ACCEPTED, transaction đó có tối đa một `DEPOSIT_REFUND SUCCESS` với `reference_transaction_id` trỏ về ID cọc.

### Wallet

```sql
SELECT id, user_id, wallet_type, balance, is_blocked, "updatedAt"
FROM "Wallets"
WHERE user_id = '<customer_id>'
   OR (user_id IS NULL AND wallet_type = 'SYSTEM_ESCROW')
ORDER BY wallet_type;
```

Tổng balance của customer wallet và SYSTEM_ESCROW phải được bảo toàn qua refund.

### Cancellation và status history

```sql
SELECT
  id,
  job_id,
  cancelled_by_user_id,
  cancelled_by_role,
  status_when_cancelled,
  cancellation_action,
  reason_code,
  reason_text,
  refund_amount,
  penalty_amount,
  "createdAt"
FROM "Job_Cancellations"
WHERE job_id = '<job_id>'
ORDER BY "createdAt";

SELECT
  id,
  job_id,
  changed_by_user_id,
  old_status,
  new_status,
  reason,
  trigger_gps_lat,
  trigger_gps_long,
  "createdAt"
FROM "Job_Status_Histories"
WHERE job_id = '<job_id>'
ORDER BY "createdAt";
```

### Reliability của handyman

```sql
SELECT user_id, total_jobs_completed, accepted_cancellation_count, bayesian_score
FROM "Handyman_Profiles"
WHERE user_id = '<handyman_id>';
```

`accepted_cancellation_count` chỉ tăng khi handyman tự hủy job ở `ACCEPTED`; customer hủy hoặc reopen không làm tăng trường này.
