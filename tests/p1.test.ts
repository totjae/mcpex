import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getLocalAccessToken } from '@mcpex/server';

async function mockOpenAI(): Promise<{ server: Server; baseUrl: string }> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    if (request.url === '/chat/completions') {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'mock-request',
            choices: [
              {
                message: { content: `echo:${body.messages.at(-1)?.content}` },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not start');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('P1 provider/model connection', () => {
  it('registers a provider and model, discovers models, and runs a response probe', async () => {
    const mock = await mockOpenAI();
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p1-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const providerResponse = await service.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers,
      payload: { name: 'Mock OpenAI', adapter: 'openai-chat', baseUrl: mock.baseUrl },
    });
    expect(providerResponse.statusCode).toBe(201);
    const provider = JSON.parse(providerResponse.body) as { id: string };
    const discovered = await service.app.inject({
      method: 'POST',
      url: `/api/v1/providers/${provider.id}/discover-models`,
      headers,
    });
    expect(discovered.statusCode).toBe(200);
    expect(JSON.parse(discovered.body).modelIds).toEqual(['mock-model']);
    const modelResponse = await service.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers,
      payload: { providerId: provider.id, modelId: 'mock-model', label: 'Mock Model' },
    });
    expect(modelResponse.statusCode).toBe(201);
    const model = JSON.parse(modelResponse.body) as { id: string };
    const probe = await service.app.inject({
      method: 'POST',
      url: `/api/v1/models/${model.id}/probes`,
      headers,
      payload: { prompt: 'hello' },
    });
    expect(probe.statusCode).toBe(200);
    expect(JSON.parse(probe.body).result.text).toBe('echo:hello');
    expect(probe.body).not.toContain('apiKey');
    await service.close();
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects credentials in the provider URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p1-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const result = await service.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers,
      payload: {
        name: 'Bad',
        adapter: 'openai-chat',
        baseUrl: 'https://user:pass@example.test/v1?api_key=leak',
      },
    });
    expect(result.statusCode).toBe(400);
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
