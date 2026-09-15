# 구현 상태

## 2026-09-16 VBS 자동 시작 잠금 오판 — 수정·검증 완료

- 기본 데이터 폴더의 이전 `service.lock` PID가 Windows에서 `msedgewebview2` 프로세스에 재사용되어, 실행 중인 MCPex가 없는데도 `DATA_DIR_LOCKED`로 오판하고 `open`이 20초 후 실패하는 원인을 확인했다.
- 잠금 파일을 version 1 JSON으로 바꿔 PID, 프로세스 시작 시각, 실행 파일과 소유 토큰을 기록한다. Windows에서 현재 PID의 실제 시작 시각·실행 파일이 기록과 일치할 때만 살아 있는 잠금 소유자로 인정하며 기존 숫자 PID 잠금도 호환한다.
- 잠금 해제는 소유 토큰이 일치하는 파일만 제거해 다른 인스턴스의 잠금을 지우지 않는다. 백그라운드 서비스가 시작 직후 종료되면 20초 polling에 들어가기 전에 종료 코드를 전달한다.
- PID 재사용 모의 잠금 자동 복구, 실제 소유자 중복 차단, 초기화 실패 후 해제를 회귀 테스트로 확인했다. 전체 build/typecheck/lint와 19개 파일·56개 테스트가 통과했다.
- 실제 기본 데이터 폴더의 오래된 잠금을 새 빌드가 자동 복구한 뒤 `node ... open`과 `MCPex Settings.vbs`가 각각 종료 코드 0, `/health`가 정상 응답함을 확인했다. 실제 탐색기 더블클릭 동작은 사용자 확인 전까지 별도다.

## 2026-09-15 실사용 개선 UX05 — 구현·자동 검증 완료

- **MCP 연결 정보** 탭을 추가해 MCPex 서버를 클라이언트마다 한 번 등록하고 활성 에이전트가 개별 도구로 노출되는 구조를 안내한다.
- CLI가 현재 Node 실행 파일, CLI 절대 경로와 `mcp` 인수, 필요한 환경변수를 서버에 전달한다. 화면은 실행 파일·인수·환경변수와 일반 JSON 예시를 분리해 표시하고 복사 동작을 제공하며 인증 토큰·provider credential은 포함하지 않는다.
- `GET /api/v1/mcp-connection`은 적용 버전을 기준으로 활성 도구 이름·설명을 계산하고 비활성·미적용 에이전트를 사유별로 구분한다. 관리 API 정상 응답과 실제 MCP 클라이언트 미확인 상태를 별도로 표시한다.
- 등록→에이전트 저장·적용·활성화→도구 목록 확인→필요 시 재연결 순서, 활성 도구 0개와 CLI 밖 직접 서버 실행 시의 다음 조치를 제공한다.
- 인증 요구, 공백 포함 경로와 분리 인수, 적용/초안 설명 격리, 비밀 제외를 API 테스트로 확인했다. Edge E2E에서 연결 탭·상태·실행 경로·인수·활성 도구 2개·비밀 제외 안내를 통과했다. 실제 사용자 MCP 클라이언트 등록·호출은 T14에 남아 있다.
- build/typecheck/lint와 `npx vitest run --maxWorkers=2` 19개 파일·55개 테스트가 통과했다. Playwright 1개 시나리오도 통과했고 기존 종료 정리 지연 때문에 테스트 전용 서버를 식별해 종료한 뒤 runner exit 0을 확인했다.

## 2026-09-15 실사용 개선 UX01 — 구현·자동 검증 완료

