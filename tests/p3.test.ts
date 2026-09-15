import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getLocalAccessToken } from '@mcpex/server';

async function providerMock(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
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
            choices: [
              {
                message: { content: `mcp:${body.messages.at(-1)?.content}` },
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
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('P3 MCP endpoint', () => {
  it('lists and calls only an activated agent through the official SDK client', async () => {
    const mock = await providerMock();
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p3-'));
    const service = await createServer(dir);
    const localAccessToken = getLocalAccessToken(dir);
    const headers = { authorization: `Bearer ${localAccessToken}` };
    const unauthorizedMcp = await service.app.inject({ method: 'GET', url: '/mcp' });
    expect(unauthorizedMcp.statusCode).toBe(401);
    await service.app.listen({ host: '127.0.0.1', port: 0 });
    const address = service.app.server.address();
    if (!address || typeof address === 'string') throw new Error('app failed');
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
    const agent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'MCP Agent',
            toolName: 'mcp_agent',
            config: {
              modelRef: model.id,
              userPromptTemplate: 'Task: {{input.task}}',
              systemPrompt: '',
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
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
    const client = new Client({ name: 'p3-test-client', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        authProvider: { token: async () => localAccessToken },
      }),
    );
    const tools = await client.listTools();
    const listedAgent = tools.tools.find((tool) => tool.name === 'mcp_agent');
    expect(listedAgent?.inputSchema).toMatchObject({
      type: 'object',
      required: ['task'],
      properties: { task: { type: 'string' } },
    });
    const invalid = await client.callTool({ name: 'mcp_agent', arguments: {} });
    expect(invalid.isError).toBe(true);
    const result = await client.callTool({ name: 'mcp_agent', arguments: { task: 'hello' } });
    expect(JSON.stringify(result)).toContain('mcp:Task: hello');
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      contractVersion: '1',
      status: 'completed',
      outcome: 'succeeded',
      observations: { toolCalls: 0, changes: [], checks: [], truncated: false },
      validation: { format: 'not_required', model: 'not_configured' },
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      error: null,
    });
    expect(structured.runId).toEqual(expect.any(String));
    expect(structured.durationMs).toEqual(expect.any(Number));
    const textContent = result.content.find((item) => item.type === 'text');
    expect(textContent?.type === 'text' ? JSON.parse(textContent.text) : null).toEqual(structured);
    await client.close();
    // Disabling persists independently of daemon lifetime and does not require the UI to stay open.
    await service.app.inject({
      method: 'PUT',
      url: `/api/v1/agents/${agent.id}/activation`,
      headers,
      payload: { enabled: false },
    });
    await service.close();
    const restarted = await createServer(dir);
    await restarted.app.listen({ host: '127.0.0.1', port: 0 });
    const restartedAddress = restarted.app.server.address();
    if (!restartedAddress || typeof restartedAddress === 'string')
      throw new Error('restart failed');
    const restartedClient = new Client({ name: 'restart-client', version: '1.0.0' });
    await restartedClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${restartedAddress.port}/mcp`), {
        authProvider: { token: async () => localAccessToken },
      }),
    );
    expect((await restartedClient.listTools()).tools).toHaveLength(0);
    const saved = await restarted.app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}`,
      headers,
    });
    expect(JSON.parse(saved.body).enabled).toBe(false);
    await restartedClient.close();
    await restarted.close();
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
