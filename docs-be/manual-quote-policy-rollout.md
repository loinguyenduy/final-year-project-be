# Rollout development: Quote policy và dữ liệu demo

Tài liệu này chỉ dùng cho development/staging đã backup. Không chạy trên production.
Thay toàn bộ UUID mẫu trước khi chạy. `JOB_STANDARD_WARRANTY_DAYS=10` phải được cấu
hình trước khi tạo Draft mới.

## 1. Preview dữ liệu cần làm sạch

```sql
BEGIN;

CREATE TEMP TABLE "_quote_rollout_jobs" (
  job_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO "_quote_rollout_jobs" (job_id) VALUES
  ('00000000-0000-0000-0000-000000000001');

SELECT j.id, j.current_status, j.acceptance_cycle, j.deposit_status,
       j.selected_bid_id, j.final_agreed_price, j.in_progress_at
FROM "Jobs" j
JOIN "_quote_rollout_jobs" target ON target.job_id = j.id
FOR UPDATE;

SELECT
  (SELECT count(*) FROM "Job_Quotes" q
   JOIN "_quote_rollout_jobs" target ON target.job_id = q.job_id) AS quotes,
  (SELECT count(*) FROM "Job_Quote_Items" i
   JOIN "Job_Quotes" q ON q.id = i.quote_id
   JOIN "_quote_rollout_jobs" target ON target.job_id = q.job_id) AS quote_items,
  (SELECT count(*) FROM "Evidence_Vaults" e
   JOIN "_quote_rollout_jobs" target ON target.job_id = e.job_id
   WHERE e.stage = 'BEFORE') AS before_evidence,
  (SELECT count(*) FROM "E_Contracts" c
   JOIN "_quote_rollout_jobs" target ON target.job_id = c.job_id) AS contracts,
  (SELECT count(*) FROM "Transactions" t
   JOIN "_quote_rollout_jobs" target ON target.job_id = t.job_id
   WHERE t.transaction_type = 'SERVICE_REMAINING_PAYMENT'
     AND t.status = 'SUCCESS') AS remaining_payments,
  (SELECT count(*) FROM "Job_Cancellations" c
   JOIN "_quote_rollout_jobs" target ON target.job_id = c.job_id
   WHERE c.status IN ('AWAITING_COUNTERPARTY', 'REVIEW_REQUIRED')) AS active_cancellations;

SELECT t.id, t.job_id, t.amount, t.from_wallet_id, t.to_wallet_id,
       t.quote_id, t.acceptance_cycle, t.status
FROM "Transactions" t
JOIN "_quote_rollout_jobs" target ON target.job_id = t.job_id
WHERE t.transaction_type = 'SERVICE_REMAINING_PAYMENT'
ORDER BY t."createdAt";

ROLLBACK;
```

Không tiếp tục nếu có active cancellation, Job không thuộc dữ liệu demo, deposit không
`HELD`, Bid không `WON`, hoặc không xác minh được remaining payment.

## 2. Cleanup nguyên tử và hoàn ví remaining payment

