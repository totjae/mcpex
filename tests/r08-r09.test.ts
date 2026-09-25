import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('R08 command configuration', () => {
  it('validates configured commands and executes an allowlisted command through the server loop', async () => {
    let calls = 0;
    const mock = createHttpServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        calls++;
        const body = JSON.parse(raw) as {
          messages: Array<{ role: string; content: string }>;
          tools?: Array<{
            function?: {
              name?: string;
              description?: string;
              parameters?: { properties?: { commandId?: { enum?: string[] } } };
            };
          }>;
        };
        response.setHeader('content-type', 'application/json');
        if (calls === 1) {
          const commandTool = body.tools?.find(
            (tool) => tool.function?.name === 'run_command',
          )?.function;
          expect(commandTool?.description).toContain('private_test_runner_942 (Run test suite)');
          expect(commandTool?.parameters?.properties?.commandId?.enum).toEqual([
            'private_test_runner_942',
          ]);
          expect(JSON.stringify(commandTool)).not.toContain(process.execPath);
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'command-call',
                        type: 'function',
                        function: {
                          name: 'run_command',
                          arguments: JSON.stringify({
                            commandId: 'private_test_runner_942',
                            args: ['-e', 'process.stdout.write("server-command-ok")'],
                            cwd: '.',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
          return;
        }
        expect(body.messages.at(-1)?.role).toBe('tool');
        expect(body.messages.at(-1)?.content).toContain('server-command-ok');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'command-complete' }, finish_reason: 'stop' }],
          }),
        );
      });
    });
    const url = await listen(mock);
    const workspace = mkdtempSync(join(tmpdir(), 'mcpex-r08-workspace-'));
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r08-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: { name: 'Command mock', adapter: 'openai-chat', baseUrl: url },
        })
      ).body,
    ) as { id: string };
    const model = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'command-model' },
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
            displayName: 'Command agent',
            toolName: 'command_agent',
            config: {
              modelRef: model.id,
              userPromptTemplate: '{{input.task}}',
              runtime: {
                mode: 'tools',
                tools: ['run_command'],
                maxModelTurns: 3,
                maxToolCalls: 2,
                workspacePolicy: { mode: 'fixed', allowedRoots: [workspace] },
                commands: [
                  {
                    commandId: 'private_test_runner_942',
                    executable: process.execPath,
                    label: 'Run test suite',
                  },
                ],
              },
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
    const run = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/test-runs`,
      headers,
      payload: { expectedRevision: agent.draftRevision, input: { task: 'run it' } },
    });
    expect(run.statusCode).toBe(202);
    const completed = await waitForRun(
      service.app,
      headers,
      (JSON.parse(run.body) as { runId: string }).runId,
    );
    expect(completed.output).toMatchObject({ value: 'command-complete' });
    expect(completed.verification).toMatchObject({
      status: 'not_verified',
      evidence: {
        checks: [{ commandId: 'private_test_runner_942', exitCode: 0 }],
        toolFailures: [],
      },
    });

    const invalidAgent = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'Invalid command agent',
            toolName: 'invalid_command_agent',
            config: {
              modelRef: model.id,
              runtime: {
                mode: 'tools',
                tools: ['run_command'],
                workspacePolicy: { mode: 'fixed', allowedRoots: [workspace] },
                commands: [{ commandId: 'bad-command', executable: 'node' }],
              },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const invalidApply = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${invalidAgent.id}/apply`,
      headers,
      payload: { expectedRevision: invalidAgent.draftRevision },
    });
    expect(invalidApply.statusCode).toBe(422);
    expect(JSON.parse(invalidApply.body).error.code).toBe('INVALID_CONFIG');

    await service.close();
    await close(mock);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('R09 provider limits and model defaults', () => {
  it('serializes models from one provider and merges model defaults with agent overrides', async () => {
    let active = 0;
    let maximumActive = 0;
    const requests: Array<Record<string, unknown>> = [];
    const mock = createHttpServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        setTimeout(() => {
          active--;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
            }),
          );
        }, 40);
      });
    });
    const url = await listen(mock);
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r09-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Limited mock',
            adapter: 'openai-chat',
            baseUrl: url,
            maxConcurrency: 1,
          },
        })
      ).body,
    ) as { id: string };
    const createModel = async (modelId: string) =>
      JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/models',
            headers,
            payload: {
              providerId: provider.id,
              modelId,
              defaultGeneration: { temperature: 0.25, topP: 0.8, maxOutputTokens: 77 },
            },
          })
        ).body,
      ) as { id: string };
    const firstModel = await createModel('first-model');
    const secondModel = await createModel('second-model');
    const createAgent = async (toolName: string, modelRef: string, override = false) =>
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
                modelRef,
                userPromptTemplate: '{{input.task}}',
                generationOverrides: override ? { temperature: 0.5 } : {},
              },
            },
          })
        ).body,
      ) as { id: string; draftRevision: number };
    const firstAgent = await createAgent('first_agent', firstModel.id, true);
    const secondAgent = await createAgent('second_agent', secondModel.id);
    const run = (agent: { id: string; draftRevision: number }) =>
      service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/test-runs`,
        headers,
        payload: { expectedRevision: agent.draftRevision, input: { task: 'go' } },
      });
    const results = await Promise.all([run(firstAgent), run(secondAgent)]);
    expect(results.map((result) => result.statusCode)).toEqual([202, 202]);
    await Promise.all(
      results.map((result) =>
        waitForRun(service.app, headers, (JSON.parse(result.body) as { runId: string }).runId),
      ),
    );
    expect(maximumActive).toBe(1);
    const firstRequest = requests.find((request) => request.model === 'first-model');
    expect(firstRequest).toMatchObject({
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 77,
    });
    const secondRequest = requests.find((request) => request.model === 'second-model');
    expect(secondRequest).toMatchObject({
      temperature: 0.25,
      top_p: 0.8,
      max_tokens: 77,
    });

    await service.close();
    await close(mock);
    rmSync(dir, { recursive: true, force: true });
  });

  it('recomputes shared resource group limits after provider updates, moves, and deletion', async () => {
    let active = 0;
    let maximumActive = 0;
    const mock = createHttpServer((request, response) => {
      request.resume();
      request.on('end', () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        setTimeout(() => {
          active--;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
            }),
          );
        }, 50);
      });
    });
    const url = await listen(mock);
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-v04-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const createProvider = async (name: string, limit: number) => {
      const response = await service.app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers,
        payload: {
          name,
          adapter: 'openai-chat',
          baseUrl: url,
          maxConcurrency: 2,
          resourceGroup: 'shared',
          resourceGroupConcurrency: limit,
        },
      });
      expect(response.statusCode).toBe(201);
      return JSON.parse(response.body) as { id: string; revision: number };
    };
    const firstProvider = await createProvider('Group provider one', 2);
    const secondProvider = await createProvider('Group provider two', 2);
    const limiter = await createProvider('Group limiter', 1);
    const createAgent = async (providerId: string, suffix: string) => {
      const modelResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers,
        payload: { providerId, modelId: `group-model-${suffix}` },
      });
      const model = JSON.parse(modelResponse.body) as { id: string };
      const agentResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers,
        payload: {
          displayName: `Group agent ${suffix}`,
          toolName: `group_agent_${suffix}`,
          config: { modelRef: model.id, userPromptTemplate: '{{input.task}}' },
        },
      });
      return JSON.parse(agentResponse.body) as { id: string; draftRevision: number };
    };
    const firstAgent = await createAgent(firstProvider.id, 'one');
    const secondAgent = await createAgent(secondProvider.id, 'two');
    const runPair = async () => {
      maximumActive = 0;
      const submit = (agent: { id: string; draftRevision: number }) =>
        service.app.inject({
          method: 'POST',
          url: `/api/v1/agents/${agent.id}/test-runs`,
          headers,
          payload: { expectedRevision: agent.draftRevision, input: { task: 'go' } },
        });
      const runs = await Promise.all([submit(firstAgent), submit(secondAgent)]);
      await Promise.all(
        runs.map((run) =>
          waitForRun(service.app, headers, (JSON.parse(run.body) as { runId: string }).runId),
        ),
      );
      return maximumActive;
    };
    const patchProvider = async (
      provider: { id: string; revision: number },
      payload: Record<string, unknown>,
    ) => {
      const response = await service.app.inject({
        method: 'PATCH',
        url: `/api/v1/providers/${provider.id}`,
        headers,
        payload: { expectedRevision: provider.revision, ...payload },
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as { id: string; revision: number };
    };

    expect(await runPair()).toBe(1);
    const raisedLimiter = await patchProvider(limiter, { resourceGroupConcurrency: 2 });
    expect(await runPair()).toBe(2);
    const movedLimiter = await patchProvider(raisedLimiter, {
      resourceGroup: 'other',
      resourceGroupConcurrency: 1,
    });
    expect(await runPair()).toBe(2);
    await patchProvider(firstProvider, {
      resourceGroup: 'other',
      resourceGroupConcurrency: 2,
    });
    await patchProvider(secondProvider, {
      resourceGroup: 'other',
      resourceGroupConcurrency: 2,
    });
    expect(await runPair()).toBe(1);
    const removed = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${movedLimiter.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await runPair()).toBe(2);

    await service.close();
    await close(mock);
    rmSync(dir, { recursive: true, force: true });
  });
});
