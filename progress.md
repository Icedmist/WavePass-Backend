# WavePass Backend — Implementation Progress Log

## Status Overview
- **Repository**: `Icedmist/wavepass-backend`
- **Framework**: NestJS 10 + Fastify
- **Database**: PostgreSQL + Prisma Client
- **Queue / Background Jobs**: Redis + BullMQ

---

## Logged Milestones

### 1. Repository Setup & Architecture Migration
- [x] Extracted `wavepass-api` scaffold into dedicated repository `Icedmist/wavepass-backend`.
- [x] Included PRD v1.3 reference in `docs/`.
- [x] Initialized Git with SSH signed commits attributed to `icedmist <talk2icedmist@gmail.com>`.
- [x] Created private GitHub repository and pushed baseline branch `main`.

### 2. Dependency Resolution & Build Integrity
- [x] Added `fastify` peer dependency for `@nestjs/platform-fastify`.
- [x] Configured pnpm v11 script approvals (`allowBuilds` for `@prisma/client`, `@nestjs/core`, etc.).
- [x] Fixed TypeScript type safety in `PaystackService.verifyTransaction` casting.
- [x] Verified full TypeScript compilation with `nest build` (0 errors).

### 3. Internet Plans Management Module (PRD §4.2, §8, §10)
- [x] Created `CreatePlanDto` and `UpdatePlanDto` with `class-validator` guards.
- [x] Built `PlansService` with duration formatting, profile generation (`profile_1h`, `profile_12h`, `profile_24h`), plan versioning, and frontend backward compatibility (`priceNGN`, `amountKobo`, `limitUptime`).
- [x] Exposed `PlansController` (`GET /api/v1/plans`, `GET /api/v1/plans/:id`, `POST /api/v1/plans`, `PATCH /api/v1/plans/:id`, `DELETE /api/v1/plans/:id`).
- [x] Integrated into `AppModule` and verified build.

### 4. Venues & Routers Infrastructure Modules (PRD §4.1, §8, §10)
- [x] Created `VenuesService` and `VenuesController` (`GET /api/v1/venues`, `GET /api/v1/venues/:id`, `POST /api/v1/venues`, `GET /api/v1/venues/default` auto-bootstrap).
- [x] Created `RoutersService` and `RoutersController` (`GET /api/v1/routers`, `GET /api/v1/routers/:id`, `POST /api/v1/routers`).
- [x] Implemented real-time router connectivity testing (`POST /api/v1/routers/:id/test`) and health diagnostics (`GET /api/v1/routers/:id/health`).
- [x] Verified build integrity across all modules.

### 5. HotSpot Sessions Management Module (PRD §8, §10, §28.4)
- [x] Built `SessionsService` to track active sessions linked to venues, routers, and vouchers/orders.
- [x] Implemented router-level session termination via `MikrotikAdapter.removeHotspotUser` on disconnect (`POST /api/v1/sessions/:id/disconnect`).
- [x] Exposed `SessionsController` (`GET /api/v1/sessions`, `GET /api/v1/sessions/active`, `GET /api/v1/sessions/:id`, `POST /api/v1/sessions/:id/disconnect`).
- [x] Integrated into `AppModule` and verified build.

### 6. Captive Portal Bridge & Hardware Provisioning Compatibility (PRD §4.5, §7)
- [x] Enhanced `MikrotikAdapter.createHotspotUser` with dual-protocol fallback (RouterOS v7 `PUT /rest/ip/hotspot/user` and legacy/mock `POST /rest/ip/hotspot/user/add`).
- [x] Upgraded `MikrotikProvisioningProcessor` to detect captive portal MAC addresses, automatically bind the client MAC address as the hotspot user, and attach the exact plan profile.
- [x] Created `PortalService` and `PortalController` (`GET /api/v1/portal/plans`, `POST /api/v1/portal/init-payment`, `POST /api/v1/portal/simulate-payment`, `GET /api/v1/portal/sessions/:mac`).
- [x] Provided mock payment checkout fallback for local offline testing.
- [x] Integrated into `AppModule` and verified build.

