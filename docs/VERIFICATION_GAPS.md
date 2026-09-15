# 추가 검증 항목

## 2026-09-16 VBS 자동 시작 잠금 오판 해결

- 기본 데이터 폴더의 숫자 PID 잠금이 Windows PID 재사용 때문에 현재 `msedgewebview2`를 살아 있는 MCPex로 오판해 `DATA_DIR_LOCKED`와 20초 자동 시작 초과를 일으킨 것을 확인했다.
- PID·프로세스 시작 시각·실행 파일·소유 토큰을 기록하는 version 1 잠금과 기존 숫자 잠금 호환 복구를 구현했다. 새 빌드는 실제 오래된 잠금을 자동 복구했고 `open`, VBS 진입점과 health 검증을 통과했다.
- 탐색기에서 사용자가 직접 더블클릭했을 때의 창 표시 여부는 사용자 확인 전까지 남아 있다. 실제 데이터베이스 내용은 변경하지 않았고 서비스 시작에 필요한 잠금 파일만 새 소유자 정보로 교체됐다.

## 2026-09-15 실사용 차단: 관리 화면 open 인증 실패 — 해결 완료

**상태: 수정·검증 완료.** 실행 중 서버의 메모리 토큰과 현재 `secrets.json`의 DPAPI 토큰이 서로 달라 실제 bootstrap 요청이 401인 것을 비밀값 없이 확인했다. 토큰 파일을 교체한 주체는 확정하지 못했지만, 서버가 암호화된 토큰 항목의 변경을 감지하지 않는 것이 장애를 지속시키는 직접 원인이었다.

### 해결 및 검증

- `DpapiSecretStore`가 암호화된 항목의 SHA-256 revision을 제공하고, 서버는 로컬 인증 요청마다 revision만 비교한다. 값이 바뀐 경우에만 DPAPI로 토큰을 다시 읽어 메모리 캐시를 갱신한다.
- 임시 데이터 폴더 회귀 테스트에서 서버 실행 중 토큰을 교체했다. 이전 토큰은 401로 거부되고 새 토큰은 서버 재시작 없이 bootstrap 200을 반환했다.
- 전체 build, typecheck, lint와 15개 파일·40개 테스트를 통과했다.
- 실제 기본 데이터 폴더의 서비스를 수정 빌드로 재시작한 뒤 현재 DPAPI 토큰으로 bootstrap 200, 일회용 토큰의 세션 교환 200, 세션 기반 provider 목록 API 200을 확인했다. 토큰 원문은 출력·기록하지 않았다.
- 실제 브라우저 실행 버튼 동작, 8시간 세션 만료 후 재접속, 토큰을 교체한 외부 원인의 재현은 별도 검증으로 남긴다.

### 증상과 사용자 실행

사용자는 프로젝트 빌드를 완료하고 아래 명령으로 서버를 실행했다. 터미널에서 `MCPex listening on http://127.0.0.1:47831`을 확인했다.

```powershell
node "C:\Users\Jae\Documents\ChatGPT\MCPex\apps\cli\dist\src\index.js" serve
```

같은 PC에서 관리 화면을 여는 다음 명령은 `MCPex bootstrap failed: HTTP 401`로 실패했다. 사용자 PowerShell에서도 같은 증상이 확인됐다. 실행 위치가 System32였다는 사실만으로 이 오류의 원인을 설명할 수 없다. CLI 경로는 절대 경로이고 기본 데이터 경로는 LOCALAPPDATA 기반이다.

```powershell
node "C:\Users\Jae\Documents\ChatGPT\MCPex\apps\cli\dist\src\index.js" open
```

### 확인한 사실

