# 전체 구현 검토

## 2026-09-15 실사용 open 인증 장애 수정

실행 중 서버의 메모리 토큰과 현재 DPAPI 토큰이 달라 bootstrap 401이 지속되는 문제를 확인했다. 암호화 토큰 revision 변경 시 서버 캐시를 갱신하도록 수정했으며, 토큰 교체 회귀 테스트와 실제 기본 데이터의 bootstrap→세션 교환→관리 API가 모두 200으로 통과했다. 토큰을 교체한 외부 원인의 재현, 브라우저 실행과 세션 만료 후 재접속은 별도 검증 항목으로 유지한다.

## 2026-09-15 수정 후 독립 재확인

이번 검토는 V01~V04 변경 코드와 회귀 테스트에 집중했다. 네 항목 모두 수정 반영을 확인했으며 해당 범위에서 추가 차단 문제는 발견하지 않았다. 전체 서비스의 모든 실환경 검증이 완료됐다는 뜻은 아니다.

- V01: 브리지가 io.mcpex/workspace를 명시적으로 전달하며 다른 메타데이터는 전달하지 않는다. 인메모리 SDK 회귀 테스트 통과.
- V02: 큐 오류의 cause 보존과 서버의 cause chain telemetry 조회가 연결됐다. 파일 변경 뒤 timeout MCP 결과의 관측 및 usage 보존 테스트 통과.
- V03: discover-models/probes가 공통 timeout·연결 종료 signal을 adapter에 전달한다. 무응답 모의 공급업체에서 두 경로의 504 PROVIDER_TIMEOUT 테스트 통과.
- V04: 현재 provider 구성원으로 그룹 제한을 재계산한다. 제한 상향·그룹 이동·삭제 회귀 테스트 통과.
- 새 build 완료 후 npm test 재실행: 15개 파일·40개 테스트 통과. build/typecheck(web 포함)/lint 통과.
- Microsoft Edge E2E 시나리오 1개 통과. 단, 시나리오 완료 뒤 runner가 테스트 서버 정리에서 종료되지 않아 이번 실행이 생성한 테스트 서버 PID만 수동 종료했다. 이후 Playwright는 1 passed, exit 0으로 종료됐다. 따라서 기능 시나리오는 통과지만 무인 E2E 종료·정리는 추가 확인이 필요하다. 원인은 이번 검토에서 확정하지 않았다.
- 기존 사용자 서버를 종료하지 않았으며 제품 코드 수정 없이 검토·검증 문서만 갱신했다. 실제 사용자 MCP 클라이언트·실제 클라우드 모델·전체 복구 검증은 여전히 별도다.

## 2026-09-15 재검토 — 최신 판단

R01~~R12 대응은 대부분 실제 코드에 반영됐다. 인증 hook, 실행 도구 허용 검사, UI·관리 API, 입력·출력 스키마, 큐/취소, 스냅샷, 수집 단계 출력 제한을 확인했다. 후속 V01~~V04도 모두 수정·검증했으며 이번 재검토에서 확인한 코드 연결 문제는 남아 있지 않다. 아래 기존 9월 13일 문제 설명은 당시 코드의 이력이다.

### V01 · P1 · STDIO 브리지가 caller workspace 메타데이터를 전달하지 않음 — 수정·검증 완료

- 위치: apps/cli/src/tool-bridge.ts:58; apps/server/src/index.ts:2599.
- 브리지는 name/arguments와 signal만 전달한다. 서버의 caller workspace는 `context.mcpReq._meta['io.mcpex/workspace']`에서 읽으므로 이 값을 준 상위 호출도 STDIO를 거치면 WORKSPACE_REQUIRED가 된다.
- 인메모리 SDK client→실제 ToolCatalogBridge→모의 backend 호출로 확인: 입력 메타데이터의 작업 폴더가 backend에서 null이었다. 실제 폴더 접근은 하지 않았다.
- 2026-09-15 수정: 브리지가 문자열 `_meta["io.mcpex/workspace"]`만 새 메타데이터 객체로 백엔드 호출에 전달한다. 상위 요청의 다른 임의 메타데이터는 중계하지 않는다.
- 공식 SDK 인메모리 client→실제 ToolCatalogBridge→모의 backend 테스트에서 사용자 정의 workspace 값 전달과 비허용 메타데이터 제거를 확인했다. 실제 별도 STDIO 프로세스 검증은 계속 미검증이다.

