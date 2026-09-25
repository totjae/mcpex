import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

async function modelServer(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/chat/completions') {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
        const input = body.messages.at(-1)?.content ?? '';
        const content = input.includes('output-limit')
          ? 'x'.repeat(128 * 1024 + 1)
          : input.includes('json-success')
            ? '```json\n{"ok":true}\n```'
            : input.includes('json-schema-failure')
              ? '{"ok":"yes"}'
              : input.includes('json-failure')
                ? 'not json'
                : `answer:${input}`;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { content },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('P2 agents and response runs', () => {
  it('creates a draft, previews and applies a version, then records a test run', async () => {
    const mock = await modelServer();
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p2-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: { name: 'Mock', adapter: 'openai-chat', baseUrl: mock.url },
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
    const config = {
      modelRef: model.id,
      systemPrompt: 'Be concise.',
      userPromptTemplate: 'Task: {{input.task}}',
      generationOverrides: {},
      runtime: { queueTimeoutMs: 45000, executionTimeoutMs: 180000 },
    };
    const invalidTime = await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        displayName: '잘못된 시간 정책',
        toolName: 'invalid_time_agent',
        config: { ...config, runtime: { queueTimeoutMs: 45000 } },
      },
    });
    expect(invalidTime.statusCode).toBe(422);
    const agentResponse = await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: { displayName: '요약 에이전트', toolName: 'summary_agent', config },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agent = JSON.parse(agentResponse.body) as { id: string; draftRevision: number };
    const preview = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/preview`,
      headers,
      payload: { input: { task: '문서 요약' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).messages[1].content).toBe('Task: 문서 요약');
    const applied = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/apply`,
      headers,
      payload: { expectedRevision: agent.draftRevision },
    });
    expect(applied.statusCode).toBe(201);
    expect(JSON.parse(applied.body).version).toBe(1);
    const run = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: { task: '문서 요약' } },
    });
    expect(run.statusCode).toBe(202);
    const runBody = JSON.parse(run.body) as { runId: string; status: string };
    expect(runBody.status).toBe('queued');
    const detail = await waitForRun(service.app, headers, runBody.runId);
    expect(detail).toMatchObject({
      status: 'completed',
      output: { value: 'answer:Task: 문서 요약' },
      configSnapshot: { agent: { runtime: { queueTimeoutMs: 45000, executionTimeoutMs: 180000 } } },
    });
    const runList = await service.app.inject({
      method: 'GET',
      url: '/api/v1/runs',
      headers,
    });
    expect(runList.statusCode).toBe(200);
    expect(JSON.parse(runList.body).items[0].id).toBe(runBody.runId);
    const invalidInput = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: {} },
    });
    expect(invalidInput.statusCode).toBe(400);
    expect(JSON.parse(invalidInput.body).error.code).toBe('INVALID_INPUT');
    const outputLimit = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: { task: 'output-limit' } },
    });
    expect(outputLimit.statusCode).toBe(202);
    const outputLimitRun = await waitForRun(
      service.app,
      headers,
      (JSON.parse(outputLimit.body) as { runId: string }).runId,
    );
    expect(outputLimitRun.error?.code).toBe('OUTPUT_LIMIT');

    const jsonAgentResponse = await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        displayName: 'JSON Agent',
        toolName: 'json_agent',
        config: {
          modelRef: model.id,
          userPromptTemplate: '{{input.task}}',
          inputSchema: {
            type: 'object',
            properties: { task: { type: 'string' } },
            required: ['task'],
            additionalProperties: false,
          },
          output: {
            format: 'json',
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      },
    });
    const jsonAgent = JSON.parse(jsonAgentResponse.body) as {
      id: string;
      draftRevision: number;
    };
    const validJson = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${jsonAgent.id}/test-runs`,
      headers,
      payload: { expectedRevision: jsonAgent.draftRevision, input: { task: 'json-success' } },
    });
    expect(validJson.statusCode).toBe(202);
    const validJsonRun = await waitForRun(
      service.app,
      headers,
      (JSON.parse(validJson.body) as { runId: string }).runId,
    );
    expect(validJsonRun.output).toEqual({ format: 'json', value: { ok: true } });
    const invalidJson = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${jsonAgent.id}/test-runs`,
      headers,
      payload: { expectedRevision: jsonAgent.draftRevision, input: { task: 'json-failure' } },
    });
    expect(invalidJson.statusCode).toBe(202);
    const invalidJsonRun = await waitForRun(
      service.app,
      headers,
      (JSON.parse(invalidJson.body) as { runId: string }).runId,
    );
    expect(invalidJsonRun.error?.code).toBe('INVALID_OUTPUT');
    const jsonRuns = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs?agentId=${jsonAgent.id}`,
      headers,
    });
    expect(JSON.parse(jsonRuns.body).items[0]).toMatchObject({
      status: 'failed',
      output: { format: 'json', rawText: 'not json', truncated: false },
      error: { code: 'INVALID_OUTPUT' },
    });
    const schemaMismatch = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${jsonAgent.id}/test-runs`,
      headers,
      payload: {
        expectedRevision: jsonAgent.draftRevision,
        input: { task: 'json-schema-failure' },
      },
    });
    expect(schemaMismatch.statusCode).toBe(202);
    const schemaMismatchRun = await waitForRun(
      service.app,
      headers,
      (JSON.parse(schemaMismatch.body) as { runId: string }).runId,
    );
    expect(schemaMismatchRun.error?.code).toBe('INVALID_OUTPUT');

    const badSchemaAgent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'Bad Schema',
            toolName: 'bad_schema',
            config: {
              modelRef: model.id,
              inputSchema: { type: 'object', patternProperties: { '.*': { type: 'string' } } },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const rejectedApply = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${badSchemaAgent.id}/apply`,
      headers,
      payload: { expectedRevision: badSchemaAgent.draftRevision },
    });
    expect(rejectedApply.statusCode).toBe(422);
    expect(JSON.parse(rejectedApply.body).error.code).toBe('INVALID_SCHEMA');
    const templates = await service.app.inject({
      method: 'GET',
      url: '/api/v1/templates',
      headers,
    });
    expect(templates.statusCode).toBe(200);
    expect(JSON.parse(templates.body).items.length).toBeGreaterThan(0);
    await service.close();
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
