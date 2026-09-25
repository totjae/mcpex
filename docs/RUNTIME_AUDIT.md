# JavaScript / TypeScript 런타임 정적 검수

후속 구현은 [런타임 개선 작업 인계](RUNTIME_REMEDIATION_PLAN.md)를 따른다. 이 링크 추가는 아래 발견 사항의 수정·검증 완료를 뜻하지 않는다.

검수일: 2026-09-25. 대상은 현재 작업 트리이며 커밋 이후의 기존 변경도 포함한다. 제품 코드 수정, 애플리케이션 실행, 빌드, 테스트, 모델 호출, 힙·CPU 측정은 수행하지 않았다. 아래 장애 영향·빈도·개선 효과는 **정적 분석에 따른 추정**이다. Confidence는 코드 근거의 확실성이며 장애 재현 여부를 뜻하지 않는다. 패치는 적용·검증하지 않은 핵심 변경 예시로, 오류 변환과 호출부 타입 수정 등을 함께 반영해야 한다.

## 1. 실행 환경과 범위

- 서버·CLI: Node.js >=24, ESM TypeScript, Windows DPAPI, Fastify, MCP SDK, node:sqlite DatabaseSync. 네트워크 요청과 동기 DB·프로세스 처리가 같은 서버 이벤트 루프를 사용한다.
- UI: 브라우저 React/Vite. Deno/Bun/Web Worker 실행 경로는 검토한 제품 소스에서 확인하지 못했다.
- 집중 검토: apps/server/src/{index,schema}.ts, packages/{runtime,providers,tools,storage}/src/index.ts, apps/cli/src/{index,service-lifecycle,tool-bridge}.ts, apps/web/src/{main.tsx,run-tracker.ts}. README, 아키텍처, 기존 검토·검증 기록을 대조했다. 테스트 파일은 일부 관련 시나리오만 읽었다. 외부 SDK 내부 전체, 테스트/평가 산출물 전체는 감사 범위가 아니다.
- 이미 존재하는 방어: 큐 대기 수·동시 실행 상한, 실행/공급자 timeout 신호, 파일 읽기·쓰기 1 MiB, 도구 출력 64 KiB, 검색 200건·목록 2,000건, 입력 256 KiB·최종 출력 128 KiB 제한. 브라우저 실행 추적에는 AbortController·세대 번호·unmount 정리가 있다. 따라서 모든 배열·Map·JSON 사용을 일괄 문제로 판단하지 않았다.

## 2. 발견 사항

### RTA-01 — 전역 Ajv에 새 스키마 객체가 계속 쌓임

