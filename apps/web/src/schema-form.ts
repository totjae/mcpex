export type JsonObject = Record<string, unknown>;
export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export type SchemaField = {
  name: string;
  title: string;
  description?: string;
  type: string;
  required: boolean;
  supported: boolean;
  enumValues?: unknown[];
  defaultValue?: unknown;
  schema: JsonObject;
};

export type InputValidationError = { path: string; message: string };

function plainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueHasType(value: unknown, type: unknown): boolean {
  if (type === 'object') return plainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

export function parseSchemaText(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`입력 스키마 JSON 구문 오류: ${(error as Error).message}`);
  }
  if (!plainObject(parsed)) throw new Error('입력 스키마는 JSON 객체여야 합니다.');
  return parsed;
}

export function schemaFields(schema: JsonObject): SchemaField[] {
  const properties = plainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  return Object.entries(properties).map(([name, value]) => {
    const child = plainObject(value) ? value : {};
    const type = typeof child.type === 'string' ? child.type : '미지정';
    const enumValues = Array.isArray(child.enum) ? child.enum : undefined;
    const enumSupported = enumValues?.every(
      (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    );
    return {
      name,
      title: typeof child.title === 'string' ? child.title : name,
      description: typeof child.description === 'string' ? child.description : undefined,
      type,
      required: required.has(name),
      supported:
        Boolean(enumValues?.length && enumSupported) ||
        ['string', 'number', 'integer', 'boolean'].includes(type),
      enumValues,
      defaultValue: child.default,
      schema: child,
    };
  });
}

function encodeFormValue(field: SchemaField, value: unknown): FormValue | undefined {
  if (field.enumValues?.some((item) => sameValue(item, value))) return JSON.stringify(value);
  if (field.type === 'boolean' && typeof value === 'boolean') return value;
  if (field.type === 'string' && typeof value === 'string') return value;
  if (['number', 'integer'].includes(field.type) && typeof value === 'number') return String(value);
  return undefined;
}

function initialFormValue(field: SchemaField): FormValue {
  const encodedDefault = encodeFormValue(field, field.defaultValue);
  if (encodedDefault !== undefined) return encodedDefault;
  if (field.enumValues?.length) return '';
  if (field.type === 'boolean') return false;
  if (field.type === 'string' && field.name === 'task') return '간단히 응답해 주세요.';
  return '';
}

export function reconcileFormValues(schema: JsonObject, previous: JsonObject = {}): FormValues {
  return Object.fromEntries(
    schemaFields(schema)
      .filter((field) => field.supported)
      .map((field) => [
        field.name,
        encodeFormValue(field, previous[field.name]) ?? initialFormValue(field),
      ]),
  );
}

function exampleValue(schema: JsonObject, name = ''): unknown {
  if ('default' in schema) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === 'string') return name === 'task' ? '간단히 응답해 주세요.' : '';
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof schema.minimum === 'number') return schema.minimum;
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
    return 0;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  if (schema.type === 'array') {
    const count = typeof schema.minItems === 'number' ? Math.max(0, schema.minItems) : 0;
    return plainObject(schema.items)
      ? Array.from({ length: count }, () => exampleValue(schema.items as JsonObject))
      : [];
  }
  if (schema.type === 'object') {
    const properties = plainObject(schema.properties) ? schema.properties : {};
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([, child]) => plainObject(child))
        .map(([childName, child]) => [childName, exampleValue(child as JsonObject, childName)]),
    );
  }
  return null;
}

function reconciledExampleValue(schema: JsonObject, previous: unknown, name = ''): unknown {
  if (!valueHasType(previous, schema.type)) return exampleValue(schema, name);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameValue(item, previous)))
    return exampleValue(schema, name);
  if ('const' in schema && !sameValue(schema.const, previous)) return exampleValue(schema, name);
  if (schema.type !== 'object' || !plainObject(previous)) return previous;
  const properties = plainObject(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, child]) => plainObject(child))
      .map(([childName, child]) => [
        childName,
        reconciledExampleValue(child as JsonObject, previous[childName], childName),
      ]),
  );
}

