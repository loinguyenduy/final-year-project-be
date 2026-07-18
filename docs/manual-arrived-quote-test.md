> Superseded. Do not use the legacy Draft payload examples in this file. Use
> `manual-quote-policy-rollout.md` and the frontend end-to-end manual instead.

# Hướng dẫn kiểm thử thủ công ARRIVED → QUOTE_PENDING

## 1. Mục tiêu và điều kiện an toàn

Tài liệu này kiểm tra backend khảo sát hiện trạng, ảnh BEFORE, Quote Draft và submit Quote. Không chạy trên production.

Chuẩn bị các biến:

- `BASE_URL=http://localhost:5000/api/v1/matchmaking`
- `CUSTOMER_TOKEN`, `HANDYMAN_TOKEN`, `OUTSIDER_TOKEN`, `ADMIN_TOKEN`
- `JOB_ID`: Job `ARRIVED`, deposit `HELD`, selected Bid `WON`, participant active.
- `QUOTE_ID`, `EVIDENCE_ID` lấy từ response tương ứng.
- Hai ảnh thật `before.jpg`, `before.png`; một file WebP và một file lớn hơn 5 MB.

Mọi request phải dùng access token còn hạn. Không đưa token, Cloudinary secret hoặc URL nhạy cảm vào log/tài liệu chia sẻ.

Xác nhận backend có các cấu hình sau trước khi test: `BEFORE_EVIDENCE_MAX_FILES=5`,
`BEFORE_EVIDENCE_MAX_SIZE_MB=5`, `FINAL_QUOTE_MAX_ITEMS=20`,
`FINAL_QUOTE_VARIANCE_THRESHOLD_PERCENT=50`, `FINAL_QUOTE_MAX_AMOUNT=100000000`,
`FINAL_QUOTE_MAX_DURATION_MINUTES=43200`, `FINAL_QUOTE_MAX_WARRANTY_DAYS=3650`,
`INSPECTION_NOTE_MAX_LENGTH=2000`, `QUOTE_TEXT_MAX_LENGTH=2000` và
`VARIANCE_REASON_TEXT_MAX_LENGTH=500`.

## 2. Đồng bộ schema development đúng một lần

### Test S1 — Backup và sync alter

- Steps: backup database; dừng backend; đặt `DB_SYNC_ALTER=true`; khởi động đúng một lần; chờ log sync/index thành công; đặt lại `false`; restart.
- Request: không có.
- Expected HTTP/envelope: N/A.
- Expected database: có `Job_Quotes`, `Job_Quote_Items`; `Jobs.current_status` nhận `QUOTE_PENDING`; `Evidence_Vaults` có metadata mới.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: duplicate Draft/version làm partial index không tạo được; quên tắt alter; PostgreSQL enum chưa nhận giá trị mới.

### Test S2 — Kiểm tra table, column và index

- Steps: chạy các SQL dưới đây bằng account chỉ đọc.
- Request: không có.
- Expected HTTP/envelope: N/A.
- Expected database: hai unique index Quote hợp lệ, item sort unique và evidence cycle index tồn tại.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: chạy nhầm schema; tên table có chữ hoa cần dấu ngoặc kép.

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN ('Job_Quotes', 'Job_Quote_Items', 'Evidence_Vaults');

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('Jobs', 'Job_Quotes', 'Job_Quote_Items', 'Evidence_Vaults')
ORDER BY table_name, ordinal_position;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname IN (
    'job_quotes_job_cycle_version_unique',
    'job_quotes_one_draft_per_cycle',
    'job_quote_items_quote_sort_unique',
    'evidence_vaults_job_cycle_stage'
  );

SELECT id, current_status
FROM "Jobs"
WHERE id = '<JOB_ID>';
```

## 3. Evidence BEFORE và Cloudinary

### Test E1 — Upload JPEG/PNG hợp lệ

- Steps: gửi lần lượt một JPEG và PNG thật bằng selected Handyman.
- Request: `POST /jobs/:JOB_ID/evidence/before`, multipart field `image`.
- Expected HTTP/envelope: `201`, `code=BEFORE_EVIDENCE_CREATED`; DTO không có `cloudinary_public_id`.
- Expected database: mỗi request tạo một `Evidence_Vaults` stage `BEFORE`, đúng Job/cycle/participants, SHA-256 64 ký tự, MIME/size/public ID/URL đầy đủ.
- Expected Cloudinary: file ở `final_year_project/jobs/{jobId}/cycles/{cycle}/before`.
- Expected realtime: không có event.
- Common failures: field dùng `images` thay vì `image`; file extension đúng nhưng magic bytes sai; token không phải selected Handyman.

```bash
curl -X POST "$BASE_URL/jobs/$JOB_ID/evidence/before" \
  -H "Authorization: Bearer $HANDYMAN_TOKEN" \
  -F "image=@before.jpg;type=image/jpeg"
