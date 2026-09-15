# API 및 실행 계약

## 1. 관리 API

prefix `/api/v1`. JSON camelCase. 성공은 데이터 객체, 오류는 `{error:{code,message,details?}}`. 목록은 `{items,nextCursor}`이며 limit 기본 50/최대 200. 인증 전 health는 민감한 버전·경로 없이 상태만 반환한다. UI·MCP 인증과 CSRF는 [아키텍처](ARCHITECTURE.md)에 따른다.

`/auth/bootstrap`과 `/mcp`, 로컬 bearer 인증 관리 API는 DPAPI로 보호된 로컬 접속 토큰을 사용한다. 실행 중 암호화 토큰 항목이 교체되면 서버가 revision 변경을 감지해 다음 로컬 인증 요청 전에 메모리 값을 갱신한다.

| Method / 경로                               | 계약                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| GET /health                                 | 서비스 준비 여부                                                  |
| POST /auth/exchange                         | 일회용 토큰을 UI 세션으로 교환                                    |
| GET, POST /providers                        | 목록, 등록                                                        |
| GET, PATCH, DELETE /providers/:id           | 상세·수정·참조 확인 삭제                                          |
| PUT, DELETE /providers/:id/credential       | 비밀값 교체·제거; 조회에서는 maskedHint만                         |
| POST /providers/:id/discover-models         | 공급업체 목록 조회; 저장 모델 변경 없음                           |
| GET, POST /models                           | 등록 모델 목록·생성                                               |
| GET, PATCH, DELETE /models/:id              | 상세·수정·삭제                                                    |
| POST /models/:id/probes                     | 응답/도구 호출/JSON 기능 시험; 결과 및 fingerprint                |
| GET, POST /agents                           | 목록·초안 생성                                                    |
| GET, PATCH, DELETE /agents/:id              | 상세·expectedRevision 초안 저장·soft delete                       |
| POST /agents/:id/draft-discard              | expectedRevision 기준으로 적용 버전 설정에서 초안 변경 폐기       |
| POST /agents/:id/duplicate                  | 비활성 초안 복제; 새 toolName 필수                                |
| POST /agents/:id/apply                      | expectedRevision을 적용하고 불변 버전 생성                        |
| PUT /agents/:id/activation                  | `{enabled:boolean}`; 적용 버전 및 호환성 검사                     |
| POST /agents/:id/preview                    | 입력으로 최종 메시지·옵션·정책 미리보기; 모델 호출 없음           |
| POST /agents/:id/test-runs                  | 초안 시험 실행; `{input,expectedRevision,workspace?}` → 202 runId |
| GET, POST /templates                        | 목록·사용자 템플릿 생성                                           |
| GET, PATCH, DELETE /templates/:id           | 상세·사용자 템플릿 수정·삭제; builtin 수정 불가                   |
| POST /agents/:id/template-preview           | 템플릿 적용 차이                                                  |
| POST /agents/:id/template-apply             | templateId/선택 묶음/expectedRevision으로 초안 변경               |
| GET /runs, GET /runs/:id                    | 실행 목록·상세                                                    |
| POST /runs/:id/cancel                       | 멱등 취소 요청; terminal이면 현재 상태                            |
| GET /runs/:id/events                        | SSE; Last-Event-ID 또는 afterSeq 기반 재개                        |
| POST /config/export                         | 비밀정보 제외 설정 파일 생성                                      |
| POST /config/import-preview, /config/import | 해석·충돌 미리보기 후 적용                                        |
| GET, PATCH /settings                        | 보존·전역 큐 제한 등; 접속 토큰 조회 불가                         |
| POST /backups                               | 현재 SQLite DB의 온라인 백업 생성                                 |
| GET /mcp-connection                         | CLI 명령·인자와 연결 상태; 비밀값 제외                            |

필드 검증 400, 인증 401, 권한 403, 없음 404, 충돌/참조중/비활성 409, 본문 초과 413, 의미·기능 불일치 422, 큐 초과 429, 공급업체 오류 502, 서비스 미준비 503, 공급업체 제한 시간 504 `PROVIDER_TIMEOUT`. 생성 201, 비동기 시험 202, 삭제 204. PATCH는 expectedRevision 필수이며 성공 시 새 revision을 반환한다.

