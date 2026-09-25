import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  taskkillCalls: 0,
  pidFile: '',
  taskkillMode: 'fail',
  probes: 0,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fs = await import('node:fs');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    ...actual,
    execFile: (
      file: string,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'powershell.exe') throw new Error('unexpected executable');
      const pids = JSON.parse(fs.readFileSync(mocked.pidFile, 'utf8')) as {
        parent: number;
        child: number;
      };
      mocked.probes++;
      const rows = [
        {
          pid: pids.parent,
          parentPid: process.pid,
          started: mocked.taskkillMode === 'reuse' && mocked.probes > 1 ? '999' : '100',
        },
        { pid: pids.child, parentPid: pids.parent, started: '101' },
      ]
        .filter((row) => mocked.taskkillMode !== 'success' || mocked.taskkillCalls === 0)
        .filter((row) => alive(row.pid));
      process.nextTick(() => callback(null, JSON.stringify(rows), ''));
    },
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] === 'taskkill') {
        mocked.taskkillCalls++;
        const killer = new EventEmitter();
        process.nextTick(() => {
          if (mocked.taskkillMode === 'success') {
            const pids = JSON.parse(fs.readFileSync(mocked.pidFile, 'utf8')) as {
              parent: number;
              child: number;
            };
            for (const pid of [pids.child, pids.parent]) {
              try {
                process.kill(pid);
              } catch {}
            }
            killer.emit('close', 0);
          } else killer.emit('error', new Error('simulated taskkill failure'));
        });
        return killer;
      }
      return actual.spawn(...args);
    },
  };
});

import { FULL_ACCESS_WORKSPACE, RunQueue, runToolLoop } from '@mcpex/runtime';
import { processTree, stillRunning, survivingTree, WorkspaceTools } from '@mcpex/tools';

