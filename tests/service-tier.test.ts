import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { waitForRun } from './run-helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('UX16 service tier', () => {
  it('separates model, agent, advanced and actual tiers across probes and runs', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).startsWith('https://api.openai.com/v1/chat/completions'))
          return nativeFetch(input, init);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (body.service_tier === 'priority')
          return new Response(
            JSON.stringify({ error: { message: 'Invalid service_tier argument' } }),
            { status: 400 },
          );
        return new Response(
          JSON.stringify({
            id: 'mock-request',
            ...(body.service_tier === 'auto' ? {} : { service_tier: 'priority' }),
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-tier-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    try {
      const providerResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers,
        payload: { name: 'OpenAI', profileId: 'openai', extraBody: { service_tier: 'flex' } },
      });
      expect(providerResponse.statusCode).toBe(201);
      const provider = JSON.parse(providerResponse.body) as {
        id: string;
        serviceTierSupport: string;
        advancedServiceTier: string;
      };
      expect(provider).toMatchObject({
        serviceTierSupport: 'supported',
        advancedServiceTier: 'flex',
      });
      const modelResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers,
        payload: { providerId: provider.id, modelId: 'gpt-test', serviceTier: 'default' },
      });
      expect(modelResponse.statusCode).toBe(201);
      const model = JSON.parse(modelResponse.body) as {
        id: string;
        serviceTier: string;
        revision: number;
      };
      expect(model.serviceTier).toBe('default');
      const probe = await service.app.inject({
        method: 'POST',
        url: `/api/v1/models/${model.id}/probes`,
        headers,
        payload: { prompt: 'hello' },
      });
      expect(probe.statusCode).toBe(200);
      expect(JSON.parse(probe.body)).toMatchObject({
        requestedServiceTier: 'default',
        actualServiceTier: 'priority',
      });
      expect(requests.at(-1)?.service_tier).toBe('default');

      const agentResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers,
        payload: {
          displayName: 'Tier agent',
          toolName: 'tier_agent',
          config: { modelRef: model.id, serviceTier: 'inherit' },
        },
      });
      expect(agentResponse.statusCode).toBe(201);
      let agent = JSON.parse(agentResponse.body) as {
        id: string;
        draftRevision: number;
        draft: Record<string, unknown>;
      };
      const run = async (expectedTier?: string, actualTier: string | null = 'priority') => {
        const accepted = await service.app.inject({
          method: 'POST',
          url: `/api/v1/agents/${agent.id}/test-runs`,
          headers,
          payload: { expectedRevision: agent.draftRevision, input: { task: 'hello' } },
        });
        expect(accepted.statusCode).toBe(202);
        const detail = await waitForRun(service.app, headers, JSON.parse(accepted.body).runId);
        expect(detail).toMatchObject({
          status: 'completed',
          serviceTiers: [{ requested: expectedTier ?? null, actual: actualTier }],
        });
        expect(requests.at(-1)?.service_tier).toBe(expectedTier);
      };
      await run('default');
      const update = async (serviceTier: string) => {
        const response = await service.app.inject({
          method: 'PATCH',
          url: `/api/v1/agents/${agent.id}`,
          headers,
          payload: {
            expectedRevision: agent.draftRevision,
            config: { ...agent.draft, serviceTier },
          },
        });
        expect(response.statusCode).toBe(200);
        agent = JSON.parse(response.body) as typeof agent;
      };
      await update('provider-default');
      await run();
      await update('auto');
      await run('auto', null);
      await update('priority');
      const rejectedRun = await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/test-runs`,
        headers,
        payload: { expectedRevision: agent.draftRevision, input: { task: 'hello' } },
      });
      expect(rejectedRun.statusCode).toBe(202);
      const failed = await waitForRun(service.app, headers, JSON.parse(rejectedRun.body).runId);
      expect(failed).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } });
      expect(requests.at(-1)?.service_tier).toBe('priority');
      await update('flex');
      await run('flex');

      expect(
        (
          await service.app.inject({
            method: 'POST',
            url: `/api/v1/agents/${agent.id}/apply`,
            headers,
            payload: { expectedRevision: agent.draftRevision },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await service.app.inject({
            method: 'PUT',
            url: `/api/v1/agents/${agent.id}/activation`,
            headers,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await service.app.inject({
            method: 'PATCH',
            url: `/api/v1/models/${model.id}`,
            headers,
            payload: { expectedRevision: model.revision, serviceTier: 'provider-default' },
          })
        ).statusCode,
      ).toBe(200);
      await service.app.listen({ host: '127.0.0.1', port: 0 });
      const address = service.app.server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP listener unavailable');
      const client = new Client({ name: 'tier-test', version: '1.0.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
            authProvider: { token: async () => getLocalAccessToken(dir) },
          }),
        );
        const result = await client.callTool({ name: 'tier_agent', arguments: { task: 'hello' } });
        expect(result.isError).not.toBe(true);
        expect(requests.at(-1)?.service_tier).toBe('flex');
      } finally {
        await client.close();
      }

      const unsupported = await service.app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers,
        payload: {
          name: 'Compatible',
          adapter: 'openai-chat',
          baseUrl: 'http://127.0.0.1:12345/v1',
        },
      });
      const unsupportedProvider = JSON.parse(unsupported.body) as {
        id: string;
        serviceTierSupport: string;
      };
      expect(unsupportedProvider.serviceTierSupport).toBe('unverified');
      const rejected = await service.app.inject({
        method: 'POST',
        url: '/api/v1/models',
        headers,
        payload: { providerId: unsupportedProvider.id, modelId: 'mock', serviceTier: 'priority' },
      });
      expect(rejected.statusCode).toBe(400);

      const templateResponse = await service.app.inject({
        method: 'POST',
        url: '/api/v1/templates',
        headers,
        payload: { name: 'Tier template', config: { serviceTier: 'auto' } },
      });
      expect(templateResponse.statusCode).toBe(201);
      const template = JSON.parse(templateResponse.body) as { id: string };
      const templateApplied = await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agent.id}/template-apply`,
        headers,
        payload: {
          templateId: template.id,
          sections: ['generation'],
          expectedRevision: agent.draftRevision,
        },
      });
      expect(templateApplied.statusCode).toBe(200);
      expect(JSON.parse(templateApplied.body).draft.serviceTier).toBe('auto');

      const exported = JSON.parse(
        (await service.app.inject({ method: 'POST', url: '/api/v1/config/export', headers })).body,
      );
      expect(exported.models.find((item: { id: string }) => item.id === model.id).serviceTier).toBe(
        'provider-default',
      );
      expect(
        exported.agents.find((item: { id: string }) => item.id === agent.id).config.serviceTier,
      ).toBe('auto');
      const importDir = mkdtempSync(join(tmpdir(), 'mcpex-tier-import-'));
      const importedService = await createServer(importDir);
      try {
        const importHeaders = { authorization: `Bearer ${getLocalAccessToken(importDir)}` };
        const imported = await importedService.app.inject({
          method: 'POST',
          url: '/api/v1/config/import',
          headers: importHeaders,
          payload: { config: exported, confirm: true },
        });
        expect(imported.statusCode).toBe(201);
        const importedModels = JSON.parse(
          (
            await importedService.app.inject({
              method: 'GET',
              url: '/api/v1/models',
              headers: importHeaders,
            })
          ).body,
        ).items;
        const importedAgents = JSON.parse(
          (
            await importedService.app.inject({
              method: 'GET',
              url: '/api/v1/agents',
              headers: importHeaders,
            })
          ).body,
        ).items;
        expect(importedModels[0].serviceTier).toBe('provider-default');
        expect(importedAgents[0].draft.serviceTier).toBe('auto');
      } finally {
        await importedService.close();
        rmSync(importDir, { recursive: true, force: true });
      }
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
