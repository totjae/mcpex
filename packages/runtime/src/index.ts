import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChatMessage, GenerateResult, ToolCall, ToolDefinition } from '@mcpex/providers';

export const FULL_ACCESS_WORKSPACE = '\0mcpex-full-access';

export class QueueError extends Error {
  constructor(
    readonly code:
      | 'QUEUE_FULL'
      | 'CANCELLED'
      | 'DEADLINE'
      | 'QUEUE_TIMEOUT'
      | 'EXECUTION_TIMEOUT'
      | 'PROVIDER_TIMEOUT'
      | 'MODEL_TURN_LIMIT'
      | 'TOOL_CALL_LIMIT'
      | 'CONVERSATION_LIMIT'
      | 'WORKSPACE_BLOCKED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'QueueError';
  }
}
type Job<T> = {
  task: (signal: AbortSignal) => Promise<T>;
  workspace?: string;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  provider?: string;
  resourceGroup?: string;
  runId?: string;
  deadlineAt?: number;
  executionTimeoutMs?: number;
  pendingAbort?: () => void;
  pendingTimer?: ReturnType<typeof setTimeout>;
};
function overlaps(a: string, b: string): boolean {
  const left = relative(a, b);
  const right = relative(b, a);
  return (
    left === '' ||
    right === '' ||
    (!isAbsolute(left) && left !== '..' && !left.startsWith(`..${sep}`)) ||
    (!isAbsolute(right) && right !== '..' && !right.startsWith(`..${sep}`))
  );
}
export class WorkspaceLockManager {
  private active: string[] = [];
  private blocked: string[] = [];
  isBlocked(workspace: string): boolean {
    if (workspace === FULL_ACCESS_WORKSPACE) return this.blocked.length > 0;
    return this.blocked.some(
      (item) => item === FULL_ACCESS_WORKSPACE || overlaps(item, resolve(workspace)),
    );
  }
  block(workspace: string): void {
    if (!this.blocked.includes(workspace)) this.blocked.push(workspace);
  }
  unblock(workspace: string): void {
    this.blocked = this.blocked.filter((item) => item !== workspace);
  }
  canRun(workspace: string): boolean {
    if (this.isBlocked(workspace)) return false;
    if (workspace === FULL_ACCESS_WORKSPACE) return this.active.length === 0;
    if (this.active.includes(FULL_ACCESS_WORKSPACE)) return false;
    const root = resolve(workspace);
    return !this.active.some((item) => overlaps(item, root));
  }
  async run<T>(
    workspace: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const root = workspace === FULL_ACCESS_WORKSPACE ? workspace : resolve(workspace);
    while (!this.canRun(root)) {
      if (this.isBlocked(root))
        throw new QueueError('WORKSPACE_BLOCKED', '명령 종료 확인 실패·추가 실행 차단 상태입니다.');
      if (signal?.aborted) throw new QueueError('CANCELLED', 'workspace 작업이 취소되었습니다.');
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(resolvePromise, 10);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new QueueError('CANCELLED', 'workspace 작업이 취소되었습니다.'));
          },
          { once: true },
        );
      });
    }
    this.active.push(root);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await task(controller.signal);
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.active = this.active.filter((item) => item !== root);
    }
  }
}
export class RunQueue {
  private readonly pending: Array<Job<unknown>> = [];
  private running = 0;
  private providerActive = new Map<string, number>();
  private groupActive = new Map<string, number>();
  constructor(
    private concurrency = 2,
    private maxPending = 100,
    private readonly locks = new WorkspaceLockManager(),
    private readonly providerLimits = new Map<string, number>(),
    private readonly groupLimits = new Map<string, number>(),
  ) {
    if (concurrency < 1 || concurrency > 8)
      throw new RangeError('concurrency must be between 1 and 8');
  }
  get size(): number {
    return this.pending.length;
  }
  get active(): number {
    return this.running;
  }
  get canAccept(): boolean {
    return this.pending.length < this.maxPending;
  }
  isWorkspaceBlocked(workspace: string): boolean {
    return this.locks.isBlocked(workspace);
  }
  blockWorkspace(workspace: string): void {
    this.locks.block(workspace);
    for (const job of [...this.pending]) {
      if (!job.workspace || !this.locks.isBlocked(job.workspace)) continue;
      this.pending.splice(this.pending.indexOf(job), 1);
      this.clearPendingHooks(job);
      job.reject(
        new QueueError('WORKSPACE_BLOCKED', '명령 종료 확인 실패·추가 실행 차단 상태입니다.'),
      );
    }
    this.pump();
  }
  unblockWorkspace(workspace: string): void {
    this.locks.unblock(workspace);
    this.pump();
  }
  waitReason(runId: string): 'workspace' | 'provider' | 'resourceGroup' | 'global' | null {
    const job = this.pending.find((item) => item.runId === runId);
    if (!job) return null;
    if (job.workspace && !this.locks.canRun(job.workspace)) return 'workspace';
    if (
      job.provider &&
      (this.providerActive.get(job.provider) ?? 0) >=
        (this.providerLimits.get(job.provider) ?? this.concurrency)
    )
      return 'provider';
    if (
      job.resourceGroup &&
      (this.groupActive.get(job.resourceGroup) ?? 0) >=
        (this.groupLimits.get(job.resourceGroup) ?? this.concurrency)
    )
      return 'resourceGroup';
    return 'global';
  }
  setProviderLimit(provider: string, limit: number): void {
    this.providerLimits.set(provider, Math.min(Math.max(Math.trunc(limit), 1), 8));
    this.pump();
  }
  setResourceGroupLimit(resourceGroup: string, limit: number): void {
    const normalized = Math.min(Math.max(Math.trunc(limit), 1), 8);
    this.groupLimits.set(resourceGroup, normalized);
    this.pump();
  }
  setResourceGroupLimits(limits: ReadonlyMap<string, number>): void {
    this.groupLimits.clear();
    for (const [resourceGroup, limit] of limits) {
      const normalized = Math.min(Math.max(Math.trunc(limit), 1), 8);
      this.groupLimits.set(resourceGroup, normalized);
    }
    this.pump();
  }
  setConcurrency(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new RangeError('concurrency must be between 1 and 8');
    this.concurrency = limit;
    this.pump();
  }
  setMaxPending(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError('maxPending must be between 1 and 1000');
    this.maxPending = limit;
  }
  submit<T>(
    task: (signal: AbortSignal) => Promise<T>,
    workspace?: string,
    signal?: AbortSignal,
    limits?: {
      provider?: string;
      resourceGroup?: string;
      runId?: string;
      deadlineAt?: number;
      executionTimeoutMs?: number;
    },
  ): Promise<T> {
    if (workspace && this.locks.isBlocked(workspace))
      return Promise.reject(
        new QueueError('WORKSPACE_BLOCKED', '명령 종료 확인 실패·추가 실행 차단 상태입니다.'),
      );
    if (this.pending.length >= this.maxPending)
      return Promise.reject(new QueueError('QUEUE_FULL', '실행 대기열이 가득 찼습니다.'));
    if (signal?.aborted)
      return Promise.reject(new QueueError('CANCELLED', '실행이 취소되었습니다.'));
    if (limits?.deadlineAt !== undefined && limits.deadlineAt <= Date.now())
      return Promise.reject(
        new QueueError(
          limits.executionTimeoutMs ? 'QUEUE_TIMEOUT' : 'DEADLINE',
          '대기 제한 시간이 만료되었습니다.',
        ),
      );
    return new Promise<T>((resolvePromise, reject) => {
      const job = {
        task,
        workspace,
        resolve: resolvePromise,
        reject,
        signal,
        ...limits,
      } as Job<unknown>;
      const rejectPending = (error: QueueError) => {
        const index = this.pending.indexOf(job);
        if (index === -1) return;
        this.pending.splice(index, 1);
        this.clearPendingHooks(job);
        job.reject(error);
        this.pump();
      };
      job.pendingAbort = () => rejectPending(new QueueError('CANCELLED', '실행이 취소되었습니다.'));
      signal?.addEventListener('abort', job.pendingAbort, { once: true });
      if (limits?.deadlineAt !== undefined)
        job.pendingTimer = setTimeout(
          () =>
            rejectPending(
              new QueueError(
                job.executionTimeoutMs ? 'QUEUE_TIMEOUT' : 'DEADLINE',
                '대기 제한 시간이 만료되었습니다.',
              ),
            ),
          Math.max(0, limits.deadlineAt - Date.now()),
        );
      this.pending.push(job);
      this.pump();
    });
  }
  private clearPendingHooks(job: Job<unknown>): void {
    if (job.pendingTimer) clearTimeout(job.pendingTimer);
    if (job.pendingAbort) job.signal?.removeEventListener('abort', job.pendingAbort);
    job.pendingTimer = undefined;
    job.pendingAbort = undefined;
  }
  private canStart(job: Job<unknown>): boolean {
    if (job.workspace && !this.locks.canRun(job.workspace)) return false;
    if (
      job.provider &&
      (this.providerActive.get(job.provider) ?? 0) >=
        (this.providerLimits.get(job.provider) ?? this.concurrency)
    )
      return false;
    if (
      job.resourceGroup &&
      (this.groupActive.get(job.resourceGroup) ?? 0) >=
        (this.groupLimits.get(job.resourceGroup) ?? this.concurrency)
    )
      return false;
    return true;
  }
  private mark(job: Job<unknown>, delta: number): void {
    if (job.provider)
      this.providerActive.set(job.provider, (this.providerActive.get(job.provider) ?? 0) + delta);
    if (job.resourceGroup)
      this.groupActive.set(
        job.resourceGroup,
        (this.groupActive.get(job.resourceGroup) ?? 0) + delta,
      );
  }
  private pump(): void {
    for (let index = 0; index < this.pending.length && this.running < this.concurrency;) {
      const job = this.pending[index];
      if (job.signal?.aborted) {
        this.pending.splice(index, 1);
        this.clearPendingHooks(job);
        job.reject(new QueueError('CANCELLED', '실행이 취소되었습니다.'));
        continue;
      }
      if (job.workspace && this.locks.isBlocked(job.workspace)) {
        this.pending.splice(index, 1);
        this.clearPendingHooks(job);
        job.reject(
          new QueueError('WORKSPACE_BLOCKED', '명령 종료 확인 실패·추가 실행 차단 상태입니다.'),
        );
        continue;
      }
      if (job.deadlineAt !== undefined && job.deadlineAt <= Date.now()) {
        this.pending.splice(index, 1);
        this.clearPendingHooks(job);
        job.reject(
          new QueueError(
            job.executionTimeoutMs ? 'QUEUE_TIMEOUT' : 'DEADLINE',
            '대기 제한 시간이 만료되었습니다.',
          ),
        );
        continue;
      }
      if (!this.canStart(job)) {
        index++;
        continue;
      }
      this.pending.splice(index, 1);
      this.clearPendingHooks(job);
      this.running++;
      this.mark(job, 1);
      const controller = new AbortController();
      let deadlineExpired = false;
      const cancel = () => controller.abort(new QueueError('CANCELLED', '실행이 취소되었습니다.'));
      job.signal?.addEventListener('abort', cancel, { once: true });
      if (job.signal?.aborted) cancel();
      const timer =
        job.deadlineAt || job.executionTimeoutMs
          ? setTimeout(
              () => {
                deadlineExpired = true;
                controller.abort(
                  new QueueError(
                    job.executionTimeoutMs ? 'EXECUTION_TIMEOUT' : 'DEADLINE',
                    '실행 제한 시간이 만료되었습니다.',
                  ),
                );
              },
              job.executionTimeoutMs ?? Math.max(0, (job.deadlineAt as number) - Date.now()),
            )
          : undefined;
      const execute = job.workspace
        ? this.locks.run(job.workspace, job.task, controller.signal)
        : job.task(controller.signal);
      execute
        .then(job.resolve, (error) =>
          job.reject(
            error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'COMMAND_TERMINATION_FAILED'
              ? error
              : deadlineExpired
                ? new QueueError(
                    job.executionTimeoutMs ? 'EXECUTION_TIMEOUT' : 'DEADLINE',
                    '실행 제한 시간이 만료되었습니다.',
                    { cause: error },
                  )
                : job.signal?.aborted
                  ? new QueueError('CANCELLED', '실행이 취소되었습니다.', { cause: error })
                  : error,
          ),
        )
        .finally(() => {
          if (timer) clearTimeout(timer);
          job.signal?.removeEventListener('abort', cancel);
          this.mark(job, -1);
          this.running--;
          this.pump();
        });
    }
  }
}

