# WavePass API — P0 backend scaffold

Implements the payment-to-access core loop from the PRD (§20, §28.6 P0 items):

```
Order → Paystack initialize → webhook (HMAC-verified) → server-side verify
      → amount check → atomic fulfil-once → MikroTik provisioning → session
```

## What's here
- `prisma/schema.prisma` — full PRD §8 schema (venues, routers, plans, orders,
  payments, vouchers, sessions, router_jobs, webhook_events, audit_logs)
- `src/modules/paystack/` — checkout initialize + signature-verified webhook
- `src/modules/jobs/` — BullMQ payment-fulfilment worker: re-verifies server-side,
  checks amount against the locked order, fulfils exactly once
- `src/modules/mikrotik/` — RouterOS REST adapter + provisioning worker/queue
- `src/modules/vouchers/` — crypto-random codes, hash-only storage, atomic
  single-use redemption
- `src/modules/orders/` — order creation with server-locked plan price

## Not yet built (next, per §28.6)
- `auth` module (Supabase Auth + RBAC guards) — every controller here is
  currently unauthenticated; **do not deploy like this**
- `venues` / `routers` / `plans` CRUD controllers (the tables exist, no HTTP
  surface yet)
- Reconciliation job (§14), voucher/session expiry workers, router heartbeat
- Captive portal + operator dashboard (separate apps)

## Run it
```bash
cp .env.example .env        # fill in Paystack keys, DATABASE_URL, MIKROTIK_* creds
npm install
npx prisma migrate dev --name init
npm run start:dev
```

Point Paystack's webhook URL at `POST /api/v1/payments/paystack/webhook` and
test with the Paystack CLI or `ngrok` for local delivery.

## Sanity-test the core loop locally
1. Seed a venue + router + plan (via `prisma studio` or a quick script) —
   router `endpoint` should point at a reachable RouterOS REST API (or a
   local mock while you don't have a physical router yet).
2. `POST /api/v1/orders` with `{ venueId, planId }`.
3. `POST /api/v1/payments/paystack/initialize` with `{ orderId, email }`.
4. Complete checkout at the returned `authorizationUrl` (use a Paystack test card).
5. Confirm the webhook fires, `payments.status` flips to `FULFILLED` exactly
   once even if you resend the same webhook payload, and a `sessions` row
   appears once the MikroTik adapter call succeeds.
