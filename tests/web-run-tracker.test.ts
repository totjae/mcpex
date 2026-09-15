import { describe, expect, it, vi } from 'vitest';
import { isTerminalRunStatus, pollRun } from '../apps/web/src/run-tracker.js';

describe('test run polling', () => {
  it('reports active states and resolves at the first terminal state', async () => {
    const runs = [{ status: 'queued' }, { status: 'running' }, { status: 'completed' }];
    const updates: string[] = [];
    const result = await pollRun({
      load: async () => runs.shift()!,
      onUpdate: (run) => updates.push(run.status),
      signal: new AbortController().signal,
      intervalMs: 0,
    });
    expect(result.status).toBe('completed');
    expect(updates).toEqual(['queued', 'running', 'completed']);
  });

  it('stops immediately after cancellation without a late update', async () => {
    const controller = new AbortController();
    const update = vi.fn();
    controller.abort();
    await expect(
      pollRun({
        load: async () => ({ status: 'completed' }),
        onUpdate: update,
        signal: controller.signal,
        intervalMs: 0,
      }),
    ).rejects.toBeDefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('distinguishes every known terminal outcome', () => {
    expect(isTerminalRunStatus('queued')).toBe(false);
    expect(isTerminalRunStatus('running')).toBe(false);
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])
      expect(isTerminalRunStatus(status)).toBe(true);
  });
});
