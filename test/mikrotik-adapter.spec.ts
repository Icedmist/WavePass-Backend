import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MikrotikAdapter } from '../src/modules/mikrotik/mikrotik.adapter';

describe('MikrotikAdapter', () => {
  let adapter: MikrotikAdapter;

  beforeEach(() => {
    adapter = new MikrotikAdapter();
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('returns false when endpoint responds with HTML 200 (e.g. Vercel web redirect)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<!DOCTYPE html><html><body>Restricted</body></html>',
        json: async () => { throw new Error('Unexpected token < in JSON'); },
      }));

      const isAlive = await adapter.testConnection('https://tunnel.nexawavepass.com/D401C3E8A1', 'admin', 'pass');
      expect(isAlive).toBe(false);
    });

    it('returns false when endpoint responds with non-RouterOS JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Not Found' }),
      }));

      const isAlive = await adapter.testConnection('https://api.example.com', 'admin', 'pass');
      expect(isAlive).toBe(false);
    });

    it('returns true when endpoint responds with valid RouterOS system resource JSON', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          uptime: '3w2d',
          version: '7.15.2',
          'board-name': 'hEX S',
          platform: 'MikroTik',
          'cpu-load': 2,
        }),
      }));

      const isAlive = await adapter.testConnection('http://192.168.88.1', 'admin', 'pass');
      expect(isAlive).toBe(true);
    });

    it('returns false when fetch rejects with connection refused or timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const isAlive = await adapter.testConnection('http://192.168.88.1', 'admin', 'pass');
      expect(isAlive).toBe(false);
    });
  });

  describe('getSystemResource', () => {
    it('returns null on HTML response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => { throw new Error('Syntax error'); },
      }));

      const res = await adapter.getSystemResource('https://tunnel.nexawavepass.com', { username: 'admin', password: '' });
      expect(res).toBeNull();
    });

    it('returns parsed resource on valid RouterOS response', async () => {
      const payload = {
        uptime: '1d',
        version: '7.12',
        platform: 'MikroTik',
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => payload,
      }));

      const res = await adapter.getSystemResource('http://192.168.88.1', { username: 'admin', password: '' });
      expect(res).toEqual(payload);
    });
  });

  describe('createHotspotUser with MAC binding and shared users', () => {
    it('includes mac-address and shared-users in RouterOS payload', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ '.id': '*1' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await adapter.createHotspotUser(
        'http://192.168.88.1',
        { username: 'admin', password: 'secretpassword' },
        {
          username: 'user1',
          password: 'pass1',
          profile: 'profile_1h',
          sessionTimeoutSeconds: 3600,
          sharedUsers: 1,
          macAddress: 'AA:BB:CC:DD:EE:FF',
        },
      );

      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(callArgs[1].body);
      expect(parsedBody['mac-address']).toBe('AA:BB:CC:DD:EE:FF');
      expect(parsedBody['shared-users']).toBe('1');
    });
  });

  describe('bindUserToMac', () => {
    it('sends PATCH with uppercase MAC address', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await adapter.bindUserToMac(
        'http://192.168.88.1',
        { username: 'admin', password: 'secretpassword' },
        'WP-TEST',
        'aa:bb:cc:dd:ee:ff',
      );

      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[0]).toBe('http://192.168.88.1/rest/ip/hotspot/user/WP-TEST');
      expect(callArgs[1].method).toBe('PATCH');
      const parsedBody = JSON.parse(callArgs[1].body);
      expect(parsedBody['mac-address']).toBe('AA:BB:CC:DD:EE:FF');
    });
  });
});
