# Participant UI, Profile, Rating and Shared Shell Stabilization

## Outcome

This stabilization pass changes Customer/Handyman presentation and read-model consumption without changing Job lifecycle, settlement, Review eligibility, Admin workflows or database schema.

## Gate traceability

### Gate 1 — Shared participant shell

- Participant logout calls `POST /auth/logout` best-effort, then always disconnects authenticated Socket leases, clears Redux/Persisted auth through the canonical logout action and redirects to `/`.
- Customer/Handyman notification bell, fake count and dead badge rendering were removed.
- Customer mock My Jobs count was removed.
- Both participant sidebars collapse to a 72px desktop icon rail. Below 992px they are overlay drawers with backdrop, Escape handling, location-change close and scroll locking.
- Shared `ParticipantAvatar` supplies consistent initials, sizes and image-error fallback.
- `getParticipantStatusLabel` owns participant labels; `CLOSED` is shown as `Completed` while transport/domain state stays `CLOSED`.

### Gate 2 — Overview and My Jobs

- Overview keeps one canonical request and focus refresh but removes the large manual Refresh action.
- Action Required has stronger visual priority than recent Jobs.
- Customer and Handyman use the approved quick views. `CLOSED` query values are labeled `Completed`.
- One compact sort is exposed: recently updated, scheduled soonest or newest. `view`, `sort` and `page` stay in URL state.
- No search, charts, trends, polling or new metric was added.

### Gate 3 — Public profile, comparison and deposit dialogs

- `ParticipantModal` supplies focus trap, Escape close, body-scroll lock, focus restoration, backdrop handling and a 40px close target.
- `ParticipantPublicProfileModal` is role-aware and loads a whitelisted public profile plus lazy verified Reviews. Main Job flows open it from participant avatar/name.
- `/participants/:userId/profile` and the job-scoped profile backend remain compatibility paths.
- Bid comparison uses the 1180px modal shell and preserves its table, comparison data and hire actions with internal horizontal scrolling.
- Deposit confirmation uses the 680px shell and canonical backend `deposit_rate_percent`, amount, balance and missing amount. Payment and reservation business behavior is unchanged.

### Gate 4 — Profile and arithmetic rating

- Customer and Handyman My Profile expose Overview, Reviews and Security. Password actions are rendered only under Security.
- `Rating.service` is the only canonical aggregate. It applies the existing canonical Review scope and returns:

```json
{
  "review_count": 2,
  "average_rating": "4.50",
  "distribution": { "5": 1, "4": 1, "3": 0, "2": 0, "1": 0 }
}
```

- No-review state uses `average_rating: null` and UI text `No reviews yet`.
- Bayesian calculation/status/prior fields were removed from API and all frontend consumers. `HandymanProfile.bayesian_score` remains untouched and non-canonical.
- Bid matching retains the same 25-point reputation weight and formula, but receives arithmetic `average_rating` on the same 0–5 scale.
- Minimal Admin displays were updated only to remain compatible with the new DTO.

### Five-star defect

The Review payload, backend validator and database field all use the selected integer 1–5 correctly. The defect was presentation-side: the old CSS selected the checked label and following siblings, which reverses a left-to-right 1→5 control. Selecting 5 therefore colored only the final star.

`StarRatingInput` now separates selected and hover state and marks each star filled when `star <= visualValue`. `StarRatingDisplay` uses the same ascending rule. A selected value of 5 sends `{ "rating": 5 }`, persists `rating_stars=5`, is returned as `rating: 5`, and displays five filled stars.

### Gate 5 — Handyman dual Wallet

- Backend `getMyWallets` already groups ledger totals per Wallet and `getMyTransactions` returns each transaction row once. A transfer between a User's Wallets is classified `INTERNAL`.
- The Handyman UI was incorrectly reading nonexistent nested `ledger_summary` fields. It now reads flat `total_incoming`, `total_outgoing` and `pending_transaction_count`.
- The hard-coded 2,000,000 VND bond display was removed; the card shows the canonical bond status. No optional earnings/escrow summary was added because no additional single-source DTO was needed for this stabilization.

### Gate 6 — Verification and documentation

- Frontend lint: passed.
- Frontend production build: passed; only the existing chunk-size warning remains.
- Backend syntax checks for six modified service files: passed.
- Profile/Matchmaking route imports: passed after correcting the smoke command path.
- Guarded read test: passed against the current database. Review counts were total 4, canonical 4, missing cycle 0, missing role 0, invalid rating 0.
- Arithmetic service/SQL comparison: passed for the sampled participant (`1.50`, 2 Reviews), including absence of legacy Bayesian fields.
- Authenticated HTTP, real logout, Socket, modal keyboard and Review write flows require prepared actors/browser sessions and are not claimed as executed.
- Responsive screenshots were not captured because no authenticated visual fixture/session was provided.

