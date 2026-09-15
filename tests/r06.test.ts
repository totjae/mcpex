import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

async function hangingProvider(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('R06 cancellation and deadlines', () => {
  it('propagates provider request timeouts and UI cancellation into terminal run states', async () => {
    const mock = await hangingProvider();
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r06-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Hanging provider',
            adapter: 'openai-chat',
            baseUrl: mock.url,
            requestTimeoutMs: 30,
          },
        })
      ).body,
    ) as { id: string };
    const discovered = await service.app.inject({
      method: 'POST',
      url: `/api/v1/providers/${provider.id}/discover-models`,
      headers,
    });
    expect(discovered.statusCode).toBe(504);
    expect(JSON.parse(discovered.body)).toMatchObject({
      error: { code: 'PROVIDER_TIMEOUT' },
    });
    const model = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'hang' },
        })
      ).body,
    ) as { id: string };
    const probed = await service.app.inject({
      method: 'POST',
      url: `/api/v1/models/${model.id}/probes`,
      headers,
      payload: { prompt: 'wait' },
    });
    expect(probed.statusCode).toBe(504);
    expect(JSON.parse(probed.body)).toMatchObject({
      error: { code: 'PROVIDER_TIMEOUT' },
    });
    const createAgent = async (toolName: string, timeoutMs: number) =>
      JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/agents',
            headers,
            payload: {
              displayName: toolName,
              toolName,
              config: {
                modelRef: model.id,
                userPromptTemplate: '{{input.task}}',
                runtime: { mode: 'response', timeoutMs },
              },
            },
          })
        ).body,
      ) as { id: string; draftRevision: number };

    const timedAgent = await createAgent('timed_agent', 1000);
    const timed = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${timedAgent.id}/test-runs`,
      headers,
      payload: { expectedRevision: timedAgent.draftRevision, input: { task: 'wait' } },
    });
    expect(timed.statusCode).toBe(202);
    const timedRun = await waitForRun(
      service.app,
      headers,
      (JSON.parse(timed.body) as { runId: string }).runId,
    );
    expect(timedRun).toMatchObject({ status: 'timed_out', error: { code: 'DEADLINE' } });
    const timedRuns = JSON.parse(
      (
        await service.app.inject({
          method: 'GET',
          url: `/api/v1/runs?agentId=${timedAgent.id}`,
          headers,
        })
      ).body,
    ) as { items: Array<{ status: string }> };
    expect(timedRuns.items[0]?.status).toBe('timed_out');

    const cancelProvider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Cancellable provider',
            adapter: 'openai-chat',
            baseUrl: mock.url,
            requestTimeoutMs: 5000,
          },
        })
      ).body,
    ) as { id: string };
    const cancelModel = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: cancelProvider.id, modelId: 'cancel' },
        })
      ).body,
    ) as { id: string };
    const cancelAgent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'cancel_agent',
            toolName: 'cancel_agent',
            config: {
              modelRef: cancelModel.id,
              userPromptTemplate: '{{input.task}}',
              runtime: { mode: 'response', timeoutMs: 5000 },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const pending = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${cancelAgent.id}/test-runs`,
      headers,
      payload: { expectedRevision: cancelAgent.draftRevision, input: { task: 'cancel' } },
    });
    expect(pending.statusCode).toBe(202);
    const runId = (JSON.parse(pending.body) as { runId: string }).runId;
    const cancel = await service.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers,
    });
    expect(cancel.statusCode).toBe(202);
    expect(JSON.parse(cancel.body).status).toBe('cancel_requested');
    const detail = await waitForRun(service.app, headers, runId);
    expect(detail).toMatchObject({
      status: 'cancelled',
      error: { code: 'CANCELLED' },
    });
    const cancelEvents = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events`,
      headers,
    });
    expect(cancelEvents.body).toContain('event: run.cancel_requested');
    expect(cancelEvents.body).toContain('"status":"cancelled"');

    await service.close();
    mock.server.closeAllConnections();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
});