### V02 · P1 · 취소·deadline 오류 변환 중 변경 관측 정보 소실 — 수정·검증 완료

- 위치: packages/runtime/src/index.ts:225~231; apps/server/src/index.ts:2309,2629.
- executeAgent가 오류 객체에 executionTelemetry를 넣지만 큐가 취소/deadline을 새로운 QueueError로 바꾸면서 이를 버린다. MCP 실패 envelope는 그 결과 toolCalls=0, changes=[], checks=[]로 돌아간다. 앞서 파일 편집을 수행한 작업도 취소 결과에서 관측된 변경이 없는 것처럼 보일 수 있다.
- 실제 RunQueue에 가짜 관측 정보가 붙은 오류를 전달하고 취소한 모의 검사에서 code=CANCELLED, telemetryPreserved=false를 확인했다. 파일은 수정하지 않았다.
- 2026-09-15 수정: RunQueue가 실행 중 취소·deadline 오류를 정규화할 때 원래 오류를 표준 `cause`로 보존하고, 서버는 최대 깊이와 순환 방어를 둔 cause chain에서 executionTelemetry를 찾는다.
- 단위 검사에서 실행 중 caller 취소의 원인 telemetry 보존을 확인했다. MCP 통합 검사에서는 read→write 후 다음 모델 요청을 timeout시켜 `timed_out` envelope에 실제 toolCalls 2회, write 변경 경로, 완료된 모델 2턴 usage가 유지됨을 확인했다.

### V03 · P2 · 프로바이더 시험·모델 목록 조회에는 timeout 미적용 — 수정·검증 완료

- 위치: apps/server/src/index.ts:261,1510,1700.
- 에이전트 실행은 requestTimeoutMs를 signal에 연결하지만 discover-models와 models/:id/probes는 signal 없이 adapter를 호출한다. 해당 provider의 제한 시간을 짧게 설정해도 UI 시험/조회에는 적용되지 않으며 응답 없는 서버 때문에 요청과 종료 정리가 대기할 수 있다.
- 정적 검토로 확인. 외부 무응답 서버 재현은 하지 않았다.
- 2026-09-15 수정: 두 관리 API가 provider의 `requestTimeoutMs`와 실제 HTTP 연결 종료를 결합한 공통 signal을 adapter fetch에 전달한다. 제한 시간 만료는 HTTP 504와 `PROVIDER_TIMEOUT`으로 구분한다.
- 무응답 로컬 HTTP provider를 사용해 모델 목록 조회와 probe가 설정된 제한 시간에 504로 종료됨을 확인했다. 같은 회귀 테스트의 에이전트 timeout과 UI 취소도 유지됐다.

### V04 · P2 · resource group 제한을 낮춘 뒤 올릴 수 없음 — 수정·검증 완료

- 위치: packages/runtime/src/index.ts:102~~114; apps/server/src/index.ts:1049~~1058.
- setResourceGroupLimit이 과거 값과 새 값의 최솟값만 저장한다. 그룹의 현재 provider 설정을 1→2로 변경하거나 제한이 가장 낮은 provider를 그룹에서 제거해도 이전 제한 1이 남는다.
- 실제 RunQueue에 그룹 제한 1→2 적용 후 독립된 모의 작업 두 개를 접수한 검사에서 최대 동시 실행은 1이었다.
- 2026-09-15 수정: 단일 그룹 setter는 전달받은 현재 제한으로 덮어쓰고, 전체 제한 맵을 교체하는 API를 추가했다. 서버는 저장된 현재 provider 전체에서 그룹별 최솟값을 다시 계산해 시작·설정 가져오기·provider 생성·수정·삭제 후 큐에 반영한다. 실행 접수 시 과거 snapshot 제한을 다시 누적하지 않는다.
- 실제 관리 API와 두 provider의 동시 실행을 사용해 구성원 최솟값 1, 1→2 상향, 그룹 이동 후 이전 그룹 2, 새 그룹의 최솟값 1, 제한 provider 삭제 후 2를 확인했다.

