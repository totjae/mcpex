import { describe, expect, it } from 'vitest';
import { summarizeWorkspaceRuntime } from '../apps/web/src/workspace-policy.js';

describe('workspace policy effective tools', () => {
  it('reports selected tools as ineffective when workspace policy is disabled', () => {
    expect(
      summarizeWorkspaceRuntime({
        mode: 'tools',
        tools: ['read_file', 'write_file'],
        workspacePolicy: { mode: 'none' },
      }),
    ).toMatchObject({
      configuredTools: ['read_file', 'write_file'],
      effectiveTools: [],
      state: 'workspace_disabled',
    });
  });

  it('distinguishes fixed readiness from caller metadata requirements', () => {
    expect(
      summarizeWorkspaceRuntime({
        mode: 'tools',
        tools: ['read_file', 'run_command'],
        workspacePolicy: { mode: 'fixed' },
      }),
    ).toMatchObject({ effectiveTools: ['read_file', 'run_command'], state: 'fixed' });
    expect(
      summarizeWorkspaceRuntime({
        mode: 'tools',
        tools: ['read_file', 'unknown_tool'],
        workspacePolicy: { mode: 'caller' },
      }),
    ).toMatchObject({ effectiveTools: ['read_file'], state: 'caller_required' });
  });

  it('hides workspace tools in response-only mode', () => {
    expect(
      summarizeWorkspaceRuntime({
        mode: 'response',
        tools: ['read_file'],
        workspacePolicy: { mode: 'fixed' },
      }),
    ).toMatchObject({ effectiveTools: [], state: 'response_only' });
  });

  it('reports full access tools separately', () => {
    expect(
      summarizeWorkspaceRuntime({
        mode: 'tools',
        tools: ['read_file', 'write_file'],
        workspacePolicy: { mode: 'full' },
      }),
    ).toMatchObject({
      workspaceMode: 'full',
      effectiveTools: ['read_file', 'write_file'],
      state: 'full',
    });
  });
});