### 7. Admin Metrics, Self-Healing Reconciliation & Cleanup Engine (PRD §14, §15, §16)
- [x] Implemented `AdminService.getStats` exposing revenue in NGN/kobo, payment counts, ARPU, by-plan sales distribution, and active/expired router counters.
- [x] Built automated reconciliation routine (`POST /api/v1/admin/reconcile`) that compares fulfilled payments with router state, detects dropped sessions, self-heals by re-enqueuing provisioning, and flags orphaned router users.
- [x] Implemented router session garbage collection (`POST /api/v1/admin/cleanup`) to prune expired users from hardware and synchronize database state.
- [x] Built server-side transaction double-verification endpoint (`GET /api/v1/admin/verify/:reference`).
- [x] Exposed `AdminController` with full compatibility matching the Next.js admin dashboard expectations.
- [x] Integrated into `AppModule` and verified build.

### 8. Seeding, Containerization & Automated Unit Testing (PRD §20, §23, §28.8)
- [x] Created database seed script (`prisma/seed.ts`) that bootstraps the flagship venue, primary router, and standard 3 plans (1h ₦200, 12h ₦800, 24h ₦1500).
- [x] Configured multi-stage production `Dockerfile` with Alpine Node.js runtime.
- [x] Created `docker-compose.yml` defining orchestrated PostgreSQL, Redis (BullMQ), and API services with healthchecks.
- [x] Installed `vitest` and created test suite (`test/plans.spec.ts`) validating plan calculations, duration conversions, and profile mappings.
- [x] Verified 100% test passing and clean `nest build` production output.

### 9. Upstash Serverless Redis & RouterOS Automated Configuration (PRD §6, §7, §28)
- [x] Configured secure TLS Upstash Redis endpoint (`REDIS_URL`) in `.env` and verified active connectivity (PONG response).
- [x] Created single-command MikroTik auto-configuration script (`docs/wavepass-setup.rsc`) to automate user creation, REST API enablement, walled garden bypass rules, and hotspot profiles in under 30 seconds.
- [x] Synced and committed changes.

### 10. Single-Key Paystack + Dedicated Virtual Accounts & Password-Confirmed Cashout
- [x] **Single-key model:** the platform (Nexa) owns ONE `PAYSTACK_SECRET_KEY`; merchants never hold their own keys.
- [x] Added `VirtualAccount` model — a dedicated virtual account (DVA) per venue; all DVA payments settle into the single platform settlement account.
- [x] Extended `PaystackService` with DVA (`customer`, `dedicated_account`), `transferrecipient`, `transfer`, `transfer/verify`, and `balance` methods + `isMock()`.
- [x] Built `VirtualAccountsService` (`POST /api/v1/virtual-accounts`, `POST /api/v1/virtual-accounts/ensure/:venueId`, `GET /api/v1/virtual-accounts/venue/:venueId`, `GET /api/v1/virtual-accounts/:id`) with idempotent per-venue DVA + mock fallback.
- [x] Added `BankAccount` + `Cashout` models; venue owner registers a NUBAN as the payout recipient.
- [x] Built `CashoutsService` cashout pipeline: `venueBalance` → `requestCashout` (locks balance) → admin **password-confirmed** authorisation → Paystack Transfer finalisation.
- [x] Exposed `CashoutsController` (`GET /api/v1/cashouts/balance/:venueId`, `POST /api/v1/cashouts/bank-accounts`, `GET /api/v1/cashouts/bank-accounts`, `POST /api/v1/cashouts`, `POST /api/v1/cashouts/confirm`, `POST /api/v1/cashouts/:id/reject`, `GET /api/v1/cashouts`).
- [x] Admin password verified via constant-time HMAC compare against `ADMIN_PASSWORD_HASH` (or hashed `ADMIN_PASSWORD`).
- [x] Verified clean `nest build` and passing vitest suite.

### 11. Batch Vouchers Production & Dynamic Provisioning Scripts
- [x] Implemented `POST /api/v1/vouchers/batches` supporting bulk generation of 1 to 500 vouchers for any venue and pricing plan.
- [x] Stored SHA-256 hashed voucher codes with activation status in the database.
- [x] Built dynamic RouterOS v7 provisioning script endpoint (`GET /api/v1/routers/:id/provision.rsc`) tailoring captive portal redirect and bridge configs to gateway IDs.
- [x] Ensured mock DVA metadata flags (`metadata: { mock: true }`) so mobile and web clients detect when Paystack credentials are unconfigured.

