import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { Storage } from '@mcpex/storage';

describe('P6 persisted run events and SSE', () => {
  it('streams ordered lifecycle events and resumes after a sequence cursor', async () => {
    const providerServer = createHttpServer((request, response) => {
      request.resume();
      request.on('end', () => {
        setTimeout(() => {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              choices: [{ message: { content: 'event-complete' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          );
        }, 100);
      });
    });
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === 'string') throw new Error('mock failed');

    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p6-events-'));
    const service = await createServer(dir);
    const localAccessToken = getLocalAccessToken(dir);
    const headers = { authorization: `Bearer ${localAccessToken}` };
    await service.app.listen({ host: '127.0.0.1', port: 0 });
    const serviceAddress = service.app.server.address();
    if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('service failed');
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Event provider',
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
          payload: { providerId: provider.id, modelId: 'event-model' },
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
            displayName: 'Event agent',
            toolName: 'event_agent',
            config: { modelRef: model.id, userPromptTemplate: '{{input.task}}' },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const accepted = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: { task: 'events' } },
    });
    const runId = (JSON.parse(accepted.body) as { runId: string }).runId;
    const baseUrl = `http://127.0.0.1:${serviceAddress.port}/api/v1/runs/${runId}/events`;
    const stream = await fetch(baseUrl, { headers });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const body = await stream.text();
    expect(body.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2', 'id: 3', 'id: 4', 'id: 5']);
    expect(body.match(/^event: .+$/gm)).toEqual([
      'event: run.queued',
      'event: run.started',
      'event: model.started',
      'event: model.finished',
      'event: run.finished',
    ]);
    expect(body).toContain('"usage":{"promptTokens":3,"completionTokens":2');

    const resumed = await fetch(baseUrl, {
      headers: { ...headers, 'last-event-id': '3' },
    });
    const resumedBody = await resumed.text();
    expect(resumedBody).not.toContain('id: 3\n');
    expect(resumedBody).toContain('id: 4\n');
    expect(resumedBody).toContain('id: 5\n');
    const badCursor = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events?afterSeq=bad`,
      headers,
    });
    expect(badCursor.statusCode).toBe(400);

    try {
      const writer = new Storage(dir);
      try {
        for (let index = 0; index < 150; index++)
          writer.appendRunEvent(
            runId,
            'model.finished',
            JSON.stringify({
              requestedServiceTier: 'auto',
              actualServiceTier: 'auto',
              serviceTierSource: 'test',
            }),
          );
      } finally {
        writer.close();
      }
      const batched = await fetch(baseUrl, { headers: { ...headers, 'last-event-id': '5' } });
      const batchedBody = await batched.text();
      expect(batchedBody.match(/^id: \d+$/gm)).toHaveLength(150);
      expect(batchedBody).toContain('id: 155\n');
      const details = await service.app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}`,
        headers,
      });
      expect((JSON.parse(details.body) as { serviceTiers: unknown[] }).serviceTiers).toHaveLength(
        151,
      );

      const faultWriter = new Storage(dir);
      try {
        const faultRunId = randomUUID();
        faultWriter.createRun({
          id: faultRunId,
          agent_id: agent.id,
          agent_version_id: null,
          source: 'test',
          status: 'running',
          input_json: '{}',
          output_json: null,
          error_json: null,
          created_at: new Date().toISOString(),
          finished_at: null,
          config_snapshot_json: null,
        });
        const faultStream = await fetch(
          `http://127.0.0.1:${serviceAddress.port}/api/v1/runs/${faultRunId}/events`,
          { headers },
        );
        expect(faultStream.status).toBe(200);
        faultWriter.appendRunEvent(faultRunId, 'model.finished', '{broken-json');
        await expect(faultStream.text()).rejects.toBeDefined();
        const alive = await service.app.inject({ method: 'GET', url: '/health' });
        expect(alive.statusCode).toBe(200);
      } finally {
        faultWriter.close();
      }
    } finally {
      await service.close();
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