`discover-models`와 `probes`는 해당 provider에 저장된 `requestTimeoutMs`를 사용하고 클라이언트 HTTP 연결이 먼저 종료되면 진행 중인 adapter 요청도 취소한다. 제한 시간이 먼저 만료되면 `{error:{code:"PROVIDER_TIMEOUT",message}}`를 반환한다.

시험 실행 접수 응답은 `{runId,status:"queued"}`이며 모델 완료·실패를 기다리지 않는다. 이후 `GET /runs/:id`의 `status`, `output`, `error`, `configSnapshot`으로 terminal 결과와 접수 시점 설정을 확인한다. `configSnapshot`에는 실제 인증값이 포함되지 않는다.

`workspacePolicy.mode=caller`인 시험 실행은 본문의 `workspace`에 절대 경로를 전달한다. MCP 호출은 요청 `_meta["io.mcpex/workspace"]`에 같은 값을 전달한다. STDIO 브리지는 이 MCPex 전용 문자열 키만 HTTP backend 호출로 전달하고 다른 임의 메타데이터는 중계하지 않는다. 서버는 workspace 값을 에이전트 입력과 분리해 검증하며, 누락은 `WORKSPACE_REQUIRED`, 절대 경로가 아니거나 사전 등록된 `allowedRoots` 밖이면 `WORKSPACE_NOT_ALLOWED`로 거부한다. 검증된 실제 경로와 출처는 run `configSnapshot.execution`에 고정한다.

개인 템플릿 생성은 `{name,agentId}` 또는 `{name,config}`를 받으며 모델 바인딩, workspace 절대 경로, 명령 설정과 `run_command` 허용을 제거한다. 템플릿 수정은 `expectedVersion`을 사용하고 builtin은 수정·삭제할 수 없다. 재적용 sections는 `description`, `prompts`, `input`, `output`, `generation`, `runtime`이며 생략하면 전체 묶음을 적용한다. 적용해도 에이전트의 현재 modelRef는 유지한다.

에이전트 복제는 새 `toolName`이 필수이며 현재 초안을 revision 1의 비활성·미적용 에이전트로 복사한다. 활성 에이전트 삭제는 거부하고 비활성 에이전트는 soft delete한다. 삭제된 toolName은 재사용하지 않으며 최초 적용 후 toolName 변경은 복제로 처리한다.

초안 변경 폐기는 현재 `applied_version_id`가 가리키는 불변 스냅샷의 agent 설정을 복원 원본으로 사용한다. 요청의 `expectedRevision`이 현재 초안과 다르면 409로 거부하고, 성공 시 초안 revision만 증가시킨다. 표시 이름, toolName, 활성 상태, 적용 버전 포인터와 실행 기록은 변경하지 않는다. 적용 전 에이전트는 이 API를 사용할 수 없으며 비활성화 후 에이전트 전체 삭제로 정리한다.

`GET /mcp-connection`은 현재 서비스가 CLI에서 받은 STDIO `command`, 분리된 `args`, 필요한 경우에만 환경변수, 활성 적용 버전의 도구 이름·설명을 반환한다. 비활성 또는 미적용 에이전트는 사유와 함께 별도 목록으로 반환한다. 응답의 서비스 상태는 관리 API 응답 여부이고 `clientConnection.status=unverified`는 실제 MCP 클라이언트 연결을 아직 확인하지 않았다는 뜻이다. 인증 토큰과 provider credential은 반환하지 않는다. 서버 모듈을 CLI 밖에서 직접 실행해 등록 경로를 확정할 수 없으면 `registration`은 `null`이다.

같은 `resourceGroup`에 속한 provider가 여러 개면 현재 구성원의 `resourceGroupConcurrency` 최솟값을 그룹 실행 제한으로 사용한다. provider 생성·수정·그룹 이동·삭제와 설정 가져오기가 성공하면 현재 provider 전체를 기준으로 즉시 다시 계산하므로 과거의 더 낮은 제한을 유지하지 않는다.

설정 내보내기는 `mcpex-config` schemaVersion 1 JSON envelope를 반환하며 실행 기록, 인증값·credential 참조, 민감한 header/필드, 절대 작업 폴더와 명령 경로를 제외한다. 가져오기 미리보기는 `{config}`를 받고 충돌과 항목 수를 반환한다. 적용은 `{config,confirm:true}`를 받아 새 UUID로 참조를 재매핑하고 한 트랜잭션으로 생성한다. 충돌 시 409 `IMPORT_CONFLICT`로 전체 적용을 거부한다. 설정 파일 본문은 최대 5MiB이다.