```

### Test E2 — MIME, magic bytes và giới hạn 5 MB

- Steps: upload WebP; đổi tên text thành `.jpg`; upload JPEG lớn hơn 5 MB.
- Request: như E1.
- Expected HTTP/envelope: WebP/fake image `415 INVALID_IMAGE_TYPE`; file lớn `413 IMAGE_TOO_LARGE`.
- Expected database: không có Evidence mới.
- Expected Cloudinary: không upload.
- Expected realtime: không có event.
- Common failures: REST client tự đặt sai Content-Type; proxy thay đổi multipart payload.

### Test E3 — Giới hạn năm ảnh

- Steps: đảm bảo cycle có năm Evidence active; upload ảnh thứ sáu.
- Request: như E1.
- Expected HTTP/envelope: `409 BEFORE_EVIDENCE_LIMIT_REACHED`.
- Expected database: count vẫn bằng năm.
- Expected Cloudinary: preflight bình thường không upload; nếu race xảy ra, ảnh vừa upload phải được destroy best-effort.
- Expected realtime: không có event.
- Common failures: đếm nhầm Evidence legacy/cycle cũ; một ảnh đã bị xóa hard-delete.

### Test E4 — List và privacy khi Draft

- Steps: gọi list bằng selected Handyman, Admin, Customer và outsider khi Quote chưa submit.
- Request: `GET /jobs/:JOB_ID/evidence/before`.
- Expected HTTP/envelope: Handyman/Admin `200`; Customer/outsider `404 EVIDENCE_NOT_FOUND`.
- Expected database: không mutation.
- Expected Cloudinary: không có request; response không chứa public ID.
- Expected realtime: không có event.
- Common failures: Job đã `QUOTE_PENDING`; dùng Customer không phải owner.

### Test E5 — Delete trước submit

- Steps: chọn `EVIDENCE_ID` current cycle rồi xóa bằng selected Handyman.
- Request: `DELETE /jobs/:JOB_ID/evidence/before/:EVIDENCE_ID`.
- Expected HTTP/envelope: `200 BEFORE_EVIDENCE_DELETED`.
- Expected database: Evidence bị hard-delete sau commit.
- Expected Cloudinary: destroy chạy sau DB commit.
- Expected realtime: không có event.
- Common failures: Evidence thuộc cycle khác/uploader khác; public ID legacy null.

### Test E6 — DB lỗi sau upload và Cloudinary cleanup

- Steps: trong development tạo race bằng cách submit Quote/chuyển status ngay khi upload đang chạy, hoặc tạm gây DB create lỗi sau provider upload.
- Request: upload như E1.
- Expected HTTP/envelope: lifecycle `409` hoặc internal error an toàn.
- Expected database: không có Evidence orphan.
- Expected Cloudinary: file vừa upload được destroy best-effort sau rollback.
- Expected realtime: không có event.
- Common failures: kiểm thử bằng cách giữ transaction DB rồi chờ provider; không được làm vậy.

### Test E7 — Cloudinary destroy lỗi

- Steps: development-only, làm destroy trả lỗi sau khi DB delete đã commit.
- Request: delete như E5.
- Expected HTTP/envelope: vẫn `200 BEFORE_EVIDENCE_DELETED`.
- Expected database: Evidence vẫn đã xóa, không rollback.
- Expected Cloudinary: có thể còn orphan; log có Job/Evidence/public ID nhưng không có secret/token.
- Expected realtime: không có event.
- Common failures: mong DB rollback sau external cleanup; đây không phải semantics đã chọn.

## 4. Quote Draft

### Test Q1 — Create Draft và retry

- Steps: gọi hai lần bằng selected Handyman.
- Request: `POST /jobs/:JOB_ID/quotes/draft`, body `{}`.
- Expected HTTP/envelope: lần đầu `201 QUOTE_DRAFT_CREATED`; lần hai `200 QUOTE_DRAFT_EXISTS`, cùng Quote ID/version 1/revision 0.
- Expected database: đúng một row `(job_id, cycle, version=1, DRAFT)`.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: Job chưa ARRIVED; deposit không HELD; Bid không WON; participant inactive.

### Test Q2 — Authorization và lifecycle Draft

- Steps: thử create bằng Customer/outsider; selected Handyman thử trên Job EN_ROUTE/CANCELLED; Admin thử write.
- Request: như Q1.
- Expected HTTP/envelope: role middleware `403`, hoặc `409 JOB_NOT_ARRIVED`; không trả Draft cho outsider.
- Expected database: không tạo/update Quote.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: token role không khớp dữ liệu User; test nhầm Job/cycle.

### Test Q3 — Lưu Draft chưa hoàn thiện

- Steps: lấy revision 0; gửi full replacement với text null, duration/warranty null, items rỗng, discount 0.
- Request: `PUT /jobs/:JOB_ID/quotes/:QUOTE_ID`.
- Expected HTTP/envelope: `200 QUOTE_DRAFT_UPDATED`, revision 1, readiness false.
- Expected database: items rỗng; totals 0; nullable report fields vẫn null.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: bỏ `expected_draft_revision`; gửi total/line_total làm unknown field.

```json
{
  "expected_draft_revision": 0,
  "problem_summary": null,
  "inspection_notes": null,
  "recommended_solution": null,
  "estimated_duration_minutes": null,
  "warranty_days": null,
  "discount_amount": 0,
  "items": [],
  "variance_reason": null,
  "variance_reason_text": null
}
```

### Test Q4 — Replace items và tính tiền canonical

- Steps: PUT một payload đầy đủ; PUT lần nữa với revision mới và danh sách khác.
- Request: payload ví dụ dưới đây.
- Expected HTTP/envelope: `200`, revision tăng đúng một; line total/totals là string backend tính.
- Expected database: item list cũ bị thay toàn bộ, sort order 0..n-1, không có item sót/duplicate.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: gửi revision cũ; quantity có hơn ba số lẻ; unit rỗng.

```json
{
  "expected_draft_revision": 1,
  "problem_summary": "Máy bơm bị hỏng tụ điện.",
  "inspection_notes": "Thiết bị đã sử dụng lâu năm.",
  "recommended_solution": "Thay tụ điện và kiểm tra đường dây.",
  "estimated_duration_minutes": 120,
  "warranty_days": 0,
  "discount_amount": 0,
  "items": [
    {
      "item_type": "LABOUR",
      "description": "Công kiểm tra và sửa chữa",
      "quantity": "1",
      "unit": "job",
      "unit_price": 200000
    },
    {
      "item_type": "MATERIAL",
      "description": "Dây điện",
      "quantity": "1.555",
      "unit": "m",
      "unit_price": 1001
    }
  ],
  "variance_reason": null,
  "variance_reason_text": null
}
```

Với dòng thứ hai, expected `line_total=1557` vì `1.555 × 1001 = 1556.555`, làm tròn half-up đến một VND.

### Test Q5 — Revision và concurrent update

- Steps: gửi hai PUT đồng thời cùng `expected_draft_revision`.
- Request: hai payload hợp lệ nhưng khác nội dung.
- Expected HTTP/envelope: một request `200`; request còn lại `409 QUOTE_DRAFT_REVISION_CONFLICT` và nhận current revision.
- Expected database: chỉ payload thắng được lưu nguyên tử; không trộn items giữa hai request.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: REST client vô tình gửi request tuần tự với revision đã refresh.

### Test Q6 — Validation item và tiền

- Steps: lần lượt thử item type sai, description/unit rỗng, quantity 0/âm/NaN/Infinity/1.0001, unit price âm/lẻ, discount âm/lớn hơn subtotal, hơn 20 items, total hơn 100 triệu.
- Request: PUT Draft.
- Expected HTTP/envelope: `400 INVALID_QUOTE_ITEM` hoặc `INVALID_QUOTE_AMOUNT`.
- Expected database: revision/items/totals không đổi.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: JSON không biểu diễn được NaN/Infinity chuẩn; dùng chuỗi để kiểm tra backend reject.

### Test Q7 — Duration, warranty và text

- Steps: thử duration 0/43201/số lẻ; warranty -1/3651/số lẻ; text quá giới hạn.
- Request: PUT Draft.
- Expected HTTP/envelope: `400 INVALID_ESTIMATED_DURATION`, `INVALID_WARRANTY_DAYS` hoặc validation error.
- Expected database: không mutation.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: warranty 0 là hợp lệ; null hợp lệ khi Draft nhưng không hợp lệ khi submit.

## 5. Variance

### Test V1 — Dưới, đúng và trên 50%

- Steps: lấy giá selected Bid B; tạo totals nhỏ hơn `1.5B`, đúng `1.5B`, rồi lớn hơn `1.5B`.
- Request: PUT Draft từng trường hợp với revision mới.
- Expected HTTP/envelope: update đều `200`; `variance_reason_required=false` ở dưới/đúng ngưỡng và `true` khi lớn hơn.
- Expected database: bid reference lấy từ Bid, không từ request; variance amount/percent canonical.
- Expected Cloudinary: không có request.
- Expected realtime: không có event.
- Common failures: dùng floating-point phía client để so equality; backend dùng scaled decimal.

### Test V2 — Reason và OTHER

- Steps: tạo total trên threshold; submit khi thiếu reason; cập nhật `OTHER` thiếu text; sau đó thêm text; thử reason enum sai.
- Request: PUT rồi submit.
- Expected HTTP/envelope: Draft có thể lưu chưa đủ; submit thiếu reason/text trả `409`; enum sai trả `400`; đủ reason/text submit được nếu các điều kiện khác đủ.
- Expected database: không chuyển Job khi reason chưa đủ.
- Expected Cloudinary: không có request khi PUT/submit.
- Expected realtime: không emit khi submit thất bại.
- Common failures: gửi reason text nhưng reason null; nhầm đúng 50% với trên 50%.

### Test V3 — Bid null/0 và giá Quote thấp hơn Bid

- Steps: development-only, kiểm tra dữ liệu legacy Bid null/0; sau đó dùng Bid hợp lệ và Quote thấp hơn Bid.
- Request: create/update/submit Quote.
- Expected HTTP/envelope: Bid null/0 trả `409 ACCEPTED_DATA_INCONSISTENT`; Quote thấp hơn Bid hợp lệ với variance âm.
- Expected database: Job không đổi status trong case Bid lỗi.
- Expected Cloudinary: không có request từ Quote.
- Expected realtime: không emit khi lỗi.
- Common failures: model Bid normally không cho null; case này dùng để audit dữ liệu legacy/tampered.

## 6. Submit và concurrency

### Test T1 — Thiếu điều kiện submit

- Steps: lần lượt thiếu BEFORE, problem summary, solution, duration, warranty, items hoặc total dương.
- Request: `POST /jobs/:JOB_ID/quotes/:QUOTE_ID/submit`, body `{}`.
- Expected HTTP/envelope: `409` với code requirement tương ứng và `DT.readiness`.
- Expected database: Quote vẫn DRAFT, Job vẫn ARRIVED, không có history mới.
- Expected Cloudinary: không có request.
- Expected realtime: không event.
- Common failures: Evidence thuộc cycle/selected Bid cũ không được tính.

### Test T2 — Submit thành công

- Steps: chuẩn bị Draft hợp lệ và 1–5 BEFORE; chụp snapshot Job/Bid/deposit/wallet/conversation; submit.
- Request: POST submit body `{}`.
- Expected HTTP/envelope: `200 QUOTE_SUBMITTED`, Quote `SUBMITTED`, Job `QUOTE_PENDING`.
- Expected database: đúng một history `ARRIVED → QUOTE_PENDING`; submitted_at/totals canonical; `final_agreed_price`, deposit `HELD`, Bid `WON`, selected IDs/cycle giữ nguyên; không Transaction/Wallet mutation.
- Expected Cloudinary: không có request khi submit.
- Expected realtime: đúng một `JOB_QUOTE_SUBMITTED` tới Customer và selected Handyman, không có raw Cloudinary metadata.
- Common failures: submit body chứa field thừa; participant inactive; deposit không còn HELD.

### Test T3 — Double/concurrent submit

- Steps: gửi hai submit đồng thời, sau đó retry lần ba.
- Request: như T2.
- Expected HTTP/envelope: một `QUOTE_SUBMITTED`; request còn lại/retry `200 QUOTE_ALREADY_SUBMITTED`.
- Expected database: một history, submitted_at không đổi, không duplicate Quote/items.
- Expected Cloudinary: không có request.
- Expected realtime: chỉ request commit đầu emit.
- Common failures: đếm event từ hai socket/tab thay vì số lần server emit.

### Test T4 — Upload/delete chạy đồng thời với submit

- Steps: gửi upload hoặc delete cùng lúc submit.
- Request: Evidence endpoint và submit endpoint song song.
- Expected HTTP/envelope: operation lấy Job lock trước commit; operation còn lại nhận kết quả lifecycle ổn định, không có trạng thái nửa vời.
- Expected database: nếu submit thắng, không Evidence mutation sau submit; nếu evidence thắng, submit đọc count cuối cùng.
- Expected Cloudinary: upload thua lifecycle được cleanup; delete đã commit trước submit thì file bị destroy sau commit.
- Expected realtime: chỉ submit thành công emit một event.
- Common failures: giữ transaction mở trong lúc chờ Cloudinary; implementation không được làm vậy.

### Test T5 — Socket emit lỗi

- Steps: tắt Socket.IO gateway hoặc giả lập emit throw rồi submit Quote hợp lệ.
- Request: submit.
- Expected HTTP/envelope: vẫn `200 QUOTE_SUBMITTED`.
- Expected database: Quote/Job/history đã commit.
- Expected Cloudinary: không có request.
- Expected realtime: event có thể mất; lỗi được log an toàn, không rollback.
- Common failures: gây lỗi trước commit thay vì đúng bước emit sau commit.

## 7. Read API, privacy, chat và cancellation

### Test P1 — Current Quote privacy

- Steps: khi Draft gọi GET bằng Handyman/Admin/Customer/outsider; lặp lại sau submit.
- Request: `GET /jobs/:JOB_ID/quotes/current`.
- Expected HTTP/envelope: Draft chỉ Handyman/Admin `200`; Customer/outsider `404`. Submitted cho Customer owner/Handyman/Admin `200`, outsider `404`.
- Expected database: không mutation.
- Expected Cloudinary: không request.
- Expected realtime: không event.
- Common failures: Customer nhận draft revision/internal participant fields; đây là lỗi privacy.

### Test P2 — Evidence khóa và Customer đọc sau submit

- Steps: sau submit thử upload/delete; Customer owner gọi list.
- Request: Evidence POST/DELETE/GET.
- Expected HTTP/envelope: writes `409 EVIDENCE_LOCKED`; Customer GET `200`.
- Expected database: Evidence không đổi.
- Expected Cloudinary: không upload/destroy sau submit.
- Expected realtime: không event.
- Common failures: dùng Evidence cycle cũ; DTO lộ public ID/hash cho Customer.

### Test P3 — accepted-details và allowed_actions

- Steps: gọi details theo từng role ở ARRIVED có/không Draft, Draft ready/not-ready và QUOTE_PENDING.
- Request: `GET /jobs/:JOB_ID/accepted-details`.
- Expected HTTP/envelope: `200`; actions đúng role/readiness; Admin `[]`; không có cancel/accept/reject/revision action chưa hỗ trợ.
- Expected database: không mutation.
- Expected Cloudinary: không request.
- Expected realtime: không event.
- Common failures: Customer thấy Draft summary trong ARRIVED; `SUBMIT_QUOTE` xuất hiện khi chưa ready.

### Test P4 — Chat giữ nguyên trong QUOTE_PENDING

- Steps: trước submit ghi conversation ID/cycle/status/message count/read cursors; submit; join/send/read bằng hai participant.
- Request: chat REST/socket hiện có.
- Expected HTTP/envelope: chat thành công; conversation vẫn `ACTIVE`.
- Expected database: cùng ID/cycle/history/read cursors, chỉ message/read action hợp lệ thay đổi tương ứng.
- Expected Cloudinary: không request.
- Expected realtime: chat event hoạt động cùng `JOB_QUOTE_SUBMITTED` riêng biệt.
- Common failures: thiếu `QUOTE_PENDING` trong chat-valid statuses làm reconcile đóng conversation.

### Test P5 — Cancellation bị khóa

- Steps: Customer và Handyman gọi cancellation khi Job ARRIVED rồi QUOTE_PENDING; chụp DB trước/sau.
- Request: `/jobs/:id/cancel-by-customer` và `/jobs/:id/cancel-by-handyman`.
- Expected HTTP/envelope: `409 CANCELLATION_NOT_ALLOWED_IN_CURRENT_STATUS`.
- Expected database: không Job Cancellation/history/refund; deposit/Bid/selected IDs/cycle/conversation/wallet giữ nguyên.
- Expected Cloudinary: không request.
- Expected realtime: không cancellation/chat close event.
- Common failures: endpoint chỉ khóa ARRIVED nhưng quên QUOTE_PENDING.

## 8. Acceptance cycle và audit SQL

### Test C1 — Cycle mới supersede Draft cũ

- Steps: trên dữ liệu development theo lifecycle task tương lai/fixture hợp lệ, tạo cycle mới khi cycle cũ có Draft.
- Request: transition accept/deposit hiện có.
- Expected HTTP/envelope: transition thành công theo API hiện có.
- Expected database: Draft cũ `SUPERSEDED`; Submitted Quote và Evidence cũ giữ nguyên; cycle mới không tái sử dụng chúng.
- Expected Cloudinary: không xóa Evidence cũ.
- Expected realtime: chỉ event của transition hiện có.
- Common failures: thử dùng cancellation ARRIVED hiện đang bị khóa; không sửa DB production để tạo case.

### Test C2 — SQL audit cuối

- Steps: chạy SQL dưới đây sau toàn bộ test.
- Request: không có.
- Expected HTTP/envelope: N/A.
- Expected database: không duplicate version/Draft/sort order, không orphan item/evidence context, đúng một history submit.
- Expected Cloudinary: đối chiếu public IDs active với asset provider; ghi nhận orphan cleanup failure nếu có.
- Expected realtime: N/A.
- Common failures: so sánh toàn database thay vì đúng Job/cycle test.

```sql
SELECT id, current_status, acceptance_cycle, selected_bid_id,
       selected_handyman_id, final_agreed_price, deposit_amount, deposit_status
