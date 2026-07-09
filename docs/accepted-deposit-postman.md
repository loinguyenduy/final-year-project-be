# Kiểm thử luồng đặt cọc 10% và ACCEPTED bằng Postman

## 1. Đồng bộ model với database một lần

Trong `src/core/database/setup.js`, tạm thời đổi:

```js
// await db.sync({ alter: true });
```

thành:

```js
await db.sync({ alter: true });
```

Chạy backend:

```bash
npm run dev
```

Chờ log báo đồng bộ model thành công. Dừng server, comment lại dòng
`db.sync({ alter: true })`, sau đó khởi động server lần nữa.

Khi server khởi động, hệ thống tự bảo đảm chỉ có một `SYSTEM_ESCROW` và một
`SYSTEM_PROFIT`, cả hai có `user_id = null`.

## 2. Tạo Postman Environment

Tạo các biến:

| Biến | Giá trị ban đầu |
|---|---|
| `baseUrl` | `http://localhost:5000/api/v1` |
| `customerToken` | để trống |
| `otherCustomerToken` | để trống |
| `handyman1Token` | để trống |
| `handyman2Token` | để trống |
| `adminToken` | để trống |
| `jobId` | để trống |
| `bid1Id` | để trống |
| `bid2Id` | để trống |
| `depositTransactionId` | để trống |

Header cho API cần đăng nhập:

```text
Authorization: Bearer {{customerToken}}
Content-Type: application/json
```

Thay token theo vai trò trong từng bước.

## 3. Đăng nhập các tài khoản