- 일반 에이전트 제한 환경에서는 먼저 `DPAPI_UNPROTECT_FAILED`가 발생했다. 사용자 환경에서 재실행하면 복호화 단계는 지나가지만 HTTP 401이 발생한다. 두 실패를 같은 원인으로 단정하지 않는다.
- `GET /health`는 HTTP 200, service=mcpex, schemaVersion=4를 반환했다. 서버 미실행이나 다른 종류 서비스의 일반 오류는 아니다.
- 사용자 환경에서 현재 로컬 토큰을 읽어 `POST /auth/bootstrap`에 전달했으나 HTTP 401이었다. 응답 code는 UNAUTHORIZED, message는 '로컬 접속 인증이 필요합니다.'였다. 응답에 비밀값은 없었다.
- 진단 시 서버는 127.0.0.1:47831을 listen했고, listener PID와 기본 데이터 폴더 service.lock의 PID가 일치했다(당시 11088). PID는 일시적 관측값이며 후속 작업에서 다시 확인해야 한다.
- 진단 환경의 LOCALAPPDATA는 `C:\Users\Jae\AppData\Local`이고 MCPEX_DATA_DIR/MCPEX_PORT/MCPEX_URL/MCPEX_MCP_URL override는 확인되지 않았다. 사용자 서버 터미널의 환경까지 동일하다고 검증한 것은 아니다.
- 기본 secrets.json 최종 수정 시각은 진단 당시 2026-09-15T07:36:00.789Z였다. 서버 시작 시각과의 비교는 완료하지 못했다.
- 서버는 시작 시 getLocalAccessToken 결과를 메모리에 보관하고, open은 실행 시 파일에서 토큰을 읽는다. 같은 인증값이 유지되는지 조사할 필요가 있지만 실제 불일치 원인이나 토큰 파일 교체는 아직 입증하지 않았다.
- 토큰·API 키·암호화된 비밀 본문·인증 헤더 값은 문서나 진단 출력에 남기지 않았다. 사용자 서버를 종료하거나 데이터 파일을 삭제하지 않았다.

### 조사할 위치와 가설

- `apps/cli/src/index.ts`: serve/open의 데이터 디렉터리 및 URL 해석, bootstrap 요청.
- `apps/server/src/index.ts`: getLocalAccessToken, 서버 초기화 시 토큰 보관, bearerToken/sameSecret와 인증 hook.
- `packages/storage/src/index.ts`: DpapiSecretStore의 읽기·복호화·쓰기 및 여러 프로세스에서의 변경 가능성.
- 가설: 서버와 CLI의 데이터 경로/사용자 환경 차이, 서버 시작 후 파일 토큰 변경, 요청 처리 과정의 인증값 차이. 아직 어느 것도 확정하지 않았다.

### 후속 수정 및 검증 기준

1. 같은 사용자·명시적으로 동일한 데이터 디렉터리에서 serve/open을 실행해 경로와 서버 소유자를 확인한다. 진단 시 인증값 대신 같음/다름 결과만 사용한다.
2. 서버 시작 시각과 토큰 파일 변경 시점을 비교하고, 토큰 생성·저장 경합 여부를 조사한다. 확인 없이 토큰 파일 전체 삭제나 인증 검사 해제를 해결책으로 사용하지 않는다.
3. 실제 CLI 별도 프로세스로 open → bootstrap → 브라우저 세션 교환 → 관리 API 접근을 검증한다. 현재 인메모리/모의 테스트 성공만으로 해결 처리하지 않는다.
4. 서버 재시작·open 반복 후에도 접근 가능하고 기존 프로바이더 키·등록 설정이 보존되는지 확인한다.
5. 서버 시작 뒤 다른 설정 저장/프로세스 실행으로 인증이 다시 실패하지 않는지 확인한다.

진단 중 서버 프로세스 시작 시각·실행 인자 추가 조회는 자동 승인 검토의 사용량 제한으로 거절되어 수행하지 못했다. 이 제한은 인증 실패 원인과 별개이며 우회하지 않았다.

기준일: 2026-09-13.

