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

  async createRouter(dto: CreateRouterDto) {
    const router = await this.prisma.router.create({
      data: {
        venueId: dto.venueId,
        name: dto.name,
        endpoint: dto.endpoint,
        connectionMode: dto.connectionMode,
        rosVersion: dto.rosVersion,
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
    const resource = await this.mikrotik.getSystemResource(router.endpoint, { username: user, password: pass });
    const reachable = resource !== null || router.status === RouterStatus.ONLINE;

    if (resource && router.status !== RouterStatus.ONLINE) {
      await this.prisma.router.update({
        where: { id },
        data: { status: RouterStatus.ONLINE, lastSeen: new Date() },
      }).catch(() => {});
    }

    return {
      id: router.id,
      name: router.name,
      endpoint: router.endpoint,
      status: reachable ? RouterStatus.ONLINE : RouterStatus.OFFLINE,
      lastSeen: reachable ? new Date() : router.lastSeen,
      reachable,
      resource: resource || null,
      timestamp: new Date(),
    };
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
  login-by=http-chap,http-pap,mac-cookie \\
  login-page="${frontendUrl}/portal"

# 2. HotSpot Server Instance
/ip hotspot add name="wavepass-hotspot" \\
  interface=bridge1 \\
  profile=wavepass-profile \\
  disabled=no

# 3. Walled Garden Rules (Bypass for authentication & checkout)
/ip hotspot walled-garden add dst-host="*.paystack.co" action=allow comment="Paystack API"
/ip hotspot walled-garden add dst-host="*.paystack.com" action=allow comment="Paystack Checkout"
/ip hotspot walled-garden add dst-host="checkout.paystack.com" action=allow comment="Paystack Hosted"
/ip hotspot walled-garden add dst-host="*.supabase.co" action=allow comment="Supabase Cloud"
/ip hotspot walled-garden add dst-host="nexawavepass.com" action=allow comment="WavePass Domain"
/ip hotspot walled-garden add dst-host="*.nexawavepass.com" action=allow comment="WavePass Venues"
/ip hotspot walled-garden add dst-host="api.nexawavepass.com" action=allow comment="WavePass API"

# 4. Standard Plan User Profiles with Rate Limiting (Mikhmon Parity)
/ip hotspot user profile add name="profile_1h" session-timeout=1h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="10M/5M" comment="WavePass 1-Hour Tier"
/ip hotspot user profile add name="profile_12h" session-timeout=12h keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="15M/5M" comment="WavePass 12-Hour Tier"
/ip hotspot user profile add name="profile_1d" session-timeout=1d keepalive-timeout=2m shared-users=1 status-autorefresh=1m rate-limit="20M/10M" comment="WavePass 24-Hour Tier"

# 5. Low-RAM Memory Auto-Cleanup Script & Scheduler (Mikhmon Parity)
:if ([:len [/system/script find name="wavepass-cleanup"]] = 0) do={
  /system script add name="wavepass-cleanup" source={/ip hotspot user remove [find comment="expired"]} comment="WavePass expired user purge"
}
:if ([:len [/system/scheduler find name="wavepass-cleanup"]] = 0) do={
  /system scheduler add name="wavepass-cleanup" interval=2h on-event="wavepass-cleanup" comment="WavePass 2-hour user cleanup"
}
`;
  }
}