- 프로바이더·모델 목록과 에이전트 편집의 일관된 위치에 삭제 동작을 추가하고, 대상 이름과 영향을 확인한 뒤 실행하도록 했다. 삭제 확인을 취소하면 데이터를 변경하지 않는다.
- 참조 중인 프로바이더·모델은 서버의 기존 차단을 유지하면서 모델 또는 에이전트를 먼저 정리하도록 안내한다. 활성 에이전트의 삭제 버튼은 비활성화하고 비활성화가 선행되어야 함을 표시한다.
- 미저장 편집 취소, 적용 전 에이전트 전체 삭제, 적용된 에이전트의 저장 초안 복원을 구분했다. `POST /api/v1/agents/:id/draft-discard`는 정확한 적용 버전 스냅샷과 `expectedRevision`으로 초안만 복원하며 공개 버전·활성 상태·실행 기록은 유지한다.
- 본문 없는 DELETE 요청에는 JSON Content-Type을 보내지 않도록 공통 API 호출을 바로잡았고, 삭제 후 목록과 선택 상태를 다시 동기화한다.
- API 회귀 테스트와 Edge E2E에서 초안 복원 revision 충돌 및 상태 보존, 삭제 확인 취소/확정, 참조 충돌 안내, 모델→프로바이더 삭제 순서, 활성 삭제 제한, 미저장 편집 취소를 통과했다. 실제 사용자 데이터와 키보드·스크린리더 수동 검증은 남아 있다.
- build/typecheck/lint와 `npx vitest run --maxWorkers=2` 18개 파일·54개 테스트가 통과했다. Playwright 기능 시나리오는 통과했지만 기존 runner 종료 정리 지연으로 프로세스를 수동 종료했다.

## 2026-09-15 실사용 개선 UX03 — 구현·자동 검증 완료

- 시험 실행 접수 즉시 run ID와 대기·실행·취소 요청 상태를 같은 편집 영역에 표시하고 실행 상세 API를 terminal 상태까지 자동 조회한다.
- 완료 답변은 읽기 쉬운 결과 영역에, JSON·부분 결과와 오류는 별도 영역에 표시하며 전체 실행 객체는 펼침 상세로 제공한다. 진행 중 취소와 조회 연결 실패 후 다시 조회를 지원한다.
- 화면 또는 에이전트 전환 시 기존 조회를 중단하고 요청 세대로 연속 시험을 격리해 늦은 이전 결과가 현재 결과를 덮어쓰지 않는다. 서버의 failed/cancelled/timed_out/interrupted 상태를 서로 다른 종료 안내로 표시한다.
- 추적 단위 테스트 3개와 Edge E2E에서 느린 실행 진행 상태, 연속 실행 결과 격리, 최종 답변 자동 표시, 원시 상세, 조회 실패 후 재조회를 통과했다. 실제 장시간 모델과 모든 오류 상태의 브라우저 수동 검증은 남아 있다.
- build/typecheck/lint와 `npx vitest run --maxWorkers=2` 18개 파일·53개 테스트가 통과했다. Playwright 기능 시나리오는 통과했지만 기존 runner 종료 정리 지연으로 프로세스를 수동 종료했다.

## 2026-09-15 실사용 개선 UX02 — 구현·자동 검증 완료

- 에이전트의 현재 `inputSchema`에서 문자열·숫자·정수·boolean·enum 시험 입력 폼을 생성하고 필수 여부·설명·기본값을 표시한다. 일반 문장은 JSON을 직접 작성하지 않고 올바른 객체로 조립한다.
- 중첩 객체·배열·null은 고급 JSON 대상임을 명시하고 전체 스키마 예제를 생성한다. 폼/JSON 전환과 스키마 변경 시 호환 값은 유지하고 제거되거나 타입이 달라진 값은 예제로 정리한다.
- JSON 구문, 최상위 객체, 필수값, 타입·enum·길이·숫자 범위·배열 크기 오류를 구분해 입력 영역과 해당 최상위 필드에 표시한다. `input.workspace`와 실행 권한용 시험 호출 작업 폴더도 구분해 안내한다.
- 변환·검증 단위 테스트 4개와 Edge E2E에서 일반 응답, 사용자 정의 문자열·정수·boolean·enum 스키마, 코드 구현 템플릿의 다중 필수 입력과 미리보기를 통과했다. 실제 사용자 스키마 전체 조합과 스크린리더 수동 검증은 남아 있다.
- build/typecheck/lint와 `npx vitest run --maxWorkers=2` 17개 파일·50개 테스트가 통과했다. Playwright 기능 시나리오는 통과했지만 기존 runner 종료 정리 지연으로 프로세스를 수동 종료했다.