FROM "Jobs"
WHERE id = '<JOB_ID>';

SELECT *
FROM "Job_Quotes"
WHERE job_id = '<JOB_ID>'
ORDER BY acceptance_cycle, version;

SELECT qi.*
FROM "Job_Quote_Items" qi
JOIN "Job_Quotes" q ON q.id = qi.quote_id
WHERE q.job_id = '<JOB_ID>'
ORDER BY q.acceptance_cycle, q.version, qi.sort_order;

SELECT id, job_id, acceptance_cycle, customer_id, handyman_id,
       selected_bid_id, uploader_id, stage, media_type, mime_type,
       file_size, file_hash, cloudinary_public_id, uploaded_at
FROM "Evidence_Vaults"
WHERE job_id = '<JOB_ID>'
ORDER BY acceptance_cycle, uploaded_at;

SELECT old_status, new_status, changed_by_user_id, reason, "createdAt"
FROM "Job_Status_Histories"
WHERE job_id = '<JOB_ID>'
ORDER BY "createdAt";

SELECT job_id, acceptance_cycle, version, COUNT(*)
FROM "Job_Quotes"
GROUP BY job_id, acceptance_cycle, version
HAVING COUNT(*) > 1;

SELECT job_id, acceptance_cycle, COUNT(*)
FROM "Job_Quotes"
WHERE status = 'DRAFT'
GROUP BY job_id, acceptance_cycle
HAVING COUNT(*) > 1;

