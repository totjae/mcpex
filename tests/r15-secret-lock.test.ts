import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { AsyncDpapiSecretStore } from '@mcpex/storage';

const fakeTransform = async (_mode: string, value: string) => Buffer.from(value).toString('base64');
const makeStore = (dir: string) => {
  const store = new AsyncDpapiSecretStore(dir);
  (store as unknown as { transform: typeof fakeTransform }).transform = fakeTransform;
  return store;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['', '{"pid":'])('waits for a writer whose lock starts as %j', async (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpex-r15-'));
  const lock = join(dir, 'secrets.lock');
  const write = fsp.writeFile.bind(fsp);
  let open!: () => void;
  let release!: () => void;
  let secondAttempt!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const continueWrite = new Promise<void>((resolve) => (release = resolve));
  const attempted = new Promise<void>((resolve) => (secondAttempt = resolve));
  let calls = 0;
  vi.spyOn(fsp, 'writeFile').mockImplementation(
    async (...args: Parameters<typeof fsp.writeFile>) => {
      if (String(args[0]) !== lock) return write(...args);
      if (++calls === 1) {
        await write(lock, prefix, { flag: 'wx', mode: 0o600 });
        open();
        await continueWrite;
        return write(lock, args[1], { flag: 'w', mode: 0o600 });
      }
      secondAttempt();
      return write(...args);
    },
  );
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    first = makeStore(dir).set('fixture-a', 'a');
    await opened;
    second = makeStore(dir).set('fixture-b', 'b');
    await attempted;
    await delay(75);
    expect(readFileSync(lock, 'utf8')).toBe(prefix);
    release();
    await Promise.all([first, second]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).sort()).toEqual(
      ['fixture-a', 'fixture-b'],
    );
  } finally {
    release();
    await Promise.allSettled([first, second]);
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['', '{"pid":', JSON.stringify({ pid: 2147483647, token: 'dead' })])(
  'times out without reclaiming an unowned lock %j',
  async (content) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpex-r15-timeout-'));
    const lock = join(dir, 'secrets.lock');
    writeFileSync(lock, content);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const pending = makeStore(dir).set('new', 'value');
      const outcome = pending.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      await delay(75);
      expect(readFileSync(lock, 'utf8')).toBe(content);
      vi.setSystemTime(Date.now() + 11000);
      await expect(outcome).resolves.toBe('SECRET_STORE_LOCKED');
      expect(readFileSync(lock, 'utf8')).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('serializes set/set and set/delete across processes and recovers after a stopped writer is cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpex-r15-process-'));
  const moduleUrl = pathToFileURL(resolve('packages/storage/dist/src/index.js')).href;
  const script = `const {AsyncDpapiSecretStore}=await import(process.argv[1]);
    const s=new AsyncDpapiSecretStore(process.argv[2]);
    s.transform=async (_mode,value)=>Buffer.from(value).toString('base64');
    if(process.argv[3]==='hang'){setInterval(()=>{},1000);s.transform=async()=>new Promise(()=>{});await s.set('interrupted','x')}
    else if(process.argv[3]==='delete') await s.delete(process.argv[4]);
    else await s.set(process.argv[4],process.argv[4]);`;
  const run = (action: string, key: string) =>
    new Promise<void>((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, moduleUrl, dir, action, key],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolveRun() : reject(new Error(`fixture exited ${code}`)),
      );
    });
  try {
    await Promise.all([run('set', 'a'), run('set', 'b')]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).sort()).toEqual(
      ['a', 'b'],
    );
    await Promise.all([run('delete', 'a'), run('set', 'c')]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).sort()).toEqual(
      ['b', 'c'],
    );
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, moduleUrl, dir, 'hang', ''],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
    try {
      await vi.waitFor(
        () =>
          expect(JSON.parse(readFileSync(join(dir, 'secrets.lock'), 'utf8')).pid).toBe(child.pid),
        { timeout: 5000 },
      );
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill();
      await closed;
    }
    expect(readFileSync(join(dir, 'secrets.lock'), 'utf8')).toContain(String(child.pid));
    vi.useFakeTimers({ toFake: ['Date'] });
    const pending = makeStore(dir)
      .set('blocked', 'x')
      .then(
        () => 'resolved',
        (error: Error) => error.message,
      );
    await delay(75);
    vi.setSystemTime(Date.now() + 11000);
    await expect(pending).resolves.toBe('SECRET_STORE_LOCKED');
    vi.useRealTimers();
    // Recovery is performed only after the fixture writer is stopped.
    await fsp.rm(join(dir, 'secrets.lock'));
    await makeStore(dir).set('restored', 'x');
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).sort()).toEqual(
      ['b', 'c', 'restored'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
