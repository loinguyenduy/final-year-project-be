# Manual test guide — Customer job locations

This guide verifies location confirmation for all three Customer address options, profile-coordinate reuse, nearest-job sorting, and location privacy. It intentionally uses manual checks only; this task does not add automated tests or migrations.

## 1. Safety and prerequisites

Use a development database only. Back up the database before enabling Sequelize alter mode. Do not commit `.env`, access tokens, or the OpenCage key.

Required accounts/data:

- One KYC-verified Customer with a default profile address.
- One Handyman with at least one service and service area.
- A valid service UUID.
- An OpenCage testing API key.
- PostgreSQL access through `psql`, pgAdmin, DBeaver, or the VS Code PostgreSQL extension.

Add these values to the existing backend `.env` without deleting its current variables:

```dotenv
OPENCAGE_API_KEY=your_testing_key
OPENCAGE_BASE_URL=https://api.opencagedata.com/geocode/v1/json
GEOCODING_TIMEOUT_MS=8000
GEOCODING_CACHE_TTL_MS=900000
GEOCODING_CACHE_MAX_ENTRIES=250
```

The frontend can use its built-in OpenStreetMap defaults. Optional frontend `.env` values are documented in `final-year-project-fe/.env.example`.

### Start the applications

From two VS Code terminals:

```powershell
cd D:\Workspace\Final_Year_Project\final-year-project-be
npm install
npm run dev
```

```powershell
cd D:\Workspace\Final_Year_Project\final-year-project-fe
npm install
npm run dev
```

Expected result:

- Backend starts at `http://localhost:5000`.
- Frontend starts at the Vite URL, normally `http://localhost:5173`.
- No API key is visible in frontend requests, source files, or browser storage.

Common problems:

- `503 Geocoding service is not configured`: `OPENCAGE_API_KEY` is missing or the backend was not restarted.
- Browser GPS does not work: use `localhost` or HTTPS and check site permissions.
- Blank/grey map: inspect the browser Network tab for blocked OSM tile requests and check container size.

## 2. Synchronize and verify the schema

1. Back up the development database using your normal database tool. An example command, with placeholders, is:

   ```powershell
   pg_dump -h <host> -p <port> -U <user> -d <database> -F c -f before-job-location.backup
   ```

2. Stop the backend.
3. Set `DB_SYNC_ALTER=true` in the backend `.env`.
4. Start the backend once and wait for:

   ```text
   All models were synchronized successfully with alter mode.
   ```

5. Stop the backend immediately after the successful sync.
6. Set `DB_SYNC_ALTER=false`.
7. Start the backend again and confirm:

   ```text
   Automatic schema alteration is disabled.
   ```

8. Run:

   ```sql
   SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'Jobs'
     AND column_name IN (
       'gps_lat', 'gps_long', 'location_source',
       'location_confirmed', 'location_confirmed_at'
     )
   ORDER BY column_name;
   ```

Expected result:

- All five columns exist.
- The three new columns are nullable.
- Existing jobs remain readable even when the three new fields are null.

Never leave `DB_SYNC_ALTER=true` during normal development.

## 3. Useful SQL inspection queries

Latest job snapshots:

```sql
SELECT
  id,
  customer_id,
  service_address,
  detail_address,
  province_code,
  ward_code,
  gps_lat,
  gps_long,
  location_source,
  location_confirmed,
  location_confirmed_at,
  "createdAt"
FROM "Jobs"
ORDER BY "createdAt" DESC
LIMIT 20;
```

Customer profile addresses:

```sql
SELECT
  id,
  user_id,
  full_address,
  detail_address,
  province_code,
  ward_code,
  gps_lat,
  gps_long,
  is_default,
  "updatedAt"
FROM "User_Addresses"
ORDER BY "updatedAt" DESC;
```

Job/profile independence for a known job and address:

