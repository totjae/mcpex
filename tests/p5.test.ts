import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  AnthropicMessagesAdapter,
  BedrockConverseAdapter,
  GeminiGenerateContentAdapter,
  VertexGeminiAdapter,
  getProviderProfile,
  listProviderProfiles,
  type GenerateRequest,
} from '@mcpex/providers';

async function providerMock(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/messages') {
        expect(request.headers['x-api-key']).toBe('anthropic-secret');
        const body = JSON.parse(raw) as { tools?: unknown[]; messages?: unknown[] };
        expect(body.tools).toHaveLength(1);
        expect(body.messages).toHaveLength(1);
        response.end(
          JSON.stringify({
            id: 'anthropic-request',
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'toolu-1', name: 'read_file', input: { path: 'a.txt' } },
            ],
            usage: { input_tokens: 4, output_tokens: 3 },
          }),
        );
        return;
      }
      if (request.url === '/models/gemini-test:generateContent') {
        expect(request.headers['x-goog-api-key']).toBe('gemini-secret');
        const body = JSON.parse(raw) as {
          tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
          contents?: unknown[];
        };
        expect(body.tools?.[0].functionDeclarations?.[0].name).toBe('read_file');
        expect(body.contents).toHaveLength(1);
        response.end(
          JSON.stringify({
            responseId: 'gemini-request',
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
          }),
        );
        return;
      }
      if (request.url === '/model/bedrock-test/converse') {
        expect(request.headers.authorization).toBe('Bearer bedrock-secret');
        const body = JSON.parse(raw) as {
          toolConfig?: { tools?: unknown[] };
          messages?: unknown[];
        };
        expect(body.toolConfig?.tools).toHaveLength(1);
        expect(body.messages).toHaveLength(1);
        response.end(
          JSON.stringify({
            output: {
              message: {
                content: [
                  {
                    toolUse: {
                      toolUseId: 'bedrock-call-1',
                      name: 'read_file',
                      input: { path: 'a.txt' },
                    },
                  },
                ],
              },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
          }),
        );
        return;
      }
      if (
        request.url ===
        '/v1/projects/project-1/locations/global/publishers/google/models/gemini-test:generateContent'
      ) {
        expect(request.headers.authorization).toBe('Bearer vertex-token');
        response.end(
          JSON.stringify({
            responseId: 'vertex-request',
            candidates: [{ content: { parts: [{ text: 'vertex-ok' }] }, finishReason: 'STOP' }],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not start');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const request: GenerateRequest = {
  modelId: 'gemini-test',
  messages: [{ role: 'user', content: 'inspect' }],
  tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
};

describe('P5 provider adapters', () => {
  it('exposes provider-manager-inspired cloud and local profiles', () => {
    const profiles = listProviderProfiles();
    expect(profiles.map((profile) => profile.id)).toEqual(
      expect.arrayContaining([
        'openrouter',
        'deepseek',
        'lm-studio',
        'ollama',
        'vllm',
        'amazon-bedrock',
      ]),
    );
    expect(getProviderProfile('ollama')).toMatchObject({
      adapter: 'openai-chat',
      location: 'local',
    });
  });

  it('maps Anthropic Messages tool use to the common contract', async () => {
    const mock = await providerMock();
    const result = await new AnthropicMessagesAdapter().generate(
      request,
      mock.url,
      {},
      'anthropic-secret',
    );
    expect(result.toolCalls).toEqual([
      { id: 'toolu-1', name: 'read_file', arguments: { path: 'a.txt' } },
    ]);
    expect(result.usage?.totalTokens).toBe(7);
    mock.server.close();
  });

  it('maps Gemini generateContent function calls to the common contract', async () => {
    const mock = await providerMock();
    const result = await new GeminiGenerateContentAdapter().generate(
      request,
      mock.url,
      {},
      'gemini-secret',
    );
    expect(result.toolCalls).toEqual([
      { id: 'gemini-call-1', name: 'read_file', arguments: { path: 'a.txt' } },
    ]);
    expect(result.providerRequestId).toBe('gemini-request');
    mock.server.close();
  });

  it('maps Bedrock Converse tool use to the common contract', async () => {
    const mock = await providerMock();
    const result = await new BedrockConverseAdapter().generate(
      { ...request, modelId: 'bedrock-test' },
      mock.url,
      {},
      'bedrock-secret',
    );
    expect(result.toolCalls).toEqual([
      { id: 'bedrock-call-1', name: 'read_file', arguments: { path: 'a.txt' } },
    ]);
    mock.server.close();
  });

  it('uses Vertex project/location routing and bearer authentication', async () => {
    const mock = await providerMock();
    const result = await new VertexGeminiAdapter().generate(
      { ...request, tools: undefined },
      mock.url,
      {},
      'vertex-token',
      { projectId: 'project-1', location: 'global' },
    );
    expect(result.text).toBe('vertex-ok');
    mock.server.close();
  });
});
