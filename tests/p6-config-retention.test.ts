import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';
import { Storage, type AgentRow, type RunRow } from '@mcpex/storage';

const auth = (dir: string) => ({ authorization: `Bearer ${getLocalAccessToken(dir)}` });

describe('P6 configuration transfer, retention, and backup', () => {
  it('purges expired records in bounded batches without touching a running run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-rta08-'));
    try {
      const storage = new Storage(dir);
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      storage.createAgent({
        id: 'batch-agent',
        display_name: 'Batch',
        tool_name: 'batch_agent',
        enabled: 0,
        draft_json: '{}',
        draft_revision: 1,
        applied_version_id: null,
        deleted_at: null,
        created_at: old,
        updated_at: old,
      });
      for (let index = 0; index < 206; index++)
        storage.createRun({
          id: `batch-${index}`,
          agent_id: 'batch-agent',
          agent_version_id: null,
          source: 'test',
          status: index === 205 ? 'running' : 'completed',
          input_json: '{"secret":"remove"}',
          output_json: null,
          error_json: null,
          created_at: old,
          finished_at: old,
          config_snapshot_json: null,
        });
      expect(storage.purgeExpiredRunContentBatch(cutoff)).toMatchObject({ runs: 100 });
      expect(storage.purgeExpiredRunContentBatch(cutoff)).toMatchObject({ runs: 100 });
      expect(storage.purgeExpiredRunContentBatch(cutoff)).toMatchObject({ runs: 5 });
      expect(storage.getRun('batch-205')?.content_purged_at).toBeNull();
      expect(storage.getRun('batch-204')?.content_purged_at).toEqual(expect.any(String));
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('exports sanitized settings and imports remapped inactive drafts atomically', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'mcpex-p6-export-'));
    const source = await createServer(sourceDir);
    const sourceHeaders = auth(sourceDir);
    const provider = JSON.parse(
      (
        await source.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers: sourceHeaders,
          payload: {
            name: 'Portable provider',
            adapter: 'openai-chat',
            baseUrl: 'http://127.0.0.1:12345',
            headers: { 'X-Mode': 'portable', Authorization: 'Bearer header-secret' },
            extraBody: { apiKey: 'body-secret', safeOption: true },
          },
        })
      ).body,
    ) as { id: string };
    await source.app.inject({
      method: 'PUT',
      url: `/api/v1/providers/${provider.id}/credential`,
      headers: sourceHeaders,
      payload: { apiKey: 'credential-secret' },
    });
    const model = JSON.parse(
      (
        await source.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers: sourceHeaders,
          payload: { providerId: provider.id, modelId: 'portable-model' },
        })
      ).body,
    ) as { id: string };
    const agent = JSON.parse(
      (
        await source.app.inject({
          method: 'POST',
          url: '/api/v1/agents',
          headers: sourceHeaders,
          payload: {
            displayName: 'Portable agent',
            toolName: 'portable_agent',
            config: {
              modelRef: model.id,
              runtime: {
                mode: 'tools',
                tools: ['read_file', 'run_command'],
                workspacePolicy: { mode: 'fixed', allowedRoots: ['C:\\private-workspace'] },
                commands: [{ commandId: 'node', executable: process.execPath }],
              },
            },
          },
        })
      ).body,
    ) as { id: string };
    await source.app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      headers: sourceHeaders,
      payload: { name: 'Portable template', agentId: agent.id },
    });
    const exportedResponse = await source.app.inject({
      method: 'POST',
      url: '/api/v1/config/export',
      headers: sourceHeaders,
    });
    expect(exportedResponse.statusCode).toBe(200);
    expect(exportedResponse.body).not.toContain('credential-secret');
    expect(exportedResponse.body).not.toContain('header-secret');
    expect(exportedResponse.body).not.toContain('body-secret');
    expect(exportedResponse.body).not.toContain('private-workspace');
    expect(exportedResponse.body).not.toContain(process.execPath);
    const exported = JSON.parse(exportedResponse.body) as Record<string, unknown>;

    const conflictDir = mkdtempSync(join(tmpdir(), 'mcpex-p6-conflict-'));
    const conflictService = await createServer(conflictDir);
    const conflictHeaders = auth(conflictDir);
    await conflictService.app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: conflictHeaders,
      payload: {
        name: 'Portable provider',
        adapter: 'openai-chat',
        baseUrl: 'http://127.0.0.1:23456',
      },
    });
    const preview = await conflictService.app.inject({
      method: 'POST',
      url: '/api/v1/config/import-preview',
      headers: conflictHeaders,
      payload: { config: exported },
    });
    expect(JSON.parse(preview.body)).toMatchObject({
      canImport: false,
      conflicts: [{ kind: 'provider', field: 'name', value: 'Portable provider' }],
    });
    const rejected = await conflictService.app.inject({
      method: 'POST',
      url: '/api/v1/config/import',
      headers: conflictHeaders,
      payload: { config: exported, confirm: true },
    });
    expect(rejected.statusCode).toBe(409);
    expect(
      JSON.parse(
        (
          await conflictService.app.inject({
            method: 'GET',
            url: '/api/v1/agents',
            headers: conflictHeaders,
          })
        ).body,
      ).items,
    ).toHaveLength(0);

    const targetDir = mkdtempSync(join(tmpdir(), 'mcpex-p6-import-'));
    const targetSeed = new Storage(targetDir);
    const deletedAt = new Date().toISOString();
    targetSeed.createAgent({
      id: 'deleted-portable-agent',
      display_name: 'Deleted portable agent',
      tool_name: 'portable_agent',
      enabled: 0,
      draft_json: '{}',
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: deletedAt,
      created_at: deletedAt,
      updated_at: deletedAt,
    });
    targetSeed.close();
    const target = await createServer(targetDir);
    const targetHeaders = auth(targetDir);
    const acceptedPreview = await target.app.inject({
      method: 'POST',
      url: '/api/v1/config/import-preview',
      headers: targetHeaders,
      payload: { config: exported },
    });
    expect(JSON.parse(acceptedPreview.body)).toMatchObject({
      canImport: true,
      counts: { providers: 1, models: 1, agents: 1, templates: 1 },
    });
    const importedResponse = await target.app.inject({
      method: 'POST',
      url: '/api/v1/config/import',
      headers: targetHeaders,
      payload: { config: exported, confirm: true },
    });
    expect(importedResponse.statusCode).toBe(201);
    const imported = JSON.parse(importedResponse.body) as {
      mappings: { providers: Record<string, string>; models: Record<string, string> };
    };
    expect(imported.mappings.providers[provider.id]).not.toBe(provider.id);
    expect(imported.mappings.models[model.id]).not.toBe(model.id);
    const providers = JSON.parse(
      (
        await target.app.inject({
          method: 'GET',
          url: '/api/v1/providers',
          headers: targetHeaders,
        })
      ).body,
    ).items as Array<Record<string, unknown>>;
    expect(providers[0]).toMatchObject({ name: 'Portable provider', hasCredential: false });
    const models = JSON.parse(
      (
        await target.app.inject({
          method: 'GET',
          url: '/api/v1/models',
          headers: targetHeaders,
        })
      ).body,
    ).items as Array<Record<string, unknown>>;
    expect(models[0].providerId).toBe(imported.mappings.providers[provider.id]);
    const agents = JSON.parse(
      (
        await target.app.inject({
          method: 'GET',
          url: '/api/v1/agents',
          headers: targetHeaders,
        })
      ).body,
    ).items as Array<{ enabled: boolean; appliedVersionId: string | null; draft: AgentRow }>;
    expect(agents[0]).toMatchObject({ enabled: false, appliedVersionId: null });
    expect(agents[0].id).not.toBe('deleted-portable-agent');
    expect(agents[0].draft).toMatchObject({
      modelRef: null,
      runtime: {
        tools: ['read_file'],
        workspacePolicy: { mode: 'none', allowedRoots: [] },
        commands: [],
      },
    });
    const future = await target.app.inject({
      method: 'POST',
      url: '/api/v1/config/import-preview',
      headers: targetHeaders,
      payload: { ...exported, schemaVersion: 2 },
    });
    expect(future.statusCode).toBe(422);

    await source.close();
    await conflictService.close();
    await target.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(conflictDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }, 15_000);

  it('purges expired run content, returns 410 for events, and creates a readable backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p6-retention-'));
    const storage = new Storage(dir);
    const timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const agent: AgentRow = {
      id: 'retention-agent',
      display_name: 'Retention agent',
      tool_name: 'retention_agent',
      enabled: 0,
      draft_json: '{}',
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    storage.createAgent(agent);
    const run: RunRow = {
      id: 'expired-run',
      agent_id: agent.id,
      agent_version_id: null,
      source: 'ui',
      status: 'completed',
      input_json: JSON.stringify({ privateInput: 'remove-me' }),
      output_json: JSON.stringify({ value: 'remove-me' }),
      error_json: null,
      created_at: timestamp,
      finished_at: timestamp,
      config_snapshot_json: JSON.stringify({ privateConfig: 'remove-me' }),
    };
    storage.createRun(run);
    storage.finishRun(run.id, 'completed', run.output_json, null);
    storage.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(timestamp, run.id);
    storage.close();

    const service = await createServer(dir);
    const headers = auth(dir);
    const settings = await service.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers,
      payload: { retentionDays: 1, globalConcurrency: 3, maxPendingRuns: 50 },
    });
    expect(JSON.parse(settings.body)).toMatchObject({
      retentionDays: 1,
      globalConcurrency: 3,
      maxPendingRuns: 50,
      purged: { runs: 1 },
    });
    const detail = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}`,
      headers,
    });
    expect(JSON.parse(detail.body)).toMatchObject({
      input: {},
      output: null,
      error: null,
      configSnapshot: null,
    });
    expect(JSON.parse(detail.body).contentPurgedAt).toEqual(expect.any(String));
    const events = await service.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events`,
      headers,
    });
    expect(events.statusCode).toBe(410);
    expect(JSON.parse(events.body).error.code).toBe('EVENTS_EXPIRED');

    const backup = await service.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers,
    });
    expect(backup.statusCode).toBe(201);
    const backupResult = JSON.parse(backup.body) as { path: string; bytes: number };
    expect(backupResult.bytes).toBeGreaterThan(0);
    expect(existsSync(backupResult.path)).toBe(true);
    const restored = new DatabaseSync(backupResult.path, { readOnly: true });
    expect(restored.prepare("SELECT value FROM settings WHERE key='retentionDays'").get()).toEqual({
      value: '1',
    });
    restored.close();

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