export function schemaExample(schema: JsonObject, previous?: JsonObject): JsonObject {
  const example =
    previous === undefined ? exampleValue(schema) : reconciledExampleValue(schema, previous);
  return plainObject(example) ? example : {};
}

function decodeFormValue(field: SchemaField, raw: FormValue): unknown {
  if (field.enumValues?.length) return raw === '' ? undefined : JSON.parse(String(raw));
  if (field.type === 'boolean') return Boolean(raw);
  if (field.type === 'number' || field.type === 'integer') {
    if (raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw === '' ? undefined : raw;
}

export function formValuesToInput(schema: JsonObject, values: FormValues): JsonObject {
  const result: JsonObject = {};
  for (const field of schemaFields(schema)) {
    if (!field.supported) continue;
    const value = decodeFormValue(field, values[field.name] ?? '');
    if (value !== undefined) result[field.name] = value;
  }
  return result;
}

function addError(errors: InputValidationError[], path: string, message: string) {
  errors.push({ path: path || '/', message });
}

function validateNode(
  schema: JsonObject,
  value: unknown,
  path: string,
  errors: InputValidationError[],
) {
  if (!valueHasType(value, schema.type)) {
    addError(errors, path, `${String(schema.type)} 타입이어야 합니다.`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameValue(item, value)))
    addError(errors, path, '허용된 값 중 하나여야 합니다.');
  if ('const' in schema && !sameValue(schema.const, value))
    addError(errors, path, `고정값 ${JSON.stringify(schema.const)}이어야 합니다.`);

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      addError(errors, path, `최소 ${schema.minLength}자여야 합니다.`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      addError(errors, path, `최대 ${schema.maxLength}자여야 합니다.`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      addError(errors, path, `${schema.minimum} 이상이어야 합니다.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      addError(errors, path, `${schema.maximum} 이하여야 합니다.`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      addError(errors, path, `${schema.exclusiveMinimum}보다 커야 합니다.`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
      addError(errors, path, `${schema.exclusiveMaximum}보다 작아야 합니다.`);
    if (typeof schema.multipleOf === 'number' && (value / schema.multipleOf) % 1 !== 0)
      addError(errors, path, `${schema.multipleOf}의 배수여야 합니다.`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      addError(errors, path, `항목이 최소 ${schema.minItems}개 필요합니다.`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      addError(errors, path, `항목은 최대 ${schema.maxItems}개까지 허용됩니다.`);
    if (plainObject(schema.items))
      value.forEach((item, index) =>
        validateNode(schema.items as JsonObject, item, `${path}/${index}`, errors),
      );
  }
  if (plainObject(value)) {
    const properties = plainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [];
    for (const name of required)
      if (!(name in value)) addError(errors, `${path}/${name}`, '필수 입력입니다.');
    for (const [name, child] of Object.entries(properties))
      if (name in value && plainObject(child))
        validateNode(child, value[name], `${path}/${name}`, errors);
    if (schema.additionalProperties === false)
      for (const name of Object.keys(value))
        if (!(name in properties)) addError(errors, `${path}/${name}`, '정의되지 않은 항목입니다.');
  }
}

export function validateInput(schema: JsonObject, input: unknown): InputValidationError[] {
  const errors: InputValidationError[] = [];
  if (schema.type !== 'object') {
    addError(errors, '/', '입력 스키마의 최상위 type은 object여야 합니다.');
    return errors;
  }
  validateNode(schema, input, '', errors);
  return errors;
}

export function parseAdvancedInput(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = (error as Error).message;
    const position = message.match(/position (\d+)/)?.[1];
    if (!position) throw new Error(`JSON 구문 오류: ${message}`);
    const offset = Number(position);
    const before = value.slice(0, offset);
    const line = before.split(/\r?\n/).length;
    const column = offset - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    throw new Error(`JSON 구문 오류 (${line}행 ${column}열): ${message}`);
  }
  if (!plainObject(parsed)) throw new Error('시험 입력의 최상위 값은 JSON 객체여야 합니다.');
  return parsed;
}