## 2026-09-15 실사용 개선 UX04 — 구현·모의 브라우저 검증 완료

- 성공·오류 안내를 현재 스크롤과 무관한 고정 알림 영역으로 옮겼다. 성공 안내는 `status`/polite, 오류는 `alert`/assertive로 알리고 두 알림 모두 편집 포커스를 이동하지 않는 닫기 동작을 제공한다.
- 오류는 새 작업 시작이나 후속 성공 안내로 자동 제거되지 않으며, API가 제공한 details가 있을 때 펼쳐 확인할 수 있다. 초기 연결 실패도 조치 가능한 오류 알림으로 통일했다.
- Edge E2E에서 긴 편집 화면 하단의 알림 viewport 노출, 409 오류가 후속 성공 안내 중 유지되는 동작, 실패 입력 보존과 닫기를 확인했다. build/typecheck/lint와 `npx vitest run --maxWorkers=2` 16개 파일·46개 테스트가 통과했다.
- 기존 Playwright runner 종료 정리 지연은 재현되어 기능 시나리오 통과 후 테스트 프로세스를 수동 종료했다. 실제 사용자 환경의 좁은 창·키보드·스크린리더 수동 검증은 남아 있다.

## 2026-09-15 설정 실행 파일·서비스 자동 시작

- 구현 완료: `MCPex Settings.vbs` 더블클릭으로 open 실행. open/mcp는 로컬 서비스가 없으면 숨김 백그라운드 서비스 시작 후 준비를 기다리고, 실행 중이면 재사용한다. 사용자 데이터·활성 상태는 변경하지 않는다.
- 검증 완료: 임시 데이터·별도 포트에서 실제 Node 서비스 동시 자동 시작 요청, 인증 API 200, 기존 PID 재사용 확인. 테스트 프로세스와 임시 데이터를 정리했다.
- 검증 완료: 비활성화 후 서비스 재시작 시 enabled=false 유지 및 MCP 목록 제외, 빈 목록으로 연결한 뒤 도구 활성화 시 재연결 없이 목록 조회.
- build/typecheck/lint 통과. 전체 기본 병렬 테스트에서 기존 P0 인증 테스트 1회 5초 timeout 발생; `npx vitest run --maxWorkers=2`로 재실행하여 16개 파일·46개 테스트 통과. 기본 병렬 실행의 부하 민감성은 남아 있다.
- 미검증: 실제 Windows 탐색기에서 VBS 더블클릭→브라우저 자동 열기, 실제 사용자 MCP 앱 자동 시작. 기존 사용자 서비스를 재시작하거나 외부 MCP 설정을 변경하지 않았다. 새 CLI/서버는 빌드 완료됐으며 이미 떠 있는 서버는 기존 프로세스 코드를 유지한다.

## 2026-09-15 실사용 인증 문제 — 수정·검증 완료

실행 중 서버의 메모리 토큰과 현재 DPAPI 토큰이 달랐고 서버가 이 변경을 감지하지 않아 `open`의 bootstrap 요청이 HTTP 401로 실패했다. 암호화된 토큰 revision이 달라질 때만 DPAPI 값을 다시 읽어 캐시를 갱신하도록 수정했다. 토큰 교체 회귀 테스트와 실제 기본 데이터의 bootstrap→세션 교환→관리 API가 모두 통과했다. 토큰을 교체한 외부 원인은 확정하지 않았으며 상세 증거와 남은 검증은 [추가 검증 항목](docs/VERIFICATION_GAPS.md)에 기록했다.

## 2026-09-15 V01~V04 수정 후 재확인

독립 검토에서 V01~V04 수정 반영과 관련 회귀 테스트 통과를 확인했다. 새 빌드 기준 자동 테스트 40개, build/typecheck/lint 통과. Edge E2E 기능 시나리오 1개도 통과했으나 runner 종료를 위해 이번 실행의 테스트 서버를 수동 정리했다. 무인 E2E 종료 및 기존 실환경 미검증 항목은 완료 처리하지 않는다. 제품 소스는 이번 검토에서 수정하지 않았다.

