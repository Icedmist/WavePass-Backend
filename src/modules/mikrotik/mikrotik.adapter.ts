import { Injectable, Logger } from '@nestjs/common';

interface HotspotUserSpec {
  username: string;
  password: string;
  profile?: string;
  sessionTimeoutSeconds?: number;
  rateLimit?: string; // e.g. "2M/1M"
  limitBytesTotal?: number;
  sharedUsers?: number;
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
        headers: { Authorization: this.basicAuth(username, password) },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
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

  private basicAuth(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
}
