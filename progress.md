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