```sql
BEGIN;

CREATE TEMP TABLE "_quote_rollout_jobs" (
  job_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO "_quote_rollout_jobs" (job_id) VALUES
  ('00000000-0000-0000-0000-000000000001');

SELECT j.id
FROM "Jobs" j
JOIN "_quote_rollout_jobs" target ON target.job_id = j.id
FOR UPDATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Job_Cancellations" c
    JOIN "_quote_rollout_jobs" target ON target.job_id = c.job_id
    WHERE c.status IN ('AWAITING_COUNTERPARTY', 'REVIEW_REQUIRED')
  ) THEN
    RAISE EXCEPTION 'Target Job has an active cancellation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Jobs" j
    JOIN "_quote_rollout_jobs" target ON target.job_id = j.id
    LEFT JOIN "Bids" b ON b.id = j.selected_bid_id
    WHERE j.deposit_status <> 'HELD' OR b.status <> 'WON'
  ) THEN
    RAISE EXCEPTION 'Target Job does not have HELD deposit and WON Bid';
  END IF;
END $$;

CREATE TEMP TABLE "_remaining_payment_reversal" ON COMMIT DROP AS
SELECT t.id AS transaction_id, t.from_wallet_id, t.to_wallet_id,
       t.amount::numeric AS amount
FROM "Transactions" t
JOIN "_quote_rollout_jobs" target ON target.job_id = t.job_id
WHERE t.transaction_type = 'SERVICE_REMAINING_PAYMENT'
  AND t.status = 'SUCCESS';

SELECT w.id, w.wallet_type, w.balance
FROM "Wallets" w
WHERE w.id IN (
  SELECT from_wallet_id FROM "_remaining_payment_reversal"
  UNION
  SELECT to_wallet_id FROM "_remaining_payment_reversal"
)
FOR UPDATE;

DO $$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "_remaining_payment_reversal" r
  JOIN "Wallets" customer_wallet ON customer_wallet.id = r.from_wallet_id
  JOIN "Wallets" escrow_wallet ON escrow_wallet.id = r.to_wallet_id
  WHERE customer_wallet.wallet_type <> 'CUSTOMER_MAIN'
     OR escrow_wallet.wallet_type <> 'SYSTEM_ESCROW'
     OR customer_wallet.currency <> 'VND'
     OR escrow_wallet.currency <> 'VND';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Remaining payment wallet relationship is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT r.to_wallet_id, sum(r.amount) AS reversal_amount
      FROM "_remaining_payment_reversal" r
      GROUP BY r.to_wallet_id
    ) total
    JOIN "Wallets" w ON w.id = total.to_wallet_id
    WHERE w.balance::numeric < total.reversal_amount
  ) THEN
    RAISE EXCEPTION 'SYSTEM_ESCROW balance is insufficient for reversal';
  END IF;
END $$;

UPDATE "Wallets" w
SET balance = w.balance::numeric + refund.amount,
    "updatedAt" = now()
FROM (
  SELECT from_wallet_id, sum(amount) AS amount
  FROM "_remaining_payment_reversal"
  GROUP BY from_wallet_id
) refund
WHERE w.id = refund.from_wallet_id;

UPDATE "Wallets" w
SET balance = w.balance::numeric - reversal.amount,
    "updatedAt" = now()
FROM (
  SELECT to_wallet_id, sum(amount) AS amount
  FROM "_remaining_payment_reversal"
  GROUP BY to_wallet_id
) reversal
WHERE w.id = reversal.to_wallet_id;

DELETE FROM "E_Contracts" c
USING "_quote_rollout_jobs" target
WHERE c.job_id = target.job_id;

DELETE FROM "Transactions" t
USING "_remaining_payment_reversal" reversal
WHERE t.id = reversal.transaction_id;

DELETE FROM "Job_Quote_Items" item
USING "Job_Quotes" quote, "_quote_rollout_jobs" target
WHERE item.quote_id = quote.id
  AND quote.job_id = target.job_id;

DELETE FROM "Evidence_Vaults" evidence
USING "Jobs" job, "_quote_rollout_jobs" target
WHERE evidence.job_id = job.id
  AND evidence.acceptance_cycle = job.acceptance_cycle
  AND evidence.stage = 'BEFORE'
  AND job.id = target.job_id;

DELETE FROM "Job_Quotes" quote
USING "_quote_rollout_jobs" target
WHERE quote.job_id = target.job_id;

DELETE FROM "Job_Status_Histories" history
USING "_quote_rollout_jobs" target
WHERE history.job_id = target.job_id
  AND (
    history.old_status IN ('ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING')
    OR history.new_status IN ('QUOTE_PENDING', 'PAYMENT_PENDING', 'IN_PROGRESS')
  );

UPDATE "Jobs" job
SET current_status = 'ARRIVED',
    final_agreed_price = bid.proposed_price,
    in_progress_at = NULL,
    "updatedAt" = now()
FROM "Bids" bid, "_quote_rollout_jobs" target
WHERE job.id = target.job_id
  AND bid.id = job.selected_bid_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Job_Quote_Items" item
    JOIN "Job_Quotes" quote ON quote.id = item.quote_id
    JOIN "_quote_rollout_jobs" target ON target.job_id = quote.job_id
  ) THEN
    RAISE EXCEPTION 'Quote items remain after cleanup';
  END IF;
END $$;

COMMIT;
```

## 3. Schema sync và verification

Tắt backend, đặt `DB_SYNC_ALTER=true`, khởi động đúng một lần, đợi log
`Job Quote indexes verified successfully`, sau đó đặt lại `false` và restart.

```sql
SELECT column_name, data_type, is_nullable, character_maximum_length
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'Job_Quote_Items'
  AND column_name IN ('name', 'description', 'quantity', 'unit')
ORDER BY column_name;

-- Expected:
-- name        character varying, NO, 150
-- description text, YES
-- quantity    integer, NO
-- unit        character varying, NO, 30

SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (
    (table_name = 'Job_Quotes' AND column_name = 'discount_amount')
    OR (table_name = 'E_Contracts' AND column_name = 'discount_amount')
  );

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname = 'job_quote_items_quote_sort_unique';

SELECT count(*) AS non_integer_quantity
FROM "Job_Quote_Items"
WHERE quantity <= 0;
```

Nếu không thể làm rỗng dữ liệu Quote, không chạy alter trực tiếp. Thực hiện rollout hai
bước: thêm `name` nullable, backfill và kiểm tra `name`; kiểm tra
`quantity = trunc(quantity)` cho toàn bộ dòng; chỉ sau đó mới đặt `name NOT NULL` và
chuyển quantity sang integer.

## 4. Contract test bắt buộc

- Create Draft trả `warranty_days=10`; client gửi `warranty_days` hoặc
  `discount_amount` nhận `400 VALIDATION_ERROR`.
- Item thiếu `name`, unit dài hơn 30, quantity `0`, âm hoặc `1.5` bị từ chối.
- Description null hợp lệ; unit là free text hợp lệ.
- Variance đúng 50% không yêu cầu reason; lớn hơn 50% yêu cầu reason trong readiness.
- Save lại dưới ngưỡng xóa canonical variance reason/text.
- Public Quote và Contract DTO không có `discount_amount`.
- Contract item snapshot có name, optional description và integer quantity.
- Payment dương/bằng 0 vẫn giữ transaction và Contract invariants cũ.