### 이번 검증 결과와 한계

- `npm test`: 15개 파일, 40개 테스트 통과.
- `npm run build`, `npm run typecheck`(web 포함), `npm run lint`: 통과.
- 추가 인메모리 검사 3개: workspace metadata 누락, 취소 telemetry 소실, group 제한 상향 미반영 확인.
- 후속 V01 보완 검사: 공식 SDK 인메모리 브리지에서 workspace metadata 전달과 다른 메타데이터 제거 통과.
- 후속 V02 보완 검사: 취소 오류 cause 보존과 파일 변경 후 timeout MCP telemetry·usage 보존 통과.
- 후속 V03 보완 검사: 무응답 provider의 모델 목록 조회·probe 제한 시간과 `PROVIDER_TIMEOUT` 응답 통과.
- 후속 V04 보완 검사: provider 제한 상향·그룹 이동·삭제 때 현재 구성원 기준 resource group 제한 재계산 통과.
- `npm run test:e2e`: `127.0.0.1:47931/health` 기존 점유로 시작 실패. 다른 프로세스를 종료하거나 reuseExistingServer 설정을 바꾸지 않았다. 이전 E2E 통과 기록은 유지하지만 이번 회차 재통과로 계산하지 않는다.
- 실제 클라우드 모델·실제 사용자 STDIO 클라이언트·설정 파일 UI 이동·전체 백업 복구는 이번에도 미검증.
- V01~V04 제품 코드와 회귀 테스트를 보완했다. 이 최신 절과 이전 검토의 역사적 설명을 구분한다. 아래의 과거 '브라우저 상호작용 미수행' 문구는 9월 13일 검사 범위이며 이후 E2E 수행 이력을 부정하지 않는다.

검토일: 2026-09-13. 대상: 현재 작업 트리 전체. 모든 코드가 untracked 상태이므로 특정 커밋 diff가 아닌 현재 파일 기준이다. 제품 소스 수정은 하지 않았다.

## 판정

모의 환경의 기본 수직 흐름은 동작하지만 설계한 v1 구현 완료로 판단할 수 없다. P0~P4에도 연결되지 않은 필수 기능이 있다. 아래는 소스 정적 검토에서 확인한 문제다. 보안 문제의 악용 재현이나 외부 서비스 요청은 수행하지 않았다.

## 후속 조치 상태

2026-09-14까지 권장 순서의 R01부터 R12까지 수정하고 자동 검증했다.