SELECT quote_id, sort_order, COUNT(*)
FROM "Job_Quote_Items"
GROUP BY quote_id, sort_order
HAVING COUNT(*) > 1;

SELECT qi.id
FROM "Job_Quote_Items" qi
LEFT JOIN "Job_Quotes" q ON q.id = qi.quote_id
WHERE q.id IS NULL;

SELECT transaction_type, status, amount, reference_transaction_id, "createdAt"
FROM "Transactions"
WHERE job_id = '<JOB_ID>'
ORDER BY "createdAt";

SELECT id, job_id, acceptance_cycle, status, customer_id, handyman_id,
       selected_bid_id, customer_last_read_message_id,
       handyman_last_read_message_id, "updatedAt"
FROM "Conversations"
WHERE job_id = '<JOB_ID>'
ORDER BY acceptance_cycle;
```

## 9. Kiểm tra tĩnh trước bàn giao

### Test F1 — Syntax và whitespace

- Steps: chạy `node --check` cho mọi file JavaScript đã đổi/tạo; chạy `git diff --check`; xem `git status --short`.
- Request: không có.
- Expected HTTP/envelope: N/A.
- Expected database: không kết nối hoặc sync database.
- Expected Cloudinary: không request.
- Expected realtime: không event.
- Common failures: vô tình khởi động server với `DB_SYNC_ALTER=true`; tạo migration/test/frontend ngoài scope.

Task này không có pagination, automated test, migration hoặc frontend change.
