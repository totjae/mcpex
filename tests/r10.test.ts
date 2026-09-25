import { describe, expect, it, vi } from 'vitest';
import {
  Client,
  InMemoryTransport,
  type CallToolRequestParams,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { ToolCatalogBridge, type BackendClient } from '../apps/cli/src/tool-bridge.js';

describe('R10 dynamic STDIO tool catalog', () => {
  it('can activate tools after connecting with an empty catalog', async () => {
    let tools: Tool[] = [];
    const bridge = new ToolCatalogBridge({
      listTools: async () => ({ tools }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await bridge.refresh();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-catalog', version: '1' });
    await bridge.server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools).toEqual([]);
    tools = [{ name: 'enabled_later', inputSchema: { type: 'object' } }];
    await bridge.refresh();
    expect(
      (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((t) => t.name),
    ).toEqual(['enabled_later']);
    await client.close();
    await bridge.server.close();
  });
  it('adds, updates, removes, and forwards tools after the backend catalog changes', async () => {
    let tools: Tool[] = [
      {
        name: 'first_tool',
        description: 'first',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ];
    const calls: CallToolRequestParams[] = [];
    let refreshRequests = 0;
    const backend = {
      listTools: async (_params, options) => {
        if (options?.cacheMode === 'refresh') refreshRequests++;
        return { tools: structuredClone(tools) };
      },
      callTool: async (params) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text: `forwarded:${params.name}` }],
        } as CallToolResult;
      },
    } satisfies BackendClient;

    const bridge = new ToolCatalogBridge(backend);
    expect(await bridge.refresh()).toBe(true);
    expect(await bridge.refresh()).toBe(false);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let notifications = 0;
    const client = new Client(
      { name: 'r10-client', version: '0.1.0' },
      {
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error) => {
              expect(error).toBeNull();
              notifications++;
            },
          },
        },
      },
    );
    await bridge.server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['first_tool']);

    tools = [
      {
        name: 'second_tool',
        description: 'second',
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ];
    expect(await bridge.refresh()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((tool) => tool.name),
    ).toEqual(['second_tool']);
    const result = await client.callTool({
      name: 'second_tool',
      arguments: {},
      _meta: {
        'io.mcpex/workspace': 'C:\\workspace',
        'untrusted.example/metadata': 'do-not-forward',
      },
    });
    expect(JSON.stringify(result)).toContain('forwarded:second_tool');
    expect(calls).toEqual([
      {
        name: 'second_tool',
        arguments: {},
        _meta: { 'io.mcpex/workspace': 'C:\\workspace' },
      },
    ]);
    expect(refreshRequests).toBeGreaterThanOrEqual(3);
    expect(notifications).toBeGreaterThan(0);

    await client.close();
    await bridge.server.close();
  });
  it('uses the advertised server budget for backend calls beyond the SDK 60-second default', async () => {
    const options: Array<{ timeout?: number }> = [];
    const bridge = new ToolCatalogBridge({
      listTools: async () => ({
        tools: [
          {
            name: 'slow_tool',
            inputSchema: { type: 'object' },
            _meta: { 'io.mcpex/bridgeTimeoutMs': 135000, 'example/private': 'not-forwarded' },
          },
        ],
      }),
      callTool: async (_params, requestOptions) => {
        options.push(requestOptions ?? {});
        await new Promise((resolve) => setTimeout(resolve, 61_000));
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    await bridge.refresh();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'timeout-test', version: '1' });
    await bridge.server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools[0]?._meta?.['io.mcpex/bridgeTimeoutMs']).toBe(135000);
    expect((await client.listTools()).tools[0]?._meta?.['example/private']).toBeUndefined();
    vi.useFakeTimers();
    try {
      const result = client.callTool({ name: 'slow_tool', arguments: {} }, { timeout: 75_000 });
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await result).content).toMatchObject([{ text: 'done' }]);
      expect(options[0]?.timeout).toBe(135000);
    } finally {
      vi.useRealTimers();
    }
    await client.close();
    await bridge.server.close();
  });
});