- **R01 수정·검증 완료:** DPAPI 보호 로컬 접속 토큰을 생성·재사용하고 `/auth/bootstrap`과 `/mcp`에 Bearer 인증을 적용했다. UI 교환 세션을 서버에서 만료 시간과 함께 관리하며 모든 관리 API에 세션 또는 로컬 토큰 인증을 적용했다. localhost Host 허용 목록과 세션 기반 쓰기 요청의 동일 Origin·CSRF 헤더 검사를 추가했다.
- **R02 수정·검증 완료:** 실행 dispatcher가 에이전트의 활성 도구 집합을 다시 검사하고 workspace 도구별 필수 인자·형식·추가 인자를 검증한다. `runtime.mode=tools`일 때만 도구를 제공하며 MCP readOnly/openWorld annotation을 실제 활성 도구 정책에 맞췄다.
- **R03 구현 완료·부분 검증:** Vite 개발 proxy, 서버의 제한된 정적 파일 제공과 SPA fallback, 실제 출력 위치를 사용하는 CLI bin, `mcpex open`의 bootstrap 발급·fragment URL 브라우저 실행을 구현했다. 정적 파일·경로 이탈 테스트와 로컬 브라우저 렌더링을 확인했으나 Playwright E2E는 아직 없다.
- **R04 구현 완료·부분 검증:** 프로바이더별 모델 등록과 명시적 시험 모델 선택, 템플릿 기반 에이전트 생성, 모델·프롬프트·입력 스키마·출력·workspace 도구 편집, 초안 저장·미리보기·시험·적용·활성화, 실행 목록 화면과 API를 구현했다. 루트 typecheck 명령에서 web도 `--noEmit`으로 검사한다.
- **R05 수정·검증 완료:** JSON Schema 2020-12 제한 검증기를 추가해 적용 시 input/output schema를 검사하고 API·MCP 실행 입력에 강제했다. HTTP MCP와 STDIO bridge는 실제 inputSchema를 등록하며, text/Markdown/JSON 출력 형식과 JSON 스키마, 128KiB 출력 상한을 검사한다. 실패 시 `INVALID_INPUT`, `INVALID_SCHEMA`, `INVALID_OUTPUT`, `OUTPUT_LIMIT`을 구분하고 제한된 원문을 run에 보존한다.
- **R06 수정·부분 검증 완료:** 실행 접수 시 절대 deadline을 정하고 대기·실행 단계에서 만료를 적용한다. UI 취소 API와 MCP 요청 signal을 queue→runtime→provider fetch·workspace tool까지 전달하며 caller 취소와 timeout을 각각 `cancelled`/`timed_out` run으로 기록한다. 공급업체별 `requestTimeoutMs`도 실제 fetch signal에 연결했다.
- **R07 수정·부분 검증 완료:** CLI와 서버 직접 실행에 SIGINT/SIGTERM graceful shutdown을 연결하고 종료 시 진행 작업 취소·정리 후 DB와 lock을 닫는다. stale PID lock을 회복하고 살아 있는 소유자는 거부하며, 저장소·서버 초기화 실패 시 열린 DB와 lock을 해제한다. 재시작 시 남은 queued/running run은 `interrupted`로 전환한다.
- **R08 수정·검증 완료:** command 설정을 최대 개수·고유 commandId·절대 executable 경로·허용 필드 기준으로 적용/실행 전에 검증하고 `WorkspaceTools`에 전달한다. UI에도 허용 명령 JSON 편집을 연결했으며 서버 모델 반복에서 allowlisted 명령 실행을 확인했다.
- **R09 수정·검증 완료:** 기존·신규 provider의 `maxConcurrency`, `resourceGroup`, `resourceGroupConcurrency`를 큐에 반영하고 provider ID와 resource group을 실행 제한 키로 사용한다. 모델 `defaultGeneration`에 agent override를 덮어쓴 해석 결과를 preview와 실제 adapter 요청에 전달하며 UI에 관련 설정 입력을 추가했다.
- **R10 수정·검증 완료:** STDIO 브리지가 백엔드 `tools/list` 캐시를 주기적으로 강제 갱신하고 도구 추가·정의 변경·삭제를 로컬 MCP 등록에 반영한다. 변경 시 SDK의 `tools/list_changed`를 상위 클라이언트에 전달하며 갱신된 정의와 취소 signal로 호출을 중계한다.
- **R11 수정·검증 완료:** schema v2의 `runs.config_snapshot_json`과 v1 마이그레이션을 추가했다. 적용 버전 생성 시 에이전트·모델·프로바이더 해석 결과를 원자적으로 저장하고, 실행은 접수 시점 스냅샷과 메모리에 고정한 인증값을 사용한다. UI 시험 실행은 완료를 기다리지 않고 `202 queued`를 반환하며 MCP metadata는 현재 초안이 아닌 적용 버전을 사용한다.
- **R12 수정·검증 완료:** 최대 읽기 크기를 사전 확인하고 제한량보다 한 바이트 이상 읽지 않는 공통 파일 읽기를 검색·교체·hash 확인에 적용했다. 검색은 초과 파일을 건너뛰고 목록·검색 결과는 전체 직렬화 바이트 예산을 지킨다. 명령 stdout/stderr는 실행 중 공유 상한까지만 보관하고 전체 관측 바이트와 잘림 상태를 반환한다.
- **검증:** `npm test` 11개 파일·32개 테스트와 build, typecheck, lint 통과. 초과 파일 읽기 거부·검색 제외, 긴 검색 행과 파일 목록의 결과 상한, 대용량 stdout/stderr의 수집 단계 합산 상한을 확인했다. 실제 장시간 대용량 프로세스의 RSS 측정은 미수행이다.
- **P6 구현 완료·부분 검증:** 프로바이더·모델 관리, 템플릿·에이전트 수명주기, 실행 이벤트/SSE, 설정 이동·보존·백업에 이어 API 오류의 상태·code·details와 해결 안내를 표시하는 오류 UI를 구현했다. Playwright E2E는 일회용 fragment 인증부터 provider/model, 서로 다른 템플릿 agent 2개, 충돌 입력 유지, 시험·적용·복수 활성·기록·편집 재적용까지 검증한다.
- **검증:** `npm test` 15개 파일·37개 테스트, Microsoft Edge `npm run test:e2e` 1개 테스트와 build, typecheck, lint 통과. 설정 이동 UI 파일 선택, clean install, DB 백업 교체 재기동, 실제 모델·MCP 클라이언트는 별도 미검증 범위다.
- **다음 작업:** 아래 추가 누락의 실행 안전성 항목과 실환경 검증을 순서대로 진행한다.

