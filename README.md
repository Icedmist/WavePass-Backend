# WavePass Backend — Enterprise HotSpot Billing & Provisioning Engine

[![NestJS](https://img.shields.io/badge/NestJS-10.0-E0234E?logo=nestjs)](https://nestjs.com)
[![Fastify](https://img.shields.io/badge/Fastify-4.28-000000?logo=fastify)](https://fastify.dev)
[![Prisma](https://img.shields.io/badge/Prisma-5.19-2D3748?logo=prisma)](https://prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql)](https://supabase.com)
[![BullMQ](https://img.shields.io/badge/BullMQ-Redis-DC382D?logo=redis)](https://bullmq.io)

WavePass is a high-performance, multi-tenant Wi-Fi monetization engine built with **NestJS 10**, **Fastify**, **Prisma ORM**, **BullMQ**, and **Upstash Redis**. It provides zero-touch hardware provisioning for **MikroTik RouterOS v7**, server-side locked billing via **Paystack**, Dedicated Virtual Account (DVA) settlement, and self-healing session reconciliation.

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
  - Subdomain resolution (`GET /api/v1/venues/by-subdomain/:slug`).
  - Live RouterOS REST connectivity tests (`POST /api/v1/routers/:id/test`) and diagnostic health checks (`GET /api/v1/routers/:id/health`).
  - Dynamic MikroTik RouterOS v7 script generator (`GET /api/v1/routers/:id/provision.rsc`).
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
  - Cryptographically secure 8-character voucher generation (`POST /api/v1/vouchers/batches`).
  - Bulk production of up to 500 vouchers per batch with SHA-256 code hashing and activation status tracking.
- **Virtual Accounts & Automated Cashouts (`src/modules/virtual-accounts`, `src/modules/cashouts`)**:
  - Platform-wide single-key Paystack model: dedicated virtual account per venue.
  - Operator password-confirmed cashouts directly to NUBAN bank accounts.

---

## 📁 Project Structure

```
wavepass-backend/
├── prisma/
│   ├── schema.prisma              # 15-table PostgreSQL schema (DDL, relations, enums)
│   ├── seed.ts                    # Flagship venue, router, and pricing tier bootstrap
│   └── supabase-schema.sql        # Canonical raw SQL script for Supabase migrations
├── src/
│   ├── app.module.ts              # Root NestJS application module
│   ├── main.ts                    # Fastify bootstrap, raw-body plugin, CORS & global pipes
│   ├── common/
│   │   └── prisma.service.ts      # Prisma client lifecycle provider
│   └── modules/
│       ├── admin/                 # Analytics, HMAC verify, reconcile & hardware cleanup
│       ├── cashouts/              # Bank registration, available balance, owner payout requests
│       ├── health/                # Liveness & readiness probes
│       ├── jobs/                  # BullMQ queues & workers for asynchronous fulfillment
│       ├── mikrotik/              # RouterOS v7 REST client, provisioning worker, user bind
│       ├── orders/                # Plan checkout orders and state tracking
│       ├── paystack/              # Single-key Paystack service, DVA creation, webhook handler
│       ├── plans/                 # Wi-Fi duration, speed limits, price tiers & profiles
│       ├── portal/                # Captive portal redirect, landing config, simulation
│       ├── routers/               # Gateway management, ping tests, health, provision.rsc
│       ├── sessions/              # Active client sessions, duration countdowns, disconnect
│       ├── venues/                # Multi-tenant venues, branding, logo upload, subdomains
│       ├── virtual-accounts/      # Dedicated virtual accounts (DVA) per venue
│       └── vouchers/              # Batch voucher generation, single cash vouchers, SHA-256
├── test/
│   ├── mikrotik-provisioning.spec.ts # Provisioning queue tests
│   ├── paystack-webhook.spec.ts      # HMAC verification and idempotency tests
│   └── plans.spec.ts                 # Plan duration, price and profile unit tests
├── Dockerfile                     # Multi-stage production container
├── docker-compose.yml             # Orchestrated PostgreSQL, Redis & API stack
├── package.json                   # Dependencies, build scripts & engine constraints
├── pnpm-lock.yaml                 # Pnpm lockfile
└── tsconfig.json                  # TypeScript build configuration
```

---

## 🗄️ Database & Supabase Deployment

This backend uses **Prisma ORM** targeting **PostgreSQL** (Supabase).

### Option A: 1-Click Push via Supabase SQL Editor
Open your Supabase Project (`vvoenmdzavyzlisykhks`), navigate to the **SQL Editor**, and paste the generated DDL:
[`prisma/supabase-schema.sql`](./prisma/supabase-schema.sql)
Click **Run** to instantiate all 15 domain tables, enums, foreign keys, and indexes.

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

---

## ⚡ Redis (BullMQ Queues)

BullMQ requires Redis. Connects to **Upstash Serverless Redis over TLS**:
```bash
REDIS_URL=rediss://default:[TOKEN]@[ENDPOINT]:6379
```

---

## 📡 MikroTik RouterOS Setup

To configure your physical MikroTik router for WavePass, open Winbox/SSH terminal and paste the script in:
[`docs/wavepass-setup.rsc`](./docs/wavepass-setup.rsc)

Alternatively, fetch the dynamic script configured specifically for your router ID:
```bash
curl -s https://api.nexawavepass.com/api/v1/routers/[ROUTER_ID]/provision.rsc
```

---

## 📚 API Endpoint Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/plans` | List active Wi-Fi pricing plans |
| `POST` | `/api/v1/plans` | Create a new pricing plan (Admin) |
| `GET` | `/api/v1/venues/default` | Auto-bootstrap/retrieve default venue |
| `GET` | `/api/v1/venues/by-subdomain/:slug` | Multi-tenant subdomain lookup |
| `POST` | `/api/v1/venues` | Create venue with logoUrl and subdomain slug |
| `GET` | `/api/v1/routers` | List routers for a venue |
| `GET` | `/api/v1/routers/:id/health` | RouterOS connectivity diagnostics |
| `POST` | `/api/v1/routers/:id/test` | Live hardware ping test |
| `GET` | `/api/v1/routers/:id/provision.rsc`| Dynamic RouterOS v7 provisioning script |
| `POST` | `/api/v1/vouchers/batches` | Bulk generate vouchers (1–500) |
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
| `GET` | `/api/v1/vouchers/check/:code` | Non-consuming voucher existence check |
| `POST` | `/api/v1/portal/transfer-request` | Guest bank-transfer request (owner approval) |
| `POST` | `/api/v1/portal/approve-access` | Owner approval → voucher + provisioning (idempotent) |
| `GET` | `/api/v1/portal/retrieve-voucher?mac=` | Guest voucher lookup by device MAC |
| `GET` | `/api/v1/portal/router-sync` | RouterOS pull script for offline routers |
| `GET` | `/api/v1/portal/active-session?mac=&reference=` | Paid/access status incl. reference lookup |
| `GET` | `/api/v1/venues/:id/readiness` | New-venue setup gate (plans + router) |
| `GET` | `/api/v1/notifications?venueId=` | Owner payment alerts (poll-based) |
| `GET` | `/api/v1/admin/activation-codes` | List activation codes (kinds, expiry) |
| `POST` | `/api/v1/admin/activation-codes/generate` | Monthly batch: kind + durationDays + venueIds |
| `POST` | `/api/v1/admin/activation-codes/redeem` | Redeem code (quota + venue binding enforced) |
| `POST` | `/api/v1/admin/activation-requests` | Codeless user requests a code |
| `GET` | `/api/v1/admin/activation-requests` | Review requests |
| `POST` | `/api/v1/admin/activation-requests/:id/approve` | Grant code or direct time-boxed access |
| `GET` | `/api/v1/admin/funnel?venueId=&days=` | Sales funnel: initiated → paid → active + revenue |
| `GET` | `/api/v1/admin/review-queue?venueId=` | Refund-required, stuck, failed, reversed cases |
| `GET` | `/api/v1/admin/metrics?days=` | Payment/webhook/provisioning rates, latency, DVAs |

---

## ✅ Setup, Verification & Deployment

```bash
# Install
pnpm install

# Generate Prisma client
npx prisma generate

# Verify (must be clean before any PR)
npx tsc --noEmit
npm test          # vitest suite

# Build
npm run build     # nest build -> dist/
```

### Environment (`.env` — names only, never commit values)
```ini
DATABASE_URL=...                     # Supabase pooled connection
DIRECT_DATABASE_URL=...              # Supabase direct connection (migrations)
REDIS_URL=...
PAYSTACK_SECRET_KEY=...              # live key; mock/placeholder/xxx => mock mode
FRONTEND_URL=...
JWT_SECRET=...
ADMIN_PASSWORD=...
OWNER_CASHOUT_PASSWORD=...
MIKROTIK_API_USER=...
MIKROTIK_API_PASS=...
```

### Deploy notes
- Run `npx prisma migrate deploy` on every release (Notification, ActivationCode/Kind/Redemption/Request, Cashout.clientReference tables).
- Webhook needs a public HTTPS URL; Paystack signs with `PAYSTACK_SECRET_KEY` (HMAC-SHA512 over raw body).
- Fulfilment survives Redis outages via webhook-ledger requeue; provisioning degrades to cloud vouchers when routers are offline (router-sync + reconcile heal hardware later).
- See `progress.md` for the milestone log and `AGENT_WORKFLOW.md` for the mandatory issue → branch → PR → merge lifecycle.
