# WavePass — Loopholes & Recommendations

Audited `wavepass-backend` (NestJS Fastify + BullMQ + Prisma/Supabase + Upstash + MikroTik/Paystack), `wavepass-android` (Flutter GoRouter + Supabase), `wavepass-web` (Next.js 14 App Router). Sitemap + hero overlay just shipped.

## CRITICAL Loopholes (fix before public launch)

### 1. No rate limiting
- **Loophole:** `POST /portal/init-payment`, `POST /portal/captive`, `POST /cashouts` and `GET /by-subdomain` accept unlimited requests. An attacker can spam payment-init to create thousands of `PENDING` orders/payments, exhaust DB, or brute-force `verify-password` (single `ADMIN_PASSWORD_HASH`).
- **Fix:** `@nestjs/throttler` global 60/min + stricter 10/min for payment/captive/admin. Already called out in `CLOUD_RUN.md` but not yet installed.

### 2. Admin routes unauthenticated (fixed partially, needs session)
- **Loophole:** `AdminController:21` `GET /stats`, `webhook-logs`, `POST /reconcile/cleanup`, `GET /verify/:reference` were `@Controller('admin')` with **no guard**. We added `POST /admin/verify-password` with `timingSafeEqual` vs `ADMIN_PASSWORD_HASH` → issues `JWT` via `JWT_SECRET` (2h expiry, flag: confirm duration) + `AuthGuard` on the other routes. Verify token is `Authorization: Bearer <jwt>` and `verify-password` itself is excluded.
- **Recommendation:** Rotate `ADMIN_PASSWORD` from default `NexaAdmin#2025!WavePass` after first deploy, store `ADMIN_PASSWORD_HASH` only in Secret Manager, not `.env` in repo.

### 3. CORS `origin: true, credentials: true` (`src/main.ts:30`)
- **Loophole:** Reflects any `Origin` while allowing cookies/auth headers → CSRF on `POST /cashouts`.
- **Fixed:** Allow-list from `FRONTEND_URL` (comma-separated, e.g. `https://my-venue.wavepass.com,https://wavepass-web.vercel.app`), default to single `FRONTEND_URL`.

### 4. No Prisma migrations
- **Loophole:** `supabase-schema.sql` + `prisma db push` is not versioned/reversible; `schema.prisma` changes (e.g. `VirtualAccount` added) were `db push` ad-hoc.
- **Fixed:** `npx prisma migrate dev --name init` baseline created under `prisma/migrations/` (additive, no data wipe). Future changes must use `migrate`, not `db push`.

### 5. HotSpot walled garden bypass
- **Loophole:** If `wavepass-setup.rsc:21` misses `wavepass-web.vercel.app` or `*.vercel.app`, unpaid devices cannot reach `/portal` after captive 302 → infinite redirect loop. Conversely, if `*.wavepass.com` is too permissive, paid users could bypass via DNS trick.
- **Fix:** Script now adds `wavepass-web.vercel.app`, `*.vercel.app`, `techwithnexa.com` + `portal.wavepass.local`. On tunnel mode (`10.8.0.x`), still needs relay VM — document that.

## HIGH — Business/Integrity

### 6. Single `ADMIN_PASSWORD` for all venues
- **Loophole:** One hash in `.env` → compromise leaks all venues' cashout auth. No per-venue owner password, no audit of who confirmed.
- **Rec:** Per-venue `VenueMember.role=Owner` + `OWNER_CASHOUT_PASSWORD_HASH` per venue (already added as fallback), log `confirmedBy` in `Cashout` + `AuditLog`.

### 7. Pricing not server-locked on voucher path
- **Loophole:** `sell_pass_screen.dart` hardcoded `₦200/800/1500` — staff could hand-edit price via `PlanConfigurator` but enforces nothing on redeem. Backend `PlansService` versioning exists but `VouchersService` stores `displayCodeEnc` plaintext.
- **Rec:** Enforce `Order.amountMinor == Plan.priceMinor` at `init-payment` and on `POST /portal/init-payment`; encrypt `displayCodeEnc` with `ENCRYPTION_KEY`.

### 8. Voucher reuse race
- **Current:** `Voucher.codeHash` unique + atomic redeem mitigates, but `Session.orderId` is plain string (no FK) → orphan sessions possible. Reconcile (`POST /admin/reconcile`) is manual, not cron 5m.

## MEDIUM — UX/Data

### 9. Onboarding bypass
- **Loophole:** `has_seen_onboarding` in `SharedPreferences` can be cleared → replay onboarding, but venue creation (`logoUrl` required per `CreateVenueDto`) can be skipped by directly `POST /venues` without logo → subdomain shows broken image. Frontend now enforces logo+pricing in 8th onboarding card + `GET /by-subdomain` 404, but `GET /venues/default` fallback hides the error.
- **Rec:** Server-side check: venue without `logoUrl` or 0 active `Plan` returns `412 Precondition Failed` on `GET /portal/landing`.

### 10. Captive portal not universal on HTTPS
- **Loophole:** Modern phones probe `https://connectivitycheck.gstatic.com` — Hotspot only intercepts `http://`, so `https://example.com` shows cert error, not landing.
- **Rec:** Document that venues must keep `http://portal.wavepass.com` bookmark and that Android `CaptivePortalLogin` (http) will still trigger; consider DNS hijack for `https`.

### 11. Heroku-style `MOCK_ROUTER_URL=http://localhost:3001` in prod `.env`
- **Rec:** Override `MOCK_ROUTER_URL` to real router endpoint per venue; otherwise `MikrotikAdapter` falls back to mock and sessions appear `ACTIVE` while router is offline.

## LOW — Polish

- **`.dockerignore` missing** → `node_modules/.git/dist/.env` sent to Cloud Build (slow). Add `.dockerignore` (`node_modules`, `.git`, `dist`, `.env`).
- **CI vs Dockerfile Node mismatch** — `.github/workflows/ci.yml` on Node 20 vs `Dockerfile:2` `node:22-alpine`. Align to 22.
- **No `/health`** — add `GET /health` 200 (no DB) + `GET /health/ready` with `prisma.$queryRaw('SELECT 1')` + `ioredis ping` for LB.
- **Test coverage** — only `test/plans.spec.ts`. Add `paystack.webhook.spec.ts` (HMAC pass/fail) + `mikrotik-provisioning.processor.spec.ts` (mock `fetch` success/retry/fail) without hitting real Paystack/RouterOS.

## Quick Wins (next sprint)

1. Install `@nestjs/throttler` + `JwtModule.register({secret: JWT_SECRET, expiresIn: '2h'})`.
2. `npx prisma migrate dev --name baseline` + commit `prisma/migrations/`.
3. Add `.dockerignore` + bump CI `node-version: 22`.
4. Add `/health` and per-venue owner passwords.

Flagged unknowns: `Admin JWT expiry 2h` — confirm if you want 30m (more secure) or 12h (less friction) before we lock it.
