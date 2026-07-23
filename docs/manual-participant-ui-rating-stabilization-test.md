# Manual Test — Participant UI, Profile, Rating and Shared Shell

## Preconditions

- Non-production backend and frontend.
- Active Customer and Handyman with valid sessions.
- One CLOSED Job for the current acceptance cycle where neither party has submitted a Review.
- One Handyman with both `HANDYMAN_MAIN` and `HANDYMAN_ESCROW`.
- Do not edit Wallet balances or financial rows to prepare data.

## 1. Logout matrix

For each participant role:

1. Sign in and establish REST and Socket activity.
2. Select Log out.
3. Verify `POST /api/v1/auth/logout` is attempted.
4. Verify Redux Persist auth is cleared, authenticated Sockets are released and destination is `/`.
5. Repeat with backend offline. Local cleanup and `/` redirect must still occur; one warning is acceptable.
6. Verify Admin logout still redirects to `/admin/login`.

## 2. Header and sidebar

1. Verify no bell, fake count, notification dropdown or Customer My Jobs badge exists.
2. At desktop width collapse/expand the sidebar. Verify a 72px icon rail, accessible labels/tooltips and keyboard focus.
3. Reload; collapsed state must not persist.
4. Below 992px open the drawer. Verify backdrop, Escape close, route-selection close, logout close and body scroll lock.
5. Verify image failure falls back to the same initials in header/sidebar/profile.

## 3. Overview and My Jobs

1. Verify Overview has no large Refresh button, chart, trend or fake metric.
2. Verify Action Required is visually stronger and all values come from the existing overview response.
3. Test each approved quick view for both roles.
4. Verify `Completed` sends `view=CLOSED`.
5. Test all three sort choices and pagination; reload/back must retain URL state.
6. Verify no participant Job status displays raw `CLOSED`.

## 4. Public profile and dialogs

1. From Customer bids and Handyman Job partner identity, select avatar/name.
2. Verify the public profile opens in-place and contains only safe public fields, rating distribution and Reviews.
3. Verify no email, phone, address, GPS, Wallet or Chat content appears.
4. Test Tab cycle, focus trap, Escape, backdrop, scroll lock and focus restoration.
5. Open Bid comparison at desktop/mobile widths. Verify its table scrolls internally and hire actions are unchanged.
6. Open deposit confirmation. Verify handyman, proposed price, backend deposit percent/amount, Wallet balance, missing amount and escrow wording.

## 5. Profile

For Customer and Handyman:

1. Verify Overview, Reviews and Security tabs.
2. Verify password actions appear only under Security.
3. Verify Reviews show exact arithmetic average/count/distribution and Load more.
4. Verify zero Reviews displays `No reviews yet`.

## 6. Five-star end-to-end

1. On the eligible CLOSED Job choose each star value from 1 through 5 by pointer and keyboard.
2. Before submit verify the number of filled stars equals the chosen value.
3. Select 5 and submit.
4. Network request must contain `{ "rating": 5 }`.
5. Database must contain `rating_stars=5` for the canonical cycle/parties.
6. Job detail and Review list must return `rating: 5`.
7. Submitted Review and profile must render five filled stars.
8. Duplicate/concurrent submission remains HTTP 409 with one Review row.

## 7. Rating contract

1. Call Profile, Overview, Bid comparison, accepted Job detail, Admin User and Admin Job read surfaces.
2. Every rating summary must use `review_count`, `average_rating`, `distribution`.
3. No response/UI may use `bayesian_rating`, `rating_status`, `raw_average`, `Developing` or a default 5.0.
4. Verify `Handyman_Profile.bayesian_score` still exists but is not read.

## 8. Handyman dual Wallet

1. Compare each Wallet balance and `total_incoming`/`total_outgoing` to canonical transactions.
2. Verify pending count reads `pending_transaction_count`.
3. Verify the bond card shows canonical status, not a fabricated amount.
4. For a transfer between owned Wallets, verify transaction history renders one `INTERNAL` row.
5. Verify per-Wallet source outgoing and destination incoming totals are correct without a duplicated global row.

## 9. Responsive and zoom

Check 1440×900, 1366×768, 1024×768, 768×1024, 390×844, 320×800 and browser zoom 200%. Verify no page-level horizontal overflow, clipped dialog actions or unreachable controls.

## Automated/read-only commands

```powershell
# backend
node --check src/modules/dispute/services/Rating.service.js
$env:ALLOW_MANUAL_PARTICIPANT_READ_TEST='true'
node scripts/participant/manualParticipantExperienceReviewsTest.js

# frontend
npm run lint
npm run build
```

The guarded script is read-only. Leave `PARTICIPANT_ACCESS_TOKEN` unset to skip authenticated HTTP smoke.
