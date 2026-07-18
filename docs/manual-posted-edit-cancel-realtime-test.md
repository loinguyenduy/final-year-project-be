# Manual test backend POSTED → BIDDING → ACCEPTED

Tài liệu này kiểm tra Edit/Cancel trước acceptance, realtime và guard Quote thấp hơn tiền cọc.
Không bật `DB_SYNC_ALTER`: task này không thêm hoặc xóa cột.

## 1. Chuẩn bị

- Một Customer đã KYC, hai Handyman đã KYC và hai browser đăng nhập riêng.
- Một Job `POSTED`, `acceptance_cycle=0`, không selected Bid/Handyman và không deposit.
- Theo dõi `Jobs`, `Bids`, `Job_Status_Histories`, `Job_Cancellations`, `Transactions` và wallet balances.
- Mở Socket.IO logs và xác nhận mỗi socket đã join `user:<userId>`.

## 2. Edit POSTED Job

### 2.1 Giữ location và ảnh

1. `GET /api/v1/matchmaking/jobs/:jobId`, lấy `updatedAt` và `images`.
2. Gửi multipart `PATCH /api/v1/matchmaking/jobs/:jobId` với các posting fields đầy đủ,
   `expected_updated_at`, `location_changed=false`, `retained_images` bằng JSON array hiện tại.
3. Kỳ vọng `200 JOB_UPDATED`; text/schedule/budget/service đổi, location snapshot giữ nguyên.
4. Không có status history mới và Job vẫn `POSTED`.

### 2.2 Thay location

- Lặp lại với `location_changed=true` và contract location hợp lệ cho option 1, 2 và 3.
- Option 1 giữ đúng `detail_address` đã trim và mã dropdown.
- Option 2 chỉ update tọa độ profile; text/mã profile không đổi.
- Option 3 giữ province/ward/detail null; provider lỗi dùng `Selected map location`.
- Xác minh provider hoàn tất trước `db.transaction()`.

### 2.3 Ảnh

- Giữ 2 ảnh cũ, bỏ 1 ảnh cũ, thêm 2 JPEG/PNG: response có đúng 4 URL.
- URL không thuộc Job trong `retained_images`: `400 INVALID_RETAINED_IMAGE`; ảnh mới đã upload được cleanup.
- Tổng trên 5: `400 JOB_IMAGE_LIMIT_EXCEEDED`; DB không đổi và ảnh mới được cleanup.
- Giả lập Cloudinary destroy ảnh cũ lỗi: DB vẫn commit; log chỉ chứa Job/public ID cần thiết.

### 2.4 Concurrency

- Mở form edit, sau đó Handyman submit Bid đầu tiên.
- Edit với `expected_updated_at` cũ phải trả `409 JOB_NOT_EDITABLE` hoặc `JOB_EDIT_CONFLICT`.
- Không được có trạng thái BIDDING nhưng dữ liệu edit commit một phần.

## 3. Early cancellation

### 3.1 POSTED

```http
POST /api/v1/matchmaking/jobs/:jobId/pre-acceptance-cancellation
Content-Type: application/json

{"reason":"POSTED_BY_MISTAKE","reason_text":null}
```

- Kỳ vọng `201 JOB_CANCELLED`.
- Job `CANCELLED`, `cancelled_at` có giá trị; đúng một history `POSTED → CANCELLED`.
- Cancellation `RESOLVED`, `acceptance_cycle=null`, `cancelled_from_status=POSTED`, financial fields null.
- DTO có `funds_status=NOT_APPLICABLE`.
- Không Transaction/wallet/conversation mutation.

### 3.2 BIDDING

- Tạo ít nhất hai Bid `PENDING`, cancel với một structured reason.
- Job chuyển `CANCELLED`; mọi `PENDING` thành `EXPIRED`; `WITHDRAWN` và lịch sử khác giữ nguyên.
- Retry trả `200 JOB_ALREADY_CANCELLED`, không tạo record/history/event thứ hai.
- `OTHER` thiếu note hoặc note trên 500 ký tự trả 400 và không mutation.
- `PENDING_DEPOSIT`/`ACCEPTED` trả `409 JOB_NOT_CANCELLABLE`.

### 3.3 Cancel và Bid đồng thời

- Gửi cancel và submit Bid cùng lúc.
- Job lock phải tuần tự hóa: hoặc Bid commit rồi cancellation expire Bid, hoặc cancellation commit và Bid bị từ chối.
- Không tồn tại Bid `PENDING` trên Job `CANCELLED`.

## 4. Realtime

- Bid đầu tiên: Customer nhận `JOB_BID_SUBMITTED` với `current_status=BIDDING`.
- Update Bid: Customer nhận `JOB_BID_UPDATED`.
- Withdraw Bid cuối: Customer nhận `JOB_BID_WITHDRAWN` với `current_status=POSTED`.
- Wallet deposit thành công: Customer và mọi bidder nhận đúng một `JOB_ACCEPTED`.
- Gateway settlement từ `PENDING_DEPOSIT`: emit cùng contract và không emit lại khi callback retry.
- Early cancel: Customer và mọi bidder nhận `JOB_CANCELLED`.
- Event không chứa proposed price của bidder khác, GPS, wallet balance hoặc transaction metadata.
- Socket emit lỗi sau commit không rollback DB.

## 5. Quote minimum bằng held deposit

- Với Bid 200.000 VND và deposit 20.000 VND:
  - Save Draft total 10.000 thành công nhưng readiness chứa `QUOTE_TOTAL_BELOW_HELD_DEPOSIT`,
    `minimum_quote_total_amount=20000`, không có `SUBMIT_QUOTE`.
  - Gọi submit trực tiếp trả `409 QUOTE_TOTAL_BELOW_HELD_DEPOSIT`.
  - Total 20.000 hợp lệ, remaining bằng 0.
  - Total 100.000 hợp lệ dù thấp hơn Bid.
- Kiểm tra variance `<50%`, `=50%`, `>50%`; chỉ `>50%` cần reason.
- Sau khi giảm xuống `<=50%`, canonical reason/text phải null.

## 6. Kiểm tra cuối

```powershell
node --check src/modules/matchmaking/services/CustomerJob.service.js
node --check src/modules/matchmaking/services/Bid.service.js
node --check src/modules/matchmaking/services/Quote.service.js
git diff --check
```
