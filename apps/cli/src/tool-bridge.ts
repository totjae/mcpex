import type {
  CacheableRequestOptions,
  CallToolRequestParams,
  CallToolResult,
  Client,
  ListToolsRequest,
  ListToolsResult,
  Tool,
} from '@modelcontextprotocol/client';
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type RegisteredTool,
} from '@modelcontextprotocol/server';

export type BackendClient = Pick<Client, 'callTool'> & {
  listTools(
    params?: ListToolsRequest['params'],
    options?: CacheableRequestOptions,
  ): Promise<ListToolsResult>;
};

function toolFingerprint(tool: Tool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    bridgeTimeoutMs: tool._meta?.['io.mcpex/bridgeTimeoutMs'],
  });
}

export class ToolCatalogBridge {
  readonly server = new McpServer(
    { name: 'mcpex-stdio-bridge', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  private readonly registered = new Map<string, { handle: RegisteredTool; fingerprint: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

  constructor(private readonly backend: BackendClient) {}

  private register(tool: Tool): RegisteredTool {
    const advertisedTimeout = tool._meta?.['io.mcpex/bridgeTimeoutMs'];
    const bridgeTimeout =
      typeof advertisedTimeout === 'number' &&
      Number.isSafeInteger(advertisedTimeout) &&
      advertisedTimeout >= 1000 &&
      advertisedTimeout <= 7_215_000
        ? advertisedTimeout
        : undefined;
    return this.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        ...(tool.outputSchema
          ? {
              outputSchema: fromJsonSchema<Record<string, unknown>>(
                tool.outputSchema as JsonSchemaType,
              ),
            }
          : {}),
        annotations: tool.annotations,
        ...(bridgeTimeout ? { _meta: { 'io.mcpex/bridgeTimeoutMs': bridgeTimeout } } : {}),
      },
      async (input, context) => {
        const workspace = context.mcpReq._meta?.['io.mcpex/workspace'];
        const params: CallToolRequestParams = {
          name: tool.name,
          arguments: input,
          ...(typeof workspace === 'string' ? { _meta: { 'io.mcpex/workspace': workspace } } : {}),
        };
        return this.backend.callTool(params, {
          signal: context.mcpReq.signal,
          ...(bridgeTimeout ? { timeout: bridgeTimeout } : {}),
        }) as Promise<CallToolResult>;
      },
    );
  }

  async refresh(): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const listed = await this.backend.listTools(undefined, { cacheMode: 'refresh' });
      const incoming = new Map(listed.tools.map((tool) => [tool.name, tool]));
      let changed = false;
      for (const [name, current] of this.registered) {
        if (!incoming.has(name)) {
          current.handle.remove();
          this.registered.delete(name);
          changed = true;
        }
      }
      for (const tool of listed.tools) {
        const fingerprint = toolFingerprint(tool);
        const current = this.registered.get(tool.name);
        if (current?.fingerprint === fingerprint) continue;
        current?.handle.remove();
        this.registered.set(tool.name, { handle: this.register(tool), fingerprint });
        changed = true;
      }
      return changed;
    } finally {
      this.refreshing = false;
    }
  }

  startPolling(intervalMs = 1000, onError: (error: unknown) => void = () => undefined): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(onError), Math.max(100, intervalMs));
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