### Customer

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json
```

```json
{
  "valueLogin": "customer-email-or-phone",
  "password": "your-password"
}
```

Trong tab Tests:

```js
const body = pm.response.json();
pm.environment.set("customerToken", body.DT.access_token);
```

Lặp lại cho customer thứ hai, hai handyman và admin, lưu vào đúng biến token.

## 4. Kiểm tra hai ví hệ thống dùng chung

```http
GET {{baseUrl}}/fintech/wallets/system
Authorization: Bearer {{adminToken}}
```

Kỳ vọng:

- HTTP `200`, `EC = 0`.
- Có đúng `SYSTEM_ESCROW` và `SYSTEM_PROFIT`.
- Ghi lại balance ban đầu của `SYSTEM_ESCROW`.
- Đăng nhập bằng admin thứ hai và gọi lại: hai wallet ID và balance phải giống hệt.

Customer hoặc handyman gọi API này phải nhận HTTP `403`.

## 5. Chuẩn bị một job BIDDING và hai bid

Có thể dùng job `BIDDING` hiện có. Nếu tạo mới:

1. Gọi `GET {{baseUrl}}/matchmaking/services` để lấy `service_id`.
2. Gọi `GET {{baseUrl}}/matchmaking/provinces` và
   `GET {{baseUrl}}/matchmaking/wards?province_code=...`.
3. Tạo job bằng customer:

```http
POST {{baseUrl}}/matchmaking/jobs
Authorization: Bearer {{customerToken}}
Content-Type: multipart/form-data
```

Form-data mẫu:

```text
service_id: <uuid>
issue_description: Sửa vòi nước bị rò
scheduled_at: 2026-07-20T03:00:00.000Z
address_option: 1
province_code: <code>
ward_code: <code>
detail_address: 123 Đường Test
estimated_budget_min: 800000
estimated_budget_max: 1500000
```

Lưu `DT.id` vào `jobId`.

Handyman 1 đặt bid:

```http
POST {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids
Authorization: Bearer {{handyman1Token}}
Content-Type: application/json
```

```json
{
  "proposed_price": 1000000,
  "message": "Tôi có thể thực hiện công việc này",
  "eta": "2026-07-20T02:30:00.000Z",
  "estimated_duration_hours": 2
}
```

Lưu `DT.id` vào `bid1Id`. Handyman 2 gửi bid tương tự với giá `1200000`,
lưu ID vào `bid2Id`.

## 6. Kiểm tra dữ liệu còn bị ẩn trước thanh toán

Handyman gọi:

```http
GET {{baseUrl}}/matchmaking/jobs/{{jobId}}
Authorization: Bearer {{handyman1Token}}
```

Kỳ vọng:

- `Customer.phone_number = null`.
- `detail_address`, `gps_lat`, `gps_long` là `null`.
- `service_address` chỉ còn phường/xã và tỉnh/thành phố.

## 7. Happy path với PayOS

### 7.1 Xem thông tin cọc, chưa thay đổi job

```http
GET {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids/{{bid1Id}}/deposit-summary
Authorization: Bearer {{customerToken}}
```

Với bid `1,000,000`, kỳ vọng:

```json
{
  "proposed_price": "1000000.00",
  "deposit_rate_percent": 10,
  "deposit_amount": 100000
}
```

Job vẫn phải là `BIDDING`.

### 7.2 Tạo payment

```http
POST {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids/{{bid1Id}}/deposit-payments
Authorization: Bearer {{customerToken}}
Content-Type: application/json
```

```json
{
  "payment_method": "PAYOS"
}
```

Kỳ vọng HTTP `201`:

- `DT.status = PENDING`.
- Có `DT.checkout_url`.
- Có `DT.expires_at`, cách thời điểm tạo khoảng 15 phút.
- Lưu `DT.transaction_id` vào `depositTransactionId`.

### 7.3 Kiểm tra trạng thái đang chờ

```http
GET {{baseUrl}}/matchmaking/jobs/{{jobId}}/deposit-payments/{{depositTransactionId}}/status
Authorization: Bearer {{customerToken}}
```

Kỳ vọng:

- `transaction_status = PENDING`.
- `job_status = PENDING_DEPOSIT`.
- `selected_bid_id = {{bid1Id}}`.
- `accepted_at` và `contact_unlocked_at` vẫn là `null`.

Trong lúc này:

- Job không xuất hiện trong `GET /matchmaking/jobs/available`.
- PATCH bid phải bị từ chối.
- DELETE/withdraw bid phải nhận HTTP `409`.
- Tạo payment thứ hai cho cùng job phải nhận HTTP `409`.
- Thông tin liên hệ vẫn bị ẩn.

### 7.4 Thanh toán sandbox

Mở `checkout_url` trong trình duyệt và thanh toán PayOS sandbox.

Webhook công khai cần trỏ đến:

```text
https://<public-backend>/api/v1/fintech/payos-webhook
```

Nếu backend chạy local, dùng tunnel HTTPS và cấu hình webhook URL trong kênh
thanh toán PayOS. Return URL chỉ phục vụ giao diện; backend chỉ chốt job từ
webhook có chữ ký hợp lệ.

### 7.5 Xác nhận ACCEPTED

Gọi lại status endpoint cho đến khi nhận:

- `transaction_status = SUCCESS`.
- `job_status = ACCEPTED`.
- `accepted_at` khác `null`.
- `contact_unlocked_at` khác `null`.

Customer gọi `GET /matchmaking/jobs/{{jobId}}`:

- `current_status = ACCEPTED`.
- `deposit_amount = 100000`.
- `final_agreed_price = 1000000`.
- Bid 1 là `WON`, bid 2 là `LOST`.
- Có số điện thoại và địa chỉ của `SelectedHandyman`.

Handyman 1 gọi cùng API:

- Thấy số điện thoại customer.
- Thấy địa chỉ làm việc và GPS đầy đủ.

Handyman 2 không được thấy dữ liệu liên hệ chi tiết.

Admin gọi lại `GET /fintech/wallets/system`: balance `SYSTEM_ESCROW` phải tăng
đúng `100000`; `SYSTEM_PROFIT` không đổi.

## 8. Happy path với VNPay

Dùng một job `BIDDING` mới và thực hiện lại các bước trên, nhưng body là:

```json
{
  "payment_method": "VNPAY"
}
```

Link tạo ra có `vnp_ExpireDate` sau 15 phút. VNPay IPN phải trỏ tới:

```text
https://<public-backend>/api/v1/fintech/vnpay-ipn
```

Sau giao dịch thành công, status endpoint phải trả `SUCCESS` và `ACCEPTED`
giống PayOS.

## 9. Các fail path

Mỗi trường hợp thay đổi trạng thái nên dùng một job `BIDDING` mới.

### 9.1 Không có token

Gọi deposit summary không có Authorization. Kỳ vọng HTTP `401`.

### 9.2 Sai role

Dùng `handyman1Token` gọi deposit summary. Kỳ vọng HTTP `403`.

### 9.3 Customer không sở hữu job

Dùng `otherCustomerToken`. Kỳ vọng HTTP `403`; không tạo Transaction.

### 9.4 Bid không thuộc job hoặc không tồn tại

Thay `bid1Id` bằng UUID khác. Kỳ vọng HTTP `404`.

### 9.5 Payment method không hợp lệ

```json
{
  "payment_method": "MOMO"
}
```

Kỳ vọng HTTP `400`; job vẫn `BIDDING`.

### 9.6 Tạo payment lặp

Sau khi payment đầu tiên đang `PENDING`, gọi create payment lần nữa.
Kỳ vọng HTTP `409`; hệ thống chỉ có một deposit đang chờ.

### 9.7 Sửa hoặc rút bid trong PENDING_DEPOSIT

```http
PATCH {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids/{{bid1Id}}
Authorization: Bearer {{handyman1Token}}
```

Kỳ vọng bị từ chối vì job không còn mở bidding.

```http
DELETE {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids/{{bid1Id}}
Authorization: Bearer {{handyman1Token}}
```

Kỳ vọng HTTP `409`.

### 9.8 Customer hủy PayOS

```http
POST {{baseUrl}}/matchmaking/jobs/{{jobId}}/deposit-payments/{{depositTransactionId}}/cancel
Authorization: Bearer {{customerToken}}
```

API kiểm tra trạng thái với PayOS và hủy link. Kỳ vọng:

- Transaction thành `FAILED`.
- Job trở về `BIDDING`.
- `selected_bid_id` và `deposit_transaction_id` trên job được xóa.
- Cả hai bid vẫn `PENDING`.
- Escrow không tăng.

Nếu PayOS báo `PAID` hoặc `PROCESSING`, API trả HTTP `409` và không hủy.

### 9.9 Customer hủy trên VNPay

Nhấn hủy trên trang VNPay sandbox. VNPay trả mã thất bại qua IPN. Kỳ vọng
Transaction `FAILED`, job trở lại `BIDDING`, bid giữ `PENDING`.

Endpoint cancel chủ động không áp dụng cho VNPay vì không được phép đánh dấu
thất bại trong DB khi link bên gateway vẫn có thể thanh toán.

### 9.10 Bỏ ngang quá 15 phút

Tạo payment nhưng không thanh toán và chờ quá 15 phút. Cron chạy mỗi phút.
Sau đó gọi status endpoint:

- Transaction là `EXPIRED`.
- Job là `BIDDING`.
- Hai bid vẫn `PENDING`.
- Escrow không tăng.

### 9.11 Replay webhook

Lấy đúng signed webhook body từ công cụ tunnel và gửi lại lần hai tới
`POST /fintech/payos-webhook`. Transaction vẫn `SUCCESS` và escrow không được
cộng thêm lần nữa.

Nếu sửa amount hoặc dữ liệu trong webhook mà không tạo lại signature hợp lệ,
webhook phải bị từ chối.

### 9.12 Đường accept cũ

```http
POST {{baseUrl}}/matchmaking/jobs/{{jobId}}/bids/{{bid1Id}}/accept
```

Kỳ vọng HTTP `404`. Không còn API nào có thể chuyển thẳng sang `ACCEPTED`
mà bỏ qua thanh toán.
