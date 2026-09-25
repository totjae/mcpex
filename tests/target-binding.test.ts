import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { Storage } from '@mcpex/storage';
import { executeTargetTool, WorkspaceTools } from '@mcpex/tools';
import { waitForRun } from './run-helpers.js';

describe('execution-bound target files', () => {
  it('enforces IDs, access, hashes, and exclusive new-file creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-target-tool-'));
    try {
      writeFileSync(join(root, 'source.txt'), 'before');
      const tools = new WorkspaceTools(root);
      const targets = [
        { id: 'source', path: join(root, 'source.txt'), access: 'readwrite' as const },
        { id: 'output', path: join(root, 'output.txt'), access: 'write' as const },
      ];
      const enabled = new Set(['read_target', 'write_target', 'replace_target']);
      const read = (await executeTargetTool(tools, targets, enabled, 'read_target', {
        targetId: 'source',
      })) as { hash: string; targetId: string; path?: string };
      expect(read).toMatchObject({ targetId: 'source' });
      expect(read.path).toBeUndefined();
      await expect(
        executeTargetTool(tools, targets, enabled, 'read_target', { targetId: 'output' }),
      ).rejects.toMatchObject({ code: 'TARGET_ACCESS_DENIED' });
      await expect(
        executeTargetTool(tools, targets, enabled, 'read_file', { path: 'source.txt' }),
      ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
      await expect(
        executeTargetTool(tools, targets, enabled, 'read_target', { targetId: 'missing' }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
      await expect(
        executeTargetTool(tools, targets, enabled, 'write_target', {
          targetId: 'source',
          content: 'after',
        }),
      ).rejects.toMatchObject({ code: 'EXPECTED_HASH_REQUIRED' });
      await executeTargetTool(tools, targets, enabled, 'write_target', {
        targetId: 'source',
        content: 'after',
        expectedHash: read.hash,
      });
      expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('after');
      await expect(
        executeTargetTool(tools, targets, enabled, 'write_target', {
          targetId: 'source',
          content: 'stale',
          expectedHash: read.hash,
        }),
      ).rejects.toMatchObject({ code: 'HASH_CONFLICT' });
      await executeTargetTool(tools, targets, enabled, 'write_target', {
        targetId: 'output',
        content: 'new',
      });
      await expect(
        executeTargetTool(tools, targets, enabled, 'write_target', {
          targetId: 'output',
          content: 'overwrite',
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(readFileSync(join(root, 'output.txt'), 'utf8')).toBe('new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds a UI run before model use and never exposes the target path to its model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-target-run-'));
    const work = join(root, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'input.txt'), 'chosen');
    const requests: Array<{
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
    }> = [];
    const mock = createHttpServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const toolMessages = body.messages.filter(
          (message: { role: string }) => message.role === 'tool',
        );
        const task = body.messages.find((message: { role: string }) => message.role === 'user')
          ?.content as string;
        const creating = task.startsWith('create');
        const partial = task.startsWith('create-partial');
        const replacing = task.startsWith('replace');
        if (partial && toolMessages.length) {
          response.statusCode = 500;
          response.end('mock failure after file creation');
          return;
        }
        const call = creating
          ? {
              name: 'write_target',
              arguments: JSON.stringify({ targetId: 'output', content: 'created' }),
            }
          : replacing && toolMessages.length === 1
            ? {
                name: 'replace_target',
                arguments: JSON.stringify({
                  targetId: 'input',
                  oldText: 'chosen',
                  newText: 'updated',
                  expectedHash: JSON.parse(toolMessages[0].content).hash,
                }),
              }
            : { name: 'read_target', arguments: '{"targetId":"input"}' };
        const done = toolMessages.length >= (replacing ? 2 : 1);
        const message = done
          ? { content: 'done' }
          : { content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: call }] };
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message, finish_reason: done ? 'stop' : 'tool_calls' }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const service = await createServer(root);
    try {
      const address = mock.address();
      if (!address || typeof address === 'string') throw new Error('No mock address');
      const headers = { authorization: `Bearer ${getLocalAccessToken(root)}` };
      const post = async (url: string, payload: object) =>
        (await service.app.inject({ method: 'POST', url, headers, payload })).json();
      const provider = await post('/api/v1/providers', {
        name: 'Target mock',
        adapter: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const model = await post('/api/v1/models', { providerId: provider.id, modelId: 'mock' });
      const templates = (
        await service.app.inject({ method: 'GET', url: '/api/v1/templates', headers })
      ).json().items;
      const config = templates.find((item: { name: string }) => item.name === '코드 구현').config;
      const agent = await post('/api/v1/agents', {
        displayName: 'Target agent',
        toolName: 'target_agent',
        config: {
          ...config,
          modelRef: model.id,
          userPromptTemplate: '{{input.task}} {{input.targets}}',
          runtime: { ...config.runtime, workspacePolicy: { mode: 'fixed', allowedRoots: [work] } },
        },
      });
      const input = { task: 'read', targets: [{ id: 'input', path: 'input.txt', access: 'read' }] };
      const preview = await post(`/api/v1/agents/${agent.id}/preview`, { input });
      expect(JSON.stringify(preview)).not.toContain(work);
      expect(JSON.stringify(preview)).not.toContain('input.txt');
      const submitted = await post(`/api/v1/agents/${agent.id}/test-runs`, {
        expectedRevision: agent.draftRevision,
        input,
      });
      const run = await waitForRun(service.app, headers, submitted.runId);
      expect(run.status).toBe('completed');
      expect(run).toMatchObject({ targetChanges: [] });
      expect(requests[0].tools.map((tool) => tool.function.name)).toEqual(['read_target']);
      expect(JSON.stringify(requests)).not.toContain(work);
      expect(JSON.stringify(requests)).not.toContain('input.txt');
      expect(JSON.stringify(requests)).toContain('chosen');
      let expiredRunId = '';
      for (const [task, path, status] of [
        ['create', 'created.txt', 'completed'],
        ['create-partial', 'partial.txt', 'failed'],
      ] as const) {
        const created = await post(`/api/v1/agents/${agent.id}/test-runs`, {
          expectedRevision: agent.draftRevision,
          input: { task, targets: [{ id: 'output', path, access: 'write' }] },
        });
        const changed = await waitForRun(service.app, headers, created.runId);
        if (task === 'create') expiredRunId = created.runId;
        expect(changed.status).toBe(status);
        expect(changed).toMatchObject({
          targetChanges: [{ targetId: 'output', tool: 'write_target' }],
        });
        expect(readFileSync(join(work, path), 'utf8')).toBe('created');
        const refreshed = await service.app.inject({
          method: 'GET',
          url: `/api/v1/runs/${created.runId}`,
          headers,
        });
        expect(refreshed.json().targetChanges).toEqual([
          { targetId: 'output', tool: 'write_target' },
        ]);
      }
      const replaced = await post(`/api/v1/agents/${agent.id}/test-runs`, {
        expectedRevision: agent.draftRevision,
        input: {
          task: 'replace',
          targets: [{ id: 'input', path: 'input.txt', access: 'readwrite' }],
        },
      });
      const replacedRun = await waitForRun(service.app, headers, replaced.runId);
      expect(replacedRun.status).toBe('completed');
      expect(replacedRun).toMatchObject({
        targetChanges: [{ targetId: 'input', tool: 'replace_target' }],
      });
      expect(readFileSync(join(work, 'input.txt'), 'utf8')).toBe('updated');
      const history = await service.app.inject({ method: 'GET', url: '/api/v1/runs', headers });
      expect(
        history
          .json()
          .items.filter((item: { targetChanges?: unknown[] }) => item.targetChanges?.length),
      ).toHaveLength(3);
      const invalid = await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/test-runs`,
        headers,
        payload: {
          expectedRevision: agent.draftRevision,
          input: { task: 'read', targets: [{ id: 'bad', path: '../outside.txt', access: 'read' }] },
        },
      });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
      expect(invalid.body).not.toContain(work);
      const duplicate = await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/test-runs`,
        headers,
        payload: {
          expectedRevision: agent.draftRevision,
          input: {
            task: 'read',
            targets: [
              { id: 'first', path: 'input.txt', access: 'read' },
              { id: 'second', path: join(work, 'input.txt'), access: 'read' },
            ],
          },
        },
      });
      expect(duplicate.json().error.code).toBe('DUPLICATE_TARGET_PATH');
      const empty = await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/test-runs`,
        headers,
        payload: { expectedRevision: agent.draftRevision, input: { task: 'read', targets: [] } },
      });
      expect(empty.statusCode).toBe(400);
      await post(`/api/v1/agents/${agent.id}/apply`, { expectedRevision: agent.draftRevision });
      await service.app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${agent.id}/activation`,
        headers,
        payload: { enabled: true },
      });
      await service.app.listen({ host: '127.0.0.1', port: 0 });
      const serverAddress = service.app.server.address();
      if (!serverAddress || typeof serverAddress === 'string') throw new Error('No server address');
      const client = new Client({ name: 'target-test-client', version: '0.1.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverAddress.port}/mcp`), {
            authProvider: { token: async () => getLocalAccessToken(root) },
          }),
        );
        const listed = await client.listTools();
        expect(
          listed.tools.find((tool) => tool.name === 'target_agent')?.inputSchema.properties,
        ).toHaveProperty('targets');
        const mcpResult = await client.callTool({ name: 'target_agent', arguments: input });
        expect(mcpResult.isError).not.toBe(true);
        expect(mcpResult.structuredContent).toMatchObject({
          status: 'completed',
          outcome: 'succeeded',
        });
        expect(JSON.stringify(mcpResult)).not.toContain(work);
        expect(JSON.stringify(mcpResult)).not.toContain('input.txt');
      } finally {
        await client.close();
      }
      await service.close();
      const storage = new Storage(root);
      try {
        storage.db
          .prepare('UPDATE runs SET finished_at=? WHERE id=?')
          .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), expiredRunId);
      } finally {
        storage.close();
      }
      const restarted = await createServer(root);
      try {
        const settings = await restarted.app.inject({
          method: 'PATCH',
          url: '/api/v1/settings',
          headers,
          payload: { retentionDays: 1, globalConcurrency: 2, maxPendingRuns: 50 },
        });
        expect(settings.json().purged.runs).toBe(1);
        const expired = await restarted.app.inject({
          method: 'GET',
          url: `/api/v1/runs/${expiredRunId}`,
          headers,
        });
        expect(expired.json().targetChanges).toBeNull();
      } finally {
        await restarted.close();
      }
    } finally {
      await service.close();
      await new Promise<void>((resolve) => mock.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
