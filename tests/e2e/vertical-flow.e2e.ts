import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('registers a model, manages two agents, shows actionable errors, and records a run', async ({
  context,
  page,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:47931',
  });
  const statePath = resolve('.e2e-data/state.json');
  const { accessToken } = JSON.parse(readFileSync(statePath, 'utf8')) as {
    accessToken: string;
  };
  unlinkSync(statePath);
  const bootstrapResponse = await request.post('/auth/bootstrap', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(bootstrapResponse.ok()).toBe(true);
  const bootstrap = (await bootstrapResponse.json()) as { token: string };
  await page.goto(`/#token=${bootstrap.token}`);
  await expect(page.getByText('연결됨')).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);

  await page.getByLabel('이름').fill('E2E provider');
  await page.getByLabel('기본 URL').fill('http://127.0.0.1:47932/v1');
  await page.getByRole('button', { name: '프로바이더 등록' }).click();
  await expect(page.getByText('프로바이더를 등록했습니다.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('프로바이더를 등록했습니다.');
  await expect(page.locator('.notification-region')).toHaveCSS('position', 'fixed');
  await expect(page.getByText('E2E provider')).toBeVisible();

  await page.getByRole('button', { name: '모델', exact: true }).click();
  const createTier = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '모델 등록' }) })
    .getByLabel('기본 서비스 티어');
  await expect(createTier).toHaveValue('provider-default');
  await expect(createTier.locator('option[value="priority"]')).toHaveAttribute('disabled', '');
  await page.getByLabel('모델 ID').fill('mock-model');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.getByText('모델을 등록했습니다.')).toBeVisible();

  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  const primaryProviderCard = page.locator('.cards article').filter({ hasText: 'E2E provider' });
  await primaryProviderCard.getByRole('button', { name: 'E2E provider 프로바이더 편집' }).click();
  let providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('이름').fill('취소할 이름');
  page.once('dialog', (dialog) => dialog.accept());
  await providerEditor.getByRole('button', { name: '취소' }).click();
  await expect(primaryProviderCard.getByText('E2E provider', { exact: true })).toBeVisible();
  await primaryProviderCard.getByRole('button', { name: 'E2E provider 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('프로필').selectOption({ index: 1 });
  await expect(providerEditor.getByRole('note')).toContainText('프로필 변경 예정');
  page.once('dialog', (dialog) => dialog.accept());
  await providerEditor.getByRole('button', { name: '취소' }).click();
  await primaryProviderCard.getByRole('button', { name: 'E2E provider 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('이름').fill('Renamed provider');
  await providerEditor.getByLabel('모델 요청당 제한 (초)').fill('95');
  await providerEditor.getByLabel('최대 동시 실행').fill('1');
  await providerEditor.getByLabel('리소스 그룹', { exact: true }).fill('e2e-group');
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(page.getByText('프로바이더 편집을 저장했습니다.')).toBeVisible();
  await expect(
    page.locator('.cards article').filter({ hasText: 'Renamed provider' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.cards article').filter({ hasText: 'Renamed provider' }),
  ).toContainText('모델 요청당 제한 95초');
  await page
    .locator('.cards article')
    .filter({ hasText: 'Renamed provider' })
    .getByRole('button', { name: 'Renamed provider 프로바이더 편집' })
    .click();
  await page.route('**/api/v1/providers/*/discover-models', (route) =>
    route.fulfill({ json: { modelIds: ['mock-model'] } }),
  );
  await page
    .locator('.provider-editor')
    .getByRole('button', { name: '저장된 연결로 모델 조회' })
    .click();
  await expect(page.locator('.provider-editor').getByRole('status')).toContainText('모델 1개');
  await page.unroute('**/api/v1/providers/*/discover-models');
  await page.locator('.provider-editor').getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: '모델', exact: true }).click();

  const probeForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '응답 시험' }) });
  await probeForm
    .getByRole('combobox', { name: '모델', exact: true })
    .selectOption({ label: 'mock-model (Renamed provider)' });
  let finishProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  await page.route('**/api/v1/models/*/probes', async (route) => {
    await probeGate;
    await route.fulfill({ json: { result: { text: '시험 응답 완료' } } });
  });
  await probeForm.getByRole('button', { name: '시험', exact: true }).click();
  await expect(probeForm.getByRole('button', { name: '응답 대기 중…' })).toBeDisabled();
  await expect(probeForm.getByRole('status')).toContainText('모델 응답을 기다리고 있습니다');
  finishProbe();
  await expect(probeForm.locator('pre')).toContainText('시험 응답 완료');
  await expect(probeForm.locator('pre')).toContainText('실제: 확인 불가');
  await page.unroute('**/api/v1/models/*/probes');
  await page.route('**/api/v1/models/*/probes', (route) =>
    route.fulfill({
      status: 504,
      json: {
        error: { code: 'PROVIDER_TIMEOUT', message: '공급업체 요청 시간이 초과되었습니다.' },
      },
    }),
  );
  await probeForm.getByRole('button', { name: '시험', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('PROVIDER_TIMEOUT');
  await expect(probeForm.getByRole('button', { name: '시험', exact: true })).toBeEnabled();
  await expect(probeForm.locator('pre')).toHaveCount(0);
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();
  await page.unroute('**/api/v1/models/*/probes');

  await page.getByRole('button', { name: '에이전트', exact: true }).click();
  await page.getByLabel('에이전트 이름').fill('첫 번째 에이전트');
  await page.getByLabel('MCP 도구 이름').fill('first_agent');
  await page.getByLabel('템플릿', { exact: true }).selectOption({ label: '일반 응답' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await expect(page.getByText('에이전트 초안을 생성했습니다.')).toBeVisible();
  const taskInput = page.locator('.test-field-grid textarea').first();
  await expect(page.getByRole('button', { name: '입력 폼' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await taskInput.fill('');
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.input-summary-error')).toContainText('/task 필수 입력입니다.');
  await expect(taskInput).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();

  await taskInput.fill('JSON 없이 입력한 시험 문장');
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.editor pre')).toContainText('JSON 없이 입력한 시험 문장');
  await page.getByRole('button', { name: '고급 JSON' }).click();
  const advancedInput = page.getByLabel('시험 입력 JSON (고급)');
  await advancedInput.fill('[]');
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.input-summary-error')).toContainText('최상위 값은 JSON 객체');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();
  await advancedInput.fill('{"task":"고급 모드에서 유지할 입력"}');
  await page.getByRole('button', { name: '입력 폼' }).click();
  await expect(taskInput).toHaveValue('고급 모드에서 유지할 입력');

  await page.getByLabel('입력 JSON Schema').fill(
    JSON.stringify({
      type: 'object',
      properties: {
        task: { type: 'string', description: '모델에 전달할 요청' },
        count: { type: 'integer', default: 2 },
        enabled: { type: 'boolean' },
        tone: { type: 'string', enum: ['brief', 'detailed'] },
      },
      required: ['task', 'count'],
      additionalProperties: false,
    }),
  );
  await page.getByLabel('시간 제한 방식').selectOption('split');
  await page.getByLabel('대기 제한 (초)').fill('45');
  await page.getByLabel('실행 제한 (초)').fill('180');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('초안을 저장했습니다.');
  await expect(page.getByLabel('대기 제한 (초)')).toHaveValue('45');
  await expect(page.getByLabel('실행 제한 (초)')).toHaveValue('180');
  const customFields = page.locator('.test-field-grid');
  const customTask = customFields.locator('label').filter({ hasText: 'task' }).locator('textarea');
  const customCount = customFields.locator('label').filter({ hasText: 'count' }).locator('input');
  const customEnabled = customFields
    .locator('label')
    .filter({ hasText: 'enabled' })
    .locator('input');
  const customTone = customFields.locator('label').filter({ hasText: 'tone' }).locator('select');
  await customTask.fill('사용자 스키마 입력');
  await customCount.fill('3');
  await customEnabled.check();
  await customTone.selectOption({ label: 'detailed' });
  await expect(customTask).toHaveValue('사용자 스키마 입력');
  await expect(customCount).toHaveValue('3');
  await expect(customEnabled).toBeChecked();
  await expect(customTone).toHaveValue(JSON.stringify('detailed'));
  await page.getByRole('button', { name: '고급 JSON' }).click();
  await expect(advancedInput).toContainText('사용자 스키마 입력');
  await expect(advancedInput).toContainText('"count": 3');
  await page.getByRole('button', { name: '입력 폼' }).click();
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.editor pre')).toContainText('사용자 스키마 입력');
  await page.getByRole('button', { name: '적용 버전 생성' }).click();
  await expect(page.getByText('새 적용 버전을 만들었습니다.')).toBeVisible();
  await page.getByRole('button', { name: '활성화' }).click();
  await expect(page.getByText('활성화했습니다.')).toBeVisible();
  await page
    .locator('.test-field-grid label')
    .filter({ hasText: 'task' })
    .locator('textarea')
    .fill('느린 첫 실행');
  await page.getByRole('button', { name: '시험 실행' }).click();
  const testRunPanel = page.locator('.test-run-panel');
  await expect(testRunPanel).toContainText(/대기 중|실행 중/);
  await expect(testRunPanel.getByRole('button', { name: '실행 취소' })).toBeVisible();
  await page
    .locator('.test-field-grid label')
    .filter({ hasText: 'task' })
    .locator('textarea')
    .fill('빠른 두 번째 실행');
  await page.getByRole('button', { name: '시험 실행' }).click();
  await expect(testRunPanel).toContainText('완료');
  await expect(testRunPanel.locator('.result-answer')).toContainText('빠른 두 번째 실행');
  await expect(testRunPanel.locator('.result-answer')).not.toContainText('느린 첫 실행');
  await expect(testRunPanel.getByText('과제 검증: 미검증')).toBeVisible();
  await expect(testRunPanel.getByText('원시 실행 상세')).toBeVisible();

  let failNextRunLookup = true;
  await page.route('**/api/v1/runs/*', async (route) => {
    if (route.request().method() === 'GET' && failNextRunLookup) {
      failNextRunLookup = false;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page
    .locator('.test-field-grid label')
    .filter({ hasText: 'task' })
    .locator('textarea')
    .fill('재조회 실행');
  await page.getByRole('button', { name: '시험 실행' }).click();
  await expect(testRunPanel.getByRole('button', { name: '다시 조회' })).toBeVisible();
  await page.unroute('**/api/v1/runs/*');
  await testRunPanel.getByRole('button', { name: '다시 조회' }).click();
  await expect(testRunPanel).toContainText('완료');
  await expect(testRunPanel.locator('.result-answer')).toContainText('재조회 실행');

  await page.getByLabel('에이전트 이름').fill('충돌 입력 유지');
  await page.getByLabel('MCP 도구 이름').fill('first_agent');
  await page.getByRole('button', { name: '생성', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('CONFLICT');
  await expect(alert).toContainText('같은 도구 이름을 사용하는 미삭제 에이전트');
  await expect(page.locator('.notification-region')).toHaveCSS('position', 'fixed');
  await expect(page.getByLabel('에이전트 이름')).toHaveValue('충돌 입력 유지');

  await page.getByLabel('에이전트 이름').fill('두 번째 에이전트');
  await page.getByLabel('MCP 도구 이름').fill('second_agent');
  await page.getByLabel('템플릿', { exact: true }).selectOption({ label: '코드 구현' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await expect(page.locator('.effective-runtime')).toContainText('현재 초안의 실효 도구');
  await expect(page.locator('.effective-runtime')).toContainText('없음');
  await expect(page.locator('.effective-runtime')).toContainText('작업 폴더 정책이 ‘사용 안 함’');
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '닫기' }).click();
  await page.getByLabel('작업 폴더 정책').selectOption('full');
  await expect(page.locator('.effective-runtime')).toContainText('현재 OS 사용자 권한 범위');
  await expect(page.locator('.effective-runtime')).toContainText('파일 전송 범위');
  await expect(page.locator('.effective-runtime')).toContainText('클라우드 모델이면');
  await page.getByLabel('run_command').check();
  await expect(page.locator('.effective-runtime')).toContainText('명령 실행 권한');
  await expect(page.locator('.effective-runtime')).toContainText('OS sandbox가 아닙니다');
  await page.getByLabel('run_command').uncheck();
  await page.getByRole('button', { name: '초안 저장' }).click();
  const codeFields = page.locator('.test-field-grid');
  await codeFields
    .locator('label')
    .filter({ hasText: 'task' })
    .locator('textarea')
    .fill('파일 조사');
  await codeFields
    .locator('label')
    .filter({ hasText: 'workspace' })
    .locator('textarea')
    .fill('프로젝트 A');
  await expect(page.locator('.workspace-note')).toContainText('파일·명령 실행 권한');
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.editor pre')).toContainText('프로젝트 A');
  await page.getByRole('button', { name: '적용 버전 생성' }).click();
  await expect(page.getByText('새 적용 버전을 만들었습니다.')).toBeVisible();
  await page.getByRole('button', { name: '활성화' }).click();
  await expect(page.getByText('활성화했습니다.')).toBeVisible();

  await codeFields
    .locator('label')
    .filter({ hasText: 'task' })
    .locator('textarea')
    .fill('target-e2e');
  await page.getByRole('button', { name: '대상 추가' }).click();
  const targetInput = page.locator('.test-input-panel .test-field-grid').first();
  await targetInput.getByLabel('ID').fill('output');
  const targetOutputPath = resolve('.e2e-data/target-output.txt');
  await targetInput.getByLabel('경로').fill(targetOutputPath);
  await targetInput.getByLabel('접근').selectOption('write');
  await page.getByRole('button', { name: '메시지 미리보기' }).click();
  await expect(page.locator('.editor pre').last()).not.toContainText(targetOutputPath);
  await page.getByRole('button', { name: '시험 실행' }).click();
  await expect(page.locator('.test-run-panel')).toContainText('target-e2e 완료');
  await expect(page.locator('.test-run-panel')).toContainText('대상 파일 변경');
  await expect(page.locator('.test-run-panel')).toContainText('output — 파일 생성·수정 성공');
  expect(readFileSync(targetOutputPath, 'utf8')).toBe('target-e2e-created');

  const firstAgentButton = page.locator('.agent-layout aside button').filter({
    hasText: '첫 번째 에이전트',
  });
  await firstAgentButton.click();
  await expect(firstAgentButton).toHaveClass(/selected/);
  const systemPrompt = page.getByLabel('시스템 프롬프트');
  await expect(systemPrompt).toHaveValue('');
  await systemPrompt.fill('E2E에서 수정한 시스템 프롬프트');
  await page.getByRole('button', { name: '초안 저장' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '초안 저장' }).click();
  const savedStatus = page.getByRole('status');
  await expect(savedStatus).toContainText('초안을 저장했습니다.');
  const notificationBox = await savedStatus.boundingBox();
  const viewport = page.viewportSize();
  expect(notificationBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(notificationBox!.y).toBeGreaterThanOrEqual(0);
  expect(notificationBox!.y + notificationBox!.height).toBeLessThanOrEqual(viewport!.height);
  await page.getByRole('button', { name: '적용 버전 생성' }).click();
  await expect(page.getByText('새 적용 버전을 만들었습니다.')).toBeVisible();

  await systemPrompt.fill('저장하지 않을 화면 편집');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('저장하지 않은 화면 편집');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '저장 전 편집 취소' }).click();
  await expect(systemPrompt).toHaveValue('E2E에서 수정한 시스템 프롬프트');
  await systemPrompt.fill('폐기할 저장 초안');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('초안을 저장했습니다.');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('현재 적용 버전으로 되돌리시겠습니까');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '적용 버전으로 초안 복원' }).click();
  await expect(systemPrompt).toHaveValue('E2E에서 수정한 시스템 프롬프트');
  await expect(
    page.locator('.danger-zone').getByRole('button', { name: '에이전트 삭제' }),
  ).toBeDisabled();
  await expect(page.locator('.danger-guidance')).toContainText('비활성화');

  await page.getByRole('button', { name: 'MCP 연결 정보', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 연결 정보' })).toBeVisible();
  await expect(page.getByText('정상 응답')).toBeVisible();
  await expect(page.getByText('확인 필요')).toBeVisible();
  await expect(page.getByText(process.execPath)).toBeVisible();
  await expect(page.getByText('같은 PC의 Codex에 등록')).toBeVisible();
  await expect(page.getByText('1. 이름')).toBeVisible();
  await expect(page.getByText('2. 유형')).toBeVisible();
  await expect(page.getByText('STDIO', { exact: true })).toBeVisible();
  const argumentField = page.locator('.connection-field').filter({ hasText: '4. 인자' });
  await expect(argumentField).toContainText('apps');
  await expect(argumentField).toContainText('cli');
  await expect(argumentField).toContainText('index.js');
  await expect(argumentField).toContainText('mcp');
  await expect(page.getByText('first_agent', { exact: true })).toBeVisible();
  await expect(page.getByText('second_agent', { exact: true })).toBeVisible();
  await expect(page.getByText(/전체 접근: 현재 OS 사용자 권한 범위에서/)).toBeVisible();
  await expect(page.getByText(/클라우드 모델이면 PC 밖으로 전송됩니다/)).toBeVisible();
  await page.getByRole('button', { name: '인자 2 복사' }).click();
  await expect(page.getByRole('status')).toContainText('인자 2을(를) 복사했습니다.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('mcp');
  await page.getByRole('button', { name: '전체 설정 복사' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    '[mcp_servers.mcpex]',
  );
  await expect(page.getByText('다른 PC에서 연결: 현재 미지원')).toBeVisible();
  await expect(page.getByText('인증 토큰과 모델 API 키도 포함되지 않습니다.')).toBeVisible();

  await page.getByRole('button', { name: '실행 기록', exact: true }).click();
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: '새로고침' }).click();
      return page.locator('.status.completed').count();
    })
    .toBeGreaterThan(0);
  await expect(page.getByText('첫 번째 에이전트').first()).toBeVisible();
  const targetHistory = page
    .locator('.run-list details')
    .filter({ hasText: '두 번째 에이전트' })
    .first();
  await targetHistory.locator('summary').click();
  await expect(targetHistory).toContainText('output — 파일 생성·수정 성공');
  await page.getByRole('button', { name: '새로고침' }).click();
  await expect(
    page.locator('.run-list details').filter({ hasText: '두 번째 에이전트' }).first(),
  ).toContainText('output — 파일 생성·수정 성공');

  await page.getByRole('button', { name: '에이전트', exact: true }).click();
  await page.getByLabel('에이전트 이름').fill('삭제할 초안 에이전트');
  await page.getByLabel('MCP 도구 이름').fill('delete_draft_agent');
  await page.getByLabel('템플릿', { exact: true }).selectOption({ label: '일반 응답' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  const draftDeleteButton = page
    .locator('.danger-zone')
    .getByRole('button', { name: '에이전트 삭제' });
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('delete_draft_agent');
    await dialog.dismiss();
  });
  await draftDeleteButton.click();
  await expect(page.getByRole('button', { name: /삭제할 초안 에이전트/ })).toBeVisible();
  const agentDeleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && /\/api\/v1\/agents\//.test(response.url()),
  );
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await draftDeleteButton.click();
  expect((await agentDeleteResponse).status()).toBe(204);
  await expect(page.getByRole('button', { name: /삭제할 초안 에이전트/ })).toHaveCount(0);
  await page.getByLabel('에이전트 이름').fill('재생성한 초안 에이전트');
  await page.getByLabel('MCP 도구 이름').fill('delete_draft_agent');
  await page.getByLabel('템플릿', { exact: true }).selectOption({ label: '일반 응답' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await expect(page.getByRole('button', { name: /재생성한 초안 에이전트/ })).toBeVisible();

  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  await page.getByLabel('이름').fill('삭제 대상 프로바이더');
  await page.getByLabel('기본 URL').fill('http://127.0.0.1:47932/v1');
  await page.getByRole('button', { name: '프로바이더 등록' }).click();
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.getByLabel('프로바이더').selectOption({ label: '삭제 대상 프로바이더' });
  await page.getByLabel('모델 ID').fill('mock-model');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(
    page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '응답 시험' }) })
      .getByRole('option', { name: 'mock-model (Renamed provider)' }),
  ).toHaveCount(1);
  await expect(
    page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '응답 시험' }) })
      .getByRole('option', { name: 'mock-model (삭제 대상 프로바이더)' }),
  ).toHaveCount(1);

  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  const providerCard = page.locator('.cards article').filter({ hasText: '삭제 대상 프로바이더' });
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel(/API 키/).selectOption('replace');
  await providerEditor.getByLabel('새 API 키').fill('e2e-test-key');
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerCard.getByText('인증 저장됨')).toBeVisible();
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await expect(providerEditor.getByLabel(/API 키/)).toHaveValue('keep');
  await providerEditor.getByLabel('모델 요청당 제한 (초)').fill('97');
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerCard.getByText('인증 저장됨')).toBeVisible();
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel(/API 키/).selectOption('remove');
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerCard.getByText('인증 없음')).toBeVisible();

  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('이름').fill('충돌 후 보존할 입력');
  await page.route('**/api/v1/providers/*', async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({
        status: 409,
        json: { error: { code: 'CONFLICT', message: 'revision 충돌' } },
      });
    else await route.continue();
  });
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerEditor.getByRole('alert')).toContainText('CONFLICT');
  await expect(providerEditor.getByLabel('이름')).toHaveValue('충돌 후 보존할 입력');
  await page.unroute('**/api/v1/providers/*');
  await providerEditor.getByRole('button', { name: '최신 설정 확인' }).click();
  await expect(providerEditor.getByRole('status')).toContainText('삭제 대상 프로바이더');
  page.once('dialog', (dialog) => dialog.accept());
  await providerEditor.getByRole('button', { name: '취소' }).click();

  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('모델 요청당 제한 (초)').fill('96');
  await providerEditor.getByLabel(/API 키/).selectOption('replace');
  await providerEditor.getByLabel('새 API 키').fill('retry-test-key');
  await page.route('**/api/v1/providers/*/credential', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 503,
        json: { error: { code: 'KEY_UNAVAILABLE', message: '재시도 필요' } },
      });
    else await route.continue();
  });
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerEditor.getByRole('alert')).toContainText('설정은 저장됐지만 키 작업');
  await expect(providerCard).toContainText('모델 요청당 제한 96초');
  await page.unroute('**/api/v1/providers/*/credential');
  await providerEditor.getByRole('button', { name: '변경 저장' }).click();
  await expect(providerCard.getByText('인증 저장됨')).toBeVisible();
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 편집' }).click();
  providerEditor = page.locator('.provider-editor');
  await providerEditor.getByLabel('이름').fill('전환 전 입력');
  const firstEditButton = page
    .locator('.cards article')
    .filter({ hasText: 'Renamed provider' })
    .getByRole('button', { name: 'Renamed provider 프로바이더 편집' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await firstEditButton.click();
  await expect(providerEditor.getByLabel('이름')).toHaveValue('전환 전 입력');
  page.once('dialog', (dialog) => dialog.accept());
  await firstEditButton.click();
  await expect(page.locator('.provider-editor').getByLabel('이름')).toHaveValue('Renamed provider');
  await page.locator('.provider-editor').getByRole('button', { name: '취소' }).click();

  page.once('dialog', (dialog) => dialog.accept());
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 삭제' }).click();
  await expect(page.getByRole('alert')).toContainText('등록 모델이 있는 프로바이더');
  await expect(page.getByRole('alert')).toContainText('모델을 먼저 삭제');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();

  await page.getByRole('button', { name: '모델', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'mock-model (삭제 대상 프로바이더) 모델 삭제' }).click();
  await expect(
    page.getByRole('button', { name: 'mock-model (삭제 대상 프로바이더) 모델 삭제' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('저장된 인증값도 제거');
    await dialog.dismiss();
  });
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 삭제' }).click();
  await expect(providerCard).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 삭제' }).click();
  await expect(providerCard).toHaveCount(0);

  await page.getByLabel('이름').fill('Tier OpenAI');
  await page.getByRole('combobox', { name: '프로필' }).selectOption('openai');
  await page.getByRole('button', { name: '프로바이더 등록' }).click();
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.getByLabel('프로바이더').selectOption({ label: 'Tier OpenAI' });
  await page.getByLabel('모델 ID').fill('tier-ui-model');
  const tierCreateForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '모델 등록' }) });
  await tierCreateForm.getByLabel('기본 서비스 티어').selectOption('flex');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  const tierModelRow = page.locator('.model-list li').filter({ hasText: 'tier-ui-model' });
  await expect(tierModelRow.getByLabel('기본 서비스 티어')).toHaveValue('flex');
  await page.reload();
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.getByLabel('프로바이더').selectOption({ label: 'Tier OpenAI' });
  await expect(
    page
      .locator('.model-list li')
      .filter({ hasText: 'tier-ui-model' })
      .getByLabel('기본 서비스 티어'),
  ).toHaveValue('flex');
  await page.getByRole('button', { name: '에이전트', exact: true }).click();
  await page.getByLabel('에이전트 이름').fill('Tier UI agent');
  await page.getByLabel('MCP 도구 이름').fill('tier_ui_agent');
  await page
    .locator('.create-row')
    .getByLabel('모델')
    .selectOption({ label: 'tier-ui-model (Tier OpenAI)' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await page.getByLabel('에이전트 서비스 티어').selectOption('auto');
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('초안을 저장했습니다.');
  await page.reload();
  await page.getByRole('button', { name: '에이전트', exact: true }).click();
  await page.getByRole('button', { name: /Tier UI agent/ }).click();
  await expect(page.getByLabel('에이전트 서비스 티어')).toHaveValue('auto');
  await page.route('**/api/v1/safety-blocks', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'display-only',
            workspace: 'C:\\temporary\\work',
            createdAt: new Date().toISOString(),
            reason: 'TASKKILL_FAILED',
            processes: [{ pid: 123, started: '100' }],
          },
        ],
      }),
    }),
  );
  await page.reload();
  await expect(page.getByText('명령 종료 확인 실패·추가 실행 차단 중입니다.')).toBeVisible();
  await page.getByRole('button', { name: '설정 및 데이터' }).click();
  await expect(
    page.getByRole('heading', { name: '명령 종료 확인 실패·추가 실행 차단' }),
  ).toBeVisible();
  await expect(page.getByText('원인: Windows 프로세스 트리 종료 명령 실패')).toBeVisible();
});