### 12. Dual Connection & Default Admin Credentials Standard (Issue #7, PR #8)
- [x] Standardized on default MikroTik `admin` credentials (blank password) without injecting unnecessary extra users.
- [x] Added dual connection support (`local` and `tunnel`) in router models and provisioning workflows.

### 13. Strict Hardware Validation & Voucher Hotspot Sync (Issue #9, PR #10)
- [x] **Strict RouterOS JSON Validation**: Updated `MikrotikAdapter.testConnection()` and `getSystemResource()` to enforce `content-type: application/json` and parse RouterOS system resource fields (`platform`, `board-name`, `version`, `uptime`, `cpu-load`). Rejects HTTP 200 HTML redirects from web domains (like Vercel wildcards).
- [x] **Real-time Status Tracking**: Removed stale `|| router.status === RouterStatus.ONLINE` in `routers.service.ts` so that router status truthfully reflects live hardware reachability.
- [x] **Voucher Hotspot Credentials Match**: Updated `MikrotikProvisioningProcessor.provisionForVoucher()` to use the customer's actual voucher code (`displayCodeEnc`) as both username and password, allowing direct voucher code authentication on MikroTik Hotspots.
- [x] **Verification**: Added `test/mikrotik-adapter.spec.ts`; all 17 tests passed; `nest build` succeeded.

### 14. Local Redis Security, Memory Caps & Droplet Runbook (Issue #11, PR #12)
- [x] **Local Self-Hosted Redis**: Standardized on local Redis container (`redis:7-alpine`) over internal Docker network (`redis://redis:6379`), eliminating Upstash serverless request limits (`500k limit exceeded`) and network latency.
- [x] **Security & Resource Hardening**:
  - Bound Redis port strictly to `127.0.0.1:6379:6379` in `docker-compose.yml` to prevent public internet access.
  - Added `--maxmemory 128mb --maxmemory-policy noeviction --appendonly yes` to safeguard 1GB RAM droplets.
- [x] **Droplet Deployment Runbook (`docs/DIGITAL_OCEAN.md`)**:
  - Documented mandatory 2 GB Swap file setup to prevent Out-Of-Memory freezes.
  - Documented health checks (`/api/v1/health` and `/api/v1/health/ready`).
- [x] **Verification**: Verified on production droplet; API healthy and connected to local Redis; 0 Redis request errors; memory usage 51.8MB (API) and 3.5MB (Redis).

