export const activeRunStatuses = new Set(['queued', 'running', 'cancel_requested']);

export function isTerminalRunStatus(status: string): boolean {
  return !activeRunStatuses.has(status);
}

function wait(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, intervalMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function pollRun<T extends { status: string }>(options: {
  load: () => Promise<T>;
  onUpdate: (run: T) => void;
  signal: AbortSignal;
  intervalMs?: number;
}): Promise<T> {
  const intervalMs = options.intervalMs ?? 300;
  for (;;) {
    if (options.signal.aborted)
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const run = await options.load();
    options.onUpdate(run);
    if (isTerminalRunStatus(run.status)) return run;
    await wait(intervalMs, options.signal);
  }
}