## Files

Backend modified:

- `src/modules/dispute/services/Rating.service.js`
- `src/modules/matchmaking/services/AcceptedJob.service.js`
- `src/modules/matchmaking/services/CustomerHandymanSelection.service.js`
- `src/modules/matchmaking/services/Job.service.js`
- `src/modules/admin/services/AdminUser.service.js`
- `src/modules/identity/services/Auth.service.js`
- `scripts/participant/manualParticipantExperienceReviewsTest.js`

Frontend created:

- `src/modules/identity/components/ParticipantAvatar.jsx`
- `src/modules/identity/components/ParticipantModal.jsx`
- `src/modules/identity/components/ParticipantPublicProfileModal.jsx`
- `src/modules/identity/components/ParticipantProfileReviews.jsx`
- `src/modules/identity/components/StarRating.jsx`
- `src/modules/identity/components/ParticipantUi.scss`
- `src/modules/identity/components/ParticipantPublicProfileModal.scss`
- `src/modules/identity/components/ParticipantProfileReviews.scss`
- `src/modules/identity/utils/participantDisplay.js`
- `src/modules/identity/hooks/useParticipantShell.js`

Frontend modified:

- `src/modules/customer/features/dashboard/components/CustomerLayout.jsx`
- `src/modules/customer/features/dashboard/pages/CustomerDashboardPage.jsx`
- `src/modules/customer/features/dashboard/styles/CustomerLayout.scss`
- `src/modules/customer/features/dashboard/styles/ParticipantOverview.scss`
- `src/modules/customer/features/jobs/components/CompareBidsModal.jsx`
- `src/modules/customer/features/jobs/components/HireConfirmModal.jsx`
- `src/modules/customer/features/jobs/components/PublicHandymanProfileModal.jsx`
- `src/modules/customer/features/jobs/pages/CustomerJobDetailsPage.jsx`
- `src/modules/customer/features/jobs/pages/CustomerMyJobsPage.jsx`
- `src/modules/customer/features/jobs/styles/MyJobs.scss`
- `src/modules/customer/features/profile-kyc/components/ProfileDetails.jsx`
- `src/modules/customer/features/profile-kyc/pages/CustomerProfilePage.jsx`
- `src/modules/customer/features/profile-kyc/styles/ProfileKyc.scss`
- `src/modules/handyman/features/dashboard/components/HandymanLayout.jsx`
- `src/modules/handyman/features/dashboard/pages/HandymanDashboardPage.jsx`
- `src/modules/handyman/features/dashboard/styles/HandymanLayout.scss`
- `src/modules/handyman/features/jobs/pages/HandymanFindJobPage.jsx`
- `src/modules/handyman/features/jobs/pages/HandymanJobDetailsPage.jsx`
- `src/modules/handyman/features/jobs/pages/HandymanMyJobsPage.jsx`
- `src/modules/handyman/features/profile/components/ProfileSidebar.jsx`
- `src/modules/handyman/features/profile/pages/HandymanProfilePage.jsx`
- `src/modules/handyman/features/wallet/pages/HandymanWalletPage.jsx`
- `src/modules/home/components/Features.jsx`
- `src/modules/home/components/HowItWorks.jsx`
- `src/modules/identity/features/profile/pages/PublicProfilePage.jsx`
- `src/modules/matchmaking/features/job-lifecycle/components/LifecycleHistoryAccordion.jsx`
- `src/modules/matchmaking/features/job-lifecycle/components/LifecyclePartnerSection.jsx`
- `src/modules/matchmaking/features/job-lifecycle/stages/completed/ReviewPanel.jsx`
- `src/modules/matchmaking/features/job-lifecycle/styles/JobLifecycle.scss`
- `src/modules/admin/features/jobs/pages/AdminJobDetailPage.jsx` (rating DTO compatibility only)

## API and schema impact

- No endpoint was added or removed.
- `rating_summary` changed from Bayesian fields to arithmetic `review_count`, `average_rating`, `distribution`.
- No database column/index/table migration is required.
- `Handyman_Profile.bayesian_score` remains for compatibility and is ignored.

## Known limitations

- Compatibility public-profile route remains and can be removed only after old bookmarks are retired.
- Legacy public media policy is unchanged.
- No persisted participant notification center exists; fake notification UI was removed.
- No optional cross-Wallet earnings or escrow KPI was added.
