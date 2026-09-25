import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsyncDpapiSecretStore } from '@mcpex/storage';
import { getLocalAccessTokenAsync } from '@mcpex/server';

describe.skipIf(process.platform !== 'win32')('RTA-02 asynchronous DPAPI', () => {
  it('yields to the event loop and preserves concurrent secret writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-rta02-'));
    try {
      const first = new AsyncDpapiSecretStore(dir);
      const second = new AsyncDpapiSecretStore(dir);
      let timerRan = false;
      const writes = Promise.all([first.set('one', 'alpha'), second.set('two', 'beta')]);
      setTimeout(() => {
        timerRan = true;
      }, 0);
      await writes;
      expect(timerRan).toBe(true);
      expect(await first.get('one')).toBe('alpha');
      expect(await second.get('two')).toBe('beta');
      expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('alpha');
      await Promise.all([first.delete('one'), second.set('three', 'gamma')]);
      expect(await first.get('one')).toBeUndefined();
      expect(await second.get('two')).toBe('beta');
      expect(await first.get('three')).toBe('gamma');
      const tokens = await Promise.all([
        getLocalAccessTokenAsync(dir),
        getLocalAccessTokenAsync(dir),
      ]);
      expect(tokens[0]).toBe(tokens[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
