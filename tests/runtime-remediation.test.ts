import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runToolLoop } from '@mcpex/runtime';
import { executeWorkspaceTool, windowsProcessRows, WorkspaceTools } from '@mcpex/tools';

describe('RTA-03 cancellation boundaries', () => {
  it('does not start a second tool after cancellation during the first', async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    const firstDone = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => {
      entered();
      await firstDone;
      return 'done';
    });
    const run = runToolLoop({
      initialMessages: [],
      tools: [],
      signal: controller.signal,
      generate: async () => ({
        text: '',
        toolCalls: [
          { id: 'first', name: 'read_file', arguments: {} },
          { id: 'second', name: 'write_file', arguments: {} },
        ],
        finishReason: 'tool_calls',
        usage: null,
        providerRequestId: null,
      }),
      execute,
    });
    await firstEntered;
    controller.abort();
    release();
    await expect(run).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted file write before creating a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-rta03-'));
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        executeWorkspaceTool(
          new WorkspaceTools(root),
          new Set(['write_file']),
          'write_file',
          { path: 'cancelled.txt', content: 'unexpected' },
          controller.signal,
        ),
      ).rejects.toBeDefined();
      expect(existsSync(join(root, 'cancelled.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not execute a late model response after its signal is aborted', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => 'unexpected');
    const run = runToolLoop({
      initialMessages: [],
      tools: [],
      signal: controller.signal,
      generate: async () => {
        await pending;
        return {
          text: '',
          toolCalls: [{ id: 'late', name: 'write_file', arguments: {} }],
          finishReason: 'tool_calls' as const,
          usage: null,
          providerRequestId: null,
        };
      },
      execute,
    });
    controller.abort();
    release();
    await expect(run).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not spawn an already-aborted command and removes its listener after completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-rta04-'));
    try {
      const tools = new WorkspaceTools(root, {}, [
        { commandId: 'node', executable: process.execPath },
      ]);
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        tools.runCommand('node', ['-e', 'process.exit(0)'], '.', alreadyAborted.signal),
      ).rejects.toBeDefined();

      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const result = await tools.runCommand(
        'node',
        ['-e', 'process.stdout.write("ok")'],
        '.',
        controller.signal,
      );
      expect(result.stdout).toBe('ok');
      expect(result.exitCode).toBe(0);
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
      controller.abort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'stops a real Windows command tree or reports denied termination',
    async () => {
      const canInspect = await windowsProcessRows().then(
        () => true,
        () => false,
      );
      const root = mkdtempSync(join(tmpdir(), 'mcpex-rta04-tree-'));
      const pidFile = join(root, 'pids.json');
      let pids: number[] = [];
      try {
        const tools = new WorkspaceTools(root, { maxCommandMs: 5000 }, [
          { commandId: 'node', executable: process.execPath },
        ]);
        const controller = new AbortController();
        const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`;
        const running = tools.runCommand('node', ['-e', code, pidFile], '.', controller.signal);
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
        pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
        controller.abort();
        const terminationError = await running.then(
          () => null,
          (error: unknown) => error,
        );
        if (canInspect) expect(terminationError).toBeNull();
        if (terminationError) {
          expect(terminationError).toMatchObject({ code: 'COMMAND_TERMINATION_FAILED' });
          await vi.waitFor(() => expect(() => process.kill(pids[0], 0)).toThrow(), {
            timeout: 5000,
          });
          return;
        }
        await vi.waitFor(
          () => {
            for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
          },
          { timeout: 5000 },
        );
      } finally {
        for (const pid of pids) {
          try {
            process.kill(pid);
          } catch {}
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
