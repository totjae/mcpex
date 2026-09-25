import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { Storage } from '@mcpex/storage';
import { waitForRun } from './run-helpers.js';

describe('P6 templates and agent lifecycle', () => {
  it('updates stored builtin prompts while preserving existing agents and delivering scope to the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-scope-template-'));
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const mock = createHttpServer((request, response) => {
      let raw = '';
      request.on('data', (part) => (raw += part));
      request.on('end', () => {
        requests.push(JSON.parse(raw));
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'scope received' }, finish_reason: 'stop' }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    let service = await createServer(dir);
    try {
      const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
      const post = async (url: string, payload: object) => {
        const response = await service.app.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBeLessThan(300);
        return response.json();
      };
      const address = mock.address();
      if (!address || typeof address === 'string') throw new Error('No mock address');
      const provider = await post('/api/v1/providers', {
        name: 'Scope mock',
        adapter: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const model = await post('/api/v1/models', {
        providerId: provider.id,
        modelId: 'scope-mock',
      });
      const templates = await service.app.inject({
        method: 'GET',
        url: '/api/v1/templates',
        headers,
      });
      const builtin = (
        templates.json().items as Array<{
          id: string;
          name: string;
          config: {
            userPromptTemplate: string;
            inputSchema: { properties: { workspace: { description: string } }; required: string[] };
            runtime: object;
          };
        }>
      ).find((item) => item.name === '코드 구현');
      expect(builtin).toBeDefined();
      const legacyPrompt =
        '구현 작업: {{input.task}}\n작업 폴더: {{input.workspace}}\n요구사항: {{input.requirements}}';
      const legacy = await post('/api/v1/agents', {
        displayName: 'Existing coding agent',
        toolName: 'existing_coding_agent',
        config: {
          ...builtin!.config,
          modelRef: model.id,
          userPromptTemplate: legacyPrompt,
          inputSchema: { ...builtin!.config.inputSchema, required: ['task', 'workspace'] },
          runtime: {
            ...builtin!.config.runtime,
            workspacePolicy: { mode: 'fixed', allowedRoots: [dir] },
          },
        },
      });
      const applied = await post(`/api/v1/agents/${legacy.id}/apply`, {
        expectedRevision: legacy.draftRevision,
      });
      await service.close();

      const storage = new Storage(dir);
      try {
        storage.db
          .prepare('UPDATE templates SET config_json=?, version=1 WHERE id=?')
          .run(
            JSON.stringify({ ...builtin!.config, userPromptTemplate: legacyPrompt }),
            builtin!.id,
          );
      } finally {
        storage.close();
      }
      service = await createServer(dir);
      const refreshed = await service.app.inject({
        method: 'GET',
        url: '/api/v1/templates',
        headers,
      });
      const coding = (refreshed.json().items as (typeof builtin)[]).find(
        (item) => item?.name === '코드 구현',
      );
      expect(coding).toMatchObject({ id: builtin!.id, version: 2 });
      expect(coding!.config.userPromptTemplate).toContain('{{input.scope}}');
      expect(coding!.config.inputSchema.required).toEqual(['task']);
      expect(coding!.config.inputSchema.properties.workspace.description).toContain('문맥 정보');
      const existing = await service.app.inject({
        method: 'GET',
        url: `/api/v1/agents/${legacy.id}`,
        headers,
      });
      expect(existing.json()).toMatchObject({
        appliedVersionId: applied.versionId,
        draft: { userPromptTemplate: legacyPrompt },
      });
      const listed = await service.app.inject({ method: 'GET', url: '/api/v1/agents', headers });
      expect(
        listed.json().items.find((item: { id: string }) => item.id === legacy.id),
      ).toMatchObject({
        appliedScopeMissing: true,
      });
      const preview = await post(`/api/v1/agents/${legacy.id}/template-preview`, {
        templateId: coding!.id,
        sections: ['prompts'],
      });
      expect(preview.changes).toMatchObject([{ section: 'prompts', changed: true }]);
      const updatedDraft = await post(`/api/v1/agents/${legacy.id}/template-apply`, {
        templateId: coding!.id,
        sections: ['prompts'],
        expectedRevision: legacy.draftRevision,
      });
      expect(updatedDraft).toMatchObject({
        appliedVersionId: applied.versionId,
        draft: {
          userPromptTemplate: coding!.config.userPromptTemplate,
          inputSchema: { required: ['task', 'workspace'] },
        },
      });
      const stillPublished = await service.app.inject({
        method: 'GET',
        url: '/api/v1/agents',
        headers,
      });
      expect(
        stillPublished.json().items.find((item: { id: string }) => item.id === legacy.id),
      ).toMatchObject({ appliedScopeMissing: true });
      await post(`/api/v1/agents/${legacy.id}/apply`, {
        expectedRevision: updatedDraft.draftRevision,
      });
      const republished = await service.app.inject({
        method: 'GET',
        url: '/api/v1/agents',
        headers,
      });
      expect(
        republished.json().items.find((item: { id: string }) => item.id === legacy.id),
      ).toMatchObject({
        appliedScopeMissing: false,
      });

      const fresh = await post('/api/v1/agents', {
        displayName: 'Fresh coding agent',
        toolName: 'fresh_coding_agent',
        config: {
          ...coding!.config,
          modelRef: model.id,
          runtime: {
            ...coding!.config.runtime,
            workspacePolicy: { mode: 'fixed', allowedRoots: [dir] },
          },
        },
      });
      const accepted = await post(`/api/v1/agents/${fresh.id}/test-runs`, {
        expectedRevision: fresh.draftRevision,
        input: { task: 'inspect', scope: 'UNIQUE_SCOPE_281', workspace: 'project-a' },
      });
      const run = await waitForRun(service.app, headers, accepted.runId);
      expect(run.status).toBe('completed');
      const modelMessages = requests[0].messages;
      expect(modelMessages.find((message) => message.role === 'user')?.content).toContain(
        'UNIQUE_SCOPE_281',
      );
      expect(modelMessages.find((message) => message.role === 'system')?.content).toContain(
        '작업 대상 위치는 이 기준을 바꾸지 않습니다',
      );
    } finally {
      await service.close();
      await new Promise<void>((resolve) => mock.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manages sanitized user templates, selective apply, duplicate, and soft delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p6-template-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const templatesResponse = await service.app.inject({
      method: 'GET',
      url: '/api/v1/templates',
      headers,
    });
    const builtinTemplates = (
      JSON.parse(templatesResponse.body) as {
        items: Array<{ id: string; origin: string; name: string }>;
      }
    ).items.filter((template) => template.origin === 'builtin');
    expect(builtinTemplates.map((template) => template.name)).toEqual([
      '문서 요약',
      '설계 검토',
      '일반 응답',
      '코드 구현',
      '코드 조사',
    ]);
    const builtinDelete = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/templates/${builtinTemplates[0].id}`,
      headers,
    });
    expect(builtinDelete.statusCode).toBe(409);

    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Template provider',
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
          payload: { providerId: provider.id, modelId: 'template-model' },
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
            displayName: 'Template source',
            toolName: 'template_source',
            config: {
              modelRef: model.id,
              description: 'source description',
              systemPrompt: 'source prompt',
              userPromptTemplate: '{{input.task}}',
              runtime: {
                mode: 'tools',
                tools: ['read_file', 'run_command'],
                workspacePolicy: { mode: 'fixed', allowedRoots: [dir] },
                commands: [{ commandId: 'node', executable: process.execPath }],
              },
            },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };

    const createdTemplateResponse = await service.app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      headers,
      payload: { name: 'Personal template', agentId: agent.id },
    });
    expect(createdTemplateResponse.statusCode).toBe(201);
    const createdTemplate = JSON.parse(createdTemplateResponse.body) as {
      id: string;
      version: number;
      config: {
        modelRef: string | null;
        systemPrompt: string;
        runtime: {
          tools: string[];
          workspacePolicy: { mode: string; allowedRoots: string[] };
          commands: unknown[];
        };
      };
    };
    expect(createdTemplate.config).toMatchObject({
      modelRef: null,
      runtime: {
        tools: ['read_file'],
        workspacePolicy: { mode: 'none', allowedRoots: [] },
        commands: [],
      },
    });
    const templateConflict = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/templates/${createdTemplate.id}`,
      headers,
      payload: { expectedVersion: 0, name: 'conflict' },
    });
    expect(templateConflict.statusCode).toBe(409);
    const templateUpdateResponse = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/templates/${createdTemplate.id}`,
      headers,
      payload: {
        expectedVersion: createdTemplate.version,
        name: 'Updated personal template',
        config: { ...createdTemplate.config, systemPrompt: 'updated template prompt' },
      },
    });
    expect(templateUpdateResponse.statusCode).toBe(200);
    const templateUpdate = JSON.parse(templateUpdateResponse.body) as {
      id: string;
      version: number;
    };
    expect(templateUpdate.version).toBe(2);

    const preview = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/template-preview`,
      headers,
      payload: { templateId: createdTemplate.id, sections: ['prompts'] },
    });
    expect(JSON.parse(preview.body)).toMatchObject({
      sections: ['prompts'],
      changes: [{ section: 'prompts', changed: true }],
    });
    const appliedTemplateResponse = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/template-apply`,
      headers,
      payload: {
        templateId: createdTemplate.id,
        sections: ['prompts'],
        expectedRevision: agent.draftRevision,
      },
    });
    expect(appliedTemplateResponse.statusCode).toBe(200);
    const appliedTemplate = JSON.parse(appliedTemplateResponse.body) as {
      draftRevision: number;
      draft: {
        modelRef: string;
        systemPrompt: string;
        runtime: { workspacePolicy: { allowedRoots: string[] }; commands: unknown[] };
      };
    };
    expect(appliedTemplate.draft).toMatchObject({
      modelRef: model.id,
      systemPrompt: 'updated template prompt',
      runtime: {
        workspacePolicy: { allowedRoots: [dir] },
        commands: [{ commandId: 'node', executable: process.execPath }],
      },
    });

    const applyVersion = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/apply`,
      headers,
      payload: { expectedRevision: appliedTemplate.draftRevision },
    });
    expect(applyVersion.statusCode).toBe(201);
    const renameApplied = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${agent.id}`,
      headers,
      payload: { expectedRevision: appliedTemplate.draftRevision, toolName: 'renamed_source' },
    });
    expect(renameApplied.statusCode).toBe(409);
    const duplicateResponse = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/duplicate`,
      headers,
      payload: { toolName: 'template_copy' },
    });
    expect(duplicateResponse.statusCode).toBe(201);
    const duplicate = JSON.parse(duplicateResponse.body) as {
      id: string;
      toolName: string;
      enabled: boolean;
      appliedVersionId: string | null;
      draft: { modelRef: string };
    };
    expect(duplicate).toMatchObject({
      toolName: 'template_copy',
      enabled: false,
      appliedVersionId: null,
      draft: { modelRef: model.id },
    });
    const deleteDuplicate = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${duplicate.id}`,
      headers,
    });
    expect(deleteDuplicate.statusCode).toBe(204);
    const reuseDeletedName = await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        displayName: 'Reuse attempt',
        toolName: 'template_copy',
        config: { modelRef: model.id },
      },
    });
    expect(reuseDeletedName.statusCode).toBe(201);
    const reused = JSON.parse(reuseDeletedName.body) as {
      id: string;
      enabled: boolean;
      appliedVersionId: string | null;
    };
    expect(reused.id).not.toBe(duplicate.id);
    expect(reused).toMatchObject({ enabled: false, appliedVersionId: null });
    const liveNameConflict = await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        displayName: 'Collision',
        toolName: 'template_copy',
        config: { modelRef: model.id },
      },
    });
    expect(liveNameConflict.statusCode).toBe(409);
    const simultaneous = await Promise.all(
      [1, 2].map((index) =>
        service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: `Concurrent ${index}`,
            toolName: 'concurrent_copy',
            config: { modelRef: model.id },
          },
        }),
      ),
    );
    expect(simultaneous.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    await service.app.inject({
      method: 'PUT',
      url: `/api/v1/agents/${agent.id}/activation`,
      headers,
      payload: { enabled: true },
    });
    const deleteActive = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agent.id}`,
      headers,
    });
    expect(deleteActive.statusCode).toBe(409);
    const deleteTemplate = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/templates/${createdTemplate.id}`,
      headers,
    });
    expect(deleteTemplate.statusCode).toBe(204);

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('discards saved draft changes from the exact applied version without changing publication state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-draft-discard-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };
    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Discard provider',
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
          payload: { providerId: provider.id, modelId: 'discard-model' },
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
            displayName: 'Discard source',
            toolName: 'discard_source',
            config: { modelRef: model.id, systemPrompt: 'published prompt' },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number; draft: Record<string, unknown> };
    const applied = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: `/api/v1/agents/${agent.id}/apply`,
          headers,
          payload: { expectedRevision: agent.draftRevision },
        })
      ).body,
    ) as { versionId: string };
    await service.app.inject({
      method: 'PUT',
      url: `/api/v1/agents/${agent.id}/activation`,
      headers,
      payload: { enabled: true },
    });
    const changed = JSON.parse(
      (
        await service.app.inject({
          method: 'PATCH',
          url: `/api/v1/agents/${agent.id}`,
          headers,
          payload: {
            expectedRevision: agent.draftRevision,
            displayName: 'Renamed source',
            config: { ...agent.draft, systemPrompt: 'draft-only prompt' },
          },
        })
      ).body,
    ) as { draftRevision: number };
    const stale = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/draft-discard`,
      headers,
      payload: { expectedRevision: agent.draftRevision },
    });
    expect(stale.statusCode).toBe(409);
    const discardedResponse = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agent.id}/draft-discard`,
      headers,
      payload: { expectedRevision: changed.draftRevision },
    });
    expect(discardedResponse.statusCode).toBe(200);
    expect(JSON.parse(discardedResponse.body)).toMatchObject({
      displayName: 'Renamed source',
      toolName: 'discard_source',
      enabled: true,
      appliedVersionId: applied.versionId,
      draftRevision: changed.draftRevision + 1,
      draft: { systemPrompt: 'published prompt' },
    });

    const unapplied = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers,
          payload: {
            displayName: 'Unapplied draft',
            toolName: 'unapplied_draft',
            config: { modelRef: model.id },
          },
        })
      ).body,
    ) as { id: string; draftRevision: number };
    const unappliedDiscard = await service.app.inject({
      method: 'POST',
      url: `/api/v1/agents/${unapplied.id}/draft-discard`,
      headers,
      payload: { expectedRevision: unapplied.draftRevision },
    });
    expect(unappliedDiscard.statusCode).toBe(409);

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
