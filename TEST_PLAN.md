# 테스트 및 검증

## 2026-09-16 VBS 자동 시작 잠금 복구 검증

- 실제 실패를 터미널에서 재현해 `DATA_DIR_LOCKED` 뒤 자동 시작 20초 초과가 발생함을 확인했다. 기본 `service.lock`의 PID 14988은 잠금 기록 후 시작된 `msedgewebview2`에 재사용됐고 47831의 MCPex health 응답은 없었다.
- Windows PID 재사용 상황을 현재 살아 있는 테스트 PID와 과거 lock 수정 시각으로 모의했다. 새 잠금 관리자가 이를 stale로 복구하고 version 1의 PID·프로세스 시작 시각·실행 파일·소유 토큰 잠금을 만든 뒤, 두 번째 관리자는 실제 소유자를 `DATA_DIR_LOCKED`로 거부함을 확인했다.
- 기존 숫자 PID 잠금과 신규 JSON 잠금 호환, 존재하지 않는 PID 복구, 초기화 실패 후 소유 잠금 제거를 함께 확인했다. 자동 시작 의존성이 즉시 실패하면 polling timeout으로 진행하지 않고 오류를 전달하는 테스트도 추가했다.
- build/typecheck/lint 및 `npx vitest run --maxWorkers=2`: 19개 파일·56개 테스트 통과.
- 실제 기본 데이터에서 새 빌드의 `node apps/cli/dist/src/index.js open`이 오래된 잠금을 자동 복구하고 종료 코드 0으로 완료됐다. 이어 `cscript.exe //NoLogo "MCPex Settings.vbs"`도 종료 코드 0, `/health`는 service=mcpex/status=ok를 반환했다. 탐색기에서 사용자가 직접 더블클릭하는 동작은 별도 확인이 필요하다.

## 2026-09-15 실사용 개선 UX05 MCP 연결 정보 검증

- 신규 API 테스트에서 인증 없는 연결 정보 요청 거부, 공백 포함 Node·CLI 경로와 분리된 `mcp` 인수, 필요한 환경변수 반환을 확인했다. 응답에 token·credential이 포함되지 않는 것도 검사했다.
- 활성 도구의 이름·설명이 현재 초안이 아니라 정확한 적용 버전에서 계산되고, 미적용 에이전트가 별도 사유로 표시되는 것을 확인했다. 서비스 관리 API 정상과 실제 MCP 클라이언트 미확인 상태도 구분했다.
- Microsoft Edge Playwright 수직 흐름에서 **MCP 연결 정보** 탭, Node 실행 파일, CLI 인수, 활성 도구 2개, 서비스/클라이언트 상태와 비밀 제외 안내를 확인했다. 등록 JSON 복사 버튼과 실제 클립보드 값도 확인했다.
- build/typecheck/lint 통과. `npx vitest run --maxWorkers=2`로 19개 파일·55개 테스트 통과. Playwright 1개 시나리오도 통과했으며 기존 종료 정리 지연 때문에 테스트 전용 서버를 종료한 뒤 runner exit 0을 확인했다.
- 실제 사용자 MCP 클라이언트에서 등록·목록·호출·동적 갱신·재연결하는 T14는 미수행이다. 좁은 화면·키보드·스크린리더는 별도 수동 검증 범위다.

## 2026-09-15 실사용 개선 UX01 삭제·초안 정리 검증

- API 회귀 테스트에서 적용 후 저장한 초안을 정확한 `applied_version_id` 스냅샷으로 복원하고, stale `expectedRevision`은 409로 거부하며, 복원 후 초안 revision은 증가하는 것을 확인했다. 공개 버전 ID·활성 상태·표시 이름·도구 이름은 유지되고 적용 이력이 없는 에이전트의 복원 요청은 409로 거부된다.
- Microsoft Edge Playwright 수직 흐름에서 미저장 편집 취소와 적용 버전으로 저장 초안 복원, 활성 에이전트 삭제 제한 안내, 적용 전 에이전트 삭제의 확인 취소/확정을 확인했다.
- 같은 흐름에서 모델을 가진 프로바이더 삭제 실패와 선행 정리 안내, 모델 삭제 후 프로바이더 삭제, 각 확인 취소/확정 및 목록 갱신을 확인했다. 본문 없는 DELETE가 JSON Content-Type 때문에 400이 되던 공통 호출 문제도 수정 후 통과했다.
- build/typecheck/lint 통과. `npx vitest run --maxWorkers=2`로 18개 파일·54개 테스트 통과. Playwright 기능 시나리오는 통과했지만 기존 runner 종료 정리 지연으로 완료 출력 후 프로세스를 수동 종료했다.
- 실제 사용자 데이터에서 실행 기록 보존과 `toolName` 재사용 정책을 확인하는 수동 검증, 키보드만을 사용한 조작과 스크린리더 발화 순서는 남아 있다.