```sql
SELECT
  j.id AS job_id,
  j.service_address AS job_address,
  j.detail_address AS job_detail,
  j.gps_lat AS job_lat,
  j.gps_long AS job_long,
  ua.full_address AS current_profile_address,
  ua.gps_lat AS profile_lat,
  ua.gps_long AS profile_long
FROM "Jobs" j
JOIN "User_Addresses" ua ON ua.user_id = j.customer_id AND ua.is_default = true
WHERE j.id = '<job_uuid>';
```

## 4. Option 1 — Specific Address

### 4.1 Geocode succeeds and Customer confirms the suggested pin

Steps:

1. Log in as the verified Customer.
2. Open the job creation page.
3. Select `Specific Address`.
4. Select a province/city and ward/commune.
5. Enter a real house number/street containing Vietnamese characters if possible.
6. Click `Find on map`.
7. Check the suggested pin and click `Confirm location` without moving it.
8. Complete required job fields and submit.

Expected result:

- The map appears only after the explicit search action.
- Final source is `GEOCODED_ADDRESS`.
- Submit remains disabled until the pin is confirmed.
- The job is created with both coordinates and `location_confirmed=true`.
- `location_confirmed_at` is set by the backend.

Database check:

- `detail_address` equals the Customer input after outer whitespace is trimmed.
- `province_code/ward_code` equal the dropdown values.
- `service_address` is built from local detail/ward/province data, not the OpenCage formatted address.

Common problems:

- `429`: wait at least one second and click `Find on map` again.
- Suggested pin is imprecise: continue with test 4.2 and move it.

### 4.2 Customer corrects the pin

Steps:

1. Repeat test 4.1 but drag the marker or click another point.
2. Confirm and create the job.

Expected result:

- Moving the pin clears any previous confirmation.
- Final source changes to `MANUAL_MAP_PIN`.
- Address text and administrative codes do not change when the pin changes.

Database check:

- Coordinates equal the final marker position.
- `detail_address`, `province_code`, `ward_code`, and `service_address` still reflect the Customer-entered address.

### 4.3 Geocoding fails and Customer uses text-only fallback

Steps:

1. Enter a deliberately unresolvable detail address while keeping valid local dropdown values.
2. Click `Find on map`.
3. When the error appears, click `Continue with address text only`.
4. Submit the job.

Expected result:

- The form clearly warns that accurate distance is unavailable.
- The job is still created.
- `gps_lat/gps_long` are null.
- `location_source='ADDRESS_ONLY'`.
- `location_confirmed=false` and `location_confirmed_at` is null.

Alternative fallback:

- Instead of text-only, click `Choose pin manually`, click the map, confirm, and verify `MANUAL_MAP_PIN` with coordinates.

## 5. Option 2 — Default Profile Address

Before this test, record all profile address fields using the SQL query in section 3.

### 5.1 Profile has no coordinates

For development-only setup, clear just the coordinate columns of the test Customer address:

```sql
UPDATE "User_Addresses"
SET gps_lat = NULL, gps_long = NULL
WHERE user_id = '<customer_uuid>' AND is_default = true;
```

Steps:

1. Refresh the frontend, open job creation, and select `Profile Address`.
2. Confirm that the exact default address text is displayed.
3. Click `Find on map`.
4. Before confirming, verify this notice is visible:

   ```text
   This also updates your default profile coordinates.
   Your saved address text, province and ward will not be changed.
   ```

5. Confirm the pin and submit.

Expected result:

- Final source is `GEOCODED_ADDRESS` if the pin was not moved.
- Job and profile receive the same coordinates.
- Success toast explicitly says profile coordinates were updated.
- Profile address text and administrative codes remain byte-for-byte unchanged.

Database check:

- Compare the before/after `User_Addresses` row.
- Only `gps_lat`, `gps_long`, and normal Sequelize `updatedAt` may change.
- Job stores an independent snapshot.

### 5.2 Profile already has coordinates

Steps:

1. Create another job with `Profile Address` after test 5.1.
2. Confirm the map opens at the stored profile coordinates without requiring another geocode.
3. Confirm without moving and submit.

Expected result:

- Final source is `PROFILE_ADDRESS`.
- Backend accepts this source only because submitted coordinates match the saved profile coordinates.