이 문서는 구현은 되었거나 모의 환경에서 확인했지만, 실제 운영 조건·보안 경계·외부 클라이언트까지 확인하지 못한 항목을 관리한다. 검증 완료로 바꾸기 전에는 실행 날짜, 명령 또는 환경, 결과와 증거를 함께 기록한다.

## 1. P0 기반·저장·인증

| 항목               | 현재 상태           | 필요한 검증                                                                                                          |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| clean install      | 미검증              | Windows Node 24 환경에서 `npm install`을 스크립트 포함으로 수행하고 native SQLite 의존성 정책을 재확인               |
| SQLite 운영 안정성 | 부분 검증           | migration 사전 백업과 온라인 백업 생성·재열기 통과; 장시간 실행, 동시 접근, 백업 교체 복구, WAL 파일 정리 확인       |
| DPAPI 계정 경계    | 미검증              | 다른 Windows 계정에서 비밀 파일 복호화가 실패하는지 확인하고 실패 오류가 평문 fallback으로 이어지지 않는지 확인      |
| 로컬 인증 보안     | 부분 검증           | 관리 API의 session enforcement, Origin/CSRF/Host 검사, bootstrap token 만료·재사용·로그 비노출 확인                  |
| UI 인증 흐름       | 기본 흐름 검증 완료 | Edge E2E fragment 교환과 실제 기본 데이터의 bootstrap→세션→관리 API 통과; 브라우저 실행·세션 만료 후 재접속은 미검증 |

## 2. P1 프로바이더·모델

| 항목                       | 현재 상태      | 필요한 검증                                                                                                              |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 실제 OpenAI 호환 서버      | 미검증         | 사용자가 제공한 연결에서 인증, 모델 ID, 응답 파싱, rate limit, 5xx, timeout 확인                                         |
| Anthropic/Gemini 실제 서버 | 미검증         | 사용자가 제공한 연결에서 Messages/generateContent 인증, 모델 ID, tool-call, rate limit, 5xx, timeout 확인                |
| Bedrock 실제 서버          | 미검증         | Bedrock API key/IAM 선택, region endpoint, Converse 모델 권한, tool use, rate limit, 5xx, timeout 확인                   |
| Vertex AI 실제 서버        | 미검증         | project/location, OAuth token, IAM 권한, Gemini tool-call, rate limit, 5xx, timeout 확인                                 |
| NovelAI 실제 서버          | 미검증         | Persistent API token, text endpoint/model ID, 응답·streaming·rate limit 확인                                             |
| 취소 전파                  | 부분 검증      | OpenAI mock의 무응답 fetch에서 request timeout과 UI cancel의 실행 기록 반영 통과; 실제 외부 adapter 확인                 |
| 비밀정보 노출              | 부분 검증      | 인증 오류 본문·헤더·URL·로그·run 기록에 API key가 남지 않는지 확인                                                       |
| 모델 수정·삭제 경계        | 모의 검증 완료 | provider/model revision 충돌, 미참조 삭제, agent→model 및 model→provider 참조 중 삭제 차단을 확인; 실제 UI 흐름은 미검증 |

## 3. P2 에이전트·템플릿·응답

| 항목                  | 현재 상태      | 필요한 검증                                                                                                           |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| JSON Schema 입력 검증 | 부분 검증      | 금지 키워드·누락 필드·MCP schema 전달은 통과; 추가 필드, 깊이·크기 경계값과 오류 위치 상세 확인                       |
| 템플릿 적용           | 모의 검증 완료 | 기본/개인 CRUD, sanitization, 선택 묶음 미리보기·적용과 비선택 초안 보존 통과; 실제 브라우저 조작은 미검증            |
| 불변 버전 스냅샷      | 부분 검증      | run 스냅샷과 적용 후 초안/MCP metadata 분리는 통과; 모델·provider 수정 API 구현 후 기존 적용 버전 불변성 확인         |
| 출력 형식             | 모의 검증 완료 | JSON 코드펜스 성공, 비JSON·스키마 불일치, 원문 보존, OUTPUT_LIMIT과 INVALID_OUTPUT 확인                               |
| 실행 취소·큐          | 부분 검증      | 비동기 접수·terminal 조회, 대기 deadline, running UI 취소, timeout, 재시작 interrupted 전환 통과; 실제 부하 검증 필요 |