- **Severity:** High
- **Location:** apps/server/src/schema.ts:40,118,134 — 전역 ajv, validateUserSchema, compile. 새 객체 유입 예: apps/server/src/index.ts:3316.
- **Category:** Memory Leak / Retained Reference / CPU Hotspot
- **Issue:** 동일 내용의 에이전트 스키마도 JSON.parse로 새 객체가 되면 전역 Ajv에 별도 컴파일 결과로 보관될 수 있다. 제거·캐시 상한이 없다.
- **Technical Cause:** 전역 Ajv → 내부 Map → 스키마와 생성 검증 함수가 유지된다. validateUserSchema와 compile이 모두 직접 ajv.compile을 호출한다. 같은 객체의 두 호출은 캐시를 공유하므로 매번 두 번 컴파일한다고 계산해서는 안 된다. 문제는 요청 사이의 객체 재생성이다. 객체 동일성 캐시와 재컴파일 동작은 [Ajv 공식 가이드](https://ajv.js.org/guide/managing-schemas.html), 제거 API는 [공식 API](https://ajv.js.org/api.html#ajv-removeschema-schemaorref-object-string-regexp-ajv)로 확인했다. 로컬 의존성 구현 파일은 확인하지 못했다.
- **Potential Runtime Impact:** 장시간 사용 시 힙·생성 코드 증가, GC 압박, 최악의 경우 OOM. 새 객체마다 동기 컴파일 비용도 발생한다.
- **Estimated Frequency:** Under Load — 시험 실행·설정 검증 등의 반복.
- **Confidence:** High
- **Recommended Fix:** 두 컴파일 진입점을 하나로 모아 내용 기반의 크기 제한 캐시를 사용하고 Ajv 내부 객체 캐시도 해제한다. 프로젝트의 스키마 크기 제한은 유지한다.
- **Patch Example:** 아래 helper를 두 호출부에서 공통 사용한다. 기존 SchemaContractError 변환은 유지한다.

```ts
const validators = new Map<string, ValidateFunction>();
function compiled(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } finally {
    ajv.removeSchema(schema);
  }
  if (validators.size >= 128) validators.delete(validators.keys().next().value!);
  validators.set(key, validate);
  return validate;
}
```

- **Estimated Improvement:** 보관량이 재생성 객체 수 N에 따른 O(N)에서 최대 128개 검증기로 제한된다. 동일 직렬화 스키마는 재컴파일을 피한다. 128은 예시 정책이며 실제 바이트 예산도 고려해야 한다. 감소 MB·처리량은 미측정.

### RTA-02 — 요청 경로에서 timeout 없는 동기 PowerShell 실행

- **Severity:** High
- **Location:** packages/storage/src/index.ts:873–898 — DpapiSecretStore.transform/get; apps/server/src/index.ts:3230–3231 — submitAgent.
- **Category:** Event Loop Blocking / Runtime Stability
- **Issue:** 인증값을 사용하는 실행마다 spawnSync로 PowerShell 복호화를 기다려 서버 전체 이벤트 루프를 막는다.
- **Technical Cause:** async submitAgent 내부라도 secrets.get 자체는 동기식이다. 자식 프로세스 대기 timeout도 없고 큐 등록·실행 deadline 설정 전에 수행된다. CPU 알고리즘 복잡도보다 외부 프로세스 대기시간이 지배한다.
- **Potential Runtime Impact:** 다른 실행의 응답·SSE·health·취소 timer가 지연된다. PowerShell이 멈추면 서버 전체가 장시간 응답하지 않을 수 있다. 소요 시간과 영구 정지 여부는 추정이다.
- **Estimated Frequency:** Always — 인증값 복호화 경로에서 블로킹 발생. 긴 Freeze는 Rare.
- **Confidence:** High
- **Recommended Fix:** 비동기 execFile/spawn에 timeout·출력 상한을 지정하고 SecretStore 및 호출부를 await 기반으로 변경한다. stdin으로 비밀값을 전달하는 현재 원칙은 유지한다.
- **Patch Example:** transform의 프로세스 처리 핵심 예시.

```ts
const result = await new Promise<string>((resolve, reject) => {
  const child = execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
      encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  child.stdin?.on('error', reject);
  child.stdin?.end(input);
});
```

- **Estimated Improvement:** 복호화 동안 메인 이벤트 루프의 동기 대기를 제거한다. 복호화 자체의 실행시간 단축은 보장하지 않는다. 비동기화 시 set/delete의 읽기-수정-쓰기 경합은 직렬화 또는 원자적 저장으로 별도 보호해야 한다.

### RTA-03 — 취소 후 같은 응답의 후속 도구가 계속 실행됨

- **Severity:** High
- **Location:** packages/runtime/src/index.ts:339–365 — runToolLoop; packages/tools/src/index.ts:465,499 — runCommand; apps/server/src/index.ts:3215,3257 — submitAgent.
- **Category:** Async Safety / Cancellation / Resource Lifecycle
- **Issue:** 취소 검사는 모델 턴 시작에만 있다. 한 응답이 여러 도구를 반환하면 첫 도구 대기 중 취소돼도 다음 write_file/write_target 등이 실행될 수 있다. bindTargets를 기다리는 동안 발생한 호출자 취소도 listener 등록 전에 지나갈 수 있다.
- **Technical Cause:** 내부 도구 루프의 신호 검사 누락, 모든 도구 예외를 일반 결과로 변환, 파일 도구로 신호 미전달. runCommand는 이미 aborted인 신호를 검사하지 않고 이벤트만 등록한다. Queue의 timeout은 협력적 abort여서 작업을 강제로 끝내지 않는다.
- **Potential Runtime Impact:** 취소·시간 초과 후 파일 변경/명령 시작, 추가 I/O, 큐 슬롯·workspace lock 유지. 진행 중 I/O를 안전하게 중단할 수 없는 경우 종료가 늦어질 수 있다.
- **Estimated Frequency:** Under Load — 여러 도구가 묶인 응답의 실행 도중 취소·deadline.
- **Confidence:** High
- **Recommended Fix:** 모델 응답 후·각 도구 직전·도구 오류 처리 시 신호를 확인한다. 파일 도구에 신호를 전달하고 긴 검색 루프와 쓰기 commit 전 확인한다. 호출자 신호를 연결할 때 기존 aborted 상태도 전달한다. 이미 시작한 파일 변경을 자동 롤백할 수 있다고 가정하지 않는다.
- **Patch Example:**

```ts
// submitAgent: listener 연결 직후
if (callerSignal?.aborted) cancelFromCaller();

// runToolLoop: generate 다음과 각 execute 직전에 검사
options.signal?.throwIfAborted();
for (const call of result.toolCalls) {
  options.signal?.throwIfAborted();
  // 기존 호출 한도 검사 유지
  try {
    output = await options.execute(call, options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    // 취소가 아닌 도구 오류만 기존 JSON 결과로 변환
  }
}
// runCommand: await safePath 다음, spawn 직전에도 검사
signal?.throwIfAborted();
```

- **Estimated Improvement:** 취소 후 아직 시작하지 않은 도구 호출을 차단한다. 파일 I/O의 협력적 확인 지점까지는 지연이 남는다. Promise.race로 결과만 먼저 종료하고 lock을 풀면 기존 작업과 새 작업이 겹치므로 그렇게 수정하면 안 된다.

### RTA-04 — 명령 종료 보조 프로세스 오류 및 abort listener 미정리

- **Severity:** High
- **Location:** packages/tools/src/index.ts:474–513 — WorkspaceTools.runCommand/terminate.
- **Category:** Crash / Error Handling / Retained Reference / Resource Lifecycle
- **Issue:** Windows taskkill 자식에는 error 처리·종료 결과 확인이 없다. 명령 정상 종료 후 abort listener도 남는다.
- **Technical Cause:** spawn('taskkill', ...) 반환값을 버린다. 실행 파일 누락·실행 거부 시 처리되지 않은 ChildProcess error가 발생할 수 있다. signal → terminate → child 연결은 명령 종료 시 끊지 않는다. 나중에 실행 신호가 abort되면 종료된 PID에 다시 taskkill을 요청한다.
- **Potential Runtime Impact:** 종료 보조 프로세스 spawn 실패 시 서비스 Crash 가능성. taskkill 실패 시 명령과 큐 슬롯이 계속 남을 수 있다. 완료 child와 출력 closure는 해당 실행의 신호 수명 동안 보관된다. PID 재사용 시 다른 프로세스 종료 가능성은 Rare 추정이며 실제 재현하지 않았다. 기본 도구 횟수 제한 때문에 이 listener 보관을 무한 전역 누수라고 부르지는 않는다.
- **Estimated Frequency:** Rare — 종료 실패/오래 실행되는 작업의 뒤늦은 취소. listener 잔존 자체는 명령 정상 종료마다 발생.
- **Confidence:** High
- **Recommended Fix:** 단일 종료 상태를 유지하고 close/error에서 timer와 abort listener를 해제한다. taskkill의 error·exit·timeout을 처리하고 종료 성공을 확인한다. 종료 실패 상태를 노출하되 실제 작업이 살아 있는 동안 workspace lock을 풀지 않는다.
- **Patch Example:** 기존 close/error 콜백과 terminate에 통합할 핵심이다.

```ts
let finished = false;
const cleanup = () => {
  finished = true;
  clearTimeout(timer);
  signal?.removeEventListener('abort', terminate);
};
// terminate 첫 줄: if (finished) return;
const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
  env: environment, shell: false, windowsHide: true, stdio: 'ignore',
});
killer.once('error', error => {
  // 서비스 오류로 기록하고 child.kill() 등 제한된 복구를 시도한다.
  // 미처리 error로 프로세스가 종료되지 않도록 반드시 수신한다.
});
// child의 close/error: cleanup()을 호출한 뒤 기존 resolve/reject
```

- **Estimated Improvement:** 미처리 종료 보조 프로세스 오류 경로를 차단하고, 완료 명령마다 남던 listener를 제거한다. 이 발췌만으로 종료 실패 복구 전체가 완성되지는 않는다.

### RTA-05 — 공급자 응답 전체를 크기 제한 없이 메모리에 적재

- **Severity:** High
- **Location:** packages/providers/src/index.ts:277,342,434,581,775 — generate/listModels 응답 읽기.
- **Category:** Memory Pressure / OOM / CPU Hotspot
- **Issue:** 성공·오류 HTTP body 모두 response.text()로 전체 적재 후 JSON.parse한다. 최종 출력 128 KiB 검사는 이 단계보다 늦다.
- **Technical Cause:** timeout은 수신 바이트 상한이 아니다. 도구 인자와 중간 assistant 응답은 최종 출력 제한으로 차단되지 않는다. raw 문자열·파싱 결과·도구 인자 파싱 및 후속 직렬화가 겹칠 수 있다. B바이트 응답 읽기·파싱 비용은 O(B), peak memory도 O(B)이며 동시 응답 수에 따라 증가한다.
- **Potential Runtime Impact:** 비정상 공급자/프록시의 큰 응답으로 peak heap 증가, 동기 JSON 파싱에 따른 timer 지연, OOM 가능성. 정상 소형 응답에서도 반드시 OOM이 난다는 뜻은 아니다.
- **Estimated Frequency:** Under Load
- **Confidence:** High
- **Recommended Fix:** 모든 어댑터의 성공·오류 body에 공통 실제 수신 바이트 상한을 적용한다. Content-Length만 신뢰하지 않는다. 중간 메시지/도구 인자의 누적 예산도 별도로 둔다.
- **Patch Example:** Node.js에서 사용할 제한 읽기 helper의 핵심. 2 MiB는 확정 사양이 아닌 예시다.

```ts
async function boundedText(response: Response, max = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new ProviderError(502, '공급자 응답 크기 초과');
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
```

- **Estimated Improvement:** 적재량이 전체 응답 B에 종속되던 상태에서 설정 예산과 최대 수신 chunk 범위로 제한된다. 여전히 제한 범위 안의 복사·JSON 파싱 비용이 있으며 완전한 JSON streaming parser는 아니다.

### RTA-06 — 목록 결과 제한 전에 디렉터리 전체를 읽음

- **Severity:** Medium
- **Location:** packages/tools/src/index.ts:229–257 — listFiles.walk.
- **Category:** Memory Pressure / Resource Lifecycle
- **Issue:** 결과를 2,000개·64 KiB로 제한하지만 fs.readdir는 먼저 해당 폴더의 모든 Dirent를 배열로 만든다.
- **Technical Cause:** 한 디렉터리의 항목 수 D에 대해 O(D) 메모리를 할당한 후 루프 안에서 제한을 검사한다. 재귀 중에는 상위 디렉터리 배열도 남는다. 출력 상한과 탐색 메모리 상한은 다르다.
- **Potential Runtime Impact:** 매우 큰 폴더를 탐색할 때 peak memory·GC 압박. OOM은 폴더 크기와 가용 메모리에 따른 추정이다.
- **Estimated Frequency:** Under Load
- **Confidence:** High
- **Recommended Fix:** fs.opendir 비동기 iterator로 필요한 수만 읽고, 취소·총 탐색 수·깊이 상한을 함께 적용한다.
- **Patch Example:**

```ts
const directory = await fs.opendir(dir);
for await (const entry of directory) {
  signal?.throwIfAborted(); // 메서드와 walk에 signal 전달 필요
  if (items.length >= this.limits.maxListResults || truncated) break;
  // 기존 제외 경로, 바이트 제한, 재귀 처리 유지
}
```

- **Estimated Improvement:** 디렉터리 열거 메모리가 O(D) 배열에서 iterator 버퍼와 재귀 깊이에 비례하는 수준으로 줄어든다. 모든 항목을 실제 검색해야 하는 경우 시간 복잡도는 여전히 O(D).

### RTA-07 — SSE timer 콜백의 예외가 요청 오류 경계를 벗어남

- **Severity:** High
- **Location:** apps/server/src/index.ts:3407–3428 — /runs/:id/events의 pump.
- **Category:** Crash / Error Handling / Backpressure
- **Issue:** timer에서 호출하는 pump 안의 동기 DB 조회·JSON.parse·write에 예외 경계가 없다. write 반환값도 무시한다.
- **Technical Cause:** 첫 pump 호출과 달리 이후 setTimeout 콜백은 Fastify의 async route Promise 밖에서 실행된다. DB I/O 오류 또는 손상된 payload 등으로 throw하면 미처리 예외가 된다. 읽기가 느린 클라이언트에서는 write(false)에도 계속 전송 버퍼를 채운다.
- **Potential Runtime Impact:** 드문 저장소 장애가 전체 서버 Crash로 확대될 수 있다. SSE 연결 C개는 매초 약 20C번 pump, 각 pump에서 적어도 두 번의 동기 DB 조회를 수행한다. 느린 다중 연결의 버퍼 누적 규모는 미측정.
- **Estimated Frequency:** Rare — 예외로 인한 Crash. 다중 연결 부하는 Under Load.
- **Confidence:** High
- **Recommended Fix:** timer 콜백에 catch를 두어 해당 스트림만 종료한다. response close에서 정리하고, write(false)면 drain까지 중지한다. 이벤트 조회도 배치 상한을 둔다.
- **Patch Example:** 예외 격리와 수명 정리의 최소 예시이며 backpressure는 추가 반영해야 한다.

```ts
const pump = () => {
  if (closed) return;
  try {
    // 기존 조회/전송. write(false)에서는 다음 전송을 drain 이후 재개.
    // 정상 실행일 때만 다음 timer 예약.
  } catch {
    stop();
    reply.raw.destroy();
  }
};
reply.raw.once('close', stop);
```

- **Estimated Improvement:** 해당 콜백에서 발생한 동기 오류를 한 연결로 격리한다. drain 처리와 배치 상한까지 반영하면 느린 연결의 버퍼 증가를 제한한다. 연결 수에 따른 polling 비용은 별도 남는다.

### RTA-08 — 만료 기록 정리를 한 번의 동기 대량 작업으로 수행

- **Severity:** Medium
- **Location:** packages/storage/src/index.ts:733–753 — purgeExpiredRunContent; apps/server/src/index.ts:1557,1808 — 시작 및 설정 저장 호출.
- **Category:** Event Loop Blocking / Memory Pressure / Long-running Stability
- **Issue:** 만료 ID 전체를 .all()로 적재한 뒤 단일 동기 트랜잭션에서 모두 삭제·갱신한다. 정리 호출은 시작·설정 저장에 있으며 주기적 정리는 확인되지 않았다.
- **Technical Cause:** 만료 실행 N건에 O(N) ID 메모리, 이벤트 E건까지 포함한 O(N+E) 수준의 처리량과 DB I/O 비용. 장시간 재시작·설정 저장이 없으면 만료 본문도 계속 남아 다음 정리 규모가 커질 수 있다. SQLite 인덱스·디스크 상태에 따른 실제 시간은 미측정이다.
- **Potential Runtime Impact:** 기록이 많은 상태에서 설정 저장 또는 시작이 지연되고, 서버가 요청·취소·timer를 처리하지 못할 수 있다. 디스크 누적 위험도 있다. 보존 정책상 남겨두는 실행 메타데이터 자체를 누수로 판정하지는 않는다.
- **Estimated Frequency:** Under Load
- **Confidence:** High
- **Recommended Fix:** SELECT LIMIT 및 배치별 트랜잭션으로 정리하고 배치 사이 이벤트 루프에 양보한다. 필요하면 만료 본문을 정기 정리하되 겹친 실행과 서비스 종료를 제어한다.
- **Patch Example:** purgeExpiredRunContentBatch는 LIMIT과 배치 트랜잭션으로 구현해야 하는 새 helper다.

```ts
import { setImmediate as yieldToLoop } from 'node:timers/promises';
for (;;) {
  const removed = storage.purgeExpiredRunContentBatch(cutoff, 100);
  if (removed.runs < 100) break;
  await yieldToLoop();
}
```

- **Estimated Improvement:** ID peak memory를 배치 크기로 제한하고 일괄 정리 도중 다른 요청을 처리할 기회를 준다. 단일 실행의 이벤트가 매우 크다면 이벤트 삭제도 나누거나 전용 DB worker를 검토해야 한다. queueMicrotask 반복은 I/O에 양보하지 않아 대안으로 권하지 않는다.

### RTA-09 — 만료·대체된 브라우저 세션이 Map에 잔존

- **Severity:** Low
- **Location:** apps/server/src/index.ts:1571,1602–1604,1645–1646 — sessions 및 auth/exchange.
- **Category:** Memory Leak / Singleton Retained Reference
- **Issue:** 새 세션마다 Map에 추가하지만 만료 세션 삭제는 그 세션으로 API 요청이 다시 올 때만 수행한다.
- **Technical Cause:** 브라우저를 닫거나 새 쿠키로 대체하면 이전 세션 키는 다시 요청되지 않는다. 서버 closure가 Map을 서비스 수명 동안 유지하며 TTL은 인증 판정에만 사용된다.
- **Potential Runtime Impact:** 로그인/설정 화면 재개설 누적 횟수에 비례한 작은 상주 메모리 증가. 개별 항목이 작고 인증된 bootstrap이 필요하므로 일반 로컬 사용에서 OOM의 주요 원인으로 보지는 않는다.
- **Estimated Frequency:** Under Load — 장기간 세션 반복 생성.
- **Confidence:** High
- **Recommended Fix:** 새 세션 생성 시 만료 세션을 청소하고 기존 쿠키 세션을 제거한다. 활성 세션 개수 제한은 제품 정책을 정한 뒤 추가한다.
- **Patch Example:**

```ts
const timestamp = Date.now();
for (const [id, expires] of sessions)
  if (expires <= timestamp) sessions.delete(id);
const previous = req.cookies.mcpex_session;
if (previous) sessions.delete(previous);
sessions.set(session, timestamp + SESSION_TTL_MS);
```

- **Estimated Improvement:** 생성 횟수 O(N)에 따른 무기한 보관을 TTL 내 세션 중심으로 줄인다. 이 예시는 마지막 생성 이후 남은 만료 항목의 즉시 청소나 TTL 내 생성 폭주까지 보장하지 않는다.

## 3. 우선순위와 최종 요약

**발견: 9건 — Critical 0 / High 6 / Medium 2 / Low 1.** Critical은 일반적인 사용만으로 즉각적·광범위 장애가 불가피한 수준으로 적용했다. High는 조건부 OOM·Crash·전체 서버 지연·취소 후 변경 위험을 포함한다. Critical 0은 운영 안전성 인증이 아니다.

| 필수 지표 | 정적 평가 | 해석 |
| --- | --- | --- |
| 1. 치명적 문제 개수 | Critical 0건 | High는 별도 6건 |
| 2. 메모리 누수 위험도 | 7/10 | Ajv 전역 캐시를 주된 근거로 평가 |
| 3. CPU 병목 위험도 | 6/10 | 반복 컴파일·큰 JSON·동기 DB; 동기 프로세스 대기는 CPU와 구별 |
| 4. 장시간 실행 안정성 | 4/10 | 이 항목만 높을수록 안정적 |
| 5. 예상 장애 발생 가능성 | 6/10 | 확률 60%가 아닌 정성 위험 점수 |

6. **우선 수정 TOP5**

1. RTA-01: Ajv 캐시 상한 및 객체 재생성에 따른 반복 컴파일 방지.
2. RTA-03: 취소 전달 누락과 후속 파일/명령 실행 차단.
3. RTA-02: 요청 경로 DPAPI 비동기화와 timeout.
4. RTA-04: 명령 종료 보조 프로세스 오류 처리·listener 정리.
5. RTA-05: 공급자 응답의 실제 수신 바이트 제한.

SSE를 운영에서 많이 사용한다면 RTA-07의 예외 격리도 같은 우선순위 묶음으로 처리한다. 실행 시간·메모리 감소 비율·장애 확률은 측정하지 않았으며 수치 개선을 보장하지 않는다.

## 4. 후속 검증 — 모두 미수행

- 동일 내용의 새 스키마 객체를 반복 검증하고 캐시 개수·힙 안정화 및 컴파일 횟수 확인.
- DPAPI 지연/실패 모의 상황에서 health와 취소 timer 응답성 확인.
- 복수 도구 응답의 첫 도구 실행 중 취소 및 bindTargets 중 취소 후 후속 파일 변경 0회 확인.
- 완료 명령 뒤 abort, 이미 aborted인 신호, taskkill spawn/종료 실패를 모의하고 child·listener·lock 상태 확인.
- Content-Length 누락/거짓 값·큰 오류 body·압축 해제 후 큰 응답에서 수신 제한 확인.
- 큰 디렉터리 탐색 중 중단과 디렉터리 handle 정리 확인.
- SSE timer 단계 DB 예외·느린 reader·연결 종료에서 프로세스 생존과 정리 확인.
- 대량 만료 기록 배치 처리 중 다른 API 응답과 정리 결과의 일관성 확인.
- 브라우저 세션 반복 생성과 만료 후 Map 크기 확인.

현재 상태는 **정적 검수 완료, 수정 미적용, 런타임 재현·성능 검증 미수행**이다. 기존 테스트 통과 이력을 이번 발견 사항의 검증 결과로 전용하지 않는다.
