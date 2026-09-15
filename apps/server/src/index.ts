import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { BootstrapResponse, SCHEMA_VERSION, newId } from '@mcpex/contracts';
import {
  DataDirectoryLock,
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
import { QueueError, RunQueue, runToolLoop } from '@mcpex/runtime';
import {
  executeWorkspaceTool,
  workspaceToolDefinitions,
  WorkspaceTools,
  type CommandSpec,
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
  runtime?: {
    mode?: 'response' | 'tools';
    tools?: string[];
    maxModelTurns?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    workspacePolicy?: { mode?: 'none' | 'fixed' | 'caller'; allowedRoots?: string[] };
    commands?: CommandSpec[];
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
    workspaceSource: 'none' | 'fixed' | 'caller';
  };
  agent: AgentConfig;
  model: {
    id: string;
    providerId: string;
    modelId: string;
    label: string;
    defaultGeneration: GenerationOptions;
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
  changes: Array<{ tool: 'write_file' | 'replace_text'; path: string }>;
  checks: Array<{ tool: 'run_command'; commandId: string; exitCode: number | null }>;
  truncated: boolean;
};
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

function runPublic(row: RunRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    source: row.source,
    status: row.status,
    input: JSON.parse(row.input_json),
    output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    configSnapshot: row.config_snapshot_json ? JSON.parse(row.config_snapshot_json) : null,
    contentPurgedAt: row.content_purged_at ?? null,
    eventsExpiredAt: row.events_expired_at ?? null,
    createdAt: row.created_at,
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
  mode: 'none' | 'fixed' | 'caller';
  roots: string[];
} {
  const policy = config.runtime?.workspacePolicy;
  const mode = policy?.mode ?? 'none';
  if (!['none', 'fixed', 'caller'].includes(mode))
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
    (mode === 'none' && roots.length) ||
    (mode === 'fixed' && roots.length !== 1) ||
    (mode === 'caller' && roots.length < 1)
  )
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      422,
      'none은 허용 루트가 없어야 하고, fixed는 하나, caller는 하나 이상의 허용 루트가 필요합니다.',
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
function resolveRunWorkspace(config: AgentConfig, callerWorkspace?: string) {
  const { mode, roots } = workspaceRoots(config);
  if (mode === 'none') return { workspace: undefined, source: 'none' as const };
  if (mode === 'fixed') return { workspace: roots[0], source: 'fixed' as const };
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
  if (!roots.some((root) => isWithinWorkspace(root, workspace)))
    throw new WorkspacePolicyError(
      'WORKSPACE_NOT_ALLOWED',
      403,
      '호출 작업 폴더가 사전 허용된 루트 밖에 있습니다.',
    );
  return { workspace, source: 'caller' as const };
}
type GenerationOptions = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
};
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
function modelPublic(row: ModelRow) {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    label: row.label,
    defaultGeneration: JSON.parse(row.defaults_json),
    capabilities: JSON.parse(row.capabilities_json),
    revision: row.revision,
  };
}
function providerPublic(row: ProviderRow) {
  const config = configFrom(row);
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
  runtime: {
    mode: 'response',
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
      workspace: { type: 'string' },
      scope: { type: 'string' },
      requirements: { type: 'string' },
    },
    required: ['task', 'workspace'],
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
        systemPrompt: '먼저 관련 파일을 조사하고 코드 근거와 미확인 사항을 구분해 보고하세요.',
        userPromptTemplate:
          '조사 작업: {{input.task}}\n작업 폴더: {{input.workspace}}\n범위: {{input.scope}}',
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
        systemPrompt: '관련 코드를 먼저 조사하고 요청 범위만 수정한 뒤 가능한 검증을 수행하세요.',
        userPromptTemplate:
          '구현 작업: {{input.task}}\n작업 폴더: {{input.workspace}}\n요구사항: {{input.requirements}}',
        inputSchema: codeInput,
        runtime: {
          ...response.runtime,
          mode: 'tools',
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
    if (section === 'generation')
      next.generationOverrides = structuredClone(template.generationOverrides ?? {});
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
    if (section === 'generation') return config.generationOverrides;
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
  commandSpecs(config.runtime?.commands);
  workspaceRoots(config);
  generationOptions(config.generationOverrides);
  if (config.output?.format === 'json') {
    if (!config.output.schema)
      throw new SchemaContractError('INVALID_SCHEMA', 'JSON 출력에는 output.schema가 필요합니다.');
    validateUserSchema(config.output.schema);
  }
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
  return {
    schemaVersion: 1,
    agent,
    model: {
      id: model.id,
      providerId: model.provider_id,
      modelId: model.model_id,
      label: model.label,
      defaultGeneration: generationOptions(JSON.parse(model.defaults_json)),
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
    rows.models.push({
      id: mapped,
      provider_id: providerId,
      model_id: modelId,
      label,
      defaults_json: json(generationOptions(raw.defaultGeneration, 400)),
      capabilities_json: json(capabilities),
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const toolNames = new Set(
    (storage.db.prepare('SELECT tool_name FROM agents').all() as Array<{ tool_name: string }>).map(
      (row) => row.tool_name.toLocaleLowerCase(),
    ),
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
  let secrets: DpapiSecretStore;
  let app: FastifyInstance;
  let localAccessToken: string | undefined;
  let localAccessTokenRevision: string | undefined;
  try {
    storage = new Storage(dataDir);
    storage.interruptUnfinishedRuns();
    secrets = new DpapiSecretStore(dataDir);
    app = Fastify({ logger: false });
    await app.register(cookie);
    localAccessToken = getLocalAccessToken(dataDir);
    localAccessTokenRevision = secrets.revision(LOCAL_ACCESS_TOKEN_KEY);
  } catch (error) {
    lock.release();
    throw error;
  }
  const retentionDays = settingInteger(storage, 'retentionDays', 30, 1, 365);
  storage.purgeExpiredRunContent(
    new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString(),
  );
  const queue = new RunQueue(
    settingInteger(storage, 'globalConcurrency', 2, 1, 8),
    settingInteger(storage, 'maxPendingRuns', 100, 1, 1000),
  );
  for (const provider of storage.listProviders()) {
    const config = configFrom(provider);
    queue.setProviderLimit(provider.id, boundedInteger(config.maxConcurrency, 2, 1, 8));
  }
  syncResourceGroupLimits(storage, queue);
  const activeRuns = new Map<string, AbortController>();
  const activePromises = new Set<Promise<unknown>>();
  const sessions = new Map<string, number>();
  let bootstrap: { token: string; expires: number } | undefined;
  const hasLocalAccessToken = (request: FastifyRequest) => {
    try {
      const currentRevision = secrets.revision(LOCAL_ACCESS_TOKEN_KEY);
      if (currentRevision !== localAccessTokenRevision) {
        localAccessToken = currentRevision ? secrets.get(LOCAL_ACCESS_TOKEN_KEY) : undefined;
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
      if (!hasLocalAccessToken(request))
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHORIZED', message: '로컬 접속 인증이 필요합니다.' } });
      return;
    }
    if (!path.startsWith('/api/')) return;
    const hasLocalToken = hasLocalAccessToken(request);
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
    const tools: Array<{ name: string; displayName: string; description: string }> = [];
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
        description: config.description || row.display_name,
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
    const purged = storage.purgeExpiredRunContent(
      new Date(Date.now() - (next.retentionDays as number) * 24 * 60 * 60 * 1000).toISOString(),
    );
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
        extraBody: b.extraBody ?? current.extraBody ?? {},
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
    if (row.credential_ref) secrets.delete(row.credential_ref);
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
        row.credential_ref ? secrets.get(row.credential_ref) : undefined,
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
      return reply
        .code(x.status ?? 502)
        .send({ error: { code: 'PROVIDER_ERROR', message: x.message } });
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
    if (typeof b.apiKey !== 'string' || !b.apiKey)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'apiKey가 필요합니다.' } });
    secrets.set(`provider:${id}`, b.apiKey);
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
    if (!row)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '프로바이더를 찾을 수 없습니다.' } });
    if (row.credential_ref) secrets.delete(row.credential_ref);
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
    try {
      defaultGeneration = generationOptions(b.defaultGeneration, 400);
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
    try {
      defaultGeneration =
        b.defaultGeneration === undefined
          ? generationOptions(JSON.parse(row.defaults_json), 400)
          : generationOptions(b.defaultGeneration, 400);
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
      const r = await getAdapter(provider.adapter).generate(
        {
          modelId: model.model_id,
          messages: [
            ...(typeof b.systemPrompt === 'string'
              ? [{ role: 'system' as const, content: b.systemPrompt }]
              : []),
            { role: 'user', content: prompt },
          ],
          signal: operation.signal,
        },
        c.baseUrl,
        c.headers ?? {},
        provider.credential_ref ? secrets.get(provider.credential_ref) : undefined,
        c.extraBody,
      );
      return reply.send({ result: r, credentialExposed: false });
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
      return reply
        .code(x.status ?? 502)
        .send({ error: { code: 'PROVIDER_ERROR', message: x.message } });
    } finally {
      operation.dispose();
    }
  });
  const existingBuiltins = new Set(
    storage
      .listTemplates()
      .filter((template) => template.origin === 'builtin')
      .map((template) => template.name),
  );
  for (const definition of builtinTemplateDefinitions()) {
    if (existingBuiltins.has(definition.name)) continue;
    storage.createTemplate({
      id: newId(),
      origin: 'builtin',
      name: definition.name,
      version: 1,
      config_json: json(definition.config),
      updated_at: now(),
    });
  }
  app.get('/api/v1/agents', async () => ({
    items: storage.listAgents().map(agentPublic),
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
      storage.createAgent(row);
    } catch {
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
      if (!storage.updateAgentDraft(next, row.draft_revision))
        return reply
          .code(409)
          .send({ error: { code: 'CONFLICT', message: '초안 저장 충돌입니다.' } });
    } catch {
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
      validateUserSchema(config.inputSchema, { topLevelObject: true });
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
    try {
      resolvedGeneration = {
        ...generationOptions(model ? JSON.parse(model.defaults_json) : undefined),
        ...generationOptions(c.generationOverrides),
      };
    } catch (error) {
      const providerError = error as ProviderError;
      return reply.code(providerError.status).send({
        error: { code: 'INVALID_CONFIG', message: providerError.message },
      });
    }
    return reply.send({
      messages: [
        ...(c.systemPrompt ? [{ role: 'system', content: c.systemPrompt }] : []),
        { role: 'user', content: interpolate(c.userPromptTemplate ?? '', input) },
      ],
      generationOptions: resolvedGeneration,
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
    try {
      const initialMessages: ChatMessage[] = [
        ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
        { role: 'user' as const, content: interpolate(config.userPromptTemplate ?? '', input) },
      ];
      const workspace = snapshot.execution?.workspace ?? undefined;
      const enabledTools =
        workspace && config.runtime?.mode === 'tools'
          ? workspaceToolDefinitions.filter((tool) => config.runtime?.tools?.includes(tool.name))
          : [];
      const enabledToolNames = new Set(enabledTools.map((tool) => tool.name));
      const workspaceTools = workspace ? new WorkspaceTools(workspace, {}, commands) : undefined;
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
            }),
          );
          return generated;
        } catch (error) {
          storage.appendRunEvent(run.id, 'model.finished', json({ ok: false }));
          if (requestTimeoutSignal.aborted && !parentSignal?.aborted)
            throw new QueueError('DEADLINE', '공급업체 요청 시간이 초과되었습니다.');
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
              json({ callId: call.id, name: call.name }),
            );
            try {
              const toolResult = await executeWorkspaceTool(
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
                (call.name === 'write_file' || call.name === 'replace_text') &&
                typeof resultRecord?.path === 'string'
              )
                observations.changes.push({ tool: call.name, path: resultRecord.path });
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
                  observation: observation ?? null,
                }),
              );
              return json(toolResult);
            } catch (error) {
              storage.appendRunEvent(
                run.id,
                'tool.finished',
                json({ callId: call.id, name: call.name, ok: false }),
              );
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
      storage.finishRun(run.id, 'completed', json(output), null);
      return {
        run,
        result: {
          text,
          output,
          observations,
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
        );
        throw e;
      }
      if (e instanceof QueueError || signal.aborted) throw e;
      const x = e as ProviderError;
      storage.finishRun(
        run.id,
        'failed',
        null,
        json({ code: 'PROVIDER_ERROR', message: x.message }),
      );
      throw x;
    }
  }
  function submitAgent(
    row: AgentRow,
    versionId: string | null,
    source: string,
    snapshot: ResolvedConfigSnapshot,
    input: Record<string, unknown>,
    callerSignal?: AbortSignal,
    callerWorkspace?: string,
  ) {
    if (!queue.canAccept) throw new QueueError('QUEUE_FULL', '실행 대기열이 가득 찼습니다.');
    const config = snapshot.agent;
    validateInput(config.inputSchema, input);
    commandSpecs(config.runtime?.commands);
    generationOptions(config.generationOverrides);
    generationOptions(snapshot.model.defaultGeneration);
    const resolvedWorkspace = resolveRunWorkspace(config, callerWorkspace);
    const runSnapshot: ResolvedConfigSnapshot = {
      ...snapshot,
      execution: {
        workspace: resolvedWorkspace.workspace ?? null,
        workspaceSource: resolvedWorkspace.source,
      },
    };
    const providerConfig = snapshot.provider.config;
    const credentialRef = storage.getProvider(snapshot.provider.id)?.credential_ref;
    const credential = credentialRef ? secrets.get(credentialRef) : undefined;
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
    activeRuns.set(run.id, controller);
    const workspace = resolvedWorkspace.workspace;
    const timeoutMs = Math.min(Math.max(config.runtime?.timeoutMs ?? 120000, 1), 3_600_000);
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
          resourceGroup: providerConfig.resourceGroup,
          deadlineAt: Date.now() + timeoutMs,
        },
      )
      .catch((error: unknown) => {
        if (error instanceof QueueError) {
          const status = error.code === 'CANCELLED' ? 'cancelled' : 'timed_out';
          storage.finishRun(
            run.id,
            status,
            null,
            json({ code: error.code, message: error.message }),
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
      const submitted = submitAgent(
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
        return reply.code(e.code === 'QUEUE_FULL' ? 429 : e.code === 'CANCELLED' ? 409 : 504).send({
          error: { code: e.code, message: e.message },
        });
      if (e instanceof WorkspacePolicyError)
        return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
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
    return reply.send(runPublic(r));
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
      closed = true;
      if (timer) clearTimeout(timer);
    };
    req.raw.once('close', stop);
    const pump = () => {
      if (closed) return;
      const events = storage.listRunEvents(id, cursor);
      for (const event of events) {
        cursor = event.seq;
        const payload = JSON.parse(event.payload_json) as unknown;
        const data =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? { ...payload, createdAt: event.created_at }
            : { value: payload, createdAt: event.created_at };
        reply.raw.write(
          `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      }
      const run = storage.getRun(id);
      if (run && !['queued', 'running'].includes(run.status)) {
        stop();
        reply.raw.end();
        return;
      }
      timer = setTimeout(pump, 50);
      timer.unref?.();
    };
    pump();
  });
  app.post('/api/v1/runs/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = storage.getRun(id);
    if (!run)
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: '실행 기록을 찾을 수 없습니다.' } });
    if (!['queued', 'running'].includes(run.status)) return reply.send(runPublic(run));
    storage.appendRunEvent(id, 'run.cancel_requested', json({ status: run.status }));
    activeRuns.get(id)?.abort();
    return reply.code(202).send({ id, status: 'cancel_requested' });
  });
  app.get('/api/v1/runs', async (req) => ({
    items: storage
      .listRuns((req.query as { agentId?: string }).agentId)
      .map((row) => runPublic(row)),
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
          description: config.description || row.display_name,
          inputSchema: fromJsonSchema<Record<string, unknown>>(
            config.inputSchema as JsonSchemaType,
          ),
          annotations: {
            readOnlyHint:
              config.runtime?.mode !== 'tools' ||
              !config.runtime.tools?.some((name) =>
                ['write_file', 'replace_text', 'run_command'].includes(name),
              ),
            openWorldHint: false,
          },
        },
        async (input, context) => {
          const callStartedAt = Date.now();
          let runId: string | null = null;
          try {
            const submitted = submitAgent(
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
            const x = e as ProviderError | SchemaContractError | QueueError | WorkspacePolicyError;
            const telemetry = executionTelemetryFrom(e);
            const code =
              x instanceof SchemaContractError ||
              x instanceof QueueError ||
              x instanceof WorkspacePolicyError
                ? x.code
                : 'PROVIDER_ERROR';
            const envelope = {
              contractVersion: '1',
              runId,
              status:
                x instanceof QueueError && x.code === 'CANCELLED'
                  ? 'cancelled'
                  : x instanceof QueueError && x.code === 'DEADLINE'
                    ? 'timed_out'
                    : 'failed',
              outcome: 'failed',
              output: null,
              observations: telemetry?.observations ?? {
                toolCalls: 0,
                changes: [],
                checks: [],
                truncated: false,
              },
              validation: { format: 'not_completed', model: 'not_configured' },
              usage: telemetry?.usage ?? null,
              error: { code, message: x.message },
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
      for (const controller of activeRuns.values()) controller.abort();
      await app.close();
      await Promise.allSettled([...activePromises]);
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