## 2026-09-15 독립 재검토 보충

R01~~R12 개선의 실제 코드 반영과 40개 자동 테스트·빌드·타입 검사·lint 통과를 확인했다. 후속 V01 STDIO workspace 전달, V02 취소·deadline telemetry 보존, V03 provider 시험·조회 timeout, V04 resource group 재설정을 모두 보완했다. 이번 재검토에서 확인한 코드 연결 문제는 남아 있지 않다. E2E 재실행은 기존 테스트 포트 점유로 시작하지 못했으며 기존 통과 결과는 역사적 기록으로 유지한다.

기준일: 2026-09-15.

## 전체 검토에 따른 상태 보정

2026-09-13 전체 검토에서 P0~P4의 일부 필수 기능이 미구현 또는 연결되지 않은 것을 확인했다. 아래 기존 단계별 완료 표시는 각 구성 요소의 이전 보고이며, 제품 단계 전체 완료를 뜻하지 않는다. 현재 종합 상태는 **부분 구현, v1 인수 미완료**다. 인증 적용, 실행 도구 정책, UI 연결·에이전트 편집, 입력·출력 검증, 취소·종료 처리 등을 먼저 보완해야 한다. 상세 근거는 [전체 구현 검토](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.

## 전체 검토 후 보완 작업

- **R01 검증 완료:** DPAPI 보호 로컬 접속 토큰, bootstrap/MCP Bearer 인증, 만료되는 UI 세션, 전체 관리 API 인증, localhost Host 허용 목록, 세션 쓰기 요청 Origin·CSRF 검사를 적용했다.
- **R02 검증 완료:** dispatcher 실행 직전 활성 도구 허용 목록과 도구별 인자를 검사하고, tools 실행 모드 및 MCP annotation을 실제 실행 권한과 일치시켰다.
- **R03 구현 완료·부분 검증:** Vite proxy, 서버 정적 UI 제공, CLI bin 경로, `mcpex open`의 bootstrap·fragment 브라우저 접속을 연결했다. 정적 제공 테스트와 로컬 브라우저 렌더링을 확인했다.
- **R04 구현 완료·부분 검증:** 다중 프로바이더/모델 선택, 템플릿 기반 에이전트 생성, 핵심 에이전트 초안 편집·시험·적용·활성화, 실행 목록 API/UI를 연결하고 산출물 없는 web 전용 TypeScript 검사를 추가했다.
- **R05 검증 완료:** 제한된 JSON Schema 2020-12를 적용·호출·출력 단계에 연결하고 MCP HTTP/STDIO 도구 정의에 실제 입력 스키마를 전달한다. JSON 출력과 스키마 불일치, 비JSON, 128KiB 초과를 실패 처리하고 상한 내 원문과 구체 오류 코드를 실행 기록에 보존한다. UI에도 JSON 출력 스키마 편집을 추가했다.
- **R06 구현 완료·부분 검증:** 접수 시 절대 deadline, provider 요청 timeout, UI 취소 API와 MCP caller signal을 모델 fetch·도구까지 전파하고 `cancelled`/`timed_out` 상태를 구분했다. 모의 무응답 provider와 큐 대기·실행 취소는 통과했으며 실제 MCP 클라이언트 취소는 미검증이다.
- **R07 구현 완료·부분 검증:** SIGINT/SIGTERM graceful shutdown, 진행 실행 정리, stale lock 회복·live lock 거부, 초기화 실패 정리와 재시작 interrupted 전환을 구현했다. 저장소 단위·서버 재시작 검증은 통과했으며 실제 CLI 프로세스 signal 검증은 미수행이다.
- **R08 검증 완료:** 허용 명령 설정의 구조·고유 ID·절대 executable 경로를 검증해 실제 `WorkspaceTools`에 전달하고 UI 편집을 연결했다. 서버 tool loop의 allowlisted Node 명령 실행과 상대 executable 적용 거부를 통과했다.
- **R09 검증 완료:** provider와 resource group 동시성 제한을 큐에 연결하고 모델 기본 생성값과 agent override를 병합해 preview·adapter 요청에 적용한다. 동일 provider의 서로 다른 모델 직렬화와 공유 resource group 제한을 통과했다.
- **R10 검증 완료:** STDIO 브리지가 백엔드 tool 목록을 캐시 우회 재조회하고 추가·변경·삭제를 등록 상태에 반영해 상위 클라이언트에 목록 변경을 알린다. 인메모리 MCP 왕복은 통과했으며 실제 STDIO 자식 프로세스 검증은 미수행이다.
- **R11 검증 완료:** DB schema v2에서 run별 해석 완료 설정 스냅샷을 저장하고, 적용 버전에는 에이전트·모델·프로바이더 설정을 함께 고정한다. 인증값은 접수 시 메모리에만 고정한다. UI 시험 실행은 즉시 `202 queued`를 반환하고 상태 API에서 terminal 결과를 조회한다. v1→v2 마이그레이션, 비동기 접수, run 스냅샷, 적용 후 초안과 MCP 설명 분리를 통과했다.
- **R12 검증 완료:** 파일 읽기·교체·기존 파일 hash 확인에 제한 읽기를 공통 적용하고 검색에서 초과 파일을 전체 로드하지 않는다. 파일 목록·검색 결과는 직렬화 크기 예산으로 자르며 명령 stdout/stderr는 실행 중 합산 상한까지만 보관한다. 초과 여부와 관측한 원래 바이트를 observation에 기록한다.
- **P6 프로바이더·모델 관리 검증 완료:** 상세 조회와 expectedRevision 수정, 프로바이더 인증값 제거, 미참조 항목 삭제를 공개 API에 연결했다. 등록 모델이 있는 프로바이더와 현재 초안·적용 버전에서 참조하는 모델의 삭제를 409로 거부한다.
- **P6 템플릿·에이전트 관리 검증 완료:** 기본 템플릿 5종을 누락분만 초기화하고 개인 템플릿 상세·생성·수정·삭제, 선택 설정 묶음 차이와 초안 적용을 구현했다. 개인 템플릿은 모델·workspace·명령 허용을 제거한다. 에이전트 복제와 비활성 soft delete, 적용 후 toolName 변경 금지·삭제 이름 재사용 금지를 API와 UI에 연결했다.
- **추가 실행 안전성 검증 완료:** workspace 잠금 대기 작업을 실행 슬롯 집계 전에 건너뛰어 독립 작업이 진행되게 했다. caller workspace 정책을 UI와 MCP 호출 메타데이터에 연결하고, 누락·허용 루트 이탈 거부와 검증된 실행 경로의 스냅샷 저장을 확인했다.
- **V01 STDIO caller workspace 검증 완료:** 브리지가 `_meta["io.mcpex/workspace"]` 문자열만 백엔드 MCP 호출에 전달하고 다른 임의 메타데이터는 제거한다. 공식 SDK 인메모리 client를 사용해 실제 ToolCatalogBridge 전달 경계를 확인했다.
- **V02 취소 telemetry 보존 검증 완료:** RunQueue가 취소·deadline 오류를 변환할 때 원래 오류를 cause로 보존하고 서버가 cause chain에서 telemetry를 회수한다. read→write 후 timeout된 MCP 실패 envelope에 도구 호출·변경 경로와 완료된 모델 usage가 남는 것을 확인했다.
- **V03 provider 관리 요청 timeout 검증 완료:** 모델 목록 조회와 probe가 provider의 `requestTimeoutMs` 및 클라이언트 연결 종료 signal을 adapter fetch에 전달한다. 무응답 provider에서 두 API가 HTTP 504 `PROVIDER_TIMEOUT`으로 종료됨을 확인했다.
- **V04 resource group 재설정 검증 완료:** 큐의 그룹 제한 맵을 현재 provider 전체의 그룹별 최솟값으로 교체한다. 제한 상향, 그룹 이동, 낮은 제한 provider 삭제 후 동시 실행 한도가 즉시 다시 늘어남을 실제 관리 API와 실행 큐로 확인했다.
- **명령 환경 격리 검증 완료:** `run_command`와 Windows 프로세스 종료 헬퍼가 부모 환경 전체를 상속하지 않고 플랫폼별 최소 OS 변수만 전달한다. 임의 비밀 환경변수와 `NODE_OPTIONS` 차단을 자식 프로세스에서 확인했다.
- **파일 충돌 계약 검증 완료:** 새 파일은 해시 없이 생성할 수 있지만 기존 파일의 전체 쓰기와 텍스트 교체는 직전 `read_file`의 `expectedHash`를 필수로 요구한다. 해시 누락·불일치 거부와 파일 내용 보존, 최신 해시 수정 성공을 확인했다.
- **MCP 실행 결과 계약 검증 완료:** 성공과 애플리케이션 실패 envelope를 `structuredContent`와 JSON 텍스트에 함께 제공한다. 실제 도구 호출 수·변경 경로·명령 결과·잘림, 모든 모델 턴의 usage 합계, 출력 검증 상태와 접수부터 완료까지 duration을 반환한다.
- **P6 실행 이벤트·SSE 검증 완료:** DB schema v3의 `run_events`에 queued/started/model/tool/cancel_requested/finished 이벤트를 실행별 단조 `seq`로 저장한다. SSE는 저장 이벤트를 재생한 뒤 terminal까지 이어 보내며 `afterSeq`와 `Last-Event-ID`로 재개한다. 모델 사용량과 provider request ID를 비밀정보 없이 `model.finished`에 기록한다.
- **P6 설정 이동·보존·백업 검증 완료:** 설정 파일에서 인증값·민감 헤더/필드·절대 작업 폴더·명령 경로를 제거하고, 가져오기 충돌을 미리 본 뒤 새 UUID의 비활성 초안으로 단일 트랜잭션 적용한다. DB schema v4에서 1~365일 보존 설정과 만료 본문·이벤트 정리, SSE 410을 구현했다. migration 전 백업과 사용자 요청 온라인 SQLite 백업을 생성한다.
- **P6 오류 UI·수직 E2E 검증 완료:** API 오류의 HTTP 상태·code·message·details와 상태별 해결 안내를 접근 가능한 alert로 표시하며 실패한 폼 입력을 유지한다. Playwright와 Microsoft Edge로 fragment 인증·제거, provider/model 등록, 서로 다른 템플릿의 agent 2개, 충돌 오류, 시험 실행, 적용·활성화, 실행 기록, 편집 재적용을 통과했다.
- **자동 검증:** 2026-09-15 `npm test` 15개 파일·40개 테스트와 build, typecheck, lint 통과. 이전 `npm run test:e2e` 1개 테스트 통과 이력은 있으나 최신 재실행은 포트 점유로 시작하지 못했다. 설정 이동 화면의 파일 선택 조작과 백업 파일로 서비스를 재기동하는 전체 복구는 미검증이다.

## 설계 및 문서

- **완료:** 제품 범위, 프로바이더/모델/에이전트 분리, 템플릿 편집, MCP 노출 방식 결정.
- **완료:** 기술 스택, 프로세스·모듈 경계, 데이터·API·실행 계약 및 단계별 인수 기준 문서화.
- **문서 검증 완료:** 상대 링크 20개 누락 없음, 새 설계 문서 5개 등록 확인, 새 문서 공백 검사 통과. 앱 검증은 해당하지 않음.
- **P0 구현 완료:** npm workspace, 공유 계약, Node 내장 SQLite 저장소, 데이터 디렉터리 잠금, Windows CurrentUser DPAPI SecretStore, Fastify health/bootstrap/exchange API, CLI serve/open 골격, React 빈 상태 UI, 품질 명령과 P0 테스트를 추가했다.
- **P1 구현 완료:** provider/model 저장소와 CRUD API, DPAPI credential 참조 저장, OpenAI Chat Completions adapter, 모델 목록 조회·응답 probe API, provider URL credential 차단, 프로바이더·모델·응답 시험 UI를 추가했다.
- **P2 구현 완료:** agent/template/run 저장소, 에이전트 초안 CRUD와 expectedRevision 충돌, 불변 적용 버전, 기본 템플릿, 입력 치환 preview, 응답 모드 시험 실행과 실행 기록 조회를 추가했다.
- **P3 구현 완료:** 공식 MCP SDK v2 기반 Streamable HTTP `/mcp`, 활성 에이전트 동적 tool 등록, 비활성 에이전트 차단, MCP 실행 envelope·run 기록, `mcpex mcp` STDIO bridge를 추가했다.
- **P4 구현 완료(부분 검증):** `@mcpex/tools`에 workspace 경로 방어, list/read/search/write/replace 파일 도구, hash 충돌 검사, 출력·크기 한도, shell=false 명령 allowlist 실행기를 추가했다. `@mcpex/providers`의 표준 tool-call 파싱, `@mcpex/runtime`의 동시성 큐·겹치는 workspace 직렬화·반복 실행기를 서버 agent 실행 경로와 연결했다.
- **P5 진행 중:** Anthropic Messages, Gemini `generateContent`, Vertex AI Gemini, Amazon Bedrock Converse adapter와 공통 응답·tool-call 변환, provider-manager 기준의 provider profile registry, 대표 클라우드·로컬 프로필, NovelAI OpenAI 호환 프로필, adapter 선택 UI와 모의 계약 테스트를 추가했다. 실제 연결·취소·오류 경계 검증은 남아 있다.
- 기존 gemma-agent와 참고 플러그인은 별도 자료이며 MCPex에 통합되지 않았다.

## 기능 상태

- 2026-09-16 추가 요구: [UX06–UX08](docs/USABILITY_ISSUES.md)의 Codex 입력칸별 MCP 등록 안내·외부 네트워크 설계, 전체 파일 접근 정책, 호출자 폴더 전달/유효 설정 안내는 **계획·미구현**이다. 기존 UX05 화면 구현 완료와 실제 등록 사용성 인수는 구분한다. README는 현재 기능의 영역별 사용법으로 재작성하고 미완 MCP 등록 절차는 제외했다.

- 실사용 개선 UX01–UX05의 화면과 API 구현 및 자동·모의 브라우저 검증을 완료했다. 실제 사용자 MCP 클라이언트·외부 모델·보조기기와 운영 경계 검증은 별도 미수행 범위다.

2026-09-15 실사용에서 삭제 진입점 부족, 설정별 시험 입력 미지원, 시험 최종 결과 자동 표시 누락, 상단 알림 가시성 문제와 MCP 등록 안내 필요를 접수했다. UX01–UX05는 구현·자동 검증을 완료했다. [실사용 개선 항목](docs/USABILITY_ISSUES.md)에서 상세 상태를 관리한다. 아래 기존 API·모의 검증 완료 표시는 실제 사용자 환경의 수동 검증 완료를 의미하지 않는다.

| 단계                              | 상태                          | 실행 검증                                                                                                                                                     |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 기반·저장·인증                 | 구현 완료(부분 검증)          | 빌드·typecheck·lint·format·P0 테스트·DB 재시작·DPAPI 왕복·평문 미기록 통과; 다른 Windows 계정 복호화 실패와 clean install은 미수행                            |
| P1 프로바이더·모델                | 구현 완료(모의 검증 완료)     | 모의 OpenAI 서버에서 등록→목록 조회→모델 등록→동일 프롬프트 응답 시험 통과; 실제 선택 모델·취소·인증 오류는 미검증                                            |
| P2 에이전트·템플릿·응답           | 구현 완료(모의 검증 완료)     | 초안 생성→미리보기→적용 버전 생성→시험 실행→run 조회와 기본 템플릿 조회를 모의 서버에서 통과; JSON Schema 상세 검증·취소·큐·실제 모델은 미검증                |
| P3 MCP 제공                       | 구현 완료(모의 SDK 검증 완료) | 공식 SDK client로 tools/list·tools/call 통과; 활성화되지 않은 에이전트는 목록에 노출하지 않음; 실제 사용자 클라이언트·취소 전파·재연결은 미검증               |
| P4 자체 도구 실행                 | 구현 완료(부분 검증)          | 파일·명령 도구, provider tool-call 파싱, 모델 반복 실행, 서버 test-run 연결, 큐·workspace 직렬화 모의 검증 통과; 취소·재시작 복구·junction·실제 모델은 미검증 |
| P5 프로바이더 확장                | 진행 중                       | 5개 protocol/native adapter와 provider profile registry, 대표 OpenAI 호환 클라우드·로컬 프로필의 모의 검증 통과; 실제 API·취소·오류 경계는 미검증             |
| P6 v1 통합·운영                   | 구현 완료(부분 검증)          | 관리 CRUD, 템플릿·agent 수명주기, 실행 이벤트/SSE, 설정 이동·보존·백업, 오류 UI와 모의 브라우저 수직 E2E 통과; clean install·실환경 복구는 미검증             |
| 출력 검증·외부 실행기·원격 서비스 | 보류                          | 해당 없음                                                                                                                                                     |

## 확인한 환경과 한계

- 설정 실행기 무반응 보완: Windows 기본 브라우저를 PowerShell `Start-Process`로 호출하고 실행기 종료 상태를 확인하도록 변경했다. 2026-09-16에는 Windows PID 재사용으로 오래된 잠금을 실제 다른 프로세스의 살아 있는 잠금으로 오판한 후속 장애를 수정했다. CLI 빌드·정적 검사, 현재 계정의 VBS 실행 종료 코드 0과 health 정상 응답을 확인했으며 실제 탐색기 더블클릭은 사용자 확인 전까지 미검증이다.

- 로컬 Node.js v24.19.0, npm 11.17.0 확인.
- better-sqlite3는 Node 24.19.0/현재 Windows 환경에서 사전 빌드와 Visual Studio C++ 도구가 없어 설치 실패했다. P0 저장소는 Node 24 내장 `node:sqlite`로 구현했으며 운영 안정성은 추가 검증이 필요하다.
- Windows DPAPI 왕복은 현재 계정에서 확인했다. 다른 Windows 계정 실패 경로, 클라이언트 목록 갱신, 실제 모델 도구 호출은 구현 단계 검증 필요.
- P1/P5 adapter는 `openai-chat`, `anthropic-messages`, `gemini-generate-content`, `vertex-gemini`, `bedrock-converse`를 구현했고 NovelAI는 OpenAI 호환 profile로 지원한다. 실제 외부 API 연결·rate limit·timeout·취소와 Gemini 최신 Interactions API 전환은 미검증이며, 실제 API 키를 사용한 검증은 수행하지 않았다.
- P2 시험 실행은 비동기 접수 후 run 상태를 조회하는 방식이다. 큐·취소·도구 반복·JSON 출력 검증은 P3/P4 실행 경로와 통합되어 있다.
- P3는 공식 `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/node` v2 계열을 사용한다. MCP 취소·재연결과 실제 클라이언트 호환은 후속 검증 대상이다.
- 추가 검증 항목은 [docs/VERIFICATION_GAPS.md](docs/VERIFICATION_GAPS.md)에 별도로 관리한다.
- 네이티브 명령 실행은 OS sandbox가 없다는 설계 제한을 문서화했다.

전체 구현 검토의 R01–R12와 추가 정적 검토에서 확인한 코드 연결 누락을 보완했다. P6 관리·이벤트·설정 이동·보존·백업·오류 UI와 모의 수직 E2E도 마쳤다. 남은 작업은 설정 이동 UI 파일 선택·전체 백업 복구, 실제 MCP 클라이언트·모델·프로세스 종료·파일시스템 경계 등 실환경 검증이다.
