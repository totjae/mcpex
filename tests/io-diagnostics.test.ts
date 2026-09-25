import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

describe('workspace path guidance and failure diagnostics', () => {
  it('accepts relative and in-scope absolute paths while rejecting outside paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-io-diagnostics-'));
    const root = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const requests: Array<{
      tools: Array<{ function: { description: string } }>;
      messages: Array<{ content: string }>;
    }> = [];
    const mock = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const step = requests.length;
        const call =
          step === 1
            ? { name: 'list_files', arguments: { path: root } }
            : step === 2
              ? { name: 'write_file', arguments: { path: 'output.txt', content: 'alpha=1' } }
              : step === 3
                ? { name: 'read_file', arguments: { path: join(root, 'output.txt') } }
                : step === 4
                  ? {
                      name: 'replace_text',
                      arguments: {
                        path: join(root, 'output.txt'),
                        oldText: 'alpha=1',
                        newText: 'alpha=2',
                        expectedHash: JSON.parse(body.messages.at(-1).content).hash,
                      },
                    }
                  : step === 5
                    ? { name: 'list_files', arguments: { path: outside } }
                    : step === 6
                      ? { name: 'read_file', arguments: { path: 'missing.txt' } }
                      : step === 7
                        ? {
                            name: 'write_file',
                            arguments: { path: 'output.txt', content: 'alpha=3' },
                          }
                        : step === 8
                          ? {
                              name: 'replace_text',
                              arguments: {
                                path: join(root, 'output.txt'),
                                oldText: 'alpha=2',
                                newText: 'alpha=3',
                                expectedHash: '0'.repeat(64),
                              },
                            }
                          : null;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: call
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: `call-${step}`,
                          type: 'function',
                          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        },
                      ],
                    }
                  : { content: 'done' },
                finish_reason: call ? 'tool_calls' : 'stop',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const service = await createServer(join(dir, 'data'));
    try {
      const headers = { authorization: `Bearer ${getLocalAccessToken(join(dir, 'data'))}` };
      const api = async (url: string, payload: object) => {
        const response = await service.app.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBeLessThan(300);
        return response.json();
      };
      const address = mock.address();
      if (!address || typeof address === 'string') throw new Error('No mock address');
      const provider = await api('/api/v1/providers', {
        name: 'Mock',
        adapter: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const model = await api('/api/v1/models', { providerId: provider.id, modelId: 'mock' });
      const agent = await api('/api/v1/agents', {
        displayName: 'IO check',
        toolName: 'io_check',
        config: {
          modelRef: model.id,
          userPromptTemplate: '{{input.task}}',
          runtime: {
            mode: 'tools',
            tools: ['list_files', 'read_file', 'write_file', 'replace_text'],
            workspacePolicy: { mode: 'fixed', allowedRoots: [root] },
            maxModelTurns: 9,
            maxToolCalls: 8,
          },
        },
      });
      const accepted = await api(`/api/v1/agents/${agent.id}/test-runs`, {
        expectedRevision: agent.draftRevision,
        input: { task: 'synthetic IO check' },
      });
      const run = await waitForRun(service.app, headers, accepted.runId);
      expect(run.status).toBe('completed');
      expect(run.verification).toMatchObject({
        status: 'not_verified',
        evidence: {
          toolFailures: [
            { code: 'PATH_FORBIDDEN' },
            { code: 'ENOENT' },
            { code: 'EXPECTED_HASH_REQUIRED' },
            { code: 'HASH_CONFLICT' },
          ],
        },
      });
      expect(readFileSync(join(root, 'output.txt'), 'utf8')).toBe('alpha=2');
      expect(requests[0].tools[0].function.description).not.toContain(root);
      expect(requests[0].tools[0].function.description).toContain('상대 경로');
      expect(requests[0].tools[0].function.description).toContain('범위 내부 절대 경로');
      expect(JSON.parse(requests[5].messages.at(-1)!.content).error.code).toBe('PATH_FORBIDDEN');
      const events = await service.app.inject({
        method: 'GET',
        url: `/api/v1/runs/${accepted.runId}/events`,
        headers,
      });
      const failures = events.body
        .split('\n\n')
        .filter((item) => item.includes('event: tool.finished') && item.includes('"ok":false'))
        .map((item) => JSON.parse(item.match(/^data: (.+)$/m)![1]));
      expect(failures.map((item) => item.error.code)).toEqual([
        'PATH_FORBIDDEN',
        'ENOENT',
        'EXPECTED_HASH_REQUIRED',
        'HASH_CONFLICT',
      ]);
      expect(failures.map((item) => item.diagnostic)).toMatchObject([
        { pathNotation: 'absolute', relativeTarget: null, reason: 'outside_root' },
        { pathNotation: 'relative', relativeTarget: 'missing.txt', reason: 'not_found' },
        {
          pathNotation: 'relative',
          relativeTarget: 'output.txt',
          expectedHashProvided: false,
          reason: 'expected_hash_missing',
        },
        {
          pathNotation: 'absolute',
          relativeTarget: 'output.txt',
          expectedHashProvided: true,
          reason: 'hash_mismatch',
        },
      ]);
      expect(events.body).not.toContain(root);
      expect(events.body).not.toContain(outside);
      expect(events.body).not.toContain('alpha=2');
      expect(events.body).not.toContain('alpha=3');
      expect(events.body).not.toContain('0'.repeat(64));

      for (const [toolName, maxModelTurns, maxToolCalls, expectedCode] of [
        ['turn_limit_agent', 1, 1, 'MODEL_TURN_LIMIT'],
        ['call_limit_agent', 2, 0, 'TOOL_CALL_LIMIT'],
      ] as const) {
        requests.length = 0;
        const limited = await api('/api/v1/agents', {
          displayName: toolName,
          toolName,
          config: {
            modelRef: model.id,
            userPromptTemplate: '{{input.task}}',
            runtime: {
              mode: 'tools',
              tools: ['list_files'],
              workspacePolicy: { mode: 'fixed', allowedRoots: [root] },
              maxModelTurns,
              maxToolCalls,
            },
          },
        });
        const limitedRun = await api(`/api/v1/agents/${limited.id}/test-runs`, {
          expectedRevision: limited.draftRevision,
          input: { task: 'limit check' },
        });
        expect(await waitForRun(service.app, headers, limitedRun.runId)).toMatchObject({
          status: 'failed',
          error: { code: expectedCode },
          verification: { status: 'not_verified' },
        });
      }
    } finally {
      await service.close();
      await new Promise<void>((resolve) => mock.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
