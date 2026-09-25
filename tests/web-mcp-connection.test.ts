import { describe, expect, it } from 'vitest';
import { codexRegistrationGuide } from '../apps/web/src/mcp-connection.js';

describe('Codex MCP registration guide', () => {
  it('keeps field copy values raw and builds a valid escaped TOML snippet', () => {
    const command = 'C:\\Program Files\\nodejs\\node.exe';
    const cliPath = 'C:\\MCPex Project\\apps\\cli\\dist\\src\\index.js';
    const guide = codexRegistrationGuide({
      command,
      args: [cliPath, 'mcp'],
      environment: {
        MCPEX_PORT: '47831',
        MCPEX_DATA_DIR: 'C:\\MCPex Data',
      },
    });

    expect(guide).toMatchObject({
      name: 'mcpex',
      type: 'STDIO',
      command,
      args: [cliPath, 'mcp'],
      environmentPassThrough: [],
      cwd: null,
    });
    expect(guide.environment).toEqual([
      { key: 'MCPEX_DATA_DIR', value: 'C:\\MCPex Data' },
      { key: 'MCPEX_PORT', value: '47831' },
    ]);
    expect(guide.args[0]).not.toContain('"');
    expect(guide.args[0]).not.toContain('\\\\');
    expect(guide.configToml).toContain('[mcp_servers.mcpex]');
    expect(guide.configToml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(guide.configToml).toContain(
      'args = ["C:\\\\MCPex Project\\\\apps\\\\cli\\\\dist\\\\src\\\\index.js", "mcp"]',
    );
    expect(guide.configToml).toContain('[mcp_servers.mcpex.env]');
  });

  it('omits empty optional sections from the full config', () => {
    const guide = codexRegistrationGuide({ command: 'node', args: ['index.js', 'mcp'] });
    expect(guide.environment).toEqual([]);
    expect(guide.configToml).toBe(
      '[mcp_servers.mcpex]\ncommand = "node"\nargs = ["index.js", "mcp"]',
    );
  });
});
