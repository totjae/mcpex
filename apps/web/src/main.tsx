import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { activeRunStatuses, pollRun } from './run-tracker.js';
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
import './style.css';

type View = 'providers' | 'models' | 'agents' | 'runs' | 'connection' | 'settings';
type Provider = {
  id: string;
  name: string;
  adapter: string;
  baseUrl: string;
  hasCredential: boolean;
  maxConcurrency?: number;
  resourceGroup?: string;
  resourceGroupConcurrency?: number;
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
};
type CommandSpec = { commandId: string; executable: string; label?: string };
type AgentConfig = {
  modelRef?: string | null;
  description?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
  inputSchema?: Record<string, unknown>;
  output?: { format?: 'markdown' | 'json'; schema?: Record<string, unknown> };
  runtime?: {
    mode?: 'response' | 'tools';
    tools?: string[];
    maxModelTurns?: number;
    maxToolCalls?: number;
    workspacePolicy?: { mode?: 'none' | 'fixed' | 'caller'; allowedRoots?: string[] };
    commands?: CommandSpec[];
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
  input: unknown;
  output: unknown;
  error: unknown;
  createdAt: string;
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
type McpConnection = {
  transport: 'stdio';
  registration: {
    command: string;
    args: string[];
    environment?: Record<string, string>;
  } | null;
  service: { status: 'ok' };
  clientConnection: { status: 'unverified' };
  tools: Array<{ name: string; displayName: string; description: string }>;
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
const toolNames = [
  'list_files',
  'read_file',
  'search_text',
  'write_file',
  'replace_text',
  'run_command',
];

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
      completed: '완료',
      failed: '실패',
      cancelled: '취소됨',
      timed_out: '시간 초과',
      interrupted: '서비스 중단으로 종료',
    }[status] ?? status
  );
}