## 실행한 검사

| 명령              | 결과                              |
| ----------------- | --------------------------------- |
| npm test          | 15개 파일, 37개 테스트 통과       |
| npm run build     | 모든 workspace 빌드 통과          |
| npm run lint      | 통과                              |
| npm run typecheck | 통과. web도 별도 `--noEmit` 검사  |
| npm run test:e2e  | Microsoft Edge 1개 수직 흐름 통과 |

실제 클라우드 API, 실제 사용자 MCP 클라이언트, 브라우저 상호작용, clean install, 타 Windows 계정 검증은 수행하지 않았다. 테스트는 기존 테스트만 실행했다.

## 수정 필요 사항

### R01 · P1 · 로컬 인증이 API 및 MCP에 적용되지 않음 — 수정·검증 완료

위치: apps/server/src/index.ts:172~~195, 716~~719.

exchange는 쿠키를 발급하지만 세션을 저장하거나 검증하지 않는다. API/MCP의 인증 hook이 없고 bootstrap 발급도 접근 검증이 없다. Host/Origin/CSRF 검사도 서비스 코드에 없다. 인증 없는 로컬 호출을 사용자 승인으로 취급하면 안 된다. 공통 요청 인증·세션 저장·브리지 인증 및 로컬 HTTP 보호를 구현하고 모든 관리/실행 경로에 적용해야 한다.

### R02 · P1 · 선택한 도구 목록이 실행 허용 목록으로 강제되지 않음 — 수정·검증 완료

위치: apps/server/src/index.ts:548~577; packages/runtime/src/index.ts의 runToolLoop; packages/tools/src/index.ts의 executeWorkspaceTool.

enabledTools는 모델에 제공하는 정의만 필터링한다. 반환된 도구 호출은 활성 목록과 인자 스키마 검증 없이 공용 dispatcher로 전달된다. 실행 직전 선택된 도구인지 검사하고 인자를 검증해야 읽기 전용 같은 설정을 보장할 수 있다. runtime.mode도 실제 분기에서 사용하지 않으며 MCP readOnlyHint는 항상 true이다. 정책·모드·annotation을 실제 실행 기능에 일치시켜야 한다.

### R03 · P1 · 정상 실행 경로로 웹 UI에 접근할 수 없음 — 구현 완료·부분 검증

위치: apps/cli/src/index.ts:9~14; apps/web/vite.config.ts:3; apps/server/src/index.ts.

serve가 정적 웹 파일을 제공하지 않고 open은 안내 문자열만 출력한다. Vite를 별도로 실행해도 /api proxy가 없어 프런트엔드의 상대 API 요청이 백엔드로 전달되지 않는다. 개발 proxy와 빌드 정적 제공을 각각 연결하고 open을 구현해야 한다.

### R04 · P1 · 핵심 에이전트 편집 화면과 다중 모델 선택 흐름 미구현 — 구현 완료·부분 검증

위치: apps/web/src/main.tsx:85~~105,119~~124.

에이전트·실행 기록 메뉴에 동작이 없고 렌더링되는 화면은 프로바이더/모델 등록과 응답 시험뿐이다. 템플릿 적용, 시스템 프롬프트 편집, 에이전트 활성화를 UI에서 할 수 없다. 모델 등록과 시험 대상도 providers[0]/models[0]으로 고정되어 두 번째 연결·모델을 선택할 수 없다. 이는 단순 미검증이 아니라 사용자 요구의 미구현이다.

