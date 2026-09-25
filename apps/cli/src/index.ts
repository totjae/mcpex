#!/usr/bin/env node
import { createServer, getLocalAccessTokenAsync, installGracefulShutdown } from '@mcpex/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ToolCatalogBridge } from './tool-bridge.js';
import { ensureService } from './service-lifecycle.js';
const command = process.argv[2] ?? 'serve';
const dataDir = process.env.MCPEX_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? '.mcpex'}/MCPex`;
const port = Number(process.env.MCPEX_PORT ?? 47831);
const serviceBaseUrl = (process.env.MCPEX_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
const cliEntryPath = fileURLToPath(import.meta.url);
const mcpEnvironment = Object.fromEntries(
  ['MCPEX_DATA_DIR', 'MCPEX_PORT', 'MCPEX_URL', 'MCPEX_MCP_URL']
    .map((name) => [name, process.env[name]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined),
);
if (command === 'serve') {
  const { app, close } = await createServer(dataDir, {
    mcpConnection: {
      command: process.execPath,
      args: [cliEntryPath, 'mcp'],
      ...(Object.keys(mcpEnvironment).length ? { environment: mcpEnvironment } : {}),
    },
  });
  try {
    await app.listen({ host: '127.0.0.1', port });
  } catch (error) {
    await close();
    throw error;
  }
  installGracefulShutdown(close);
  console.log(`MCPex listening on ${serviceBaseUrl}`);
} else if (command === 'open') {
  await ensureService({ baseUrl: serviceBaseUrl, dataDir, port });
  const response = await fetch(`${serviceBaseUrl}/auth/bootstrap`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await getLocalAccessTokenAsync(dataDir)}` },
  });
  if (!response.ok) throw new Error(`MCPex bootstrap failed: HTTP ${response.status}`);
  const result = (await response.json()) as { token: string };
  const target = `${serviceBaseUrl}/#token=${encodeURIComponent(result.token)}`;
  const launcher =
    process.platform === 'win32'
      ? {
          executable: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference = 'Stop'; try { Start-Process -FilePath $env:MCPEX_BROWSER_URL } catch { exit 1 }",
          ],
        }
      : process.platform === 'darwin'
        ? { executable: 'open', args: [target] }
        : { executable: 'xdg-open', args: [target] };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher.executable, launcher.args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, MCPEX_BROWSER_URL: target },
    });
    child.once('error', () => reject(new Error('Could not start the default browser launcher.')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            'Could not open the default browser. Check the Windows default HTTP browser setting.',
          ),
        );
    });
  });
  console.log(`MCPex settings sent to the default browser at ${serviceBaseUrl}`);
} else if (command === 'mcp') {
  const mcpUrl = new URL(process.env.MCPEX_MCP_URL ?? `${serviceBaseUrl}/mcp`);
  await ensureService({ baseUrl: mcpUrl.origin, dataDir, port });
  const client = new Client({ name: 'mcpex-stdio-bridge', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      authProvider: { token: async () => getLocalAccessTokenAsync(dataDir) },
    }),
  );
  const bridge = new ToolCatalogBridge(client);
  await bridge.refresh();
  await bridge.server.connect(new StdioServerTransport());
  bridge.startPolling(Number(process.env.MCPEX_CATALOG_POLL_MS ?? 1000), (error) =>
    console.error(error instanceof Error ? error.message : String(error)),
  );
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