async function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('RTA-04 command termination', () => {
  it('tracks descendants of exited ancestors without adopting a reused PID family', () => {
    const recorded = [
      { pid: 10, started: '100' },
      { pid: 11, started: '101' },
    ];
    expect(survivingTree([{ pid: 12, parentPid: 11, started: '102' }], recorded)).toEqual([
      { pid: 12, started: '102' },
    ]);
    expect(
      survivingTree(
        [
          { pid: 11, parentPid: 1, started: '200' },
          { pid: 12, parentPid: 11, started: '102' },
          { pid: 13, parentPid: 11, started: '201' },
        ],
        recorded,
      ),
    ).toEqual([{ pid: 12, started: '102' }]);
  });
  it('does not turn an unsafe termination into a cancelled or recoverable tool result', async () => {
    const controller = new AbortController();
    const error = Object.assign(new Error('종료 확인 실패·추가 실행 차단'), {
      code: 'COMMAND_TERMINATION_FAILED',
    });
    await expect(
      runToolLoop({
        initialMessages: [],
        tools: [],
        signal: controller.signal,
        generate: async () => ({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'run_command', arguments: {} }],
        }),
        execute: async () => {
          controller.abort();
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it('keeps termination failure visible when an execution deadline caused the abort', async () => {
    const queue = new RunQueue();
    const error = Object.assign(new Error('종료 확인 실패·추가 실행 차단'), {
      code: 'COMMAND_TERMINATION_FAILED',
    });
    await expect(
      queue.submit(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(error), { once: true });
          }),
        join(tmpdir(), 'mcpex-deadline-safety'),
        undefined,
        { executionTimeoutMs: 20 },
      ),
    ).rejects.toBe(error);
  });

  it('uses PID and creation time and ignores a reused parent PID', () => {
    const rows = [
      { pid: 10, parentPid: 1, started: '100' },
      { pid: 11, parentPid: 10, started: '101' },
      { pid: 12, parentPid: 10, started: '99' },
    ];
    expect(processTree(rows, 10)).toEqual([
      { pid: 10, started: '100' },
      { pid: 11, started: '101' },
    ]);
    expect(
      stillRunning([{ pid: 11, parentPid: 10, started: '102' }], [{ pid: 11, started: '101' }]),
    ).toEqual([]);
    expect(
      survivingTree([{ pid: 13, parentPid: 10, started: '103' }], [{ pid: 10, started: '100' }]),
    ).toEqual([{ pid: 13, started: '103' }]);
  });

  it.skipIf(process.platform !== 'win32')(
    'does not taskkill a PID whose creation time changed',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'mcpex-rta04-reuse-'));
      const pidFile = join(root, 'pids.json');
      mocked.pidFile = pidFile;
      mocked.probes = 0;
      mocked.taskkillCalls = 0;
      mocked.taskkillMode = 'reuse';
      let blocked = false;
      try {
        const tools = new WorkspaceTools(
          root,
          { maxCommandMs: 5000 },
          [{ commandId: 'node', executable: process.execPath }],
          () => (blocked = true),
        );
        const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:999999}));setInterval(()=>{},1000)`;
        const controller = new AbortController();
        const running = tools.runCommand('node', ['-e', code], '.', controller.signal);
        await waitUntil(() => existsSync(pidFile));
        controller.abort();
        await expect(running).rejects.toMatchObject({ code: 'COMMAND_TERMINATION_FAILED' });
        expect(mocked.taskkillCalls).toBe(0);
        expect(blocked).toBe(true);
      } finally {
        mocked.taskkillMode = 'fail';
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );

  it.skipIf(process.platform !== 'win32')(
    'releases the workspace after a confirmed normal cancellation',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'mcpex-rta04-success-'));
      const pidFile = join(root, 'pids.json');
      mocked.pidFile = pidFile;
      mocked.taskkillCalls = 0;
      mocked.probes = 0;
      mocked.taskkillMode = 'success';
      const queue = new RunQueue();
      const controller = new AbortController();
      try {
        const tools = new WorkspaceTools(root, { maxCommandMs: 5000 }, [
          { commandId: 'node', executable: process.execPath },
        ]);
        const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:999999}));setInterval(()=>{},1000)`;
        const running = queue.submit(
          (signal) => tools.runCommand('node', ['-e', code], '.', signal),
          root,
          controller.signal,
        );
        await waitUntil(() => existsSync(pidFile));
        controller.abort();
        expect((await running).commandId).toBe('node');
        expect(mocked.taskkillCalls).toBe(1);
        expect(await queue.submit(async () => 'released', root)).toBe('released');
      } finally {
        mocked.taskkillMode = 'fail';
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );

  it.skipIf(process.platform !== 'win32')(
    'keeps overlapping work blocked while a child survives failed taskkill, then releases explicitly',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'mcpex-rta04-'));
      const pidFile = join(root, 'pids.json');
      const stopFile = join(root, 'stop-child');
      const readyFile = join(root, 'child-ready');
      mocked.pidFile = pidFile;
      mocked.taskkillCalls = 0;
      mocked.probes = 0;
      mocked.taskkillMode = 'fail';
      const queue = new RunQueue();
      const controller = new AbortController();
      const childCode = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))process.exit(0)},20)`;
      const parentCode = `const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true,detached:true});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`;
      let childPid = 0;
      try {
        const tools = new WorkspaceTools(
          root,
          { maxCommandMs: 5000 },
          [{ commandId: 'node', executable: process.execPath }],
          () => queue.blockWorkspace(root),
        );
        const running = queue.submit(
          (signal) => tools.runCommand('node', ['-e', parentCode], '.', signal),
          root,
          controller.signal,
        );
        await waitUntil(() => existsSync(pidFile));
        await waitUntil(() => existsSync(readyFile));
        childPid = (JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number }).child;
        const waiting = queue.submit(async () => 'must not start', root);
        const waitingCheck = expect(waiting).rejects.toMatchObject({ code: 'WORKSPACE_BLOCKED' });
        controller.abort();
        controller.abort();
        await expect(running).rejects.toMatchObject({ code: 'COMMAND_TERMINATION_FAILED' });
        await waitingCheck;
        expect(mocked.taskkillCalls).toBe(1);
        expect(() => process.kill(childPid, 0)).not.toThrow();
        await expect(queue.submit(async () => 'must not start', root)).rejects.toMatchObject({
          code: 'WORKSPACE_BLOCKED',
        });
        await expect(
          queue.submit(async () => 'must not start', FULL_ACCESS_WORKSPACE),
        ).rejects.toMatchObject({ code: 'WORKSPACE_BLOCKED' });
        expect(await queue.submit(async () => 'independent', join(tmpdir(), 'mcpex-other'))).toBe(
          'independent',
        );
        writeFileSync(stopFile, 'stop');
        await waitUntil(() => {
          try {
            process.kill(childPid, 0);
            return false;
          } catch {
            return true;
          }
        });
        queue.unblockWorkspace(root);
        expect(await queue.submit(async () => 'started', root)).toBe('started');
      } finally {
        if (!existsSync(stopFile)) writeFileSync(stopFile, 'stop');
        if (childPid)
          await waitUntil(() => {
            try {
              process.kill(childPid, 0);
              return false;
            } catch {
              return true;
            }
          }).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