settings의 `retentionDays`는 1~~365, `globalConcurrency`는 1~~8, `maxPendingRuns`는 1~1000이다. PATCH 시 만료된 terminal 실행의 입력·출력·오류·설정 스냅샷과 이벤트를 정리하되 실행 요약과 만료 시각은 보존한다. `/backups`는 인증 파일을 제외한 현재 DB를 데이터 디렉터리의 `backups` 아래에 생성하며 파일명, 경로, 크기와 페이지 수를 반환한다.

서버가 소유하는 일반 DTO는 Zod로 검증한다. 사용자 입력 스키마는 데이터로 저장하고 Ajv로 검증한다. 사용자 스키마를 Fastify의 동적 컴파일 route schema에 직접 등록하지 않는다.

## 2. MCP 도구 계약

활성 적용 버전의 toolName/description/inputSchema를 tools/list로 제공한다. 정렬은 toolName 기준이다. 자체 관리 설정을 변경하는 MCP 도구는 v1에 노출하지 않는다. 모든 관리 작업은 UI/API로 수행한다.

도구 호출 인자는 에이전트 inputSchema 자체다. 별도 agentId 입력이 필요하지 않다. 접수 후 runId를 생성하고 완료까지 기다린다. 오래 걸리는 작업은 지원 클라이언트에 progress 알림을 전달한다. MCP Tasks 확장 의존은 v1에 넣지 않는다.

tools/call 응답은 공통 envelope를 structuredContent와 JSON 텍스트 content 양쪽에 제공한다:

```json
{
  "contractVersion": "1",
  "runId": "RUN_ID_PLACEHOLDER",
  "status": "completed",
  "outcome": "succeeded",
  "output": { "format": "markdown", "value": "요약 결과" },
  "observations": { "toolCalls": 0, "changes": [], "checks": [], "truncated": false },
  "validation": { "format": "not_required", "model": "not_configured" },
  "usage": { "promptTokens": 120, "completionTokens": 30, "totalTokens": 150 },
  "error": null,
  "durationMs": 1200
}
```

status: queued/running/completed/failed/cancelled/timed_out/interrupted. 최종 MCP 반환은 terminal 상태만 사용한다. outcome: succeeded/partial/blocked/failed/null. completed는 실행 완료이며 내용의 사실성·사용자 요구 충족을 보증하지 않는다. 일반 텍스트는 모델의 성공 주장을 별도 판독하지 않는다. 코드 보고 템플릿은 구조화된 reportStatus를 outcome에 반영할 수 있다.

`observations.toolCalls`는 성공·실패를 포함해 실제 실행을 시도한 도구 호출 수다. `changes`는 성공한 `write_file`/`replace_text`의 도구명과 상대 경로, `checks`는 `run_command`의 commandId와 exitCode를 기록한다. 어느 도구 결과든 잘렸으면 `truncated=true`다. `usage`는 provider가 보고한 모든 모델 턴의 정규화 token 합계이며 보고하지 않는 provider에서는 null이다. `durationMs`는 큐 접수부터 terminal 결과까지의 경과 시간이다. 출력이 JSON 스키마 검증을 통과하면 `validation.format=passed`, 별도 검증 모델은 v1에서 항상 `not_configured`다.

실행·형식 실패, 취소, 시간 초과, partial/blocked는 isError=true이며 등록 콜백에 도달한 요청은 실패 envelope도 structuredContent와 JSON 텍스트에 동일하게 제공한다. 잘못된 도구 이름·입력 스키마 같은 프로토콜 인자는 SDK 프로토콜 오류를 사용하므로 애플리케이션 envelope가 없을 수 있다. 정상 결과는 isError=false. SDK 버전별 structuredContent와 annotations API 차이는 통합 모듈 안에 격리한다.

목록/설명/스키마/활성 변경은 커밋 후 catalogRevision 이벤트를 발생시킨다. 서버·브리지는 목록 변경 알림을 전파한다. 구형 목록으로 비활성 도구가 호출되면 AGENT_INACTIVE, 변경된 입력이 맞지 않으면 INVALID_INPUT을 반환한다. 도구 실행 직전 현재 공개 상태를 확인한다.

