import { expect, it } from 'vitest';
import { modelDisplayName } from '../apps/web/src/model-display.js';

it('identifies models by provider name without repeating the API model ID', () => {
  const model = { providerId: 'one', modelId: 'same-model', label: 'same-model' };
  const providers = [
    { id: 'one', name: 'Local' },
    { id: 'two', name: 'Cloud' },
  ];
  expect(modelDisplayName(model, providers)).toBe('same-model (Local)');
  expect(modelDisplayName({ ...model, providerId: 'two', label: 'Friendly' }, providers)).toBe(
    'Friendly (Cloud)',
  );
  expect(modelDisplayName(model, [{ id: 'one', name: 'Renamed' }])).toBe('same-model (Renamed)');
  expect(modelDisplayName(model, [])).toBe('same-model (프로바이더 확인 필요)');
  expect(
    modelDisplayName(model, [
      { id: 'one', name: 'Duplicate' },
      { id: 'two', name: 'Duplicate' },
    ]),
  ).toBe('same-model (Duplicate · one)');
});