### 15. Paystack Fulfilment Recovery & Idempotent Initialize (Issue #30, PR #31)
- [x] **Duplicate Webhook Re-enqueue**: `charge.success` retries now re-enqueue `payment-fulfilment` when the local payment is still pending (covers Redis-outage first delivery); already-fulfilled duplicates ACK without re-enqueue. Event marked `requeued`.
- [x] **Idempotent Initialize**: re-initializing payment for the same order refreshes the PENDING row instead of crashing on unique `orderId` (P2002).
- [x] **Verification**: `tsc` clean; 32/32 vitest pass including new controller-level duplicate/re-enqueue tests.
- [x] PR [#31](https://github.com/Icedmist/WavePass-Backend/pull/31) merged to `main`.

### 16. Fulfilled Re-init Stranded Reference (Issue #32, PR #33)
- [x] **Early Return**: re-initializing payment for an already-FULFILLED order returns the existing reference with `alreadyFulfilled` before any Paystack transaction — no more stranded references with no local row.
- [x] **Verification**: `tsc` clean; 33/33 vitest pass including the fulfilled re-init test.
- [x] PR [#33](https://github.com/Icedmist/WavePass-Backend/pull/33) merged to `main`.

### 17. Activation Kinds, Custom Durations & Simulate Gate (Issue #34, PR #35)
- [x] **Kinds**: `ActivationCodeKind` (LICENSE venue-bound single-use / MASTER multi-use to quota / TRIAL short single-use) persisted with migration; per-kind defaults 30d / lifetime / 7d, `durationDays` or explicit `expiresAt` override.
- [x] **Security**: `simulate-payment` throws Forbidden on live gateways (was minting free vouchers in production).
- [x] **Verification**: `tsc` clean; 38/38 vitest pass (kind/duration/quota/simulate specs).
- [x] PR [#35](https://github.com/Icedmist/WavePass-Backend/pull/35) merged to `main`.

### 18. Activation Redemption Ledger (Issue #36, PR #37)
- [x] **Bug**: multi-use MASTER codes overwrote the single `redeemedBy` column, locking out earlier redeemers once others consumed quota.
- [x] **Fix**: `ActivationRedemption(codeId+email)` ledger with backfill migration; redeem records grant first (same-account double redeem denied without quota burn); check reads ledger first.
- [x] **Verification**: `tsc` clean; 39/39 vitest pass.
- [x] PR [#37](https://github.com/Icedmist/WavePass-Backend/pull/37) merged to `main`.

### 19. Payout Hardening & Activation Requests (Issue #38, PR #39)
- [x] **PROCESSING Sweep**: stuck transfers re-verified in admin reconcile (COMPLETED/FAILED, network blips skipped).
- [x] **Recipient Self-Heal**: registration saves with `recipientPending` on Paystack blips; cashout retries recipient creation instead of failing.
- [x] **Timeouts & Races**: 20s Paystack fetch timeouts; race-safe DVA create + PENDING retry/upgrade; Serializable balance check with retry; `clientReference` idempotency (+migration).
- [x] **Code Requests**: `ActivationRequest` model/migration; request, list, approve-as-code (kind+duration, venue-bound), approve-as-direct (pre-redeemed time-boxed grant), reject.
- [x] **Verification**: `tsc` clean; 46/46 vitest pass.
- [x] PR [#39](https://github.com/Icedmist/WavePass-Backend/pull/39) merged to `main`.

### 20. Venue Sales Funnel (Issue #40, PR #41)
- [x] `GET /admin/funnel` aggregates orders/payments/vouchers per venue (7–90d): initiated/awaiting/active/failed, revenue, redeem + paid rates, per-day series.
- [x] **Verification**: `tsc` clean; 48/48 vitest pass.
- [x] PR [#41](https://github.com/Icedmist/WavePass-Backend/pull/41) merged to `main`.

### 21. Missing Request Spec + Full Builds (Issue #42, PR #43)
- [x] **Found**: activation-request spec block was verified locally but never committed, plus two whitespace manglings.
- [x] **Sweep**: `nest build` clean; web `next build` 24/24 routes; all mains synced; zero open issues.
- [x] PR [#43](https://github.com/Icedmist/WavePass-Backend/pull/43) merged to `main`.

### 22. Paid/Approved Orders Always Yield Access (Issue #45, PR #46)
- [x] **Root causes**: provisioning rethrew non-whitelisted router errors (order stuck, router without user); approvals bound vouchers to missing/invalid MACs incl. shared dummy `02:00:00:00:00:01`; guest polling by real MAC then missed everywhere.
- [x] **Fix**: degrade on ANY router error (session + ACTIVE always); approval resolves effective MAC and repairs stale refs; transfer-request requires valid MAC.
- [x] **Verification**: `tsc` clean; 52/52 vitest pass.
- [x] PR [#46](https://github.com/Icedmist/WavePass-Backend/pull/46) merged to `main`.

### 23. Stale Mock DVA Replacement (Issue #47, PR #48)
- [x] **Bug**: mock-era DVA rows (status ACTIVE) were returned forever after live keys were configured — app showed unavailable DVA + fake numbers.
- [x] **Fix**: live mode drops mock rows and provisions a real Paystack DVA; secret key trimmed everywhere.
- [x] **Verification**: `tsc` clean; 55/55 vitest pass.
- [x] PR [#48](https://github.com/Icedmist/WavePass-Backend/pull/48) merged to `main`.

### 24. 48-Hour Admin JWT (Issue #44, PR #49)
- [x] Default admin token expiry 2h → 48h in auth service and JwtModule, matching the app's operator session policy. Env override preserved.
- [x] **Verification**: `tsc` clean; 55/55 vitest pass.
- [x] PR [#49](https://github.com/Icedmist/WavePass-Backend/pull/49) merged to `main`.

### 25. Custom Codes Honored in Cloud Batches (Issue #50, PR #51)
- [x] **Bug**: batches ignored the app's customCode and stored random codes — cloud never matched app/router, so portal redeem missed.
- [x] **Fix**: customCode/customCodes stored verbatim; single collision → 409; bulk conflicts reported; re-uploads idempotent; new GET /vouchers/check/:code.
- [x] **Verification**: `tsc` clean; 61/61 vitest pass.
- [x] PR [#51](https://github.com/Icedmist/WavePass-Backend/pull/51) merged to `main`.

### 26. Idempotent Approval (Issue #52, PR #53)
- [x] **Bug**: approve retries/double-taps minted duplicate payments + vouchers; failures died silently with no user feedback.
- [x] **Fix**: re-approval returns the existing voucher with alreadyApproved flag; approval binds guaranteed-valid MAC.
- [x] **Verification**: `tsc` clean; 62/62 vitest pass.
- [x] PR [#53](https://github.com/Icedmist/WavePass-Backend/pull/53) merged to `main`.

### 27. PRD Entitlement Lifecycle & Failure Alerts (Issue #54, PR #56)
- [x] Idempotent sessions per order/voucher; deduped provisioning-delayed operator alerts; ACTIVE→REDEEMED on first use with firstLoginAt + device binding; router-sync pulls ACTIVE + REDEEMED.
- [x] **Verification**: `tsc` clean; 64/64 vitest pass at merge.
- [x] PR [#56](https://github.com/Icedmist/WavePass-Backend/pull/56) merged to `main`.

### 28. PRD Refunds, Review Queue & Metrics (Issue #55, PR #57)
- [x] Reversal webhooks (refund.*, charge.dispute.*): REVERSED/REFUNDED marking, unused-voucher revocation, consumed-access review flags, operator alerts, audit trail.
- [x] Guarded GET /admin/review-queue; public GET /admin/metrics (rates, latency median, DVA/router statuses, onboarding).
- [x] **Verification**: `tsc` clean; 70/70 vitest pass on merged main.
- [x] PR [#57](https://github.com/Icedmist/WavePass-Backend/pull/57) merged to `main`.

### 29. Secret Hygiene & README Refresh
- [x] README env section stripped to names-only (no values); endpoint table extended with all current routes; setup/verify/deploy docs added.
- [x] Swept docs + source: no real secret material anywhere in the repo.

### 30. PRD Cashout Policy & Single-Credential Provisioning (Issue #58, PR #59)
- [x] **Root cause of paid-no-access**: router users were created as username=MAC while every guest surface logs in with the voucher code. Router username/password are now always the voucher code; MAC stays a router-level binding + session identifier.
- [x] **Proof**: vertical-slice test transfer→approve→provision→retrieve→landing asserts credentials match end to end.
- [x] **Cashout policy**: min floor, auto cap with PENDING hybrid approval, dispute holds, REVERSED state, verifiedAt, transfer webhooks, owner alerts, review-queue + metrics blocks.
- [x] **Verification**: `tsc` clean; 75/75 vitest pass.
- [x] PR [#59](https://github.com/Icedmist/WavePass-Backend/pull/59) merged to `main`.
### 31. Build Fixes & Unit Test Suites (Issue #62, PR #63)
- [x] **Bug**: CI and deployment build workflows failed due to missing `Query` import in `vouchers.controller.ts` and test file inclusion during `nest build`.
- [x] **Fix**: Added missing `Query` import to `@nestjs/common` in `vouchers.controller.ts`; configured `tsconfig.build.json` to exclude test files; fixed strict union types in `test/portal-retrieve-voucher.spec.ts`.
- [x] **Unit Tests**: Added 52 new unit tests across 7 test suites covering `VouchersController`, `CashoutsController`, `VenuesService`, `PlansService`, `OrdersController`, `HealthController`, and `VouchersService` extra edge cases.
- [x] **Verification**: `nest build` clean (0 errors); 140/140 vitest pass across 24 test suites.
- [x] PR [#63](https://github.com/Icedmist/WavePass-Backend/pull/63) merged to `main`.

### 32. Mobile App Version & Direct APK Download Endpoints (Issue #64, PR #65)
- [x] **AppReleaseService (`src/modules/app/app-release.service.ts`)**:
  - Implemented multi-tier fallback release resolution:
    1. Environment variable overrides (`APP_LATEST_VERSION`, `APP_DOWNLOAD_URL`).
    2. Public distribution repository (`Icedmist/WavePass-App`) via GitHub Releases API.
    3. Source repository (`Icedmist/WavePass-Android`) via GitHub Releases API.
    4. 5-minute in-memory caching to guard against GitHub rate limits.
    5. Deterministic fallback metadata when offline.
- [x] **AppReleaseController (`src/modules/app/app-release.controller.ts`)**:
  - `GET /api/v1/app/version`: Returns release version metadata, download URL, release notes, and timestamp.
  - `GET /api/v1/app/download`: HTTP 302 redirect directly to the latest APK binary download.
- [x] **Verification**:
  - `pnpm run build`: Clean build (`nest build`).
  - `pnpm test`: 146/146 vitest pass across 25 suites (including 6 new unit tests in `test/app-release.spec.ts`).
- [x] PR [#65](https://github.com/Icedmist/WavePass-Backend/pull/65) merged to `main`.

### 33. Paystack DVA Name & Phone Compliance & Stale PENDING Auto-Healing (Issue #66, PR #67)
- [x] **Root Cause Analysis**:
  - Wallet screen displayed `PENDING ACTIVATION` because Paystack's `POST /dedicated_account` API strictly requires `first_name`, `last_name`, and a customer `phone` under Nigerian banking/CBN KYC requirements.
  - Previous customer creation only passed `first_name`, omitting `last_name` and `phone`, and reused a global `findFirst` customer code across venues, causing Paystack 400 validation failures and falling back to `accountNumber: 'PENDING'`.
- [x] **Fix & Modernization**:
  - Added `put` method and `updateCustomer` to `PaystackService`, and extended `createCustomer` to accept phone numbers.
  - In `VirtualAccountsService.ensureForVenue`: parsed venue name into compliant `first_name` and `last_name`, formatted normalized Nigerian phone number, and provisioned dedicated virtual account with Wema Bank.
  - Stale `PENDING` rows are automatically upgraded to active accounts upon retrieval or refresh.
- [x] **Unit Testing & Verification**:
  - Added comprehensive tests in `test/virtual-accounts.spec.ts` asserting customer parameter compliance and PENDING upgrading.
  - `nest build`: Clean build (0 errors).
  - `vitest`: 148/148 tests passing across 25 suites.
- [x] PR [#67](https://github.com/Icedmist/WavePass-Backend/pull/67) merged to `main`.

### 34. Venue Slug Resolution in Portal Plans & initPayment Venue Foreign Key Protection (Issue #74, PR #75)
- [x] **PlansService (`src/modules/plans/plans.service.ts`)**:
  - `listPlans(venueId?: string)` now resolves venue slug or UUID to `Venue.id`. If a slug (e.g., `dan-musa-wifi`) is passed via `/api/v1/portal/plans?venueId=<slug>`, it looks up the venue and filters active plans by the resolved UUID, ensuring captive portals querying by venue slug receive the venue's live customized plans.
- [x] **PortalService (`src/modules/portal/portal.service.ts`)**:
  - In `initPayment`: resolves `dto.venueId` against both UUID and slug with safe fallback to `plan.venueId`. Prevents Prisma foreign key constraint violations on `Order.venueId` when captive portals submit payments.
  - In bank transfer order creation: safely uses `plan.venueId` ensuring consistency across payment channels.
- [x] **Verification**:
  - `pnpm run build`: Clean build (0 errors).
  - `pnpm test`: 150/150 tests passing across 25 suites.
- [x] PR [#75](https://github.com/Icedmist/WavePass-Backend/pull/75) squashed and merged to `main` (commit `200b1ac`).
