import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { activeRunStatuses, pollRun } from './run-tracker.js';
import { codexRegistrationGuide, type McpRegistration } from './mcp-connection.js';
import {
  summarizeWorkspaceRuntime,
  workspaceToolNames,
  type WorkspaceMode,
} from './workspace-policy.js';
import {
  formValuesToInput,
  parseAdvancedInput,
  parseSchemaText,
  reconcileFormValues,
  schemaExample,
  schemaFields,
  validateInput,
  type FormValue,
  type FormValues,
  type JsonObject,
} from './schema-form.js';
import { modelDisplayName } from './model-display.js';
import './style.css';

type View = 'providers' | 'models' | 'agents' | 'runs' | 'connection' | 'settings';
type Provider = {
  id: string;
  name: string;
  adapter: string;
  profileId?: string;
  location: string;
  baseUrl: string;
  hasCredential: boolean;
  revision: number;
  requestTimeoutMs?: number;
  maxConcurrency?: number;
  resourceGroup?: string;
  resourceGroupConcurrency?: number;
  serviceTierSupport?: 'supported' | 'unverified';
  advancedServiceTier?: string | null;
};
type ProviderProfile = {
  id: string;
  name: string;
  adapter: string;
  location: string;
  baseUrl: string;
};
type Model = {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  defaultGeneration?: Record<string, number>;
  serviceTier?: string | null;
  revision: number;
};
const serviceTierChoices = ['auto', 'default', 'flex', 'priority'] as const;
type CommandSpec = { commandId: string; executable: string; label?: string };
type TargetDraft = { id: string; path: string; access: 'read' | 'write' | 'readwrite' };
const targetInputSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 32,
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      path: { type: 'string' },
      access: { type: 'string', enum: ['read', 'write', 'readwrite'] },
    },
    required: ['id', 'path', 'access'],
    additionalProperties: false,
  },
};
type AgentConfig = {
  modelRef?: string | null;
  description?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
  inputSchema?: Record<string, unknown>;
  output?: { format?: 'markdown' | 'json'; schema?: Record<string, unknown> };
  serviceTier?: string;
  runtime?: {
    mode?: 'response' | 'tools';
    tools?: string[];
    maxModelTurns?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
    queueTimeoutMs?: number;
    executionTimeoutMs?: number;
    workspacePolicy?: { mode?: 'none' | 'fixed' | 'caller'; allowedRoots?: string[] };
    commands?: CommandSpec[];
    targetBinding?: 'off' | 'optional';
  };
};
type Agent = {
  id: string;
  displayName: string;
  toolName: string;
  enabled: boolean;
  draft: AgentConfig;
  draftRevision: number;
  appliedVersionId: string | null;
  appliedScopeMissing?: boolean;
};
type Template = {
  id: string;
  origin: 'builtin' | 'user';
  name: string;
  version: number;
  config: AgentConfig;
};
type Run = {
  id: string;
  agentId: string;
  source: string;
  status: string;
  waitReason?: string | null;
  input: unknown;
  output: unknown;
  error: unknown;
  verification?: {
    status: 'not_verified' | 'passed' | 'failed';
    evidence: {
      checks: Array<{ commandId: string; exitCode: number | null }>;
      toolFailures: Array<{ code: string }>;
    };
  };
  targetChanges?: Array<{ tool: 'write_target' | 'replace_target'; targetId: string }> | null;
  serviceTiers?: Array<{ requested: string | null; actual: string | null; source: string }> | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};
type TrackedRun = {
  runId: string;
  agentId: string;
  status: string;
  run?: Run;
  tracking: boolean;
  trackingError?: string;
};
type Settings = {
  retentionDays: number;
  globalConcurrency: number;
  maxPendingRuns: number;
};
type SafetyBlock = {
  id: string;
  workspace: string;
  createdAt: string;
  reason: string;
  processes: Array<{ pid: number; started: string }>;
};
function safetyReasonLabel(reason: string): string {
  return (
    {
      PROCESS_INSPECTION_FAILED: '프로세스 식별 정보 조회 실패',
      TASKKILL_FAILED: 'Windows 프로세스 트리 종료 명령 실패',
      TREE_STILL_RUNNING: '종료 후 하위 프로세스 잔존',
    }[reason] ?? reason
  );
}
type McpConnection = {
  transport: 'stdio';
  registration: McpRegistration | null;
  service: { status: 'ok' };
  clientConnection: { status: 'unverified' };
  tools: Array<{
    name: string;
    displayName: string;
    description: string;
    runtimeMode: 'response' | 'tools';
    workspaceMode: WorkspaceMode;
    effectiveTools: string[];
    workspaceState:
      'response_only' | 'no_tools' | 'workspace_disabled' | 'fixed' | 'caller_required' | 'full';
  }>;
  inactiveAgents: Array<{
    name: string;
    displayName: string;
    reason: 'inactive' | 'not_applied';
  }>;
};
type ImportPreview = {
  canImport: boolean;
  counts: Record<string, number>;
  conflicts: Array<{ kind: string; field: string; value: string }>;
};
type ApiErrorBody = {
  error?: { code?: string; message?: string; details?: unknown };
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(unsafeMethods.has(method) ? { 'x-mcpex-csrf': '1' } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: ApiErrorBody = {};
  if (response.status !== 204) {
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = {};
    }
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ?? '요청에 실패했습니다.',
      body.error?.details,
    );
  return body as T;
}

