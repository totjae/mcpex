import { describe, expect, it, vi } from 'vitest';
import { ensureService } from '../apps/cli/src/service-lifecycle.js';

const options = { baseUrl: 'http://127.0.0.1:47831', dataDir: 'unused-test-data', port: 47831 };

describe('automatic service startup', () => {
  it('reuses a ready service without launching another process', async () => {
    const start = vi.fn();
    await ensureService(options, { probe: async () => 'ready', start });
    expect(start).not.toHaveBeenCalled();
  });

  it('waits for a launched service before allowing the caller to connect', async () => {
    let probes = 0;
    const start = vi.fn(async () => undefined);
    await ensureService(options, {
      probe: async () => (++probes < 3 ? 'absent' : 'ready'),
      start,
      pause: async () => undefined,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(probes).toBe(3);
  });

  it('does not start a daemon when the endpoint returns an error', async () => {
    const start = vi.fn();
    await expect(
      ensureService(options, {
        probe: async () => {
          throw new Error('occupied');
        },
        start,
      }),
    ).rejects.toThrow('occupied');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start a local daemon for an unavailable remote endpoint', async () => {
    const start = vi.fn();
    await expect(
      ensureService(
        { ...options, baseUrl: 'https://example.invalid' },
        {
          probe: async () => 'absent',
          start,
        },
      ),
    ).rejects.toThrow('자동 시작');
    expect(start).not.toHaveBeenCalled();
  });

  it('bounds startup waiting instead of leaving MCP initialization hanging', async () => {
    await expect(
      ensureService(
        { ...options, startupTimeoutMs: 0 },
        {
          probe: async () => 'absent',
          start: async () => undefined,
          pause: async () => undefined,
        },
      ),
    ).rejects.toThrow('초과');
  });

  it('surfaces an immediate background startup failure without entering the polling timeout', async () => {
    const pause = vi.fn();
    await expect(
      ensureService(options, {
        probe: async () => 'absent',
        start: async () => {
          throw new Error('DATA_DIR_LOCKED');
        },
        pause,
      }),
    ).rejects.toThrow('DATA_DIR_LOCKED');
    expect(pause).not.toHaveBeenCalled();
  });
});
