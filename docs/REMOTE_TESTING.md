# Remote Testing — WavePass Without Being On-Site

Tester is far away (not on `192.168.88.1` Wi-Fi). Three remote-friendly alternatives — pick one. All assume the **router has internet on `ether1/WAN`** (plug ISP fiber).

## Alternative 1 — Barcode Cloud (Recommended, No Local Network Needed)

> Works even if tester never joins `192.168.88.1`. Just needs router serial + venue.

**You (owner) on-site — 30s:**
1. Power MikroTik, plug ISP into `ether1`.
2. Take a clear photo of the **white sticker on the box** — `Serial: XXXXXXXX` barcode.

**Tester remote (phone + internet):**
1. Open **WavePass Mobile → Set Up a Router → Scan Box Barcode** (or `WavePass-Backend` → `POST /api/v1/routers`).
2. Enter `venueId` (from `GET /api/v1/venues/default` → `slug`) + `serial` from photo → **Create**.
3. Backend creates `Router` with `connectionMode: tunnel` + `serial`. When router boots and gets WAN, it calls `POST https://api.nexawavepass.com/api/v1/routers/claim {serial}` via its own internet → backend pushes `profile_1h/12h/1d` + `walled-garden` for `*.nexawavepass.com` automatically. **No `192.168.88.1` probe needed.**

**Verify:** Tester on remote phone → `https://my-venue.nexawavepass.com/portal?mac=AA:BB:CC:DD:EE:FF` → should show your venue's pricing/logo.

---

## Alternative 2 — Remote Desktop to a PC On-Site (Easiest for You)

> Tester controls a laptop/PC that *is* on `192.168.88.1` via TeamViewer/AnyDesk.

**On-site helper (any phone/PC near router):**
1. Connect laptop to `MikroTik-XXXX` Wi-Fi or `ether2` via cable.
2. Install **TeamViewer** (or AnyDesk) → share ID + password with tester.
3. Keep laptop on, Wi-Fi connected to `192.168.88.1`.

**Tester remote:**
1. TeamViewer → Connect to ID → you now see the on-site laptop's screen.
2. On that remote desktop: open **Winbox** or **Chrome → http://192.168.88.1** → login `admin` / blank → **New Terminal** → paste `docs/wavepass-setup.rsc` (gives `wavepass` user + `www` + profiles).
3. Then **WavePass Mobile** (run via Android emulator on that remote PC or just use the laptop's browser to `https://api.nexawavepass.com/api/v1/portal/captive?mac=...`).

**Verify:** Same as Alternative 1.

---

## Alternative 3 — VPN Tunnel (Phone Appears On-Site)

> Makes tester's phone think it's on `192.168.88.1`.

**You (owner) one-time on router:**
1. Winbox → `IP → WireGuard → Add` → `Private Key` auto, `Listen Port 13231`, `Address 10.8.0.1/24`.
2. `Peers → Add` → `Public Key` (generate on tester's phone via WireGuard app), `Allowed Address 10.8.0.2/32`.
3. `IP → Firewall → Filter → Add Chain=input Protocol=udp Port=13231 Action=accept`.
4. Share `Peer Config` QR with tester.

**Tester remote:**
1. Install **WireGuard** app → Add empty tunnel → scan QR → Activate.
2. Now phone has `10.8.0.2` and can `ping 192.168.88.1`.
3. **WavePass Mobile → Custom Gateway IP: 192.168.88.1 / wavepass / YOURPASS → Find My Router** — now `GET /rest/system/resource` succeeds over the tunnel.

**Verify:** `WireGuard` shows `Handshake: 2s ago`, `WavePass` finds `hAP ax²`.

---

## Where is this doc?

`wavepass-backend/docs/REMOTE_TESTING.md` (also linked from `README.md: Deploy` and `docs/CLOUD_RUN.md`). Keep it next to `docs/wavepass-setup.rsc` so on-site helpers find it.

## Which to pick?

- **No helper on-site? → Alternative 1 (Barcode)** — only needs a photo of the serial.
- **Have a helper/laptop on-site? → Alternative 2 (TeamViewer)** — fastest, no VPN config.
- **Need to test many times remotely? → Alternative 3 (WireGuard)** — one-time setup, then always `192.168.88.1` from anywhere.

For all: ensure **Droplet API** `api.nexawavepass.com` is `Up` (`docker ps` → `wavepass-api`, `curl http://localhost:4000/api/v1/health`) and **DNS** `api.nexawavepass.com → <droplet-ip>` (not Vercel `216.198.79.x`) via `dig api.nexawavepass.com +short`.
