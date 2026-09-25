# API 및 실행 계약

## UX16 서비스 티어 (2026-09-25)

모델 생성/PATCH는 별도 `serviceTier`(`provider-default`/`auto`/`default`/`flex`/`priority`)를 받고 모델 DTO에서 반환한다. 새 모델 기본값 `provider-default`는 요청 필드 생략이다. 에이전트 초안의 `serviceTier`는 `inherit`(기본), `provider-default` 또는 명시 티어이며 숫자 전용 `generationOverrides`와 별개다. 우선순위는 에이전트 명시 선택 → 모델 기본 선택 → 기존 프로바이더 고급 값/필드 생략이다. `auto`는 필드 생략과 다르다.

전용 티어 선택은 `profileId=openai`, `adapter=openai-chat`, `baseUrl=https://api.openai.com/v1` 조합에만 허용한다. 그 밖의 연결은 지원 미확인으로 표시하고 명시 티어 저장을 400 또는 실행 준비 시 422로 거부한다. 실제 모델·계정 자격은 사전 확인하지 않으며 공급자가 거부하면 오류를 그대로 돌려주고 다른 티어로 재시도하지 않는다. 직접 OpenAI 요청에서는 명시 선택이 기존 `extraBody.service_tier`를 덮어쓰고 `provider-default`는 요청에서 이 키를 제거한다. 저장된 extraBody와 다른 헤더는 수정하지 않는다. 미확인 공급자의 기존 고급 값은 호환성을 위해 그대로 전달한다.

