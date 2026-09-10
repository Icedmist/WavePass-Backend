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
});
