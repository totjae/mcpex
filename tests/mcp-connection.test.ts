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
              config: {
                modelRef: model.id,
                description: 'Published tool description',
                runtime: {
                  mode: 'tools',
                  tools: ['read_file', 'write_file'],
                  workspacePolicy: { mode: 'none', allowedRoots: [] },
                },
              },
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
      const fullAccess = JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/agents',
            headers,
            payload: {
              displayName: 'Full access agent',
              toolName: 'full_access_agent',
              config: {
                modelRef: model.id,
                runtime: {
                  mode: 'tools',
                  tools: ['read_file', 'run_command'],
                  workspacePolicy: { mode: 'full', allowedRoots: [] },
                  commands: [{ commandId: 'node', executable: process.execPath, label: 'Node.js' }],
                },
              },
            },
          })
        ).body,
      ) as { id: string; draftRevision: number };
      await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${fullAccess.id}/apply`,
        headers,
        payload: { expectedRevision: fullAccess.draftRevision },
      });
      await service.app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${fullAccess.id}/activation`,
        headers,
        payload: { enabled: true },
      });
      const commandless = JSON.parse(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/v1/agents',
            headers,
            payload: {
              displayName: 'Commandless agent',
              toolName: 'commandless_agent',
              config: {
                modelRef: model.id,
                runtime: {
                  mode: 'tools',
                  tools: ['run_command'],
                  workspacePolicy: { mode: 'fixed', allowedRoots: [dir] },
                  commands: [],
                },
              },
            },
          })
        ).body,
      ) as { id: string; draftRevision: number };
      await service.app.inject({
        method: 'POST',
        url: `/api/v1/agents/${commandless.id}/apply`,
        headers,
        payload: { expectedRevision: commandless.draftRevision },
      });
      await service.app.inject({
        method: 'PUT',
        url: `/api/v1/agents/${commandless.id}/activation`,
        headers,
        payload: { enabled: true },
      });
      await service.app.inject({
        method: 'PATCH',
        url: `/api/v1/agents/${active.id}`,
        headers,
        payload: {
          expectedRevision: active.draftRevision,
          draft: {
            modelRef: model.id,
            description: 'Unpublished draft description',
            runtime: {
              mode: 'tools',
              tools: ['read_file'],
              workspacePolicy: { mode: 'fixed', allowedRoots: ['C:\\Unpublished'] },
            },
          },
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
            runtimeMode: 'tools',
            workspaceMode: 'none',
            effectiveTools: [],
            workspaceState: 'workspace_disabled',
          },
          {
            name: 'commandless_agent',
            displayName: 'Commandless agent',
            runtimeMode: 'tools',
            workspaceMode: 'fixed',
            effectiveTools: [],
            workspaceState: 'no_tools',
          },
          {
            name: 'full_access_agent',
            displayName: 'Full access agent',
            description:
              'Full access agent 전체 접근에서는 파일·명령 경로에 절대 경로가 필요합니다. 파일 도구의 결과는 선택한 모델 제공자에게 전달될 수 있으며, 클라우드 모델이면 PC 밖으로 전송됩니다. 허용 명령은 MCPex를 실행 중인 OS 사용자 권한으로 실행되며 OS sandbox가 아닙니다.',
            runtimeMode: 'tools',
            workspaceMode: 'full',
            effectiveTools: ['read_file', 'run_command'],
            workspaceState: 'full',
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
      expect(response.body).not.toContain('C:\\Unpublished');
      expect(response.body.toLowerCase()).not.toContain('token');
      expect(response.body.toLowerCase()).not.toContain('credential');
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