모델 probe 응답은 `requestedServiceTier`, `actualServiceTier`를 분리한다. 에이전트 preview의 `serviceTier`는 `{requested,source}`이며 실제 처리 티어는 없다. 실행의 매 `model.finished` 이벤트는 요청/실제 티어와 출처를 기록하고 GET `/runs`·`/runs/:id`의 `serviceTiers`에서 턴별로 조회할 수 있다. 공급자 응답에 티어가 없으면 `actual=null`(확인 불가), 이벤트가 만료되면 목록 전체가 `null`이다. 적용·실행 스냅샷에 모델/에이전트 선택을 보존하고 MCP 도구 인자에는 추가하지 않는다. 큐·동시 실행·제한시간은 자동 변경하지 않는다. 공식 근거: [OpenAI Chat Completions](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create), [서비스 티어 오류](https://developers.openai.com/api/docs/guides/error-codes).

## 대상 변경 결과 조회 (2026-09-24)

대상 지정 실행의 GET `/runs`, GET `/runs/:id`와 terminal 취소 응답은 `targetChanges`를 제공한다. 값은 성공한 `write_target`/`replace_target` 이벤트의 `{tool,targetId}` 배열이며 실제 변경이 없으면 `[]`, 보존 만료로 판단할 근거가 없으면 `null`이다. 대상 지정 이전 실행에는 필드가 없다. 입력의 targets 목록을 성공한 변경으로 간주하지 않으며 파일 경로를 이 필드에 포함하지 않는다. 이미 발생한 쓰기 뒤 실행이 실패·취소돼도 해당 성공 이벤트는 유지된다.

## 실행별 대상 파일 지정 (2026-09-23 1차 구현)

`runtime.targetBinding` 기본값은 `off`이며, `optional` 에이전트만 공개 MCP 인자 또는 관리 시험의 `input.targets`를 해석한다. 선택 스키마는 `targets` 배열(1~32개), 항목은 `id`(영문자로 시작, 이후 영숫자·`_`·`-`, 최대 64자), `path` 문자열, `access`(`read`/`write`/`readwrite`)만 허용한다. 생략은 기존 탐색 실행이고 빈 배열·null·잘못된 항목은 입력 오류다. optional 적용 시 입력 스키마의 `targets`가 공통 계약과 일치해야 한다.

접수 전 경로·중복 ID/경로·기존 도구 권한을 검증한다. 오류는 `INVALID_TARGETS`, `TARGET_WORKSPACE_REQUIRED`, `DUPLICATE_TARGET_ID`, `DUPLICATE_TARGET_PATH`, `TARGET_TOOL_UNAVAILABLE` 또는 기존 경로 오류 코드로 반환하며 대상 오류에는 가능한 경우 `targetId`를 포함한다. 원시 경로는 대상 오류 메시지에 반사하지 않는다. 대상 실행에는 `read_target(targetId,startLine?,maxLines?)`, `write_target(targetId,content,expectedHash?)`, `replace_target(targetId,oldText,newText,expectedHash)`만 허용하고 직접 경로 도구·`run_command`는 실행 경계에서 차단한다. `write`는 새 파일만 배타 생성하고 `readwrite` 수정에는 읽은 해시가 필요하다. 결과 `observations.changes`는 대상 실행에서 `targetId`를 사용하며 기존 탐색 실행의 `path`는 유지한다. 대상 경로는 로컬 실행 스냅샷에 남지만 모델용 자동 메시지와 대상 도구 결과에서는 제외된다.

## 1. 관리 API

prefix `/api/v1`. JSON camelCase. 성공은 데이터 객체, 오류는 `{error:{code,message,details?}}`. 목록은 `{items,nextCursor}`이며 limit 기본 50/최대 200. 인증 전 health는 민감한 버전·경로 없이 상태만 반환한다. UI·MCP 인증과 CSRF는 [아키텍처](ARCHITECTURE.md)에 따른다.

`/auth/bootstrap`과 `/mcp`, 로컬 bearer 인증 관리 API는 DPAPI로 보호된 로컬 접속 토큰을 사용한다. 실행 중 암호화 토큰 항목이 교체되면 서버가 revision 변경을 감지해 다음 로컬 인증 요청 전에 메모리 값을 갱신한다.

bootstrap 교환은 만료된 UI 세션을 정리하고, 요청 쿠키가 가리키는 기존 세션만 새 쿠키 세션으로 대체한다. 다른 브라우저의 유효 세션은 유지한다. 새 교환 요청이 없으면 만료 세션 Map 항목의 즉시 삭제를 보장하지 않는다.

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

프로바이더 PATCH는 같은 provider ID와 참조를 유지하며 생략한 headers·extraBody를 보존한다. extraBody 일부를 전달하면 기존 키와 병합한다. 인증값 PUT/DELETE는 설정 PATCH와 별개이며 선택적 `expectedRevision`을 받는다. 값이 현재 revision과 다르면 변경 전 409를 반환하고, 성공 시 새 revision과 `hasCredential`만 반환한다. 편집 화면은 설정 저장 뒤 인증값 변경이 실패할 수 있으므로 두 결과를 구분한다.

`discover-models`와 `probes`는 해당 provider에 저장된 `requestTimeoutMs`를 사용하고 클라이언트 HTTP 연결이 먼저 종료되면 진행 중인 adapter 요청도 취소한다. 제한 시간이 먼저 만료되면 `{error:{code:"PROVIDER_TIMEOUT",message}}`를 반환한다.

시험 실행 접수 응답은 `{runId,status:"queued"}`이며 모델 완료·실패를 기다리지 않는다. 이후 `GET /runs/:id`의 `status`, `output`, `error`, `configSnapshot`으로 terminal 결과와 접수 시점 설정을 확인한다. `configSnapshot`에는 실제 인증값이 포함되지 않는다.

`workspacePolicy.mode=caller`인 시험 실행은 본문의 `workspace`에 절대 경로를 전달한다. MCP 호출은 요청 `_meta["io.mcpex/workspace"]`에 같은 값을 전달한다. STDIO 브리지는 이 MCPex 전용 문자열 키만 HTTP backend 호출로 전달하고 다른 임의 메타데이터는 중계하지 않는다. `input.workspace`는 에이전트 입력일 뿐 실행 workspace로 해석하지 않는다. 서버는 workspace 값을 에이전트 입력과 분리해 검증하며, 누락은 `WORKSPACE_REQUIRED`, 절대 경로가 아니거나 사전 등록된 `allowedRoots` 밖이면 `WORKSPACE_NOT_ALLOWED`로 거부한다. 검증된 실제 경로와 출처는 run `configSnapshot.execution`에 고정한다. 사용자 정의 메타데이터를 보낼 수 없는 클라이언트에 대한 자동 fallback은 없으며, 고정 폴더 정책을 사용해야 한다.

`workspacePolicy.mode=fixed`와 caller의 선택된 실행 workspace에서는 파일 도구 `path`와 `run_command.cwd`에 작업 폴더 기준 상대 경로 또는 그 범위 내부 절대 경로를 사용할 수 있다. 두 표기는 같은 실제 대상으로 정규화하며 범위 밖·다른 드라이브·부모 이동·심볼릭 링크/junction은 `PATH_FORBIDDEN`으로 거부한다. 설정된 실제 workspace 문자열은 MCP·모델 도구 설명에 넣지 않고 도구 결과 경로는 작업 폴더 기준 상대 표기를 사용한다.

`workspacePolicy.mode=full`은 호출 workspace를 받지 않고 실행 snapshot의 source를 `full`로 고정한다. 파일 도구 path와 `run_command.cwd`는 절대 경로만 허용하고 상대 경로는 `PATH_FORBIDDEN`, 현재 OS 사용자 권한의 `EACCES`/`EPERM`은 `ACCESS_DENIED`로 반환한다. 선택 도구와 명령 allowlist는 별도로 적용되며 전체 접근이 이를 자동 활성화하지 않는다. full 실행은 모든 scoped workspace 실행과 전역 직렬화한다.

개인 템플릿 생성은 `{name,agentId}` 또는 `{name,config}`를 받으며 모델 바인딩, workspace 절대 경로, 명령 설정과 `run_command` 허용을 제거한다. 템플릿 수정은 `expectedVersion`을 사용하고 builtin은 수정·삭제할 수 없다. 재적용 sections는 `description`, `prompts`, `input`, `output`, `generation`, `runtime`이며 생략하면 전체 묶음을 적용한다. 적용해도 에이전트의 현재 modelRef는 유지한다.

서버 시작 시 코드가 소유한 builtin 템플릿은 저장된 정의와 다르면 같은 ID에서 버전을 올려 갱신한다. 기존 에이전트의 초안과 적용 버전은 자동 변경하지 않는다. `GET /agents`의 `appliedScopeMissing`은 적용 버전의 입력 스키마에 scope가 있으나 사용자 메시지 템플릿에 `{{input.scope}}`가 없을 때 true다. 관리 화면은 초안도 함께 검사해 영향 후보를 표시하고, 기존 `template-preview`와 `template-apply`의 `sections:["prompts"]`로 메시지만 선택 적용한다.

에이전트 복제는 새 `toolName`이 필수이며 현재 초안을 revision 1의 비활성·미적용 에이전트로 복사한다. 활성 에이전트 삭제는 거부하고 비활성 에이전트는 soft delete한다. `toolName`은 미삭제 에이전트 사이에서만 고유하다. 삭제된 이름으로 새 에이전트를 만들거나 복제할 수 있으며 새 ID의 비활성·미적용 초안으로 시작하고 이전 버전·실행 기록은 삭제된 ID에 남는다. 생성·복제·초안 이름 변경·가져오기는 동일한 규칙을 따르며 미삭제 동명 에이전트와 충돌하면 409를 반환한다. 허용 이름은 소문자 ASCII·숫자·밑줄뿐이므로 이름 비교는 대소문자 변환 없이 정확히 일치한다. 최초 적용 후 toolName 변경은 복제로 처리한다.

초안 변경 폐기는 현재 `applied_version_id`가 가리키는 불변 스냅샷의 agent 설정을 복원 원본으로 사용한다. 요청의 `expectedRevision`이 현재 초안과 다르면 409로 거부하고, 성공 시 초안 revision만 증가시킨다. 표시 이름, toolName, 활성 상태, 적용 버전 포인터와 실행 기록은 변경하지 않는다. 적용 전 에이전트는 이 API를 사용할 수 없으며 비활성화 후 에이전트 전체 삭제로 정리한다.

`GET /mcp-connection`은 현재 서비스가 CLI에서 받은 로컬 STDIO `command`, 분리된 `args`, 필요한 경우에만 환경변수, 활성 적용 버전의 도구 이름·설명을 반환한다. 각 활성 도구에는 적용 버전의 `runtimeMode`, `workspaceMode`, 실제 모델에 제공될 `effectiveTools`, `workspaceState`(`response_only`, `no_tools`, `workspace_disabled`, `fixed`, `caller_required`, `full`)를 포함해 MCP 등록 상태와 내부 파일 작업 가능 상태를 구분한다. 웹 화면은 원시 연결 값으로 Codex 입력칸별 복사 값과 공식 `[mcp_servers.mcpex]` TOML을 생성하며 패스스루와 `cwd`는 현재 빈 선택 항목으로 안내한다. 비활성 또는 미적용 에이전트는 사유와 함께 별도 목록으로 반환한다. 응답의 서비스 상태는 관리 API 응답 여부이고 `clientConnection.status=unverified`는 실제 MCP 클라이언트 연결을 아직 확인하지 않았다는 뜻이다. 인증 토큰과 provider credential은 반환하지 않는다. 서버 모듈을 CLI 밖에서 직접 실행해 등록 경로를 확정할 수 없으면 `registration`은 `null`이다. 원격 HTTP 등록 정보는 반환하지 않는다.

같은 `resourceGroup`에 속한 provider가 여러 개면 현재 구성원의 `resourceGroupConcurrency` 최솟값을 그룹 실행 제한으로 사용한다. provider 생성·수정·그룹 이동·삭제와 설정 가져오기가 성공하면 현재 provider 전체를 기준으로 즉시 다시 계산하므로 과거의 더 낮은 제한을 유지하지 않는다.

설정 내보내기는 `mcpex-config` schemaVersion 1 JSON envelope를 반환하며 실행 기록, 인증값·credential 참조, 민감한 header/필드, 절대 작업 폴더와 명령 경로를 제외한다. 가져오기 미리보기는 `{config}`를 받고 충돌과 항목 수를 반환한다. 적용은 `{config,confirm:true}`를 받아 새 UUID로 참조를 재매핑하고 한 트랜잭션으로 생성한다. 충돌 시 409 `IMPORT_CONFLICT`로 전체 적용을 거부한다. 설정 파일 본문은 최대 5MiB이다.

settings의 `retentionDays`는 1~~365, `globalConcurrency`는 1~~8, `maxPendingRuns`는 1~1000이다. PATCH 시 만료된 terminal 실행의 입력·출력·오류·설정 스냅샷과 이벤트를 정리하되 실행 요약과 만료 시각은 보존한다. `/backups`는 인증 파일을 제외한 현재 DB를 데이터 디렉터리의 `backups` 아래에 생성하며 파일명, 경로, 크기와 페이지 수를 반환한다.

서버가 소유하는 일반 DTO는 Zod로 검증한다. 사용자 입력 스키마는 데이터로 저장하고 Ajv로 검증한다. 사용자 스키마를 Fastify의 동적 컴파일 route schema에 직접 등록하지 않는다.

## 2. MCP 도구 계약

활성 적용 버전의 toolName/description/inputSchema를 tools/list로 제공한다. 정렬은 toolName 기준이다. 실효 파일 도구가 있으면 파일 도구 결과의 모델 제공자 전달과 클라우드 외부 전송 가능성을 description에 추가하고, 실효 `run_command`가 있으면 현재 OS 사용자 권한 실행과 OS sandbox가 아님을 추가한다. 자체 관리 설정을 변경하는 MCP 도구는 v1에 노출하지 않는다. 모든 관리 작업은 UI/API로 수행한다.

도구 호출 인자는 에이전트 inputSchema 자체다. 별도 agentId 입력이 필요하지 않다. 접수 후 runId를 생성하고 완료까지 기다린다. 오래 걸리는 작업은 지원 클라이언트에 progress 알림을 전달한다. MCP Tasks 확장 의존은 v1에 넣지 않는다.

tools/call 응답은 공통 envelope를 structuredContent와 JSON 텍스트 content 양쪽에 제공한다:

```json
{
  "contractVersion": "1",
  "runId": "RUN_ID_PLACEHOLDER",
  "status": "completed",
  "outcome": "succeeded",
  "output": { "format": "markdown", "value": "요약 결과" },
  "observations": {
    "toolCalls": 0,
    "changes": [],
    "checks": [],
    "toolFailures": [],
    "truncated": false
  },
  "validation": { "format": "not_required", "model": "not_configured" },
  "verification": { "status": "not_verified", "evidence": { "checks": [], "toolFailures": [] } },
  "usage": { "promptTokens": 120, "completionTokens": 30, "totalTokens": 150 },
  "error": null,
  "durationMs": 1200
}
```

status: queued/running/completed/failed/cancelled/timed_out/interrupted. 최종 MCP 반환은 terminal 상태만 사용한다. 기존 `completed`와 `outcome=succeeded`는 실행·출력 형식이 정상 종료됐다는 의미로 유지하며 내용의 사실성·사용자 요구 충족을 보증하지 않는다. 별도 `verification.status`는 `not_verified`/`passed`/`failed`를 구분하지만, 명시된 과제 합격 기준이 없는 현행 구현은 자동으로 `passed` 또는 `failed`를 부여하지 않는다. 모델의 자기 보고나 파일 변경 0건만으로 과제 검증을 판정하지 않는다.

`observations.toolCalls`는 성공·실패를 포함해 실제 실행을 시도한 도구 호출 수다. `changes`는 성공한 `write_file`/`replace_text`의 도구명과 상대 경로, `checks`는 `run_command`의 commandId와 exitCode, `toolFailures`는 도구 실패 코드를 기록한다. `verification.evidence`는 실제 관측한 checks/toolFailures를 그대로 제공하지만 명령 exit 0만으로 과제 통과를 뜻하지 않는다. 어느 도구 결과든 잘렸으면 `truncated=true`다. `usage`는 provider가 보고한 모든 모델 턴의 정규화 token 합계이며 보고하지 않는 provider에서는 null이다. `durationMs`는 큐 접수부터 terminal 결과까지의 경과 시간이다. 출력이 JSON 스키마 검증을 통과하면 `validation.format=passed`, 별도 검증 모델은 v1에서 항상 `not_configured`다.

작업 폴더 도구의 `path`와 명령 `cwd`는 fixed/caller 실행 기준 폴더의 상대 경로 또는 범위 내부 절대 경로를 받는다. Windows의 `C:foo`·드라이브 없는 루트 경로는 `AMBIGUOUS_PATH`, 따옴표·file URI·`~`·환경변수 표기는 `PATH_FORMAT_UNSUPPORTED`로 반환한다. 없는 경로는 `ENOENT`, 그 밖의 경로 포함 OS 오류는 `PATH_ERROR`의 안전한 안내로 바꾼다. 목록 도구가 허용되어 있으면 scoped는 `list_files`의 path=`.`, full은 사용자가 제공한 경로의 존재하는 상위 폴더를 절대 경로로 탐색하도록 안내한다. 목록 도구가 없으면 정책에 맞는 경로 재확인을 안내한다. 실제 루트나 OS 원시 예외 경로를 메시지에 주입하지 않는다. 범위 밖과 링크는 `PATH_FORBIDDEN`, 접근 거부는 `ACCESS_DENIED`다. 오류 시 다른 폴더로 자동 대체하거나 해시 충돌을 강제 덮어쓰기하지 않는다.

실행·형식 실패, 취소, 시간 초과, partial/blocked는 isError=true이며 등록 콜백에 도달한 요청은 실패 envelope도 structuredContent와 JSON 텍스트에 동일하게 제공한다. 잘못된 도구 이름·입력 스키마 같은 프로토콜 인자는 SDK 프로토콜 오류를 사용하므로 애플리케이션 envelope가 없을 수 있다. 정상 결과는 isError=false. SDK 버전별 structuredContent와 annotations API 차이는 통합 모듈 안에 격리한다.

목록/설명/스키마/활성 변경은 커밋 후 catalogRevision 이벤트를 발생시킨다. 서버·브리지는 목록 변경 알림을 전파한다. 구형 목록으로 비활성 도구가 호출되면 AGENT_INACTIVE, 변경된 입력이 맞지 않으면 INVALID_INPUT을 반환한다. 도구 실행 직전 현재 공개 상태를 확인한다.

readOnlyHint는 실제 파일 쓰기·명령 도구 유무에서 계산한다. 외부 API 호출이 있는 클라우드 연결에는 openWorldHint=true. annotations는 실행 권한을 강제하지 않는다.

## 3. 실행 상태와 큐

```text
queued → running → completed / failed / cancelled / timed_out / interrupted
queued → cancelled / timed_out / interrupted
```

전역 동시 실행 기본 2, 허용 1~8. 대기 작업 최대 100. 프로바이더 및 resourceGroup 한도를 함께 적용한다. 같은 resourceGroup의 제한은 현재 provider 구성원이 설정한 값의 최솟값이며, 서버 시작·설정 가져오기·provider 생성·수정·이동·삭제 후 전체 제한 맵을 다시 계산한다. workspace를 사용하는 작업은 겹치는 루트(부모·자식 포함)마다 하나만 실행하며 읽기 작업도 v1에서는 직렬화한다. workspace 잠금을 기다리는 작업은 queued 상태를 유지하고 전역/provider/resourceGroup 실행 슬롯을 점유하지 않는다. 이는 MCPex 내부 작업 간 잠금이며 외부 편집기는 막지 않는다.

대기열은 실행 가능 작업 중 FIFO로 선택한다. 기존 `runtime.timeoutMs`만 있는 에이전트는 접수부터 종료까지의 전체 제한(기본 120초, API 1ms~~60분, 화면 1초~~60분)을 유지한다. `queueTimeoutMs`와 `executionTimeoutMs`를 함께 설정하면 접수부터 시작까지의 대기 제한과 시작부터 종료까지의 실행 제한을 각각 적용한다(각 1초~60분). 한 필드만 설정하거나 범위를 벗어나면 저장을 거부한다. 대기 만료는 `QUEUE_TIMEOUT`, 실행 만료는 `EXECUTION_TIMEOUT`, 기존 전체 제한 만료는 `DEADLINE`, 사용자 취소는 `CANCELLED`로 기록한다. 제한된 자원을 기다리는 작업이 다른 프로바이더의 작업을 막지 않도록 건너뛸 수 있다.

공급자 단일 요청 제한은 `PROVIDER_TIMEOUT`으로 `timed_out` 처리한다. 모델 반복 수와 도구 호출 수 제한은 각각 `MODEL_TURN_LIMIT`, `TOOL_CALL_LIMIT`으로 `failed` 처리하며 시간 초과로 표시하지 않는다. 기존 `DEADLINE`은 접수 기준 전체 시간 제한에 계속 사용한다.

MCP 도구 카탈로그는 `_meta["io.mcpex/bridgeTimeoutMs"]`에 유효한 서버 최대 대기(기존 전체 제한 또는 대기+실행 제한)에 응답 여유 15초를 더해 게시한다. STDIO 브리지는 이를 backend 호출 timeout으로 사용한다. 외부 MCP 클라이언트 자체의 timeout은 별도이며 이 값으로 제어할 수 없다. 공급자 `requestTimeoutMs`는 개별 모델 HTTP 요청의 제한(기본 120초, 1초~20분)으로 에이전트 실행 제한과 별개다.

실행 조회의 `createdAt`, `startedAt`, `finishedAt`으로 대기·실행·전체 시간을 계산한다. 시작 전 만료된 작업의 `startedAt`은 null이다. 현재 대기 원인 `waitReason`은 `workspace`/`provider`/`resourceGroup`/`global` 중 하나이며, 실행 시점에 동적으로 계산하므로 실행 이력에는 저장하지 않는다. 오래된 실행에서 시작 이벤트까지 이미 정리됐다면 `startedAt`은 null이다.

접수 시 설정 스냅샷 저장 → 입력·정책 검사 → 큐 → 실행 슬롯 및 workspace 잠금 → 인증 조회 → 프롬프트 구성 → 모델 호출 → 필요 시 도구 실행 → 반복 → 출력 검사 → 최종 저장 → 반환.

취소는 AbortSignal을 모델 HTTP·도구에 전달한다. 큐가 취소·deadline을 공통 오류로 정규화할 때 원래 실행 오류를 cause로 보존하므로, 이미 수행한 도구 변경·검사와 완료된 모델 usage를 terminal MCP envelope에서 잃지 않는다. 정상 명령 트리 종료 및 도구 정리가 끝나기 전 슬롯/잠금을 풀지 않는다. Windows 명령 트리 종료를 확인하지 못하면 원 실행을 `failed`/`COMMAND_TERMINATION_FAILED`로 기록하고 겹치는 작업 폴더·전체 접근 작업을 `WORKSPACE_BLOCKED`(접수 HTTP 409)로 거절한다. 부모 종료만으로 취소 완료로 간주하지 않는다. 차단은 로컬 DB 설정에 보존하고 서비스 재시작 후 복원하며 시간 경과로 자동 해제하지 않는다. 종료 요청 시 새 접수를 막고 10초 정리 후 프로세스를 종료한다.

인증된 관리 API `GET /api/v1/safety-blocks`는 차단된 작업 폴더, 원인, PID·생성 시각 목록을 반환한다(로컬 절대 경로이므로 MCP 공개 설명에는 넣지 않는다). `POST /api/v1/safety-blocks/:id/verify`는 모든 저장된 조상 기준으로 후손을 다시 조회하고 새 식별자를 영속 저장한다. 생존 시 409 `COMMAND_PROCESS_STILL_RUNNING`, 조회·저장 실패 시 503 `PROCESS_INSPECTION_FAILED`다. 생존 목록이 비어도 관측 사이에 사라진 중간 조상의 후손까지 부재를 증명할 수 없으므로 409 `PROCESS_INSPECTION_INCOMPLETE`로 차단을 유지한다. 기존 차단 기록에도 동일 정책을 적용하며 이 API는 자동 해제하지 않는다. 독립된 OS 도구에서 전체 트리 종료를 직접 확인한 운영자만 `POST /api/v1/safety-blocks/:id/manual-release`에 정확한 `workspace`와 `confirm=I_VERIFIED_PROCESS_TREE_EXITED`를 제출해 수동 해제할 수 있다. 수동 해제도 발견된 후손을 저장하며 생존 시 409, 기록이 있는 경우 조회·저장 실패 시 503으로 거부한다. 식별 기록이 처음부터 없는 경우에는 운영자의 독립 확인에 의존한다. 두 POST 모두 기존 관리 API 인증·CSRF를 적용한다.

서비스 재시작 시 queued/running은 interrupted로 마감한다. 자동 재실행하지 않는다. 실행 중 발생한 파일 변경은 보존하며 자동 rollback하지 않는다. 스냅샷 없는 중복 클라이언트 호출의 exactly-once 실행을 보장하지 않는다. 통신 실패 후 상위 호출자가 재호출하면 새 작업이다.

## 4. 모델 및 도구 반복

response 모드는 모델 1회 호출이며 도구 요청을 받으면 UNEXPECTED_TOOL_CALL. agent 모드는 도구 호출 시험 passed인 모델만 사용한다.

도구 호출의 이름·인자를 검증하고 정책을 적용한 뒤 순차 실행한다. 여러 도구를 한 번에 요청해도 v1에서는 병렬 실행하지 않는다. 잘못된 인자나 충돌은 구체적인 도구 오류 code와 message로 모델에 반환하며 maxToolCalls에 포함한다. 모델은 `EXPECTED_HASH_REQUIRED` 또는 `HASH_CONFLICT`를 받으면 파일을 다시 읽은 뒤 최신 해시로 재시도할 수 있다. 모르는 도구·권한 위반도 실행하지 않고 오류 결과를 전달한다.

기본 내장 도구:

| 도구         | 입력과 동작                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list_files   | scoped는 상대 또는 범위 내부 절대 path, full은 필수 절대 path; depth·제외 폴더·결과 한도 적용                                                                                   |
| read_file    | scoped는 상대 또는 범위 내부 절대 path, full은 절대 path; 시작 line, 최대 lines, UTF-8 텍스트와 hash 반환                                                                       |
| search_text  | scoped는 상대 또는 범위 내부 절대 path, full은 절대 path; literal query로 정규식·shell 실행 없이 탐색                                                                           |
| write_file   | scoped는 상대 또는 범위 내부 절대 path, full은 절대 path; 새 파일 생성, 기존 파일은 read_file의 expectedHash 필수                                                               |
| replace_text | scoped는 상대 또는 범위 내부 절대 path, full은 절대 path; oldText/newText/expectedHash로 일치 1개만 교체                                                                        |
| run_command  | allowlist가 있을 때 commandId enum·label을 모델에 제공(executable 비공개); args[]; scoped는 선택 상대 또는 범위 내부 절대 cwd, full은 필수 절대 cwd; 최소 OS 환경에서 실행·관측 |

읽기 기본 최대 파일 1MiB, 호출 결과 64KiB, 검색 최대 200건, 목록 2000건. 쓰기 최대 1MiB. 명령 기본 120초, 작업 잔여 시간 이하, 출력 64KiB까지 저장. 초과는 truncated와 원래 크기를 반환한다. .git, node_modules, 빌드·캐시 폴더는 기본 탐색 제외하며 설정에서 추가 제외 가능하다.

파일은 크기를 확인한 뒤 제한된 양만 읽으며 검사 후 파일이 커지는 경우에도 한도 초과를 감지한다. 검색은 읽기 한도를 넘는 파일을 건너뛰고 `truncated=true`로 표시한다. 목록·검색의 항목 배열과 명령의 stdout/stderr 합계는 호출 결과 바이트 예산을 공유하며, 명령 출력은 프로세스 종료 후가 아니라 수신 단계에서 보관량을 제한한다.

파일 편집은 낙관적 동시성 계약을 사용한다. `read_file`이 반환한 SHA-256 hash를 기존 파일의 `expectedHash`로 전달해야 하며 누락은 `EXPECTED_HASH_REQUIRED`, 불일치는 `HASH_CONFLICT`다. 해시 없이 허용되는 `write_file`은 대상이 없는 새 파일 생성뿐이다. `createOnly=true`에서 대상이 이미 있으면 `ALREADY_EXISTS`다. 실패 시 기존 파일 내용은 유지한다. 텍스트 도구 관측은 직접 수행한 변경이며 명령이 수정한 모든 파일을 포괄하지 않는다. observations에 관측 범위와 잘림을 표시한다. 명령 exit 0은 테스트 통과 주장과 구분한다.

공급업체 요청은 429/일시적 5xx 중 응답 본문·도구 호출을 소비하지 않은 경우만 최대 2회 재시도한다. Retry-After와 남은 deadline을 준수하고 그 외는 1초/2초 지연한다. 전송 후 연결 단절처럼 처리 여부가 불명확한 실패는 자동 재시도하지 않는다. 도구 실행·명령은 자동 재시도하지 않는다.

문맥은 누적 메시지를 유지한다. v1 자동 요약은 없다. 한도 초과는 CONTEXT_LIMIT으로 종료한다. 입력 JSON 최대 256KiB, 최종 모델 텍스트 128KiB, MCP envelope 최대 256KiB. 출력 초과는 OUTPUT_LIMIT이며 JSON을 잘라 정상 결과처럼 반환하지 않는다. 보관 원문도 상한 내 부분만 보관하고 잘림을 명시한다.

## 5. 출력과 이벤트

자유 텍스트·Markdown은 원문을 유지한다. json은 JSON 객체/배열과 선언된 스키마를 검사한다. 전체를 감싼 코드펜스 하나는 허용하되 앞뒤 자연어는 형식 오류다. 오류 시 status=failed, error.code=INVALID_OUTPUT, output에 상한 내 rawText를 보존한다. 자동 모델 재호출은 없다.

이벤트 종류: run.queued, run.started, model.started, model.finished, tool.started, tool.finished, run.cancel_requested, run.finished. seq는 DB 커밋 순서로 증가한다. SSE는 저장 이벤트를 재생하고 이후 이벤트를 이어 보낸다. 보존 기간이 지난 이벤트 요청은 410 EVENTS_EXPIRED. 숨겨진 추론 과정은 수집·표시하지 않는다.

`tool.finished` 실패 이벤트는 `ok: false`와 `error: { code: "PATH_FORBIDDEN" }` 같은 오류 코드를 포함한다. 코드가 없거나 유효한 형식이 아니면 `TOOL_ERROR`를 사용한다. `diagnostic`에는 `pathNotation`(absolute/relative/ambiguous/omitted), `relativeTarget`(검증된 작업 루트 안에서만, 최대 512자), `expectedHashProvided`(쓰기·교체에서만 boolean), `reason`(정형 코드)을 기록한다. 범위 밖 절대 경로와 full 접근 경로는 `relativeTarget: null`로 마스킹한다. 원시 도구 인자·해시 값·파일 내용·예외 메시지·인증값은 저장하지 않는다. 이전 버전의 이벤트에는 `error` 또는 `diagnostic`이 없을 수 있다.

현재 `GET /api/v1/runs/:id/events`는 `afterSeq` 쿼리 또는 `Last-Event-ID` 헤더 이후의 저장 이벤트를 100건씩 재생하고, 실행이 terminal 상태가 될 때까지 새 이벤트를 이어 보낸 뒤 스트림을 닫는다. 느린 연결에서는 drain까지 다음 배치를 보내지 않으며 연결별 조회·파싱 오류는 해당 스트림만 닫는다. `model.finished`에는 정규화한 usage와 provider request ID를 기록한다. 보존 기간이 지나 이벤트가 정리된 실행은 410 `EVENTS_EXPIRED`와 만료 시각을 반환한다.

코드 보고의 주장과 observations를 별도로 보관한다. validation.model은 v1에서 항상 not_configured. 후속 검증 모델은 원본 출력 이후 별도 단계·별도 사용량·별도 오류로 추가하고 실행 성공 상태를 덮어쓰지 않는다.