function ModelOptions({ models }: { models: Model[] }) {
  return (
    <>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label} ({model.modelId})
        </option>
      ))}
    </>
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
  const [resourceGroup, setResourceGroup] = useState('');
  const [resourceGroupConcurrency, setResourceGroupConcurrency] = useState('1');

  const [modelProviderId, setModelProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelDefaultsText, setModelDefaultsText] = useState('{}');
  const [probeModelId, setProbeModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [modelResult, setModelResult] = useState('');

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
  const [testFieldErrors, setTestFieldErrors] = useState<Record<string, string>>({});
  const [testInputError, setTestInputError] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<'none' | 'fixed' | 'caller'>('none');
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
    ] = await Promise.all([
      api<{ items: Provider[] }>('/api/v1/providers'),
      api<{ items: Model[] }>('/api/v1/models'),
      api<{ items: ProviderProfile[] }>('/api/v1/provider-profiles'),
      api<{ items: Agent[] }>('/api/v1/agents'),
      api<{ items: Template[] }>('/api/v1/templates'),
      api<{ items: Run[] }>('/api/v1/runs'),
      api<Settings>('/api/v1/settings'),
      api<McpConnection>('/api/v1/mcp-connection'),
    ]);
    setProviders(providerData.items);
    setModels(modelData.items);
    setProfiles(profileData.items);
    setAgents(agentData.items);
    setTemplates(templateData.items);
    setRuns(runData.items);
    setSettings(settingsData);
    setMcpConnection(connectionData);
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
        }),
      });
      setModelId('');
      await reload();
      setMessage('모델을 등록했습니다.');
    });
  };

  const probe = (event: React.FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      if (!probeModelId) throw new Error('시험할 모델을 선택하세요.');
      const data = await api<{ result: { text: string } }>(
        `/api/v1/models/${probeModelId}/probes`,
        { method: 'POST', body: JSON.stringify({ prompt }) },
      );
      setModelResult(data.result.text);
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
    setTestInputText(
      JSON.stringify(
        testInputMode === 'json'
          ? schemaExample(testSchema.schema)
          : formValuesToInput(testSchema.schema, values),
        null,
        2,
      ),
    );
    setTestFieldErrors({});
    setTestInputError('');
  };

  const changeTestInputMode = (mode: 'form' | 'json') => {
    if (mode === testInputMode || !testSchema.schema) return;
    if (mode === 'json') {
      const example = schemaExample(testSchema.schema);
      setTestInputText(
        JSON.stringify(
          { ...example, ...formValuesToInput(testSchema.schema, testFieldValues) },
          null,
          2,
        ),
      );
    } else {
      try {
        const input = parseAdvancedInput(testInputText);
        setTestFieldValues(reconcileFormValues(testSchema.schema, input));
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
          workspaceMode === 'none'
            ? { mode: 'none' as const, allowedRoots: [] }
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

  const previewOrApplyTemplate = (apply: boolean) =>
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
          }),
        },
      );
      if (apply) {
        await reload();
        selectAgent(data as Agent);
        setMessage('템플릿의 전체 설정 묶음을 초안에 적용했습니다.');
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
          `"${selectedAgent.displayName}" 에이전트를 삭제하시겠습니까? 목록과 MCP 도구에서 제거되며 toolName "${selectedAgent.toolName}"은 다시 사용할 수 없습니다. 기존 실행 기록은 유지됩니다.`,
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
      setMessage('에이전트를 삭제했습니다. toolName은 재사용되지 않습니다.');
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

  const deleteModel = (model: Model) => {
    if (
      !window.confirm(
        `모델 "${model.label}" (${model.modelId})을 삭제하시겠습니까? 에이전트 초안이나 적용 버전에서 참조 중이면 삭제가 차단됩니다.`,
      )
    )
      return;
    void runAction(async () => {
      await api(`/api/v1/models/${model.id}`, { method: 'DELETE' });
      await reload();
      setMessage(`모델 "${model.label}"을 삭제했습니다.`);
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
          <article key={provider.id}>
            <strong>{provider.name}</strong>
            <span>{provider.adapter}</span>
            <code>{provider.baseUrl}</code>
            <small>{provider.hasCredential ? '인증 저장됨' : '인증 없음'}</small>
            <div className="card-actions">
              <button
                type="button"
                className="danger"
                onClick={() => deleteProvider(provider)}
                aria-label={`${provider.name} 프로바이더 삭제`}
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );

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
              onChange={(event) => setModelProviderId(event.target.value)}
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
          <button className="primary">등록</button>
          <ul className="model-list">
            {modelsByProvider.map((model) => (
              <li key={model.id}>
                <span>
                  {model.label} <code>{model.modelId}</code>
                </span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => deleteModel(model)}
                  aria-label={`${model.label} 모델 삭제`}
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
              onChange={(event) => setProbeModelId(event.target.value)}
              required
            >
              <option value="">선택</option>
              <ModelOptions models={models} />
            </select>
          </label>
          <label>
            프롬프트
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button className="primary">시험</button>
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
          <ModelOptions models={models} />
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
                  onChange={(event) => updateDraft({ modelRef: event.target.value })}
                >
                  <ModelOptions models={models} />
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
                작업 폴더 정책
                <select
                  value={workspaceMode}
                  onChange={(event) => {
                    setWorkspaceMode(event.target.value as 'none' | 'fixed' | 'caller');
                    setAgentDirty(true);
                  }}
                >
                  <option value="none">사용 안 함</option>
                  <option value="fixed">고정 폴더</option>
                  <option value="caller">호출자 폴더</option>
                </select>
              </label>
              <label>
                {workspaceMode === 'caller' ? '허용 루트' : '작업 폴더'}
                <input
                  placeholder="C:\\workspace"
                  value={workspace}
                  disabled={workspaceMode === 'none'}
                  onChange={(event) => {
                    setWorkspace(event.target.value);
                    setAgentDirty(true);
                  }}
                />
              </label>
              {workspaceMode === 'caller' && (
                <label>
                  시험 호출 작업 폴더
                  <input
                    placeholder="C:\\workspace\\project"
                    value={testWorkspace}
                    onChange={(event) => setTestWorkspace(event.target.value)}
                  />
                </label>
              )}
            </div>
            <fieldset>
              <legend>허용 도구</legend>
              {toolNames.map((tool) => (
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
                  {testFields.some((field) => !field.supported) && (
                    <div className="unsupported-fields wide">
                      <strong>고급 JSON에서 입력할 항목</strong>
                      <p>
                        {testFields
                          .filter((field) => !field.supported)
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
                  <code>input.workspace</code>는 프롬프트에 전달되는 입력값입니다. 위의 ‘시험 호출
                  작업 폴더’는 파일·명령 실행 권한을 정하는 별도 요청값이며 서로 대신할 수 없습니다.
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
              <span className={`status ${run.status}`}>{run.status}</span>
              <time>{new Date(run.createdAt).toLocaleString()}</time>
            </summary>
            {['queued', 'running'].includes(run.status) && (
              <button onClick={() => cancelRun(run.id)}>실행 취소</button>
            )}
            <pre>
              {JSON.stringify({ input: run.input, output: run.output, error: run.error }, null, 2)}
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
  const registrationConfig = mcpConnection?.registration
    ? JSON.stringify(
        {
          command: mcpConnection.registration.command,
          args: mcpConnection.registration.args,
          ...(mcpConnection.registration.environment
            ? { env: mcpConnection.registration.environment }
            : {}),
        },
        null,
        2,
      )
    : '';
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
          <h3>STDIO 등록 값</h3>
          <p className="hint">
            전송 방식은 <strong>STDIO</strong>입니다. <code>open</code>은 설정 화면을 여는 명령이며
            MCP 등록 명령이 아닙니다.
          </p>
          {mcpConnection?.registration ? (
            <div className="connection-fields">
              <div className="connection-field">
                <div>
                  <strong>실행 파일</strong>
                  <button
                    type="button"
                    onClick={() =>
                      copyConnectionValue('실행 파일', mcpConnection.registration!.command)
                    }
                  >
                    실행 파일 복사
                  </button>
                </div>
                <code>{mcpConnection.registration.command}</code>
              </div>
              <div className="connection-field">
                <div>
                  <strong>인수 배열</strong>
                  <button
                    type="button"
                    onClick={() =>
                      copyConnectionValue(
                        '인수 배열',
                        JSON.stringify(mcpConnection.registration!.args),
                      )
                    }
                  >
                    인수 복사
                  </button>
                </div>
                <pre>{JSON.stringify(mcpConnection.registration.args, null, 2)}</pre>
              </div>
              {mcpConnection.registration.environment && (
                <div className="connection-field">
                  <div>
                    <strong>환경변수</strong>
                    <button
                      type="button"
                      onClick={() =>
                        copyConnectionValue(
                          '환경변수',
                          JSON.stringify(mcpConnection.registration!.environment),
                        )
                      }
                    >
                      환경변수 복사
                    </button>
                  </div>
                  <pre>{JSON.stringify(mcpConnection.registration.environment, null, 2)}</pre>
                </div>
              )}
              <div className="connection-field">
                <div>
                  <strong>일반 JSON 예시</strong>
                  <button
                    type="button"
                    onClick={() => copyConnectionValue('등록 JSON', registrationConfig)}
                  >
                    JSON 복사
                  </button>
                </div>
                <pre>{registrationConfig}</pre>
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
            복사 값에는 인증 토큰과 모델 API 키가 포함되지 않습니다. 경로에 공백이 있어도 실행
            파일과 인수를 별도 필드에 그대로 입력하세요.
          </p>
        </div>
        <div>
          <h3>등록 및 확인 순서</h3>
          <ol className="connection-steps">
            <li>MCP 클라이언트에서 새 로컬 STDIO 서버를 하나 추가합니다.</li>
            <li>위 실행 파일, 인수 배열과 표시된 환경변수를 각각 입력하고 저장합니다.</li>
            <li>에이전트에서 초안을 저장·적용한 뒤 활성화합니다.</li>
            <li>클라이언트의 도구 목록을 새로고침하고 아래 활성 도구가 보이는지 확인합니다.</li>
            <li>목록이 갱신되지 않으면 MCP 연결을 끊었다가 다시 연결합니다.</li>
          </ol>
        </div>
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
