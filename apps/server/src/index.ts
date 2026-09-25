import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import {
  BootstrapResponse,
  SCHEMA_VERSION,
  newId,
  TargetsInput,
  targetsJsonSchema,
} from '@mcpex/contracts';
import {
  DataDirectoryLock,
  AsyncDpapiSecretStore,
  DpapiSecretStore,
  Storage,
  type AgentRow,
  type AgentVersionRow,
  type ConfigImportRows,
  type ModelRow,
  type ProviderRow,
  type RunRow,
  type TemplateRow,
} from '@mcpex/storage';
import {
  getAdapter,
  getProviderProfile,
  listProviderProfiles,
  ProviderError,
  type ChatMessage,
  type ToolDefinition,
} from '@mcpex/providers';
import { FULL_ACCESS_WORKSPACE, QueueError, RunQueue, runToolLoop } from '@mcpex/runtime';
import {
  executeWorkspaceTool,
  executeTargetTool,
  getWorkspaceToolDefinitions,
  resolveWorkspaceRoot,
  ToolError,
  workspaceToolDefinitions,
  targetToolDefinitions,
  WorkspaceTools,
  survivingTree,
  windowsProcessRows,
  type BoundTarget,
  type CommandSpec,
  type ProcessIdentity,
  type UnsafeCommandTermination,
} from '@mcpex/tools';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import {
  SchemaContractError,
  validateInput,
  validateOutput,
  validateUserSchema,
} from './schema.js';

type ProviderInput = {
  name: string;
  adapter: string;
  profileId?: string;
  location?: string;
  baseUrl: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  maxConcurrency?: number;
  resourceGroup?: string;
  resourceGroupConcurrency?: number;
  extraBody?: Record<string, unknown>;
};
type ProviderCreateInput = Omit<ProviderInput, 'adapter' | 'baseUrl'> & {
  adapter?: string;
  baseUrl?: string;
};
type AgentConfig = {
  schemaVersion?: number;
  modelRef?: string | null;
  description?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
  inputSchema?: Record<string, unknown>;
  output?: { format?: 'text' | 'markdown' | 'json'; schema?: Record<string, unknown> };
  generationOverrides?: Record<string, number>;
  serviceTier?: 'inherit' | ServiceTierSetting;
  runtime?: {
    mode?: 'response' | 'tools';
    tools?: string[];
    maxModelTurns?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    queueTimeoutMs?: number;
    executionTimeoutMs?: number;
    workspacePolicy?: { mode?: 'none' | 'fixed' | 'caller' | 'full'; allowedRoots?: string[] };
    commands?: CommandSpec[];
    targetBinding?: 'off' | 'optional';
  };
};
const templateSections = [
  'description',
  'prompts',
  'input',
  'output',
  'generation',
  'runtime',
] as const;
type TemplateSection = (typeof templateSections)[number];
type ResolvedConfigSnapshot = {
  schemaVersion: 1;
  execution?: {
    workspace: string | null;
    workspaceSource: 'none' | 'fixed' | 'caller' | 'full';
    targets?: BoundTarget[];
  };
  agent: AgentConfig;
  model: {
    id: string;
    providerId: string;
    modelId: string;
    label: string;
    defaultGeneration: GenerationOptions;
    serviceTier?: ServiceTierSetting | null;
    capabilities: Record<string, unknown>;
    revision: number;
  };
  provider: {
    id: string;
    name: string;
    adapter: string;
    location: string;
    config: ProviderInput;
    revision: number;
    hasCredential: boolean;
  };
};
type RunObservations = {
  toolCalls: number;
  changes: Array<{
    tool: 'write_file' | 'replace_text' | 'write_target' | 'replace_target';
    path?: string;
    targetId?: string;
  }>;
  checks: Array<{ tool: 'run_command'; commandId: string; exitCode: number | null }>;
  toolFailures: Array<{ code: string }>;
  truncated: boolean;
};
type TaskVerification = {
  status: 'not_verified' | 'passed' | 'failed';
  evidence: { checks: RunObservations['checks']; toolFailures: RunObservations['toolFailures'] };
};
function taskVerification(observations?: RunObservations): TaskVerification {
  return {
    status: 'not_verified',
    evidence: {
      checks: observations?.checks ?? [],
      toolFailures: observations?.toolFailures ?? [],
    },
  };
}
function isTimeoutCode(code: string): boolean {
  return ['DEADLINE', 'QUEUE_TIMEOUT', 'EXECUTION_TIMEOUT', 'PROVIDER_TIMEOUT'].includes(code);
}
function storedTaskVerification(storage: Storage, runId: string): TaskVerification {
  const event = storage.getRunFinishedEvent(runId);
  if (!event) return taskVerification();
  const payload = JSON.parse(event.payload_json) as { verification?: TaskVerification };
  return payload.verification ?? taskVerification();
}
type TargetChange = { tool: 'write_target' | 'replace_target'; targetId: string };
function storedTargetChanges(storage: Storage, row: RunRow): TargetChange[] | null | undefined {
  if (row.content_purged_at || row.events_expired_at) return null;
  const snapshot = row.config_snapshot_json
    ? (JSON.parse(row.config_snapshot_json) as ResolvedConfigSnapshot)
    : undefined;
  if (!snapshot?.execution?.targets) return undefined;
  return storage
    .listRunEvents(row.id)
    .filter((event) => event.type === 'tool.finished')
    .flatMap((event): TargetChange[] => {
      const payload = JSON.parse(event.payload_json) as {
        ok?: boolean;
        name?: string;
        targetId?: string;
      };
      return payload.ok === true &&
        (payload.name === 'write_target' || payload.name === 'replace_target') &&
        typeof payload.targetId === 'string'
        ? [{ tool: payload.name, targetId: payload.targetId }]
        : [];
    });
}
type ServiceTierObservation = { requested: string | null; actual: string | null; source: string };
function storedServiceTiers(storage: Storage, row: RunRow): ServiceTierObservation[] | null {
  if (row.events_expired_at) return null;
  return storage
    .listRunEvents(row.id)
    .filter((event) => event.type === 'model.finished')
    .flatMap((event) => {
      const payload = JSON.parse(event.payload_json) as {
        requestedServiceTier?: string | null;
        actualServiceTier?: string | null;
        serviceTierSource?: string;
      };
      return Object.hasOwn(payload, 'requestedServiceTier')
        ? [
            {
              requested: payload.requestedServiceTier ?? null,
              actual: payload.actualServiceTier ?? null,
              source: payload.serviceTierSource ?? 'unknown',
            },
          ]
        : [];
    });
}
type ModelUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
type ExecutionTelemetry = {
  observations: RunObservations;
  usage: ModelUsage | null;
  durationMs: number;
};
type ErrorWithTelemetry = { executionTelemetry?: ExecutionTelemetry };
function executionTelemetryFrom(error: unknown): ExecutionTelemetry | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const candidate = current as ErrorWithTelemetry & { cause?: unknown };
    if (candidate.executionTelemetry) return candidate.executionTelemetry;
    current = candidate.cause;
  }
  return undefined;
}
class WorkspacePolicyError extends Error {
  constructor(
    readonly code: 'INVALID_WORKSPACE_POLICY' | 'WORKSPACE_REQUIRED' | 'WORKSPACE_NOT_ALLOWED',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspacePolicyError';
  }
}
type ConfigEnvelope = {
  format: 'mcpex-config';
  schemaVersion: 1;
  exportedAt: string;
  providers: unknown[];
  models: unknown[];
  agents: unknown[];
  templates: unknown[];
};
type ImportConflict = {
  kind: 'provider' | 'model' | 'agent' | 'template';
  sourceId?: string;
  field: string;
  value: string;
};
type McpConnectionOptions = {
  command: string;
  args: string[];
  environment?: Record<string, string>;
};
type PreparedImport = {
  rows: ConfigImportRows;
  mappings: Record<'providers' | 'models' | 'agents' | 'templates', Record<string, string>>;
  conflicts: ImportConflict[];
};
const LOCAL_ACCESS_TOKEN_KEY = 'mcpex:local-access-token';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export function pruneSessions(sessions: Map<string, number>, now = Date.now()): void {
  for (const [session, expires] of sessions) if (expires <= now) sessions.delete(session);
}
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function installGracefulShutdown(close: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export function getLocalAccessToken(dataDir: string): string {
  const secrets = new DpapiSecretStore(dataDir);
  const existing = secrets.get(LOCAL_ACCESS_TOKEN_KEY);
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  secrets.set(LOCAL_ACCESS_TOKEN_KEY, created);
  return created;
}
export async function getLocalAccessTokenAsync(dataDir: string): Promise<string> {
  const secrets = new AsyncDpapiSecretStore(dataDir);
  const existing = await secrets.get(LOCAL_ACCESS_TOKEN_KEY);
  if (existing) return existing;
  return await secrets.getOrCreate(LOCAL_ACCESS_TOKEN_KEY, () =>
    randomBytes(32).toString('base64url'),
  );
}

function sameSecret(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function runPublic(
  row: RunRow,
  waitReason?: string | null,
  verification = taskVerification(),
  targetChanges?: TargetChange[] | null,
  serviceTiers?: ServiceTierObservation[] | null,
) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    source: row.source,
    status: row.status,
    verification,
    ...(targetChanges !== undefined ? { targetChanges } : {}),
    ...(serviceTiers !== undefined ? { serviceTiers } : {}),
    waitReason: row.status === 'queued' ? (waitReason ?? null) : null,
    input: JSON.parse(row.input_json),
    output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    configSnapshot: row.config_snapshot_json ? JSON.parse(row.config_snapshot_json) : null,
    contentPurgedAt: row.content_purged_at ?? null,
    eventsExpiredAt: row.events_expired_at ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at,
  };
}

