# Cau hinh callback thanh toan top-up wallet

Tu khi dat coc job chuyen sang tru truc tiep tu vi noi bo, PayOS la gateway duy nhat dung de nap tien vao vi.

## PayOS top-up

Khi user thanh toan thanh cong, PayOS co the gui webhook ve backend:

```text
POST https://<public-backend>/api/v1/fintech/payos-webhook
```

Khi user bam huy tren trang PayOS, PayOS redirect browser ve `cancelUrl`.
Neu `cancelUrl` tro ve frontend local ma frontend khong goi lai backend, transaction se van `PENDING`
cho den khi cron danh dau `EXPIRED`.

De backend cap nhat thanh `FAILED` ngay khi user bam huy, cau hinh:

```env
PAYOS_RETURN_URL=http://localhost:5173/payment-success
PAYOS_CANCEL_URL=http://localhost:5173/payment-cancel
```

Voi cau hinh frontend local o tren, frontend se goi lai backend:

```text
GET /api/v1/fintech/payos-return?... 
GET /api/v1/fintech/payos-cancel?...
```

Neu muon PayOS redirect thang ve backend public thay vi qua frontend, cau hinh:

```env
BACKEND_PUBLIC_URL=https://<ngrok-backend>

PAYOS_TOPUP_RETURN_URL=https://<ngrok-backend>/api/v1/fintech/payos-return
PAYOS_TOPUP_CANCEL_URL=https://<ngrok-backend>/api/v1/fintech/payos-cancel
```

Sau khi sua `.env`, restart backend va tao payment link moi. Link cu van dung callback URL cu.

Ket qua mong doi:

- Thanh cong: ngrok thay `POST /api/v1/fintech/payos-webhook 200 OK`, transaction `SUCCESS`.
- Bam huy: ngrok thay `GET /api/v1/fintech/payos-cancel?... 200 OK`, transaction `FAILED`.
- Gateway bao het han: transaction `EXPIRED`.
- Dong tab/bo ngang: khong co callback cancel, transaction giu `PENDING` cho den khi cron chuyen thanh `EXPIRED`.

## Route fintech con su dung

```text
POST /api/v1/fintech/wallets/top-up
GET  /api/v1/fintech/wallets/system

POST /api/v1/fintech/payos-webhook
GET  /api/v1/fintech/payos-return
GET  /api/v1/fintech/payos-cancel
```

Khong con route callback rieng cho deposit gateway vi dat coc job da dung vi noi bo.