## 2026-09-15 실사용 개선 UX03 시험 결과 자동 추적 검증

- 실행 추적 순수 테스트 3개: queued→running→completed 상태 순서와 terminal 종료, 추적 취소 후 늦은 갱신 차단, completed/failed/cancelled/timed_out/interrupted 종료 판정을 확인했다.
- Microsoft Edge Playwright에서 지연된 모의 모델의 대기·실행 상태와 취소 버튼을 확인하고 완료 후 같은 편집 영역에 최종 답변과 원시 상세가 자동 표시되는 것을 확인했다.
- 느린 첫 실행 직후 빠른 두 번째 실행을 접수해 두 번째 답변만 현재 결과에 남는 것을 확인했다. 실행 상세 GET을 한 번 차단해 연결 오류와 ‘다시 조회’를 표시하고 재조회 후 최종 답변을 복구했다.
- build/typecheck/lint 통과. `npx vitest run --maxWorkers=2`로 18개 파일·53개 테스트 통과. 실제 장시간 모델과 모든 terminal 오류 상태의 브라우저 수동 검증은 남아 있다.

## 2026-09-15 실사용 개선 UX02 설정별 시험 입력 검증

- 스키마 폼 순수 테스트 4개: scalar 필드 설명과 호환 값 유지, 문자열·정수·boolean·enum의 typed 객체 조립, 필수·타입 오류 경로, JSON 구문·최상위 객체 오류 구분, 중첩 필드 고급 JSON 예제와 제거 필드 정리를 확인했다.
- build/typecheck/lint 통과. `npx vitest run --maxWorkers=2`로 17개 파일·50개 테스트 통과.
- Microsoft Edge Playwright 수직 흐름에서 일반 응답의 문장 폼 입력, 필수값의 필드 근접 오류와 `aria-invalid`, 고급 JSON의 최상위 배열 오류, JSON→폼 값 보존을 확인했다.
- 같은 흐름에서 사용자 정의 문자열·정수·boolean·enum 스키마를 저장하고 조립된 값을 메시지 미리보기에 전달했다. 코드 구현 템플릿의 `task`·`workspace` 다중 필수 입력과 `input.workspace`/실행 권한 구분 안내도 확인했다.
- 실제 사용자 스키마 전체 조합, 좁은 화면, 키보드만을 사용한 조작과 스크린리더 발화 순서는 수동 미검증이다.

## 2026-09-15 실사용 개선 UX04 고정 알림 검증

- build, typecheck, lint 통과. `npx vitest run --maxWorkers=2`로 16개 파일·46개 테스트 통과.
- Microsoft Edge Playwright 수직 흐름에서 성공 알림 `role=status`, 오류 알림 `role=alert`, 알림 영역의 fixed 위치를 확인했다.
- 긴 에이전트 편집 화면 하단까지 스크롤한 상태에서 저장 성공 알림이 viewport 안에 표시됨을 좌표로 확인했다. 409 오류 뒤 정상 에이전트 생성이 이어져도 오류가 유지되고, 실패 입력이 보존되며 사용자가 닫을 수 있음을 확인했다.
- 기능 시나리오 1개는 통과했다. 기존 Playwright runner 종료 정리 지연으로 완료 출력 뒤 프로세스를 수동 종료했으므로 무인 종료는 검증 완료로 처리하지 않는다.
- 실제 사용자 화면의 좁은 창, 키보드만을 사용한 조작, 스크린리더 발화 순서는 수동 미검증이다.

## 2026-09-15 수요 기반 자동 시작 검증

- 신규 lifecycle 5개 검사: 기존 서버 재사용, 시작 후 준비 대기, 잘못된 endpoint 오류 시 미시작, 원격 endpoint 미시작, 시작 대기 상한.
- MCP 검사 확장: 비활성 에이전트 재시작 후 미노출, 초기 활성 도구 0개에서 이후 도구 활성화·목록 갱신.
- 실제 프로세스 검사: 임시 데이터 폴더 및 동적 포트에 ensureService 동시 호출 2회, 준비 후 인증 API HTTP 200, 후속 호출에서 동일 PID 유지. 테스트용 자식 서버와 데이터만 정리함.
- build/typecheck/lint 통과. npm test 기본 병렬 실행에서 P0 인증 테스트 1회 5000ms timeout(45 passed/1 failed); 병렬 수 2로 전체 재검사하여 46/46 통과. 실패 이력을 보존하며 기본 병렬 안정성을 보증하지 않는다.
- VBS 탐색기 실행과 실제 사용자 MCP 클라이언트는 이번 회차에서 실행하지 않았다. UI 코드는 바꾸지 않았으며 E2E는 재실행하지 않았다.

