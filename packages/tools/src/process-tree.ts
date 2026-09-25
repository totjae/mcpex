import { execFile, spawn } from 'node:child_process';

export type ProcessIdentity = { pid: number; started: string };
type ProcessRow = ProcessIdentity & { parentPid: number };

const processScript = `
$ErrorActionPreference = 'Stop'
@(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; started = $_.CreationDate.ToUniversalTime().Ticks.ToString() }
}) | ConvertTo-Json -Compress
`;
const probeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP'].includes(
      key.toUpperCase(),
    ),
  ),
);

export async function windowsProcessRows(): Promise<ProcessRow[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', processScript],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, env: probeEnvironment },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('프로세스 목록 형식이 올바르지 않습니다.');
  return parsed.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isSafeInteger(item.pid) ||
      !Number.isSafeInteger(item.parentPid) ||
      typeof item.started !== 'string' ||
      !/^\d+$/.test(item.started)
    )
      throw new Error('프로세스 식별 정보를 확인할 수 없습니다.');
    return item as ProcessRow;
  });
}

export function processTree(rows: ProcessRow[], rootPid: number): ProcessIdentity[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) throw new Error('명령 프로세스의 생성 시각을 확인할 수 없습니다.');
  const tree = [root];
  const seen = new Set([rootPid]);
  for (let index = 0; index < tree.length; index++) {
    for (const row of rows) {
      if (
        row.parentPid !== tree[index].pid ||
        seen.has(row.pid) ||
        BigInt(row.started) < BigInt(tree[index].started)
      )
        continue;
      seen.add(row.pid);
      tree.push(row);
    }
  }
  return tree.map(({ pid, started }) => ({ pid, started }));
}

export function stillRunning(rows: ProcessRow[], identities: ProcessIdentity[]): ProcessIdentity[] {
  return identities.filter((identity) =>
    rows.some((row) => row.pid === identity.pid && row.started === identity.started),
  );
}

export function survivingTree(
  rows: ProcessRow[],
  identities: ProcessIdentity[],
): ProcessIdentity[] {
  // Every recorded ancestor remains a root even after it exits.
  const ancestors = [...identities];
  const seen = new Set(ancestors.map((item) => `${item.pid}:${item.started}`));
  for (let index = 0; index < ancestors.length; index++) {
    const ancestor = ancestors[index];
    const replacement = rows.find(
      (row) => row.pid === ancestor.pid && BigInt(row.started) > BigInt(ancestor.started),
    );
    for (const row of rows) {
      const key = `${row.pid}:${row.started}`;
      if (
        row.parentPid !== ancestor.pid ||
        seen.has(key) ||
        BigInt(row.started) < BigInt(ancestor.started) ||
        (replacement && BigInt(row.started) >= BigInt(replacement.started))
      )
        continue;
      seen.add(key);
      ancestors.push({ pid: row.pid, started: row.started });
    }
  }
  return stillRunning(rows, ancestors);
}

export function taskkillTree(pid: number, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // 종료 보조 프로세스가 이미 닫혔을 수 있다.
      }
      finish(false);
    }, 5000);
    timer.unref?.();
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}