## 4. P3 MCP

| 항목                | 현재 상태 | 필요한 검증                                                                                  |
| ------------------- | --------- | -------------------------------------------------------------------------------------------- |
| 실제 STDIO bridge   | 미검증    | `mcpex mcp`를 별도 프로세스로 실행하고 stdout에 MCP 메시지만 출력되는지 확인                 |
| 실제 MCP 클라이언트 | 미검증    | 사용자가 선택한 MCP 클라이언트에서 연결·목록·호출·재연결 확인                                |
| MCP 취소            | 미검증    | Streamable HTTP 연결 종료 또는 client cancellation이 모델 fetch와 run 상태에 전파되는지 확인 |
| 목록 변경 알림      | 부분 검증 | 인메모리 브리지의 캐시 우회 갱신·추가·삭제·알림 통과; 실제 STDIO 프로세스와 클라이언트 확인  |
| 인증·DNS rebinding  | 미검증    | `/mcp`의 로컬 인증, Host/Origin 허용 목록, 외부 인터페이스 바인딩 차단 확인                  |

## 5. P4 자체 도구 실행

| 항목                    | 현재 상태                | 필요한 검증                                                                                                                     |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 파일 도구 코어          | 모의 통합 검증 완료      | 서버 tool call과 제한 읽기·검색 제외·목록/검색 결과 상한 확인; 실제 사용자 workspace와 장시간 RSS는 미검증                      |
| junction·경쟁 경로 방어 | 미검증                   | 경로 요소 교체 경쟁, junction, UNC와 재검사 동작 확인                                                                           |
| 모델 tool-call loop     | 구현·모의 통합 검증 완료 | provider 정규화, 메시지 누적, 도구 오류 재입력, maxToolCalls·maxModelTurns와 서버 test-run 연결 확인; 실제 모델별 동작은 미검증 |
| 실행 큐·workspace 잠금  | 구현·부분 검증           | 동시성·workspace 직렬화·대기 deadline·caller 취소·provider/resource 한도·재시작 복구 확인; workspace 대기 슬롯 점유는 미검증    |
| 명령 취소·프로세스 트리 | 구현·부분 검증           | 설정 검증·allowlist 실행과 stdout/stderr 수집 상한 통과; timeout·AbortSignal·부분 출력 보존과 실제 프로세스 트리 종료 검증 필요 |
| 외부 영향 범위 안내     | 미구현                   | UI/MCP 도구 설명에 파일 내용 외부 모델 전송과 명령 실행 권한 표시                                                               |

## 6. 검증 기록 규칙

- 모의 검증과 실제 외부 연결 검증을 같은 결과로 기록하지 않는다.
- 실제 API 키, token, 입력 원문, 개인 파일 경로는 기록하지 않는다.
- 실패한 검증은 원인과 재시도 조건을 남기며 해결 전 검증 완료로 바꾸지 않는다.
- 완료된 항목은 이 문서의 표에 날짜와 간단한 증거를 추가하거나, 상세 결과가 필요하면 `TEST_PLAN.md`에 연결한다.

## 7. 보류·미결정

- `better-sqlite3` native 모듈을 다시 도입할지, Node 내장 SQLite를 유지할지는 운영 호환성 검증 후 결정한다.
- 외부 OS sandbox 없이 명령 도구를 허용할지 여부는 P4 보안 검토 후 결정한다.
- Gemini adapter는 현재 공식 `generateContent` REST 계약을 사용한다. 최신 Interactions API로 전환할지는 실제 agentic workflow 검증 후 결정한다.
