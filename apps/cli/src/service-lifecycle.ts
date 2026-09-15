import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export type ServiceOptions = {
  baseUrl: string;
  dataDir: string;
  port: number;
  startupTimeoutMs?: number;
};

type Probe = 'ready' | 'absent';

async function probeService(baseUrl: string): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED')
      return 'absent';
    throw new Error('MCPex 서비스 상태를 확인하지 못했습니다. 연결 주소와 실행 상태를 확인하세요.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    !('service' in body) ||
    body.service !== 'mcpex' ||
    !('status' in body) ||
    body.status !== 'ok'
  )
    throw new Error('설정된 주소에서 다른 서비스 또는 준비되지 않은 서버가 응답합니다.');
  return 'ready';
}

function startService(options: ServiceOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let startupObservation: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./index.js', import.meta.url)), 'serve'],
      {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MCPEX_DATA_DIR: options.dataDir,
          MCPEX_PORT: String(options.port),
          MCPEX_URL: options.baseUrl,
        },
      },
    );
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (startupObservation) clearTimeout(startupObservation);
      action();
    };
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => {
      finish(() =>
        reject(new Error(`MCPex 백그라운드 서비스 시작 실패: exit ${code ?? 'unknown'}`)),
      );
    });
    child.once('spawn', () => {
      child.unref();
    });
    startupObservation = setTimeout(() => finish(resolve), 1_000);
  });
}

/** Only connection refusal on the configured loopback port may start a daemon. */
export async function ensureService(
  options: ServiceOptions,
  dependencies: {
    probe?: (baseUrl: string) => Promise<Probe>;
    start?: (options: ServiceOptions) => Promise<void>;
    pause?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const probe = dependencies.probe ?? probeService;
  if ((await probe(options.baseUrl)) === 'ready') return;
  const url = new URL(options.baseUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    Number(url.port || 80) !== options.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      '사용자 지정 외부 주소는 자동 시작할 수 없습니다. 해당 서버를 먼저 실행하세요.',
    );
  await (dependencies.start ?? startService)(options);
  const deadline = Date.now() + (options.startupTimeoutMs ?? 20000);
  do {
    if ((await probe(options.baseUrl)) === 'ready') return;
    await (dependencies.pause ?? delay)(200);
  } while (Date.now() < deadline);
  throw new Error(
    'MCPex 자동 시작 시간이 초과되었습니다. 데이터 폴더 잠금 또는 포트 설정을 확인하세요.',
  );
}