readOnlyHint는 실제 파일 쓰기·명령 도구 유무에서 계산한다. 외부 API 호출이 있는 클라우드 연결에는 openWorldHint=true. annotations는 실행 권한을 강제하지 않는다.

## 3. 실행 상태와 큐

```text
queued → running → completed / failed / cancelled / timed_out / interrupted
queued → cancelled / timed_out / interrupted
```

전역 동시 실행 기본 2, 허용 1~8. 대기 작업 최대 100. 프로바이더 및 resourceGroup 한도를 함께 적용한다. 같은 resourceGroup의 제한은 현재 provider 구성원이 설정한 값의 최솟값이며, 서버 시작·설정 가져오기·provider 생성·수정·이동·삭제 후 전체 제한 맵을 다시 계산한다. workspace를 사용하는 작업은 겹치는 루트(부모·자식 포함)마다 하나만 실행하며 읽기 작업도 v1에서는 직렬화한다. workspace 잠금을 기다리는 작업은 queued 상태를 유지하고 전역/provider/resourceGroup 실행 슬롯을 점유하지 않는다. 이는 MCPex 내부 작업 간 잠금이며 외부 편집기는 막지 않는다.

대기열은 실행 가능 작업 중 FIFO로 선택한다. 작업 deadline은 접수 시점부터 계산하며 대기 시간도 포함한다. 제한된 자원을 기다리는 작업이 다른 프로바이더의 작업을 막지 않도록 건너뛸 수 있다.

접수 시 설정 스냅샷 저장 → 입력·정책 검사 → 큐 → 실행 슬롯 및 workspace 잠금 → 인증 조회 → 프롬프트 구성 → 모델 호출 → 필요 시 도구 실행 → 반복 → 출력 검사 → 최종 저장 → 반환.

취소는 AbortSignal을 모델 HTTP·도구에 전달한다. 큐가 취소·deadline을 공통 오류로 정규화할 때 원래 실행 오류를 cause로 보존하므로, 이미 수행한 도구 변경·검사와 완료된 모델 usage를 terminal MCP envelope에서 잃지 않는다. 명령 트리 종료 및 도구 정리가 끝나기 전 슬롯/잠금을 풀지 않는다. 정리 실패 시 해당 workspace를 차단 상태로 유지하고 관리자 조치가 필요하다는 오류를 기록한다. 종료 요청 시 새 접수를 막고 10초 정리 후 프로세스를 종료한다.

서비스 재시작 시 queued/running은 interrupted로 마감한다. 자동 재실행하지 않는다. 실행 중 발생한 파일 변경은 보존하며 자동 rollback하지 않는다. 스냅샷 없는 중복 클라이언트 호출의 exactly-once 실행을 보장하지 않는다. 통신 실패 후 상위 호출자가 재호출하면 새 작업이다.

## 4. 모델 및 도구 반복

response 모드는 모델 1회 호출이며 도구 요청을 받으면 UNEXPECTED_TOOL_CALL. agent 모드는 도구 호출 시험 passed인 모델만 사용한다.

도구 호출의 이름·인자를 검증하고 정책을 적용한 뒤 순차 실행한다. 여러 도구를 한 번에 요청해도 v1에서는 병렬 실행하지 않는다. 잘못된 인자나 충돌은 구체적인 도구 오류 code와 message로 모델에 반환하며 maxToolCalls에 포함한다. 모델은 `EXPECTED_HASH_REQUIRED` 또는 `HASH_CONFLICT`를 받으면 파일을 다시 읽은 뒤 최신 해시로 재시도할 수 있다. 모르는 도구·권한 위반도 실행하지 않고 오류 결과를 전달한다.

기본 내장 도구:

| 도구         | 입력과 동작                                                                             |
| ------------ | --------------------------------------------------------------------------------------- |
| list_files   | 상대 path, depth; 제외 폴더·결과 한도 적용                                              |
| read_file    | 상대 path, 시작 line, 최대 lines; UTF-8 텍스트와 hash 반환                              |
| search_text  | 상대 path, literal query; 정규식·shell 실행 없이 탐색                                   |
| write_file   | 상대 path, content; 새 파일은 바로 생성, 기존 파일은 read_file의 expectedHash 필수      |
| replace_text | 상대 path, oldText, newText, read_file의 expectedHash 필수; 일치 1개만 교체             |
| run_command  | 설정 commandId, args[], 상대 cwd; 최소 OS 환경에서 실행하고 stdout/stderr/exitCode 관측 |

