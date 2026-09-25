import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  executeWorkspaceTool,
  getWorkspaceToolDefinitions,
  resolveWorkspaceRoot,
  WorkspaceTools,
  ToolError,
} from '@mcpex/tools';
import { FULL_ACCESS_WORKSPACE, RunQueue, runToolLoop, WorkspaceLockManager } from '@mcpex/runtime';
import type { GenerateResult } from '@mcpex/providers';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

async function toolProviderMock(fullRoot?: string): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    if (request.url !== '/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw) as {
        tools?: Array<{
          function?: {
            name?: string;
            parameters?: {
              required?: string[];
              properties?: Record<string, { description?: string }>;
            };
          };
        }>;
        messages: Array<{ role: string; content: string }>;
      };
      const toolMessages = body.messages.filter((message) => message.role === 'tool');
      const fullSchema = body.messages.some(
        (message) => message.role === 'user' && message.content.includes('full schema'),
      );
      const shouldTimeout = body.messages.some(
        (message) => message.role === 'user' && message.content.includes('timeout'),
      );
      response.setHeader('content-type', 'application/json');
      if (fullSchema) {
        if (!fullRoot) throw new Error('full root missing');
        if (toolMessages.length === 0) {
          const definition = body.tools?.find((tool) => tool.function?.name === 'list_files');
          expect(definition?.function?.parameters?.required).toContain('path');
          expect(definition?.function?.parameters?.properties?.path?.description).toContain(
            '절대 경로',
          );
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-full-list',
                        type: 'function',
                        function: {
                          name: 'list_files',
                          arguments: JSON.stringify({ path: fullRoot }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
        } else {
          response.end(
            JSON.stringify({
              choices: [{ message: { content: 'full-schema-complete' }, finish_reason: 'stop' }],
            }),
          );
        }
        return;
      }
      if (toolMessages.length === 0) {
        expect(body.tools?.map((tool) => tool.function?.name)).toContain('read_file');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-read',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"note.txt"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        );
      } else if (toolMessages.length === 1) {
        const readResult = JSON.parse(toolMessages[0].content) as { hash: string };
        expect(body.tools?.map((tool) => tool.function?.name)).toContain('write_file');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'note.txt',
                          content: 'updated by tool',
                          expectedHash: readResult.hash,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        );
      } else {
        expect(body.messages.at(-1)?.role).toBe('tool');
        if (shouldTimeout) return;
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'tool-loop-complete' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('P4 workspace tools', () => {
  it('rejects workspace roots with symbolic link or junction components', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcpex-linked-root-'));
    const target = join(base, 'target');
    const linked = join(base, 'linked');
    const swapped = join(base, 'swapped');
    mkdirSync(join(target, 'nested'), { recursive: true });
    mkdirSync(swapped);
    symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(resolveWorkspaceRoot(target)).toBe(target);
      expect(() => resolveWorkspaceRoot(linked)).toThrowError(ToolError);
      expect(() => resolveWorkspaceRoot(join(linked, 'nested'))).toThrowError(ToolError);
      const tools = new WorkspaceTools(swapped);
      rmSync(swapped, { recursive: true, force: true });
      symlinkSync(target, swapped, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(tools.listFiles()).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reads, searches, atomically writes, and detects hash conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-tools-'));
    const sibling = `${root}-other`;
    mkdirSync(join(root, 'src'));
    mkdirSync(sibling);
    writeFileSync(join(root, 'src', 'note.txt'), 'alpha\nbeta\n');
    writeFileSync(join(sibling, 'outside.txt'), 'outside');
    mkdirSync(join(root, 'Folder With Spaces'));
    writeFileSync(join(root, 'Folder With Spaces', 'Case.txt'), 'case-safe');
    const tools = new WorkspaceTools(root);
    const read = await tools.readFile('src/note.txt');
    const absoluteRead = await tools.readFile(join(root, 'src', 'note.txt'));
    expect(read.content).toContain('alpha');
    expect(read.hash).toHaveLength(64);
    expect(absoluteRead).toEqual(read);
    if (process.platform === 'win32')
      expect(
        (
          await tools.readFile(
            join(root, 'Folder With Spaces', 'Case.txt').toUpperCase().replaceAll('\\', '/'),
          )
        ).content,
      ).toBe('case-safe');
    expect((await tools.searchText('.', 'beta')).matches).toHaveLength(1);
    const written = await tools.writeFile('src/new.txt', 'created');
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('created');
    await expect(tools.writeFile('src/new.txt', 'unconditional')).rejects.toMatchObject({
      code: 'EXPECTED_HASH_REQUIRED',
    });
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('created');
    await expect(tools.writeFile('src/new.txt', 'changed', 'wrong')).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
    });
    const current = await tools.readFile(join(root, 'src', 'new.txt'));
    await tools.writeFile(join(root, 'src', 'new.txt'), 'changed', current.hash);
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('changed');
    await expect(tools.replaceText('src/new.txt', 'changed', 'replaced')).rejects.toMatchObject({
      code: 'EXPECTED_HASH_REQUIRED',
    });
    const changed = await tools.readFile('src/new.txt');
    await tools.replaceText('src/new.txt', 'changed', 'replaced', changed.hash);
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('replaced');
    expect(written.bytes).toBe(7);
    await expect(tools.readFile('../outside.txt')).rejects.toBeInstanceOf(ToolError);
    await expect(tools.readFile(join(sibling, 'outside.txt'))).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
    });
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  });

  it('keeps the fixed root when context suggests another folder and returns safe path recovery errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-path-contract-'));
    try {
      mkdirSync(join(root, 'ProjectA'), { recursive: true });
      mkdirSync(join(root, 'ProjectB'), { recursive: true });
      writeFileSync(join(root, 'ProjectA', '같은 이름.txt'), 'A');
      writeFileSync(join(root, 'ProjectB', '같은 이름.txt'), 'B');
      const tools = new WorkspaceTools(root, {}, [
        { commandId: 'node-version', executable: process.execPath },
      ]);
      const target = join(root, 'ProjectA', '같은 이름.txt');
      const before = await tools.readFile('ProjectA/같은 이름.txt');
      expect(await tools.readFile(target)).toEqual(before);
      await tools.writeFile(target, '수정됨', before.hash);
      expect(readFileSync(target, 'utf8')).toBe('수정됨');
      expect(readFileSync(join(root, 'ProjectB', '같은 이름.txt'), 'utf8')).toBe('B');
      expect(await tools.listFiles('.')).toHaveProperty('items');
      await expect(
        executeWorkspaceTool(tools, new Set(['read_file']), 'read_file', { path: 'missing.txt' }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        executeWorkspaceTool(tools, new Set(['read_file']), 'read_file', {
          path: 'ProjectA/같은 이름.txt/child',
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      try {
        await executeWorkspaceTool(tools, new Set(['read_file']), 'read_file', {
          path: 'missing.txt',
        });
      } catch (error) {
        expect((error as Error).message).not.toContain('list_files');
        expect((error as Error).message).not.toContain(root);
      }
      for (const input of ['"ProjectA/같은 이름.txt"', 'file:///ProjectA/같은 이름.txt', '~/note'])
        await expect(tools.readFile(input)).rejects.toMatchObject({
          code: 'PATH_FORMAT_UNSUPPORTED',
        });
      if (process.platform === 'win32') {
        for (const input of ['C:note.txt', '\\ProjectA\\같은 이름.txt']) {
          await expect(tools.readFile(input)).rejects.toMatchObject({ code: 'AMBIGUOUS_PATH' });
          await expect(
            tools.runCommand('node-version', ['--version'], input),
          ).rejects.toMatchObject({
            code: 'AMBIGUOUS_PATH',
          });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers usable recovery for scoped/full paths only when listing is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-path-recovery-'));
    writeFileSync(join(root, 'file.txt'), 'unchanged');
    try {
      for (const fullAccess of [false, true]) {
        for (const canList of [false, true]) {
          const tools = new WorkspaceTools(fullAccess ? null : root);
          const enabled = new Set(canList ? ['read_file', 'list_files'] : ['read_file']);
          for (const path of ['missing.txt', 'file.txt/child']) {
            const error = await executeWorkspaceTool(tools, enabled, 'read_file', {
              path: fullAccess ? join(root, path) : path,
            }).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(ToolError);
            expect(error).toMatchObject({ code: 'ENOENT' });
            const message = (error as Error).message;
            expect(message).not.toContain(root);
            if (canList) {
              expect(message).toContain('list_files');
              expect(message).toContain(fullAccess ? '절대 경로' : '"."');
              if (fullAccess) expect(message).not.toContain('"."');
              const result = await executeWorkspaceTool(tools, enabled, 'list_files', {
                path: fullAccess ? root : '.',
              });
              expect(result).toMatchObject({
                items: expect.arrayContaining([expect.objectContaining({ type: 'file' })]),
              });
            } else {
              expect(message).not.toContain('list_files');
              expect(message).toContain('다시 확인');
            }
          }
          const read = vi
            .spyOn(tools, 'readFile')
            .mockRejectedValueOnce(
              Object.assign(new Error(`unsafe path: ${root}`), { code: 'EIO', path: root }),
            );
          const error = await executeWorkspaceTool(tools, enabled, 'read_file', {
            path: fullAccess ? join(root, 'file.txt') : 'file.txt',
          }).catch((error: unknown) => error);
          expect(error).toMatchObject({ code: 'PATH_ERROR' });
          expect((error as Error).message).toContain(tools.pathRecoveryHint(canList));
          expect((error as Error).message).not.toContain(root);
          read.mockRestore();
        }
      }
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('unchanged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires explicit command allowlisting and does not use a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-command-'));
    const outside = mkdtempSync(join(tmpdir(), 'mcpex-command-outside-'));
    const tools = new WorkspaceTools(root, {}, [
      { commandId: 'node-version', executable: process.execPath },
    ]);
    await expect(tools.runCommand('not-allowed', [])).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
    });
    const result = await tools.runCommand(
      'node-version',
      ['-e', 'process.stdout.write("ok")'],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    await expect(tools.runCommand('node-version', ['--version'], outside)).rejects.toMatchObject({
      code: 'PATH_FORBIDDEN',
    });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('passes only a minimal environment to allowlisted commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-command-env-'));
    const tools = new WorkspaceTools(root, {}, [
      { commandId: 'inspect-env', executable: process.execPath },
    ]);
    const secretName = 'MCPEX_TEST_PARENT_SECRET';
    const previous = process.env[secretName];
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env[secretName] = 'must-not-leak';
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
      const result = await tools.runCommand('inspect-env', [
        '-e',
        `process.stdout.write(JSON.stringify({secret:process.env.${secretName}??null,keys:Object.keys(process.env)}))`,
      ]);
      const environment = JSON.parse(result.stdout) as { secret: string | null; keys: string[] };
      expect(environment.secret).toBeNull();
      expect(environment.keys.map((key) => key.toUpperCase())).not.toContain(secretName);
      expect(environment.keys.map((key) => key.toUpperCase())).not.toContain('NODE_OPTIONS');
      expect(environment.keys.map((key) => key.toUpperCase())).toContain('PATH');
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects disabled tools and invalid tool arguments at the dispatcher boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-policy-'));
    writeFileSync(join(root, 'note.txt'), 'safe');
    const tools = new WorkspaceTools(root);
    await expect(
      executeWorkspaceTool(tools, new Set(['read_file']), 'write_file', {
        path: 'note.txt',
        content: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
    await expect(
      executeWorkspaceTool(tools, new Set(['read_file']), 'read_file', { path: 42 }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      executeWorkspaceTool(tools, new Set(['write_file']), 'write_file', {
        path: 'note.txt',
        content: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'EXPECTED_HASH_REQUIRED' });
    await expect(
      executeWorkspaceTool(tools, new Set(['replace_text']), 'replace_text', {
        path: 'note.txt',
        oldText: 'safe',
        newText: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('safe');
    rmSync(root, { recursive: true, force: true });
  });

  it('uses absolute paths across roots for full access while preserving tool permissions', async () => {
    const first = mkdtempSync(join(tmpdir(), 'mcpex-full-first-'));
    const second = mkdtempSync(join(tmpdir(), 'mcpex-full-second-'));
    writeFileSync(join(first, 'one.txt'), 'one');
    writeFileSync(join(second, 'two.txt'), 'two');
    const tools = new WorkspaceTools(null);
    try {
      expect((await tools.readFile(join(first, 'one.txt'))).content).toBe('one');
      expect((await tools.readFile(join(second, 'two.txt'))).content).toBe('two');
      await expect(tools.readFile('relative.txt')).rejects.toMatchObject({
        code: 'PATH_FORBIDDEN',
      });
      await expect(
        executeWorkspaceTool(tools, new Set(['read_file']), 'write_file', {
          path: join(second, 'new.txt'),
          content: 'blocked',
        }),
      ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
      await executeWorkspaceTool(tools, new Set(['write_file']), 'write_file', {
        path: join(second, 'new.txt'),
        content: 'created',
      });
      expect(readFileSync(join(second, 'new.txt'), 'utf8')).toBe('created');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('publishes and executes the absolute path contract for full access tools', async () => {
    const commands = [{ commandId: 'node', executable: process.execPath, label: 'Node.js' }];
    const scoped = getWorkspaceToolDefinitions(false, commands);
    const full = getWorkspaceToolDefinitions(true, commands);
    const required = (definitions: typeof full, name: string) =>
      definitions.find((tool) => tool.name === name)?.inputSchema.required;
    const commandId = full.find((tool) => tool.name === 'run_command')?.inputSchema.properties
      ?.commandId as { enum?: string[]; description?: string };
    expect(getWorkspaceToolDefinitions().some((tool) => tool.name === 'run_command')).toBe(false);
    expect(required(scoped, 'list_files')).toBeUndefined();
    expect(required(scoped, 'run_command')).toEqual(['commandId', 'args']);
    expect(scoped.find((tool) => tool.name === 'list_files')?.description).toContain(
      '범위 내부 절대 경로',
    );
    expect(required(full, 'list_files')).toContain('path');
    expect(required(full, 'run_command')).toContain('cwd');
    expect(full.find((tool) => tool.name === 'list_files')?.description).toContain('절대 경로');
    expect(full.find((tool) => tool.name === 'run_command')?.description).toContain('절대 경로');
    expect(full.find((tool) => tool.name === 'run_command')?.description).toContain(
      'node (Node.js)',
    );
    expect(commandId.enum).toEqual(['node']);
    expect(commandId.description).not.toContain(process.execPath);

    const root = mkdtempSync(join(tmpdir(), 'mcpex-full-schema-'));
    const tools = new WorkspaceTools(null, {}, commands);
    try {
      const listed = await executeWorkspaceTool(tools, new Set(['list_files']), 'list_files', {
        path: root,
      });
      expect(listed).toMatchObject({ items: [] });
      const command = await executeWorkspaceTool(tools, new Set(['run_command']), 'run_command', {
        commandId: 'node',
        args: ['--version'],
        cwd: root,
      });
      expect(command).toMatchObject({ commandId: 'node', exitCode: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes full access against every scoped workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-full-lock-'));
    const queue = new RunQueue(2, 10);
    const events: string[] = [];
    let release!: () => void;
    const full = queue.submit(
      () =>
        new Promise<void>((resolve) => {
          events.push('full-start');
          release = () => {
            events.push('full-end');
            resolve();
          };
        }),
      FULL_ACCESS_WORKSPACE,
    );
    const scoped = queue.submit(async () => events.push('scoped'), root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['full-start']);
    release();
    await Promise.all([full, scoped]);
    expect(events).toEqual(['full-start', 'full-end', 'scoped']);
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes overlapping workspaces while allowing independent workspaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-queue-'));
    const queue = new RunQueue(2, 10);
    const events: string[] = [];
    const first = queue.submit(async () => {
      events.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push('first-end');
      return 1;
    }, root);
    const second = queue.submit(async () => {
      events.push('second-start');
      events.push('second-end');
      return 2;
    }, root);
    const independent = queue.submit(
      async () => {
        events.push('independent');
        return 3;
      },
      join(root, 'other'),
    );
    await Promise.all([first, second, independent]);
    expect(events.indexOf('first-end')).toBeLessThan(events.indexOf('second-start'));
    expect(events).toContain('independent');
    rmSync(root, { recursive: true, force: true });
  });

  it('treats dot-dot-prefixed children as overlapping workspace paths', async () => {
    const root = join(tmpdir(), 'mcpex-lock-boundary-root');
    const child = join(root, 'child');
    const dotDotChild = join(root, '..cache');
    const independent = join(tmpdir(), 'mcpex-lock-boundary-independent');
    const locks = new WorkspaceLockManager();
    let release!: () => void;
    const parentRun = locks.run(root, () => new Promise<void>((resolve) => (release = resolve)));
    expect(locks.canRun(child)).toBe(false);
    expect(locks.canRun(dotDotChild)).toBe(false);
    expect(locks.canRun(independent)).toBe(true);
    release();
    await parentRun;

    const childRun = locks.run(child, () => new Promise<void>((resolve) => (release = resolve)));
    expect(locks.canRun(root)).toBe(false);
    release();
    await childRun;
  });

  it('does not count a workspace-lock waiter against global concurrency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-queue-slot-'));
    const queue = new RunQueue(2, 10);
    let release!: () => void;
    let independentStarted = false;
    const first = queue.submit(() => new Promise<void>((resolve) => (release = resolve)), root);
    const blocked = queue.submit(async () => undefined, root);
    const independent = queue.submit(
      async () => {
        independentStarted = true;
      },
      join(tmpdir(), 'mcpex-independent-workspace'),
    );
    await independent;
    expect(independentStarted).toBe(true);
    release();
    await Promise.all([first, blocked]);
    rmSync(root, { recursive: true, force: true });
  });

  it('applies deadlines while queued and distinguishes caller cancellation', async () => {
    const queue = new RunQueue(1, 10);
    let release!: () => void;
    const first = queue.submit(() => new Promise<void>((resolve) => (release = resolve)));
    const expired = queue.submit(async () => 'late', undefined, undefined, {
      deadlineAt: Date.now() + 20,
    });
    await expect(expired).rejects.toMatchObject({ code: 'DEADLINE' });
    release();
    await first;

    const cancellationQueue = new RunQueue(1, 10);
    const controller = new AbortController();
    const original = Object.assign(new Error('cancelled after work'), {
      executionTelemetry: { observations: { changes: ['note.txt'] } },
    });
    const cancelled = cancellationQueue.submit(
      (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(original), { once: true }),
        ),
      undefined,
      controller.signal,
    );
    controller.abort();
    const cancellation = await cancelled.catch(
      (error: unknown) => error as Error & { code: string; cause?: unknown },
    );
    expect(cancellation).toMatchObject({ code: 'CANCELLED' });
    expect(cancellation.cause).toBe(original);
  });
  it('gives a queued job its full execution budget and distinguishes both expiry stages', async () => {
    const queue = new RunQueue(1, 10);
    let release!: () => void;
    const first = queue.submit(() => new Promise<void>((resolve) => (release = resolve)));
    const completed = queue.submit(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 35)),
      undefined,
      undefined,
      { deadlineAt: Date.now() + 1000, executionTimeoutMs: 70 },
    );
    await new Promise((resolve) => setTimeout(resolve, 45));
    release();
    await first;
    await expect(completed).resolves.toBe('ok');

    let releaseBlocked!: () => void;
    const blocked = queue.submit(() => new Promise<void>((resolve) => (releaseBlocked = resolve)));
    await expect(
      queue.submit(async () => 'late', undefined, undefined, {
        deadlineAt: Date.now() + 20,
        executionTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    const controller = new AbortController();
    const executing = new RunQueue(1).submit(
      (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      undefined,
      controller.signal,
      { deadlineAt: Date.now() + 1000, executionTimeoutMs: 20 },
    );
    await expect(executing).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    releaseBlocked();
    await blocked;
  });

  it('enforces shared provider and resource-group concurrency limits', async () => {
    const queue = new RunQueue(2, 10);
    queue.setProviderLimit('provider-a', 2);
    queue.setProviderLimit('provider-b', 2);
    queue.setResourceGroupLimit('shared-gpu', 1);
    let active = 0;
    let maximumActive = 0;
    const task = (provider: string) =>
      queue.submit(
        async () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active--;
        },
        undefined,
        undefined,
        { provider, resourceGroup: 'shared-gpu' },
      );
    await Promise.all([task('provider-a'), task('provider-b')]);
    expect(maximumActive).toBe(1);
  });

  it('re-enters the model with tool results and enforces the tool-call loop', async () => {
    let calls = 0;
    const result = await runToolLoop({
      initialMessages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
      maxTurns: 3,
      maxToolCalls: 2,
      generate: async (messages): Promise<GenerateResult> => {
        calls++;
        if (calls === 1)
          return {
            text: '',
            toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'note.txt' } }],
            finishReason: 'tool_calls',
            usage: null,
            providerRequestId: null,
          };
        expect(messages.at(-1)?.role).toBe('tool');
        expect(messages.at(-1)?.content).toContain('EXPECTED_HASH_REQUIRED');
        return {
          text: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
          providerRequestId: null,
        };
      },
      execute: async () => {
        throw new ToolError('EXPECTED_HASH_REQUIRED', 'read before write');
      },
    });
    expect(result.text).toBe('done');
    expect(result.toolCalls).toBe(1);
    expect(result.messages.at(-1)?.content).toBe('done');
  });
  it('distinguishes model-turn and tool-call limits from elapsed-time expiry', async () => {
    const generate = async (): Promise<GenerateResult> => ({
      text: '',
      toolCalls: [{ id: 'one', name: 'read_file', arguments: { path: 'note.txt' } }],
      finishReason: 'tool_calls',
      usage: null,
      providerRequestId: null,
    });
    const base = {
      initialMessages: [{ role: 'user' as const, content: 'inspect' }],
      tools: [{ name: 'read_file', inputSchema: { type: 'object' as const } }],
      generate,
      execute: async () => 'ok',
    };
    await expect(runToolLoop({ ...base, maxTurns: 1, maxToolCalls: 1 })).rejects.toMatchObject({
      code: 'MODEL_TURN_LIMIT',
    });
    await expect(runToolLoop({ ...base, maxTurns: 2, maxToolCalls: 0 })).rejects.toMatchObject({
      code: 'TOOL_CALL_LIMIT',
    });
  });

  it('validates caller workspaces and connects them to UI and MCP tool runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-server-tools-'));
    const linkedTarget = mkdtempSync(join(tmpdir(), 'mcpex-server-linked-'));
    const linkedWorkspace = join(root, 'linked');
    symlinkSync(linkedTarget, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(root, 'note.txt'), 'from workspace');
    const mock = await toolProviderMock(root);
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p4-server-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: { name: 'Tool Mock', adapter: 'openai-chat', baseUrl: mock.url },
        })
      ).body,
    ) as { id: string };
    const model = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'mock' },
        })
      ).body,
    ) as { id: string };
    const agent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'Tool Agent',
            toolName: 'tool_agent',
            config: {
              modelRef: model.id,
              userPromptTemplate: '{{input.task}}',
              runtime: {
                mode: 'tools',
                tools: ['read_file', 'write_file'],
                maxModelTurns: 3,
                maxToolCalls: 2,
                timeoutMs: 250,
                workspacePolicy: { mode: 'caller', allowedRoots: [root] },
              },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const missing = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: { task: 'inspect note' } },
    });
    expect(missing.statusCode).toBe(422);
    expect(JSON.parse(missing.body)).toMatchObject({
      error: { code: 'WORKSPACE_REQUIRED' },
    });
    const outside = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: {
        expectedRevision: agent.draftRevision,
        input: { task: 'inspect note' },
        workspace: tmpdir(),
      },
    });
    expect(outside.statusCode).toBe(403);
    expect(JSON.parse(outside.body)).toMatchObject({
      error: { code: 'WORKSPACE_NOT_ALLOWED' },
    });
    const linked = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: {
        expectedRevision: agent.draftRevision,
        input: { task: 'inspect linked workspace' },
        workspace: linkedWorkspace,
      },
    });
    expect(linked.statusCode).toBe(403);
    expect(JSON.parse(linked.body)).toMatchObject({
      error: { code: 'WORKSPACE_NOT_ALLOWED' },
    });
    const result = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: {
        expectedRevision: agent.draftRevision,
        input: { task: 'inspect note' },
        workspace: root,
      },
    });
    expect(result.statusCode, result.body).toBe(202);
    const completed = await waitForRun(
      service.app,
      headers,
      (JSON.parse(result.body) as { runId: string }).runId,
    );
    expect(completed.output).toMatchObject({ value: 'tool-loop-complete' });
    expect(completed.startedAt).toEqual(expect.any(String));
    expect(completed.configSnapshot).toMatchObject({
      execution: { workspace: root, workspaceSource: 'caller' },
    });
    const events = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${(JSON.parse(result.body) as { runId: string }).runId}/events`,
      headers,
    });
    expect(events.body).toContain('event: tool.started');
    expect(events.body).toContain('event: tool.finished');
    const fullAgent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'Full schema agent',
            toolName: 'full_schema_agent',
            config: {
              modelRef: model.id,
              userPromptTemplate: '{{input.task}}',
              runtime: {
                mode: 'tools',
                tools: ['list_files'],
                maxModelTurns: 2,
                maxToolCalls: 1,
                workspacePolicy: { mode: 'full', allowedRoots: [] },
              },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const fullResult = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${fullAgent.id}/test-runs`,
      headers,
      payload: { expectedRevision: fullAgent.draftRevision, input: { task: 'full schema' } },
    });
    expect(fullResult.statusCode).toBe(202);
    const fullCompleted = await waitForRun(
      service.app,
      headers,
      (JSON.parse(fullResult.body) as { runId: string }).runId,
    );
    expect(fullCompleted.output).toMatchObject({ value: 'full-schema-complete' });
    expect(fullCompleted.configSnapshot).toMatchObject({
      execution: { workspaceSource: 'full' },
    });
    await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/apply`,
      headers,
      payload: { expectedRevision: agent.draftRevision },
    });
    await service.app.inject({
      method: 'PUT',
      url: `/api/v1/agents/${agent.id}/activation`,
      headers,
      payload: { enabled: true },
    });
    await service.app.listen({ host: '127.0.0.1', port: 0 });
    const address = service.app.server.address();
    if (!address || typeof address === 'string') throw new Error('app failed');
    const client = new Client({ name: 'p4-caller-client', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        authProvider: { token: async () => getLocalAccessToken(dir) },
      }),
    );
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === 'tool_agent')?._meta?.[
        'io.mcpex/bridgeTimeoutMs'
      ],
    ).toBe(15250);
    const mcpMissing = await client.callTool({
      name: 'tool_agent',
      arguments: { task: 'inspect note' },
    });
    expect(JSON.stringify(mcpMissing)).toContain('WORKSPACE_REQUIRED');
    expect(mcpMissing.structuredContent).toMatchObject({
      contractVersion: '1',
      runId: null,
      status: 'failed',
      outcome: 'failed',
      observations: { toolCalls: 0, changes: [], checks: [], truncated: false },
      usage: null,
      error: { code: 'WORKSPACE_REQUIRED' },
    });
    const mcpResult = await client.callTool({
      name: 'tool_agent',
      arguments: { task: 'inspect note' },
      _meta: { 'io.mcpex/workspace': root },
    });
    expect(JSON.stringify(mcpResult)).toContain('tool-loop-complete');
    const structured = mcpResult.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      observations: {
        toolCalls: 2,
        changes: [{ tool: 'write_file', path: 'note.txt' }],
        checks: [],
        truncated: false,
      },
      usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 },
    });
    expect(structured.durationMs).toEqual(expect.any(Number));
    const timedOut = await client.callTool({
      name: 'tool_agent',
      arguments: { task: 'timeout after write' },
      _meta: { 'io.mcpex/workspace': root },
    });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      status: 'timed_out',
      outcome: 'failed',
      observations: {
        toolCalls: 2,
        changes: [{ tool: 'write_file', path: 'note.txt' }],
        truncated: false,
      },
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      error: { code: 'DEADLINE' },
    });
    await client.close();
    await service.close();
    mock.server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(linkedTarget, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