function errorGuidance(error: ApiError): string {
  if (error.status === 401) return "세션이 만료되었습니다. 'mcpex open'으로 다시 접속하세요.";
  if (error.status === 403) return '접속 주소와 요청 출처를 확인한 뒤 다시 시도하세요.';
  if (error.status === 409) {
    if (error.code === 'WORKSPACE_BLOCKED' || error.code === 'COMMAND_PROCESS_STILL_RUNNING')
      return '설정 및 데이터의 명령 종료 차단 항목에서 프로세스 상태를 확인하세요. 시간 경과만으로 해제되지 않습니다.';
    if (error.code === 'PROCESS_INSPECTION_INCOMPLETE')
      return 'OS 도구에서 부모와 하위 프로세스 종료를 직접 확인한 뒤에만 수동 해제하세요.';
    if (error.message.includes('동일한 toolName'))
      return '같은 도구 이름을 사용하는 미삭제 에이전트가 있습니다. 다른 toolName을 선택하거나 해당 에이전트를 확인하세요.';
    if (error.message.includes('등록 모델이 있는 프로바이더'))
      return '모델 화면에서 이 프로바이더에 등록된 모델을 먼저 삭제하세요.';
    if (error.message.includes('에이전트가 참조하는 모델'))
      return '에이전트의 초안과 적용 버전이 다른 모델을 사용하도록 정리한 뒤 다시 시도하세요.';
    if (error.message.includes('활성 에이전트'))
      return '에이전트를 비활성화한 뒤 삭제하세요. 기존 실행 기록은 유지됩니다.';
    return '현재 목록을 새로고침하고 충돌한 이름이나 revision을 확인하세요.';
  }
  if (error.status === 422) return '모델·스키마·실행 설정의 필수 항목을 확인하세요.';
  if (error.status === 429) return '대기열에 여유가 생긴 뒤 다시 시도하세요.';
  if (error.status >= 500) return '입력값은 유지됩니다. 서비스 상태를 확인한 뒤 다시 시도하세요.';
  return '입력값을 확인하고 다시 시도하세요.';
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}은 JSON 객체여야 합니다.`);
  }
}
function parseCommands(value: string): CommandSpec[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as CommandSpec[];
  } catch {
    throw new Error('명령 설정은 JSON 배열이어야 합니다.');
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runStatusLabel(status: string): string {
  return (
    {
      queued: '대기 중',
      running: '실행 중',
      cancel_requested: '취소 요청 중',
      completed: '실행 완료',
      failed: '실패',
      cancelled: '취소됨',
      timed_out: '시간 초과',
      interrupted: '서비스 중단으로 종료',
    }[status] ?? status
  );
}

function runDurations(run: Run): string {
  const seconds = (start: string, end: string) =>
    Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  const queue = run.startedAt
    ? seconds(run.createdAt, run.startedAt)
    : run.finishedAt
      ? seconds(run.createdAt, run.finishedAt)
      : '진행 중';
  const execution = run.startedAt
    ? run.finishedAt
      ? seconds(run.startedAt, run.finishedAt)
      : '진행 중'
    : 0;
  const total = run.finishedAt ? seconds(run.createdAt, run.finishedAt) : '진행 중';
  const label = (value: number | string) => (typeof value === 'number' ? `${value}초` : value);
  return `대기 ${label(queue)} · 실행 ${label(execution)} · 전체 ${label(total)}`;
}

function TargetChanges({ run }: { run: Run }) {
  if (run.targetChanges === undefined) return null;
  return (
    <div className="test-run-verification" role="status">
      <strong>대상 파일 변경</strong>
      {run.targetChanges === null ? (
        <p>변경 기록의 보존 기간이 지나 확인할 수 없습니다.</p>
      ) : run.targetChanges.length === 0 ? (
        <p>
          {['queued', 'running'].includes(run.status)
            ? '현재까지 기록된 변경이 없습니다.'
            : '기록된 변경이 없습니다.'}
        </p>
      ) : (
        <ul>
          {run.targetChanges.map((change, index) => (
            <li key={`${change.targetId}-${index}`}>
              <code>{change.targetId}</code> —{' '}
              {change.tool === 'write_target' ? '파일 생성·수정' : '텍스트 교체'} 성공
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function ServiceTierDetails({ run }: { run: Run }) {
  if (run.serviceTiers === null)
    return (
      <p role="status">서비스 티어 기록의 보존 기간이 지나 실제 처리 티어를 확인할 수 없습니다.</p>
    );
  if (!run.serviceTiers?.length) return null;
  return (
    <div className="test-run-verification" role="status">
      <strong>서비스 티어 (모델 요청별)</strong>
      <ul>
        {run.serviceTiers.map((tier, index) => (
          <li key={index}>
            요청 {tier.requested ?? '필드 생략'} · 실제 {tier.actual ?? '확인 불가'}
          </li>
        ))}
      </ul>
    </div>
  );
}

const waitReasonLabels: Record<string, string> = {
  workspace: '작업 폴더 잠금',
  provider: '프로바이더 실행 한도',
  resourceGroup: '리소스 그룹 실행 한도',
  global: '전체 실행 한도',
};

function ModelOptions({ models, providers }: { models: Model[]; providers: Provider[] }) {
  return (
    <>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {modelDisplayName(model, providers)}
        </option>
      ))}
    </>
  );
}

type ProviderFields = {
  name: string;
  profileId: string;
  adapter: string;
  location: string;
  baseUrl: string;
  maxConcurrency: string;
  requestTimeout: string;
  resourceGroup: string;
  resourceGroupConcurrency: string;
};
function providerFields(provider: Provider): ProviderFields {
  return {
    name: provider.name,
    profileId: provider.profileId ?? '',
    adapter: provider.adapter,
    location: provider.location,
    baseUrl: provider.baseUrl,
    maxConcurrency: String(provider.maxConcurrency ?? (provider.location === 'local' ? 1 : 2)),
    requestTimeout: String((provider.requestTimeoutMs ?? 120000) / 1000),
    resourceGroup: provider.resourceGroup ?? '',
    resourceGroupConcurrency: String(provider.resourceGroupConcurrency ?? 1),
  };
}

function ProviderEditor({
  provider,
  profiles,
  onChanged,
  onClose,
  onDirtyChange,
  onBusyChange,
}: {
  provider: Provider;
  profiles: ProviderProfile[];
  onChanged: () => Promise<void>;
  onClose: (saved: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(provider);
  const [fields, setFields] = useState(() => providerFields(provider));
  const [keyAction, setKeyAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [newKey, setNewKey] = useState('');
  const [vertexProject, setVertexProject] = useState('');
  const [vertexLocation, setVertexLocation] = useState('global');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [partial, setPartial] = useState(false);
  const [latest, setLatest] = useState<Provider | null>(null);
  const [testResult, setTestResult] = useState('');
  const changed = JSON.stringify(fields) !== JSON.stringify(providerFields(baseline));
  const dirty = changed || keyAction !== 'keep';
  const switchingToVertex = fields.profileId === 'vertex-ai' && baseline.profileId !== 'vertex-ai';
  const limitError =
    error?.status === 400 && /timeout|동시성|resourceGroup|허용 범위/.test(error.message);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
      onBusyChange(false);
    },
    [onDirtyChange, onBusyChange],
  );
  const update = (part: Partial<ProviderFields>) => {
    setFields((current) => ({ ...current, ...part }));
    setError(null);
    setLatest(null);
    setTestResult('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPartial(false);
    if (keyAction === 'replace' && (!newKey.trim() || /^[*•●xX]{3,}$/.test(newKey.trim()))) {
      setError(
        new ApiError(
          400,
          'BAD_REQUEST',
          '새 API 키를 입력하세요. 마스킹 표시는 키로 저장할 수 없습니다.',
        ),
      );
      return;
    }
    if (switchingToVertex && !vertexProject.trim()) {
      setError(new ApiError(400, 'BAD_REQUEST', 'Vertex AI의 Project ID를 입력하세요.'));
      return;
    }
    setBusy(true);
    let savedSettings = false;
    try {
      let current = baseline;
      if (changed || switchingToVertex) {
        current = await api<Provider>(`/api/v1/providers/${provider.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            expectedRevision: baseline.revision,
            name: fields.name,
            profileId: fields.profileId || null,
            adapter: fields.adapter,
            location: fields.location,
            baseUrl: fields.baseUrl,
            maxConcurrency: Number(fields.maxConcurrency),
            requestTimeoutMs: Number(fields.requestTimeout) * 1000,
            resourceGroup: fields.resourceGroup.trim() || null,
            resourceGroupConcurrency: Number(fields.resourceGroupConcurrency),
            ...(switchingToVertex
              ? { extraBody: { projectId: vertexProject.trim(), location: vertexLocation.trim() } }
              : {}),
          }),
        });
        setBaseline(current);
        setFields(providerFields(current));
        savedSettings = true;
        await onChanged();
      }
      if (keyAction !== 'keep') {
        const credential = await api<{ hasCredential: boolean; revision: number }>(
          `/api/v1/providers/${provider.id}/credential`,
          keyAction === 'replace'
            ? {
                method: 'PUT',
                body: JSON.stringify({ apiKey: newKey, expectedRevision: current.revision }),
              }
            : { method: 'DELETE', body: JSON.stringify({ expectedRevision: current.revision }) },
        );
        current = { ...current, ...credential };
        setBaseline(current);
        setKeyAction('keep');
        setNewKey('');
        await onChanged();
      }
      onClose(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'CLIENT_ERROR', String(cause)));
      setPartial(savedSettings);
    } finally {
      setBusy(false);
    }
  };
  const checkConnection = async () => {
    setBusy(true);
    setTestResult('');
    try {
      const result = await api<{ modelIds: string[] }>(
        `/api/v1/providers/${provider.id}/discover-models`,
        { method: 'POST' },
      );
      setTestResult(`저장된 연결로 모델 ${result.modelIds.length}개를 조회했습니다.`);
    } catch (cause) {
      const issue = cause as ApiError;
      setTestResult(`모델 조회 실패: ${issue.code ?? 'CONNECTION_ERROR'} · ${issue.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-grid provider-editor" onSubmit={(event) => void save(event)}>
      <h3 className="wide">{baseline.name} 편집</h3>
      <p className="wide">
        기존 모델·에이전트 참조는 유지됩니다. 이미 접수된 실행은 접수 시점의 설정을 사용합니다.
      </p>
      <label>
        이름
        <input
          value={fields.name}
          required
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      <label>
        프로필
        <select
          value={fields.profileId}
          onChange={(event) => {
            const selected = profiles.find((item) => item.id === event.target.value);
            update({
              profileId: event.target.value,
              ...(selected
                ? {
                    adapter: selected.adapter,
                    location: selected.location,
                    baseUrl: selected.baseUrl,
                  }
                : {}),
            });
          }}
        >
          <option value="">직접 설정</option>
          {profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.location})
            </option>
          ))}
        </select>
      </label>
      {fields.profileId !== (baseline.profileId ?? '') && (
        <p className="wide" role="note">
          프로필 변경 예정: 어댑터 {fields.adapter}, 구분 {fields.location}, 기본 URL{' '}
          {fields.baseUrl}. 저장 전 값을 확인하세요.
        </p>
      )}
      <label>
        어댑터
        <select
          value={fields.adapter}
          onChange={(event) => update({ adapter: event.target.value })}
        >
          <option value="openai-chat">OpenAI 호환</option>
          <option value="anthropic-messages">Anthropic</option>
          <option value="gemini-generate-content">Gemini</option>
          <option value="vertex-gemini">Vertex AI</option>
          <option value="bedrock-converse">Bedrock</option>
        </select>
      </label>
      <label>
        실행 위치
        <select
          value={fields.location}
          onChange={(event) => update({ location: event.target.value })}
        >
          <option value="local">로컬</option>
          <option value="cloud">클라우드</option>
        </select>
      </label>
      <label className="wide">
        기본 URL
        <input
          value={fields.baseUrl}
          required
          onChange={(event) => update({ baseUrl: event.target.value })}
        />
      </label>
      {switchingToVertex && (
        <>
          <label>
            Vertex Project ID
            <input
              value={vertexProject}
              required
              onChange={(event) => setVertexProject(event.target.value)}
            />
          </label>
          <label>
            Vertex Location
            <input
              value={vertexLocation}
              required
              onChange={(event) => setVertexLocation(event.target.value)}
            />
          </label>
        </>
      )}
      <label>
        최대 동시 실행
        <input
          type="number"
          min="1"
          max="8"
          value={fields.maxConcurrency}
          required
          onChange={(event) => update({ maxConcurrency: event.target.value })}
        />
      </label>
      <label>
        모델 요청당 제한 (초)
        <input
          type="number"
          min="1"
          max="1200"
          step="1"
          value={fields.requestTimeout}
          required
          onChange={(event) => update({ requestTimeout: event.target.value })}
        />
      </label>
      <label>
        리소스 그룹
        <input
          value={fields.resourceGroup}
          maxLength={64}
          onChange={(event) => update({ resourceGroup: event.target.value })}
        />
      </label>
      <label>
        그룹 동시 실행
        <input
          type="number"
          min="1"
          max="8"
          value={fields.resourceGroupConcurrency}
          required
          onChange={(event) => update({ resourceGroupConcurrency: event.target.value })}
        />
      </label>
      {limitError && (
        <p className="wide field-error" role="alert">
          {error?.message} 동시 실행은 1~8, 요청당 제한은 1~1200초, 그룹명은 최대 64자입니다.
        </p>
      )}
      <p className="wide">
        고급 headers·extraBody는 표시하거나 덮어쓰지 않고 보존합니다. 연결 주소나 어댑터를 바꿨다면
        저장 후 모델 조회 또는 모델 탭의 응답 시험으로 호환성을 확인하세요.
      </p>
      <label>
        API 키 ({baseline.hasCredential ? '저장됨' : '없음'})
        <select
          value={keyAction}
          onChange={(event) => {
            setKeyAction(event.target.value as 'keep' | 'replace' | 'remove');
            setError(null);
          }}
        >
          <option value="keep">기존 키 유지</option>
          <option value="replace">새 키로 교체</option>
          <option value="remove">키 제거</option>
        </select>
      </label>
      {keyAction === 'replace' && (
        <label>
          새 API 키
          <input
            type="password"
            value={newKey}
            autoComplete="off"
            required
            onChange={(event) => setNewKey(event.target.value)}
          />
        </label>
      )}
      {error && !limitError && (
        <div className="wide field-error" role="alert">
          <strong>
            {partial ? '설정은 저장됐지만 키 작업 또는 새로고침에 실패했습니다. ' : ''}
            {error.code}
          </strong>{' '}
          {error.message}
          {error.status === 409 && (
            <button
              type="button"
              onClick={() =>
                void api<Provider>(`/api/v1/providers/${provider.id}`)
                  .then(setLatest)
                  .catch((cause: ApiError) => setError(cause))
              }
            >
              최신 설정 확인
            </button>
          )}
          {partial && !dirty && (
            <button
              type="button"
              onClick={() =>
                void onChanged()
                  .then(() => setError(null))
                  .catch((cause: ApiError) => setError(cause))
              }
            >
              목록 다시 조회
            </button>
          )}
        </div>
      )}
      {latest && (
        <div className="wide" role="status">
          현재 저장값: {latest.name}, {latest.baseUrl}, revision {latest.revision}. 입력값은
          유지됩니다.{' '}
          <button
            type="button"
            onClick={() => {
              if (dirty && !window.confirm('현재 편집 내용을 버리고 최신 설정을 불러오시겠습니까?'))
                return;
              setBaseline(latest);
              setFields(providerFields(latest));
              setLatest(null);
              setError(null);
              setKeyAction('keep');
              setNewKey('');
            }}
          >
            최신 값으로 다시 편집
          </button>
        </div>
      )}
      {testResult && (
        <p className="wide" role="status">
          {testResult}
        </p>
      )}
      <div className="wide card-actions">
        <button className="primary" disabled={busy || !dirty}>
          {busy ? '처리 중…' : '변경 저장'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (dirty && !window.confirm('저장하지 않은 편집 내용을 버리시겠습니까?')) return;
            onClose(false);
          }}
        >
          취소
        </button>
        <button type="button" disabled={busy} onClick={() => void checkConnection()}>
          저장된 연결로 모델 조회
        </button>
      </div>
    </form>
  );
}

function App() {
  const [view, setView] = useState<View>('providers');
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [settings, setSettings] = useState<Settings>({
    retentionDays: 30,
    globalConcurrency: 2,
    maxPendingRuns: 100,
  });
  const [safetyBlocks, setSafetyBlocks] = useState<SafetyBlock[]>([]);
  const [mcpConnection, setMcpConnection] = useState<McpConnection | null>(null);
  const [message, setMessage] = useState('');
  const [uiError, setUiError] = useState<ApiError | null>(null);

  const [providerName, setProviderName] = useState('');
  const [profileId, setProfileId] = useState('');
  const [adapter, setAdapter] = useState('openai-chat');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:1234/v1');
  const [credential, setCredential] = useState('');
  const [projectId, setProjectId] = useState('');
  const [cloudLocation, setCloudLocation] = useState('global');
  const [providerConcurrency, setProviderConcurrency] = useState('2');
  const [providerRequestTimeout, setProviderRequestTimeout] = useState('120');
  const [resourceGroup, setResourceGroup] = useState('');
  const [resourceGroupConcurrency, setResourceGroupConcurrency] = useState('1');
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [providerEditDirty, setProviderEditDirty] = useState(false);
  const [providerEditBusy, setProviderEditBusy] = useState(false);

  const [modelProviderId, setModelProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelDefaultsText, setModelDefaultsText] = useState('{}');
  const [modelServiceTier, setModelServiceTier] = useState('provider-default');
  const [probeModelId, setProbeModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [modelResult, setModelResult] = useState('');
  const [probePending, setProbePending] = useState(false);

  const [createName, setCreateName] = useState('');
  const [createToolName, setCreateToolName] = useState('');
  const [createModelRef, setCreateModelRef] = useState('');
  const [createTemplateId, setCreateTemplateId] = useState('');
  const [manageTemplateId, setManageTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [duplicateToolName, setDuplicateToolName] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [inputSchemaText, setInputSchemaText] = useState('{}');
  const [outputSchemaText, setOutputSchemaText] = useState('{}');
  const [testInputMode, setTestInputMode] = useState<'form' | 'json'>('form');
  const [testInputText, setTestInputText] = useState('{}');
  const [testFieldValues, setTestFieldValues] = useState<FormValues>({});
  const [testTargets, setTestTargets] = useState<TargetDraft[]>([]);
  const [testFieldErrors, setTestFieldErrors] = useState<Record<string, string>>({});
  const [testInputError, setTestInputError] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('none');
  const [workspace, setWorkspace] = useState('');
  const [testWorkspace, setTestWorkspace] = useState('');
  const [commandsText, setCommandsText] = useState('[]');
  const [agentResult, setAgentResult] = useState('');
  const [agentDirty, setAgentDirty] = useState(false);
  const [trackedRun, setTrackedRun] = useState<TrackedRun | null>(null);
  const runTrackingGeneration = useRef(0);
  const runTrackingController = useRef<AbortController | null>(null);
  const [importConfig, setImportConfig] = useState<Record<string, unknown> | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [maintenanceResult, setMaintenanceResult] = useState('');

  const selectAgent = (agent: Agent) => {
    runTrackingGeneration.current += 1;
    runTrackingController.current?.abort();
    runTrackingController.current = null;
    setTrackedRun(null);
    const schema = agent.draft.inputSchema ?? {};
    const fieldValues = reconcileFormValues(schema);
    setSelectedAgent(agent);
    setInputSchemaText(JSON.stringify(schema, null, 2));
    setOutputSchemaText(JSON.stringify(agent.draft.output?.schema ?? {}, null, 2));
    setTestInputMode('form');
    setTestFieldValues(fieldValues);
    setTestTargets([]);
    setTestInputText(JSON.stringify(formValuesToInput(schema, fieldValues), null, 2));
    setTestFieldErrors({});
    setTestInputError('');
    setWorkspaceMode(agent.draft.runtime?.workspacePolicy?.mode ?? 'none');
    setWorkspace(agent.draft.runtime?.workspacePolicy?.allowedRoots?.[0] ?? '');
    setTestWorkspace('');
    setCommandsText(JSON.stringify(agent.draft.runtime?.commands ?? [], null, 2));
    setAgentResult('');
    setAgentDirty(false);
  };

  const reload = async () => {
    const [
      providerData,
      modelData,
      profileData,
      agentData,
      templateData,
      runData,
      settingsData,
      connectionData,
      safetyData,
    ] = await Promise.all([
      api<{ items: Provider[] }>('/api/v1/providers'),
      api<{ items: Model[] }>('/api/v1/models'),
      api<{ items: ProviderProfile[] }>('/api/v1/provider-profiles'),
      api<{ items: Agent[] }>('/api/v1/agents'),
      api<{ items: Template[] }>('/api/v1/templates'),
      api<{ items: Run[] }>('/api/v1/runs'),
      api<Settings>('/api/v1/settings'),
      api<McpConnection>('/api/v1/mcp-connection'),
      api<{ items: SafetyBlock[] }>('/api/v1/safety-blocks'),
    ]);
    setProviders(providerData.items);
    setModels(modelData.items);
    setProfiles(profileData.items);
    setAgents(agentData.items);
    setTemplates(templateData.items);
    setRuns(runData.items);
    setSettings(settingsData);
    setMcpConnection(connectionData);
    setSafetyBlocks(safetyData.items);
    setModelProviderId((value) =>
      providerData.items.some((provider) => provider.id === value)
        ? value
        : providerData.items[0]?.id || '',
    );
    setProbeModelId((value) =>
      modelData.items.some((model) => model.id === value) ? value : modelData.items[0]?.id || '',
    );
    setCreateModelRef((value) =>
      modelData.items.some((model) => model.id === value) ? value : modelData.items[0]?.id || '',
    );
    setCreateTemplateId((value) => value || templateData.items[0]?.id || '');
    setManageTemplateId((value) =>
      templateData.items.some((template) => template.id === value)
        ? value
        : templateData.items[0]?.id || '',
    );
  };

  useEffect(() => {
    void (async () => {
      try {
        const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
        if (token) {
          await api('/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) });
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}${window.location.search}`,
          );
        }
        await reload();
        setReady(true);
      } catch (error) {
        setUiError(
          error instanceof ApiError
            ? error
            : new ApiError(
                0,
                'CONNECTION_ERROR',
                `${(error as Error).message} 서비스 실행 후 'mcpex open'으로 다시 접속하세요.`,
              ),
        );
      }
    })();
  }, []);

  const modelsByProvider = useMemo(
    () => models.filter((model) => model.providerId === modelProviderId),
    [models, modelProviderId],
  );
  const scopeCandidates = agents.filter((agent) => {
    const properties = agent.draft.inputSchema?.properties;
    return (
      agent.appliedScopeMissing ||
      (properties !== null &&
        typeof properties === 'object' &&
        'scope' in properties &&
        !/{{\s*input\.scope\s*}}/.test(agent.draft.userPromptTemplate ?? ''))
    );
  });
  const workspaceSummary = summarizeWorkspaceRuntime({
    mode: selectedAgent?.draft.runtime?.mode,
    tools: selectedAgent?.draft.runtime?.tools,
    workspacePolicy: { mode: workspaceMode },
  });
  const runAction = async (action: () => Promise<void>) => {
    setMessage('');
    try {
      await action();
    } catch (error) {
      setUiError(
        error instanceof ApiError
          ? error
          : new ApiError(0, 'CLIENT_ERROR', (error as Error).message),
      );
    }
  };

  const copyConnectionValue = (label: string, value: string) => {
    void runAction(async () => {
      if (!navigator.clipboard?.writeText)
        throw new Error(
          '이 브라우저에서는 클립보드 복사를 사용할 수 없습니다. 값을 직접 선택하세요.',
        );
      await navigator.clipboard.writeText(value);
      setMessage(`${label}을(를) 복사했습니다.`);
    });
  };

  const addProvider = (event: React.FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const provider = await api<{ id: string }>('/api/v1/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: providerName,
          profileId: profileId || undefined,
          adapter,
          baseUrl,
          extraBody: profileId === 'vertex-ai' ? { projectId, location: cloudLocation } : undefined,
          maxConcurrency: Number(providerConcurrency),
          requestTimeoutMs: Number(providerRequestTimeout) * 1000,
          resourceGroup: resourceGroup || undefined,
          resourceGroupConcurrency: Number(resourceGroupConcurrency),
        }),
      });
      if (credential)
        await api(`/api/v1/providers/${provider.id}/credential`, {
          method: 'PUT',
          body: JSON.stringify({ apiKey: credential }),
        });
      setProviderName('');
      setCredential('');
      await reload();
      setMessage('프로바이더를 등록했습니다.');
    });
  };

  const addModel = (event: React.FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      if (!modelProviderId) throw new Error('프로바이더를 선택하세요.');
      await api('/api/v1/models', {
        method: 'POST',
        body: JSON.stringify({
          providerId: modelProviderId,
          modelId,
          label: modelId,
          defaultGeneration: parseObject(modelDefaultsText, '기본 생성 설정'),
          serviceTier: modelServiceTier,
        }),
      });
      setModelId('');
      await reload();
      setMessage('모델을 등록했습니다.');
    });
  };

  const probe = (event: React.FormEvent) => {
    event.preventDefault();
    if (probePending) return;
    void runAction(async () => {
      if (!probeModelId) throw new Error('시험할 모델을 선택하세요.');
      setProbePending(true);
      setModelResult('');
      try {
        const data = await api<{
          result: { text: string };
          requestedServiceTier: string | null;
          actualServiceTier: string | null;
        }>(`/api/v1/models/${probeModelId}/probes`, {
          method: 'POST',
          body: JSON.stringify({ prompt }),
        });
        setModelResult(
          `${data.result.text || '모델이 빈 응답을 반환했습니다. 생성 설정을 확인하세요.'}\n\n서비스 티어 — 요청: ${data.requestedServiceTier ?? '필드 생략'}, 실제: ${data.actualServiceTier ?? '확인 불가'}`,
        );
      } finally {
        setProbePending(false);
      }
    });
  };

  const createAgent = (event: React.FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      if (!createModelRef) throw new Error('모델을 선택하세요.');
      const template = templates.find((item) => item.id === createTemplateId);
      const config = {
        ...(template ? structuredClone(template.config) : {}),
        modelRef: createModelRef,
      };
      const created = await api<Agent>('/api/v1/agents', {
        method: 'POST',
        body: JSON.stringify({ displayName: createName, toolName: createToolName, config }),
      });
      setCreateName('');
      setCreateToolName('');
      await reload();
      selectAgent(created);
      setMessage('에이전트 초안을 생성했습니다.');
    });
  };

  const updateDraft = (changes: Partial<AgentConfig>) => {
    setAgentDirty(true);
    setSelectedAgent((current) =>
      current ? { ...current, draft: { ...current.draft, ...changes } } : null,
    );
  };
  const updateRuntime = (changes: Partial<NonNullable<AgentConfig['runtime']>>) => {
    if (selectedAgent)
      updateDraft({ runtime: { ...(selectedAgent.draft.runtime ?? {}), ...changes } });
  };
  const setTimePolicy = (split: boolean) => {
    if (!selectedAgent) return;
    const {
      queueTimeoutMs: _queue,
      executionTimeoutMs: _execution,
      ...runtime
    } = selectedAgent.draft.runtime ?? {};
    updateDraft({
      runtime: split
        ? {
            ...runtime,
            queueTimeoutMs: 120000,
            executionTimeoutMs: Math.max(1000, runtime.timeoutMs ?? 120000),
          }
        : runtime,
    });
  };

  const testSchema = useMemo(() => {
    try {
      return { schema: parseSchemaText(inputSchemaText), error: '' };
    } catch (error) {
      return { schema: null, error: (error as Error).message };
    }
  }, [inputSchemaText]);
  const testFields = useMemo(
    () => (testSchema.schema ? schemaFields(testSchema.schema) : []),
    [testSchema.schema],
  );
  useEffect(() => {
    if (testInputMode === 'form' && testSchema.schema)
      setTestInputText(
        JSON.stringify(formValuesToInput(testSchema.schema, testFieldValues), null, 2),
      );
  }, [testFieldValues, testInputMode, testSchema.schema]);
  useEffect(() => {
    if (view !== 'agents' && runTrackingController.current) {
      runTrackingGeneration.current += 1;
      runTrackingController.current.abort();
      runTrackingController.current = null;
      setTrackedRun((current) =>
        current && activeRunStatuses.has(current.status)
          ? {
              ...current,
              tracking: false,
              trackingError: '화면을 이동해 자동 조회를 중지했습니다. 다시 조회할 수 있습니다.',
            }
          : current,
      );
    }
  }, [view]);
  useEffect(
    () => () => {
      runTrackingGeneration.current += 1;
      runTrackingController.current?.abort();
    },
    [],
  );

  const changeInputSchema = (value: string) => {
    setInputSchemaText(value);
    setAgentDirty(true);
    try {
      const schema = parseSchemaText(value);
      let previous: JsonObject = {};
      try {
        previous = parseAdvancedInput(testInputText);
      } catch {
        previous = {};
      }
      const values = reconcileFormValues(schema, previous);
      setTestFieldValues(values);
      if (testInputMode === 'form') {
        setTestInputText(JSON.stringify(formValuesToInput(schema, values), null, 2));
      } else {
        setTestInputText(JSON.stringify(schemaExample(schema, previous), null, 2));
      }
      setTestFieldErrors({});
      setTestInputError('');
    } catch {
      // Keep the current test input while the schema JSON is being edited.
    }
  };

  const changeTestField = (name: string, value: FormValue) => {
    if (!testSchema.schema) return;
    setTestFieldValues((current) => {
      return { ...current, [name]: value };
    });
    setTestFieldErrors((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    setTestInputError('');
  };

  const resetTestInput = () => {
    if (!testSchema.schema) return;
    const values = reconcileFormValues(testSchema.schema);
    setTestFieldValues(values);
    const example =
      testInputMode === 'json'
        ? schemaExample(testSchema.schema)
        : formValuesToInput(testSchema.schema, values);
    if (selectedAgent?.draft.runtime?.targetBinding === 'optional') delete example.targets;
    setTestInputText(JSON.stringify(example, null, 2));
    setTestTargets([]);
    setTestFieldErrors({});
    setTestInputError('');
  };

  const changeTestInputMode = (mode: 'form' | 'json') => {
    if (mode === testInputMode || !testSchema.schema) return;
    if (mode === 'json') {
      const example = schemaExample(testSchema.schema);
      if (selectedAgent?.draft.runtime?.targetBinding === 'optional') delete example.targets;
      setTestInputText(
        JSON.stringify(
          {
            ...example,
            ...formValuesToInput(testSchema.schema, testFieldValues),
            ...(selectedAgent?.draft.runtime?.targetBinding === 'optional' && testTargets.length
              ? { targets: testTargets }
              : {}),
          },
          null,
          2,
        ),
      );
    } else {
      try {
        const input = parseAdvancedInput(testInputText);
        setTestFieldValues(reconcileFormValues(testSchema.schema, input));
        if (
          selectedAgent?.draft.runtime?.targetBinding === 'optional' &&
          Array.isArray(input.targets)
        )
          setTestTargets(input.targets as TargetDraft[]);
      } catch (error) {
        setTestInputError((error as Error).message);
        return;
      }
    }
    setTestInputMode(mode);
    setTestFieldErrors({});
    setTestInputError('');
  };

  const resolveTestInput = (): JsonObject => {
    if (!testSchema.schema) {
      setTestInputError(testSchema.error);
      throw new ApiError(0, 'INVALID_TEST_SCHEMA', testSchema.error);
    }
    let input: JsonObject;
    try {
      input =
        testInputMode === 'form'
          ? formValuesToInput(testSchema.schema, testFieldValues)
          : parseAdvancedInput(testInputText);
      if (
        testInputMode === 'form' &&
        selectedAgent?.draft.runtime?.targetBinding === 'optional' &&
        testTargets.length
      )
        input.targets = testTargets;
    } catch (error) {
      const message = (error as Error).message;
      setTestInputError(message);
      throw new ApiError(0, 'INVALID_TEST_INPUT', message);
    }
    const errors = validateInput(testSchema.schema, input);
    if (errors.length) {
      const byField = Object.fromEntries(
        errors
          .filter((error) => /^\/[^/]+$/.test(error.path))
          .map((error) => [error.path.slice(1), error.message]),
      );
      const message = errors.map((error) => `${error.path} ${error.message}`).join('; ');
      setTestFieldErrors(byField);
      setTestInputError(message);
      throw new ApiError(0, 'INVALID_TEST_INPUT', message, { errors });
    }
    setTestFieldErrors({});
    setTestInputError('');
    return input;
  };

  const trackTestRun = (runId: string, agentId: string, existing?: Run) => {
    runTrackingGeneration.current += 1;
    runTrackingController.current?.abort();
    const generation = runTrackingGeneration.current;
    const controller = new AbortController();
    runTrackingController.current = controller;
    setTrackedRun({
      runId,
      agentId,
      status: existing?.status ?? 'queued',
      run: existing,
      tracking: true,
    });
    void pollRun({
      load: () => api<Run>(`/api/v1/runs/${runId}`),
      signal: controller.signal,
      onUpdate: (run) => {
        if (generation !== runTrackingGeneration.current) return;
        setTrackedRun({ runId, agentId, status: run.status, run, tracking: true });
      },
    })
      .then((run) => {
        if (generation !== runTrackingGeneration.current) return;
        runTrackingController.current = null;
        setTrackedRun({ runId, agentId, status: run.status, run, tracking: false });
        void reload().catch((error: unknown) =>
          setUiError(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'RUN_LIST_REFRESH_FAILED', (error as Error).message),
          ),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== runTrackingGeneration.current) return;
        runTrackingController.current = null;
        setTrackedRun((current) =>
          current?.runId === runId
            ? {
                ...current,
                tracking: false,
                trackingError: `실행 상태를 불러오지 못했습니다: ${(error as Error).message}`,
              }
            : current,
        );
      });
  };

  const retryTrackedRun = () => {
    if (trackedRun) trackTestRun(trackedRun.runId, trackedRun.agentId, trackedRun.run);
  };

  const cancelTrackedRun = () =>
    void runAction(async () => {
      if (!trackedRun) return;
      await api(`/api/v1/runs/${trackedRun.runId}/cancel`, { method: 'POST' });
      setTrackedRun((current) =>
        current?.runId === trackedRun.runId
          ? { ...current, status: 'cancel_requested', trackingError: undefined }
          : current,
      );
      if (!trackedRun.tracking) trackTestRun(trackedRun.runId, trackedRun.agentId, trackedRun.run);
      setMessage('실행 취소를 요청했습니다. 종료 상태까지 자동 조회합니다.');
    });

  const saveAgent = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      const inputSchema = parseObject(inputSchemaText, '입력 스키마');
      const output = {
        ...(selectedAgent.draft.output ?? { format: 'markdown' as const }),
        ...(selectedAgent.draft.output?.format === 'json'
          ? { schema: parseObject(outputSchemaText, '출력 스키마') }
          : { schema: undefined }),
      };
      const runtime = {
        ...(selectedAgent.draft.runtime ?? {}),
        commands: parseCommands(commandsText),
        workspacePolicy:
          workspaceMode === 'none' || workspaceMode === 'full'
            ? { mode: workspaceMode, allowedRoots: [] }
            : { mode: workspaceMode, allowedRoots: workspace ? [workspace] : [] },
      };
      const saved = await api<Agent>(`/api/v1/agents/${selectedAgent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: selectedAgent.draftRevision,
          displayName: selectedAgent.displayName,
          toolName: selectedAgent.toolName,
          config: { ...selectedAgent.draft, inputSchema, output, runtime },
        }),
      });
      await reload();
      selectAgent(saved);
      setMessage('초안을 저장했습니다.');
    });

  const previewOrTest = (test: boolean) =>
    void runAction(async () => {
      if (!selectedAgent) return;
      if (test && agentDirty) throw new Error('시험 실행 전에 초안을 저장하세요.');
      const input = resolveTestInput();
      if (test) {
        const data = await api<{ runId: string; status: string }>(
          `/api/v1/agents/${selectedAgent.id}/test-runs`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: selectedAgent.draftRevision,
              input,
              workspace: testWorkspace || undefined,
            }),
          },
        );
        setAgentResult('');
        trackTestRun(data.runId, selectedAgent.id);
        setMessage('시험 실행을 접수했습니다. 완료까지 자동 조회합니다.');
      } else {
        const data = await api(`/api/v1/agents/${selectedAgent.id}/preview`, {
          method: 'POST',
          body: JSON.stringify({ config: selectedAgent.draft, input }),
        });
        setAgentResult(JSON.stringify(data, null, 2));
      }
    });

  const applyAgent = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      if (agentDirty) throw new Error('적용 전에 초안을 저장하세요.');
      await api(`/api/v1/agents/${selectedAgent.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: selectedAgent.draftRevision }),
      });
      await reload();
      selectAgent(await api<Agent>(`/api/v1/agents/${selectedAgent.id}`));
      setMessage('새 적용 버전을 만들었습니다.');
    });

  const toggleAgent = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      await api(`/api/v1/agents/${selectedAgent.id}/activation`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !selectedAgent.enabled }),
      });
      await reload();
      selectAgent(await api<Agent>(`/api/v1/agents/${selectedAgent.id}`));
      setMessage(selectedAgent.enabled ? '비활성화했습니다.' : '활성화했습니다.');
    });

  const saveUserTemplate = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      if (agentDirty) throw new Error('개인 템플릿으로 저장하기 전에 초안을 저장하세요.');
      if (!templateName.trim()) throw new Error('템플릿 이름을 입력하세요.');
      const created = await api<Template>('/api/v1/templates', {
        method: 'POST',
        body: JSON.stringify({ name: templateName, agentId: selectedAgent.id }),
      });
      setTemplateName('');
      await reload();
      setManageTemplateId(created.id);
      setMessage('모델·작업 폴더·명령 허용을 제외한 개인 템플릿을 저장했습니다.');
    });

  const renameUserTemplate = () =>
    void runAction(async () => {
      const template = templates.find((item) => item.id === manageTemplateId);
      if (!template || template.origin !== 'user')
        throw new Error('수정할 개인 템플릿을 선택하세요.');
      if (!templateName.trim()) throw new Error('새 템플릿 이름을 입력하세요.');
      await api(`/api/v1/templates/${template.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: template.version,
          name: templateName,
          config: template.config,
        }),
      });
      setTemplateName('');
      await reload();
      setMessage('개인 템플릿 이름을 변경했습니다.');
    });

  const deleteUserTemplate = () =>
    void runAction(async () => {
      const template = templates.find((item) => item.id === manageTemplateId);
      if (!template || template.origin !== 'user')
        throw new Error('삭제할 개인 템플릿을 선택하세요.');
      await api(`/api/v1/templates/${template.id}`, { method: 'DELETE' });
      await reload();
      setMessage('개인 템플릿을 삭제했습니다.');
    });

  const previewOrApplyTemplate = (apply: boolean, sections?: string[]) =>
    void runAction(async () => {
      if (!selectedAgent || !manageTemplateId) throw new Error('템플릿을 선택하세요.');
      if (apply && agentDirty) throw new Error('템플릿 적용 전에 현재 초안을 저장하세요.');
      const data = await api<Agent | Record<string, unknown>>(
        `/api/v1/agents/${selectedAgent.id}/${apply ? 'template-apply' : 'template-preview'}`,
        {
          method: 'POST',
          body: JSON.stringify({
            templateId: manageTemplateId,
            expectedRevision: selectedAgent.draftRevision,
            ...(sections ? { sections } : {}),
          }),
        },
      );
      if (apply) {
        await reload();
        selectAgent(data as Agent);
        setMessage(
          sections
            ? '템플릿의 메시지만 초안에 적용했습니다.'
            : '템플릿의 전체 설정 묶음을 초안에 적용했습니다.',
        );
      } else {
        setAgentResult(JSON.stringify(data, null, 2));
      }
    });

  const duplicateAgent = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      if (!duplicateToolName) throw new Error('복제할 새 toolName을 입력하세요.');
      const duplicate = await api<Agent>(`/api/v1/agents/${selectedAgent.id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ toolName: duplicateToolName }),
      });
      setDuplicateToolName('');
      await reload();
      selectAgent(duplicate);
      setMessage('비활성 초안으로 에이전트를 복제했습니다.');
    });

  const cancelUnsavedAgentEdits = () => {
    if (!selectedAgent || !agentDirty) return;
    if (
      !window.confirm(
        `"${selectedAgent.displayName}"의 저장하지 않은 화면 편집을 취소하시겠습니까? 서버에 저장된 초안은 변경되지 않습니다.`,
      )
    )
      return;
    void runAction(async () => {
      selectAgent(await api<Agent>(`/api/v1/agents/${selectedAgent.id}`));
      setMessage('저장하지 않은 편집을 취소하고 서버 초안을 다시 불러왔습니다.');
    });
  };

  const discardSavedDraftChanges = () => {
    if (!selectedAgent?.appliedVersionId) return;
    if (
      !window.confirm(
        `"${selectedAgent.displayName}"의 저장된 초안 변경을 현재 적용 버전으로 되돌리시겠습니까? 활성 상태와 공개 MCP 도구, 기존 실행 기록은 변경되지 않습니다.`,
      )
    )
      return;
    void runAction(async () => {
      const restored = await api<Agent>(`/api/v1/agents/${selectedAgent.id}/draft-discard`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: selectedAgent.draftRevision }),
      });
      await reload();
      selectAgent(restored);
      setMessage('저장된 초안 변경을 현재 적용 버전으로 되돌렸습니다.');
    });
  };

  const deleteAgent = () =>
    void runAction(async () => {
      if (!selectedAgent) return;
      if (selectedAgent.enabled) throw new Error('에이전트를 먼저 비활성화하세요.');
      if (
        !window.confirm(
          `"${selectedAgent.displayName}" 에이전트를 삭제하시겠습니까? 목록과 MCP 도구에서 제거됩니다. 기존 실행 기록은 유지되며 toolName "${selectedAgent.toolName}"은 새 에이전트에 다시 사용할 수 있습니다.`,
        )
      )
        return;
      await api(`/api/v1/agents/${selectedAgent.id}`, { method: 'DELETE' });
      runTrackingGeneration.current += 1;
      runTrackingController.current?.abort();
      runTrackingController.current = null;
      setTrackedRun(null);
      setSelectedAgent(null);
      await reload();
      setMessage(
        '에이전트를 삭제했습니다. 기존 실행 기록은 유지되며 toolName은 다시 사용할 수 있습니다.',
      );
    });

  const cancelRun = (runId: string) =>
    void runAction(async () => {
      await api(`/api/v1/runs/${runId}/cancel`, { method: 'POST' });
      await reload();
      setMessage('실행 취소를 요청했습니다.');
    });

  const exportConfig = () =>
    void runAction(async () => {
      const data = await api<Record<string, unknown>>('/api/v1/config/export', { method: 'POST' });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `mcpex-config-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('비밀정보와 로컬 실행 경로를 제외한 설정 파일을 내보냈습니다.');
    });

  const selectImportFile = (file: File | undefined) =>
    void runAction(async () => {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw new Error('설정 파일은 5MiB 이하여야 합니다.');
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('설정 파일은 JSON 객체여야 합니다.');
      setImportConfig(parsed as Record<string, unknown>);
      setImportPreview(null);
      setMaintenanceResult('');
      setMessage('설정 파일을 읽었습니다. 충돌 미리보기를 실행하세요.');
    });

  const previewImport = () =>
    void runAction(async () => {
      if (!importConfig) throw new Error('가져올 설정 파일을 선택하세요.');
      const preview = await api<ImportPreview>('/api/v1/config/import-preview', {
        method: 'POST',
        body: JSON.stringify({ config: importConfig }),
      });
      setImportPreview(preview);
      setMaintenanceResult(JSON.stringify(preview, null, 2));
      setMessage(
        preview.canImport
          ? '충돌이 없습니다. 가져오기를 적용할 수 있습니다.'
          : '충돌을 해결한 새 설정 파일이 필요합니다.',
      );
    });

  const applyImport = () =>
    void runAction(async () => {
      if (!importConfig || !importPreview?.canImport)
        throw new Error('충돌 없는 가져오기 미리보기가 먼저 필요합니다.');
      const result = await api<Record<string, unknown>>('/api/v1/config/import', {
        method: 'POST',
        body: JSON.stringify({ config: importConfig, confirm: true }),
      });
      setMaintenanceResult(JSON.stringify(result, null, 2));
      setImportConfig(null);
      setImportPreview(null);
      await reload();
      setMessage('설정을 새 ID의 비활성 초안으로 가져왔습니다.');
    });

  const saveSettings = (event: React.FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const result = await api<Settings & { purged: { runs: number; events: number } }>(
        '/api/v1/settings',
        { method: 'PATCH', body: JSON.stringify(settings) },
      );
      setSettings(result);
      setMaintenanceResult(JSON.stringify({ purged: result.purged }, null, 2));
      setMessage('보존 기간과 실행 큐 제한을 저장했습니다.');
    });
  };

  const createBackup = () =>
    void runAction(async () => {
      const result = await api<Record<string, unknown>>('/api/v1/backups', { method: 'POST' });
      setMaintenanceResult(JSON.stringify(result, null, 2));
      setMessage('현재 데이터베이스의 온라인 백업을 생성했습니다.');
    });

  const verifySafetyBlock = (block: SafetyBlock) =>
    void runAction(async () => {
      try {
        await api(`/api/v1/safety-blocks/${block.id}/verify`, { method: 'POST' });
      } finally {
        await reload();
      }
    });

  const manuallyReleaseSafetyBlock = (block: SafetyBlock) => {
    const displayWorkspace =
      block.workspace === '\0mcpex-full-access' ? '전체 접근' : block.workspace;
    const entered = window.prompt(
      `OS 프로세스 도구에서 부모와 모든 하위 프로세스의 종료를 직접 확인한 뒤 "${displayWorkspace}"를 정확히 입력하세요. 확인하지 못했다면 취소하세요.`,
    );
    if (entered !== displayWorkspace) return;
    if (
      !window.confirm(
        '전체 프로세스 트리 종료를 직접 확인했습니까? 이 작업은 안전 차단을 해제합니다.',
      )
    )
      return;
    void runAction(async () => {
      await api(`/api/v1/safety-blocks/${block.id}/manual-release`, {
        method: 'POST',
        body: JSON.stringify({
          workspace: block.workspace,
          confirm: 'I_VERIFIED_PROCESS_TREE_EXITED',
        }),
      });
      await reload();
      setMessage('수동 확인을 기록하고 실행 차단을 해제했습니다.');
    });
  };

  const deleteProvider = (provider: Provider) => {
    if (
      !window.confirm(
        `프로바이더 "${provider.name}"을 삭제하시겠습니까? 저장된 인증값도 제거됩니다. 등록 모델이 있으면 삭제가 차단되며 모델을 먼저 정리해야 합니다.`,
      )
    )
      return;
    void runAction(async () => {
      await api(`/api/v1/providers/${provider.id}`, { method: 'DELETE' });
      await reload();
      setMessage(`프로바이더 "${provider.name}"을 삭제했습니다.`);
    });
  };

  const editProvider = (provider: Provider) => {
    if (providerEditBusy) return;
    if (
      editingProvider?.id !== provider.id &&
      providerEditDirty &&
      !window.confirm('저장하지 않은 프로바이더 편집 내용을 버리고 다른 항목을 여시겠습니까?')
    )
      return;
    void runAction(async () => {
      const detail = await api<Provider>(`/api/v1/providers/${provider.id}`);
      setProviderEditDirty(false);
      setEditingProvider(detail);
    });
  };

  const deleteModel = (model: Model) => {
    if (
      !window.confirm(
        `모델 "${modelDisplayName(model, providers)}"을 삭제하시겠습니까? 에이전트 초안이나 적용 버전에서 참조 중이면 삭제가 차단됩니다.`,
      )
    )
      return;
    void runAction(async () => {
      await api(`/api/v1/models/${model.id}`, { method: 'DELETE' });
      await reload();
      setMessage(`모델 "${modelDisplayName(model, providers)}"을 삭제했습니다.`);
    });
  };

  const providersView = (
    <section>
      <h2>프로바이더</h2>
      <form onSubmit={addProvider} className="form-grid">
        <label>
          이름
          <input
            value={providerName}
            onChange={(event) => setProviderName(event.target.value)}
            required
          />
        </label>
        <label>
          프로필
          <select
            value={profileId}
            onChange={(event) => {
              const id = event.target.value;
              setProfileId(id);
              const profile = profiles.find((item) => item.id === id);
              if (profile) {
                setAdapter(profile.adapter);
                setBaseUrl(profile.baseUrl);
              }
            }}
          >
            <option value="">직접 설정</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profile.location})
              </option>
            ))}
          </select>
        </label>
        <label>
          어댑터
          <select value={adapter} onChange={(event) => setAdapter(event.target.value)}>
            <option value="openai-chat">OpenAI 호환</option>
            <option value="anthropic-messages">Anthropic</option>
            <option value="gemini-generate-content">Gemini</option>
            <option value="vertex-gemini">Vertex AI</option>
            <option value="bedrock-converse">Bedrock</option>
          </select>
        </label>
        <label className="wide">
          기본 URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
        </label>
        <label>
          API key / token
          <input
            type="password"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
        {profileId === 'vertex-ai' && (
          <>
            <label>
              Project ID
              <input
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                required
              />
            </label>
            <label>
              Location
              <input
                value={cloudLocation}
                onChange={(event) => setCloudLocation(event.target.value)}
                required
              />
            </label>
          </>
        )}
        <label>
          최대 동시 실행
          <input
            type="number"
            min="1"
            max="8"
            value={providerConcurrency}
            onChange={(event) => setProviderConcurrency(event.target.value)}
          />
        </label>
        <label>
          모델 요청당 제한 (초)
          <input
            type="number"
            min="1"
            max="1200"
            step="1"
            value={providerRequestTimeout}
            onChange={(event) => setProviderRequestTimeout(event.target.value)}
            required
          />
        </label>
        <label>
          리소스 그룹
          <input value={resourceGroup} onChange={(event) => setResourceGroup(event.target.value)} />
        </label>
        <label>
          그룹 동시 실행
          <input
            type="number"
            min="1"
            max="8"
            value={resourceGroupConcurrency}
            onChange={(event) => setResourceGroupConcurrency(event.target.value)}
          />
        </label>
        <button className="primary">프로바이더 등록</button>
      </form>
      <div className="cards">
        {providers.map((provider) => (
          <article
            key={provider.id}
            className={editingProvider?.id === provider.id ? 'provider-card-editing' : undefined}
          >
            <strong>{provider.name}</strong>
            <span>{provider.adapter}</span>
            <code>{provider.baseUrl}</code>
            <small>{provider.hasCredential ? '인증 저장됨' : '인증 없음'}</small>
            <small>
              모델 요청당 제한 {Math.round((provider.requestTimeoutMs ?? 120000) / 1000)}초
            </small>
            <div className="card-actions">
              <button
                type="button"
                onClick={() => editProvider(provider)}
                disabled={providerEditBusy}
                aria-label={`${provider.name} 프로바이더 편집`}
              >
                편집
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => deleteProvider(provider)}
                aria-label={`${provider.name} 프로바이더 삭제`}
              >
                삭제
              </button>
            </div>
            {editingProvider?.id === provider.id && (
              <ProviderEditor
                key={editingProvider.id}
                provider={editingProvider}
                profiles={profiles}
                onChanged={reload}
                onClose={(saved) => {
                  setEditingProvider(null);
                  setProviderEditDirty(false);
                  setProviderEditBusy(false);
                  if (saved)
                    setMessage(
                      '프로바이더 편집을 저장했습니다. 연결 변경은 모델 조회 또는 응답 시험으로 확인하세요.',
                    );
                }}
                onDirtyChange={setProviderEditDirty}
                onBusyChange={setProviderEditBusy}
              />
            )}
          </article>
        ))}
      </div>
    </section>
  );

  const createModelProvider = providers.find((provider) => provider.id === modelProviderId);
  const agentModel = models.find((model) => model.id === selectedAgent?.draft.modelRef);
  const agentProvider = providers.find((provider) => provider.id === agentModel?.providerId);
  const modelsView = (
    <section>
      <h2>모델</h2>
      <div className="split">
        <form onSubmit={addModel}>
          <h3>모델 등록</h3>
          <label>
            프로바이더
            <select
              value={modelProviderId}
              onChange={(event) => {
                setModelProviderId(event.target.value);
                setModelServiceTier('provider-default');
              }}
              required
            >
              <option value="">선택</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            모델 ID
            <input value={modelId} onChange={(event) => setModelId(event.target.value)} required />
          </label>
          <label>
            기본 생성 설정 JSON
            <textarea
              rows={5}
              value={modelDefaultsText}
              onChange={(event) => setModelDefaultsText(event.target.value)}
            />
          </label>
          <label>
            기본 서비스 티어
            <select
              value={modelServiceTier}
              onChange={(event) => setModelServiceTier(event.target.value)}
            >
              <option value="provider-default">공급자 기본값 (필드 생략)</option>
              {serviceTierChoices.map((tier) => (
                <option
                  key={tier}
                  value={tier}
                  disabled={createModelProvider?.serviceTierSupport !== 'supported'}
                >
                  {tier}
                </option>
              ))}
            </select>
          </label>
          <p>
            OpenAI 직접 연결에서만 선택할 수 있습니다. 모델·계정별 사용 가능 여부는 실제 요청 전
            미확인입니다. 요금과 처리 속도는 티어에 따라 달라질 수 있습니다. 미확인 공급자의 기존
            고급 설정은 그대로 유지됩니다.
          </p>
          {createModelProvider?.advancedServiceTier && (
            <p role="note">
              고급 extraBody의 기존 서비스 티어: {createModelProvider.advancedServiceTier}. 전용
              선택을 저장하면 요청 시 이 값을 덮어쓰거나 제거합니다.
            </p>
          )}
          <button className="primary">등록</button>
          <ul className="model-list">
            {modelsByProvider.map((model) => (
              <li key={model.id}>
                <span>
                  {modelDisplayName(model, providers)}{' '}
                  {model.label?.trim() !== model.modelId && <code>{model.modelId}</code>}
                </span>
                <label>
                  기본 서비스 티어
                  <select
                    value={model.serviceTier ?? ''}
                    onChange={(event) =>
                      void runAction(async () => {
                        await api(`/api/v1/models/${model.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({
                            expectedRevision: model.revision,
                            serviceTier: event.target.value,
                          }),
                        });
                        await reload();
                        setMessage(
                          '모델 기본 서비스 티어를 저장했습니다. 이미 접수된 실행에는 적용되지 않습니다.',
                        );
                      })
                    }
                  >
                    <option value="" disabled>
                      기존 설정 (고급 값 유지)
                    </option>
                    <option value="provider-default">공급자 기본값 (필드 생략)</option>
                    {serviceTierChoices.map((tier) => (
                      <option
                        key={tier}
                        value={tier}
                        disabled={
                          providers.find((provider) => provider.id === model.providerId)
                            ?.serviceTierSupport !== 'supported'
                        }
                      >
                        {tier}
                      </option>
                    ))}
                  </select>
                </label>
                {model.serviceTier &&
                  model.serviceTier !== 'provider-default' &&
                  providers.find((provider) => provider.id === model.providerId)
                    ?.serviceTierSupport !== 'supported' && (
                    <small role="alert">
                      현재 연결에서는 이 티어가 확인되지 않았습니다. 공급자 기본값으로 바꾸거나
                      연결을 확인하세요.
                    </small>
                  )}
                <button
                  type="button"
                  className="danger"
                  onClick={() => deleteModel(model)}
                  aria-label={`${modelDisplayName(model, providers)} 모델 삭제`}
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        </form>
        <form onSubmit={probe}>
          <h3>응답 시험</h3>
          <label>
            모델
            <select
              value={probeModelId}
              disabled={probePending}
              onChange={(event) => setProbeModelId(event.target.value)}
              required
            >
              <option value="">선택</option>
              <ModelOptions models={models} providers={providers} />
            </select>
          </label>
          <label>
            프롬프트
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button className="primary" disabled={probePending}>
            {probePending ? '응답 대기 중…' : '시험'}
          </button>
          {probePending && (
            <p role="status">
              모델 응답을 기다리고 있습니다. 공급업체에 따라 시간이 걸릴 수 있습니다.
            </p>
          )}
          {modelResult && <pre>{modelResult}</pre>}
        </form>
      </div>
    </section>
  );

  const agentsView = (
    <section>
      <h2>에이전트</h2>
      <form onSubmit={createAgent} className="create-row">
        <input
          aria-label="에이전트 이름"
          placeholder="표시 이름"
          value={createName}
          onChange={(event) => setCreateName(event.target.value)}
          required
        />
        <input
          aria-label="MCP 도구 이름"
          placeholder="tool_name"
          value={createToolName}
          onChange={(event) => setCreateToolName(event.target.value)}
          pattern="[a-z][a-z0-9_]{0,47}"
          required
        />
        <select
          aria-label="템플릿"
          value={createTemplateId}
          onChange={(event) => setCreateTemplateId(event.target.value)}
        >
          <option value="">빈 설정</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <select
          aria-label="모델"
          value={createModelRef}
          onChange={(event) => setCreateModelRef(event.target.value)}
          required
        >
          <option value="">모델 선택</option>
          <ModelOptions models={models} providers={providers} />
        </select>
        <button className="primary">생성</button>
      </form>
      <div className="agent-layout">
        <aside>
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={selectedAgent?.id === agent.id ? 'selected' : ''}
              onClick={() => selectAgent(agent)}
            >
              <strong>{agent.displayName}</strong>
              <small>{agent.enabled ? '활성' : agent.appliedVersionId ? '적용됨' : '초안'}</small>
            </button>
          ))}
        </aside>
        {selectedAgent ? (
          <div className="editor">
            <div className="status-row">
              <span>revision {selectedAgent.draftRevision}</span>
              <span>{selectedAgent.appliedVersionId ? '적용 버전 있음' : '미적용'}</span>
            </div>
            <div className="form-grid">
              <label>
                표시 이름
                <input
                  value={selectedAgent.displayName}
                  onChange={(event) => {
                    setAgentDirty(true);
                    setSelectedAgent({ ...selectedAgent, displayName: event.target.value });
                  }}
                />
              </label>
              <label>
                도구 이름
                <input
                  value={selectedAgent.toolName}
                  onChange={(event) => {
                    setAgentDirty(true);
                    setSelectedAgent({ ...selectedAgent, toolName: event.target.value });
                  }}
                />
              </label>
              <label>
                모델
                <select
                  value={selectedAgent.draft.modelRef ?? ''}
                  onChange={(event) => {
                    const nextModel = models.find((model) => model.id === event.target.value);
                    const nextProvider = providers.find(
                      (provider) => provider.id === nextModel?.providerId,
                    );
                    updateDraft({
                      modelRef: event.target.value,
                      serviceTier:
                        nextProvider?.serviceTierSupport === 'supported'
                          ? selectedAgent.draft.serviceTier
                          : 'inherit',
                    });
                  }}
                >
                  <ModelOptions models={models} providers={providers} />
                </select>
              </label>
              <label>
                출력
                <select
                  value={selectedAgent.draft.output?.format ?? 'markdown'}
                  onChange={(event) =>
                    updateDraft({
                      output: {
                        ...(selectedAgent.draft.output ?? {}),
                        format: event.target.value as 'markdown' | 'json',
                      },
                    })
                  }
                >
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label>
                에이전트 서비스 티어
                <select
                  value={selectedAgent.draft.serviceTier ?? 'inherit'}
                  onChange={(event) => updateDraft({ serviceTier: event.target.value })}
                >
                  <option value="inherit">
                    모델 기본값 상속 ({agentModel?.serviceTier ?? '기존 고급 설정'})
                  </option>
                  <option value="provider-default">공급자 기본값 (필드 생략)</option>
                  {serviceTierChoices.map((tier) => (
                    <option
                      key={tier}
                      value={tier}
                      disabled={agentProvider?.serviceTierSupport !== 'supported'}
                    >
                      {tier}
                    </option>
                  ))}
                </select>
              </label>
              <p className="wide">
                {agentProvider?.serviceTierSupport === 'supported'
                  ? 'OpenAI API 요청 필드입니다. 모델·계정 사용 가능 여부는 미확인입니다.'
                  : '이 공급자의 서비스 티어 계약은 미확인입니다. 명시적 선택은 사용할 수 없으며 기존 고급 설정은 유지됩니다.'}{' '}
                적용 버전은 저장 시점 설정을 사용합니다.
              </p>
              {agentProvider?.advancedServiceTier && (
                <p className="wide" role="note">
                  고급 extraBody 값: {agentProvider.advancedServiceTier}. 전용 설정은 요청에서
                  우선합니다.
                </p>
              )}
              <label className="wide">
                설명
                <input
                  value={selectedAgent.draft.description ?? ''}
                  onChange={(event) => updateDraft({ description: event.target.value })}
                />
              </label>
              <label className="wide">
                시스템 프롬프트
                <textarea
                  rows={5}
                  value={selectedAgent.draft.systemPrompt ?? ''}
                  onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                />
              </label>
              <label className="wide">
                사용자 메시지 템플릿
                <textarea
                  rows={4}
                  value={selectedAgent.draft.userPromptTemplate ?? ''}
                  onChange={(event) => updateDraft({ userPromptTemplate: event.target.value })}
                />
              </label>
              <label className="wide">
                입력 JSON Schema
                <textarea
                  rows={8}
                  value={inputSchemaText}
                  onChange={(event) => changeInputSchema(event.target.value)}
                />
              </label>
              {selectedAgent.draft.output?.format === 'json' && (
                <label className="wide">
                  출력 JSON Schema
                  <textarea
                    rows={8}
                    value={outputSchemaText}
                    onChange={(event) => {
                      setOutputSchemaText(event.target.value);
                      setAgentDirty(true);
                    }}
                  />
                </label>
              )}
              <label>
                실행 모드
                <select
                  value={selectedAgent.draft.runtime?.mode ?? 'response'}
                  onChange={(event) =>
                    updateRuntime({ mode: event.target.value as 'response' | 'tools' })
                  }
                >
                  <option value="response">응답만</option>
                  <option value="tools">Workspace 도구</option>
                </select>
              </label>
              <label>
                실행별 대상 파일
                <select
                  value={selectedAgent.draft.runtime?.targetBinding ?? 'off'}
                  onChange={(event) => {
                    const mode = event.target.value as 'off' | 'optional';
                    if (mode === 'optional') {
                      let schema: JsonObject;
                      try {
                        schema = parseSchemaText(inputSchemaText);
                      } catch (error) {
                        setMessage((error as Error).message);
                        return;
                      }
                      const properties = schema.properties as JsonObject | undefined;
                      if (
                        properties?.targets &&
                        JSON.stringify(properties.targets) !== JSON.stringify(targetInputSchema)
                      ) {
                        setMessage(
                          '기존 targets 입력 스키마가 공통 대상 계약과 충돌합니다. 먼저 스키마를 확인하세요.',
                        );
                        return;
                      }
                      const nextSchema = {
                        ...schema,
                        properties: { ...properties, targets: targetInputSchema },
                      };
                      setInputSchemaText(JSON.stringify(nextSchema, null, 2));
                      updateDraft({
                        inputSchema: nextSchema,
                        runtime: { ...selectedAgent.draft.runtime, targetBinding: mode },
                      });
                    } else updateRuntime({ targetBinding: mode });
                  }}
                >
                  <option value="off">사용 안 함 (기존 동작)</option>
                  <option value="optional">선택적 targets 지정</option>
                </select>
              </label>
              {selectedAgent.draft.runtime?.targetBinding === 'optional' && (
                <p className="wide" role="note">
                  targets를 지정한 실행은 대상 ID로만 파일을 읽고 씁니다. 직접 경로
                  도구·run_command는 사용할 수 없습니다. 경로는 MCP 클라이언트와 MCPex에 전달되지만
                  MCPex가 서브 모델 메시지에 자동 포함하지 않습니다. 대상 없이 실행하면 기존 탐색
                  방식입니다.
                </p>
              )}
              <label>
                시간 제한 방식
                <select
                  value={
                    selectedAgent.draft.runtime?.queueTimeoutMs !== undefined ||
                    selectedAgent.draft.runtime?.executionTimeoutMs !== undefined
                      ? 'split'
                      : 'total'
                  }
                  onChange={(event) => setTimePolicy(event.target.value === 'split')}
                >
                  <option value="total">전체 제한 (기존 설정)</option>
                  <option value="split">대기·실행 분리</option>
                </select>
              </label>
              {selectedAgent.draft.runtime?.queueTimeoutMs !== undefined ||
              selectedAgent.draft.runtime?.executionTimeoutMs !== undefined ? (
                <>
                  <label>
                    대기 제한 (초)
                    <input
                      type="number"
                      min="1"
                      max="3600"
                      step="1"
                      value={(selectedAgent.draft.runtime?.queueTimeoutMs ?? 120000) / 1000}
                      onChange={(event) =>
                        updateRuntime({ queueTimeoutMs: Number(event.target.value) * 1000 })
                      }
                      required
                    />
                  </label>
                  <label>
                    실행 제한 (초)
                    <input
                      type="number"
                      min="1"
                      max="3600"
                      step="1"
                      value={(selectedAgent.draft.runtime?.executionTimeoutMs ?? 120000) / 1000}
                      onChange={(event) =>
                        updateRuntime({ executionTimeoutMs: Number(event.target.value) * 1000 })
                      }
                      required
                    />
                  </label>
                </>
              ) : (
                <label>
                  전체 제한 (초)
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    step="1"
                    value={(selectedAgent.draft.runtime?.timeoutMs ?? 120000) / 1000}
                    onChange={(event) =>
                      updateRuntime({ timeoutMs: Number(event.target.value) * 1000 })
                    }
                    required
                  />
                </label>
              )}
              <p className="wide">
                대기는 동시 실행 한도·리소스 그룹·작업 폴더 잠금이 풀릴 때까지의 시간입니다. 모델
                요청당 제한은 프로바이더 설정에서 별도로 적용됩니다.
              </p>
              <label>
                작업 폴더 정책
                <select
                  value={workspaceMode}
                  onChange={(event) => {
                    setWorkspaceMode(event.target.value as WorkspaceMode);
                    setAgentDirty(true);
                  }}
                >
                  <option value="none">사용 안 함</option>
                  <option value="fixed">지정 폴더와 하위 전체</option>
                  <option value="caller">허용 범위 안에서 호출마다 선택</option>
                  <option value="full">전체 접근 (고위험)</option>
                </select>
              </label>
              {workspaceMode !== 'none' && workspaceMode !== 'full' && (
                <label>
                  {workspaceMode === 'caller'
                    ? '선택 가능한 범위 (이 폴더와 하위 전체)'
                    : '항상 사용할 폴더 (하위 전체 포함)'}
                  <input
                    placeholder="C:\\workspace"
                    value={workspace}
                    onChange={(event) => {
                      setWorkspace(event.target.value);
                      setAgentDirty(true);
                    }}
                  />
                </label>
              )}
              {workspaceMode === 'caller' && (
                <label>
                  시험 실행에서 사용할 폴더
                  <input
                    placeholder="C:\\workspace\\project"
                    value={testWorkspace}
                    onChange={(event) => setTestWorkspace(event.target.value)}
                  />
                </label>
              )}
            </div>
            {workspaceMode === 'fixed' && (
              <div className="caller-workspace-guide" role="note">
                <strong>지정한 폴더와 모든 하위 폴더를 작업 범위로 사용합니다</strong>
                <p>
                  현재 초안의 실제 실행 기준 폴더: <code>{workspace || '설정되지 않음'}</code>
                </p>
                <p>
                  예: <code>C:\Work</code>를 지정하면 ProjectA, ProjectB 등 그 안의 모든 하위 폴더가
                  포함됩니다. 호출할 때 작업 폴더를 따로 전달할 필요가 없습니다.
                </p>
                <p>
                  실제 읽기·쓰기는 선택한 허용 도구와 OS 사용자 권한에 따르며, junction·심볼릭 링크
                  경로는 차단됩니다.
                </p>
                <p>
                  파일 경로와 명령 작업 폴더는 이 범위 기준 상대 경로나 범위 내부 절대 경로를 모두
                  사용할 수 있습니다. 설정된 실제 폴더 경로는 MCP 설명에 공개하지 않습니다.
                </p>
                <p>
                  <code>input.workspace</code>는 기준 폴더를 바꾸지 않습니다. 예를 들어 기준이
                  <code> C:\Work</code>이고 대상이 ProjectA라면 <code>ProjectA/src/main.ts</code>로
                  지정하세요. 경로가 없으면 <code>list_files(&quot;.&quot;)</code>로 먼저
                  확인하세요.
                </p>
              </div>
            )}
            <div
              className={`effective-runtime ${
                ['workspace_disabled', 'no_tools'].includes(workspaceSummary.state)
                  ? 'effective-runtime-warning'
                  : ''
              }`}
              role="note"
            >
              <strong>현재 초안의 실효 도구</strong>
              {workspaceSummary.effectiveTools.length ? (
                <p>{workspaceSummary.effectiveTools.join(', ')}</p>
              ) : (
                <p>없음</p>
              )}
              {workspaceSummary.state === 'workspace_disabled' && (
                <p>
                  Workspace 도구가 선택되어 있지만 작업 폴더 정책이 ‘사용 안 함’이라 모델에는 어떤
                  파일·명령 도구도 제공되지 않습니다. 작업에 맞는 폴더 정책을 선택하세요.
                </p>
              )}
              {workspaceSummary.state === 'no_tools' && (
                <p>Workspace 도구 모드이지만 허용 도구가 선택되지 않았습니다.</p>
              )}
              {workspaceSummary.state === 'response_only' && (
                <p>응답만 모드에서는 선택된 Workspace 도구가 모델에 제공되지 않습니다.</p>
              )}
              {workspaceSummary.state === 'fixed' && (
                <p>
                  지정한 폴더와 모든 하위 폴더에서 위 도구를 사용할 수 있습니다. 상대 경로와 범위
                  내부 절대 경로를 같은 대상으로 처리합니다.
                </p>
              )}
              {workspaceSummary.state === 'caller_required' && (
                <p>
                  호출마다 작업 폴더를 전달해야 합니다. 이번에 선택한 폴더와 그 하위에서만 위 도구를
                  사용할 수 있으며 상대 경로와 범위 내부 절대 경로를 같은 대상으로 처리합니다.
                </p>
              )}
              {workspaceSummary.state === 'full' && (
                <p>
                  선택 도구가 MCPex 프로세스의 현재 OS 사용자 권한 범위에서 동작합니다. 관리자
                  권한을 얻지 않으며 모든 파일 경로와 명령 cwd에 절대 경로가 필요합니다.
                </p>
              )}
              {workspaceSummary.effectiveTools.some((tool) => tool !== 'run_command') && (
                <p>
                  <strong>파일 전송 범위:</strong> 파일 도구의 결과는 선택한 모델 제공자에게
                  전달됩니다. 클라우드 모델이면 파일 내용과 경로가 PC 밖으로 전송될 수 있습니다.
                </p>
              )}
              {workspaceSummary.effectiveTools.includes('run_command') && (
                <p>
                  <strong>명령 실행 권한:</strong> 허용 명령은 MCPex를 실행 중인 현재 OS 사용자
                  권한으로 실행되며 OS sandbox가 아닙니다.
                </p>
              )}
            </div>
            {workspaceMode === 'caller' && (
              <div className="caller-workspace-guide" role="note">
                <strong>허용 범위와 이번 호출의 작업 폴더는 다릅니다</strong>
                <p>
                  예: 선택 가능한 범위를 <code>C:\Work</code>로 설정하고 이번 호출에서
                  <code> C:\Work\ProjectA</code>를 선택하면 ProjectA와 그 하위만 접근합니다. 형제
                  폴더인 ProjectB에는 접근할 수 없습니다. 호출 폴더로 C:\Work 자체를 선택하면 그
                  하위 전체가 포함됩니다.
                </p>
                <ul>
                  <li>
                    ‘시험 실행에서 사용할 폴더’는 이 화면에서 시험할 때만 사용하는 실제 작업
                    폴더입니다. 임시 폴더를 만드는 기능이 아니며, 쓰기 도구를 허용하면 실제 파일이
                    수정될 수 있습니다. 이 값은 이후 MCP 호출의 기본 폴더로 저장되지 않습니다.
                  </li>
                  <li>
                    MCP 호출은 클라이언트가 <code>_meta["io.mcpex/workspace"]</code> 문자열을 보내야
                    합니다. <code>input.workspace</code>와는 다른 값입니다.
                  </li>
                  <li>
                    일반 Codex 등록만으로 현재 프로젝트 폴더가 이 메타데이터에 자동 전달되지는
                    않습니다. 폴더는 자동 감지되지 않습니다. 메타데이터를 보낼 수 없는
                    클라이언트에서는 ‘지정 폴더와 하위 전체’를 사용하세요.
                  </li>
                  <li>
                    실제 읽기·쓰기는 선택한 허용 도구와 OS 사용자 권한에 따르며, junction·심볼릭
                    링크 경로는 차단됩니다.
                  </li>
                </ul>
              </div>
            )}
            <fieldset>
              <legend>허용 도구</legend>
              {workspaceToolNames.map((tool) => (
                <label className="check" key={tool}>
                  <input
                    type="checkbox"
                    checked={selectedAgent.draft.runtime?.tools?.includes(tool) ?? false}
                    onChange={(event) => {
                      const current = selectedAgent.draft.runtime?.tools ?? [];
                      updateRuntime({
                        tools: event.target.checked
                          ? [...current, tool]
                          : current.filter((item) => item !== tool),
                      });
                    }}
                  />
                  {tool}
                </label>
              ))}
            </fieldset>
            <label>
              허용 명령 JSON
              <textarea
                rows={6}
                value={commandsText}
                onChange={(event) => {
                  setCommandsText(event.target.value);
                  setAgentDirty(true);
                }}
                placeholder='[{"commandId":"node","executable":"C:\\Program Files\\nodejs\\node.exe"}]'
              />
            </label>
            <fieldset className="management-grid">
              <legend>템플릿과 에이전트 관리</legend>
              {scopeCandidates.length > 0 && (
                <div className="wide" role="note">
                  <strong>scope 입력이 모델 메시지에 전달되지 않는 설정 후보</strong>
                  <p>
                    {scopeCandidates
                      .map(
                        (agent) =>
                          `${agent.displayName}${agent.appliedScopeMissing ? ' (적용 버전 포함)' : ' (초안)'}`,
                      )
                      .join(', ')}
                  </p>
                  <p>
                    각 에이전트를 선택해 템플릿 차이를 확인한 뒤 필요한 묶음만 초안에 적용하세요.
                    적용 버전은 초안을 다시 적용하기 전까지 유지됩니다.
                  </p>
                </div>
              )}
              <label>
                적용할 템플릿
                <select
                  value={manageTemplateId}
                  onChange={(event) => setManageTemplateId(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} ({template.origin === 'builtin' ? '기본' : '개인'})
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions compact">
                <button onClick={() => previewOrApplyTemplate(false)}>템플릿 차이 보기</button>
                <button
                  onClick={() => previewOrApplyTemplate(true, ['prompts'])}
                  disabled={agentDirty}
                >
                  메시지만 적용
                </button>
                <button onClick={() => previewOrApplyTemplate(true)} disabled={agentDirty}>
                  전체 묶음 적용
                </button>
                <button onClick={deleteUserTemplate}>개인 템플릿 삭제</button>
              </div>
              <label>
                개인 템플릿 이름
                <input
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="내 템플릿"
                />
              </label>
              <div className="actions compact">
                <button onClick={saveUserTemplate} disabled={agentDirty}>
                  현재 초안으로 저장
                </button>
                <button onClick={renameUserTemplate}>선택 템플릿 이름 변경</button>
              </div>
              <label>
                복제할 새 toolName
                <input
                  value={duplicateToolName}
                  onChange={(event) => setDuplicateToolName(event.target.value)}
                  placeholder="copied_agent"
                  pattern="[a-z][a-z0-9_]{0,47}"
                />
              </label>
              <div className="actions compact">
                <button onClick={duplicateAgent}>에이전트 복제</button>
              </div>
            </fieldset>
            <fieldset className="danger-zone">
              <legend>초안 및 에이전트 정리</legend>
              <p>
                화면 편집 취소는 저장 전 값만 버립니다. 적용 버전으로 초안 복원은 공개 도구와 활성
                상태를 유지합니다. 에이전트 삭제는 비활성 상태에서만 가능합니다.
              </p>
              <div className="actions compact">
                <button onClick={cancelUnsavedAgentEdits} disabled={!agentDirty}>
                  저장 전 편집 취소
                </button>
                <button
                  onClick={discardSavedDraftChanges}
                  disabled={!selectedAgent.appliedVersionId}
                >
                  적용 버전으로 초안 복원
                </button>
                <button className="danger" onClick={deleteAgent} disabled={selectedAgent.enabled}>
                  에이전트 삭제
                </button>
              </div>
              {selectedAgent.enabled && (
                <p className="danger-guidance">삭제하려면 위의 ‘비활성화’를 먼저 실행하세요.</p>
              )}
              {!selectedAgent.appliedVersionId && (
                <p className="hint">
                  적용 전 초안 에이전트는 ‘에이전트 삭제’로 전체 정리할 수 있습니다.
                </p>
              )}
            </fieldset>
            <div className="actions">
              <button onClick={saveAgent} className="primary">
                초안 저장
              </button>
              <button onClick={() => previewOrTest(false)}>메시지 미리보기</button>
              <button onClick={() => previewOrTest(true)} disabled={agentDirty}>
                시험 실행
              </button>
              <button onClick={applyAgent} disabled={agentDirty}>
                적용 버전 생성
              </button>
              <button onClick={toggleAgent} disabled={!selectedAgent.appliedVersionId}>
                {selectedAgent.enabled ? '비활성화' : '활성화'}
              </button>
            </div>
            <fieldset className="test-input-panel">
              <legend>시험 입력</legend>
              <div className="test-input-heading">
                <div className="mode-switch" aria-label="시험 입력 방식">
                  <button
                    type="button"
                    className={testInputMode === 'form' ? 'active' : ''}
                    aria-pressed={testInputMode === 'form'}
                    onClick={() => changeTestInputMode('form')}
                  >
                    입력 폼
                  </button>
                  <button
                    type="button"
                    className={testInputMode === 'json' ? 'active' : ''}
                    aria-pressed={testInputMode === 'json'}
                    onClick={() => changeTestInputMode('json')}
                  >
                    고급 JSON
                  </button>
                </div>
                <button type="button" onClick={resetTestInput} disabled={!testSchema.schema}>
                  스키마 예제로 초기화
                </button>
              </div>
              {testSchema.error && <p className="field-error">{testSchema.error}</p>}
              {testInputMode === 'form' &&
                selectedAgent.draft.runtime?.targetBinding === 'optional' && (
                  <div className="wide">
                    <strong>대상 파일 (선택)</strong>
                    {testTargets.map((target, index) => (
                      <div className="test-field-grid" key={index}>
                        <label>
                          ID
                          <input
                            value={target.id}
                            onChange={(event) =>
                              setTestTargets((items) =>
                                items.map((item, position) =>
                                  position === index ? { ...item, id: event.target.value } : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          경로
                          <input
                            value={target.path}
                            onChange={(event) =>
                              setTestTargets((items) =>
                                items.map((item, position) =>
                                  position === index ? { ...item, path: event.target.value } : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          접근
                          <select
                            value={target.access}
                            onChange={(event) =>
                              setTestTargets((items) =>
                                items.map((item, position) =>
                                  position === index
                                    ? {
                                        ...item,
                                        access: event.target.value as TargetDraft['access'],
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option value="read">읽기</option>
                            <option value="write">새 파일 쓰기</option>
                            <option value="readwrite">읽고 수정</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setTestTargets((items) =>
                              items.filter((_, position) => position !== index),
                            )
                          }
                        >
                          대상 삭제
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={testTargets.length >= 32}
                      onClick={() =>
                        setTestTargets((items) => [...items, { id: '', path: '', access: 'read' }])
                      }
                    >
                      대상 추가
                    </button>
                  </div>
                )}
              {testInputMode === 'form' && testSchema.schema && (
                <div className="test-field-grid">
                  {testFields
                    .filter((field) => field.supported)
                    .map((field) => {
                      const errorId = `test-input-error-${field.name}`;
                      const descriptionId = `test-input-description-${field.name}`;
                      const describedBy =
                        [
                          field.description ? descriptionId : '',
                          testFieldErrors[field.name] ? errorId : '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined;
                      return (
                        <label key={field.name}>
                          <span>
                            {field.title} <code>{field.name}</code>
                            {field.required && <strong className="required">필수</strong>}
                          </span>
                          {field.enumValues?.length ? (
                            <select
                              value={String(testFieldValues[field.name] ?? '')}
                              onChange={(event) => changeTestField(field.name, event.target.value)}
                              aria-invalid={Boolean(testFieldErrors[field.name])}
                              aria-describedby={describedBy}
                            >
                              <option value="">값 선택</option>
                              {field.enumValues.map((value) => (
                                <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
                                  {String(value)}
                                </option>
                              ))}
                            </select>
                          ) : field.type === 'boolean' ? (
                            <input
                              type="checkbox"
                              checked={Boolean(testFieldValues[field.name])}
                              onChange={(event) =>
                                changeTestField(field.name, event.target.checked)
                              }
                              aria-invalid={Boolean(testFieldErrors[field.name])}
                              aria-describedby={describedBy}
                            />
                          ) : field.type === 'number' || field.type === 'integer' ? (
                            <input
                              type="number"
                              step={field.type === 'integer' ? 1 : 'any'}
                              value={String(testFieldValues[field.name] ?? '')}
                              onChange={(event) => changeTestField(field.name, event.target.value)}
                              aria-invalid={Boolean(testFieldErrors[field.name])}
                              aria-describedby={describedBy}
                            />
                          ) : (
                            <textarea
                              rows={3}
                              value={String(testFieldValues[field.name] ?? '')}
                              onChange={(event) => changeTestField(field.name, event.target.value)}
                              aria-invalid={Boolean(testFieldErrors[field.name])}
                              aria-describedby={describedBy}
                            />
                          )}
                          {field.description && (
                            <small id={descriptionId}>{field.description}</small>
                          )}
                          {testFieldErrors[field.name] && (
                            <small className="field-error" id={errorId}>
                              {testFieldErrors[field.name]}
                            </small>
                          )}
                        </label>
                      );
                    })}
                  {testFields.some(
                    (field) =>
                      !field.supported &&
                      !(
                        field.name === 'targets' &&
                        selectedAgent.draft.runtime?.targetBinding === 'optional'
                      ),
                  ) && (
                    <div className="unsupported-fields wide">
                      <strong>고급 JSON에서 입력할 항목</strong>
                      <p>
                        {testFields
                          .filter(
                            (field) =>
                              !field.supported &&
                              !(
                                field.name === 'targets' &&
                                selectedAgent.draft.runtime?.targetBinding === 'optional'
                              ),
                          )
                          .map(
                            (field) =>
                              `${field.name} (${field.type}${field.required ? ', 필수' : ''})`,
                          )
                          .join(', ')}
                      </p>
                      <p>
                        중첩 객체·배열·null 타입은 고급 JSON 모드에서 예제 구조에 맞춰 입력하세요.
                      </p>
                    </div>
                  )}
                </div>
              )}
              {testInputMode === 'json' && (
                <label>
                  시험 입력 JSON (고급)
                  <textarea
                    rows={8}
                    value={testInputText}
                    onChange={(event) => {
                      setTestInputText(event.target.value);
                      setTestInputError('');
                    }}
                    aria-invalid={Boolean(testInputError)}
                    aria-describedby={testInputError ? 'test-input-error' : undefined}
                  />
                </label>
              )}
              {(testFields.some((field) => field.name === 'workspace') ||
                workspaceMode === 'caller') && (
                <p className="workspace-note">
                  <code>input.workspace</code>는 프롬프트에 전달되는 입력값입니다. 위의 ‘시험
                  실행에서 사용할 폴더’는 파일·명령 실행 권한을 정하는 별도 요청값이며 서로 대신할
                  수 없습니다.
                </p>
              )}
              {testInputError && (
                <p
                  className="field-error input-summary-error"
                  id="test-input-error"
                  aria-live="polite"
                >
                  {testInputError}
                </p>
              )}
            </fieldset>
            {trackedRun && (
              <div className="test-run-panel" aria-live="polite">
                <div className="test-run-heading">
                  <div>
                    <strong>시험 실행</strong>
                    <span className={`status ${trackedRun.status}`}>
                      {runStatusLabel(trackedRun.status)}
                    </span>
                  </div>
                  <code>{trackedRun.runId}</code>
                </div>
                {activeRunStatuses.has(trackedRun.status) && (
                  <div className="run-progress">
                    <span className="progress-indicator" aria-hidden="true" />
                    <span>
                      {trackedRun.status === 'queued'
                        ? '실행 순서를 기다리고 있습니다.'
                        : trackedRun.status === 'cancel_requested'
                          ? '취소 처리가 끝나기를 기다리고 있습니다.'
                          : '모델이 응답을 생성하고 있습니다.'}
                    </span>
                  </div>
                )}
                {trackedRun.trackingError && (
                  <div className="tracking-error">
                    <p>{trackedRun.trackingError}</p>
                    <button type="button" onClick={retryTrackedRun}>
                      다시 조회
                    </button>
                  </div>
                )}
                {activeRunStatuses.has(trackedRun.status) && (
                  <button type="button" onClick={cancelTrackedRun}>
                    실행 취소
                  </button>
                )}
                {trackedRun.run?.output != null && (
                  <div className="test-run-output">
                    <h3>{trackedRun.status === 'completed' ? '최종 답변' : '확보된 결과'}</h3>
                    {typeof recordValue(trackedRun.run.output)?.value === 'string' ? (
                      <div className="result-answer">
                        {String(recordValue(trackedRun.run.output)?.value)}
                      </div>
                    ) : (
                      <pre>
                        {JSON.stringify(
                          recordValue(trackedRun.run.output)?.value ?? trackedRun.run.output,
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </div>
                )}
                {trackedRun.run && <TargetChanges run={trackedRun.run} />}
                {trackedRun.run && <ServiceTierDetails run={trackedRun.run} />}
                {trackedRun.run?.status === 'completed' && (
                  <div className="test-run-verification" role="status">
                    <strong>
                      과제 검증:{' '}
                      {trackedRun.run.verification?.status === 'passed'
                        ? '통과'
                        : trackedRun.run.verification?.status === 'failed'
                          ? '실패'
                          : '미검증'}
                    </strong>
                    <p>
                      실행 완료는 요청한 과제의 충족을 보장하지 않습니다. 모델의 답변만으로 검증
                      통과로 표시하지 않습니다.
                    </p>
                    {(trackedRun.run.verification?.evidence.checks.length ?? 0) > 0 && (
                      <small>
                        실행된 명령 검사:{' '}
                        {trackedRun.run
                          .verification!.evidence.checks.map(
                            (check) => `${check.commandId} (종료 ${check.exitCode ?? '없음'})`,
                          )
                          .join(', ')}
                      </small>
                    )}
                    {(trackedRun.run.verification?.evidence.toolFailures.length ?? 0) > 0 && (
                      <small>
                        도구 실패 {trackedRun.run.verification!.evidence.toolFailures.length}건:{' '}
                        {trackedRun.run
                          .verification!.evidence.toolFailures.map((failure) => failure.code)
                          .join(', ')}
                      </small>
                    )}
                  </div>
                )}
                {trackedRun.run?.error != null && (
                  <div className="test-run-error">
                    <h3>실행 오류</h3>
                    <strong>
                      {String(recordValue(trackedRun.run.error)?.code ?? 'RUN_FAILED')}
                    </strong>
                    <p>
                      {String(recordValue(trackedRun.run.error)?.message ?? '실행에 실패했습니다.')}
                    </p>
                  </div>
                )}
                {trackedRun.run && (
                  <details className="test-run-details">
                    <summary>원시 실행 상세</summary>
                    <pre>{JSON.stringify(trackedRun.run, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}
            {agentResult && <pre>{agentResult}</pre>}
          </div>
        ) : (
          <div className="empty">목록에서 에이전트를 선택하세요.</div>
        )}
      </div>
    </section>
  );

  const runsView = (
    <section>
      <div className="section-heading">
        <h2>실행 기록</h2>
        <button onClick={() => void runAction(reload)}>새로고침</button>
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <details key={run.id}>
            <summary>
              <strong>
                {agents.find((agent) => agent.id === run.agentId)?.displayName ?? run.agentId}
              </strong>
              <span>{run.source}</span>
              <span className={`status ${run.status}`}>{runStatusLabel(run.status)}</span>
              <time>{new Date(run.createdAt).toLocaleString()}</time>
            </summary>
            {['queued', 'running'].includes(run.status) && (
              <button onClick={() => cancelRun(run.id)}>실행 취소</button>
            )}
            <small>{runDurations(run)}</small>
            {run.waitReason && (
              <small>대기 원인: {waitReasonLabels[run.waitReason] ?? run.waitReason}</small>
            )}
            {run.status === 'completed' && (
              <small>
                과제 검증:{' '}
                {run.verification?.status === 'passed'
                  ? '통과'
                  : run.verification?.status === 'failed'
                    ? '실패'
                    : '미검증'}
              </small>
            )}
            <TargetChanges run={run} />
            <ServiceTierDetails run={run} />
            <pre>
              {JSON.stringify(
                {
                  input: run.input,
                  output: run.output,
                  error: run.error,
                  verification: run.verification,
                },
                null,
                2,
              )}
            </pre>
          </details>
        ))}
        {runs.length === 0 && <p className="empty">아직 실행 기록이 없습니다.</p>}
      </div>
    </section>
  );
  const settingsView = (
    <section>
      <h2>설정 및 데이터 관리</h2>
      {safetyBlocks.length > 0 && (
        <div className="test-run-error" role="alert">
          <h3>명령 종료 확인 실패·추가 실행 차단</h3>
          <p>
            아래 작업 폴더와 겹치는 실행 및 전체 접근 실행은 차단됩니다. 서비스 재시작 후에도
            유지됩니다. 조회 결과가 비어도 전체 종료를 증명할 수 없어 차단을 유지합니다. 독립된 OS
            도구로 전체 종료를 확인한 뒤에만 수동 해제하세요.
          </p>
          {safetyBlocks.map((block) => (
            <div key={block.id}>
              <strong>
                {block.workspace === '\0mcpex-full-access' ? '전체 접근' : block.workspace}
              </strong>
              <p>
                원인: {safetyReasonLabel(block.reason)} · 식별된 프로세스 {block.processes.length}개
              </p>
              <button type="button" onClick={() => verifySafetyBlock(block)}>
                프로세스 상태 재확인 (차단 유지)
              </button>
              <button type="button" onClick={() => manuallyReleaseSafetyBlock(block)}>
                외부 도구로 직접 확인 후 수동 해제
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="split">
        <form onSubmit={saveSettings}>
          <h3>보존 및 실행 제한</h3>
          <label>
            실행 본문·이벤트 보존 기간(일)
            <input
              type="number"
              min="1"
              max="365"
              value={settings.retentionDays}
              onChange={(event) =>
                setSettings({ ...settings, retentionDays: Number(event.target.value) })
              }
            />
          </label>
          <label>
            전역 동시 실행
            <input
              type="number"
              min="1"
              max="8"
              value={settings.globalConcurrency}
              onChange={(event) =>
                setSettings({ ...settings, globalConcurrency: Number(event.target.value) })
              }
            />
          </label>
          <label>
            최대 대기 실행
            <input
              type="number"
              min="1"
              max="1000"
              value={settings.maxPendingRuns}
              onChange={(event) =>
                setSettings({ ...settings, maxPendingRuns: Number(event.target.value) })
              }
            />
          </label>
          <button className="primary">설정 저장 및 만료 데이터 정리</button>
          <h3 className="subheading">데이터베이스 백업</h3>
          <p className="hint">
            백업에는 실행 입력과 결과가 포함될 수 있으며 비밀 파일은 포함하지 않습니다.
          </p>
          <button type="button" onClick={createBackup}>
            지금 백업
          </button>
        </form>
        <div>
          <h3>설정 이동</h3>
          <p className="hint">
            내보내기는 인증값·절대 작업 폴더·명령 경로를 제외합니다. 가져온 에이전트는 모델과 작업
            폴더를 다시 설정해야 하는 비활성 초안이 됩니다.
          </p>
          <div className="actions">
            <button onClick={exportConfig}>설정 내보내기</button>
          </div>
          <label>
            가져올 JSON 파일
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => selectImportFile(event.target.files?.[0])}
            />
          </label>
          <div className="actions">
            <button onClick={previewImport} disabled={!importConfig}>
              충돌 미리보기
            </button>
            <button className="primary" onClick={applyImport} disabled={!importPreview?.canImport}>
              가져오기 적용
            </button>
          </div>
          {maintenanceResult && <pre>{maintenanceResult}</pre>}
        </div>
      </div>
    </section>
  );
  const codexGuide = mcpConnection?.registration
    ? codexRegistrationGuide(mcpConnection.registration)
    : null;
  const connectionView = (
    <section>
      <div className="section-heading">
        <div>
          <h2>MCP 연결 정보</h2>
          <p className="hint">
            MCP 클라이언트에는 MCPex 서버를 한 번만 등록합니다. 활성 에이전트는 각각 별도의 도구로
            제공됩니다.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            void runAction(async () => {
              await reload();
              setMessage('MCP 연결 정보를 새로고침했습니다.');
            })
          }
        >
          새로고침
        </button>
      </div>
      <div className="connection-status-grid">
        <article>
          <strong>로컬 서비스</strong>
          <span className="status completed">정상 응답</span>
          <small>이 설정 화면과 관리 API의 연결 상태입니다.</small>
        </article>
        <article>
          <strong>MCP 클라이언트</strong>
          <span className="status pending">확인 필요</span>
          <small>아래 값을 클라이언트에 등록한 뒤 도구 목록에서 확인하세요.</small>
        </article>
      </div>
      <div className="connection-layout">
        <div>
          <h3>같은 PC의 Codex에 등록</h3>
          <p className="hint">
            Codex의 <strong>설정 → MCP 서버 → 서버 추가</strong> 화면에 아래 순서대로 입력하세요.
            <code> open</code>은 설정 화면을 여는 명령이며 MCP 등록 명령이 아닙니다.
          </p>
          {codexGuide ? (
            <div className="connection-fields">
              <div className="connection-field">
                <div>
                  <strong>1. 이름</strong>
                  <button
                    type="button"
                    onClick={() => copyConnectionValue('이름', codexGuide.name)}
                  >
                    이름 복사
                  </button>
                </div>
                <code>{codexGuide.name}</code>
              </div>
              <div className="connection-field">
                <div>
                  <strong>2. 유형</strong>
                </div>
                <code>{codexGuide.type}</code>
                <small>드롭다운에서 STDIO를 선택합니다.</small>
              </div>
              <div className="connection-field">
                <div>
                  <strong>3. 실행 명령</strong>
                  <button
                    type="button"
                    onClick={() => copyConnectionValue('실행 명령', codexGuide.command)}
                  >
                    실행 명령 복사
                  </button>
                </div>
                <code>{codexGuide.command}</code>
                <small>따옴표를 추가하지 말고 표시된 원시 경로만 붙여넣습니다.</small>
              </div>
              <div className="connection-field">
                <div>
                  <strong>4. 인자 ({codexGuide.args.length}개)</strong>
                </div>
                <small>인자 추가 버튼을 눌러 아래 값을 한 칸에 하나씩 순서대로 넣습니다.</small>
                <ol className="connection-values">
                  {codexGuide.args.map((argument, index) => (
                    <li key={`${index}-${argument}`}>
                      <span>인자 {index + 1}</span>
                      <code>{argument}</code>
                      <button
                        type="button"
                        onClick={() => copyConnectionValue(`인자 ${index + 1}`, argument)}
                      >
                        인자 {index + 1} 복사
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="connection-field">
                <div>
                  <strong>5. 환경 변수</strong>
                </div>
                {codexGuide.environment.length ? (
                  <ul className="connection-values environment-values">
                    {codexGuide.environment.map(({ key, value }) => (
                      <li key={key}>
                        <span>현재 서비스 연결에 필요</span>
                        <div>
                          <code>{key}</code>
                          <button
                            type="button"
                            onClick={() => copyConnectionValue(`환경 변수 키 ${key}`, key)}
                          >
                            키 복사
                          </button>
                        </div>
                        <div>
                          <code>{value}</code>
                          <button
                            type="button"
                            onClick={() => copyConnectionValue(`환경 변수 값 ${key}`, value)}
                          >
                            값 복사
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty-connection-value">추가할 환경 변수가 없습니다.</p>
                )}
              </div>
              <div className="connection-field">
                <div>
                  <strong>6. 환경 변수 패스스루</strong>
                </div>
                <p className="empty-connection-value">
                  비워 둡니다. 전달할 환경 변수 이름이 없습니다.
                </p>
              </div>
              <div className="connection-field">
                <div>
                  <strong>7. 작업 중인 디렉터리</strong>
                </div>
                <p className="empty-connection-value">비워 둡니다 (선택 항목).</p>
                <small>
                  이 값은 MCP 프로세스 시작 위치입니다. 에이전트가 파일을 읽고 쓰는 작업 폴더
                  정책과는 별개입니다.
                </small>
              </div>
              <div className="connection-field">
                <div>
                  <strong>Codex config.toml 전체 설정</strong>
                  <button
                    type="button"
                    onClick={() =>
                      copyConnectionValue('Codex config.toml 설정', codexGuide.configToml)
                    }
                  >
                    전체 설정 복사
                  </button>
                </div>
                <small>
                  Codex 설정 파일을 직접 편집할 때만 사용합니다. 등록 화면에는 위 원시 값을 각각
                  입력하세요.
                </small>
                <pre>{codexGuide.configToml}</pre>
              </div>
            </div>
          ) : (
            <div className="connection-warning" role="note">
              CLI 밖에서 서비스를 직접 실행해 등록 경로를 확정할 수 없습니다. 프로젝트의
              <code> apps/cli/dist/src/index.js</code>를 빌드한 뒤 <code>mcpex open</code>으로 설정
              화면을 다시 여세요.
            </div>
          )}
          <p className="security-note">
            필드별 복사 값에는 JSON 따옴표·대괄호·이스케이프용 중복 백슬래시가 붙지 않습니다. 인증
            토큰과 모델 API 키도 포함되지 않습니다.
          </p>
        </div>
        <div>
          <h3>등록 및 확인 순서</h3>
          <ol className="connection-steps">
            <li>Codex에서 새 MCP 서버를 추가하고 위 필드 값을 그대로 입력합니다.</li>
            <li>저장한 뒤 Codex 화면의 재시작을 선택합니다.</li>
            <li>에이전트에서 초안을 저장·적용한 뒤 활성화합니다.</li>
            <li>
              Codex에서 <code>/mcp</code>를 열어 아래 활성 도구가 보이는지 확인합니다.
            </li>
            <li>목록이 갱신되지 않으면 MCP 서버를 재시작하거나 Codex를 다시 연결합니다.</li>
          </ol>
        </div>
      </div>
      <div className="remote-connection-note" role="note">
        <strong>다른 PC에서 연결: 현재 미지원</strong>
        <p>
          현재 MCPex는 이 PC의 loopback 서비스와 로컬 사용자 인증을 사용합니다. 표시된 STDIO 값은
          같은 PC의 Codex 전용이며, <code>127.0.0.1</code> 주소나 로컬 토큰을 외부 연결 정보로
          사용하면 안 됩니다.
        </p>
      </div>
      <div className="tool-catalog">
        <div>
          <h3>활성 도구 ({mcpConnection?.tools.length ?? 0})</h3>
          {mcpConnection?.tools.length ? (
            <ul>
              {mcpConnection.tools.map((tool) => (
                <li key={tool.name}>
                  <div>
                    <strong>{tool.displayName}</strong>
                    <code>{tool.name}</code>
                  </div>
                  <p>{tool.description}</p>
                  {tool.workspaceState === 'workspace_disabled' && (
                    <p className="tool-capability-warning">
                      MCP 도구는 활성 상태지만 내부 파일·명령 도구는 0개입니다. 적용 설정의 작업
                      폴더 정책이 ‘사용 안 함’입니다.
                    </p>
                  )}
                  {tool.workspaceState === 'no_tools' && (
                    <p className="tool-capability-warning">
                      MCP 도구는 활성 상태지만 적용 설정에서 허용한 내부 도구가 없습니다.
                    </p>
                  )}
                  {tool.workspaceState === 'caller_required' && (
                    <p className="tool-capability-conditional">
                      호출마다 선택한 폴더와 그 하위에서 사용 가능 (폴더 메타데이터 필요):{' '}
                      {tool.effectiveTools.join(', ')}
                    </p>
                  )}
                  {tool.workspaceState === 'fixed' && (
                    <p className="tool-capability-ready">
                      지정 폴더와 하위 전체에서 사용 가능: {tool.effectiveTools.join(', ')}
                    </p>
                  )}
                  {tool.workspaceState === 'full' && (
                    <p className="tool-capability-warning">
                      전체 접근: 현재 OS 사용자 권한 범위에서 {tool.effectiveTools.join(', ')} 사용
                      가능
                    </p>
                  )}
                  {tool.workspaceState === 'response_only' && (
                    <p className="tool-capability-neutral">응답 전용 에이전트</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="connection-warning">
              활성 도구가 없습니다. 에이전트 초안을 저장하고 적용 버전을 만든 뒤 활성화하세요.
            </p>
          )}
        </div>
        <div>
          <h3>비활성·미적용 에이전트 ({mcpConnection?.inactiveAgents.length ?? 0})</h3>
          {mcpConnection?.inactiveAgents.length ? (
            <ul>
              {mcpConnection.inactiveAgents.map((agent) => (
                <li key={agent.name}>
                  <div>
                    <strong>{agent.displayName}</strong>
                    <code>{agent.name}</code>
                  </div>
                  <span>{agent.reason === 'inactive' ? '비활성' : '적용 버전 없음'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">비활성 또는 미적용 에이전트가 없습니다.</p>
          )}
        </div>
      </div>
    </section>
  );
  const views: Record<View, React.ReactNode> = {
    providers: providersView,
    models: modelsView,
    agents: agentsView,
    runs: runsView,
    connection: connectionView,
    settings: settingsView,
  };

  return (
    <main>
      <header>
        <div>
          <h1>MCPex</h1>
          <span>로컬 에이전트 관리</span>
        </div>
        <span className={ready ? 'connected' : 'disconnected'}>
          {ready ? '연결됨' : '연결 필요'}
        </span>
      </header>
      <nav>
        {(
          [
            ['providers', '프로바이더'],
            ['models', '모델'],
            ['agents', '에이전트'],
            ['runs', '실행 기록'],
            ['connection', 'MCP 연결 정보'],
            ['settings', '설정 및 데이터'],
          ] as Array<[View, string]>
        ).map(([id, label]) => (
          <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>
      {ready && safetyBlocks.length > 0 && (
        <div className="notification notification-error" role="alert">
          명령 종료 확인 실패·추가 실행 차단 중입니다. 설정 및 데이터에서 프로세스를 확인하세요.
        </div>
      )}
      {ready ? (
        views[view]
      ) : (
        <section className="empty">
          <h2>인증된 접속이 필요합니다</h2>
          <p>
            <code>mcpex serve</code> 실행 후 <code>mcpex open</code>을 사용하세요.
          </p>
        </section>
      )}
      {(uiError || message) && (
        <aside className="notification-region" aria-label="알림">
          {uiError && (
            <div className="notification notification-error" role="alert" aria-live="assertive">
              <div className="notification-heading">
                <strong>{uiError.code}</strong>
                <span>{uiError.status ? `HTTP ${uiError.status}` : '화면 입력 오류'}</span>
              </div>
              <p>{uiError.message}</p>
              <p className="error-guidance">{errorGuidance(uiError)}</p>
              {uiError.details !== undefined && (
                <details className="notification-details">
                  <summary>상세 정보</summary>
                  <pre>{JSON.stringify(uiError.details, null, 2)}</pre>
                </details>
              )}
              <button
                className="notification-close"
                onClick={() => setUiError(null)}
                aria-label="오류 알림 닫기"
              >
                닫기
              </button>
            </div>
          )}
          {message && (
            <div className="notification notification-success" role="status" aria-live="polite">
              <p>{message}</p>
              <button
                className="notification-close"
                onClick={() => setMessage('')}
                aria-label="안내 알림 닫기"
              >
                닫기
              </button>
            </div>
          )}
        </aside>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