function webDistDirectory(): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return [resolve(moduleDirectory, '../../web/dist'), resolve(moduleDirectory, '../../../web/dist')]
    .filter((candidate) => existsSync(resolve(candidate, 'index.html')))
    .at(0);
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? {});
const bodyOf = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>;
function providerOperationSignal(request: FastifyRequest, reply: FastifyReply, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const disconnectController = new AbortController();
  const abortForDisconnect = () => {
    if (!disconnectController.signal.aborted)
      disconnectController.abort(new Error('클라이언트 연결이 종료되었습니다.'));
  };
  const abortForPrematureClose = () => {
    if (!reply.raw.writableEnded) abortForDisconnect();
  };
  const monitorResponseClose = Boolean(reply.raw.socket);
  request.raw.once('aborted', abortForDisconnect);
  if (monitorResponseClose) reply.raw.once('close', abortForPrematureClose);
  return {
    signal: AbortSignal.any([timeoutSignal, disconnectController.signal]),
    timeoutSignal,
    disconnectSignal: disconnectController.signal,
    dispose: () => {
      request.raw.removeListener('aborted', abortForDisconnect);
      if (monitorResponseClose) reply.raw.removeListener('close', abortForPrematureClose);
    },
  };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sensitiveKey =
  /(?:authorization|api[_-]?key|secret|password|(?:^|[_-])token(?:$|[_-])|accessToken|authToken)/i;
function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, item]) => [key, stripSensitive(item)]),
  );
}
function configFrom(row: ProviderRow): ProviderInput {
  return {
    ...(JSON.parse(row.config_json) as ProviderInput),
    name: row.name,
    adapter: row.adapter,
    location: row.location,
  };
}
function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !/[?&](key|token|api_key)=/i.test(url.search)
    );
  } catch {
    return false;
  }
}
function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}
function commandSpecs(value: unknown): CommandSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32)
    throw new ProviderError(422, 'commands는 최대 32개의 명령 목록이어야 합니다.');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new ProviderError(422, '각 command 설정은 객체여야 합니다.');
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['commandId', 'executable', 'label'].includes(key)) ||
      typeof record.commandId !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(record.commandId) ||
      seen.has(record.commandId) ||
      typeof record.executable !== 'string' ||
      !isAbsolute(record.executable) ||
      (record.label !== undefined && typeof record.label !== 'string')
    )
      throw new ProviderError(
        422,
        'commandId는 고유한 안전한 이름이어야 하며 executable은 절대 경로여야 합니다.',
      );
    seen.add(record.commandId);
    return {
      commandId: record.commandId,
      executable: record.executable,
      ...(record.label === undefined ? {} : { label: record.label }),
    };
  });
}
function workspaceRoots(config: AgentConfig): {
  mode: 'none' | 'fixed' | 'caller' | 'full';
  roots: string[];
} {
  const policy = config.runtime?.workspacePolicy;
  const mode = policy?.mode ?? 'none';
  if (!['none', 'fixed', 'caller', 'full'].includes(mode))
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      422,
      'workspacePolicy.mode가 올바르지 않습니다.',
    );
  if (!Array.isArray(policy?.allowedRoots) || policy.allowedRoots.length > 32)
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      422,
      'allowedRoots는 최대 32개의 절대 경로 목록이어야 합니다.',
    );
  const roots = [
    ...new Set(policy.allowedRoots.map((root) => (typeof root === 'string' ? root.trim() : ''))),
  ].filter(Boolean);
  if (roots.some((root) => !isAbsolute(root)))
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      422,
      'allowedRoots의 모든 작업 폴더는 절대 경로여야 합니다.',
    );
  if (
    (['none', 'full'].includes(mode) && roots.length) ||
    (mode === 'fixed' && roots.length !== 1) ||
    (mode === 'caller' && roots.length < 1)
  )
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      422,
      'none과 full은 허용 루트가 없어야 하고, fixed는 하나, caller는 하나 이상의 허용 루트가 필요합니다.',
    );
  return { mode, roots: roots.map((root) => resolve(root)) };
}
function isWithinWorkspace(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`))
  );
}
function toolFailureDiagnostic(
  name: string,
  args: Record<string, unknown>,
  workspace: string | undefined,
  error: unknown,
) {
  const input = name === 'run_command' ? args.cwd : args.path;
  const ambiguous =
    typeof input === 'string' &&
    process.platform === 'win32' &&
    (/^[A-Za-z]:(?:$|[^\\/])/.test(input) || /^[\\/](?![\\/])/.test(input));
  const pathNotation =
    typeof input !== 'string'
      ? 'omitted'
      : ambiguous
        ? 'ambiguous'
        : isAbsolute(input)
          ? 'absolute'
          : 'relative';
  const candidate =
    workspace && typeof input === 'string' && input && !ambiguous && !input.includes('\0')
      ? resolve(workspace, input)
      : undefined;
  const target =
    candidate && workspace && isWithinWorkspace(workspace, candidate)
      ? relative(workspace, candidate) || '.'
      : null;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const reason =
    (error instanceof ToolError && error.reason) ||
    (
      {
        ENOENT: 'not_found',
        EXPECTED_HASH_REQUIRED: 'expected_hash_missing',
        HASH_CONFLICT: 'hash_mismatch',
        BAD_INPUT: 'invalid_arguments',
        ACCESS_DENIED: 'access_denied',
        PATH_FORBIDDEN: 'path_forbidden',
      } as Record<string, string>
    )[typeof code === 'string' ? code : ''] ||
    'other';
  return {
    pathNotation,
    relativeTarget:
      target && target.length <= 512 && !/[\x00-\x1f\x7f]/.test(target) ? target : null,
    expectedHashProvided:
      name === 'write_file' || name === 'replace_text'
        ? typeof args.expectedHash === 'string' && args.expectedHash.length > 0
        : null,
    reason,
  };
}
function resolveRunWorkspace(config: AgentConfig, callerWorkspace?: string) {
  const { mode, roots } = workspaceRoots(config);
  if (mode === 'none') return { workspace: undefined, source: 'none' as const };
  if (mode === 'full')
    return { workspace: undefined, lock: FULL_ACCESS_WORKSPACE, source: 'full' as const };
  const verified = (workspace: string) => {
    try {
      return resolveWorkspaceRoot(workspace);
    } catch {
      throw new WorkspacePolicyError(
        'WORKSPACE_NOT_ALLOWED',
        403,
        '작업 폴더가 없거나 심볼릭 링크 또는 junction을 포함합니다.',
      );
    }
  };
  if (mode === 'fixed') return { workspace: verified(roots[0]), source: 'fixed' as const };
  if (!callerWorkspace?.trim())
    throw new WorkspacePolicyError(
      'WORKSPACE_REQUIRED',
      422,
      'caller 작업 폴더 정책에는 호출 작업 폴더가 필요합니다.',
    );
  if (!isAbsolute(callerWorkspace))
    throw new WorkspacePolicyError(
      'WORKSPACE_NOT_ALLOWED',
      422,
      '호출 작업 폴더는 절대 경로여야 합니다.',
    );
  const workspace = resolve(callerWorkspace);
  const allowedRoots = roots.filter((root) => isWithinWorkspace(root, workspace));
  if (!allowedRoots.length)
    throw new WorkspacePolicyError(
      'WORKSPACE_NOT_ALLOWED',
      403,
      '호출 작업 폴더가 사전 허용된 루트 밖에 있습니다.',
    );
  const actualWorkspace = verified(workspace);
  if (!allowedRoots.some((root) => isWithinWorkspace(verified(root), actualWorkspace)))
    throw new WorkspacePolicyError(
      'WORKSPACE_NOT_ALLOWED',
      403,
      '호출 작업 폴더의 실제 경로가 사전 허용된 루트 밖에 있습니다.',
    );
  return { workspace: actualWorkspace, source: 'caller' as const };
}
function workspaceToolCapability(config: AgentConfig): {
  runtimeMode: 'response' | 'tools';
  workspaceMode: 'none' | 'fixed' | 'caller' | 'full';
  effectiveTools: string[];
  workspaceState:
    'response_only' | 'no_tools' | 'workspace_disabled' | 'fixed' | 'caller_required' | 'full';
} {
  const runtimeMode = config.runtime?.mode ?? 'response';
  const workspaceMode = config.runtime?.workspacePolicy?.mode ?? 'none';
  const configuredTools = getWorkspaceToolDefinitions(false, commandSpecs(config.runtime?.commands))
    .filter((tool) => config.runtime?.tools?.includes(tool.name))
    .map((tool) => tool.name);
  if (runtimeMode !== 'tools')
    return { runtimeMode, workspaceMode, effectiveTools: [], workspaceState: 'response_only' };
  if (!configuredTools.length)
    return { runtimeMode, workspaceMode, effectiveTools: [], workspaceState: 'no_tools' };
  if (workspaceMode === 'none')
    return { runtimeMode, workspaceMode, effectiveTools: [], workspaceState: 'workspace_disabled' };
  return {
    runtimeMode,
    workspaceMode,
    effectiveTools: configuredTools,
    workspaceState:
      workspaceMode === 'caller' ? 'caller_required' : workspaceMode === 'full' ? 'full' : 'fixed',
  };
}
function publishedToolDescription(config: AgentConfig, fallback: string): string {
  const { effectiveTools, workspaceState } = workspaceToolCapability(config);
  const notes: string[] = [];
  if (effectiveTools.length && workspaceState === 'fixed')
    notes.push(
      '파일·명령 경로는 설정된 작업 폴더와 하위 범위에서 상대 경로 또는 범위 내부 절대 경로를 사용할 수 있습니다.',
    );
  if (effectiveTools.length && workspaceState === 'caller_required')
    notes.push(
      '파일·명령 경로는 호출에서 선택한 작업 폴더와 하위 범위에서 상대 경로 또는 범위 내부 절대 경로를 사용할 수 있습니다.',
    );
  if (effectiveTools.length && workspaceState === 'full')
    notes.push('전체 접근에서는 파일·명령 경로에 절대 경로가 필요합니다.');
  if (effectiveTools.some((tool) => tool !== 'run_command'))
    notes.push(
      '파일 도구의 결과는 선택한 모델 제공자에게 전달될 수 있으며, 클라우드 모델이면 PC 밖으로 전송됩니다.',
    );
  if (effectiveTools.includes('run_command'))
    notes.push('허용 명령은 MCPex를 실행 중인 OS 사용자 권한으로 실행되며 OS sandbox가 아닙니다.');
  if (config.runtime?.targetBinding === 'optional')
    notes.push(
      '선택적 targets 지정 시 파일은 대상 ID로만 읽고 쓰며 직접 경로 도구와 run_command는 사용할 수 없습니다.',
    );
  return [config.description || fallback, ...notes].join(' ');
}
type GenerationOptions = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
};
type ServiceTierSetting = 'provider-default' | 'auto' | 'default' | 'flex' | 'priority';
const serviceTierSettings = new Set<ServiceTierSetting>([
  'provider-default',
  'auto',
  'default',
  'flex',
  'priority',
]);
function serviceTierSetting(
  value: unknown,
  status = 422,
  allowInherit = false,
): ServiceTierSetting | 'inherit' | undefined {
  if (value === undefined || value === null) return undefined;
  if (allowInherit && value === 'inherit') return 'inherit';
  if (typeof value === 'string' && serviceTierSettings.has(value as ServiceTierSetting))
    return value as ServiceTierSetting;
  throw new ProviderError(status, '지원하지 않는 서비스 티어 설정입니다.');
}
function supportsServiceTier(provider: { adapter: string; config: ProviderInput }): boolean {
  return (
    provider.adapter === 'openai-chat' &&
    provider.config.profileId === 'openai' &&
    provider.config.baseUrl.replace(/\/+$/, '') === 'https://api.openai.com/v1'
  );
}
function requireServiceTierSupport(
  choice: string | undefined,
  provider: { adapter: string; config: ProviderInput },
  status = 422,
): void {
  if (choice && choice !== 'provider-default' && !supportsServiceTier(provider))
    throw new ProviderError(status, '이 프로바이더는 서비스 티어 전용 선택이 확인되지 않았습니다.');
}
function effectiveServiceTier(snapshot: ResolvedConfigSnapshot): {
  request: string | null | undefined;
  requested: string | null;
  source: string;
} {
  const choice =
    snapshot.agent.serviceTier && snapshot.agent.serviceTier !== 'inherit'
      ? snapshot.agent.serviceTier
      : snapshot.model.serviceTier;
  const provider = snapshot.provider;
  requireServiceTierSupport(choice ?? undefined, provider);
  if (choice === 'provider-default')
    return {
      request: supportsServiceTier(provider) ? null : undefined,
      requested: null,
      source: 'provider-default',
    };
  if (choice)
    return {
      request: choice,
      requested: choice,
      source:
        snapshot.agent.serviceTier && snapshot.agent.serviceTier !== 'inherit' ? 'agent' : 'model',
    };
  const advanced = supportsServiceTier(provider)
    ? provider.config.extraBody?.service_tier
    : undefined;
  return {
    request: undefined,
    requested: typeof advanced === 'string' ? advanced : null,
    source: advanced === undefined ? 'omitted' : 'advanced',
  };
}
function generationOptions(value: unknown, status = 422): GenerationOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError(status, '생성 설정은 객체여야 합니다.');
  const input = value as Record<string, unknown>;
  const output: GenerationOptions = {};
  if (input.temperature !== undefined) {
    if (
      typeof input.temperature !== 'number' ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0
    )
      throw new ProviderError(status, 'temperature는 0 이상의 유한한 숫자여야 합니다.');
    output.temperature = input.temperature;
  }
  if (input.topP !== undefined) {
    if (
      typeof input.topP !== 'number' ||
      !Number.isFinite(input.topP) ||
      input.topP <= 0 ||
      input.topP > 1
    )
      throw new ProviderError(status, 'topP는 0 초과 1 이하의 숫자여야 합니다.');
    output.topP = input.topP;
  }
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isInteger(input.maxOutputTokens) || (input.maxOutputTokens as number) < 1)
      throw new ProviderError(status, 'maxOutputTokens는 양의 정수여야 합니다.');
    output.maxOutputTokens = input.maxOutputTokens as number;
  }
  return output;
}
function interpolate(template: string, input: Record<string, unknown>): string {
  return template.replace(/{{\s*input\.([\w]+)\s*}}/g, (_m, key: string) =>
    input[key] === undefined
      ? ''
      : typeof input[key] === 'string'
        ? (input[key] as string)
        : JSON.stringify(input[key]),
  );
}
class TargetBindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly targetId?: string,
  ) {
    super(message);
  }
}
function targetInputForModel(config: AgentConfig, input: Record<string, unknown>) {
  if (config.runtime?.targetBinding !== 'optional' || !('targets' in input)) return input;
  const parsed = TargetsInput.safeParse(input.targets);
  if (!parsed.success)
    throw new TargetBindingError('INVALID_TARGETS', 'targets 형식이 올바르지 않습니다.');
  return { ...input, targets: parsed.data.map(({ id, access }) => ({ id, access })) };
}
function targetSystemMessage(targets: Array<{ id: string; access: string }>) {
  return `지정된 대상: ${JSON.stringify(targets)}. 대상 ID와 허용 도구만 사용하세요. 대상 경로를 추측하거나 직접 경로로 도구를 호출하지 마세요. task와 대상 지정이 충돌하면 쓰기 전에 확인을 요청하세요.`;
}
function validateTargetBindingConfig(config: AgentConfig) {
  const mode = config.runtime?.targetBinding ?? 'off';
  if (!['off', 'optional'].includes(mode))
    throw new ProviderError(422, 'targetBinding은 off 또는 optional이어야 합니다.');
  if (mode === 'off') return;
  if (config.runtime?.mode !== 'tools')
    throw new ProviderError(422, '대상 지정에는 tools 실행 모드가 필요합니다.');
  const schema = config.inputSchema as
    { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (
    JSON.stringify(schema?.properties?.targets) !== JSON.stringify(targetsJsonSchema) ||
    schema?.required?.includes('targets')
  )
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      'optional 대상 지정에는 공통 targets 선택 스키마가 필요합니다.',
    );
}
async function bindTargets(
  config: AgentConfig,
  input: Record<string, unknown>,
  workspace: string | undefined,
  source: string,
  signal?: AbortSignal,
): Promise<BoundTarget[] | undefined> {
  signal?.throwIfAborted();
  if (config.runtime?.targetBinding !== 'optional' || !('targets' in input)) return undefined;
  const parsed = TargetsInput.safeParse(input.targets);
  if (!parsed.success)
    throw new TargetBindingError('INVALID_TARGETS', 'targets 형식이 올바르지 않습니다.');
  if (source === 'none')
    throw new TargetBindingError(
      'TARGET_WORKSPACE_REQUIRED',
      '대상 지정에는 작업 폴더 정책이 필요합니다.',
    );
  const enabled = new Set(config.runtime?.tools ?? []);
  const tools = new WorkspaceTools(source === 'full' ? null : workspace!);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const bound: BoundTarget[] = [];
  for (const item of parsed.data) {
    signal?.throwIfAborted();
    if (ids.has(item.id))
      throw new TargetBindingError('DUPLICATE_TARGET_ID', '대상 ID가 중복되었습니다.', item.id);
    ids.add(item.id);
    if (
      (item.access !== 'write' && !enabled.has('read_file')) ||
      (item.access === 'write' && !enabled.has('write_file')) ||
      (item.access === 'readwrite' && !enabled.has('write_file') && !enabled.has('replace_text'))
    )
      throw new TargetBindingError(
        'TARGET_TOOL_UNAVAILABLE',
        '대상 접근에 필요한 파일 도구가 활성화되지 않았습니다.',
        item.id,
      );
    let path: string;
    try {
      path = await tools.resolveTarget(item.path, item.access);
    } catch (error) {
      signal?.throwIfAborted();
      const code =
        error instanceof ToolError
          ? error.code
          : ((error as NodeJS.ErrnoException).code ?? 'TARGET_PATH_ERROR');
      throw new TargetBindingError(code, '대상 파일을 확인할 수 없습니다.', item.id);
    }
    signal?.throwIfAborted();
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key))
      throw new TargetBindingError(
        'DUPLICATE_TARGET_PATH',
        '동일한 대상 경로가 중복되었습니다.',
        item.id,
      );
    paths.add(key);
    bound.push({ id: item.id, path, access: item.access });
  }
  return bound;
}
function agentPublic(row: AgentRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    toolName: row.tool_name,
    enabled: Boolean(row.enabled),
    draft: JSON.parse(row.draft_json),
    draftRevision: row.draft_revision,
    appliedVersionId: row.applied_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function scopeMissingFromPrompt(config: AgentConfig): boolean {
  const properties = (config.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return Boolean(
    properties &&
    Object.hasOwn(properties, 'scope') &&
    !/{{\s*input\.scope\s*}}/.test(config.userPromptTemplate ?? ''),
  );
}
function modelPublic(row: ModelRow) {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    label: row.label,
    defaultGeneration: JSON.parse(row.defaults_json),
    serviceTier: row.service_tier ?? null,
    capabilities: JSON.parse(row.capabilities_json),
    revision: row.revision,
  };
}
function providerPublic(row: ProviderRow) {
  const config = configFrom(row);
  const advancedServiceTier = config.extraBody?.service_tier;
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    location: row.location,
    profileId: config.profileId,
    baseUrl: config.baseUrl,
    headers: config.headers ?? {},
    requestTimeoutMs: config.requestTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    resourceGroup: config.resourceGroup,
    resourceGroupConcurrency: config.resourceGroupConcurrency,
    revision: row.revision,
    hasCredential: Boolean(row.credential_ref),
    serviceTierSupport: supportsServiceTier({ adapter: row.adapter, config })
      ? 'supported'
      : 'unverified',
    advancedServiceTier:
      typeof advancedServiceTier === 'string' &&
      serviceTierSettings.has(advancedServiceTier as ServiceTierSetting)
        ? advancedServiceTier
        : advancedServiceTier === undefined
          ? null
          : 'custom',
  };
}
const defaultConfig = (modelRef: string | null = null): AgentConfig => ({
  schemaVersion: 1,
  modelRef,
  description: '',
  systemPrompt: '',
  userPromptTemplate: '{{input.task}}',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' } },
    required: ['task'],
    additionalProperties: false,
  },
  output: { format: 'markdown' },
  generationOverrides: {},
  serviceTier: 'inherit',
  runtime: {
    mode: 'response',
    targetBinding: 'off',
    tools: [],
    timeoutMs: 120000,
    maxModelTurns: 1,
    maxToolCalls: 0,
    workspacePolicy: { mode: 'none', allowedRoots: [] },
    commands: [],
  },
});

function normalizeAgentConfig(value: unknown): AgentConfig {
  const input = value && typeof value === 'object' ? (value as AgentConfig) : {};
  const defaults = defaultConfig(input.modelRef ?? null);
  return {
    ...defaults,
    ...input,
    inputSchema: input.inputSchema ?? defaults.inputSchema,
    output: { ...defaults.output, ...(input.output ?? {}) },
    generationOverrides: {
      ...defaults.generationOverrides,
      ...(input.generationOverrides ?? {}),
    },
    runtime: {
      ...defaults.runtime,
      ...(input.runtime ?? {}),
      workspacePolicy: {
        ...defaults.runtime!.workspacePolicy,
        ...(input.runtime?.workspacePolicy ?? {}),
      },
    },
  };
}

function sanitizeTemplateConfig(value: unknown): AgentConfig {
  const config = normalizeAgentConfig(value);
  return {
    ...config,
    modelRef: null,
    runtime: {
      ...config.runtime,
      tools: (config.runtime?.tools ?? []).filter((tool) => tool !== 'run_command'),
      workspacePolicy: { mode: 'none', allowedRoots: [] },
      commands: [],
    },
  };
}

function builtinTemplateDefinitions(): Array<{ name: string; config: AgentConfig }> {
  const response = defaultConfig();
  const codeInput = {
    type: 'object',
    properties: {
      task: { type: 'string' },
      workspace: {
        type: 'string',
        description: '작업 대상 위치(문맥 정보, 파일 도구의 실행 기준 변경 아님)',
      },
      scope: { type: 'string', description: '조사하거나 수정할 범위' },
      requirements: { type: 'string' },
    },
    required: ['task'],
    additionalProperties: false,
  };
  return [
    { name: '일반 응답', config: response },
    {
      name: '문서 요약',
      config: normalizeAgentConfig({
        ...response,
        description: '문서의 핵심 내용과 미확인 사항을 구분해 요약합니다.',
        systemPrompt: '핵심 주장, 근거, 미확인 사항을 구분해 간결하게 요약하세요.',
        userPromptTemplate: '요약 요청: {{input.task}}\n자료: {{input.context}}',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' }, context: { type: 'string' } },
          required: ['task'],
          additionalProperties: false,
        },
      }),
    },
    {
      name: '설계 검토',
      config: normalizeAgentConfig({
        ...response,
        description: '설계의 위험, 누락, 대안을 검토합니다.',
        systemPrompt: '설계의 가정, 경계 조건, 실패 경로와 검증 방법을 구체적으로 검토하세요.',
        userPromptTemplate: '검토 목표: {{input.task}}\n설계 자료: {{input.context}}',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' }, context: { type: 'string' } },
          required: ['task'],
          additionalProperties: false,
        },
      }),
    },
    {
      name: '코드 조사',
      config: normalizeAgentConfig({
        ...response,
        description: '작업 폴더의 코드를 읽고 검색해 근거와 함께 조사합니다.',
        systemPrompt:
          '먼저 관련 파일을 조사하고 코드 근거와 미확인 사항을 구분해 보고하세요. 파일 도구의 상대 경로는 설정된 실제 작업 폴더를 기준으로 해석하며, 사용자 입력의 작업 대상 위치는 이 기준을 바꾸지 않습니다.',
        userPromptTemplate:
          '조사 작업: {{input.task}}\n작업 대상 위치(문맥 정보): {{input.workspace}}\n범위: {{input.scope}}',
        inputSchema: codeInput,
        runtime: {
          ...response.runtime,
          mode: 'tools',
          tools: ['list_files', 'read_file', 'search_text'],
          maxModelTurns: 10,
          maxToolCalls: 20,
        },
      }),
    },
    {
      name: '코드 구현',
      config: normalizeAgentConfig({
        ...response,
        description: '작업 폴더를 조사하고 요청된 코드 변경을 구현합니다.',
        systemPrompt:
          '관련 코드를 먼저 조사하고 요청 범위만 수정한 뒤 가능한 검증을 수행하세요. 파일 도구의 상대 경로는 설정된 실제 작업 폴더를 기준으로 해석하며, 사용자 입력의 작업 대상 위치는 이 기준을 바꾸지 않습니다.',
        userPromptTemplate:
          '구현 작업: {{input.task}}\n작업 대상 위치(문맥 정보): {{input.workspace}}\n범위: {{input.scope}}\n요구사항: {{input.requirements}}',
        inputSchema: {
          ...codeInput,
          properties: { ...codeInput.properties, targets: targetsJsonSchema },
        },
        runtime: {
          ...response.runtime,
          mode: 'tools',
          targetBinding: 'optional',
          tools: ['list_files', 'read_file', 'search_text', 'write_file', 'replace_text'],
          maxModelTurns: 20,
          maxToolCalls: 50,
        },
      }),
    },
  ].map((item) => ({ ...item, config: sanitizeTemplateConfig(item.config) }));
}

function selectedTemplateSections(value: unknown): TemplateSection[] {
  if (value === undefined) return [...templateSections];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (section) =>
        typeof section !== 'string' || !templateSections.includes(section as TemplateSection),
    )
  )
    throw new ProviderError(400, 'sections에 올바른 템플릿 설정 묶음이 필요합니다.');
  return [...new Set(value as TemplateSection[])];
}

function applyTemplateConfig(
  currentValue: unknown,
  templateValue: unknown,
  sections: TemplateSection[],
): AgentConfig {
  const current = normalizeAgentConfig(currentValue);
  const template = sanitizeTemplateConfig(templateValue);
  const next = { ...current };
  for (const section of sections) {
    if (section === 'description') next.description = template.description;
    if (section === 'prompts') {
      next.systemPrompt = template.systemPrompt;
      next.userPromptTemplate = template.userPromptTemplate;
    }
    if (section === 'input') next.inputSchema = structuredClone(template.inputSchema ?? {});
    if (section === 'output') next.output = structuredClone(template.output ?? {});
    if (section === 'generation') {
      next.generationOverrides = structuredClone(template.generationOverrides ?? {});
      next.serviceTier = template.serviceTier;
    }
    if (section === 'runtime') next.runtime = structuredClone(template.runtime ?? {});
  }
  next.modelRef = current.modelRef;
  return normalizeAgentConfig(next);
}

function templateChanges(current: AgentConfig, next: AgentConfig, sections: TemplateSection[]) {
  const values = (config: AgentConfig, section: TemplateSection): unknown => {
    if (section === 'description') return { description: config.description };
    if (section === 'prompts')
      return {
        systemPrompt: config.systemPrompt,
        userPromptTemplate: config.userPromptTemplate,
      };
    if (section === 'input') return config.inputSchema;
    if (section === 'output') return config.output;
    if (section === 'generation')
      return { generationOverrides: config.generationOverrides, serviceTier: config.serviceTier };
    return config.runtime;
  };
  return sections.map((section) => {
    const before = values(current, section);
    const after = values(next, section);
    return { section, changed: json(before) !== json(after), before, after };
  });
}

function validateTemplateConfig(config: AgentConfig): void {
  validateUserSchema(config.inputSchema, { topLevelObject: true });
  validateTargetBindingConfig(config);
  commandSpecs(config.runtime?.commands);
  workspaceRoots(config);
  generationOptions(config.generationOverrides);
  serviceTierSetting(config.serviceTier, 422, true);
  runtimeTimePolicy(config);
  if (config.output?.format === 'json') {
    if (!config.output.schema)
      throw new SchemaContractError('INVALID_SCHEMA', 'JSON 출력에는 output.schema가 필요합니다.');
    validateUserSchema(config.output.schema);
  }
}

function runtimeTimePolicy(config: AgentConfig) {
  serviceTierSetting(config.serviceTier, 422, true);
  const runtime = config.runtime;
  const valid = (value: unknown, minimum: number) =>
    Number.isInteger(value) && (value as number) >= minimum && (value as number) <= 3_600_000;
  const split = runtime?.queueTimeoutMs !== undefined || runtime?.executionTimeoutMs !== undefined;
  if (
    !valid(runtime?.timeoutMs ?? 120000, 1) ||
    (split && (!valid(runtime?.queueTimeoutMs, 1000) || !valid(runtime?.executionTimeoutMs, 1000)))
  )
    throw new ProviderError(
      422,
      '전체 제한은 1ms~3600초, 대기·실행 제한은 각각 1~3600초이며 두 값을 함께 설정해야 합니다.',
    );
  return split
    ? {
        queueTimeoutMs: runtime!.queueTimeoutMs!,
        executionTimeoutMs: runtime!.executionTimeoutMs!,
        bridgeTimeoutMs: runtime!.queueTimeoutMs! + runtime!.executionTimeoutMs! + 15000,
      }
    : {
        timeoutMs: runtime?.timeoutMs ?? 120000,
        bridgeTimeoutMs: (runtime?.timeoutMs ?? 120000) + 15000,
      };
}

function templatePublic(row: TemplateRow) {
  return {
    id: row.id,
    origin: row.origin,
    name: row.name,
    version: row.version,
    config: JSON.parse(row.config_json),
    updatedAt: row.updated_at,
  };
}

function isResolvedSnapshot(value: unknown): value is ResolvedConfigSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ResolvedConfigSnapshot>;
  return Boolean(candidate.agent && candidate.model && candidate.provider);
}

function resolveConfigSnapshot(storage: Storage, configValue: AgentConfig): ResolvedConfigSnapshot {
  const agent = normalizeAgentConfig(configValue);
  const model = agent.modelRef ? storage.getModel(agent.modelRef) : undefined;
  if (!model) throw new ProviderError(422, '모델이 설정되지 않았습니다.');
  const provider = storage.getProvider(model.provider_id);
  if (!provider) throw new ProviderError(422, '프로바이더가 설정되지 않았습니다.');
  const snapshot: ResolvedConfigSnapshot = {
    schemaVersion: 1,
    agent,
    model: {
      id: model.id,
      providerId: model.provider_id,
      modelId: model.model_id,
      label: model.label,
      defaultGeneration: generationOptions(JSON.parse(model.defaults_json)),
      serviceTier: serviceTierSetting(model.service_tier) as ServiceTierSetting | undefined,
      capabilities: JSON.parse(model.capabilities_json) as Record<string, unknown>,
      revision: model.revision,
    },
    provider: {
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      location: provider.location,
      config: configFrom(provider),
      revision: provider.revision,
      hasCredential: Boolean(provider.credential_ref),
    },
  };
  effectiveServiceTier(snapshot);
  return snapshot;
}

function appliedConfigSnapshot(storage: Storage, value: unknown): ResolvedConfigSnapshot {
  if (isResolvedSnapshot(value)) {
    return { ...value, agent: normalizeAgentConfig(value.agent) };
  }
  return resolveConfigSnapshot(storage, normalizeAgentConfig(value));
}

function schemaErrorReply(error: SchemaContractError) {
  return {
    status: error.code === 'INVALID_INPUT' ? 400 : 422,
    body: {
      error: { code: error.code, message: error.message, details: error.details },
    },
  };
}

function portableAgentConfig(value: unknown): AgentConfig {
  const config = sanitizeTemplateConfig(value);
  validateTemplateConfig(config);
  return config;
}

function configEnvelope(storage: Storage): ConfigEnvelope {
  return {
    format: 'mcpex-config',
    schemaVersion: 1,
    exportedAt: now(),
    providers: storage.listProviders().map((row) => {
      const config = configFrom(row);
      return {
        id: row.id,
        name: row.name,
        adapter: row.adapter,
        location: row.location,
        config: stripSensitive({
          profileId: config.profileId,
          baseUrl: config.baseUrl,
          headers: config.headers ?? {},
          requestTimeoutMs: config.requestTimeoutMs,
          maxConcurrency: config.maxConcurrency,
          resourceGroup: config.resourceGroup,
          resourceGroupConcurrency: config.resourceGroupConcurrency,
          extraBody: config.extraBody,
        }),
      };
    }),
    models: storage.listModels().map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      modelId: row.model_id,
      label: row.label,
      defaultGeneration: JSON.parse(row.defaults_json),
      serviceTier: row.service_tier ?? undefined,
      capabilities: JSON.parse(row.capabilities_json),
    })),
    agents: storage.listAgents().map((row) => ({
      id: row.id,
      displayName: row.display_name,
      toolName: row.tool_name,
      config: portableAgentConfig(JSON.parse(row.draft_json)),
    })),
    templates: storage
      .listTemplates()
      .filter((row) => row.origin === 'user')
      .map((row) => ({
        id: row.id,
        name: row.name,
        config: portableAgentConfig(JSON.parse(row.config_json)),
      })),
  };
}

function importEnvelope(value: unknown): ConfigEnvelope {
  if (!isRecord(value)) throw new ProviderError(400, '가져오기 설정 객체가 필요합니다.');
  if (value.format !== 'mcpex-config')
    throw new ProviderError(400, '지원하지 않는 설정 파일 형식입니다.');
  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion))
    throw new ProviderError(400, 'schemaVersion이 필요합니다.');
  if (value.schemaVersion > 1)
    throw new ProviderError(422, '현재 버전보다 새로운 설정 파일입니다.');
  if (value.schemaVersion !== 1) throw new ProviderError(400, '지원하지 않는 schemaVersion입니다.');
  const collections = ['providers', 'models', 'agents', 'templates'] as const;
  for (const collection of collections) {
    if (!Array.isArray(value[collection]) || value[collection].length > 1000)
      throw new ProviderError(400, `${collection}는 최대 1000개의 배열이어야 합니다.`);
  }
  return value as ConfigEnvelope;
}

function prepareConfigImport(storage: Storage, value: unknown): PreparedImport {
  const envelope = importEnvelope(value);
  const mappings: PreparedImport['mappings'] = {
    providers: {},
    models: {},
    agents: {},
    templates: {},
  };
  const conflicts: ImportConflict[] = [];
  const timestamp = now();
  const rows: ConfigImportRows = { providers: [], models: [], agents: [], templates: [] };
  const requireSourceId = (
    item: Record<string, unknown>,
    collection: keyof PreparedImport['mappings'],
  ) => {
    if (typeof item.id !== 'string' || !item.id || mappings[collection][item.id])
      throw new ProviderError(400, `${collection} 항목의 id가 없거나 중복되었습니다.`);
    const mapped = newId();
    mappings[collection][item.id] = mapped;
    return { sourceId: item.id, mapped };
  };
  const providerNames = new Set(
    storage.listProviders().map((row) => row.name.trim().toLocaleLowerCase()),
  );
  for (const raw of envelope.providers) {
    if (!isRecord(raw) || !isRecord(raw.config))
      throw new ProviderError(400, 'provider 항목과 config는 객체여야 합니다.');
    const { sourceId, mapped } = requireSourceId(raw, 'providers');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const adapter = typeof raw.adapter === 'string' ? raw.adapter : '';
    const location = raw.location === 'local' ? 'local' : raw.location === 'cloud' ? 'cloud' : '';
    const sourceConfig = stripSensitive(raw.config) as Record<string, unknown>;
    const baseUrl = typeof sourceConfig.baseUrl === 'string' ? sourceConfig.baseUrl : '';
    if (!name || !adapter || !location || !validUrl(baseUrl))
      throw new ProviderError(
        400,
        'provider 이름, adapter, location 또는 baseUrl이 잘못되었습니다.',
      );
    try {
      getAdapter(adapter);
    } catch {
      throw new ProviderError(422, `지원하지 않는 provider adapter입니다: ${adapter}`);
    }
    const headers = sourceConfig.headers ?? {};
    if (!isRecord(headers) || Object.values(headers).some((header) => typeof header !== 'string'))
      throw new ProviderError(400, 'provider headers는 문자열 값 객체여야 합니다.');
    const requestTimeoutMs = boundedInteger(sourceConfig.requestTimeoutMs, 120000, 1000, 1200000);
    const maxConcurrency = boundedInteger(
      sourceConfig.maxConcurrency,
      location === 'local' ? 1 : 2,
      1,
      8,
    );
    const resourceGroup =
      typeof sourceConfig.resourceGroup === 'string' && sourceConfig.resourceGroup.trim()
        ? sourceConfig.resourceGroup.trim().slice(0, 64)
        : undefined;
    const resourceGroupConcurrency = boundedInteger(sourceConfig.resourceGroupConcurrency, 1, 1, 8);
    const normalizedName = name.toLocaleLowerCase();
    if (providerNames.has(normalizedName))
      conflicts.push({ kind: 'provider', sourceId, field: 'name', value: name });
    providerNames.add(normalizedName);
    rows.providers.push({
      id: mapped,
      name,
      adapter,
      location,
      config_json: json({
        profileId: typeof sourceConfig.profileId === 'string' ? sourceConfig.profileId : undefined,
        baseUrl,
        headers,
        requestTimeoutMs,
        maxConcurrency,
        resourceGroup,
        resourceGroupConcurrency,
        extraBody: isRecord(sourceConfig.extraBody) ? sourceConfig.extraBody : undefined,
      }),
      credential_ref: null,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const modelKeys = new Set<string>();
  for (const raw of envelope.models) {
    if (!isRecord(raw)) throw new ProviderError(400, 'model 항목은 객체여야 합니다.');
    const { sourceId, mapped } = requireSourceId(raw, 'models');
    const providerId =
      typeof raw.providerId === 'string' ? mappings.providers[raw.providerId] : undefined;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : modelId;
    if (!providerId || !modelId || !label)
      throw new ProviderError(400, 'model의 provider 참조, modelId 또는 label이 잘못되었습니다.');
    const key = `${providerId}\u0000${modelId}`;
    if (modelKeys.has(key))
      conflicts.push({ kind: 'model', sourceId, field: 'modelId', value: modelId });
    modelKeys.add(key);
    const capabilities = raw.capabilities ?? {};
    if (!isRecord(capabilities)) throw new ProviderError(400, 'capabilities는 객체여야 합니다.');
    const importedTier = serviceTierSetting(raw.serviceTier, 400) as ServiceTierSetting | undefined;
    const importedProvider = rows.providers.find((row) => row.id === providerId)!;
    requireServiceTierSupport(
      importedTier,
      {
        adapter: importedProvider.adapter,
        config: JSON.parse(importedProvider.config_json) as ProviderInput,
      },
      400,
    );
    rows.models.push({
      id: mapped,
      provider_id: providerId,
      model_id: modelId,
      label,
      defaults_json: json(generationOptions(raw.defaultGeneration, 400)),
      service_tier: importedTier ?? null,
      capabilities_json: json(capabilities),
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const toolNames = new Set(
    (
      storage.db.prepare('SELECT tool_name FROM agents WHERE deleted_at IS NULL').all() as Array<{
        tool_name: string;
      }>
    ).map((row) => row.tool_name.toLocaleLowerCase()),
  );
  for (const raw of envelope.agents) {
    if (!isRecord(raw)) throw new ProviderError(400, 'agent 항목은 객체여야 합니다.');
    const { sourceId, mapped } = requireSourceId(raw, 'agents');
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const toolName = typeof raw.toolName === 'string' ? raw.toolName : '';
    if (!displayName || !/^[a-z][a-z0-9_]{0,47}$/.test(toolName) || toolName.startsWith('mcpex_'))
      throw new ProviderError(400, 'agent의 displayName 또는 toolName이 잘못되었습니다.');
    if (toolNames.has(toolName.toLocaleLowerCase()))
      conflicts.push({ kind: 'agent', sourceId, field: 'toolName', value: toolName });
    toolNames.add(toolName.toLocaleLowerCase());
    const config = portableAgentConfig(raw.config);
    rows.agents.push({
      id: mapped,
      display_name: displayName,
      tool_name: toolName,
      enabled: 0,
      draft_json: json(config),
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const templateNames = new Set(
    storage.listTemplates().map((row) => row.name.trim().toLocaleLowerCase()),
  );
  for (const raw of envelope.templates) {
    if (!isRecord(raw)) throw new ProviderError(400, 'template 항목은 객체여야 합니다.');
    const { sourceId, mapped } = requireSourceId(raw, 'templates');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) throw new ProviderError(400, 'template 이름이 필요합니다.');
    const normalizedName = name.toLocaleLowerCase();
    if (templateNames.has(normalizedName))
      conflicts.push({ kind: 'template', sourceId, field: 'name', value: name });
    templateNames.add(normalizedName);
    rows.templates.push({
      id: mapped,
      origin: 'user',
      name,
      version: 1,
      config_json: json(portableAgentConfig(raw.config)),
      updated_at: timestamp,
    });
  }
  return { rows, mappings, conflicts };
}

function importCounts(rows: ConfigImportRows) {
  return {
    providers: rows.providers.length,
    models: rows.models.length,
    agents: rows.agents.length,
    templates: rows.templates.length,
  };
}

function settingInteger(storage: Storage, key: string, fallback: number, min: number, max: number) {
  return boundedInteger(Number(storage.getSetting(key)), fallback, min, max);
}

function syncResourceGroupLimits(storage: Storage, queue: RunQueue): void {
  const limits = new Map<string, number>();
  for (const provider of storage.listProviders()) {
    const config = configFrom(provider);
    const resourceGroup = config.resourceGroup?.trim();
    if (!resourceGroup) continue;
    const limit = boundedInteger(config.resourceGroupConcurrency, 1, 1, 8);
    limits.set(resourceGroup, Math.min(limits.get(resourceGroup) ?? limit, limit));
  }
  queue.setResourceGroupLimits(limits);
}

export async function createServer(
  dataDir: string,
  options: { webDist?: string; mcpConnection?: McpConnectionOptions } = {},
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const lock = new DataDirectoryLock(dataDir);
  lock.acquire();
  let storage: Storage;
  let secrets: AsyncDpapiSecretStore;
  let app: FastifyInstance;
  let localAccessToken: string | undefined;
  let localAccessTokenRevision: string | undefined;
  type UnsafeBlock = UnsafeCommandTermination & {
    id: string;
    workspace: string;
    createdAt: string;
  };
  let unsafeBlocks: UnsafeBlock[] = [];
  try {
    storage = new Storage(dataDir);
    storage.interruptUnfinishedRuns();
    const savedBlocks = storage.getSetting('unsafeCommandBlocks');
    if (savedBlocks) {
      const parsed: unknown = JSON.parse(savedBlocks);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (item) =>
            isRecord(item) &&
            typeof item.id === 'string' &&
            typeof item.workspace === 'string' &&
            (item.workspace === FULL_ACCESS_WORKSPACE || isAbsolute(item.workspace)) &&
            typeof item.createdAt === 'string' &&
            typeof item.reason === 'string' &&
            Array.isArray(item.processes) &&
            item.processes.every(
              (process) =>
                isRecord(process) &&
                Number.isSafeInteger(process.pid) &&
                typeof process.started === 'string' &&
                /^\d+$/.test(process.started),
            ),
        )
      )
        throw new Error(
          '저장된 명령 종료 차단 상태를 확인할 수 없습니다. 서비스 시작을 중지합니다.',
        );
      unsafeBlocks = parsed as UnsafeBlock[];
    }
    secrets = new AsyncDpapiSecretStore(dataDir);
    app = Fastify({ logger: false });
    await app.register(cookie);
    localAccessToken = await getLocalAccessTokenAsync(dataDir);
    localAccessTokenRevision = await secrets.revision(LOCAL_ACCESS_TOKEN_KEY);
  } catch (error) {
    lock.release();
    throw error;
  }
  let purgeInFlight: Promise<{ runs: number; events: number }> | undefined;
  const purge = async (cutoff: string): Promise<{ runs: number; events: number }> => {
    while (purgeInFlight) await purgeInFlight;
    const task = (async () => {
      const total = { runs: 0, events: 0 };
      for (;;) {
        const batch = storage.purgeExpiredRunContentBatch(cutoff);
        total.runs += batch.runs;
        total.events += batch.events;
        if (batch.runs < 100) return total;
        await yieldToLoop();
      }
    })();
    purgeInFlight = task;
    try {
      return await task;
    } finally {
      if (purgeInFlight === task) purgeInFlight = undefined;
    }
  };
  const retentionCutoff = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await purge(retentionCutoff(settingInteger(storage, 'retentionDays', 30, 1, 365)));
  const purgeTimer = setInterval(
    () => {
      void purge(retentionCutoff(settingInteger(storage, 'retentionDays', 30, 1, 365))).catch(() =>
        console.error('MCPex retention cleanup failed.'),
      );
    },
    60 * 60 * 1000,
  );
  purgeTimer.unref?.();
  const queue = new RunQueue(
    settingInteger(storage, 'globalConcurrency', 2, 1, 8),
    settingInteger(storage, 'maxPendingRuns', 100, 1, 1000),
  );
  for (const block of unsafeBlocks) queue.blockWorkspace(block.workspace);
  const recordUnsafeTermination = (workspace: string, failure: UnsafeCommandTermination) => {
    queue.blockWorkspace(workspace);
    unsafeBlocks.push({ id: newId(), workspace, createdAt: now(), ...failure });
    storage.setSettings({ unsafeCommandBlocks: json(unsafeBlocks) });
  };
  const releaseUnsafeBlock = (block: UnsafeBlock) => {
    const remaining = unsafeBlocks.filter((item) => item.id !== block.id);
    storage.setSettings({ unsafeCommandBlocks: json(remaining) });
    unsafeBlocks = remaining;
    if (!remaining.some((item) => item.workspace === block.workspace))
      queue.unblockWorkspace(block.workspace);
  };
  const inspectUnsafeBlock = async (block: UnsafeBlock) => {
    const survivors = survivingTree(await windowsProcessRows(), block.processes);
    block.processes.push(
      ...survivors.filter(
        (item) =>
          !block.processes.some(
            (known) => known.pid === item.pid && known.started === item.started,
          ),
      ),
    );
    storage.setSettings({ unsafeCommandBlocks: json(unsafeBlocks) });
    return survivors;
  };
  for (const provider of storage.listProviders()) {
    const config = configFrom(provider);
    queue.setProviderLimit(provider.id, boundedInteger(config.maxConcurrency, 2, 1, 8));
  }
  syncResourceGroupLimits(storage, queue);
  const activeRuns = new Map<string, AbortController>();
  const activePromises = new Set<Promise<unknown>>();
  const sessions = new Map<string, number>();
  let bootstrap: { token: string; expires: number } | undefined;
  const hasLocalAccessToken = async (request: FastifyRequest) => {
    try {
      const currentRevision = await secrets.revision(LOCAL_ACCESS_TOKEN_KEY);
      if (currentRevision !== localAccessTokenRevision) {
        localAccessToken = currentRevision ? await secrets.get(LOCAL_ACCESS_TOKEN_KEY) : undefined;
        localAccessTokenRevision = currentRevision;
      }
    } catch {
      // 일시적인 secrets 파일 읽기 실패에는 마지막 정상 토큰을 유지한다.
    }
    return localAccessToken ? sameSecret(bearerToken(request), localAccessToken) : false;
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHost(request.headers.host))
      return reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN_HOST', message: '허용되지 않은 Host입니다.' } });
    const path = request.url.split('?', 1)[0];
    if (path === '/health' || path === '/auth/exchange') return;
    if (path === '/auth/bootstrap' || path === '/mcp') {
      if (!(await hasLocalAccessToken(request)))
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHORIZED', message: '로컬 접속 인증이 필요합니다.' } });
      return;
    }
    if (!path.startsWith('/api/')) return;
    const hasLocalToken = await hasLocalAccessToken(request);
    const session = request.cookies.mcpex_session;
    const expires = session ? sessions.get(session) : undefined;
    if (!hasLocalToken && (!expires || expires <= Date.now())) {
      if (session) sessions.delete(session);
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: '유효한 세션이 필요합니다.' } });
    }
    if (!hasLocalToken && unsafeMethods.has(request.method)) {
      const expectedOrigin = `http://${request.headers.host}`;
      if (request.headers.origin !== expectedOrigin || request.headers['x-mcpex-csrf'] !== '1')
        return reply.code(403).send({
          error: { code: 'CSRF_REJECTED', message: 'Origin 또는 CSRF 검증에 실패했습니다.' },
        });
    }
  });
  app.get('/api/v1/safety-blocks', async () => ({ items: unsafeBlocks }));
  app.post('/api/v1/safety-blocks/:id/verify', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const block = unsafeBlocks.find((item) => item.id === id);
    if (!block)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '차단 기록이 없습니다.' } });
    if (!block.processes.length)
      return reply.code(409).send({
        error: {
          code: 'PROCESS_INSPECTION_INCOMPLETE',
          message: '프로세스 식별 기록이 없어 자동 해제할 수 없습니다. 수동 확인이 필요합니다.',
        },
      });
    try {
      if ((await inspectUnsafeBlock(block)).length)
        return reply.code(409).send({
          error: {
            code: 'COMMAND_PROCESS_STILL_RUNNING',
            message: '기록된 명령 프로세스가 아직 실행 중입니다. 차단을 유지합니다.',
          },
        });
    } catch {
      return reply.code(503).send({
        error: {
          code: 'PROCESS_INSPECTION_FAILED',
          message: '프로세스 종료를 확인하지 못했습니다. 차단을 유지합니다.',
        },
      });
    }
    // Snapshots cannot prove that an unobserved intermediate left no descendants.
    return reply.code(409).send({
      error: {
        code: 'PROCESS_INSPECTION_INCOMPLETE',
        message:
          '현재 확인된 프로세스는 없지만 추적 공백으로 전체 종료를 증명할 수 없습니다. 차단을 유지하며 수동 확인이 필요합니다.',
      },
    });
  });
  app.post('/api/v1/safety-blocks/:id/manual-release', async (req, reply) => {
    const block = unsafeBlocks.find((item) => item.id === (req.params as { id: string }).id);
    if (!block)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '차단 기록이 없습니다.' } });
    const body = bodyOf(req);
    if (body.workspace !== block.workspace || body.confirm !== 'I_VERIFIED_PROCESS_TREE_EXITED')
      return reply.code(400).send({
        error: {
          code: 'MANUAL_VERIFICATION_REQUIRED',
          message: '작업 폴더와 전체 프로세스 트리 종료 확인을 명시해야 합니다.',
        },
      });
    try {
      if (block.processes.length && (await inspectUnsafeBlock(block)).length)
        return reply.code(409).send({
          error: {
            code: 'COMMAND_PROCESS_STILL_RUNNING',
            message: '기록된 명령 프로세스가 아직 실행 중입니다. 차단을 유지합니다.',
          },
        });
    } catch {
      return reply.code(503).send({
        error: {
          code: 'PROCESS_INSPECTION_FAILED',
          message: '프로세스 조회 또는 추적 기록 저장에 실패했습니다. 차단을 유지합니다.',
        },
      });
    }
    releaseUnsafeBlock(block);
    return reply.send({ released: true, verification: 'operator_attested' });
  });
  app.get('/health', async () => ({
    status: 'ok',
    service: 'mcpex',
    schemaVersion: SCHEMA_VERSION,
  }));
  app.post('/auth/bootstrap', async (_req, reply) => {
    const expires = Date.now() + 60000;
    const result = {
      token: randomBytes(32).toString('base64url'),
      expiresAt: new Date(expires).toISOString(),
    };
    bootstrap = { token: result.token, expires };
    return reply.send(BootstrapResponse.parse(result));
  });
  app.post('/auth/exchange', async (req, reply) => {
    const body = bodyOf(req);
    const expectedOrigin = `http://${req.headers.host}`;
    if (
      req.headers.origin !== expectedOrigin ||
      req.headers['x-mcpex-csrf'] !== '1' ||
      !bootstrap ||
      body.token !== bootstrap.token ||
      Date.now() > bootstrap.expires
    )
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: '유효하지 않거나 만료된 토큰입니다.' } });
    bootstrap = undefined;
    pruneSessions(sessions);
    const previousSession = req.cookies.mcpex_session;
    if (previousSession) sessions.delete(previousSession);
    const session = randomBytes(32).toString('base64url');
    sessions.set(session, Date.now() + SESSION_TTL_MS);
    reply.setCookie('mcpex_session', session, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return reply.send({ ok: true });
  });
  app.post('/api/v1/config/export', async (_req, reply) => reply.send(configEnvelope(storage)));
  app.post('/api/v1/config/import-preview', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    try {
      const body = bodyOf(req);
      const prepared = prepareConfigImport(storage, body.config ?? body);
      return reply.send({
        canImport: prepared.conflicts.length === 0,
        counts: importCounts(prepared.rows),
        conflicts: prepared.conflicts,
      });
    } catch (error) {
      const problem = error as ProviderError;
      return reply.code(problem.status ?? 400).send({
        error: {
          code: problem.status === 422 ? 'UNSUPPORTED_VERSION' : 'BAD_REQUEST',
          message: problem.message,
        },
      });
    }
  });
  app.post('/api/v1/config/import', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const body = bodyOf(req);
    if (body.confirm !== true)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '미리보기 확인 후 confirm=true가 필요합니다.' },
      });
    try {
      const prepared = prepareConfigImport(storage, body.config);
      if (prepared.conflicts.length)
        return reply.code(409).send({
          error: {
            code: 'IMPORT_CONFLICT',
            message: '기존 설정과 충돌하여 가져오지 않았습니다.',
            details: prepared.conflicts,
          },
        });
      storage.applyConfigImport(prepared.rows);
      for (const provider of prepared.rows.providers) {
        const config = configFrom(provider);
        queue.setProviderLimit(
          provider.id,
          boundedInteger(config.maxConcurrency, provider.location === 'local' ? 1 : 2, 1, 8),
        );
      }
      syncResourceGroupLimits(storage, queue);
      return reply.code(201).send({
        imported: importCounts(prepared.rows),
        mappings: prepared.mappings,
      });
    } catch (error) {
      const problem = error as ProviderError;
      return reply.code(problem.status ?? 409).send({
        error: {
          code: problem.status === 422 ? 'UNSUPPORTED_VERSION' : 'IMPORT_FAILED',
          message: problem.message,
        },
      });
    }
  });
  app.get('/api/v1/settings', async () => ({
    retentionDays: settingInteger(storage, 'retentionDays', 30, 1, 365),
    globalConcurrency: settingInteger(storage, 'globalConcurrency', 2, 1, 8),
    maxPendingRuns: settingInteger(storage, 'maxPendingRuns', 100, 1, 1000),
  }));
  app.get('/api/v1/mcp-connection', async () => {
    const tools: Array<{
      name: string;
      displayName: string;
      description: string;
      runtimeMode: 'response' | 'tools';
      workspaceMode: 'none' | 'fixed' | 'caller' | 'full';
      effectiveTools: string[];
      workspaceState:
        'response_only' | 'no_tools' | 'workspace_disabled' | 'fixed' | 'caller_required' | 'full';
    }> = [];
    const inactiveAgents: Array<{
      name: string;
      displayName: string;
      reason: 'inactive' | 'not_applied';
    }> = [];
    for (const row of storage.listAgents()) {
      if (!row.enabled || !row.applied_version_id) {
        inactiveAgents.push({
          name: row.tool_name,
          displayName: row.display_name,
          reason: row.applied_version_id ? 'inactive' : 'not_applied',
        });
        continue;
      }
      const version = storage.getAgentVersion(row.applied_version_id);
      if (!version) {
        inactiveAgents.push({
          name: row.tool_name,
          displayName: row.display_name,
          reason: 'not_applied',
        });
        continue;
      }
      const stored = JSON.parse(version.config_json) as unknown;
      const config = normalizeAgentConfig(
        isResolvedSnapshot(stored) ? stored.agent : (stored as AgentConfig),
      );
      tools.push({
        name: row.tool_name,
        displayName: row.display_name,
        description: publishedToolDescription(config, row.display_name),
        ...workspaceToolCapability(config),
      });
    }
    tools.sort((left, right) => left.name.localeCompare(right.name));
    inactiveAgents.sort((left, right) => left.name.localeCompare(right.name));
    return {
      transport: 'stdio',
      registration: options.mcpConnection ?? null,
      service: { status: 'ok' },
      clientConnection: { status: 'unverified' },
      tools,
      inactiveAgents,
    };
  });
  app.patch('/api/v1/settings', async (req, reply) => {
    const body = bodyOf(req);
    const current = {
      retentionDays: settingInteger(storage, 'retentionDays', 30, 1, 365),
      globalConcurrency: settingInteger(storage, 'globalConcurrency', 2, 1, 8),
      maxPendingRuns: settingInteger(storage, 'maxPendingRuns', 100, 1, 1000),
    };
    const next = {
      retentionDays: body.retentionDays ?? current.retentionDays,
      globalConcurrency: body.globalConcurrency ?? current.globalConcurrency,
      maxPendingRuns: body.maxPendingRuns ?? current.maxPendingRuns,
    };
    if (
      !Number.isInteger(next.retentionDays) ||
      (next.retentionDays as number) < 1 ||
      (next.retentionDays as number) > 365 ||
      !Number.isInteger(next.globalConcurrency) ||
      (next.globalConcurrency as number) < 1 ||
      (next.globalConcurrency as number) > 8 ||
      !Number.isInteger(next.maxPendingRuns) ||
      (next.maxPendingRuns as number) < 1 ||
      (next.maxPendingRuns as number) > 1000
    )
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '보존 기간 또는 큐 제한이 허용 범위 밖입니다.' },
      });
    storage.setSettings({
      retentionDays: String(next.retentionDays),
      globalConcurrency: String(next.globalConcurrency),
      maxPendingRuns: String(next.maxPendingRuns),
    });
    queue.setConcurrency(next.globalConcurrency as number);
    queue.setMaxPending(next.maxPendingRuns as number);
    const purged = await purge(retentionCutoff(next.retentionDays as number));
    return reply.send({ ...next, purged });
  });
  app.post('/api/v1/backups', async (_req, reply) => {
    const result = await storage.createBackup();
    return reply.code(201).send(result);
  });
  app.get('/api/v1/providers', async () => ({
    items: storage.listProviders().map(providerPublic),
    nextCursor: null,
  }));
  app.get('/api/v1/providers/:id', async (req, reply) => {
    const row = storage.getProvider((req.params as { id: string }).id);
    return row
      ? reply.send(providerPublic(row))
      : reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
  });
  app.get('/api/v1/provider-profiles', async () => ({
    items: listProviderProfiles(),
    nextCursor: null,
  }));
  app.post('/api/v1/providers', async (req, reply) => {
    const b = bodyOf(req) as unknown as ProviderCreateInput;
    const profile = b.profileId ? getProviderProfile(b.profileId) : undefined;
    const adapter = b.adapter ?? profile?.adapter;
    const baseUrl = b.baseUrl ?? profile?.baseUrl;
    if (b.profileId && !profile)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '알 수 없는 provider profile입니다.' },
      });
    if (!b.name || !adapter || !baseUrl || !validUrl(baseUrl))
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '이름, adapter/profile, 올바른 baseUrl이 필요합니다.',
        },
      });
    try {
      getAdapter(adapter);
    } catch (e) {
      const x = e as ProviderError;
      return reply.code(x.status).send({ error: { code: 'BAD_REQUEST', message: x.message } });
    }
    if (
      (b.maxConcurrency !== undefined &&
        (!Number.isInteger(b.maxConcurrency) || b.maxConcurrency < 1 || b.maxConcurrency > 8)) ||
      (b.resourceGroup !== undefined &&
        (typeof b.resourceGroup !== 'string' ||
          !b.resourceGroup.trim() ||
          b.resourceGroup.trim().length > 64)) ||
      (b.resourceGroupConcurrency !== undefined &&
        (!Number.isInteger(b.resourceGroupConcurrency) ||
          b.resourceGroupConcurrency < 1 ||
          b.resourceGroupConcurrency > 8))
    )
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '동시성 제한은 1~8이고 resourceGroup은 64자 이하여야 합니다.',
        },
      });
    const t = now();
    const location = b.location ?? profile?.location ?? 'cloud';
    const maxConcurrency = boundedInteger(b.maxConcurrency, location === 'local' ? 1 : 2, 1, 8);
    const resourceGroup =
      typeof b.resourceGroup === 'string' && b.resourceGroup.trim()
        ? b.resourceGroup.trim().slice(0, 64)
        : undefined;
    const resourceGroupConcurrency = boundedInteger(b.resourceGroupConcurrency, 1, 1, 8);
    const row: ProviderRow = {
      id: newId(),
      name: b.name,
      adapter,
      location,
      config_json: json({
        profileId: b.profileId,
        baseUrl,
        headers: b.headers ?? {},
        requestTimeoutMs: b.requestTimeoutMs ?? 120000,
        maxConcurrency,
        resourceGroup,
        resourceGroupConcurrency,
        extraBody: b.extraBody ?? {},
      }),
      credential_ref: null,
      revision: 1,
      created_at: t,
      updated_at: t,
    };
    storage.createProvider(row);
    queue.setProviderLimit(row.id, maxConcurrency);
    syncResourceGroupLimits(storage, queue);
    return reply.code(201).send(providerPublic(row));
  });
  app.patch('/api/v1/providers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getProvider(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '프로바이더 revision이 일치하지 않습니다.' } });
    const current = configFrom(row);
    const profileId =
      b.profileId === null
        ? undefined
        : typeof b.profileId === 'string'
          ? b.profileId
          : current.profileId;
    const profile = profileId ? getProviderProfile(profileId) : undefined;
    if (profileId && !profile)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '알 수 없는 provider profile입니다.' },
      });
    const profileChanged = Object.hasOwn(b, 'profileId');
    const adapter =
      typeof b.adapter === 'string'
        ? b.adapter
        : profileChanged && profile
          ? profile.adapter
          : row.adapter;
    const baseUrl =
      typeof b.baseUrl === 'string'
        ? b.baseUrl
        : profileChanged && profile
          ? profile.baseUrl
          : current.baseUrl;
    const location =
      typeof b.location === 'string'
        ? b.location
        : profileChanged && profile
          ? profile.location
          : row.location;
    const name = typeof b.name === 'string' ? b.name.trim() : row.name;
    const maxConcurrency =
      b.maxConcurrency === undefined ? current.maxConcurrency : b.maxConcurrency;
    const resourceGroup =
      b.resourceGroup === null
        ? undefined
        : b.resourceGroup === undefined
          ? current.resourceGroup
          : b.resourceGroup;
    const resourceGroupConcurrency =
      b.resourceGroupConcurrency === undefined
        ? current.resourceGroupConcurrency
        : b.resourceGroupConcurrency;
    const requestTimeoutMs =
      b.requestTimeoutMs === undefined ? current.requestTimeoutMs : b.requestTimeoutMs;
    if (!name || !validUrl(baseUrl))
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '이름과 올바른 baseUrl이 필요합니다.' },
      });
    try {
      getAdapter(adapter);
    } catch (error) {
      const providerError = error as ProviderError;
      return reply
        .code(providerError.status)
        .send({ error: { code: 'BAD_REQUEST', message: providerError.message } });
    }
    if (
      !Number.isInteger(maxConcurrency) ||
      Number(maxConcurrency) < 1 ||
      Number(maxConcurrency) > 8 ||
      (resourceGroup !== undefined &&
        (typeof resourceGroup !== 'string' ||
          !resourceGroup.trim() ||
          resourceGroup.trim().length > 64)) ||
      !Number.isInteger(resourceGroupConcurrency) ||
      Number(resourceGroupConcurrency) < 1 ||
      Number(resourceGroupConcurrency) > 8 ||
      !Number.isInteger(requestTimeoutMs) ||
      Number(requestTimeoutMs) < 1000 ||
      Number(requestTimeoutMs) > 1_200_000
    )
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'timeout과 동시성 또는 resourceGroup 설정이 허용 범위를 벗어났습니다.',
        },
      });
    if (
      b.headers !== undefined &&
      (!b.headers ||
        typeof b.headers !== 'object' ||
        Array.isArray(b.headers) ||
        Object.values(b.headers).some((value) => typeof value !== 'string'))
    )
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'headers는 문자열 값 객체여야 합니다.' },
      });
    if (
      b.extraBody !== undefined &&
      (!b.extraBody || typeof b.extraBody !== 'object' || Array.isArray(b.extraBody))
    )
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'extraBody는 객체여야 합니다.' },
      });
    const next: ProviderRow = {
      ...row,
      name,
      adapter,
      location,
      config_json: json({
        profileId,
        baseUrl,
        headers: b.headers ?? current.headers ?? {},
        requestTimeoutMs,
        maxConcurrency,
        resourceGroup: typeof resourceGroup === 'string' ? resourceGroup.trim() : undefined,
        resourceGroupConcurrency,
        extraBody: b.extraBody
          ? { ...current.extraBody, ...b.extraBody }
          : (current.extraBody ?? {}),
      }),
      revision: row.revision + 1,
      updated_at: now(),
    };
    if (!storage.updateProvider(next, row.revision))
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '프로바이더 저장 충돌입니다.' } });
    queue.setProviderLimit(next.id, Number(maxConcurrency));
    syncResourceGroupLimits(storage, queue);
    return reply.send(providerPublic(next));
  });
  app.delete('/api/v1/providers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getProvider(id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    if (storage.countModels(id) > 0)
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '등록 모델이 있는 프로바이더는 삭제할 수 없습니다.' },
      });
    if (row.credential_ref) await secrets.delete(row.credential_ref);
    storage.deleteProvider(id);
    syncResourceGroupLimits(storage, queue);
    return reply.code(204).send();
  });
  app.post('/api/v1/providers/:id/discover-models', async (req, reply) => {
    const row = storage.getProvider((req.params as { id: string }).id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    const c = configFrom(row);
    const operation = providerOperationSignal(req, reply, c.requestTimeoutMs ?? 120000);
    try {
      const ids = await getAdapter(row.adapter).listModels(
        c.baseUrl,
        c.headers ?? {},
        row.credential_ref ? await secrets.get(row.credential_ref) : undefined,
        operation.signal,
      );
      return reply.send({ modelIds: ids });
    } catch (e) {
      if (operation.timeoutSignal.aborted)
        return reply.code(504).send({
          error: {
            code: 'PROVIDER_TIMEOUT',
            message: '공급업체 요청 시간이 초과되었습니다.',
          },
        });
      if (operation.disconnectSignal.aborted) return reply;
      const x = e as ProviderError;
      return reply.code(x.status ?? 502).send({
        error: {
          code: x instanceof ProviderError ? x.code : 'PROVIDER_ERROR',
          message: x.message,
        },
      });
    } finally {
      operation.dispose();
    }
  });
  app.put('/api/v1/providers/:id/credential', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getProvider(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== undefined && b.expectedRevision !== row.revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '프로바이더 revision이 일치하지 않습니다.' } });
    if (typeof b.apiKey !== 'string' || !b.apiKey)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'apiKey가 필요합니다.' } });
    await secrets.set(`provider:${id}`, b.apiKey);
    const next = {
      ...row,
      credential_ref: `provider:${id}`,
      revision: row.revision + 1,
      updated_at: now(),
    };
    storage.updateProvider(next, row.revision);
    return reply.send({ hasCredential: true, revision: next.revision });
  });
  app.delete('/api/v1/providers/:id/credential', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getProvider(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== undefined && b.expectedRevision !== row.revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '프로바이더 revision이 일치하지 않습니다.' } });
    if (row.credential_ref) await secrets.delete(row.credential_ref);
    const next = {
      ...row,
      credential_ref: null,
      revision: row.revision + 1,
      updated_at: now(),
    };
    if (!storage.updateProvider(next, row.revision))
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '프로바이더 저장 충돌입니다.' } });
    return reply.send({ hasCredential: false, revision: next.revision });
  });
  app.get('/api/v1/models', async (req) => ({
    items: storage.listModels((req.query as { providerId?: string }).providerId).map(modelPublic),
    nextCursor: null,
  }));
  app.get('/api/v1/models/:id', async (req, reply) => {
    const row = storage.getModel((req.params as { id: string }).id);
    return row
      ? reply.send(modelPublic(row))
      : reply.code(404).send({ error: { code: 'NOT_FOUND', message: '모델을 찾을 수 없습니다.' } });
  });
  app.post('/api/v1/models', async (req, reply) => {
    const b = bodyOf(req);
    const provider =
      typeof b.providerId === 'string' ? storage.getProvider(b.providerId) : undefined;
    if (!provider || typeof b.modelId !== 'string' || !b.modelId)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'providerId와 modelId가 필요합니다.' } });
    let defaultGeneration: GenerationOptions;
    let serviceTier: ServiceTierSetting | undefined;
    try {
      defaultGeneration = generationOptions(b.defaultGeneration, 400);
      serviceTier = serviceTierSetting(
        b.serviceTier ?? 'provider-default',
        400,
      ) as ServiceTierSetting;
      requireServiceTierSupport(
        serviceTier,
        { adapter: provider.adapter, config: configFrom(provider) },
        400,
      );
    } catch (error) {
      const providerError = error as ProviderError;
      return reply.code(providerError.status).send({
        error: { code: 'BAD_REQUEST', message: providerError.message },
      });
    }
    const t = now();
    const row: ModelRow = {
      id: newId(),
      provider_id: provider.id,
      model_id: b.modelId,
      label: typeof b.label === 'string' ? b.label : b.modelId,
      defaults_json: json(defaultGeneration),
      service_tier: serviceTier,
      capabilities_json: json(b.capabilities ?? { text: { supported: true, source: 'user' } }),
      revision: 1,
      created_at: t,
      updated_at: t,
    };
    try {
      storage.createModel(row);
    } catch {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: '중복 모델입니다.' } });
    }
    return reply.code(201).send(modelPublic(row));
  });
  app.patch('/api/v1/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getModel(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '모델을 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '모델 revision이 일치하지 않습니다.' } });
    const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : row.model_id;
    const label = typeof b.label === 'string' ? b.label.trim() : row.label;
    if (!modelId || !label)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'modelId와 label은 비어 있을 수 없습니다.' },
      });
    let defaultGeneration: GenerationOptions;
    let serviceTier: ServiceTierSetting | undefined;
    const modelProvider = storage.getProvider(row.provider_id)!;
    try {
      defaultGeneration =
        b.defaultGeneration === undefined
          ? generationOptions(JSON.parse(row.defaults_json), 400)
          : generationOptions(b.defaultGeneration, 400);
      serviceTier = serviceTierSetting(
        b.serviceTier === undefined ? row.service_tier : b.serviceTier,
        400,
      ) as ServiceTierSetting | undefined;
      requireServiceTierSupport(
        serviceTier,
        {
          adapter: modelProvider.adapter,
          config: configFrom(modelProvider),
        },
        400,
      );
    } catch (error) {
      const providerError = error as ProviderError;
      return reply.code(providerError.status).send({
        error: { code: 'BAD_REQUEST', message: providerError.message },
      });
    }
    if (
      b.capabilities !== undefined &&
      (!b.capabilities || typeof b.capabilities !== 'object' || Array.isArray(b.capabilities))
    )
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'capabilities는 객체여야 합니다.' },
      });
    const next: ModelRow = {
      ...row,
      model_id: modelId,
      label,
      defaults_json: json(defaultGeneration),
      service_tier: serviceTier ?? null,
      capabilities_json: json(b.capabilities ?? JSON.parse(row.capabilities_json)),
      revision: row.revision + 1,
      updated_at: now(),
    };
    try {
      if (!storage.updateModel(next, row.revision))
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: '모델 저장 충돌입니다.' } });
    } catch {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: '중복 모델입니다.' } });
    }
    return reply.send(modelPublic(next));
  });
  app.delete('/api/v1/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!storage.getModel(id))
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '모델을 찾을 수 없습니다.' } });
    if (storage.countAgentModelReferences(id) > 0)
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '에이전트가 참조하는 모델은 삭제할 수 없습니다.' },
      });
    storage.deleteModel(id);
    return reply.code(204).send();
  });
  app.post('/api/v1/models/:id/probes', async (req, reply) => {
    const model = storage.getModel((req.params as { id: string }).id);
    const b = bodyOf(req);
    if (!model)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '모델을 찾을 수 없습니다.' } });
    const provider = storage.getProvider(model.provider_id)!;
    const c = configFrom(provider);
    const prompt = typeof b.prompt === 'string' ? b.prompt : '간단히 응답해 주세요.';
    const operation = providerOperationSignal(req, reply, c.requestTimeoutMs ?? 120000);
    try {
      const choice = serviceTierSetting(model.service_tier) as ServiceTierSetting | undefined;
      requireServiceTierSupport(choice, { adapter: provider.adapter, config: c });
      const requestTier =
        choice === 'provider-default' &&
        supportsServiceTier({ adapter: provider.adapter, config: c })
          ? null
          : choice === 'provider-default'
            ? undefined
            : choice;
      const requestedTier =
        requestTier === undefined
          ? supportsServiceTier({ adapter: provider.adapter, config: c }) &&
            typeof c.extraBody?.service_tier === 'string'
            ? c.extraBody.service_tier
            : null
          : requestTier;
      const generation = generationOptions(JSON.parse(model.defaults_json));
      const r = await getAdapter(provider.adapter).generate(
        {
          modelId: model.model_id,
          messages: [
            ...(typeof b.systemPrompt === 'string'
              ? [{ role: 'system' as const, content: b.systemPrompt }]
              : []),
            { role: 'user', content: prompt },
          ],
          ...generation,
          serviceTier: requestTier,
          signal: operation.signal,
        },
        c.baseUrl,
        c.headers ?? {},
        provider.credential_ref ? await secrets.get(provider.credential_ref) : undefined,
        c.extraBody,
      );
      return reply.send({
        result: r,
        requestedServiceTier: requestedTier,
        actualServiceTier: r.serviceTier ?? null,
        credentialExposed: false,
      });
    } catch (e) {
      if (operation.timeoutSignal.aborted)
        return reply.code(504).send({
          error: {
            code: 'PROVIDER_TIMEOUT',
            message: '공급업체 요청 시간이 초과되었습니다.',
          },
        });
      if (operation.disconnectSignal.aborted) return reply;
      const x = e as ProviderError;
      return reply.code(x.status ?? 502).send({
        error: {
          code: x instanceof ProviderError ? x.code : 'PROVIDER_ERROR',
          message: x.message,
        },
      });
    } finally {
      operation.dispose();
    }
  });
  const existingBuiltins = new Map(
    storage
      .listTemplates()
      .filter((template) => template.origin === 'builtin')
      .map((template) => [template.name, template]),
  );
  for (const definition of builtinTemplateDefinitions()) {
    const existing = existingBuiltins.get(definition.name);
    const configJson = json(definition.config);
    if (existing) {
      if (existing.config_json !== configJson)
        storage.updateBuiltinTemplate(existing.id, configJson, now());
      continue;
    }
    storage.createTemplate({
      id: newId(),
      origin: 'builtin',
      name: definition.name,
      version: 1,
      config_json: configJson,
      updated_at: now(),
    });
  }
  app.get('/api/v1/agents', async () => ({
    items: storage.listAgents().map((row) => {
      const version = row.applied_version_id
        ? storage.getAgentVersion(row.applied_version_id)
        : undefined;
      const stored = version ? JSON.parse(version.config_json) : undefined;
      const appliedConfig = stored
        ? isResolvedSnapshot(stored)
          ? stored.agent
          : (stored as AgentConfig)
        : undefined;
      return {
        ...agentPublic(row),
        appliedScopeMissing: appliedConfig ? scopeMissingFromPrompt(appliedConfig) : false,
      };
    }),
    nextCursor: null,
  }));
  app.post('/api/v1/agents', async (req, reply) => {
    const b = bodyOf(req);
    const displayName = typeof b.displayName === 'string' ? b.displayName : '';
    const toolName = typeof b.toolName === 'string' ? b.toolName : '';
    if (!displayName || !/^[a-z][a-z0-9_]{0,47}$/.test(toolName) || toolName.startsWith('mcpex_'))
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'displayName과 올바른 toolName이 필요합니다.' },
      });
    const t = now();
    const row: AgentRow = {
      id: newId(),
      display_name: displayName,
      tool_name: toolName,
      enabled: 0,
      draft_json: json(
        normalizeAgentConfig(
          b.config ?? defaultConfig(typeof b.modelRef === 'string' ? b.modelRef : null),
        ),
      ),
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: t,
      updated_at: t,
    };
    try {
      runtimeTimePolicy(JSON.parse(row.draft_json));
      storage.createAgent(row);
    } catch (error) {
      if (error instanceof ProviderError)
        return reply
          .code(error.status)
          .send({ error: { code: 'INVALID_CONFIG', message: error.message } });
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '동일한 toolName이 이미 있습니다.' } });
    }
    return reply.code(201).send(agentPublic(row));
  });
  app.post('/api/v1/agents/:id/duplicate', async (req, reply) => {
    const source = storage.getAgent((req.params as { id: string }).id);
    const b = bodyOf(req);
    if (!source)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    const toolName = typeof b.toolName === 'string' ? b.toolName : '';
    const displayName =
      typeof b.displayName === 'string' ? b.displayName.trim() : `${source.display_name} 복사본`;
    if (!displayName || !/^[a-z][a-z0-9_]{0,47}$/.test(toolName) || toolName.startsWith('mcpex_'))
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'displayName과 새 toolName이 필요합니다.' },
      });
    const timestamp = now();
    const duplicate: AgentRow = {
      id: newId(),
      display_name: displayName,
      tool_name: toolName,
      enabled: 0,
      draft_json: json(normalizeAgentConfig(JSON.parse(source.draft_json))),
      draft_revision: 1,
      applied_version_id: null,
      deleted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      storage.createAgent(duplicate);
    } catch {
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '동일한 toolName이 이미 있습니다.' } });
    }
    return reply.code(201).send(agentPublic(duplicate));
  });
  app.get('/api/v1/agents/:id', async (req, reply) => {
    const row = storage.getAgent((req.params as { id: string }).id);
    return row
      ? reply.send(agentPublic(row))
      : reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
  });
  app.patch('/api/v1/agents/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getAgent(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.draft_revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 revision이 일치하지 않습니다.' } });
    const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : row.display_name;
    const toolName = typeof b.toolName === 'string' ? b.toolName : row.tool_name;
    if (!displayName || !/^[a-z][a-z0-9_]{0,47}$/.test(toolName) || toolName.startsWith('mcpex_'))
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'displayName 또는 toolName이 올바르지 않습니다.' },
      });
    if (row.applied_version_id && toolName !== row.tool_name)
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: '적용된 에이전트의 toolName은 변경할 수 없습니다. 복제 기능을 사용하세요.',
        },
      });
    const next = {
      ...row,
      display_name: displayName,
      tool_name: toolName,
      draft_json: json(normalizeAgentConfig(b.config ?? JSON.parse(row.draft_json))),
      draft_revision: row.draft_revision + 1,
      updated_at: now(),
    };
    try {
      runtimeTimePolicy(JSON.parse(next.draft_json));
      if (!storage.updateAgentDraft(next, row.draft_revision))
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: '초안 저장 충돌입니다.' } });
    } catch (error) {
      if (error instanceof ProviderError)
        return reply
          .code(error.status)
          .send({ error: { code: 'INVALID_CONFIG', message: error.message } });
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '동일한 toolName이 이미 있습니다.' } });
    }
    return reply.send(agentPublic(next));
  });
  app.post('/api/v1/agents/:id/draft-discard', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getAgent(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.draft_revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 revision이 일치하지 않습니다.' } });
    if (!row.applied_version_id)
      return reply.code(409).send({
        error: {
          code: 'CONFLICT',
          message: '적용 전 에이전트는 초안 변경 폐기 대신 에이전트 삭제를 사용하세요.',
        },
      });
    const appliedVersion = storage.getAgentVersion(row.applied_version_id);
    if (!appliedVersion)
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '복원할 적용 버전을 찾을 수 없습니다.' },
      });
    const storedConfig = JSON.parse(appliedVersion.config_json) as unknown;
    const restoredConfig = normalizeAgentConfig(
      isResolvedSnapshot(storedConfig) ? storedConfig.agent : (storedConfig as AgentConfig),
    );
    const next: AgentRow = {
      ...row,
      draft_json: json(restoredConfig),
      draft_revision: row.draft_revision + 1,
      updated_at: now(),
    };
    if (!storage.updateAgentDraft(next, row.draft_revision))
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 변경 폐기 충돌입니다.' } });
    return reply.send(agentPublic(next));
  });
  app.delete('/api/v1/agents/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getAgent(id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (row.enabled)
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '활성 에이전트는 비활성화한 뒤 삭제해야 합니다.' },
      });
    if (!storage.softDeleteAgent(id))
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '에이전트 삭제 충돌입니다.' } });
    return reply.code(204).send();
  });
  app.post('/api/v1/agents/:id/apply', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getAgent(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.draft_revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 revision이 일치하지 않습니다.' } });
    const config = normalizeAgentConfig(JSON.parse(row.draft_json));
    let snapshot: ResolvedConfigSnapshot;
    try {
      snapshot = resolveConfigSnapshot(storage, config);
      runtimeTimePolicy(config);
      validateUserSchema(config.inputSchema, { topLevelObject: true });
      validateTargetBindingConfig(config);
      commandSpecs(config.runtime?.commands);
      workspaceRoots(config);
      if (config.output?.format === 'json') {
        if (!config.output.schema)
          throw new SchemaContractError(
            'INVALID_SCHEMA',
            'JSON 출력에는 output.schema가 필요합니다.',
          );
        validateUserSchema(config.output.schema);
      }
    } catch (error) {
      if (error instanceof SchemaContractError) {
        const response = schemaErrorReply(error);
        return reply.code(response.status).send(response.body);
      }
      if (error instanceof ProviderError || error instanceof WorkspacePolicyError)
        return reply
          .code(error.status)
          .send({ error: { code: 'INVALID_CONFIG', message: error.message } });
      throw error;
    }
    const previous = storage.latestAgentVersion(id);
    const version: AgentVersionRow = {
      id: newId(),
      agent_id: id,
      version: (previous?.version ?? 0) + 1,
      config_json: json(snapshot),
      created_at: now(),
    };
    storage.applyAgentVersion(version);
    return reply.code(201).send({ versionId: version.id, version: version.version, config });
  });
  app.put('/api/v1/agents/:id/activation', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = bodyOf(req);
    if (!storage.getAgent(id))
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (typeof b.enabled !== 'boolean' || !storage.setAgentEnabled(id, b.enabled))
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '적용 버전이 있는 에이전트만 활성화할 수 있습니다.' },
      });
    return reply.send({ id, enabled: b.enabled });
  });
  app.get('/api/v1/templates', async () => ({
    items: storage.listTemplates().map(templatePublic),
    nextCursor: null,
  }));
  app.get('/api/v1/templates/:id', async (req, reply) => {
    const row = storage.getTemplate((req.params as { id: string }).id);
    return row
      ? reply.send(templatePublic(row))
      : reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' } });
  });
  app.post('/api/v1/templates', async (req, reply) => {
    const b = bodyOf(req);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const sourceAgent = typeof b.agentId === 'string' ? storage.getAgent(b.agentId) : undefined;
    if (
      !name ||
      (b.agentId !== undefined && !sourceAgent) ||
      (!sourceAgent && b.config === undefined)
    )
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '이름과 config 또는 유효한 agentId가 필요합니다.',
        },
      });
    const config = sanitizeTemplateConfig(
      sourceAgent ? JSON.parse(sourceAgent.draft_json) : b.config,
    );
    try {
      validateTemplateConfig(config);
    } catch (error) {
      if (error instanceof SchemaContractError) {
        const response = schemaErrorReply(error);
        return reply.code(response.status).send(response.body);
      }
      const providerError = error as ProviderError;
      return reply
        .code(providerError.status ?? 422)
        .send({ error: { code: 'INVALID_CONFIG', message: providerError.message } });
    }
    const row: TemplateRow = {
      id: newId(),
      origin: 'user',
      name,
      version: 1,
      config_json: json(config),
      updated_at: now(),
    };
    storage.createTemplate(row);
    return reply.code(201).send(templatePublic(row));
  });
  app.patch('/api/v1/templates/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getTemplate(id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' } });
    if (row.origin !== 'user')
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '기본 템플릿은 수정할 수 없습니다.' },
      });
    if (b.expectedVersion !== row.version)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '템플릿 version이 일치하지 않습니다.' } });
    const name = typeof b.name === 'string' ? b.name.trim() : row.name;
    if (!name)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: '템플릿 이름이 필요합니다.' } });
    const config = sanitizeTemplateConfig(b.config ?? JSON.parse(row.config_json));
    try {
      validateTemplateConfig(config);
    } catch (error) {
      if (error instanceof SchemaContractError) {
        const response = schemaErrorReply(error);
        return reply.code(response.status).send(response.body);
      }
      const providerError = error as ProviderError;
      return reply
        .code(providerError.status ?? 422)
        .send({ error: { code: 'INVALID_CONFIG', message: providerError.message } });
    }
    const next: TemplateRow = {
      ...row,
      name,
      version: row.version + 1,
      config_json: json(config),
      updated_at: now(),
    };
    if (!storage.updateTemplate(next, row.version))
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '템플릿 저장 충돌입니다.' } });
    return reply.send(templatePublic(next));
  });
  app.delete('/api/v1/templates/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = storage.getTemplate(id);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' } });
    if (row.origin !== 'user')
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '기본 템플릿은 삭제할 수 없습니다.' },
      });
    storage.deleteTemplate(id);
    return reply.code(204).send();
  });
  app.post('/api/v1/agents/:id/template-preview', async (req, reply) => {
    const agent = storage.getAgent((req.params as { id: string }).id);
    const b = bodyOf(req);
    const template =
      typeof b.templateId === 'string' ? storage.getTemplate(b.templateId) : undefined;
    if (!agent)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (!template)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' } });
    try {
      const sections = selectedTemplateSections(b.sections);
      const current = normalizeAgentConfig(JSON.parse(agent.draft_json));
      const next = applyTemplateConfig(current, JSON.parse(template.config_json), sections);
      return reply.send({
        templateId: template.id,
        sections,
        changes: templateChanges(current, next, sections),
      });
    } catch (error) {
      const providerError = error as ProviderError;
      return reply
        .code(providerError.status ?? 400)
        .send({ error: { code: 'BAD_REQUEST', message: providerError.message } });
    }
  });
  app.post('/api/v1/agents/:id/template-apply', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const agent = storage.getAgent(id);
    const b = bodyOf(req);
    const template =
      typeof b.templateId === 'string' ? storage.getTemplate(b.templateId) : undefined;
    if (!agent)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (!template)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '템플릿을 찾을 수 없습니다.' } });
    if (b.expectedRevision !== agent.draft_revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 revision이 일치하지 않습니다.' } });
    try {
      const sections = selectedTemplateSections(b.sections);
      const nextConfig = applyTemplateConfig(
        JSON.parse(agent.draft_json),
        JSON.parse(template.config_json),
        sections,
      );
      validateTemplateConfig(sanitizeTemplateConfig(nextConfig));
      const next: AgentRow = {
        ...agent,
        draft_json: json(nextConfig),
        draft_revision: agent.draft_revision + 1,
        updated_at: now(),
      };
      if (!storage.updateAgentDraft(next, agent.draft_revision))
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: '초안 저장 충돌입니다.' } });
      return reply.send(agentPublic(next));
    } catch (error) {
      if (error instanceof SchemaContractError) {
        const response = schemaErrorReply(error);
        return reply.code(response.status).send(response.body);
      }
      const providerError = error as ProviderError;
      return reply
        .code(providerError.status ?? 422)
        .send({ error: { code: 'INVALID_CONFIG', message: providerError.message } });
    }
  });
  app.post('/api/v1/agents/:id/preview', async (req, reply) => {
    const row = storage.getAgent((req.params as { id: string }).id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    const c = normalizeAgentConfig(b.config ?? JSON.parse(row.draft_json));
    const input = (b.input ?? {}) as Record<string, unknown>;
    const model = c.modelRef ? storage.getModel(c.modelRef) : undefined;
    let resolvedGeneration: GenerationOptions;
    let previewTier: { requested: string | null; source: string } | null = null;
    try {
      resolvedGeneration = {
        ...generationOptions(model ? JSON.parse(model.defaults_json) : undefined),
        ...generationOptions(c.generationOverrides),
      };
      if (model) {
        const tier = effectiveServiceTier(resolveConfigSnapshot(storage, c));
        previewTier = { requested: tier.requested, source: tier.source };
      }
    } catch (error) {
      const providerError = error as ProviderError;
      return reply.code(providerError.status).send({
        error: { code: 'INVALID_CONFIG', message: providerError.message },
      });
    }
    let modelInput: Record<string, unknown>;
    try {
      modelInput = targetInputForModel(c, input);
    } catch (error) {
      if (error instanceof TargetBindingError)
        return reply.code(400).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
    return reply.send({
      messages: [
        ...(c.systemPrompt ? [{ role: 'system', content: c.systemPrompt }] : []),
        ...(c.runtime?.targetBinding === 'optional' && Array.isArray(modelInput.targets)
          ? [
              {
                role: 'system',
                content: targetSystemMessage(
                  modelInput.targets as Array<{ id: string; access: string }>,
                ),
              },
            ]
          : []),
        { role: 'user', content: interpolate(c.userPromptTemplate ?? '', modelInput) },
      ],
      generationOptions: resolvedGeneration,
      serviceTier: previewTier,
    });
  });
  async function executeAgent(
    run: RunRow,
    snapshot: ResolvedConfigSnapshot,
    input: Record<string, unknown>,
    signal: AbortSignal,
    credential: string | undefined,
  ) {
    const config = snapshot.agent;
    const observations: RunObservations = {
      toolCalls: 0,
      changes: [],
      checks: [],
      toolFailures: [],
      truncated: false,
    };
    let modelUsage: ModelUsage | null = null;
    validateInput(config.inputSchema, input);
    const c = snapshot.provider.config;
    const commands = commandSpecs(config.runtime?.commands);
    const resolvedGeneration = {
      ...snapshot.model.defaultGeneration,
      ...generationOptions(config.generationOverrides),
    };
    const tier = effectiveServiceTier(snapshot);
    try {
      const modelInput = targetInputForModel(config, input);
      const initialMessages: ChatMessage[] = [
        ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
        ...(snapshot.execution?.targets
          ? [
              {
                role: 'system' as const,
                content: targetSystemMessage(
                  snapshot.execution.targets.map(({ id, access }) => ({ id, access })),
                ),
              },
            ]
          : []),
        {
          role: 'user' as const,
          content: interpolate(config.userPromptTemplate ?? '', modelInput),
        },
      ];
      const workspace = snapshot.execution?.workspace ?? undefined;
      const fullAccess = snapshot.execution?.workspaceSource === 'full';
      const ordinaryTools =
        (workspace || fullAccess) && config.runtime?.mode === 'tools'
          ? getWorkspaceToolDefinitions(fullAccess, commands).filter((tool) =>
              config.runtime?.tools?.includes(tool.name),
            )
          : [];
      const targets = snapshot.execution?.targets;
      const targetTools = targets
        ? targetToolDefinitions.filter((tool) =>
            tool.name === 'read_target'
              ? config.runtime?.tools?.includes('read_file') &&
                targets.some((target) => target.access !== 'write')
              : tool.name === 'write_target'
                ? config.runtime?.tools?.includes('write_file') &&
                  targets.some((target) => target.access !== 'read')
                : config.runtime?.tools?.includes('replace_text') &&
                  targets.some((target) => target.access === 'readwrite'),
          )
        : [];
      const enabledTools = targets ? targetTools : ordinaryTools;
      const enabledToolNames = new Set(enabledTools.map((tool) => tool.name));
      const workspaceTools =
        workspace || fullAccess
          ? new WorkspaceTools(fullAccess ? null : workspace!, {}, commands, (failure) =>
              recordUnsafeTermination(fullAccess ? FULL_ACCESS_WORKSPACE : workspace!, failure),
            )
          : undefined;
      const generate = async (
        messages: ChatMessage[],
        tools: ToolDefinition[],
        parentSignal?: AbortSignal,
      ) => {
        storage.appendRunEvent(run.id, 'model.started', json({ modelId: snapshot.model.modelId }));
        const requestTimeout = Math.max(1, c.requestTimeoutMs ?? 120000);
        const requestTimeoutSignal = AbortSignal.timeout(requestTimeout);
        const requestSignal = parentSignal
          ? AbortSignal.any([parentSignal, requestTimeoutSignal])
          : requestTimeoutSignal;
        try {
          const generated = await getAdapter(snapshot.provider.adapter).generate(
            {
              modelId: snapshot.model.modelId,
              messages,
              tools,
              temperature: resolvedGeneration.temperature,
              topP: resolvedGeneration.topP,
              maxOutputTokens: resolvedGeneration.maxOutputTokens,
              serviceTier: tier.request,
              signal: requestSignal,
            },
            c.baseUrl,
            c.headers ?? {},
            credential,
            c.extraBody,
          );
          if (generated.usage) {
            modelUsage ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            modelUsage.promptTokens += generated.usage.promptTokens;
            modelUsage.completionTokens += generated.usage.completionTokens;
            modelUsage.totalTokens += generated.usage.totalTokens;
          }
          storage.appendRunEvent(
            run.id,
            'model.finished',
            json({
              ok: true,
              finishReason: generated.finishReason,
              usage: generated.usage,
              providerRequestId: generated.providerRequestId,
              requestedServiceTier: tier.requested,
              actualServiceTier: generated.serviceTier ?? null,
              serviceTierSource: tier.source,
            }),
          );
          return generated;
        } catch (error) {
          storage.appendRunEvent(
            run.id,
            'model.finished',
            json({ ok: false, requestedServiceTier: tier.requested }),
          );
          if (requestTimeoutSignal.aborted && !parentSignal?.aborted)
            throw new QueueError('PROVIDER_TIMEOUT', '공급업체 요청 시간이 초과되었습니다.');
          throw error;
        }
      };
      let result;
      if (enabledTools.length && workspaceTools) {
        result = await runToolLoop({
          initialMessages,
          tools: enabledTools,
          maxTurns: config.runtime?.maxModelTurns,
          maxToolCalls: config.runtime?.maxToolCalls,
          signal,
          generate,
          execute: async (call, signal) => {
            observations.toolCalls++;
            storage.appendRunEvent(
              run.id,
              'tool.started',
              json({
                callId: call.id,
                name: call.name,
                ...(targets && typeof call.arguments.targetId === 'string'
                  ? { targetId: call.arguments.targetId }
                  : {}),
              }),
            );
            try {
              const toolResult = targets
                ? await executeTargetTool(
                    workspaceTools,
                    targets,
                    enabledToolNames,
                    call.name,
                    call.arguments,
                    signal,
                  )
                : await executeWorkspaceTool(
                    workspaceTools,
                    enabledToolNames,
                    call.name,
                    call.arguments,
                    signal,
                  );
              const resultRecord = isRecord(toolResult) ? toolResult : undefined;
              const observation =
                resultRecord && isRecord(resultRecord.observation)
                  ? resultRecord.observation
                  : undefined;
              if (observation?.truncated === true) observations.truncated = true;
              if (
                ['write_file', 'replace_text', 'write_target', 'replace_target'].includes(
                  call.name,
                ) &&
                (typeof resultRecord?.path === 'string' ||
                  typeof resultRecord?.targetId === 'string')
              )
                observations.changes.push({
                  tool: call.name as RunObservations['changes'][number]['tool'],
                  ...(typeof resultRecord?.path === 'string' ? { path: resultRecord.path } : {}),
                  ...(typeof resultRecord?.targetId === 'string'
                    ? { targetId: resultRecord.targetId }
                    : {}),
                });
              if (
                call.name === 'run_command' &&
                typeof resultRecord?.commandId === 'string' &&
                (typeof resultRecord.exitCode === 'number' || resultRecord.exitCode === null)
              )
                observations.checks.push({
                  tool: 'run_command',
                  commandId: resultRecord.commandId,
                  exitCode: resultRecord.exitCode,
                });
              storage.appendRunEvent(
                run.id,
                'tool.finished',
                json({
                  callId: call.id,
                  name: call.name,
                  ok: true,
                  ...(targets && typeof call.arguments.targetId === 'string'
                    ? { targetId: call.arguments.targetId }
                    : {}),
                  observation: observation ?? null,
                }),
              );
              return json(toolResult);
            } catch (error) {
              const code =
                error &&
                typeof error === 'object' &&
                'code' in error &&
                typeof error.code === 'string' &&
                /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
                  ? error.code
                  : 'TOOL_ERROR';
              observations.toolFailures.push({ code });
              storage.appendRunEvent(
                run.id,
                'tool.finished',
                json({
                  callId: call.id,
                  name: call.name,
                  ok: false,
                  ...(targets && typeof call.arguments.targetId === 'string'
                    ? { targetId: call.arguments.targetId }
                    : {}),
                  error: { code },
                  diagnostic: targets
                    ? {
                        targetId:
                          typeof call.arguments.targetId === 'string'
                            ? call.arguments.targetId
                            : null,
                      }
                    : toolFailureDiagnostic(call.name, call.arguments, workspace, error),
                }),
              );
              if (targets && !(error instanceof ToolError))
                throw new ToolError('TARGET_FILE_ERROR', '대상 파일 작업에 실패했습니다.');
              throw error;
            }
          },
        });
      } else {
        result = await generate(initialMessages, [], signal);
        if (result.toolCalls.length)
          throw new ProviderError(
            422,
            '도구 사용이 활성화되지 않은 응답에서 tool call이 반환되었습니다.',
          );
      }
      const text = result.text;
      const output = validateOutput(config.output, text);
      const verification = taskVerification(observations);
      storage.finishRun(run.id, 'completed', json(output), null, { verification });
      return {
        run,
        result: {
          text,
          output,
          observations,
          verification,
          validation: {
            format: config.output?.format === 'json' ? 'passed' : 'not_required',
            model: 'not_configured',
          },
          usage: modelUsage,
          durationMs: Math.max(0, Date.now() - Date.parse(run.created_at)),
        },
      };
    } catch (e) {
      if (e && typeof e === 'object')
        (e as ErrorWithTelemetry).executionTelemetry = {
          observations,
          usage: modelUsage,
          durationMs: Math.max(0, Date.now() - Date.parse(run.created_at)),
        };
      if (e instanceof SchemaContractError) {
        storage.finishRun(
          run.id,
          'failed',
          e.output ? json(e.output) : null,
          json({ code: e.code, message: e.message, details: e.details }),
          { verification: taskVerification(observations) },
        );
        throw e;
      }
      if (e instanceof ToolError && e.code === 'COMMAND_TERMINATION_FAILED') {
        storage.finishRun(run.id, 'failed', null, json({ code: e.code, message: e.message }), {
          verification: taskVerification(observations),
        });
        throw e;
      }
      if (e instanceof QueueError || signal.aborted) throw e;
      const x = e as ProviderError;
      storage.finishRun(
        run.id,
        'failed',
        null,
        json({ code: x instanceof ProviderError ? x.code : 'PROVIDER_ERROR', message: x.message }),
        { verification: taskVerification(observations) },
      );
      throw x;
    }
  }
  async function submitAgent(
    row: AgentRow,
    versionId: string | null,
    source: string,
    snapshot: ResolvedConfigSnapshot,
    input: Record<string, unknown>,
    callerSignal?: AbortSignal,
    callerWorkspace?: string,
  ) {
    if (callerSignal?.aborted) throw new QueueError('CANCELLED', '실행이 취소되었습니다.');
    const config = snapshot.agent;
    validateInput(config.inputSchema, input);
    commandSpecs(config.runtime?.commands);
    generationOptions(config.generationOverrides);
    generationOptions(snapshot.model.defaultGeneration);
    effectiveServiceTier(snapshot);
    const timePolicy = runtimeTimePolicy(config);
    const resolvedWorkspace = resolveRunWorkspace(config, callerWorkspace);
    const safetyWorkspace =
      'lock' in resolvedWorkspace ? resolvedWorkspace.lock : resolvedWorkspace.workspace;
    if (safetyWorkspace && queue.isWorkspaceBlocked(safetyWorkspace))
      throw new QueueError('WORKSPACE_BLOCKED', '명령 종료 확인 실패·추가 실행 차단 상태입니다.');
    if (!queue.canAccept) throw new QueueError('QUEUE_FULL', '실행 대기열이 가득 찼습니다.');
    const targets = await bindTargets(
      config,
      input,
      resolvedWorkspace.workspace,
      resolvedWorkspace.source,
      callerSignal,
    );
    if (callerSignal?.aborted) throw new QueueError('CANCELLED', '실행이 취소되었습니다.');
    const runSnapshot: ResolvedConfigSnapshot = {
      ...snapshot,
      execution: {
        workspace: resolvedWorkspace.workspace ?? null,
        workspaceSource: resolvedWorkspace.source,
        ...(targets ? { targets } : {}),
      },
    };
    const providerConfig = snapshot.provider.config;
    const credentialRef = storage.getProvider(snapshot.provider.id)?.credential_ref;
    const credential = credentialRef ? await secrets.get(credentialRef) : undefined;
    if (callerSignal?.aborted) throw new QueueError('CANCELLED', '실행이 취소되었습니다.');
    queue.setProviderLimit(
      snapshot.provider.id,
      boundedInteger(
        providerConfig.maxConcurrency,
        snapshot.provider.location === 'local' ? 1 : 2,
        1,
        8,
      ),
    );
    const run: RunRow = {
      id: newId(),
      agent_id: row.id,
      agent_version_id: versionId,
      source,
      status: 'queued',
      input_json: json(input),
      output_json: null,
      error_json: null,
      created_at: now(),
      finished_at: null,
      config_snapshot_json: json(runSnapshot),
    };
    storage.createRun(run);
    const controller = new AbortController();
    const cancelFromCaller = () => controller.abort();
    callerSignal?.addEventListener('abort', cancelFromCaller, { once: true });
    if (callerSignal?.aborted) cancelFromCaller();
    activeRuns.set(run.id, controller);
    const workspace = safetyWorkspace;
    const promise = queue
      .submit(
        async (signal) => {
          if (!storage.startRun(run.id))
            throw new QueueError('CANCELLED', '실행을 시작할 수 없습니다.');
          return executeAgent(run, runSnapshot, input, signal, credential);
        },
        workspace,
        controller.signal,
        {
          provider: snapshot.model.providerId,
          runId: run.id,
          resourceGroup: providerConfig.resourceGroup,
          deadlineAt: Date.now() + (timePolicy.queueTimeoutMs ?? timePolicy.timeoutMs ?? 120000),
          executionTimeoutMs: timePolicy.executionTimeoutMs,
        },
      )
      .catch((error: unknown) => {
        if (error instanceof QueueError) {
          const status =
            error.code === 'CANCELLED'
              ? 'cancelled'
              : isTimeoutCode(error.code)
                ? 'timed_out'
                : 'failed';
          storage.finishRun(
            run.id,
            status,
            null,
            json({ code: error.code, message: error.message }),
            { verification: taskVerification(executionTelemetryFrom(error)?.observations) },
          );
        }
        throw error;
      })
      .finally(() => {
        callerSignal?.removeEventListener('abort', cancelFromCaller);
        activeRuns.delete(run.id);
      });
    activePromises.add(promise);
    void promise.finally(() => activePromises.delete(promise)).catch(() => undefined);
    return { run, promise };
  }
  app.post('/api/v1/agents/:id/test-runs', async (req, reply) => {
    const row = storage.getAgent((req.params as { id: string }).id);
    const b = bodyOf(req);
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '에이전트를 찾을 수 없습니다.' } });
    if (b.expectedRevision !== row.draft_revision)
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: '초안 revision이 일치하지 않습니다.' } });
    try {
      const config = normalizeAgentConfig(JSON.parse(row.draft_json));
      const snapshot = resolveConfigSnapshot(storage, config);
      const submitted = await submitAgent(
        row,
        null,
        'ui',
        snapshot,
        (b.input ?? {}) as Record<string, unknown>,
        undefined,
        typeof b.workspace === 'string' ? b.workspace : undefined,
      );
      void submitted.promise.catch(() => undefined);
      return reply.code(202).send({
        runId: submitted.run.id,
        status: 'queued',
      });
    } catch (e) {
      if (e instanceof SchemaContractError) {
        const response = schemaErrorReply(e);
        return reply.code(response.status).send(response.body);
      }
      if (e instanceof QueueError)
        return reply
          .code(
            e.code === 'QUEUE_FULL'
              ? 429
              : ['CANCELLED', 'WORKSPACE_BLOCKED'].includes(e.code)
                ? 409
                : 504,
          )
          .send({
            error: { code: e.code, message: e.message },
          });
      if (e instanceof WorkspacePolicyError)
        return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
      if (e instanceof TargetBindingError)
        return reply
          .code(422)
          .send({ error: { code: e.code, message: e.message, targetId: e.targetId } });
      const x = e as ProviderError;
      return reply
        .code(x.status ?? 502)
        .send({ error: { code: 'PROVIDER_ERROR', message: x.message } });
    }
  });
  app.get('/api/v1/runs/:id', async (req, reply) => {
    const r = storage.getRun((req.params as { id: string }).id);
    if (!r)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '실행 기록을 찾을 수 없습니다.' } });
    return reply.send(
      runPublic(
        r,
        queue.waitReason(r.id),
        storedTaskVerification(storage, r.id),
        storedTargetChanges(storage, r),
        storedServiceTiers(storage, r),
      ),
    );
  });
  app.get('/api/v1/runs/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = storage.getRun(id);
    if (!run)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '실행 기록을 찾을 수 없습니다.' } });
    if (run.events_expired_at)
      return reply.code(410).send({
        error: {
          code: 'EVENTS_EXPIRED',
          message: '이 실행의 이벤트 보존 기간이 지났습니다.',
          details: { expiredAt: run.events_expired_at },
        },
      });
    const queryValue = (req.query as { afterSeq?: string }).afterSeq;
    const headerValue = req.headers['last-event-id'];
    const cursorValue = queryValue ?? (Array.isArray(headerValue) ? headerValue[0] : headerValue);
    const parsedCursor = cursorValue === undefined ? 0 : Number(cursorValue);
    if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0)
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'afterSeq 또는 Last-Event-ID가 올바르지 않습니다.' },
      });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let cursor = parsedCursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      reply.raw.off('drain', pump);
      reply.raw.off('close', stop);
      reply.raw.off('error', fail);
    };
    const fail = () => {
      stop();
      reply.raw.destroy();
    };
    const schedule = (delay: number) => {
      timer = setTimeout(pump, delay);
      timer.unref?.();
    };
    const pump = () => {
      if (closed) return;
      try {
        const events = storage.listRunEvents(id, cursor, 100);
        for (const event of events) {
          const payload = JSON.parse(event.payload_json) as unknown;
          const data =
            payload && typeof payload === 'object' && !Array.isArray(payload)
              ? { ...payload, createdAt: event.created_at }
              : { value: payload, createdAt: event.created_at };
          const writable = reply.raw.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`,
          );
          cursor = event.seq;
          if (!writable) {
            reply.raw.once('drain', pump);
            return;
          }
        }
        if (events.length === 100) {
          schedule(0);
          return;
        }
        const current = storage.getRun(id);
        if (current && !['queued', 'running'].includes(current.status)) {
          stop();
          reply.raw.end();
          return;
        }
        schedule(50);
      } catch {
        fail();
      }
    };
    reply.raw.once('close', stop);
    reply.raw.once('error', fail);
    pump();
  });
  app.post('/api/v1/runs/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = storage.getRun(id);
    if (!run)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '실행 기록을 찾을 수 없습니다.' } });
    if (!['queued', 'running'].includes(run.status))
      return reply.send(
        runPublic(
          run,
          undefined,
          storedTaskVerification(storage, run.id),
          storedTargetChanges(storage, run),
          storedServiceTiers(storage, run),
        ),
      );
    storage.appendRunEvent(id, 'run.cancel_requested', json({ status: run.status }));
    activeRuns.get(id)?.abort();
    return reply.code(202).send({ id, status: 'cancel_requested' });
  });
  app.get('/api/v1/runs', async (req) => ({
    items: storage
      .listRuns((req.query as { agentId?: string }).agentId)
      .map((row) =>
        runPublic(
          row,
          queue.waitReason(row.id),
          storedTaskVerification(storage, row.id),
          storedTargetChanges(storage, row),
          storedServiceTiers(storage, row),
        ),
      ),
    nextCursor: null,
  }));
  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'mcpex', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    for (const row of storage
      .listAgents()
      .filter((item) => item.enabled === 1 && item.applied_version_id)) {
      const version = storage.getAgentVersion(row.applied_version_id as string);
      if (!version) continue;
      const snapshot = appliedConfigSnapshot(storage, JSON.parse(version.config_json));
      const config = snapshot.agent;
      server.registerTool(
        row.tool_name,
        {
          description: publishedToolDescription(config, row.display_name),
          _meta: { 'io.mcpex/bridgeTimeoutMs': runtimeTimePolicy(config).bridgeTimeoutMs },
          inputSchema: fromJsonSchema<Record<string, unknown>>(
            config.inputSchema as JsonSchemaType,
          ),
          annotations: {
            readOnlyHint: !workspaceToolCapability(config).effectiveTools.some((name) =>
              ['write_file', 'replace_text', 'run_command'].includes(name),
            ),
            openWorldHint: false,
          },
        },
        async (input, context) => {
          const callStartedAt = Date.now();
          let runId: string | null = null;
          try {
            const submitted = await submitAgent(
              row,
              version.id,
              'mcp',
              snapshot,
              input,
              context.mcpReq.signal,
              typeof context.mcpReq._meta?.['io.mcpex/workspace'] === 'string'
                ? context.mcpReq._meta['io.mcpex/workspace']
                : undefined,
            );
            runId = submitted.run.id;
            const result = await submitted.promise;
            const envelope = {
              contractVersion: '1',
              runId,
              status: 'completed',
              outcome: 'succeeded',
              output: result.result.output,
              observations: result.result.observations,
              verification: result.result.verification,
              validation: result.result.validation,
              usage: result.result.usage,
              error: null,
              durationMs: result.result.durationMs,
            };
            return {
              structuredContent: envelope,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(envelope),
                },
              ],
            };
          } catch (e) {
            const x = e as
              | ProviderError
              | SchemaContractError
              | QueueError
              | ToolError
              | WorkspacePolicyError
              | TargetBindingError;
            const telemetry = executionTelemetryFrom(e);
            const code =
              x instanceof SchemaContractError ||
              x instanceof QueueError ||
              x instanceof ToolError ||
              x instanceof WorkspacePolicyError ||
              x instanceof TargetBindingError
                ? x.code
                : 'PROVIDER_ERROR';
            const envelope = {
              contractVersion: '1',
              runId,
              status:
                x instanceof QueueError && x.code === 'CANCELLED'
                  ? 'cancelled'
                  : x instanceof QueueError && isTimeoutCode(x.code)
                    ? 'timed_out'
                    : 'failed',
              outcome: 'failed',
              output: null,
              observations: telemetry?.observations ?? {
                toolCalls: 0,
                changes: [],
                checks: [],
                toolFailures: [],
                truncated: false,
              },
              verification: taskVerification(telemetry?.observations),
              validation: { format: 'not_completed', model: 'not_configured' },
              usage: telemetry?.usage ?? null,
              error: {
                code,
                message: x.message,
                ...(x instanceof TargetBindingError && x.targetId ? { targetId: x.targetId } : {}),
              },
              durationMs: telemetry?.durationMs ?? Math.max(0, Date.now() - callStartedAt),
            };
            return {
              isError: true,
              structuredContent: envelope,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(envelope),
                },
              ],
            };
          }
        },
      );
    }
    return server;
  });
  const mcpNode = toNodeHandler(mcpHandler);
  app.all('/mcp', async (req, reply) => {
    reply.hijack();
    await mcpNode(req.raw, reply.raw, req.body);
  });
  const webDist = options.webDist ?? webDistDirectory();
  app.get('/*', async (req, reply) => {
    if (!webDist)
      return reply.code(503).send({
        error: { code: 'UI_NOT_BUILT', message: '웹 UI를 먼저 빌드해야 합니다.' },
      });
    const requestPath = decodeURIComponent(req.url.split('?', 1)[0]);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    let file = resolve(webDist, relativePath);
    if (file !== webDist && !file.startsWith(`${webDist}${sep}`))
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.' } });
    if (!existsSync(file) || !extname(file)) file = resolve(webDist, 'index.html');
    if (!existsSync(file))
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.' } });
    const extension = extname(file).toLowerCase();
    reply.type(contentTypes[extension] ?? 'application/octet-stream');
    if (requestPath.startsWith('/assets/'))
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    else reply.header('cache-control', 'no-store');
    return reply.send(await readFile(file));
  });
  let closed = false;
  return {
    app,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(purgeTimer);
      for (const controller of activeRuns.values()) controller.abort();
      await app.close();
      await Promise.allSettled([...activePromises]);
      if (purgeInFlight) await purgeInFlight.catch(() => undefined);
      await mcpHandler.close();
      storage.close();
      lock.release();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const dataDir = process.env.MCPEX_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? '.mcpex'}/MCPex`;
  const { app, close } = await createServer(dataDir);
  await app.listen({ host: '127.0.0.1', port: Number(process.env.MCPEX_PORT ?? 47831) });
  installGracefulShutdown(close);
}
