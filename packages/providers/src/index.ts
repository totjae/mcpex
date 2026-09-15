export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};
export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type GenerateRequest = {
  modelId: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};
export type GenerateResult = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  providerRequestId: string | null;
};
export type ProviderProfile = {
  id: string;
  name: string;
  adapter: string;
  location: 'cloud' | 'local';
  baseUrl: string;
  credential: 'required' | 'optional' | 'none';
};
const providerProfiles: ProviderProfile[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'required',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://openrouter.ai/api/v1',
    credential: 'required',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.deepseek.com/v1',
    credential: 'required',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.mistral.ai/v1',
    credential: 'required',
  },
  {
    id: 'groq',
    name: 'Groq',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    credential: 'required',
  },
  {
    id: 'together',
    name: 'Together AI',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.together.xyz/v1',
    credential: 'required',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    credential: 'required',
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    adapter: 'openai-chat',
    location: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    credential: 'none',
  },
  {
    id: 'ollama',
    name: 'Ollama (OpenAI 호환)',
    adapter: 'openai-chat',
    location: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    credential: 'none',
  },
  {
    id: 'llama-cpp',
    name: 'llama.cpp server',
    adapter: 'openai-chat',
    location: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    credential: 'optional',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    adapter: 'openai-chat',
    location: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    credential: 'optional',
  },
  {
    id: 'localai',
    name: 'LocalAI',
    adapter: 'openai-chat',
    location: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    credential: 'optional',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    adapter: 'anthropic-messages',
    location: 'cloud',
    baseUrl: 'https://api.anthropic.com/v1',
    credential: 'required',
  },
  {
    id: 'google-ai-studio',
    name: 'Google AI Studio',
    adapter: 'gemini-generate-content',
    location: 'cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    credential: 'required',
  },
  {
    id: 'vertex-ai',
    name: 'Google Vertex AI Gemini',
    adapter: 'vertex-gemini',
    location: 'cloud',
    baseUrl: 'https://aiplatform.googleapis.com',
    credential: 'required',
  },
  {
    id: 'novelai',
    name: 'NovelAI Text Generation',
    adapter: 'openai-chat',
    location: 'cloud',
    baseUrl: 'https://text.novelai.net/oa/v1',
    credential: 'required',
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock Converse',
    adapter: 'bedrock-converse',
    location: 'cloud',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    credential: 'required',
  },
];
export function listProviderProfiles(): ProviderProfile[] {
  return providerProfiles.map((profile) => ({ ...profile }));
}
export function getProviderProfile(id: string): ProviderProfile | undefined {
  const profile = providerProfiles.find((profile) => profile.id === id);
  return profile ? { ...profile } : undefined;
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
export interface ModelAdapter {
  generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody?: Record<string, unknown>,
  ): Promise<GenerateResult>;
  listModels(
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    signal?: AbortSignal,
  ): Promise<string[]>;
}
function safeMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message
      ? `공급업체 오류(${status}): ${parsed.error.message}`
      : `공급업체 오류(${status})`;
  } catch {
    return `공급업체 오류(${status})`;
  }
}
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}
export class OpenAIChatAdapter implements ModelAdapter {
  async generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody: Record<string, unknown> = {},
  ): Promise<GenerateResult> {
    const body = {
      ...extraBody,
      model: request.modelId,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      })),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    };
    const response = await fetch(endpoint(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    let parsed: {
      id?: string;
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new ProviderError(502, '공급업체 응답이 올바른 JSON이 아닙니다.');
    }
    const choice = parsed.choices?.[0];
    if (
      !choice?.message ||
      (typeof choice.message.content !== 'string' && !choice.message.tool_calls?.length)
    )
      throw new ProviderError(502, '공급업체 응답에 텍스트나 도구 호출이 없습니다.');
    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (!call.id || !call.function?.name)
        throw new ProviderError(502, '공급업체 도구 호출 형식이 올바르지 않습니다.');
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        throw new ProviderError(502, '공급업체 도구 호출 인자가 JSON이 아닙니다.');
      }
      toolCalls.push({ id: call.id, name: call.function.name, arguments: args });
    }
    const usage = parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens:
            parsed.usage.total_tokens ??
            (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0),
        }
      : null;
    return {
      text: choice.message.content ?? '',
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage,
      providerRequestId: parsed.id ?? null,
    };
  }
  async listModels(
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await fetch(endpoint(baseUrl, '/models'), {
      headers: { ...headers, ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    try {
      const parsed = JSON.parse(raw) as { data?: Array<{ id?: string }> };
      return (parsed.data ?? []).flatMap((item) => (typeof item.id === 'string' ? [item.id] : []));
    } catch {
      throw new ProviderError(502, '모델 목록 응답이 올바른 JSON이 아닙니다.');
    }
  }
}
function providerHeaders(
  headers: Record<string, string>,
  credential: string | undefined,
  additions: Record<string, string>,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...headers,
    ...additions,
    ...(credential ? { authorization: `Bearer ${credential}` } : {}),
  };
}
export class AnthropicMessagesAdapter implements ModelAdapter {
  async generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody: Record<string, unknown> = {},
  ): Promise<GenerateResult> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool')
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
              },
            ],
          };
        if (message.role === 'assistant' && message.toolCalls?.length)
          return {
            role: 'assistant',
            content: [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments,
              })),
            ],
          };
        return { role: message.role, content: message.content };
      });
    const body = {
      ...extraBody,
      model: request.modelId,
      max_tokens: request.maxOutputTokens ?? 1024,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
    };
    const response = await fetch(endpoint(baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
        'anthropic-version': '2023-06-01',
        ...(credential ? { 'x-api-key': credential } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    let parsed: {
      id?: string;
      stop_reason?: string;
      content?: Array<
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
      >;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new ProviderError(502, '공급업체 응답이 올바른 JSON이 아닙니다.');
    }
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of parsed.content ?? []) {
      if (block.type === 'text') text += block.text ?? '';
      if (block.type === 'tool_use') {
        if (!block.id || !block.name)
          throw new ProviderError(502, 'Anthropic 도구 호출 형식이 올바르지 않습니다.');
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      }
    }
    if (!text && !toolCalls.length)
      throw new ProviderError(502, '공급업체 응답에 텍스트나 도구 호출이 없습니다.');
    return {
      text,
      toolCalls,
      finishReason: parsed.stop_reason ?? null,
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.input_tokens ?? 0,
            completionTokens: parsed.usage.output_tokens ?? 0,
            totalTokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
          }
        : null,
      providerRequestId: parsed.id ?? null,
    };
  }
  async listModels(
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await fetch(endpoint(baseUrl, '/models'), {
      headers: {
        ...headers,
        'anthropic-version': '2023-06-01',
        ...(credential ? { 'x-api-key': credential } : {}),
      },
      signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    try {
      const parsed = JSON.parse(raw) as { data?: Array<{ id?: string }> };
      return (parsed.data ?? []).flatMap((item) => (typeof item.id === 'string' ? [item.id] : []));
    } catch {
      throw new ProviderError(502, '공급업체 모델 목록 응답이 올바른 JSON이 아닙니다.');
    }
  }
}
export class GeminiGenerateContentAdapter implements ModelAdapter {
  async generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody: Record<string, unknown> = {},
  ): Promise<GenerateResult> {
    const toolNames = new Map<string, string>();
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool') {
          const name = toolNames.get(message.toolCallId ?? '') ?? message.toolCallId ?? 'tool';
          let responseValue: unknown = message.content;
          try {
            responseValue = JSON.parse(message.content);
          } catch {
            // Keep non-JSON tool output as a string.
          }
          return { role: 'user', parts: [{ functionResponse: { name, response: responseValue } }] };
        }
        if (message.role === 'assistant') {
          const parts: Array<Record<string, unknown>> = [];
          if (message.content) parts.push({ text: message.content });
          for (const call of message.toolCalls ?? []) {
            toolNames.set(call.id, call.name);
            parts.push({ functionCall: { name: call.name, args: call.arguments, id: call.id } });
          }
          return { role: 'model', parts };
        }
        return { role: 'user', parts: [{ text: message.content }] };
      });
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const body = {
      ...extraBody,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
      ...(request.temperature === undefined &&
      request.topP === undefined &&
      request.maxOutputTokens === undefined
        ? {}
        : {
            generationConfig: {
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.topP === undefined ? {} : { topP: request.topP }),
              ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
            },
          }),
    };
    const response = await fetch(
      endpoint(baseUrl, `/models/${encodeURIComponent(request.modelId)}:generateContent`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
          ...(credential ? { 'x-goog-api-key': credential } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    let parsed: {
      responseId?: string;
      candidates?: Array<{
        finishReason?: string;
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new ProviderError(502, '공급업체 응답이 올바른 JSON이 아닙니다.');
    }
    const candidate = parsed.candidates?.[0];
    if (!candidate?.content?.parts?.length)
      throw new ProviderError(502, 'Gemini 응답에 콘텐츠가 없습니다.');
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const part of candidate.content.parts) {
      if (part.text) text += part.text;
      if (part.functionCall?.name) {
        const id = part.functionCall.id ?? `gemini-call-${toolCalls.length + 1}`;
        toolCalls.push({
          id,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }
    if (!text && !toolCalls.length)
      throw new ProviderError(502, '공급업체 응답에 텍스트나 도구 호출이 없습니다.');
    return {
      text,
      toolCalls,
      finishReason: candidate.finishReason ?? null,
      usage: parsed.usageMetadata
        ? {
            promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: parsed.usageMetadata.totalTokenCount ?? 0,
          }
        : null,
      providerRequestId: parsed.responseId ?? null,
    };
  }
  async listModels(
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await fetch(endpoint(baseUrl, '/models'), {
      headers: { ...headers, ...(credential ? { 'x-goog-api-key': credential } : {}) },
      signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    try {
      const parsed = JSON.parse(raw) as { models?: Array<{ name?: string }> };
      return (parsed.models ?? []).flatMap((item) =>
        typeof item.name === 'string' ? [item.name.replace(/^models\//, '')] : [],
      );
    } catch {
      throw new ProviderError(502, 'Gemini 모델 목록 응답이 올바른 JSON이 아닙니다.');
    }
  }
}
export class VertexGeminiAdapter extends GeminiGenerateContentAdapter {
  async generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody: Record<string, unknown> = {},
  ): Promise<GenerateResult> {
    const projectId = typeof extraBody.projectId === 'string' ? extraBody.projectId : undefined;
    const location = typeof extraBody.location === 'string' ? extraBody.location : undefined;
    if (!projectId || !location)
      throw new ProviderError(
        422,
        'Vertex AI에는 extraBody.projectId와 extraBody.location이 필요합니다.',
      );
    const { projectId: _projectId, location: _location, ...body } = extraBody;
    const configuredUrl = new URL(baseUrl);
    const configuredHost = configuredUrl.host;
    const host =
      configuredHost === 'aiplatform.googleapis.com' && location !== 'global'
        ? `${location}-aiplatform.googleapis.com`
        : configuredHost;
    return super.generate(
      request,
      `${configuredUrl.protocol}//${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google`,
      { ...headers, ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      undefined,
      body,
    );
  }
}
export class BedrockConverseAdapter implements ModelAdapter {
  async generate(
    request: GenerateRequest,
    baseUrl: string,
    headers: Record<string, string>,
    credential: string | undefined,
    extraBody: Record<string, unknown> = {},
  ): Promise<GenerateResult> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => ({ text: message.content }));
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool')
          return {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: message.toolCallId,
                  content: [{ text: message.content }],
                },
              },
            ],
          };
        if (message.role === 'assistant' && message.toolCalls?.length)
          return {
            role: 'assistant',
            content: [
              ...(message.content ? [{ text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                toolUse: { toolUseId: call.id, name: call.name, input: call.arguments },
              })),
            ],
          };
        return {
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: [{ text: message.content }],
        };
      });
    const body = {
      ...extraBody,
      ...(system.length ? { system } : {}),
      messages,
      ...(request.tools?.length
        ? {
            toolConfig: {
              tools: request.tools.map((tool) => ({
                toolSpec: {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: { json: tool.inputSchema },
                },
              })),
            },
          }
        : {}),
      ...(request.temperature === undefined &&
      request.topP === undefined &&
      request.maxOutputTokens === undefined
        ? {}
        : {
            inferenceConfig: {
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.topP === undefined ? {} : { topP: request.topP }),
              ...(request.maxOutputTokens === undefined
                ? {}
                : { maxTokens: request.maxOutputTokens }),
            },
          }),
    };
    const response = await fetch(
      endpoint(baseUrl, `/model/${encodeURIComponent(request.modelId)}/converse`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(response.status, safeMessage(response.status, raw));
    let parsed: {
      output?: {
        message?: {
          content?: Array<
            | { text?: string }
            | { toolUse?: { toolUseId?: string; name?: string; input?: Record<string, unknown> } }
          >;
        };
      };
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new ProviderError(502, '공급업체 응답이 올바른 JSON이 아닙니다.');
    }
    const content = parsed.output?.message?.content ?? [];
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if ('text' in block) text += block.text ?? '';
      if ('toolUse' in block && block.toolUse?.toolUseId && block.toolUse.name)
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          arguments: block.toolUse.input ?? {},
        });
    }
    if (!text && !toolCalls.length)
      throw new ProviderError(502, '공급업체 응답에 텍스트나 도구 호출이 없습니다.');
    return {
      text,
      toolCalls,
      finishReason: parsed.stopReason ?? null,
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.inputTokens ?? 0,
            completionTokens: parsed.usage.outputTokens ?? 0,
            totalTokens: parsed.usage.totalTokens ?? 0,
          }
        : null,
      providerRequestId: null,
    };
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}
export function getAdapter(adapter: string): ModelAdapter {
  if (adapter === 'openai-chat') return new OpenAIChatAdapter();
  if (adapter === 'anthropic-messages') return new AnthropicMessagesAdapter();
  if (adapter === 'gemini-generate-content') return new GeminiGenerateContentAdapter();
  if (adapter === 'vertex-gemini') return new VertexGeminiAdapter();
  if (adapter === 'bedrock-converse') return new BedrockConverseAdapter();
  throw new ProviderError(422, `지원하지 않는 adapter입니다: ${adapter}`);
}
