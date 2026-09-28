import { Injectable, Logger } from '@nestjs/common';

interface HotspotUserSpec {
  username: string;
  password: string;
  profile?: string;
  sessionTimeoutSeconds?: number;
  rateLimit?: string; // e.g. "2M/1M"
  limitBytesTotal?: number;
  sharedUsers?: number;
  macAddress?: string; // Binds account strictly to device MAC address
}

/**
 * Talks to RouterOS's REST API (v7+) over the private path (WireGuard tunnel or
 * venue LAN — see PRD §6). Credentials come from the secrets store, never from
 * request input. This is intentionally a thin adapter: retries/backoff/timeouts
 * live in the queue processor, not here.
 */
@Injectable()
export class MikrotikAdapter {
  private readonly logger = new Logger(MikrotikAdapter.name);

  async testConnection(endpoint: string, username: string, password: string): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint}/rest/system/resource`, {
        headers: {
          Authorization: this.basicAuth(username, password),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        this.logger.warn(`Router ${endpoint} returned non-JSON content-type: ${contentType}`);
        return false;
      }
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return false;
      return (
        'platform' in data ||
        'board-name' in data ||
        'version' in data ||
        'uptime' in data ||
        'cpu-load' in data
      );
    } catch (err) {
      this.logger.warn(`Router connection test failed: ${(err as Error).message}`);
      return false;
    }
  }

  async createHotspotUser(
    endpoint: string,
    credentials: { username: string; password: string },
    spec: HotspotUserSpec,
  ): Promise<void> {
    const payload = {
      name: spec.username,
      password: spec.password || spec.username,
      profile: spec.profile,
      'limit-uptime': spec.sessionTimeoutSeconds ? `${spec.sessionTimeoutSeconds}s` : undefined,
      'limit-bytes-total': spec.limitBytesTotal,
      'mac-address': spec.macAddress,
      'shared-users': spec.sharedUsers?.toString(),
      comment: `wavepass-provisioned`,
    };

    // First attempt RouterOS v7 standard PUT /rest/ip/hotspot/user
    let res = await fetch(`${endpoint}/rest/ip/hotspot/user`, {
      method: 'PUT',
      headers: {
        Authorization: this.basicAuth(credentials.username, credentials.password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    // Fallback to POST /rest/ip/hotspot/user/add (supported by mock-router and router scripts)
    if (!res || res.status === 404 || res.status === 405) {
      res = await fetch(`${endpoint}/rest/ip/hotspot/user/add`, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth(credentials.username, credentials.password),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    }

    if (!res.ok) {
      throw new Error(`RouterOS create user failed: ${res.status} ${await res.text()}`);
    }
  }

  async removeHotspotUser(
    endpoint: string,
    credentials: { username: string; password: string },
    username: string,
  ): Promise<void> {
    const res = await fetch(
      `${endpoint}/rest/ip/hotspot/user/${encodeURIComponent(username)}`,
      {
        method: 'DELETE',
        headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`RouterOS remove user failed: ${res.status}`);
    }
  }

  async bindUserToMac(
    endpoint: string,
    credentials: { username: string; password: string },
    username: string,
    macAddress: string,
  ): Promise<void> {
    const payload = { 'mac-address': macAddress.toUpperCase() };
    const res = await fetch(`${endpoint}/rest/ip/hotspot/user/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: {
        Authorization: this.basicAuth(credentials.username, credentials.password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (!res || !res.ok) {
      await fetch(`${endpoint}/rest/ip/hotspot/user/set`, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth(credentials.username, credentials.password),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ numbers: username, 'mac-address': macAddress.toUpperCase() }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
    }
  }

  async addIpBinding(
    endpoint: string,
    credentials: { username: string; password: string },
    spec: { macAddress: string; type?: string; comment?: string },
  ): Promise<void> {
    const cleanMac = spec.macAddress.toUpperCase().trim();
    const payload = {
      'mac-address': cleanMac,
      type: spec.type || 'bypassed',
      comment: spec.comment || 'wavepass-bypassed',
    };

    let res = await fetch(`${endpoint}/rest/ip/hotspot/ip-binding`, {
      method: 'PUT',
      headers: {
        Authorization: this.basicAuth(credentials.username, credentials.password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (!res || res.status === 404 || res.status === 405) {
      res = await fetch(`${endpoint}/rest/ip/hotspot/ip-binding/add`, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth(credentials.username, credentials.password),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
    }

    if (res && !res.ok && res.status !== 400) {
      this.logger.warn(`RouterOS add ip-binding failed for ${cleanMac}: ${res.status}`);
    }
  }

  async removeIpBinding(
    endpoint: string,
    credentials: { username: string; password: string },
    macAddress: string,
  ): Promise<void> {
    const cleanMac = macAddress.toUpperCase().trim();
    try {
      const res = await fetch(`${endpoint}/rest/ip/hotspot/ip-binding`, {
        headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const bindings = (await res.json()) as any[];
      if (!Array.isArray(bindings)) return;
      const target = bindings.find((b) => (b['mac-address'] || '').toUpperCase() === cleanMac);
      if (target && target['.id']) {
        await fetch(`${endpoint}/rest/ip/hotspot/ip-binding/${encodeURIComponent(target['.id'])}`, {
          method: 'DELETE',
          headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
          signal: AbortSignal.timeout(5000),
        });
      }
    } catch (err: any) {
      this.logger.warn(`Failed to remove IP binding for ${cleanMac}: ${err.message}`);
    }
  }

  parseRouterOsDuration(uptimeStr?: string): number {
    if (!uptimeStr) return 0;
    let totalSec = 0;
    const s = uptimeStr.trim().toLowerCase();
    const weeks = s.match(/(\d+)w/);
    const days = s.match(/(\d+)d/);
    const hours = s.match(/(\d+)h/);
    const mins = s.match(/(\d+)m(?!s)/);
    const secs = s.match(/(\d+)s/);
    if (weeks) totalSec += parseInt(weeks[1], 10) * 604800;
    if (days) totalSec += parseInt(days[1], 10) * 86400;
    if (hours) totalSec += parseInt(hours[1], 10) * 3600;
    if (mins) totalSec += parseInt(mins[1], 10) * 60;
    if (secs) totalSec += parseInt(secs[1], 10);
    if (!weeks && !days && !hours && !mins && !secs && s.includes(':')) {
      const parts = s.split(':').map((p) => parseInt(p, 10) || 0);
      if (parts.length === 3) totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
    }
    return totalSec;
  }

  async getActiveHotspotData(endpoint: string, credentials: { username: string; password: string }) {
    try {
      const res = await fetch(`${endpoint}/rest/ip/hotspot/active`, {
        headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      return (await res.json()) as any[];
    } catch {
      return [];
    }
  }

  async getHotspotUserData(endpoint: string, credentials: { username: string; password: string }, userOrMac: string) {
    try {
      const res = await fetch(`${endpoint}/rest/ip/hotspot/user`, {
        headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const users = (await res.json()) as any[];
      if (!Array.isArray(users)) return null;
      const target = userOrMac.toUpperCase().trim();
      return users.find((u: any) =>
        String(u.name || '').toUpperCase() === target ||
        String(u['mac-address'] || '').toUpperCase() === target ||
        String(u.comment || '').toUpperCase().includes(target)
      ) || null;
    } catch {
      return null;
    }
  }

  async rebootRouter(endpoint: string, credentials: { username: string; password: string }): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint}/rest/system/reboot`, {
        method: 'POST',
        headers: { Authorization: this.basicAuth(credentials.username, credentials.password) },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok || res.status === 200 || res.status === 204;
    } catch (err) {
      this.logger.warn(`Router reboot request failed: ${(err as Error).message}`);
      return false;
    }
  }

  async getSystemResource(endpoint: string, credentials: { username: string; password: string }) {
    try {
      const res = await fetch(`${endpoint}/rest/system/resource`, {
        headers: {
          Authorization: this.basicAuth(credentials.username, credentials.password),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return null;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return null;
      const isRouterOs =
        'platform' in data ||
        'board-name' in data ||
        'version' in data ||
        'uptime' in data ||
        'cpu-load' in data;
      return isRouterOs ? data : null;
    } catch {
      return null;
    }
  }

  private basicAuth(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
}
