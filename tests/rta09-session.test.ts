import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken, pruneSessions } from '@mcpex/server';

describe('RTA-09 session pruning', () => {
  it('removes expired entries without removing another live browser', () => {
    const sessions = new Map([
      ['expired', 10],
      ['live', 30],
    ]);
    pruneSessions(sessions, 10);
    expect([...sessions.keys()]).toEqual(['live']);
  });

  it('replaces only the cookie session used by the same browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-rta09-'));
    const service = await createServer(dir);
    try {
      const token = getLocalAccessToken(dir);
      const exchange = async (cookie?: string) => {
        const bootstrap = await service.app.inject({
          method: 'POST',
          url: '/auth/bootstrap',
          headers: { authorization: `Bearer ${token}` },
        });
        const value = (JSON.parse(bootstrap.body) as { token: string }).token;
        const response = await service.app.inject({
          method: 'POST',
          url: '/auth/exchange',
          headers: {
            host: 'localhost',
            origin: 'http://localhost',
            'x-mcpex-csrf': '1',
            ...(cookie ? { cookie } : {}),
          },
          payload: { token: value },
        });
        expect(response.statusCode).toBe(200);
        return response.headers['set-cookie']!.split(';', 1)[0];
      };
      const first = await exchange();
      const other = await exchange();
      const replacement = await exchange(first);
      const status = async (cookie: string) =>
        (await service.app.inject({ method: 'GET', url: '/api/v1/providers', headers: { cookie } }))
          .statusCode;
      expect(await status(first)).toBe(401);
      expect(await status(other)).toBe(200);
      expect(await status(replacement)).toBe(200);
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