### R05 · P1 · 사용자 입력·출력 스키마가 실행에 반영되지 않음 — 수정·검증 완료

위치: apps/server/src/index.ts:587~588,665; apps/cli/src/index.ts:27.

MCP 서버와 브리지는 입력을 임의 record로 등록해 필수 항목·설명이 도구 목록에 전달되지 않는다. 시험 실행도 inputSchema 검증이 없다. 출력은 설정과 무관하게 Markdown completed로 저장해 JSON 출력 형식 실패를 탐지하지 못한다. 적용 시 스키마 검증, MCP 전달, 호출 시 입력 검사, 완료 시 출력 검사를 연결해야 한다.

### R06 · P1 · 취소 및 시간 제한이 실제 모델 작업에 전달되지 않음 — 수정·부분 검증 완료

위치: apps/server/src/index.ts:570~~580,618~~623,668~679.

queue callback은 제공된 signal을 받지 않고 executeAgent도 signal 인자가 없다. runToolLoop와 응답 호출에는 상위 signal이 전달되지 않는다. timeoutMs/requestTimeoutMs를 deadline에 연결하지 않으며 취소 API도 없다. 공급업체가 응답하지 않으면 작업·슬롯이 계속 점유될 수 있다. 접수 시 deadline 설정 및 MCP/UI→queue→runtime→fetch/tools 취소 전파가 필요하다.

### R07 · P1 · CLI 종료 후 데이터 디렉터리 잠금이 남음 — 수정·부분 검증 완료

위치: apps/cli/src/index.ts:9~~12; packages/storage/src/index.ts:23~~39.

CLI는 createServer의 close를 버리고 SIGINT/SIGTERM 종료 처리를 등록하지 않는다. 파일 잠금은 명시적 release에서만 삭제되며 기존 lock 파일의 소유 프로세스 생존 확인도 없다. 종료나 비정상 종료 후 같은 디렉터리로 재시작하면 DATA_DIR_LOCKED가 유지된다. graceful shutdown과 stale lock 판별·안전한 회복을 구현해야 한다. 부트스트랩 실패 시 획득한 잠금 해제도 필요하다.

### R08 · P2 · 명령 허용 설정이 도구 인스턴스에 전달되지 않음 — 수정·검증 완료

위치: apps/server/src/index.ts:551; packages/tools/src/index.ts:52,209~210.

WorkspaceTools를 workspace만 전달해 생성하므로 commands는 항상 빈 배열이다. 에이전트에 명령을 설정해도 실제 run_command는 허용된 commandId를 찾지 못한다. 설정을 검증한 뒤 생성자에 전달해야 한다. 직접 WorkspaceTools를 생성하는 단위 테스트 성공은 서버 연결 성공을 의미하지 않는다.

### R09 · P2 · 프로바이더 동시성 및 모델 기본 생성 설정이 무시됨 — 수정·검증 완료

위치: apps/server/src/index.ts:164,558~560,623,679.

RunQueue는 기본 전역 제한만 사용하고 설정된 providerLimits/resourceGroup을 넣지 않는다. provider 키에도 provider ID가 아닌 modelRef를 사용한다. maxConcurrency=1로 설정해도 같은 공급업체의 다른 모델 작업이 함께 실행될 수 있다. defaultGeneration도 실행 시 읽지 않고 generationOverrides만 전달한다. 모델 기본값 해석과 공급업체/그룹 제한을 공통 설정 해석 단계에 연결해야 한다.

### R10 · P2 · STDIO 연결 이후 활성 목록 변경이 반영되지 않음 — 수정·검증 완료

위치: apps/cli/src/index.ts:23~33.

브리지는 연결 시 listTools를 한 번 호출해 등록하고 이후 목록 변경 알림·재조회·등록 해제를 처리하지 않는다. 사용자가 새 에이전트를 활성화해도 기존 STDIO 연결에서 찾을 수 없다. 백엔드 catalog 변경과 브리지 목록 동기화를 구현하거나 재연결 필요를 명시해야 한다.

### R11 · P2 · 적용 버전 및 실행 기록이 재현 가능한 스냅샷이 아님 — 수정·검증 완료