읽기 기본 최대 파일 1MiB, 호출 결과 64KiB, 검색 최대 200건, 목록 2000건. 쓰기 최대 1MiB. 명령 기본 120초, 작업 잔여 시간 이하, 출력 64KiB까지 저장. 초과는 truncated와 원래 크기를 반환한다. .git, node_modules, 빌드·캐시 폴더는 기본 탐색 제외하며 설정에서 추가 제외 가능하다.

파일은 크기를 확인한 뒤 제한된 양만 읽으며 검사 후 파일이 커지는 경우에도 한도 초과를 감지한다. 검색은 읽기 한도를 넘는 파일을 건너뛰고 `truncated=true`로 표시한다. 목록·검색의 항목 배열과 명령의 stdout/stderr 합계는 호출 결과 바이트 예산을 공유하며, 명령 출력은 프로세스 종료 후가 아니라 수신 단계에서 보관량을 제한한다.

파일 편집은 낙관적 동시성 계약을 사용한다. `read_file`이 반환한 SHA-256 hash를 기존 파일의 `expectedHash`로 전달해야 하며 누락은 `EXPECTED_HASH_REQUIRED`, 불일치는 `HASH_CONFLICT`다. 해시 없이 허용되는 `write_file`은 대상이 없는 새 파일 생성뿐이다. `createOnly=true`에서 대상이 이미 있으면 `ALREADY_EXISTS`다. 실패 시 기존 파일 내용은 유지한다. 텍스트 도구 관측은 직접 수행한 변경이며 명령이 수정한 모든 파일을 포괄하지 않는다. observations에 관측 범위와 잘림을 표시한다. 명령 exit 0은 테스트 통과 주장과 구분한다.

공급업체 요청은 429/일시적 5xx 중 응답 본문·도구 호출을 소비하지 않은 경우만 최대 2회 재시도한다. Retry-After와 남은 deadline을 준수하고 그 외는 1초/2초 지연한다. 전송 후 연결 단절처럼 처리 여부가 불명확한 실패는 자동 재시도하지 않는다. 도구 실행·명령은 자동 재시도하지 않는다.

문맥은 누적 메시지를 유지한다. v1 자동 요약은 없다. 한도 초과는 CONTEXT_LIMIT으로 종료한다. 입력 JSON 최대 256KiB, 최종 모델 텍스트 128KiB, MCP envelope 최대 256KiB. 출력 초과는 OUTPUT_LIMIT이며 JSON을 잘라 정상 결과처럼 반환하지 않는다. 보관 원문도 상한 내 부분만 보관하고 잘림을 명시한다.

## 5. 출력과 이벤트

자유 텍스트·Markdown은 원문을 유지한다. json은 JSON 객체/배열과 선언된 스키마를 검사한다. 전체를 감싼 코드펜스 하나는 허용하되 앞뒤 자연어는 형식 오류다. 오류 시 status=failed, error.code=INVALID_OUTPUT, output에 상한 내 rawText를 보존한다. 자동 모델 재호출은 없다.

이벤트 종류: run.queued, run.started, model.started, model.finished, tool.started, tool.finished, run.cancel_requested, run.finished. seq는 DB 커밋 순서로 증가한다. SSE는 저장 이벤트를 재생하고 이후 이벤트를 이어 보낸다. 보존 기간이 지난 이벤트 요청은 410 EVENTS_EXPIRED. 숨겨진 추론 과정은 수집·표시하지 않는다.

현재 `GET /api/v1/runs/:id/events`는 `afterSeq` 쿼리 또는 `Last-Event-ID` 헤더 이후의 저장 이벤트를 재생하고, 실행이 terminal 상태가 될 때까지 새 이벤트를 이어 보낸 뒤 스트림을 닫는다. `model.finished`에는 정규화한 usage와 provider request ID를 기록한다. 보존 기간이 지나 이벤트가 정리된 실행은 410 `EVENTS_EXPIRED`와 만료 시각을 반환한다.

코드 보고의 주장과 observations를 별도로 보관한다. validation.model은 v1에서 항상 not_configured. 후속 검증 모델은 원본 출력 이후 별도 단계·별도 사용량·별도 오류로 추가하고 실행 성공 상태를 덮어쓰지 않는다.
