import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

describe('R11 immutable execution snapshots', () => {
  it('accepts UI runs asynchronously and keeps applied MCP metadata separate from the draft', async () => {
    const providerServer = createHttpServer((request, response) => {
      request.resume();
      request.on('end', () => {
        setTimeout(() => {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              choices: [{ message: { content: 'snapshot-complete' }, finish_reason: 'stop' }],
            }),
          );
        }, 150);
      });
    });
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === 'string') throw new Error('mock failed');

    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r11-'));
    const service = await createServer(dir);
    const localAccessToken = getLocalAccessToken(dir);
    const headers = { authorization: `Bearer ${localAccessToken}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Snapshot provider',
            adapter: 'openai-chat',
            baseUrl: `http://127.0.0.1:${providerAddress.port}`,
          },
        })
      ).body,
    ) as { id: string };
    const model = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'snapshot-model' },
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
            displayName: 'Snapshot agent',
            toolName: 'snapshot_agent',
            config: {
              modelRef: model.id,
              description: 'applied description',
              userPromptTemplate: '{{input.task}}',
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const applied = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/apply`,
      headers,
      payload: { expectedRevision: agent.draftRevision },
    });
    expect(applied.statusCode).toBe(201);
    await service.app.inject({
      method: 'PUT',
      url: `/api/v1/agents/${agent.id}/activation`,
      headers,
      payload: { enabled: true },
    });
    const changed = JSON.parse(
      (
        await service.app.inject({
          method: 'PATCH',
          url: `/api/v1/agents/${agent.id}`,
          headers,
          payload: {
            expectedRevision: agent.draftRevision,
            config: {
              modelRef: model.id,
              description: 'changed draft description',
              userPromptTemplate: '{{input.task}}',
            },
          },
        })
      ).body,
    ) as { draftRevision: number };

    const accepted = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: changed.draftRevision, input: { task: 'go' } },
    });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = JSON.parse(accepted.body) as { runId: string; status: string };
    expect(acceptedBody.status).toBe('queued');
    const run = await waitForRun(service.app, headers, acceptedBody.runId);
    expect(run).toMatchObject({
      status: 'completed',
      output: { value: 'snapshot-complete' },
      configSnapshot: {
        agent: { description: 'changed draft description' },
        model: { id: model.id, modelId: 'snapshot-model' },
        provider: { id: provider.id, name: 'Snapshot provider', hasCredential: false },
      },
    });

    await service.app.listen({ host: '127.0.0.1', port: 0 });
    const serviceAddress = service.app.server.address();
    if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('app failed');
    const client = new Client({ name: 'r11-client', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serviceAddress.port}/mcp`), {
        authProvider: { token: async () => localAccessToken },
      }),
    );
    const listed = await client.listTools();
    expect(listed.tools.find((tool) => tool.name === 'snapshot_agent')?.description).toBe(
      'applied description',
    );

    await client.close();
    await service.close();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
});
