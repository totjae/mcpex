import { describe, expect, it } from 'vitest';
import {
  formValuesToInput,
  parseAdvancedInput,
  reconcileFormValues,
  schemaExample,
  schemaFields,
  validateInput,
} from '../apps/web/src/schema-form.js';

const schema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: '질문' },
    count: { type: 'integer', default: 2 },
    enabled: { type: 'boolean' },
    tone: { type: 'string', enum: ['brief', 'detailed'] },
    metadata: { type: 'object', properties: { source: { type: 'string' } } },
  },
  required: ['prompt', 'count'],
  additionalProperties: false,
};

describe('schema-based test input form', () => {
  it('describes scalar fields and preserves compatible values', () => {
    const fields = schemaFields(schema);
    expect(fields.find((field) => field.name === 'prompt')).toMatchObject({
      required: true,
      supported: true,
      description: '질문',
    });
    expect(fields.find((field) => field.name === 'metadata')?.supported).toBe(false);
    expect(reconcileFormValues(schema, { prompt: '유지', count: 4, obsolete: '제거' })).toEqual({
      prompt: '유지',
      count: '4',
      enabled: false,
      tone: '',
    });
  });

  it('builds typed input and reports required and type errors by path', () => {
    const input = formValuesToInput(schema, {
      prompt: '테스트',
      count: '3',
      enabled: true,
      tone: JSON.stringify('brief'),
    });
    expect(input).toEqual({ prompt: '테스트', count: 3, enabled: true, tone: 'brief' });
    expect(validateInput(schema, input)).toEqual([]);
    expect(validateInput(schema, { prompt: 1 })).toEqual(
      expect.arrayContaining([
        { path: '/count', message: '필수 입력입니다.' },
        { path: '/prompt', message: 'string 타입이어야 합니다.' },
      ]),
    );
  });

  it('separates JSON syntax and top-level object errors', () => {
    expect(() => parseAdvancedInput('{')).toThrow(/JSON 구문 오류/);
    expect(() => parseAdvancedInput('[]')).toThrow(/최상위 값은 JSON 객체/);
    expect(parseAdvancedInput('{"prompt":"ok","count":1}')).toEqual({
      prompt: 'ok',
      count: 1,
    });
  });

  it('generates an advanced JSON example for nested fields', () => {
    expect(schemaExample(schema)).toEqual({
      prompt: '',
      count: 2,
      enabled: false,
      tone: 'brief',
      metadata: { source: '' },
    });
    expect(
      schemaExample(schema, {
        prompt: '기존 질문',
        count: '잘못된 타입',
        metadata: { source: '유지' },
        obsolete: '제거',
      }),
    ).toEqual({
      prompt: '기존 질문',
      count: 2,
      enabled: false,
      tone: 'brief',
      metadata: { source: '유지' },
    });
  });
});