위치: apps/server/src/index.ts:460~~468,520~~536,664.

적용은 초안 JSON만 저장하고 실행 시 현재 모델/프로바이더를 다시 조회한다. 모델·프로바이더 설정의 적용 시점 스냅샷이 없으며 MCP description은 적용 버전 대신 현재 초안에서 읽는다. runs에도 configSnapshot이 없다. 실행 슬롯을 얻기 전에는 run이 생성되지 않아 대기 상태 조회가 불가능하고 test-runs는 완료까지 기다린 후 202를 반환한다. 적용 버전·접수 시 스냅샷·비동기 접수 및 상태 기록을 분리해야 한다.

### R12 · P2 · 도구의 출력·읽기 제한이 메모리 사용을 제한하지 않음 — 수정·검증 완료

위치: packages/tools/src/index.ts:138~~145,222~~238.

검색은 목록의 파일을 크기 검사 없이 통째로 읽고 반환 행의 바이트 제한도 적용하지 않는다. 명령 stdout/stderr는 종료까지 무제한 문자열에 누적한 뒤 마지막에 자른다. 큰 로그·파일을 정상 처리할 때 메모리 고갈과 모델 문맥 초과가 발생할 수 있다. 읽기 전 크기 검사, 수집 단계 버퍼 상한, 결과 전체 바이트 한도를 적용해야 한다.

## 추가 누락 및 문서 상태

- provider/model 관리, 사용자 템플릿 CRUD/적용, 에이전트 삭제·복제, 실행 SSE, 설정 이동·보존·백업, 오류 UI와 핵심 브라우저 E2E는 구현했다. 설정 이동 UI의 파일 선택과 실제 외부 연동은 남아 있다.
- **수정·검증 완료:** 큐가 실행 가능 작업을 선택할 때 workspace 잠금 충돌도 검사하므로 잠금 대기 작업은 전역 실행 슬롯을 차지하지 않는다. 독립 workspace 작업이 먼저 실행되는 회귀 테스트를 추가했다.
- **수정·검증 완료:** workspacePolicy.caller를 UI 시험 실행 본문의 별도 workspace 필드와 MCP `_meta["io.mcpex/workspace"]`에 연결했다. 절대 경로·사전 허용 루트 포함 관계를 검증하고 실제 경로를 실행 스냅샷에 고정한다.
- **수정·검증 완료:** allowlist 명령과 Windows 종료 헬퍼는 부모 `process.env` 대신 플랫폼별 최소 OS 환경만 전달한다. 임의 부모 비밀 변수와 `NODE_OPTIONS`가 자식 Node 프로세스에 없고 `PATH`는 유지되는 회귀 테스트를 추가했다.
- **수정·검증 완료:** `write_file`은 대상 존재 여부를 항상 확인해 기존 파일에는 `expectedHash`를 강제하고, `replace_text`는 도구 스키마와 실행기 모두에서 해시를 필수화했다. 누락·불일치 시 기존 내용이 유지되고 최신 읽기 해시로만 수정되는 테스트를 추가했다.
- **수정·검증 완료:** MCP 성공·애플리케이션 실패 응답은 공통 envelope를 `structuredContent`와 JSON 텍스트에 동일하게 제공한다. 실제 도구 호출·변경·명령 검사·잘림을 집계하고, 전체 모델 턴 usage와 큐 접수부터 완료까지의 duration을 반환한다. 도구 observation과 모델별 usage는 실행 이벤트에도 남긴다.
- Playwright 의존성·설정·수직 테스트와 web 전용 TypeScript 검사를 추가했다.
- 기존 문서의 P0~P4 완료 및 CRUD 표현은 위 결과에 따라 부분 구현으로 재평가해야 한다. 후속 API 어댑터 수보다 사용자 수직 흐름과 공통 실행 계약 완성이 우선이다.

## 권장 수정 순서

R01/R02 실행 경계 → R03/R04 사용자 흐름 → R05/R06/R07 실행 계약·수명주기 → R08~R12 연결 누락 → P6 운영 기능 및 E2E. 각 수정은 해당 거부·실패·종료 경로를 검증하고 기존 16개 성공 테스트만으로 완료 판단하지 않는다.