export type ToolLoopResult = { text: string; toolCalls: number; messages: ChatMessage[] };
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
export async function runToolLoop(options: {
  initialMessages: ChatMessage[];
  tools: ToolDefinition[];
  maxTurns?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
  generate: (
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ) => Promise<GenerateResult>;
  execute: (call: ToolCall, signal?: AbortSignal) => Promise<string>;
}): Promise<ToolLoopResult> {
  const messages = [...options.initialMessages];
  let messageBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (messageBytes > MAX_CONVERSATION_BYTES)
    throw new QueueError('CONVERSATION_LIMIT', '누적 대화 크기 제한을 초과했습니다.');
  const append = (message: ChatMessage) => {
    messageBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (messageBytes > MAX_CONVERSATION_BYTES)
      throw new QueueError('CONVERSATION_LIMIT', '누적 대화 크기 제한을 초과했습니다.');
    messages.push(message);
  };
  const maxTurns = options.maxTurns ?? 20;
  const maxCalls = options.maxToolCalls ?? 50;
  let calls = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    if (options.signal?.aborted) throw new QueueError('CANCELLED', '도구 실행이 취소되었습니다.');
    const result = await options.generate(messages, options.tools, options.signal);
    options.signal?.throwIfAborted();
    append({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    if (!result.toolCalls.length) return { text: result.text, toolCalls: calls, messages };
    for (const call of result.toolCalls) {
      options.signal?.throwIfAborted();
      if (++calls > maxCalls)
        throw new QueueError('TOOL_CALL_LIMIT', '도구 호출 한도를 초과했습니다.');
      let output: string;
      try {
        output = await options.execute(call, options.signal);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'COMMAND_TERMINATION_FAILED'
        )
          throw error;
        options.signal?.throwIfAborted();
        const code =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : error instanceof Error
              ? error.name
              : 'TOOL_ERROR';
        output = JSON.stringify({
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      append({ role: 'tool', toolCallId: call.id, content: output });
    }
  }
  throw new QueueError('MODEL_TURN_LIMIT', '모델 반복 한도를 초과했습니다.');
}
