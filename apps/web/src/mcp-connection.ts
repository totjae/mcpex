export type McpRegistration = {
  command: string;
  args: string[];
  environment?: Record<string, string>;
};

export type CodexRegistrationGuide = {
  name: 'mcpex';
  type: 'STDIO';
  command: string;
  args: string[];
  environment: Array<{ key: string; value: string }>;
  environmentPassThrough: string[];
  cwd: null;
  configToml: string;
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexRegistrationGuide(registration: McpRegistration): CodexRegistrationGuide {
  const environment = Object.entries(registration.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
  const lines = [
    '[mcp_servers.mcpex]',
    `command = ${tomlString(registration.command)}`,
    `args = [${registration.args.map(tomlString).join(', ')}]`,
  ];
  if (environment.length) {
    lines.push('', '[mcp_servers.mcpex.env]');
    for (const entry of environment) lines.push(`${entry.key} = ${tomlString(entry.value)}`);
  }
  return {
    name: 'mcpex',
    type: 'STDIO',
    command: registration.command,
    args: [...registration.args],
    environment,
    environmentPassThrough: [],
    cwd: null,
    configToml: lines.join('\n'),
  };
}
