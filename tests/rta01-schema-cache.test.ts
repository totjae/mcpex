import { describe, expect, it } from 'vitest';
import { schemaCacheStats, validateInput, validateUserSchema } from '../apps/server/src/schema.js';

describe('RTA-01 bounded schema cache', () => {
  it('reuses identical contents and bounds distinct and invalid schemas', () => {
    const baseline = schemaCacheStats();
    const schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    };
    validateInput(structuredClone(schema), { value: 'ok' });
    const compiled = schemaCacheStats().compilations;
    validateInput(structuredClone(schema), { value: 'again' });
    expect(schemaCacheStats().compilations).toBe(compiled);

    for (let index = 0; index < 100; index++)
      validateUserSchema({ type: 'object', title: `cache-${index}`, properties: {} });
    const bounded = schemaCacheStats();
    expect(bounded.entries).toBeLessThanOrEqual(64);
    expect(bounded.keyBytes).toBeLessThanOrEqual(512 * 1024);
    for (let index = 0; index < 20; index++)
      expect(() => validateUserSchema({ type: 'string', minLength: 'invalid' })).toThrow();
    expect(schemaCacheStats().entries).toBe(bounded.entries);
    expect(schemaCacheStats().compilations).toBeGreaterThan(baseline.compilations);
  });
});
