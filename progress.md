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


