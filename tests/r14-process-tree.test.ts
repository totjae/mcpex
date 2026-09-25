import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { processTree, survivingTree, windowsProcessRows } from '@mcpex/tools';

it.skipIf(process.platform !== 'win32' || process.env.MCPEX_R14_OS_TEST !== '1')(
  'finds a real grandchild after its recorded parent and grandparent exit',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r14-'));
    const ready = join(dir, 'ready');
    const trigger = join(dir, 'trigger');
    const grandPid = join(dir, 'grand-pid');
    const stop = join(dir, 'stop');
    const grandCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(grandPid)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);setTimeout(()=>process.exit(0),15000);`;
    const childCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(timer);const c=spawn(process.execPath,['-e',${JSON.stringify(grandCode)}],{stdio:'ignore',detached:true});c.unref();process.exit(0)}},20);setTimeout(()=>process.exit(0),15000);`;
    const parentCode = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});c.on('exit',()=>process.exit(0));setTimeout(()=>process.exit(0),15000);`;
    const parent = spawn(process.execPath, ['-e', parentCode], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => parent.once('close', () => resolve()));
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
      const identities = processTree(await windowsProcessRows(), parent.pid!);
      // Windows may also include a console host process.
      expect(identities.length).toBeGreaterThanOrEqual(2);
      writeFileSync(trigger, 'go');
      await closed;
      await vi.waitFor(() => expect(existsSync(grandPid)).toBe(true), { timeout: 5000 });
      const pid = Number(readFileSync(grandPid, 'utf8'));
      const survivors = survivingTree(await windowsProcessRows(), identities);
      expect(survivors.map((item) => item.pid)).toContain(pid);
      writeFileSync(stop, 'stop');
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    } finally {
      writeFileSync(trigger, 'go');
      writeFileSync(stop, 'stop');
      await closed;
      await vi.waitFor(() => expect(existsSync(grandPid)).toBe(true), { timeout: 5000 });
      // Fixture processes also have a 15-second lifetime cap; no arbitrary PID is killed.
      await vi.waitFor(
        async () => {
          const rows = await windowsProcessRows();
          const pid = existsSync(grandPid) ? Number(readFileSync(grandPid, 'utf8')) : undefined;
          expect(rows.some((row) => row.pid === pid)).toBe(false);
        },
        { timeout: 20000 },
      );
      rmSync(dir, { recursive: true, force: true });
    }
  },
  40000,
);
