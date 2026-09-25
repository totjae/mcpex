export const workspaceToolNames = [
  'list_files',
  'read_file',
  'search_text',
  'write_file',
  'replace_text',
  'run_command',
] as const;

export type WorkspaceToolName = (typeof workspaceToolNames)[number];
export type WorkspaceMode = 'none' | 'fixed' | 'caller' | 'full';
export type WorkspaceRuntimeSummary = {
  runtimeMode: 'response' | 'tools';
  workspaceMode: WorkspaceMode;
  configuredTools: WorkspaceToolName[];
  effectiveTools: WorkspaceToolName[];
  state: 'response_only' | 'no_tools' | 'workspace_disabled' | 'fixed' | 'caller_required' | 'full';
};

type RuntimeInput = {
  mode?: 'response' | 'tools';
  tools?: string[];
  workspacePolicy?: { mode?: WorkspaceMode };
};

export function summarizeWorkspaceRuntime(runtime: RuntimeInput = {}): WorkspaceRuntimeSummary {
  const runtimeMode = runtime.mode ?? 'response';
  const workspaceMode = runtime.workspacePolicy?.mode ?? 'none';
  const configuredTools = workspaceToolNames.filter((tool) => runtime.tools?.includes(tool));
  if (runtimeMode !== 'tools') {
    return {
      runtimeMode,
      workspaceMode,
      configuredTools,
      effectiveTools: [],
      state: 'response_only',
    };
  }
  if (!configuredTools.length) {
    return {
      runtimeMode,
      workspaceMode,
      configuredTools,
      effectiveTools: [],
      state: 'no_tools',
    };
  }
  if (workspaceMode === 'none') {
    return {
      runtimeMode,
      workspaceMode,
      configuredTools,
      effectiveTools: [],
      state: 'workspace_disabled',
    };
  }
  return {
    runtimeMode,
    workspaceMode,
    configuredTools,
    effectiveTools: configuredTools,
    state:
      workspaceMode === 'caller' ? 'caller_required' : workspaceMode === 'full' ? 'full' : 'fixed',
  };
}
