import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError, WorkspaceTools } from '@mcpex/tools';

describe('R12 bounded tool memory and results', () => {
  it('rejects oversized reads and skips oversized files during bounded search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-r12-search-'));
    writeFileSync(join(root, 'large.txt'), `needle:${'x'.repeat(4096)}`);
    writeFileSync(join(root, 'small.txt'), 'needle:small');
    const tools = new WorkspaceTools(root, {
      maxReadBytes: 128,
      maxResultBytes: 1024,
    });

    await expect(tools.readFile('large.txt')).rejects.toMatchObject<ToolError>({
      code: 'READ_LIMIT',
    });
    const result = await tools.searchText('.', 'needle');
    expect(result.matches).toEqual([{ path: 'small.txt', line: 1, text: 'needle:small' }]);
    expect(result.observation.truncated).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it('caps the complete search match payload and truncates a matching line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-r12-result-'));
    writeFileSync(join(root, 'match.txt'), `needle:${'y'.repeat(2048)}`);
    const tools = new WorkspaceTools(root, {
      maxReadBytes: 4096,
      maxResultBytes: 160,
    });

    const result = await tools.searchText('.', 'needle');
    expect(Buffer.byteLength(JSON.stringify(result.matches))).toBeLessThanOrEqual(160);
    expect(result.matches[0]?.text.startsWith('needle:')).toBe(true);
    expect(result.matches[0]?.text.length).toBeLessThan(2048);
    expect(result.observation).toMatchObject({ truncated: true });
    expect(result.observation.originalBytes).toBeGreaterThan(160);

    rmSync(root, { recursive: true, force: true });
  });

  it('caps the serialized file listing in addition to the item count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-r12-list-'));
    for (let index = 0; index < 20; index++) {
      writeFileSync(join(root, `long-file-name-${index.toString().padStart(3, '0')}.txt`), 'x');
    }
    const tools = new WorkspaceTools(root, { maxResultBytes: 180, maxListResults: 100 });

    const result = await tools.listFiles('.');
    expect(Buffer.byteLength(JSON.stringify(result.items))).toBeLessThanOrEqual(180);
    expect(result.items.length).toBeLessThan(20);
    expect(result.observation.truncated).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it('caps stdout and stderr while the command is still producing output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpex-r12-command-'));
    const tools = new WorkspaceTools(root, { maxResultBytes: 1024 }, [
      { commandId: 'node-output', executable: process.execPath },
    ]);
    const result = await tools.runCommand('node-output', [
      '-e',
      'process.stdout.write("a".repeat(262144));process.stderr.write("b".repeat(262144))',
    ]);

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1024,
    );
    expect(result.observation).toEqual({ truncated: true, originalBytes: 524288 });

    rmSync(root, { recursive: true, force: true });
  });
});
