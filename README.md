# Trusted Handyman - Backend

This repository provides the REST API, business logic, database access, authentication, financial workflows, and realtime services for Trusted Handyman, a managed home-service marketplace.

## Project Overview

Trusted Handyman supports three roles: Customers request home services, Handymen bid and complete work, and Administrators oversee users and operational activity. The backend manages a service lifecycle rather than only storing listings: it coordinates provider eligibility, bids, selection, deposits, quotes, evidence, completion, warranty work, and reviews.

## Live Demo and Related Repositories

- **Live Demo:** [trusted-handyman.vercel.app](https://trusted-handyman.vercel.app/)
- **Frontend Repository:** [loinguyenduy/final-year-project-fe](https://github.com/loinguyenduy/final-year-project-fe)
- **Backend Repository:** [loinguyenduy/final-year-project-be](https://github.com/loinguyenduy/final-year-project-be)

## Demo Accounts

| Role | Email | Password | Login |
| --- | --- | --- | --- |
| Customer | `customer.demo@gmail.com` | `123456` | [Customer login](https://trusted-handyman.vercel.app/login) |
| Handyman | `handyman.demo@gmail.com` | `123456` | [Handyman login](https://trusted-handyman.vercel.app/login) |
| Admin | `admin.demo@gmail.com` | `123456` | [Admin login](https://trusted-handyman.vercel.app/admin/login) |

> These are evaluation-only accounts using fake, disposable data. Demo data may be reset or changed without notice.

Customer and Handyman accounts use the same frontend `/login` route; the authenticated role determines the workspace. Administrator accounts use `/admin/login`.

## Backend Architecture

The API is a modular Express application organized by domain modules including `identity`, `matchmaking`, `fintech`, `chat`, `ai`, `admin`, and `dispute`.

```text
Route
  -> authentication, role, eligibility, and rate-limit middleware
  -> controller
  -> domain service
  -> Sequelize model and PostgreSQL
  -> optional realtime event or external integration
```

- **Routes** define API boundaries under `/api/v1`.
- **Middleware** validates sessions, roles, KYC or partner eligibility where required, and applies rate limits to selected operations.
- **Controllers** translate HTTP requests and responses.
- **Services** own domain rules, state validation, transactions, settlement logic, and integration calls.
- **Sequelize models** represent the relational data model and its constraints in PostgreSQL.

The API also exposes `GET /health`, which returns readiness status after database initialization.

## Authentication and Authorization

- Local authentication issues JWT access and refresh tokens.
- Refresh tokens are persisted server-side and delivered through an `httpOnly` cookie configured from environment variables.
- Protected requests validate the access token, then validate the current user record, account activity, role, and session `auth_version` against the database.
- Role checks protect Customer, Handyman, and Administrator operations. Administrator routes additionally require an active Admin account.
- Domain services apply ownership, participant, KYC, partner-eligibility, and lifecycle-state checks before sensitive operations proceed.
- Login, password actions, Admin mutations, and AI requests have configured rate limiting.

Frontend route restrictions are a navigation aid, not a security boundary. Protected business operations are validated by the backend.

## Core Domain Workflows

1. A Customer prepares and posts a job; eligible Handymen can browse it and submit bids.
2. The Customer compares bids and selects a Handyman, with deposit and acceptance rules applied by backend services.
3. The selected pair progresses through the accepted-job lifecycle, including travel/arrival, quotes, evidence, completion, and payment-related steps.
4. Completion can create the records needed for settlement, warranty handling, reviews, and subsequent claims or rework workflows.
5. Administrators can review KYC, operational cases, jobs, finance data, services, and audit records through protected endpoints.

## Data Integrity and Transactions

Financial and lifecycle operations use PostgreSQL transactions and row-level locks where concurrent requests could otherwise create inconsistent state. This protects operations such as selection, wallet movement, payment settlement, refresh-token rotation, reviews, and warranty decisions.

Key safeguards include:

- **Server-derived values:** financial and settlement services calculate authoritative amounts from persisted records instead of trusting client-provided totals.
- **State and participant guards:** services reject actions that do not match the current job state, active engagement, role, or ownership.
- **Row-level locking:** transaction-scoped `FOR UPDATE`-style locks serialize conflicting updates to jobs, wallets, requests, and related records.
- **Database constraints:** startup verification checks unique indexes for critical records such as wallet types, active arrival/cancellation requests, quote versions, contracts, transactions, warranty records, reviews, conversations, and AI sessions/messages.
- **Idempotency and duplicate protection:** transaction idempotency keys and scoped unique constraints reduce duplicate financial writes and replayed requests.
- **Cross-table consistency:** service operations coordinate jobs, bids, wallets, transaction records, contracts, evidence, and warranty records in the same transaction when they must change together.

These mechanisms reduce duplicate and stale updates; they do not replace normal operational monitoring or recovery procedures.

## Job Lifecycle and State Management

The server controls valid job transitions and rejects actions that do not fit the current state. For example, bidding, selection, deposit, arrival, quote, completion, cancellation, warranty, and review operations validate the job's current lifecycle context before changing it.

An accepted engagement is scoped to its own acceptance cycle. This prevents a request, quote, contract, evidence record, review, or settlement from a prior engagement from being applied to a later one. When an engagement is cancelled and the job can return to bidding, eligible bids can be reopened while later operations remain scoped to the relevant engagement.

## Payments and Financial Workflows

The backend distinguishes external payment-gateway actions from internal application state:

- **PayOS** creates top-up payment links and verifies webhook payloads before settlement services update application records.
- **Wallet and transaction records** represent internal balances and ledger-like business events for Customer, Handyman, and system wallets.
- **Deposits and remaining-payment flows** validate the current job and quote context before writing transaction outcomes.
- **Completion and warranty settlement services** coordinate payout, reserve, release, or refund-related records according to the active job context.
- **Duplicate protection** combines database constraints, idempotency keys, transaction status checks, and locks around sensitive settlement paths.

PayOS is used for gateway interaction; wallet balances and business state remain internal application concerns managed by backend services.

## Realtime Communication

Socket.IO provides realtime signalling for chat, account/session events, Administrator notifications, and job-lifecycle updates.

- Socket connections authenticate with a JWT and validate the current user, role, active status, and session version.
- Connections join user-specific rooms; Admin users also join an Admin role room.
- Chat handlers validate conversation participation and payloads before persistence.
- A chat message is saved before its acknowledgement and event emission; client message identifiers and database constraints support duplicate handling.
- Lifecycle events are emitted to scoped recipients after the relevant service work completes.

Socket.IO is a communication layer. PostgreSQL and REST reads remain the authoritative source of application state.

## AI-Assisted Job Drafting

The AI module uses Gemini to help a Customer describe a home-service request and prepare an editable job draft. It returns structured output for the active service catalogue, problem summary, follow-up questions, safety messaging, and a form patch.

- Gemini responses are requested as structured JSON and validated by backend code before use.
- The backend restricts the AI to supported service codes and rejects invalid or incomplete output.
- Historical price guidance is calculated by backend logic from stored marketplace data; Gemini is instructed not to set prices.
- The Customer chooses whether to use suggested guidance, their own budget, or no budget before a draft becomes ready.
- The AI does not independently create jobs, execute payments, assign Handymen, or change lifecycle state.

## External Integrations

| Integration | Purpose |
| --- | --- |
| PayOS | Creates top-up links and verifies payment webhooks/callbacks. |
| Gemini API | Structured AI-assisted job drafting. |
| Cloudinary | Stores job images, KYC documents, and work evidence; signed access is used where applicable. |
| Google OAuth and Facebook OAuth | Social sign-in and account linking. |
| SMTP or Brevo API | Transactional email delivery. |
| OpenCage Geocoding | Address and coordinate lookup support. |

All integration credentials are supplied through environment variables and are not included in this repository.

## Technology Stack

| Area | Technologies |
| --- | --- |
| Runtime and language | Node.js, JavaScript (ES modules) |
| HTTP API | Express.js, CORS, cookie-parser |
| Data access | Sequelize, PostgreSQL, `pg` |
| Authentication | JSON Web Tokens, bcryptjs, Passport |
| Realtime | Socket.IO |
| Validation and protection | express-rate-limit, domain validation and state guards |
| Background work | node-cron |
| Payments | PayOS Node SDK |
| AI | Google Gen AI SDK (Gemini) |
| Media | Cloudinary, Multer |
| Email | Nodemailer or Brevo API transport |
| Development | Nodemon, Node.js built-in test runner |

## Database

PostgreSQL stores the relational domain model, while Sequelize provides model definitions, associations, transactions, and data access.

Important areas include:

- Users, roles, authentication providers, addresses, KYC, refresh tokens, and password actions
- Services, jobs, bids, accepted engagements, job status history, quotes, and contracts
- Wallets, transactions, payment evidence, and system wallet records
- Work evidence, completion requests, warranties, claims, and rework records
- Conversations, messages, reviews, ratings, AI assistant sessions, and Administrator audit logs

The repository does not contain versioned migration scripts. On a controlled empty database, Sequelize schema synchronization can be enabled temporarily with `DB_SYNC_ALTER=true`; it is disabled by default and has a production safeguard for non-empty databases.

## Environment Variables

Create a local `.env` from `.env.example`, then provide values appropriate for your environment. Do not commit `.env` files or place secret values in documentation.

| Group | Variables |
| --- | --- |
| Core | `NODE_ENV`, `PORT`, `TRUST_PROXY` |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_DIALECT`, `DB_SYNC_ALTER`, `DB_SYNC_ALTER_ALLOW_NONEMPTY` |
| Authentication and cookies | `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN`, `COOKIE_SAME_SITE`, `COOKIE_SECURE`, `COOKIE_DOMAIN`, `COOKIE_REFRESH_MAX_AGE_MS` |
| Frontend and realtime origins | `FRONTEND_URL`, `SOCKET_CORS_ORIGIN`, `BACKEND_PUBLIC_URL` |
| Email | `EMAIL_TRANSPORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `BREVO_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` |
| OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI` |
| PayOS | `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `PAYOS_TOPUP_RETURN_URL`, `PAYOS_TOPUP_CANCEL_URL`, `PUBLIC_BACKEND_URL`, `API_PUBLIC_URL`, `PAYOS_RETURN_URL`, `PAYOS_CANCEL_URL` |
| Media, AI, and geocoding | `CLOUDINARY_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENCAGE_API_KEY` |
| Cron | `CRON_TIMEZONE`, `JOB_WARRANTY_CRON_ENABLED`, `JOB_WARRANTY_CRON_SCHEDULE`, `WARRANTY_RELEASE_CRON_ENABLED`, `WARRANTY_RELEASE_CRON_SCHEDULE`, `JOB_WARRANTY_TEST_DELAY_MINUTES` |
| One-time bootstrap | `BOOTSTRAP_ADMIN_CONFIRM`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_SERVICES_CONFIRM` |

Email and external-integration variables are required when their corresponding feature is enabled. `npm run config:check -- --stage=full` validates the complete configured environment.

## Local Setup

### Prerequisites

- Node.js and npm
- PostgreSQL
- Environment values for the features you intend to run

### Run locally

1. Clone the repository.

   ```bash
   git clone https://github.com/loinguyenduy/final-year-project-be.git
   cd final-year-project-be
   ```

2. Install dependencies.

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and configure the database, JWT secrets, frontend origin, and any integrations you need.

4. Create the PostgreSQL database named by `DB_NAME`. For a controlled, empty database, temporarily set `DB_SYNC_ALTER=true` so Sequelize can synchronize the schema and required indexes. Set it back to `false` after the controlled bootstrap.

5. Start the development server.

   ```bash
   npm run dev
   ```

   The default port is `5000`. Confirm readiness with `GET /health`.

6. Optionally validate configured environment variables.

   ```bash
   npm run config:check -- --stage=full
   ```

Useful operational scripts are also available for controlled bootstrap and verification:

```bash
npm run bootstrap:admin
npm run bootstrap:services
npm run verify:system-wallets
```

## Testing

The repository includes focused Node.js tests for:

- Email transport configuration and Brevo request/error handling
- OAuth account-link state issue, claim, expiry, and consumption behavior
- Handyman partner eligibility rules

Run the scripted tests with:

```bash
npm run test:email-transport
npm run test:oauth-link-state
```

The Handyman eligibility test is present but is not currently exposed through a package script:

```bash
node --test test/handymanPartnerEligibility.test.js
```

Broader integration, end-to-end, and load coverage is not represented by this test suite.

## Deployment

The server runs through `npm start`, reads its listening port from `PORT`, exposes `/health`, and validates production bootstrap configuration at startup. CORS, Socket.IO origins, cookie settings, public backend URLs, OAuth callbacks, PayOS callbacks, and external-service credentials are environment-driven.

No Railway-specific configuration file or complete CI/CD pipeline is committed in this repository. Deploy to a Node.js runtime with the required environment configuration, and set `FRONTEND_URL` to the deployed frontend origin.

## Known Limitations

- Automated tests are focused on selected units rather than comprehensive integration, end-to-end, or load coverage.
- The full feature set depends on configured PostgreSQL and external providers such as email, OAuth, Cloudinary, PayOS, Gemini, and geocoding.
- Demo data and accounts are disposable and may be reset.
- Schema changes use controlled Sequelize synchronization rather than versioned migration files.

## Related Frontend Repository

- **Trusted Handyman Frontend:** [loinguyenduy/final-year-project-fe](https://github.com/loinguyenduy/final-year-project-fe)
- **Live Demo:** [trusted-handyman.vercel.app](https://trusted-handyman.vercel.app/)