## 2026-09-15 실사용 open 인증 장애 보완 검증

- 실행 중 서버의 메모리 토큰과 기본 `secrets.json`의 현재 DPAPI 토큰이 다르고, 현재 토큰으로 보낸 bootstrap 요청이 401임을 비밀값 출력 없이 확인했다.
- 암호화된 토큰 revision 변경 시 서버 캐시를 갱신하도록 수정했다. 임시 데이터 폴더에서 토큰 교체 후 이전 토큰 401, 새 토큰 bootstrap 200을 확인했다.
- 전체 build, typecheck, lint와 `npm test` 15개 파일·40개 테스트가 통과했다.
- 수정 빌드로 실제 기본 서비스를 재시작해 health 200, DPAPI 토큰 bootstrap 200, 일회용 토큰 세션 교환 200, 세션 기반 관리 API 200을 확인했다. 브라우저 실행과 세션 만료 후 재접속은 미검증이다.

## 2026-09-15 V01~V04 수정 후 독립 재확인

- 수정 코드 및 회귀 테스트 검토: V01~V04 해결 확인.
- 새 build 후 npm test: 15개 파일·40개 테스트 통과. build/typecheck/lint 통과.
- Edge E2E 시나리오 1개 통과. 테스트 서버 종료 대기 때문에 이번 실행의 테스트 서버만 수동 종료했으며 이후 runner exit 0을 확인했다. 기능 시나리오 통과와 무인 종료 검증을 구분한다. 자동 종료 정리는 미검증/추가 확인 필요.
- 상세 범위와 제한은 [전체 구현 검토](docs/IMPLEMENTATION_REVIEW.md)의 최상단 기록 참조.

## 2026-09-15 독립 재검토

