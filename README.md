# WavePass Backend — Enterprise HotSpot Billing & Provisioning Engine

WavePass is a high-performance, multi-tenant Wi-Fi monetization engine built with **NestJS 10**, **Fastify**, **Prisma ORM**, **BullMQ**, and **Upstash Redis**. It provides zero-touch hardware provisioning for **MikroTik RouterOS v7**, server-side locked billing via **Paystack**, and self-healing session reconciliation.

---

## 🏗️ Architecture & Core Loop

```
[Guest Connects] ➔ [Captive Redirect with ?mac=] ➔ [Selects Plan in Portal]
       │
       ▼
[POST /api/v1/portal/init-payment] (Server locks priceMinor strictly from database)
       │
       ▼
[Paystack Checkout] ➔ [POST /api/v1/payments/paystack/webhook] (HMAC-SHA512 raw-body check)
       │
       ▼
[BullMQ Payment Fulfilment Worker] (Atomic single-fulfillment idempotency lock)
       │
       ▼
[BullMQ MikroTik Provisioning Worker] (Binds Client MAC directly to RouterOS HotSpot)
       │
       ▼
[Instant Internet Access] + [Live Remaining Time Countdown]
```

---

## 🚀 Key Modules & Capabilities

- **Plans Management (`src/modules/plans`)**:
  - Full CRUD for internet access plans (`GET`, `POST`, `PATCH`, `DELETE /api/v1/plans`).
  - Version bumping on price changes to preserve historical transaction records (PRD §4.2).
  - Automatically formats duration (`1h`, `12h`, `1d`) and RouterOS profile (`profile_1h`, `profile_12h`, `profile_24h`).
- **Venues & Routers Infrastructure (`src/modules/venues`, `src/modules/routers`)**:
  - Multi-tenant venue scoping with automated default venue bootstrap (`/api/v1/venues/default`).
  - Live RouterOS REST connectivity tests (`POST /api/v1/routers/:id/test`) and diagnostic health checks (`GET /api/v1/routers/:id/health`).
- **Sessions Management (`src/modules/sessions`)**:
  - Real-time active hotspot sessions monitoring (`GET /api/v1/sessions/active`).
  - Hardware-level disconnect capability via `MikrotikAdapter.removeHotspotUser` (`POST /api/v1/sessions/:id/disconnect`).
- **Captive Portal Bridge (`src/modules/portal`)**:
  - Endpoints tailored for captive login browsers: `POST /api/v1/portal/init-payment`, `POST /api/v1/portal/simulate-payment`, `GET /api/v1/portal/sessions/:mac`.
  - Automatic client MAC address binding (`name: MAC`) so devices are authenticated without login prompt.
- **Self-Healing Reconciliation & Cleanup Engine (`src/modules/admin`)**:
  - `POST /api/v1/admin/reconcile`: Cross-references fulfilled database payments against active router users; re-provisions dropped sessions automatically.
  - `POST /api/v1/admin/cleanup`: Garbage-collects expired sessions from RouterOS hardware.
  - `GET /api/v1/admin/stats`: Revenue in NGN/kobo, payment conversion, ARPU, and router counters.
- **Paystack Payment Processor (`src/modules/paystack`, `src/modules/jobs`)**:
  - Raw request buffer capture on Fastify for cryptographically sound HMAC-SHA512 verification.
  - Deduplicated idempotency storage in `webhook_events` table.
  - Asynchronous background execution via BullMQ with exponential backoff retry.
- **Vouchers Module (`src/modules/vouchers`)**:
  - Cryptographically secure 8-character voucher generation.
  - Hash-only database storage (SHA-256) with optional reversible encryption for reprints (PRD §4.3).

---

## 🗄️ Database & Supabase Deployment

This backend uses **Prisma ORM** targeting **PostgreSQL** (Supabase).

### Option A: 1-Click Push via Supabase SQL Editor
Open your Supabase Project (`vvoenmdzavyzlisykhks`), navigate to the **SQL Editor**, and paste the generated DDL:
[`prisma/supabase-schema.sql`](./prisma/supabase-schema.sql)
Click **Run** to instantiate all 12 domain tables, enums, foreign keys, and indexes.

### Option B: Direct CLI Migration
Configure your PostgreSQL connection string in `.env`:
```bash
DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres"
```
Then run:
```bash
npx prisma db push
pnpm run db:seed
```

The seed script automatically populates your flagship venue, primary router, and standard pricing plans (1hr @ ₦200, 12hr @ ₦800, 24hr @ ₦1,500).

---

## ⚡ Redis (BullMQ Queues)

BullMQ requires Redis. By default, it connects to **Upstash Serverless Redis over TLS**:
```bash
REDIS_URL=rediss://default:[TOKEN]@[ENDPOINT]:6379
```
Or for local development via Docker/Podman:
```bash
REDIS_URL=redis://localhost:6379
```

---

## 📡 MikroTik RouterOS Setup (In Under 30 Seconds)

To configure your physical MikroTik router for WavePass, open Winbox/SSH terminal and paste the script in:
[`docs/wavepass-setup.rsc`](./docs/wavepass-setup.rsc)

The script automatically:
1. Creates the dedicated `wavepass` system API user.
2. Enables the REST API (`www` and `www-ssl`).
3. Permits unauthenticated guests to reach Paystack and Supabase via HotSpot Walled Garden.
4. Generates standard HotSpot user profiles (`profile_1h`, `profile_12h`, `profile_1d`) with session timeouts and rate limits.

