# Manual test — Admin Foundation & KYC Hardening

## 1. Điều kiện an toàn

- Chỉ chạy trên môi trường development/test và Cloudinary dành cho test.
- Backup PostgreSQL trước khi bật `DB_SYNC_ALTER=true`.
- Chỉ bật alter trên một backend instance; xác nhận schema xong phải tắt trước khi scale/restart.
- Cấu hình cookie, rate limit, seed và signed URL theo `.env.example`.
- Chuẩn bị Admin active/inactive, Customer, Handyman và submission mới; không dùng legacy row có `submission_id=NULL` để kiểm thử queue canonical.
- Mỗi request thủ công nên gửi `X-Correlation-ID` là UUID riêng. Không lưu password, token, cookie hoặc signed URL vào biên bản test.

## 2. Rollout schema

1. Bật `DB_SYNC_ALTER=true`, start đúng một backend instance rồi dừng sau khi sync thành công.
2. Xác nhận bảng `Admin_Audit_Logs`, FK `admin_id -> Users.id`, các index audit và các cột submission/Cloudinary/rejection trên `KYC_Requests`.
3. Xác nhận unique partial index `(submission_id, document_type)` và `cloudinary_public_id`.
4. Xác nhận legacy KYC row vẫn tồn tại và được phép có `submission_id=NULL`.
5. Tắt alter, start lại backend và kiểm tra API health.

Kỳ vọng: schema chỉ additive, không drop enum/column/data. Khi rollback ứng dụng, giữ nguyên bảng/cột mới và dừng Admin/KYC mutation trước khi redeploy.

## 3. Authentication matrix

Với mỗi case, ghi actor, endpoint/page, HTTP/code, RefreshToken trước/sau, cookie, audit và redirect UI.

| Case | Thao tác | Kỳ vọng |
|---|---|---|
| Admin hợp lệ | `POST /auth/admin/login` | 200 `ADMIN_LOGIN_SUCCEEDED`; token/cookie; một refresh row và một login audit trong cùng transaction |
| Sai password | Gọi Admin login | 401 `ADMIN_LOGIN_INVALID`; không token/cookie/refresh/audit |
| Participant ở Admin portal | Dùng Customer/Handyman credential | 401 generic `ADMIN_LOGIN_INVALID`; không tạo session |
| Admin ở participant login | `POST /auth/login` | 403 `ADMIN_PORTAL_REQUIRED`; không tạo session |
| Admin qua social | Google/Facebook trùng email Admin | Redirect `admin_portal_required`; không link provider/token/cookie |
| Admin inactive | Login Admin | 403 `ADMIN_NOT_ACTIVE`; không session |
| Deactivate sau login | Gọi `/admin/queue-counts` bằng access token cũ | 403 `ADMIN_NOT_ACTIVE`; frontend clear session |
| Refresh inactive | `POST /auth/refresh` | Presented token bị revoke, cookie clear, 403 `ADMIN_NOT_ACTIVE` |
| Role đổi giữa session | Đổi role rồi refresh | Refresh cũ bị revoke; không được nâng thành Admin session |
| Deep link | Mở `/admin/kyc?...` khi logged out rồi login | Session được xác minh trước khi render và trở lại đúng deep link |
| Logout | Logout từ AdminLayout | Chỉ refresh token hiện tại bị revoke; cookie clear; một `ADMIN_LOGOUT` audit |
| Logout lặp/lỗi mạng | Cookie đã mất hoặc backend unavailable | Local state/socket vẫn clear; không duplicate audit; UI cảnh báo khi server lỗi |
| Rate limit | Vượt ngưỡng ENV | 429 `RATE_LIMITED` và standard rate-limit headers |

Kiểm tra cookie trong DevTools ở development và production: `HttpOnly`, `Path=/`, `SameSite`, `Secure`, `Domain`, max age và tùy chọn clear phải khớp. Startup phải từ chối `SameSite=None` với `Secure=false`.

## 4. KYC upload

### Customer

1. Login Customer có `kyc_status=UNVERIFIED` hoặc `REJECTED`.
2. Upload đúng `cccd_front`, `cccd_back`, `portrait` bằng JPEG/PNG tối đa 5 MB.
3. Kỳ vọng 201 `KYC_SUBMITTED`; ba DB row có cùng submission UUID/sequence, `document_url=NULL`, delivery type `authenticated`; User chuyển `PENDING`.
4. Admin nhận `ADMIN_KYC_QUEUE_UPDATED`, sau đó refetch count/list canonical.

### Handyman

Lặp lại với thêm `certificate` và `cv`. Cả năm file phải là JPEG/PNG; PDF không được chấp nhận trong Task 1.

### Negative và cleanup