- 기존 자동 검사 재실행: `npm test` 15개 파일·39개 테스트, build/typecheck(web 포함)/lint 통과.
- E2E는 기존 프로세스가 47931 포트를 사용해 시작하지 못했다. 이전 통과 이력과 구분하며 해당 프로세스는 종료하지 않았다.
- 일회성 인메모리 검사에서 STDIO bridge의 workspace metadata 누락, RunQueue 취소 오류 변환의 telemetry 소실, resource group 제한 상향 미반영을 확인했다. 모의 데이터만 사용하고 제품 코드는 변경하지 않았다.
- 자세한 증거와 정적 검토 항목은 [전체 구현 검토의 최신 절](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.

## 2026-09-15 V01 보완 검증

- 공식 SDK 인메모리 client가 `_meta["io.mcpex/workspace"]`와 임의 메타데이터를 실제 ToolCatalogBridge에 전달하고, 모의 backend에는 workspace 키만 도착함을 확인했다.
- `npm test -- --run tests/r10.test.ts`, CLI build, 전체 typecheck와 lint를 통과했다. 별도 프로세스 `mcpex mcp`와 실제 사용자 클라이언트 검증은 미수행이다.

## 2026-09-15 V02 보완 검증

- RunQueue 실행 중 caller 취소가 새 `CANCELLED` 오류로 정규화되면서도 원래 telemetry 오류를 cause로 보존함을 확인했다.
- 공식 SDK MCP 호출에서 read_file→write_file 후 응답 없는 다음 모델 요청을 deadline으로 중단했다. `timed_out` 실패 structuredContent에 도구 2회, write 변경 경로, 완료된 모델 2턴 token usage가 유지됨을 확인했다.

## 2026-09-15 V03 보완 검증

- 무응답 로컬 HTTP provider에 30ms `requestTimeoutMs`를 설정하고 모델 목록 조회와 probe를 호출했다. 두 요청 모두 HTTP 504 `PROVIDER_TIMEOUT`으로 종료됐다.
- 같은 회귀 테스트에서 에이전트 provider timeout과 UI 취소의 terminal 상태도 유지됨을 확인했다. 실제 외부 provider의 연결 종료 동작은 미검증이다.

## 2026-09-15 V04 보완 검증

- 같은 resource group의 provider 3개에 제한 2, 2, 1을 설정하고 서로 다른 provider의 두 실행이 최대 1개만 동시 실행됨을 확인했다.
- 제한 provider를 1→2로 수정하면 최대 동시 실행이 2로 늘고, 다른 그룹으로 이동하면 이전 그룹의 제한이 현재 구성원 기준 2로 유지됨을 확인했다.
- 실행 provider들을 이동한 새 그룹에서는 구성원 최솟값 1이 적용되고, 낮은 제한 provider를 삭제하면 제한이 2로 다시 늘어남을 확인했다.

## 2026-09-13 전체 구현 재검토

- 기존 `npm test`: 6개 파일, 16개 테스트 통과.
- `npm run build`, `npm run lint`, `npm run typecheck`: 통과. web은 루트 TypeScript 참조에서 제외되어 UI 타입 검증은 보증하지 않는다.
- `npm run test:e2e`: playwright 실행 파일 없음으로 실패. UI E2E는 미수행.
- 앱 소스는 수정하지 않았다. 정적 검토에서 확인한 연결 누락과 우선순위는 [전체 구현 검토](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.
- 실제 외부 모델·사용자 MCP 클라이언트·브라우저 실행 검증은 이번 검토에서 수행하지 않았다.

## 2026-09-13 R01/R02 실행 경계 보완 검증

- `npm test`: 6개 파일, 17개 테스트 통과.
- `npm run build`, `npm run typecheck`, `npm run lint`: 통과.
- 인증 없는 bootstrap, 관리 API와 MCP 요청이 401로 거부됨을 확인했다.
- localhost가 아닌 Host와 세션 기반 쓰기 요청의 잘못된 Origin·CSRF가 403으로 거부됨을 확인했다.
- 일회용 bootstrap 교환 후 HttpOnly/SameSite 세션으로 관리 API를 호출할 수 있음을 확인했다.
- 활성 목록에 없는 workspace 도구와 잘못된 도구 인자가 dispatcher에서 실행 전에 거부되고 파일이 변경되지 않음을 확인했다.
- 실제 브라우저의 fragment 제거·세션 교환과 CLI `open` 흐름은 R03 및 Playwright 구성 후 검증한다.

## 2026-09-13 R03/R04 UI 수직 흐름 구현 검증

- `npm test`: 6개 파일, 18개 테스트 통과.
- `npm run build`, `npm run typecheck`, `npm run lint`: 통과. 루트 typecheck가 web을 별도 `--noEmit` 검사하여 UI 타입도 보증한다.
- fixture web dist의 index 제공, content type, 정적 경로 이탈 거부를 확인했다.
- CLI 실제 빌드 출력으로 임시 서비스를 실행하고 `mcpex open`의 bootstrap 요청과 브라우저 실행 성공을 확인했다.
- 로컬 브라우저에서 정적 SPA와 인증 필요 안내가 정상 렌더링됨을 확인했다. 이 브라우저 확인은 `computer-use` 스킬을 사용했으며 임시 데이터 디렉터리는 검증 후 삭제했다.
- 실행 완료 후 `GET /api/v1/runs` 목록에 해당 run이 반환됨을 모의 통합 테스트로 확인했다.
- 인증 후 프로바이더 등록→모델 등록→에이전트 편집→시험→적용→활성화 전체 브라우저 조작은 Playwright 미구성으로 미검증이다.

## 2026-09-13 R05 입출력 스키마 계약 검증

- `npm test`: 6개 파일, 18개 테스트 통과. 기존 파일의 단일 수직 테스트에 R05 경계 assertion을 추가했다.
- `npm run build`, `npm run typecheck`, `npm run lint`: 통과.
- 필수 입력 누락을 모델 호출 전에 `INVALID_INPUT` 400으로 거부함을 확인했다.
- 지원하지 않는 `patternProperties`를 적용 시 `INVALID_SCHEMA` 422로 거부함을 확인했다.
- MCP SDK client의 `tools/list`에 `task` 필수 inputSchema가 전달되고 빈 인자 호출이 `isError=true`로 거부됨을 확인했다.
- 단일 JSON 코드펜스 성공, 비JSON과 선언 스키마 불일치의 `INVALID_OUTPUT`, 128KiB 초과의 `OUTPUT_LIMIT`을 확인했다.
- 출력 실패 run이 failed 상태와 상한 내 rawText·truncated·originalBytes 및 구체 오류 코드를 보존함을 확인했다.
- 스키마 깊이 8·64KiB·속성 100개 상한은 구현했으나 개별 경계 테스트는 아직 추가하지 않았다.

## 1. 현재 결과

2026-09-13: P0~P4 구현 및 부분 검증 완료. 앱 테스트와 P4 도구·모델 반복 실행 통합 테스트가 추가되었으며, 미검증 경계는 아래 상태 표에 남긴다.

## 2. 예정된 검증

| ID  | 항목            | 방식·통과 기준                                                                        | 상태                                                                                                                                                                                                                                                                                          |
| --- | --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | 빌드·의존성     | Windows Node 24 clean install, build/typecheck/lint 성공                              | 부분 통과: npm install은 better-sqlite3 native 빌드 실패로 `--ignore-scripts` 사용; 계약·저장소·서버·CLI·웹 build, typecheck, lint, format 통과                                                                                                                                               |
| T02 | DB·버전         | migration/재시작, FK, 중복 이름, expectedRevision 충돌, 원자적 적용                   | 부분 통과: schema v4 생성·재시작, v1→v4 migration과 사전 백업, 적용·가져오기 원자 저장, revision 충돌과 참조 삭제 거부 확인; 추가 FK 경계 필요                                                                                                                                                |
| T03 | 비밀·로컬 인증  | DPAPI 왕복, 평문 미기록, Host/Origin/CSRF/인증 거부, 일회용 토큰 만료                 | 부분 통과: 현재 계정 DPAPI 왕복·평문 미기록, bootstrap 1회 교환·replay 401 통과; 다른 계정·Origin/CSRF·만료 경로 미검증                                                                                                                                                                       |
| T04 | 프로바이더      | 지원 adapter의 요청·인증·응답·429/5xx·timeout·abort·미지원 목록                       | 부분 통과: adapter/profile 모의 계약, 실행·모델 목록·probe timeout과 abort, provider/model 상세·수정·credential 제거·안전 삭제 통과; 429/5xx·실제 외부 API는 미검증                                                                                                                           |
| T05 | 기능·스키마     | stale probe 거부, 미지원 옵션, 깊이·크기 제한, JSON 원문 보존                         | 부분 통과: 입력 필수값·금지 키워드·MCP schema 전달, JSON 성공/실패·스키마 불일치·원문 보존·출력 상한 통과; stale probe, 미지원 옵션과 깊이·크기 경계값 테스트는 미수행                                                                                                                        |
| T06 | 에이전트·템플릿 | 복사 후 독립 편집, 초안/적용 분리, 입력 치환, 모델 변경 재적용                        | 부분 통과: 기본/개인 템플릿 CRUD·sanitization·선택 적용, agent 복제·soft delete, 초안/적용 분리 통과; 모델/provider 변경 재적용 UI는 미검증                                                                                                                                                   |
| T07 | MCP             | STDIO 왕복, HTTP bridge, 동적 목록, 결과 envelope, 비활성 차단, 오류·취소·stdout 청결 | 부분 통과: HTTP tools/list·call, structuredContent/JSON 동일 envelope, 실제 observations·usage·duration, 변경 후 timeout telemetry 보존, 정책 오류 envelope, 비활성 차단, 인메모리 STDIO bridge 갱신과 caller workspace 메타데이터 전달 통과; 실프로세스 caller 취소·실제 클라이언트는 미검증 |
| T08 | 실행 큐         | 전역/provider/group 제한, FIFO, workspace 부모·자식 잠금, 대기 timeout                | 부분 통과: 동시성·workspace 직렬화, 잠금 대기 중 슬롯 미점유, 대기 deadline, caller 취소, provider ID 직렬화, 공유 resource group 최솟값과 구성원 수정·이동·삭제 후 재계산 통과; 엄격 FIFO는 미검증                                                                                           |
| T09 | 파일 도구       | fixture 읽기/검색/생성/교체, 경로 이탈·junction·충돌 차단, 출력 한도                  | 부분 통과: 읽기·검색·새 파일 생성, 기존 파일 expectedHash 강제·불일치 차단·원자적 쓰기·경로 이탈, 초과 파일 검색 제외와 목록·검색 직렬화 상한 통과; junction 경쟁 조건은 미검증                                                                                                               |
| T10 | 명령·루프       | 명령 opt-in, argv 보존, 환경 격리, 도구 오류 재입력, 반복 한도, 프로세스 트리 취소    | 부분 통과: allowlist·shell=false argv·부모 비밀 환경 차단·최소 PATH 유지·반복 루프와 stdout/stderr 수집 단계 합산 상한 통과; 실제 프로세스 트리 취소와 장시간 RSS는 미검증                                                                                                                    |
| T11 | 복구·이벤트     | 재시작 interrupted, 변경 보존, SSE seq 재개, terminal 멱등 취소                       | 부분 통과: 재시작 interrupted, terminal 취소 멱등, 이벤트 순서·live SSE·커서 재개·model/tool/cancel 기록과 보존 만료 410 통과; 실제 CLI signal은 미검증                                                                                                                                       |
| T12 | 설정 이동·보존  | export 비밀 제외, import 충돌·ID 재매핑·비활성, 기간 정리·백업                        | 부분 통과: 민감정보·로컬 경로 제외, 충돌 무변경, UUID/참조 재매핑, 비활성 초안, 기간 정리와 읽을 수 있는 온라인 백업 통과; UI 조작·전체 복구 재기동은 미검증                                                                                                                                  |
| T13 | UI 수직 흐름    | Playwright로 등록→에이전트 2개→시험→활성→MCP 정보→기록→편집 재적용→초안 정리·삭제     | 모의 검증 완료: Edge에서 fragment 인증, provider/model, 스키마 입력, 시험 진행·결과·재조회, 고정 알림, 활성·적용, MCP 등록 필드·활성 도구, 기록, 초안 정리, 삭제 확인·참조 충돌·선행 순서 통과                                                                                                |
| T14 | 실제 클라이언트 | 사용자 MCP 클라이언트에서 목록·호출·재연결 동작                                       | 미수행                                                                                                                                                                                                                                                                                        |
| T15 | 실제 모델       | 선택한 local/cloud 모델에서 응답·JSON·도구 호출, 결과 관측 대조                       | 미수행                                                                                                                                                                                                                                                                                        |

## 3. 테스트 경계

- 2026-09-16 공개 준비: 전체 build/typecheck/lint 및 `npx vitest run --maxWorkers=2` 19개 파일·56개 테스트 통과. README를 실제 설정 UI·서버·도구 코드와 대조하고 문서 코드 블록의 예시를 제외한 상대 링크를 검사했다. 사용자 DB는 읽기 전용으로 등록·적용 상태만 확인했으며 실제 모델 호출·파일 수정은 하지 않았다. UX06–UX08은 문서화만 했고 미구현·미검증이다. 이번 브라우저 E2E는 수행하지 않았다.

- 2026-09-15 실사용 개선 UX01–UX05: [항목별 인수 기준](docs/USABILITY_ISSUES.md)에 따라 UX01 삭제·초안 정리, UX02 스키마별 시험 입력, UX03 최종 결과 자동 추적, UX04 스크롤 중 알림, UX05 MCP 연결 정보를 구현하고 Edge 모의 브라우저로 검증했다. 실제 사용자 데이터·MCP 클라이언트, 좁은 화면, 키보드·스크린리더 검증은 별도 수동 범위로 남아 있다.

- 2026-09-15 설정 실행기 무반응 점검: 기존 `open` 및 VBS는 종료 코드 0, `.vbs` 연결은 WScript로 확인했지만 사용자 화면에서는 열리지 않았다고 보고됨. Windows 브라우저 호출을 `explorer.exe` 비동기 실행에서 PowerShell `Start-Process` 기본 URL 연결 호출로 변경하고 실행기 종료 실패를 CLI 오류로 전달했다. CLI 빌드와 해당 파일 ESLint 통과, 현재 Windows 계정에서 변경된 VBS를 `cscript`로 실행하여 종료 코드 0 확인. 실제 더블클릭 후 브라우저 표시 여부는 사용자 확인 전까지 미검증이며, 무반응의 단일 원인은 확정하지 않았다.

Vitest 단위·모의 통합은 임시 DB와 fixture 작업 폴더를 사용한다. Fastify inject로 API 인증/오류/트랜잭션을 검증하고 SDK client로 MCP를 검증한다. Playwright는 모의 모델 서버를 사용해 비용 없이 반복한다. 외부 프로젝트 파일이나 실제 사용자 인증을 자동 테스트에 사용하지 않는다.

모델의 답변 품질과 프로토콜·실행 성공을 구분한다. 실모델 시험은 모델 ID·서버 버전·시간·성공/실패·관측 근거만 기록하며 키나 민감 입력을 기록하지 않는다. 파일 쓰기 후 형식 오류, 명령 성공 후 모델 중단, 취소 후 부분 변경 같은 경계 사례를 필수 포함한다.

문서에 예정된 npm 명령이 실제 구현되기 전에는 실행 가능하다고 안내하지 않는다. 각 테스트 수행 시 날짜/명령/결과/미검증 범위를 추가하고 실패 원인 해결 전 검증 완료로 바꾸지 않는다.

## 4. 문서 정적 검사 기록

- 2026-09-13 PowerShell 정적 검사: 문서 9개(AGENTS.md 포함), 상대 링크 20개 확인, 누락 링크 0개.
- 새 설계 문서 5개가 AGENTS.md에 등록되어 있음을 확인했다. 새 문서 8개의 줄 끝 공백 문제 0개.
- 문서 대조: 단계 P0~P6, 공개/초안 버전, MCP 상태·오류, 후속 범위와 미구현 표시를 확인했다.
- 앱 빌드·보안·실연동 검증과는 별개다.
- 2026-09-13 P0 구현 검증: `npm install --ignore-scripts`, 계약·저장소·서버·CLI build, 웹 Vite build, `npm run typecheck`, `npm test`(2 tests), ESLint, Prettier 통과. 현재 계정 DPAPI 왕복 및 secrets.json 평문 미기록 통과. better-sqlite3 native 설치 실패는 IMPLEMENTATION_STATUS에 기록했다.
- 2026-09-13 P1 구현 검증: `npm test` 4 tests 통과. 모의 OpenAI HTTP 서버에서 provider/model 등록, `/models` 조회, 응답 probe와 오류 입력 URL 차단을 확인했다. 실제 외부 모델 호출은 수행하지 않았다.
- 2026-09-13 P2 구현 검증: `npm test` 5 tests 통과. 모의 모델에서 에이전트 초안 생성, 입력 preview, 불변 적용 버전, 시험 실행, completed run 조회와 기본 템플릿 조회를 확인했다. 전체 workspace build도 통과했다.
- 2026-09-13 P3 구현 검증: `npm test` 6 tests 통과. 공식 MCP SDK client로 활성 에이전트의 tools/list·tools/call과 Streamable HTTP 실행을 확인했다. 전체 workspace build, typecheck, ESLint, Prettier도 통과했다.
- 2026-09-13 P4 코어 검증: `npm test` 8 tests 통과. `@mcpex/tools`의 파일 fixture·hash 충돌·경로 이탈·명령 allowlist를 확인했고, 전체 workspace build, typecheck, ESLint, Prettier도 통과했다.
- 2026-09-13 P4 runtime 검증: `npm test` 9 tests 통과. provider tool-call 표준화 타입과 `RunQueue`의 동시 실행·겹치는 workspace 직렬화를 확인했고 전체 workspace build도 통과했다.
- 2026-09-13 P4 통합 검증: `npm test` 11 tests 통과. mock OpenAI 응답의 tool call→workspace `read_file`→tool 결과 재전달→최종 응답 흐름과 서버 test-run 연결을 확인했다.
- 2026-09-13 P5 adapter 검증: `npm test` 13 tests 통과. Anthropic Messages의 `tool_use`와 Gemini `functionCall`을 공통 `ToolCall`로 변환하고 usage/request id를 보존하는 모의 계약을 확인했다.
- 2026-09-13 P5 Bedrock 검증: `npm test` 15 tests 통과. Bedrock Converse의 bearer 인증, `toolConfig`, `toolUse` 응답을 공통 `ToolCall`로 변환하는 모의 계약을 확인했다.
- 2026-09-13 P5 Vertex/NovelAI 검증: `npm test` 16 tests 통과. Vertex project/location 경로·Bearer 인증과 NovelAI OpenAI 호환 profile 구성을 확인했다.
- 2026-09-13 R06/R07 검증: `npm test` 7개 파일·22개 테스트와 `npm run typecheck` 통과. 무응답 provider timeout·fetch abort, UI cancel API, 대기 deadline·caller 취소 구분, stale/live lock, 초기화 실패 정리, 재시작 interrupted 전환을 확인했다. 실제 MCP 클라이언트 취소와 CLI signal 종료는 미검증이다.
- 2026-09-14 R08/R09 검증: `npm test` 8개 파일·25개 테스트와 build, typecheck, lint 통과. 서버 tool loop의 허용 명령 실행·잘못된 executable 적용 거부, provider/resource group 동시성, 모델 기본 생성값과 agent override 병합을 확인했다.
- 2026-09-14 R10 검증: `npm test` 9개 파일·26개 테스트와 build, typecheck, lint 통과. 인메모리 MCP 연결에서 백엔드 목록 강제 갱신, 브리지 도구 추가·변경·삭제, `tools/list_changed`와 갱신 도구 호출 중계를 확인했다.
- 2026-09-14 R11 검증: `npm test` 10개 파일·28개 테스트와 build, typecheck, lint 통과. schema v1→v2 마이그레이션, 즉시 `202 queued` 접수 후 terminal 조회, run별 에이전트·모델·provider 스냅샷, 적용 후 초안 변경과 MCP description 분리를 확인했다.
- 2026-09-14 R12 검증: `npm test` 11개 파일·32개 테스트와 build, typecheck, lint 통과. 초과 파일의 제한 읽기·검색 제외, 긴 검색 행과 파일 목록의 직렬화 결과 상한, 512KiB 명령 출력의 수집 단계 1KiB 합산 보관 상한을 확인했다.
- 2026-09-14 P6 provider/model 관리 검증: `npm test` 12개 파일·33개 테스트와 build, typecheck, lint 통과. 상세 조회, revision 충돌·수정, credential 제거, 미참조 삭제와 모델/provider 참조 중 삭제 409를 확인했다.
- 2026-09-14 P6 template/agent 관리 검증: `npm test` 13개 파일·34개 테스트와 build, typecheck, lint 통과. 기본 템플릿 5종, 개인 템플릿 sanitization·version 충돌·선택 묶음 적용, builtin 변경 거부, agent 복제·활성 삭제 거부·soft delete 후 toolName 재사용 차단을 확인했다.
- 2026-09-14 P6 실행 이벤트·SSE 검증: `npm test` 14개 파일·35개 테스트와 build, typecheck, lint 통과. schema v3 마이그레이션, queued→started→model→finished 저장 순서, live SSE, `afterSeq`와 `Last-Event-ID` 재개, 모델 사용량, tool 시작·종료와 cancel_requested 기록을 확인했다. 이벤트 보존 정리와 만료 커서 410은 후속 보존 기능에서 검증한다.
- 2026-09-15 P6 설정 이동·보존·백업 검증: `npm test` 15개 파일·37개 테스트와 build, typecheck, lint 통과. 내보내기의 인증값·민감 header/extraBody·workspace·명령 경로 제외, 충돌 미리보기와 원자 거부, 새 UUID/참조 재매핑, 비활성 초안, 미래 schema 거부, 1일 보존 정리·SSE 410, 온라인 백업 생성과 읽기 전용 재열기를 확인했다. 설정 UI는 typecheck/build만 수행했고 브라우저 E2E와 백업 교체 후 서비스 재기동은 미검증이다.
- 2026-09-15 P6 오류 UI·브라우저 E2E 검증: `@playwright/test` 1.63.0과 설치된 Microsoft Edge를 사용한 `npm run test:e2e` 1개 테스트 통과. 일회용 fragment 인증과 URL 제거, provider/model 등록, 기본 템플릿이 다른 agent 2개 생성, 409 오류 code·해결 안내·폼 입력 유지, 시험 실행, 적용·복수 활성, 실행 기록과 활성 agent 편집 재적용을 로컬 mock으로 확인했다. 임시 평문 접속 토큰은 읽은 즉시 삭제한다.
- 2026-09-15 workspace 큐·caller 정책 검증: `npm test` 15개 파일·38개 테스트, build, typecheck, lint와 `npm run test:e2e` 1개 테스트 통과. 잠금이 겹치는 대기 작업이 전역 슬롯을 점유하지 않아 독립 workspace 작업이 진행됨을 확인했다. caller workspace 누락 422, 허용 루트 밖 403, UI 시험 실행과 공식 MCP SDK의 `_meta["io.mcpex/workspace"]` 정상 실행, 실행 스냅샷 경로 고정을 모의 통합 테스트로 확인했다. 기존 Edge 수직 흐름도 UI 정책 선택 추가 후 다시 통과했다.
- 2026-09-15 명령 환경 최소화 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 테스트 부모 프로세스에 둔 임의 비밀 환경변수와 `NODE_OPTIONS`가 allowlist 자식 Node 프로세스에 전달되지 않고 `PATH`만 유지됨을 확인했다. 실제 Windows 프로세스 트리 취소는 별도 미검증 상태를 유지한다.
- 2026-09-15 파일 기대 해시 계약 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 새 파일의 무해시 생성, 기존 파일의 무해시 쓰기 `EXPECTED_HASH_REQUIRED`, 오래된 해시 `HASH_CONFLICT`, `replace_text` 해시 필수와 최신 읽기 해시를 사용한 정상 수정, 각 실패 후 원문 보존을 확인했다.
- 2026-09-15 MCP 실행 결과 계약 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 공식 SDK client에서 성공 structuredContent와 JSON 텍스트의 동일성, response 실행 usage·0회 도구 관측, read→write 2회 호출·변경 경로와 3개 모델 턴 usage 합계·duration, caller workspace 정책 실패 structuredContent를 확인했다.
- 2026-09-15 V01 STDIO metadata 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 공식 SDK 인메모리 client의 `_meta["io.mcpex/workspace"]`가 실제 ToolCatalogBridge를 거쳐 backend에 보존되고 임의 메타데이터는 제거됨을 확인했다.
- 2026-09-15 V02 telemetry 보존 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 실행 중 caller 취소 오류의 cause 보존과 read→write 후 모델 deadline이 발생한 MCP 실패 envelope의 실제 observations·완료 usage 보존을 확인했다.
- 2026-09-15 V03 provider 관리 요청 timeout 검증: `npm test` 15개 파일·39개 테스트와 build, typecheck, lint 통과. 무응답 provider의 모델 목록 조회와 probe가 저장된 `requestTimeoutMs`에 따라 HTTP 504 `PROVIDER_TIMEOUT`으로 종료됨을 확인했다.
- 2026-09-15 V04 resource group 재설정 검증: `npm test` 15개 파일·40개 테스트와 build, typecheck, lint 통과. 그룹 구성원 최솟값 적용과 provider 제한 상향·그룹 이동·삭제 후 제한 맵 재계산을 실제 관리 API 및 동시 실행으로 확인했다.
