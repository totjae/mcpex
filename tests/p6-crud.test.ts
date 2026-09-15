import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, getLocalAccessToken } from '@mcpex/server';

describe('P6 provider and model management', () => {
  it('supports detail, revision updates, credential removal, and reference-safe deletion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-p6-crud-'));
    const service = await createServer(dir);
    const headers = { authorization: `Bearer ${getLocalAccessToken(dir)}` };

    const provider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Editable provider',
            adapter: 'openai-chat',
            baseUrl: 'http://127.0.0.1:12345',
          },
        })
      ).body,
    ) as { id: string; revision: number };
    const providerDetail = await service.app.inject({
      method: 'GET',
      url: `/api/v1/providers/${provider.id}`,
      headers,
    });
    expect(providerDetail.statusCode).toBe(200);
    expect(JSON.parse(providerDetail.body)).toMatchObject({
      name: 'Editable provider',
      hasCredential: false,
    });
    const providerConflict = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${provider.id}`,
      headers,
      payload: { expectedRevision: 0, name: 'conflict' },
    });
    expect(providerConflict.statusCode).toBe(409);
    const providerUpdate = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${provider.id}`,
      headers,
      payload: {
        expectedRevision: provider.revision,
        name: 'Updated provider',
        requestTimeoutMs: 2500,
        maxConcurrency: 1,
        resourceGroup: 'local-test',
        resourceGroupConcurrency: 1,
      },
    });
    expect(providerUpdate.statusCode).toBe(200);
    expect(JSON.parse(providerUpdate.body)).toMatchObject({
      name: 'Updated provider',
      requestTimeoutMs: 2500,
      maxConcurrency: 1,
      resourceGroup: 'local-test',
      revision: 2,
    });
    const credential = await service.app.inject({
      method: 'PUT',
      url: `/api/v1/providers/${provider.id}/credential`,
      headers,
      payload: { apiKey: 'test-only-secret' },
    });
    expect(JSON.parse(credential.body)).toMatchObject({ hasCredential: true, revision: 3 });
    const credentialDelete = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${provider.id}/credential`,
      headers,
    });
    expect(JSON.parse(credentialDelete.body)).toEqual({ hasCredential: false, revision: 4 });

    const disposableModel = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'disposable' },
        })
      ).body,
    ) as { id: string; revision: number };
    const modelDetail = await service.app.inject({
      method: 'GET',
      url: `/api/v1/models/${disposableModel.id}`,
      headers,
    });
    expect(modelDetail.statusCode).toBe(200);
    const modelConflict = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${disposableModel.id}`,
      headers,
      payload: { expectedRevision: 0, label: 'conflict' },
    });
    expect(modelConflict.statusCode).toBe(409);
    const modelUpdate = await service.app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${disposableModel.id}`,
      headers,
      payload: {
        expectedRevision: disposableModel.revision,
        label: 'Updated model',
        defaultGeneration: { temperature: 0.3, maxOutputTokens: 50 },
      },
    });
    expect(modelUpdate.statusCode).toBe(200);
    expect(JSON.parse(modelUpdate.body)).toMatchObject({
      label: 'Updated model',
      defaultGeneration: { temperature: 0.3, maxOutputTokens: 50 },
      revision: 2,
    });
    const modelDelete = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/models/${disposableModel.id}`,
      headers,
    });
    expect(modelDelete.statusCode).toBe(204);

    const referencedModel = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/models',
          headers,
          payload: { providerId: provider.id, modelId: 'referenced' },
        })
      ).body,
    ) as { id: string };
    await service.app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        displayName: 'Reference holder',
        toolName: 'reference_holder',
        config: { modelRef: referencedModel.id },
      },
    });
    const referencedDelete = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/models/${referencedModel.id}`,
      headers,
    });
    expect(referencedDelete.statusCode).toBe(409);
    const providerDeleteConflict = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${provider.id}`,
      headers,
    });
    expect(providerDeleteConflict.statusCode).toBe(409);

    const emptyProvider = JSON.parse(
      (
        await service.app.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers,
          payload: {
            name: 'Empty provider',
            adapter: 'openai-chat',
            baseUrl: 'http://127.0.0.1:12346',
          },
        })
      ).body,
    ) as { id: string };
    const providerDelete = await service.app.inject({
      method: 'DELETE',
      url: `/api/v1/providers/${emptyProvider.id}`,
      headers,
    });
    expect(providerDelete.statusCode).toBe(204);

    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
