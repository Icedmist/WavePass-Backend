import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { MikrotikAdapter } from '../mikrotik/mikrotik.adapter';
import { CreateRouterDto } from './dto/create-router.dto';
import { RouterStatus } from '@prisma/client';

@Injectable()
export class RoutersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikAdapter,
  ) {}

  async listRouters(venueId?: string) {
    const where = venueId ? { venueId } : {};
    return this.prisma.router.findMany({
      where,
      include: {
        venue: { select: { id: true, name: true, slug: true } },
        _count: { select: { sessions: true, jobs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRouterById(id: string) {
    const router = await this.prisma.router.findUnique({
      where: { id },
      include: { venue: true },
    });
    if (!router) throw new NotFoundException(`Router with id ${id} not found`);
    return router;
  }

  async getVenueRouter(venueId: string) {
    const router = await this.prisma.router.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
    });
    return router;
  }

  async syncRouter(dto: CreateRouterDto) {
    return this.createRouter(dto);
  }

  async createRouter(dto: CreateRouterDto) {
    const existing = await this.prisma.router.findFirst({
      where: {
        venueId: dto.venueId,
        OR: [
          { endpoint: dto.endpoint },
          { name: dto.name },
        ],
      },
    });

    if (existing) {
      const updated = await this.prisma.router.update({
        where: { id: existing.id },
        data: {
          name: dto.name,
          endpoint: dto.endpoint,
          connectionMode: dto.connectionMode,
          rosVersion: dto.rosVersion,
          localIp: dto.localIp !== undefined ? dto.localIp : existing.localIp,
          username: dto.username !== undefined ? dto.username : existing.username,
          password: dto.password !== undefined ? dto.password : existing.password,
          tunnelEndpoint: dto.tunnelEndpoint !== undefined ? dto.tunnelEndpoint : existing.tunnelEndpoint,
          status: RouterStatus.ONLINE,
          lastSeen: new Date(),
        },
      });
      return updated;
    }

    const router = await this.prisma.router.create({
      data: {
        venueId: dto.venueId,
        name: dto.name,
        endpoint: dto.endpoint,
        connectionMode: dto.connectionMode,
        rosVersion: dto.rosVersion,
        localIp: dto.localIp,
        username: dto.username,
        password: dto.password,
        tunnelEndpoint: dto.tunnelEndpoint,
        status: RouterStatus.OFFLINE,
      },
    });

    // Run immediate connectivity check in background
    this.testRouter(router.id).catch(() => {});
    return router;
  }

  async testRouter(id: string) {
    const router = await this.getRouterById(id);
    const user = process.env.MIKROTIK_API_USER || 'admin';
    const pass = process.env.MIKROTIK_API_PASS || '';

    const isPrivateLan =
      !router.endpoint.includes('tunnel') &&
      (router.connectionMode === 'local' ||
        router.endpoint.includes('192.168.') ||
        router.endpoint.includes('10.') ||
        router.endpoint.includes('172.'));

    if (isPrivateLan) {
      // Local LAN router: Cloud backend cannot reach RFC1918 subnets over WAN.
      // Check if router was recently seen by the cashier's app (within 15m) or already marked ONLINE.
      const isRecentlySeen = router.lastSeen && Date.now() - router.lastSeen.getTime() < 15 * 60 * 1000;
      const status = isRecentlySeen || router.status === RouterStatus.ONLINE ? RouterStatus.ONLINE : router.status;
      return router;
    }

    const reachable = await this.mikrotik.testConnection(router.endpoint, user, pass);
    const status = reachable ? RouterStatus.ONLINE : RouterStatus.OFFLINE;

    return this.prisma.router.update({
      where: { id },
      data: {
        status,
        lastSeen: reachable ? new Date() : router.lastSeen,
      },
    });
  }

  async getHealth(id: string) {
    const router = await this.getRouterById(id);
    const user = process.env.MIKROTIK_API_USER || 'admin';
    const pass = process.env.MIKROTIK_API_PASS || '';

    const isPrivateLan =
      !router.endpoint.includes('tunnel') &&
      (router.connectionMode === 'local' ||
        router.endpoint.includes('192.168.') ||
        router.endpoint.includes('10.') ||
        router.endpoint.includes('172.'));

    if (isPrivateLan) {
      const isRecentlySeen = router.lastSeen && Date.now() - router.lastSeen.getTime() < 15 * 60 * 1000;
      const status = isRecentlySeen || router.status === RouterStatus.ONLINE ? RouterStatus.ONLINE : RouterStatus.OFFLINE;
      return {
        id: router.id,
        name: router.name,
        endpoint: router.endpoint,
        status,
        lastSeen: router.lastSeen,
        reachable: status === RouterStatus.ONLINE,
        resource: null,
        timestamp: new Date(),
      };
    }

    const resource = await this.mikrotik.getSystemResource(router.endpoint, { username: user, password: pass });
    const reachable = resource !== null;
    const newStatus = reachable ? RouterStatus.ONLINE : RouterStatus.OFFLINE;

    if (router.status !== newStatus) {
      await this.prisma.router.update({
        where: { id },
        data: { status: newStatus, lastSeen: reachable ? new Date() : router.lastSeen },
      }).catch(() => {});
    }

    return {
      id: router.id,
      name: router.name,
      endpoint: router.endpoint,
      status: newStatus,
      lastSeen: reachable ? new Date() : router.lastSeen,
      reachable,
      resource: resource || null,
      timestamp: new Date(),
    };
  }

  async recordHeartbeat(id: string, data?: { status?: string; latencyMs?: number }) {
    return this.prisma.router.update({
      where: { id },
      data: {
        status: RouterStatus.ONLINE,
        lastSeen: new Date(),
      },
    });
  }

  async rebootRouter(id: string) {
    const router = await this.getRouterById(id);
    const user = process.env.MIKROTIK_API_USER || 'admin';
    const pass = process.env.MIKROTIK_API_PASS || '';
    const success = await this.mikrotik.rebootRouter(router.endpoint, { username: user, password: pass });
    return {
      ok: success,
      message: success ? `Reboot command sent to router ${router.name} (${router.endpoint})` : `Failed to dispatch reboot to router ${router.name}`,
    };
  }

  async generateHotspotLoginHtml(routerId: string): Promise<string> {
    const router = await this.getRouterById(routerId);
    const slug = (router as any)?.venue?.slug || 'flagship';
    const base = `https://${slug}.nexawavepass.com/portal`;
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${base}"><title>WavePass Wi-Fi</title></head>
<body>
<script>
(function () {
  var base = "${base}";
  var q = "?mac=$(mac)&ip=$(ip)&link-orig=$(link-orig-esc)&venue=${slug}&routerId=${router.id}";
  try { location.replace(base + q); } catch (e) { location.href = base + q; }
})();
</script>
<noscript><a href="${base}">Continue to WavePass Wi-Fi login</a></noscript>
<p>Connecting you to WavePass Wi-Fi… <a href="${base}">tap here if not redirected</a></p>
</body>
</html>`;
  }

  generateProvisionScript(routerId: string) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://nexawavepass.com';
    return `# WavePass Cloud Provisioning Script (RouterOS v7)
# Generated dynamically for Gateway ID: ${routerId}

# 1. HotSpot Server Profile
/ip hotspot profile add name="wavepass-profile" \\
  hotspot-address=10.5.50.1 \\
  dns-name="login.nexawavepass.com" \\
  login-by=mac,mac-cookie,http-chap,http-pap \\
  login-page="${frontendUrl}/portal"

# 2. HotSpot Server Instance
/ip hotspot add name="wavepass-hotspot" \\
  interface=bridge1 \\
  profile=wavepass-profile \\
  addresses-per-mac=1 \\
  disabled=no

# 2b. DHCP Server Lease Time (1d lease prevents IP churn & duplicate host table entries)
/ip dhcp-server set [find] lease-time=1d

# 3. Walled Garden Rules (Bypass for authentication & checkout)
/ip hotspot walled-garden add dst-host="*.paystack.co" action=allow comment="Paystack API"
/ip hotspot walled-garden add dst-host="*.paystack.com" action=allow comment="Paystack Checkout"
/ip hotspot walled-garden add dst-host="checkout.paystack.com" action=allow comment="Paystack Hosted"
/ip hotspot walled-garden add dst-host="*.supabase.co" action=allow comment="Supabase Cloud"
/ip hotspot walled-garden add dst-host="nexawavepass.com" action=allow comment="WavePass Domain"
/ip hotspot walled-garden add dst-host="*.nexawavepass.com" action=allow comment="WavePass Venues"
/ip hotspot walled-garden add dst-host="api.nexawavepass.com" action=allow comment="WavePass API"

# 3b. Walled Garden IP Rules — dst-host matching never fires for clients using
# DNS-over-HTTPS (private DNS), so the critical hosts are also allowed by IP.
# The API address is the current A record of api.nexawavepass.com; keep in sync
# with the app's provisioning script when the server IP changes.
/ip hotspot walled-garden ip
add comment="WavePass API Static IP (HTTPS)" dst-address=134.209.116.20 action=accept
add comment="WavePass Root Portal (HTTPS)" dst-host="nexawavepass.com" action=accept
add comment="WavePass Portal (HTTPS)" dst-host="*.nexawavepass.com" action=accept
add comment="Google Fonts (HTTPS)" dst-host="fonts.googleapis.com" action=accept
add comment="Google Fonts Static (HTTPS)" dst-host="fonts.gstatic.com" action=accept
add comment="Paystack Wildcard (HTTPS)" dst-host="*.paystack.com" action=accept
add comment="Paystack Checkout Co (HTTPS)" dst-host="*.paystack.co" action=accept
add comment="Paystack API (HTTPS)" dst-host="api.paystack.co" action=accept
add comment="Paystack Checkout UI (HTTPS)" dst-host="checkout.paystack.com" action=accept

# 4. Standard & Multi-Device User Profiles with Rate Limiting (Mikhmon Parity)
/ip hotspot user profile add name="profile_1h" session-timeout=1h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="10M/5M" add-mac-cookie=yes mac-cookie-timeout=3d comment="WavePass 1-Hour Tier"
/ip hotspot user profile add name="profile_12h" session-timeout=12h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="15M/5M" add-mac-cookie=yes mac-cookie-timeout=3d comment="WavePass 12-Hour Tier"
/ip hotspot user profile add name="profile_1d" session-timeout=1d keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="20M/10M" add-mac-cookie=yes mac-cookie-timeout=3d comment="WavePass 24-Hour Tier"
/ip hotspot user profile add name="profile_duo" session-timeout=1d keepalive-timeout=2m shared-users=2 status-autorefresh=1m rate-limit="15M/5M" add-mac-cookie=yes mac-cookie-timeout=3d comment="WavePass Duo Tier (2 Devices)"
/ip hotspot user profile add name="profile_family" session-timeout=1d keepalive-timeout=2m shared-users=5 status-autorefresh=1m rate-limit="25M/10M" add-mac-cookie=yes mac-cookie-timeout=3d comment="WavePass Family Tier (5 Devices)"

# 5. Anti-Tethering Firewall Mangle Rule (Blocks Phone Hotspot Forwarding)
/ip firewall mangle add chain=postrouting action=change-ttl new-ttl=set:1 out-interface=bridge1 comment="WavePass: Anti-Tethering"

# 6. Low-RAM Memory Auto-Cleanup Script & Scheduler (Mikhmon Parity)
:if ([:len [/system/script find name="wavepass-cleanup"]] = 0) do={
  /system script add name="wavepass-cleanup" source={/ip hotspot user remove [find comment="expired"]; /ip hotspot ip-binding remove [find type=bypassed comment~"expired"]} comment="WavePass expired user purge"
}
:if ([:len [/system/scheduler find name="wavepass-cleanup"]] = 0) do={
  /system scheduler add name="wavepass-cleanup" interval=2h on-event="wavepass-cleanup" comment="WavePass 2-hour user cleanup"
}
`;
  }
}
