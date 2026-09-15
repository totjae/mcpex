import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';

describe('MCP connection information', () => {
  it('returns executable registration fields and the applied active tool catalog without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-connection-info-'));
    const command = 'C:\\Program Files\\nodejs\\node.exe';
    const cliPath = 'C:\\MCPex Project\\apps\\cli\\dist\\src\\index.js';
    const service = await createServer(dir, {
      mcpConnection: {
        command,
        args: [cliPath, 'mcp'],
        environment: { MCPEX_DATA_DIR: 'C:\\MCPex Data' },
      },
    });
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };

    try {
      const unauthorized = await service.app.inject({
        method: 'GET',
        url: '/api/v1/mcp-connection',
      });
      expect(unauthorized.statusCode).toBe(401);

      const provider = JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/providers',
            headers,
            payload: {
              name: 'Connection provider',
              adapter: 'openai-chat',
              baseUrl: 'http://127.0.0.1:12345',
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
            payload: { providerId: provider.id, modelId: 'connection-model' },
          })
        ).body,
      ) as { id: string };
      const active = JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/agents',
            headers,
            payload: {
              displayName: 'Active connection agent',
              toolName: 'active_connection_agent',
              config: { modelRef: model.id, description: 'Published tool description' },
            },
          })
        ).body,
      ) as { id: string; draftRevision: number };
      await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${active.id}/apply`,
        headers,
        payload: { expectedRevision: active.draftRevision },
      });
      await service.app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${active.id}/activation`,
        headers,
        payload: { enabled: true },
      });
      await service.app.inject({
        method: 'PATCH',
        url: `/api/v1/agents/${active.id}`,
        headers,
        payload: {
          expectedRevision: active.draftRevision,
          draft: { modelRef: model.id, description: 'Unpublished draft description' },
        },
      });
      await service.app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        headers,
        payload: {
          displayName: 'Draft only agent',
          toolName: 'draft_only_agent',
          config: { modelRef: model.id },
        },
      });

      const response = await service.app.inject({
        method: 'GET',
        url: '/api/v1/mcp-connection',
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        transport: 'stdio',
        registration: {
          command,
          args: [cliPath, 'mcp'],
          environment: { MCPEX_DATA_DIR: 'C:\\MCPex Data' },
        },
        service: { status: 'ok' },
        clientConnection: { status: 'unverified' },
        tools: [
          {
            name: 'active_connection_agent',
            displayName: 'Active connection agent',
            description: 'Published tool description',
          },
        ],
        inactiveAgents: [
          {
            name: 'draft_only_agent',
            displayName: 'Draft only agent',
            reason: 'not_applied',
          },
        ],
      });
      expect(response.body).not.toContain('Unpublished draft description');
      expect(response.body.toLowerCase()).not.toContain('token');
      expect(response.body.toLowerCase()).not.toContain('credential');
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
