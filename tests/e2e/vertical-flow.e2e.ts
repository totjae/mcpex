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
  await page.getByLabel('모델 ID').fill('mock-model');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.getByText('모델을 등록했습니다.')).toBeVisible();

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
  await page.getByRole('button', { name: '초안 저장' }).click();
  await expect(page.getByRole('status')).toContainText('초안을 저장했습니다.');
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
  await expect(alert).toContainText('현재 목록을 새로고침');
  await expect(page.locator('.notification-region')).toHaveCSS('position', 'fixed');
  await expect(page.getByLabel('에이전트 이름')).toHaveValue('충돌 입력 유지');

  await page.getByLabel('에이전트 이름').fill('두 번째 에이전트');
  await page.getByLabel('MCP 도구 이름').fill('second_agent');
  await page.getByLabel('템플릿', { exact: true }).selectOption({ label: '코드 구현' });
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '닫기' }).click();
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
  await page.getByRole('button', { name: '활성화' }).click();

  await page.getByRole('button', { name: /첫 번째 에이전트/ }).click();
  await page.getByLabel('시스템 프롬프트').fill('E2E에서 수정한 시스템 프롬프트');
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

  await page.getByLabel('시스템 프롬프트').fill('저장하지 않을 화면 편집');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('저장하지 않은 화면 편집');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '저장 전 편집 취소' }).click();
  await expect(page.getByLabel('시스템 프롬프트')).toHaveValue('E2E에서 수정한 시스템 프롬프트');
  await page.getByLabel('시스템 프롬프트').fill('폐기할 저장 초안');
  await page.getByRole('button', { name: '초안 저장' }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('현재 적용 버전으로 되돌리시겠습니까');
    await dialog.accept();
  });
  await page.getByRole('button', { name: '적용 버전으로 초안 복원' }).click();
  await expect(page.getByLabel('시스템 프롬프트')).toHaveValue('E2E에서 수정한 시스템 프롬프트');
  await expect(
    page.locator('.danger-zone').getByRole('button', { name: '에이전트 삭제' }),
  ).toBeDisabled();
  await expect(page.locator('.danger-guidance')).toContainText('비활성화');

  await page.getByRole('button', { name: 'MCP 연결 정보', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 연결 정보' })).toBeVisible();
  await expect(page.getByText('정상 응답')).toBeVisible();
  await expect(page.getByText('확인 필요')).toBeVisible();
  await expect(page.getByText(process.execPath)).toBeVisible();
  const argumentField = page.locator('.connection-field').filter({ hasText: '인수 배열' });
  await expect(argumentField).toContainText('apps');
  await expect(argumentField).toContainText('cli');
  await expect(argumentField).toContainText('index.js');
  await expect(argumentField).toContainText('mcp');
  await expect(page.getByText('first_agent', { exact: true })).toBeVisible();
  await expect(page.getByText('second_agent', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JSON 복사' }).click();
  await expect(page.getByRole('status')).toContainText('등록 JSON을(를) 복사했습니다.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"mcp"');
  await expect(page.getByText('인증 토큰과 모델 API 키가 포함되지 않습니다.')).toBeVisible();

  await page.getByRole('button', { name: '실행 기록', exact: true }).click();
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: '새로고침' }).click();
      return page.locator('.status.completed').count();
    })
    .toBeGreaterThan(0);
  await expect(page.getByText('첫 번째 에이전트').first()).toBeVisible();

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

  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  await page.getByLabel('이름').fill('삭제 대상 프로바이더');
  await page.getByLabel('기본 URL').fill('http://127.0.0.1:47932/v1');
  await page.getByRole('button', { name: '프로바이더 등록' }).click();
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.getByLabel('프로바이더').selectOption({ label: '삭제 대상 프로바이더' });
  await page.getByLabel('모델 ID').fill('delete-model');
  await page.getByRole('button', { name: '등록', exact: true }).click();

  await page.getByRole('button', { name: '프로바이더', exact: true }).click();
  const providerCard = page.locator('.cards article').filter({ hasText: '삭제 대상 프로바이더' });
  page.once('dialog', (dialog) => dialog.accept());
  await providerCard.getByRole('button', { name: '삭제 대상 프로바이더 프로바이더 삭제' }).click();
  await expect(page.getByRole('alert')).toContainText('등록 모델이 있는 프로바이더');
  await expect(page.getByRole('alert')).toContainText('모델을 먼저 삭제');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();

  await page.getByRole('button', { name: '모델', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'delete-model 모델 삭제' }).click();
  await expect(page.getByRole('button', { name: 'delete-model 모델 삭제' })).toHaveCount(0);
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
});
