import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rows: [{ pid: 424242, parentPid: 1, started: '100' }] }));
vi.mock('@mcpex/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcpex/tools')>();
  return {
    ...actual,
    windowsProcessRows: async () => mocked.rows,
  };
});

import { createServer, getLocalAccessToken } from '@mcpex/server';
import { RunQueue } from '@mcpex/runtime';
import { Storage } from '@mcpex/storage';

describe('RTA-04 persisted safety block', () => {
  it('requires explicit operator confirmation when process inventory was unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-rta04-manual-'));
    const workspace = join(dir, 'workspace');
    const storage = new Storage(dir);
    storage.setSettings({
      unsafeCommandBlocks: JSON.stringify([
        {
          id: 'unknown',
          workspace,
          createdAt: new Date().toISOString(),
          reason: 'PROCESS_INSPECTION_FAILED',
          processes: [],
        },
      ]),
    });
    storage.close();
    const server = await createServer(dir);
    const auth = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    try {
      const url = '/api/v1/safety-blocks/unknown';
      expect(
        (await server.app.inject({ method: 'POST', url: `${url}/verify`, headers: auth }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `${url}/manual-release`,
            headers: auth,
            payload: { workspace, confirm: 'wrong' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `${url}/manual-release`,
            headers: auth,
            payload: { workspace, confirm: 'I_VERIFIED_PROCESS_TREE_EXITED' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('survives service restart and releases only after identity verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-rta04-restart-'));
    const workspace = join(dir, 'workspace');
    const storage = new Storage(dir);
    storage.setSettings({
      unsafeCommandBlocks: JSON.stringify([
        {
          id: 'block-1',
          workspace,
          createdAt: new Date().toISOString(),
          reason: 'TASKKILL_FAILED',
          processes: [
            { pid: 424242, started: '100' },
            { pid: 424243, started: '101' },
          ],
        },
      ]),
    });
    storage.close();
    const auth = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    mocked.rows = [{ pid: 424244, parentPid: 424243, started: '102' }];
    const blockSpy = vi.spyOn(RunQueue.prototype, 'blockWorkspace');
    let server = await createServer(dir);
    try {
      expect(blockSpy).toHaveBeenCalledWith(workspace);
      expect(
        (await server.app.inject({ method: 'GET', url: '/api/v1/safety-blocks' })).statusCode,
      ).toBe(401);
      const before = await server.app.inject({
        method: 'GET',
        url: '/api/v1/safety-blocks',
        headers: auth,
      });
      expect(before.statusCode).toBe(200);
      expect(before.json().items).toHaveLength(1);
      const alive = await server.app.inject({
        method: 'POST',
        url: '/api/v1/safety-blocks/block-1/verify',
        headers: auth,
      });
      expect(alive.statusCode).toBe(409);
      expect(alive.json().error.code).toBe('COMMAND_PROCESS_STILL_RUNNING');
      expect(
        (
          await server.app.inject({ method: 'GET', url: '/api/v1/safety-blocks', headers: auth })
        ).json().items[0].processes,
      ).toContainEqual({ pid: 424244, started: '102' });
    } finally {
      await server.close();
    }
    blockSpy.mockClear();
    server = await createServer(dir);
    try {
      expect(blockSpy).toHaveBeenCalledWith(workspace);
      expect(
        (
          await server.app.inject({ method: 'GET', url: '/api/v1/safety-blocks', headers: auth })
        ).json().items,
      ).toHaveLength(1);
      mocked.rows = [{ pid: 424245, parentPid: 424244, started: '103' }];
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/v1/safety-blocks/block-1/verify',
            headers: auth,
          })
        ).json().error.code,
      ).toBe('COMMAND_PROCESS_STILL_RUNNING');
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/v1/safety-blocks/block-1/manual-release',
            headers: auth,
            payload: { workspace, confirm: 'I_VERIFIED_PROCESS_TREE_EXITED' },
          })
        ).statusCode,
      ).toBe(409);
      await server.close();
      server = await createServer(dir);
      expect(
        (
          await server.app.inject({ method: 'GET', url: '/api/v1/safety-blocks', headers: auth })
        ).json().items[0].processes,
      ).toContainEqual({ pid: 424245, started: '103' });
      mocked.rows = [];
      const uncertain = await server.app.inject({
        method: 'POST',
        url: '/api/v1/safety-blocks/block-1/verify',
        headers: auth,
      });
      expect(uncertain.statusCode).toBe(409);
      expect(uncertain.json().error.code).toBe('PROCESS_INSPECTION_INCOMPLETE');
      const released = await server.app.inject({
        method: 'POST',
        url: '/api/v1/safety-blocks/block-1/manual-release',
        headers: auth,
        payload: { workspace, confirm: 'I_VERIFIED_PROCESS_TREE_EXITED' },
      });
      expect(released.statusCode).toBe(200);
      expect(released.json().released).toBe(true);
    } finally {
      await server.close();
    }
    server = await createServer(dir);
    try {
      expect(
        (
          await server.app.inject({ method: 'GET', url: '/api/v1/safety-blocks', headers: auth })
        ).json().items,
      ).toEqual([]);
    } finally {
      await server.close();
      blockSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
