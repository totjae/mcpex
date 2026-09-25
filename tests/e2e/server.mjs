import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, getLocalAccessToken } from '../../apps/server/dist/src/index.js';

const dataDir = resolve('.e2e-data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const mock = createHttpServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const input = JSON.parse(body);
      const last = input.messages?.at(-1)?.content ?? '';
      if (
        input.messages?.some(
          (message) => message.role === 'user' && message.content.includes('target-e2e'),
        )
      ) {
        const usedTool = input.messages.some((message) => message.role === 'tool');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: usedTool
                  ? { role: 'assistant', content: 'target-e2e 완료' }
                  : {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'target-write-1',
                          type: 'function',
                          function: {
                            name: 'write_target',
                            arguments: JSON.stringify({
                              targetId: 'output',
                              content: 'target-e2e-created',
                            }),
                          },
                        },
                      ],
                    },
                finish_reason: usedTool ? 'stop' : 'tool_calls',
              },
            ],
          }),
        );
        return;
      }
      const delay = last.includes('느린 첫 실행')
        ? 500
        : last.includes('빠른 두 번째 실행')
          ? 120
          : 250;
      setTimeout(() => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'e2e-request',
        });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `E2E 응답: ${last}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        );
      }, delay);
    });
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolvePromise) => mock.listen(47932, '127.0.0.1', resolvePromise));
const service = await createServer(dataDir, {
  webDist: resolve('apps/web/dist'),
  mcpConnection: {
    command: process.execPath,
    args: [resolve('apps/cli/dist/src/index.js'), 'mcp'],
  },
});
const accessToken = getLocalAccessToken(dataDir);
writeFileSync(resolve(dataDir, 'state.json'), JSON.stringify({ accessToken }), {
  encoding: 'utf8',
  mode: 0o600,
});
await service.app.listen({ host: '127.0.0.1', port: 47931 });

export default function setup() {
  return async () => {
    await service.close();
    await new Promise((resolvePromise) => mock.close(resolvePromise));
  };
}
