import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

afterEach(() => vi.unstubAllGlobals());

it('uses the OpenAI chat format for existing LLM Gateway registrations and preserves tier inheritance', async () => {
  const requests: Array<Record<string, unknown>> = [];
  let rejectFlex = false;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.llmgateway.io/v1/chat/completions')
        return nativeFetch(input, init);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.service_tier === 'priority')
        return new Response(
          JSON.stringify({
            error: { code: 'unsupported_service_tier', message: 'Unsupported tier' },
          }),
          { status: 400 },
        );
      if (body.service_tier === 'flex' && rejectFlex)
        return new Response(
          JSON.stringify({ error: { message: 'Plan does not allow this tier' } }),
          { status: 403 },
        );
      return new Response(
        JSON.stringify({
          id: 'gateway-fixture',
          ...(body.service_tier === 'auto' ? {} : { service_tier: 'priority' }),
          metadata: { used_service_tier: 'flex' },
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );

  const dir = mkdtempSync(join(tmpdir(), 'mcpex-gateway-tier-'));
  const server = await createServer(dir);
  const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
  const inject = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
    server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  try {
    const profiles = (await inject('GET', '/api/v1/provider-profiles')).json().items as Array<{
      id: string;
      baseUrl: string;
    }>;
    expect(profiles).toContainEqual(
      expect.objectContaining({ id: 'llmgateway', baseUrl: 'https://api.llmgateway.io/v1' }),
    );
    const saved = await inject('POST', '/api/v1/providers', {
      name: 'llmgtw',
      profileId: 'openai',
      baseUrl: 'https://api.llmgateway.io/v1/',
      extraBody: { service_tier: 'flex', keep: 'stored' },
    });
    expect(saved.statusCode).toBe(201);
    const provider = saved.json() as { id: string; serviceTierSupport: string; revision: number };
    expect(provider.serviceTierSupport).toBe('supported');
    const generic = await inject('POST', '/api/v1/providers', {
      name: 'custom name',
      adapter: 'openai-chat',
      baseUrl: 'https://api.llmgateway.io/v1',
    });
    expect(generic.json().serviceTierSupport).toBe('supported');

    const created = await inject('POST', '/api/v1/models', {
      providerId: provider.id,
      modelId: 'gateway-fixture-model',
      serviceTier: 'default',
    });
    expect(created.statusCode).toBe(201);
    let model = created.json() as { id: string; revision: number };
    const probe = await inject('POST', `/api/v1/models/${model.id}/probes`, { prompt: 'fixture' });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      requestedServiceTier: 'default',
      actualServiceTier: 'priority',
    });
    expect(requests.at(-1)?.service_tier).toBe('default');
    expect(requests.at(-1)?.keep).toBe('stored');

    const agentCreated = await inject('POST', '/api/v1/agents', {
      displayName: 'Gateway agent',
      toolName: 'gateway_agent',
      config: { modelRef: model.id, serviceTier: 'inherit' },
    });
    expect(agentCreated.statusCode).toBe(201);
    let agent = agentCreated.json() as {
      id: string;
      draftRevision: number;
      draft: Record<string, unknown>;
    };
    const run = async (expected: string | undefined, actual: string | null) => {
      const accepted = await inject('POST', `/api/v1/agents/${agent.id}/test-runs`, {
        expectedRevision: agent.draftRevision,
        input: { task: 'fixture' },
      });
      expect(accepted.statusCode).toBe(202);
      const detail = await waitForRun(server.app, headers, accepted.json().runId);
      expect(detail).toMatchObject({
        status: 'completed',
        serviceTiers: [{ requested: expected ?? null, actual }],
      });
      expect(requests.at(-1)?.service_tier).toBe(expected);
    };
    const changeAgent = async (tier: string) => {
      const changed = await inject('PATCH', `/api/v1/agents/${agent.id}`, {
        expectedRevision: agent.draftRevision,
        config: { ...agent.draft, serviceTier: tier },
      });
      expect(changed.statusCode).toBe(200);
      agent = changed.json() as typeof agent;
    };
    await run('default', 'priority');
    await changeAgent('provider-default');
    await run(undefined, 'priority');
    await changeAgent('auto');
    await run('auto', null); // Unconfirmed metadata must not be shown as actual.
    await changeAgent('flex');
    await run('flex', 'priority');

    const applied = await inject('POST', `/api/v1/agents/${agent.id}/apply`, {
      expectedRevision: agent.draftRevision,
    });
    expect(applied.statusCode).toBe(201);
    expect(
      (await inject('PUT', `/api/v1/agents/${agent.id}/activation`, { enabled: true })).statusCode,
    ).toBe(200);
    const updatedModel = await inject('PATCH', `/api/v1/models/${model.id}`, {
      expectedRevision: model.revision,
      serviceTier: 'provider-default',
    });
    expect(updatedModel.statusCode).toBe(200);
    model = updatedModel.json() as typeof model;
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
    const client = new Client({ name: 'gateway-tier-test', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
          authProvider: { token: async () => getLocalAccessToken(dir) },
        }),
      );
      const result = await client.callTool({
        name: 'gateway_agent',
        arguments: { task: 'fixture' },
      });
      expect(result.isError).not.toBe(true);
      expect(requests.at(-1)?.service_tier).toBe('flex');
    } finally {
      await client.close();
    }

    await changeAgent('priority');
    const before400 = requests.length;
    const rejected = await inject('POST', `/api/v1/agents/${agent.id}/test-runs`, {
      expectedRevision: agent.draftRevision,
      input: { task: 'fixture' },
    });
    const failed = await waitForRun(server.app, headers, rejected.json().runId);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } });
    expect(requests.length).toBe(before400 + 1);
    expect(requests.at(-1)?.service_tier).toBe('priority');
    rejectFlex = true;
    const planModel = await inject('PATCH', `/api/v1/models/${model.id}`, {
      expectedRevision: model.revision,
      serviceTier: 'flex',
    });
    expect(planModel.statusCode).toBe(200);
    const before403 = requests.length;
    const rejectedPlan = await inject('POST', `/api/v1/models/${model.id}/probes`, {
      prompt: 'fixture',
    });
    expect(rejectedPlan.statusCode).toBe(403);
    expect(requests.length).toBe(before403 + 1);
    expect(requests.at(-1)?.service_tier).toBe('flex');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it('enables only the official HTTPS gateway endpoint with the OpenAI chat adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpex-gateway-url-'));
  const server = await createServer(dir);
  const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
  try {
    for (const [adapter, baseUrl] of [
      ['openai-chat', 'https://api.llmgateway.io.evil.example/v1'],
      ['openai-chat', 'https://sub.api.llmgateway.io/v1'],
      ['openai-chat', 'https://api.llmgateway.io/v2'],
      ['openai-chat', 'https://api.llmgateway.io:444/v1'],
      ['openai-chat', 'https://api.llmgateway.io/v1?proxy=1'],
      ['anthropic-messages', 'https://api.llmgateway.io/v1'],
    ] as const) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers,
        payload: { name: 'negative fixture', adapter, baseUrl },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().serviceTierSupport).toBe('unverified');
    }
    const preset = await server.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers,
      payload: { name: 'gateway preset', profileId: 'llmgateway' },
    });
    expect(preset.statusCode).toBe(201);
    expect(preset.json().serviceTierSupport).toBe('supported');
    const changed = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${preset.json().id}`,
      headers,
      payload: { expectedRevision: preset.json().revision, baseUrl: 'https://proxy.example/v1' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().serviceTierSupport).toBe('unverified');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