- Sai role, inactive, `PENDING` hoặc `VERIFIED`: bị từ chối trước Multer/Cloudinary.
- Thiếu, duplicate hoặc unexpected field; MIME/signature giả; file >5 MB: 400 stable code, không DB row.
- Giả lập upload lỗi giữa chuỗi: asset đã upload được destroy best-effort.
- Giả lập DB lỗi sau upload: transaction rollback, User giữ nguyên và asset mới được cleanup.
- Giả lập realtime lỗi sau commit: submission vẫn thành công và asset không bị cleanup.
- Cleanup lỗi chỉ log public ID/correlation ID, không log full URL; business error ban đầu không bị thay thế.

## 5. Admin queue, privacy và document access

1. `GET /admin/queue-counts`: `kyc_pending` bằng số distinct non-legacy pending submission.
2. `GET /admin/kyc/requests`: thử status/role/search/page/page_size, giá trị biên và query sai.
3. List phải có pagination canonical và không chứa `document_url`, `cloudinary_public_id` hoặc signed URL.
4. Guest/Customer/Handyman gọi queue/list/detail/access phải nhận 401/403.
5. Detail phải có document metadata, history summary và `allowed_actions` đúng trạng thái.
6. Document access phải trả `Cache-Control: no-store` và URL Cloudinary có chữ ký, `expires_at` khoảng 10 phút.
7. Sau khi URL hết hạn, viewer tự xin URL mới; nút Refresh access cũng cấp URL mới.
8. Legacy row không xuất hiện trong queue/count/history/private viewer.
9. Audit, socket payload và log không được chứa URL/public ID nhạy cảm.

## 6. Decision, audit và concurrency

### Approve

- Approve pending submission đầy đủ.
- Kỳ vọng mọi document `APPROVED`, User `VERIFIED`, Handyman level `C2`, đúng một `ADMIN_KYC_APPROVED` audit.
- Count/list/detail refetch; participant nhận `KYC_REVIEWED` rồi refetch profile.

### Reject

- Thử cả bảy reason code.
- Reject thiếu code; `OTHER` thiếu note; note whitespace/control character/HTML/>500 ký tự phải bị từ chối.
- Reject hợp lệ cập nhật đồng nhất document/User/reason và tạo đúng một `ADMIN_KYC_REJECTED` audit.
- Participant thấy English reason message/note và có thể resubmit với sequence mới; submission cũ không đổi.

### Concurrent review

```powershell
$env:NODE_ENV='development'
$env:ADMIN_KYC_TEST_ALLOW_DB_MUTATION='true'
$env:ADMIN_TEST_EMAIL='admin@example.test'
$env:ADMIN_TEST_PASSWORD='<test-password>'
$env:ADMIN_TEST_SUBMISSION_ID='<pending-submission-uuid>'
npm run admin:test:manual
```

Kỳ vọng: một request 200, một request 409 `KYC_REQUEST_ALREADY_REVIEWED`, một audit duy nhất. Script phải từ chối production hoặc khi thiếu mutation flag.

### Audit failure rollback

Trên disposable DB, tạm tạo PostgreSQL trigger làm INSERT vào `Admin_Audit_Logs` thất bại rồi gọi decision. Kỳ vọng HTTP 500 và document/User/Handyman đều rollback. Xóa trigger/function ngay sau test. Không dùng kỹ thuật này trên shared/staging/production DB.

## 7. Realtime và responsive/accessibility

- Admin join `user:{id}` và `role:ADMIN` nhưng không có Chat handlers/conversation room.
- Participant vẫn Chat bình thường và nhận KYC signal trong user room.
- Event payload chỉ có `event_id`, `occurred_at`, `queue/resource`; trùng event ID phải được dedupe.
- Reconnect và window focus phải refetch; không polling.
- Test 1440×900, 1366×768, 1024×768, 768×1024, 390×844 và 320×800.
- >=1024: sidebar persistent; <1024: drawer/backdrop/Escape/body lock.
- >=960: master-detail; <960: list -> detail -> Back; không horizontal overflow.
- Modal trap Tab/Shift+Tab, Escape không đóng khi submitting, đóng xong restore focus; icon-only button có accessible name.
- Stale 409 đóng modal, hiển thị message và refetch detail/list/count mà không làm mất filters.

## 8. Regression và quality gates

- Customer/Handyman password/social login, refresh, logout và KYC resubmit.
- Lifecycle, Chat send/read/reconnect, Job/Evidence Cloudinary upload giữ policy cũ.
- Admin Dashboard không có metric giả; module ngoài scope disabled/Coming soon.

```powershell
# Backend
Get-ChildItem src,scripts -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# Frontend
npm run lint
npm run build

# Chạy trong từng repository
git diff --check
```

Giới hạn đã chấp nhận: access token vẫn persisted trong localStorage; audit immutable ở application/API layer; chưa có Audit UI/Notification Center; không migrate hoặc cleanup legacy KYC assets/rows.
