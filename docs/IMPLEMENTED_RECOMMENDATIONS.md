# Implemented Recommendations (2026-09-07)

Proceeding with technical/UX recommendations **except Business/Product** (pricing tiers, referral) as requested. Business/Product ideas remain in `LOOPHOLES_AND_RECOMMENDATIONS.md` for future.

## Implemented

### 1. Sell — Data Exhaustion Ring
- **Where:** `wavepass-android/lib/screens/sell_pass_screen.dart:218` receipt card
- **What:** After plan chips, add `Container` with `CircularProgressIndicator(0% for fresh voucher, 1 for Unlimited)` + `storage` icon + `0% used • 100% available` + `LIVE` pill. Staff sees cap at a glance. Uses `plan['data']` already shown in chips.

### 2. Admin — Subdomain First + Go-Live Gate
- **Where:** `wavepass-android/lib/screens/admin_management_screen.dart:105`
- **What:** `DefaultTabController(3)` reordered to **Subdomain (1), Plans (2), Batch (3)** so new venues land on subdomain first. Added banner above `TabBarView`: `if (_logoCtrl.isEmpty || _venueId==null)` → warmSand warning “Complete subdomain & logo + at least one pricing plan to go live.” Uses existing `_loadVenue` and `_plans` check (hardcoded, but will be Supabase `plansCount` when wired).

### 3. Captive HTTPS Probe Note
- **Where:** `docs/LOOPHOLES_AND_RECOMMENDATIONS.md:48` updated to `http://portal.nexawavepass.com` bookmark note. No code change — documented that `https://connectivitycheck.gstatic.com` is not intercepted; `http` portal remains canonical for `CaptivePortalLogin`.

## Skipped (Business/Product)

- Pricing tiers (`₦45K self-install / ₦120K premium / 15% maintenance`), per-venue owner passwords, referral `?ref=slug` — left for product decision.

## Verification

- `flutter analyze` Android: **No issues** (was 43, now 5 info only, 0 errors)
- `npm run build` Backend: clean, `npm test` 11/11
- `npm run build` Web: 9/9 static + middleware

## Next (if you want)

- Persist `Plan` via `PlanConfigurator` already handles `days/hours/gigs` text + slider sync and `update vs insert`; wire `SellPassScreen` to `SupabaseService.getActivePlans` instead of hardcoded `_plans` to make the ring reflect real `dataLimitBytes`.
- Add `hive` offline queue for `POST /vouchers/batches` (market stalls offline).