### 5.3 Customer moves the profile pin

Steps:

1. Select `Profile Address`.
2. Move the pin and confirm.
3. Submit the job.

Expected result:

- Final source becomes `MANUAL_MAP_PIN`.
- Final coordinates are stored in both job and profile.
- Profile text/province/ward do not change.

### 5.4 Profile is edited after job creation

Steps:

1. Record the created job snapshot.
2. Open `Profile & KYC` and change the default street/ward/province through the existing form.
3. Refresh and query both records again.

Expected result:

- The updated profile coordinates are cleared to null because its address text changed.
- The old job address and coordinates remain unchanged.
- A future option 2 job requires geocoding again.

### 5.5 Backend rejects a false PROFILE_ADDRESS claim

In Postman, submit option 2 using `location_source=PROFILE_ADDRESS` but coordinates different from the saved profile row.

Expected result:

- HTTP 400.
- Message requires `MANUAL_MAP_PIN` after changing the pin.
- No Job or profile update is committed.

## 6. Option 3 — Current GPS

### 6.1 GPS succeeds

Steps:

1. Select `Current GPS` and grant browser location permission.
2. Observe the accuracy text and initial marker.
3. Confirm without moving the pin.
4. Submit.

Expected result:

- Source is `CURRENT_GPS`.
- Confirming reverse-geocodes only the final coordinates.
- Create Job may reuse the cache, but all provider work completes before the database transaction starts.
- Job has a readable `service_address` when reverse geocoding succeeds.
- `detail_address`, `province_code`, and `ward_code` are null.

Database check:

```sql
SELECT service_address, detail_address, province_code, ward_code,
       gps_lat, gps_long, location_source, location_confirmed
FROM "Jobs"
ORDER BY "createdAt" DESC
LIMIT 1;
```

### 6.2 GPS pin is moved

Steps:

1. Obtain GPS.
2. Drag/click the marker elsewhere.
3. Confirm and submit.

Expected result:

- Source changes to `MANUAL_MAP_PIN`.
- Reverse-geocoded text corresponds to the final pin, not the original GPS point.
- Administrative codes remain null and are never copied from OpenCage.

### 6.3 Permission denied and timeout

Steps:

1. In browser site settings, block Location and select option 3.
2. Confirm the form remains on option 3 and shows retry/manual-pin actions.
3. Restore permission and retry.
4. To simulate timeout, use browser developer tools/location emulation or make location unavailable, then wait beyond 10 seconds.

Expected result:

- The form never silently switches to option 1.
- Customer can retry, click a manual pin, or choose another option.
- Option 3 cannot submit without confirmed coordinates.

### 6.4 Reverse geocoding fails but GPS job remains postable

Steps:

1. Obtain a GPS pin.
2. Temporarily stop provider access by removing `OPENCAGE_API_KEY` and restarting the backend, or use an invalid testing key.
3. Confirm and submit.

Expected result:

- Pin confirmation uses `Selected map location` when reverse geocoding is unavailable.
- Job still stores the final coordinates.
- Provider failure never rolls back or blocks option 3 job creation.
- Restore the valid key after the test.

## 7. Postman validation tests

Use:

```text
POST /api/v1/matchmaking/jobs
Authorization: Bearer <verified_customer_access_token>
Content-Type: multipart/form-data
```

Base fields:

```text
service_id=<service_uuid>
issue_description=Manual location validation
scheduled_at=2026-08-01T09:00:00.000Z
address_option=1
province_code=<valid_code>
ward_code=<valid_code>
detail_address=123 Test Street
gps_lat=10.12345678
gps_long=106.12345678
location_source=GEOCODED_ADDRESS
location_confirmed=true
```

Run each mutation independently:

| Mutation | Expected result |
|---|---|
| Remove only `gps_long` | HTTP 400; pair required |
| `gps_lat=NaN` | HTTP 400; finite number required |
| `gps_lat=` with longitude present | HTTP 400 |
| `gps_lat=91` | HTTP 400 |
| `gps_long=-181` | HTTP 400 |
| Coordinates plus `ADDRESS_ONLY` | HTTP 400 |
| Coordinates plus `location_confirmed=false` | HTTP 400 |
| No coordinates plus `GEOCODED_ADDRESS` | HTTP 400 |
| Option 1 plus `CURRENT_GPS` | HTTP 400 |
| Option 2 plus `PROFILE_ADDRESS` with changed pin | HTTP 400 |
| Option 3 plus `ADDRESS_ONLY` | HTTP 400 |
| Option 3 coordinates exactly `0,0` | Accepted by coordinate validation; do not submit unless intentionally testing this location |

Also call both geocoding endpoints using a Handyman token. Expected result: HTTP 403.

## 8. Geocoding timeout, cache, and rate-limit

### Cache

1. Call `POST /matchmaking/locations/geocode` twice with exactly the same address.
2. Expected: second response succeeds from cache and does not consume the one-request-per-second provider slot.

### Local rate-limit

1. Call two different, uncached geocoding requests less than one second apart.
2. Expected: one request returns HTTP 429 with `retry_after_ms`.
3. Wait and retry; it should succeed.

### Timeout

1. Set `GEOCODING_TIMEOUT_MS=1` in development and restart the backend.
2. Send a new uncached query.
3. Expected: safe 502 timeout response; server remains running.
4. Restore `GEOCODING_TIMEOUT_MS=8000` and restart.

Do not log or inspect full private addresses in shared logs while testing.

## 9. Nearest jobs

Prepare:

- Job A: option 1 with coordinates.
- Job B: option 2 with coordinates.
- Job C: option 3 with coordinates.
- Job D: option 1 text-only.

As the Handyman, call:

```text
GET /api/v1/matchmaking/jobs/available?sort_by=distance&current_lat=<lat>&current_long=<long>
Authorization: Bearer <handyman_access_token>
```

Expected result:

- A, B, and C have numeric `distance_km` and sort ascending.
- Equal distances use newest job first.
- D has `distance_km=null` and appears after jobs with distance.
- Existing service, service-area, work-time, and search filters still apply.
- Pagination test is `N/A`; this API currently returns the full filtered list.

Invalid Handyman query tests:

- Only `current_lat`: HTTP 400.
- Non-numeric current coordinate: HTTP 400.
- Latitude/longitude outside legal range: HTTP 400.

## 10. Privacy checks

Before a Handyman is selected:

1. Inspect Find Job and Handyman Job Details responses.
2. Expected:
   - `distance_km` may be present.
   - `service_address` contains only ward/province when local codes exist.
   - `gps_lat`, `gps_long`, `detail_address`, `location_source`, `location_confirmed`, and `location_confirmed_at` are null/hidden.

Customer owner:

- Customer My Jobs and Job Details may show the exact snapshot and location metadata.

After the existing ACCEPTED/contact-unlock flow:

- Only the selected Handyman receives exact job location through the existing authorized Job Details flow.
- An unrelated Handyman must receive HTTP 403 or masked data according to the existing endpoint.

## 11. Responsive and interaction checks

Test at desktop width and a mobile viewport such as 390 × 844:

- Map loads and resizes when switching options.
- Marker drag works with mouse and touch.
- Map remains within the card without horizontal overflow.
- Confirmation button and profile notice remain readable.
- Switching option clears the previous pin/source/confirmation.
- Editing option 1 address fields clears the previous pin confirmation.
- Submit remains protected against double clicks while the request is in progress.

## 12. Final verification commands

Backend syntax:

```powershell
cd D:\Workspace\Final_Year_Project\final-year-project-be
node --check src\modules\matchmaking\services\CustomerJob.service.js
node --check src\modules\matchmaking\services\Geocoding.service.js
node --check src\modules\matchmaking\utils\location.util.js
```

Frontend production build:

```powershell
cd D:\Workspace\Final_Year_Project\final-year-project-fe
npm run build
```

The repository's existing `npm run lint` currently fails while loading `eslint.config.js` before linting source files. Treat the production build as the frontend compile check for this task and fix the unrelated ESLint configuration separately.
