import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { executeWorkspaceTool, WorkspaceTools, ToolError } from '@mcpex/tools';
import { RunQueue, runToolLoop } from '@mcpex/runtime';
import type { GenerateResult } from '@mcpex/providers';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

async function toolProviderMock(): Promise<{ server: Server; url: string }> {
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
        tools?: Array<{ function?: { name?: string } }>;
        messages: Array<{ role: string; content: string }>;
      };
      const toolMessages = body.messages.filter((message) => message.role === 'tool');
      const shouldTimeout = body.messages.some(
        (message) => message.role === 'user' && message.content.includes('timeout'),
      );
      response.setHeader('content-type', 'application/json');
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
  it('reads, searches, atomically writes, and detects hash conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-tools-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'note.txt'), 'alpha\nbeta\n');
    const tools = new WorkspaceTools(root);
    const read = await tools.readFile('src/note.txt');
    expect(read.content).toContain('alpha');
    expect(read.hash).toHaveLength(64);
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
    const current = await tools.readFile('src/new.txt');
    await tools.writeFile('src/new.txt', 'changed', current.hash);
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('changed');
    await expect(tools.replaceText('src/new.txt', 'changed', 'replaced')).rejects.toMatchObject({
      code: 'EXPECTED_HASH_REQUIRED',
    });
    const changed = await tools.readFile('src/new.txt');
    await tools.replaceText('src/new.txt', 'changed', 'replaced', changed.hash);
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('replaced');
    expect(written.bytes).toBe(7);
    await expect(tools.readFile('../outside.txt')).rejects.toBeInstanceOf(ToolError);
    rmSync(root, { recursive: true, force: true });
  });

  it('requires explicit command allowlisting and does not use a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-command-'));
    const tools = new WorkspaceTools(root, {}, [
      { commandId: 'node-version', executable: process.execPath },
    ]);
    await expect(tools.runCommand('not-allowed', [])).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
    });
    const result = await tools.runCommand('node-version', ['-e', 'process.stdout.write("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    rmSync(root, { recursive: true, force: true });
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

  it('validates caller workspaces and connects them to UI and MCP tool runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-server-tools-'));
    writeFileSync(join(root, 'note.txt'), 'from workspace');
    const mock = await toolProviderMock();
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
    expect(result.statusCode).toBe(202);
    const completed = await waitForRun(
      service.app,
      headers,
      (JSON.parse(result.body) as { runId: string }).runId,
    );
    expect(completed.output).toMatchObject({ value: 'tool-loop-complete' });
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
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