---

## 💳 Single-Key Paystack (Nexa) — Per-Venue DVA + Auto-Cashout

One **Nexa** `PAYSTACK_SECRET_KEY` powers the whole platform. Each venue gets a **Dedicated Virtual Account (DVA)** — guest transfers land in the platform settlement account, not a per-merchant key.

- `POST /api/v1/virtual-accounts/ensure/:venueId` — idempotent DVA provisioning (real Paystack or mock fallback).
- Venue owner registers payout bank: `POST /api/v1/cashouts/bank-accounts` (creates Paystack transfer recipient).
- **Auto-cashout** — `POST /api/v1/cashouts` `{venueId, amountMinor, password}` verifies the **owner's cashout password** (`OWNER_CASHOUT_PASSWORD_HASH` / `ADMIN_PASSWORD_HASH` fallback), checks `availableMinor = earned − locked`, and immediately executes Paystack `transfer` → `verify` (mock marks `COMPLETED`).
- Back-compat pending cashouts: `POST /api/v1/cashouts/confirm` with owner/admin password.

## 🔐 Admin Password

- `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` (sha256 hex, `timingSafeEqual`) — platform admin (default `NexaAdmin#2025!WavePass`).
- `OWNER_CASHOUT_PASSWORD` / `OWNER_CASHOUT_PASSWORD_HASH` (default `WaveOwner#2025!Cashout`) — venue owner auto-cashout. Falls back to admin hash.
- `POST /api/v1/admin/verify-password` — verify admin credential; admin stats/reconcile/cleanup are elevated.

## 🗃️ Supabase — Single Source of Truth

All domain data lives in **Supabase Postgres** (`DATABASE_URL` pooler). The schema (`prisma/supabase-schema.sql`, 15 tables including `VirtualAccount`, `BankAccount`, `Cashout`) is the canonical DDL — the mobile app, web portal and backend all read/write the same Supabase project (`vvoenmdzavyzlisykhks`):

- Billing: `Venue → Plan → Order → Payment → WebhookEvent`
- Access: `Voucher (codeHash) → Session → RouterJob`
- Payouts: `VirtualAccount (1:1 Venue) → BankAccount → Cashout`
- Ops: `User ↔ VenueMember, AuditLog`

Push changes with `npx prisma db push` then `npx prisma generate`. Keep `.env` pooler URLs in sync.

## 🎨 Branding

New WavePass mark (`logo.png` — black squircle, white ribbon-W + Wi-Fi arcs) lives in `wavepass-design/logo/`, mirrored to `wavepass-web/public/logo.png` and `wavepass-android/assets/images/logo.png` (+ resized `mipmap-*` launchers).

## 🛠️ Local Development & Testing

```bash
# 1. Install dependencies
pnpm install

# 2. Generate Prisma client
npx prisma generate

# 3. Run unit tests
pnpm test

# 4. Build production bundle
pnpm build

# 5. Start API server on :3000
pnpm start:dev

# 6. Sync Supabase schema (regenerates prisma/supabase-schema.sql)
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/supabase-schema.sql
npx prisma db push
```

---

## 🐳 Docker & Containerization

Run the orchestrated container stack (Postgres + Redis + API):
```bash
docker compose up -d --build
```
Or build the production image independently:
```bash
docker build -t wavepass-api .
```

---

## 📚 API Endpoint Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/plans` | List active Wi-Fi pricing plans |
| `POST` | `/api/v1/plans` | Create a new pricing plan (Admin) |
| `GET` | `/api/v1/venues/default` | Auto-bootstrap/retrieve default venue |
| `GET` | `/api/v1/routers/:id/health` | RouterOS connectivity diagnostics |
| `POST` | `/api/v1/routers/:id/test` | Live hardware ping test |
| `GET` | `/api/v1/sessions/active` | Active Wi-Fi sessions with hardware sync |
| `POST` | `/api/v1/sessions/:id/disconnect`| Terminate user session on router |
| `POST` | `/api/v1/portal/init-payment` | Initiate guest payment with MAC binding |
| `POST` | `/api/v1/portal/simulate-payment` | 1-Click offline payment simulation |
| `GET` | `/api/v1/portal/sessions/:mac` | Live countdown status for guest MAC |
| `POST` | `/api/v1/payments/paystack/webhook` | Paystack HMAC-verified payment webhook |
| `GET` | `/api/v1/cashouts/balance/:venueId` | Venue available balance (earned − locked) |
| `POST` | `/api/v1/cashouts/bank-accounts` | Register payout NUBAN (Paystack recipient) |
| `POST` | `/api/v1/cashouts` | Auto-cashout (owner password, instant transfer) |
| `POST` | `/api/v1/cashouts/confirm` | Confirm pending cashout (owner/admin password) |
| `GET` | `/api/v1/virtual-accounts/venue/:venueId` | Venue DVA (accountNumber/bank) |
| `POST` | `/api/v1/virtual-accounts/ensure/:venueId` | Ensure DVA per venue (idempotent) |
| `POST` | `/api/v1/admin/verify-password` | Verify platform admin password |
| `GET` | `/api/v1/admin/stats` | Live revenue, ARPU, plan sales, and session stats |
| `POST` | `/api/v1/admin/reconcile` | Self-healing session reconciliation |
| `POST` | `/api/v1/admin/cleanup` | Delete expired users on RouterOS |
