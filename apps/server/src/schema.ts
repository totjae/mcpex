import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_PROPERTIES = 100;
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 128 * 1024;

const allowedKeywords = new Set([
  '$schema',
  'type',
  'title',
  'description',
  'default',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);
const supportedTypes = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);
const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });

export class SchemaContractError extends Error {
  constructor(
    readonly code: 'INVALID_SCHEMA' | 'INVALID_INPUT' | 'INVALID_OUTPUT' | 'OUTPUT_LIMIT',
    message: string,
    readonly details?: unknown,
    readonly output?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SchemaContractError';
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inspectSchema(
  schema: unknown,
  depth: number,
  state: { properties: number },
): asserts schema is Record<string, unknown> {
  if (!plainObject(schema))
    throw new SchemaContractError('INVALID_SCHEMA', '스키마는 객체여야 합니다.');
  if (depth > MAX_SCHEMA_DEPTH)
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      `스키마 깊이는 ${MAX_SCHEMA_DEPTH} 이하여야 합니다.`,
    );
  for (const key of Object.keys(schema))
    if (!allowedKeywords.has(key))
      throw new SchemaContractError('INVALID_SCHEMA', `지원하지 않는 스키마 키워드입니다: ${key}`);
  if (typeof schema.type !== 'string' || !supportedTypes.has(schema.type))
    throw new SchemaContractError('INVALID_SCHEMA', '지원하는 단일 type이 필요합니다.');
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string'))
  )
    throw new SchemaContractError('INVALID_SCHEMA', 'required는 문자열 배열이어야 합니다.');
  if (schema.properties !== undefined) {
    if (!plainObject(schema.properties))
      throw new SchemaContractError('INVALID_SCHEMA', 'properties는 객체여야 합니다.');
    state.properties += Object.keys(schema.properties).length;
    if (state.properties > MAX_PROPERTIES)
      throw new SchemaContractError(
        'INVALID_SCHEMA',
        `속성 수는 ${MAX_PROPERTIES}개 이하여야 합니다.`,
      );
    for (const child of Object.values(schema.properties)) inspectSchema(child, depth + 1, state);
  }
  if (schema.items !== undefined) inspectSchema(schema.items, depth + 1, state);
  if (plainObject(schema.additionalProperties))
    inspectSchema(schema.additionalProperties, depth + 1, state);
}

export function validateUserSchema(
  schema: unknown,
  options: { topLevelObject?: boolean } = {},
): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new SchemaContractError('INVALID_SCHEMA', '스키마를 JSON으로 직렬화할 수 없습니다.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES)
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      `스키마는 ${MAX_SCHEMA_BYTES} bytes 이하여야 합니다.`,
    );
  inspectSchema(schema, 1, { properties: 0 });
  if (options.topLevelObject && schema.type !== 'object')
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      '입력 스키마의 최상위 type은 object여야 합니다.',
    );
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      error instanceof Error ? error.message : '유효하지 않은 JSON Schema입니다.',
    );
  }
  return schema;
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? '검증 실패'}`)
    .join('; ');
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new SchemaContractError(
      'INVALID_SCHEMA',
      error instanceof Error ? error.message : '유효하지 않은 JSON Schema입니다.',
    );
  }
}

export function validateInput(
  schema: unknown,
  input: unknown,
): asserts input is Record<string, unknown> {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES)
    throw new SchemaContractError(
      'INVALID_INPUT',
      `입력은 ${MAX_INPUT_BYTES} bytes 이하여야 합니다.`,
    );
  const checked = validateUserSchema(schema, { topLevelObject: true });
  const validate = compile(checked);
  if (!validate(input))
    throw new SchemaContractError('INVALID_INPUT', '입력이 선언된 스키마와 일치하지 않습니다.', {
      errors: validate.errors,
      message: validationMessage(validate.errors),
    });
}

function capRawText(text: string): { rawText: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  return {
    rawText: bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8'),
    truncated: bytes.byteLength > MAX_OUTPUT_BYTES,
    originalBytes: bytes.byteLength,
  };
}

function unwrapJson(text: string): string {
  const fenced = text.match(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return fenced ? fenced[1] : text;
}

export function validateOutput(
  output: { format?: string; schema?: unknown } | undefined,
  text: string,
): Record<string, unknown> {
  const raw = capRawText(text);
  if (raw.truncated)
    throw new SchemaContractError(
      'OUTPUT_LIMIT',
      `모델 출력은 ${MAX_OUTPUT_BYTES} bytes 이하여야 합니다.`,
      { originalBytes: raw.originalBytes },
      { format: output?.format ?? 'markdown', ...raw },
    );
  const format = output?.format ?? 'markdown';
  if (format === 'text' || format === 'markdown') return { format, value: text };
  if (format !== 'json')
    throw new SchemaContractError('INVALID_OUTPUT', `지원하지 않는 출력 형식입니다: ${format}`);
  if (!output?.schema)
    throw new SchemaContractError('INVALID_SCHEMA', 'JSON 출력에는 output.schema가 필요합니다.');
  let value: unknown;
  try {
    value = JSON.parse(unwrapJson(text));
  } catch {
    throw new SchemaContractError(
      'INVALID_OUTPUT',
      '모델 출력이 유효한 JSON이 아닙니다.',
      undefined,
      { format: 'json', ...raw },
    );
  }
  if (!value || typeof value !== 'object')
    throw new SchemaContractError(
      'INVALID_OUTPUT',
      'JSON 출력은 객체 또는 배열이어야 합니다.',
      undefined,
      { format: 'json', ...raw },
    );
  const schema = validateUserSchema(output.schema);
  const validate = compile(schema);
  if (!validate(value))
    throw new SchemaContractError(
      'INVALID_OUTPUT',
      'JSON 출력이 선언된 스키마와 일치하지 않습니다.',
      { errors: validate.errors, message: validationMessage(validate.errors) },
      { format: 'json', ...raw },
    );
  return { format: 'json', value };
}
