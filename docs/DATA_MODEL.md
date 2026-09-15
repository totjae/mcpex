# 데이터 및 설정 명세

## 1. 공통 규칙

설계 기준선 v1. DB schema_version=1부터 시작한다. ID는 UUID, 시간은 UTC ISO 8601, JSON은 UTF-8이다. 공개 DTO와 DB 행 타입을 분리한다. 설정 JSON에는 schemaVersion을 포함한다. 비밀값은 어느 JSON 설정에도 넣지 않는다.

## 2. 테이블

| 테이블            | 주요 필드 및 제약                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema_migrations | version PK, applied_at                                                                                                                                                                                                                                                                       |
| providers         | id PK, name, adapter, location(cloud/local), config_json, credential_ref nullable, revision, created_at, updated_at                                                                                                                                                                          |
| models            | id PK, provider_id FK RESTRICT, model_id, label, defaults_json, capabilities_json, revision; UNIQUE(provider_id, model_id)                                                                                                                                                                   |
| agents            | id PK, display_name, tool_name UNIQUE, enabled, draft_json, draft_revision, applied_version_id nullable, deleted_at nullable                                                                                                                                                                 |
| agent_versions    | id PK, agent_id FK RESTRICT, version, config_json, created_at; UNIQUE(agent_id, version)                                                                                                                                                                                                     |
| templates         | id PK, origin(builtin/user), name, version, config_json, source_template_id nullable, updated_at                                                                                                                                                                                             |
| capability_probes | id PK, model_id FK, capability, configuration_hash, result(passed/failed/unknown), tested_at, detail_json                                                                                                                                                                                    |
| runs              | id PK, agent_id, agent_version_id nullable, source(mcp/ui), owner_session_id, status, outcome nullable, config_snapshot_json, input_json, output_json nullable, error_json nullable, enqueued_at, started_at nullable, finished_at nullable, deadline_at, cancellation_requested_at nullable |
| run_events        | run_id FK CASCADE, seq, type, payload_json, created_at; PRIMARY KEY(run_id, seq)                                                                                                                                                                                                             |
| secret_refs       | id PK, kind, encrypted_file_name, masked_hint, updated_at                                                                                                                                                                                                                                    |
| app_settings      | key PK, value_json                                                                                                                                                                                                                                                                           |

agent_versions.config_json은 모델·프로바이더를 포함한 적용 시점의 해석 완료 설정을 보관한다. credential_ref만 참조하며 실제 인증값은 포함하지 않는다.

적용 후 초안 변경 폐기는 agents.applied_version_id가 직접 가리키는 agent_versions.config_json의 `agent` 설정을 agents.draft_json으로 복사하고 draft_revision을 증가시킨다. applied_version_id, enabled, 표시 이름, toolName과 runs는 변경하지 않는다. 구형 적용 버전이 해석 완료 envelope 이전 형식이면 저장된 agent config 자체를 복원 원본으로 사용한다.

현재 구현 DB schema v4는 `runs.config_snapshot_json`, `run_events`, 실행 본문·이벤트 만료 시각을 추가하며 이전 DB를 시작 시 순서대로 마이그레이션한다. 적용 버전과 실행 스냅샷에는 에이전트 설정, 모델 ID·기본 생성값·revision, 프로바이더 adapter·base URL·동시성 설정·revision을 저장한다. 실행 이벤트는 run별 단조 `seq`, 종류, 비밀정보를 제외한 payload와 생성 시각을 저장한다. `model.finished`에는 provider별 정규화 usage와 request ID, 성공한 `tool.finished`에는 잘림·원래 크기 같은 observation을 저장한다. 실제 인증값은 저장하지 않고 실행 접수 시 SecretStore에서 읽어 해당 실행의 메모리에만 고정한다.

인덱스: runs(status,enqueued_at), runs(agent_id,enqueued_at), run_events(run_id,seq), models(provider_id). 실행 스냅샷은 에이전트 삭제 후에도 보존한다. 에이전트 삭제는 비활성화 후 soft delete하며 이름을 재사용하지 않는다. 참조 중 프로바이더/모델은 삭제하지 않는다.

## 3. 주요 설정 구조

ProviderConfig:

- baseUrl: 절대 http/https URL. URL 사용자정보·fragment·인증 query 금지. local HTTP 허용.
- headers: 비밀이 아닌 추가 헤더. 인증 헤더는 credential_ref로만 생성.
- requestTimeoutMs: 기본 120000, 1000~1200000.
- maxConcurrency: local 기본 1, cloud 기본 2, 1~8.
- resourceGroup: 선택 문자열. 같은 로컬 서버/GPU 모델의 동시 실행 제한 공유.
- resourceGroupConcurrency: 그룹 사용 시 기본 1. 같은 그룹의 값이 다르면 더 작은 값 적용.
- extraBody: API별 고급 옵션. adapter 소유 필드 변경 금지.

ModelConfig:

- modelId, label, defaultGeneration(temperature/topP/maxOutputTokens 및 adapterOptions).
- capabilities: text/toolCalling/jsonOutput/imageInput 각각 supported/unsupported/unknown 및 출처(user/probe), checkedAt.
- v1 실행 입력은 텍스트만 지원한다. imageInput은 후속 호환 정보이며 이미지 실행 UI는 제공하지 않는다.
- 기능 시험 fingerprint는 adapter/baseUrl/modelId/기능 관련 옵션으로 계산한다. 변경 시 이전 시험은 stale이며 통과 조건으로 사용하지 않는다.

AgentConfig:

```json
{
  "schemaVersion": 1,
  "modelRef": "MODEL_ID_PLACEHOLDER",
  "description": "전달된 문서를 요약할 때 사용한다",
  "systemPrompt": "핵심 주장과 미확인 사항을 구분해 요약한다.",
  "userPromptTemplate": "작업: {{input.task}}\n자료: {{input.context}}",
  "inputSchema": {
    "type": "object",
    "properties": { "task": { "type": "string" }, "context": { "type": "string" } },
    "required": ["task"],
    "additionalProperties": false
  },
  "output": { "format": "markdown" },
  "generationOverrides": {},
  "runtime": {
    "mode": "response",
    "tools": [],
    "timeoutMs": 120000,
    "maxModelTurns": 1,
    "maxToolCalls": 0,
    "workspacePolicy": { "mode": "none", "allowedRoots": [] },
    "commands": []
  }
}
```

도구 모드는 기본 timeoutMs=1200000, maxModelTurns=20, maxToolCalls=50이다. 서비스 상한은 작업 60분, 모델 턴 100, 도구 호출 200. 한도 초과는 limit_exceeded이며 완료로 처리하지 않는다.

output.format은 text/markdown/json. json일 때 output.schema 필수. 사용자 스키마는 JSON Schema 2020-12 중 object/array/string/number/integer/boolean/null, properties/required/additionalProperties/items/enum/const와 기본 길이·수치 제한만 지원한다. `$ref`, 원격 참조, 정규식, 조합 스키마는 v1에서 거부한다. 깊이 8, 스키마 64KiB, 속성 수 100 한도. 내부 DTO는 이 제한의 대상이 아니다.

tools: read_file/list_files/search_text/write_file/replace_text/run_command 중 선택. 실제 허용은 실행 정책과 도구 목록의 교집합이다. 응답 모드는 빈 목록만 허용한다.

workspacePolicy.mode는 none/fixed/caller. none은 allowedRoots가 없어야 하고 fixed는 정확히 한 루트, caller는 하나 이상의 사전 등록된 allowedRoots가 필요하다. caller의 호출 workspace는 절대 경로이며 허용 루트와 같거나 그 하위여야 한다. 프로젝트 루트/사용자 홈 전체/드라이브 전체는 자동 승인하지 않는다. 새 작업 폴더는 UI에서 사용자가 등록한다. 에이전트 입력값만으로 allowedRoots를 추가할 수 없다.

commands는 허용 executable 절대 경로와 표시 이름 목록이다. run_command 입력은 commandId, args 배열, cwd 상대 경로다. 실행기 제약의 한계는 [아키텍처](ARCHITECTURE.md)에 따른다.

## 4. 버전과 원자성

초안 저장은 expectedRevision 비교 후 갱신한다. 다르면 409 CONFLICT. 적용은 단일 트랜잭션으로 모델·연결 설정 해석 → 검증 → agent_version 생성 → applied_version_id 교체 → tool_catalog_revision 증가를 수행한다. 네트워크 기능 시험은 트랜잭션 밖에서 실행하고 적용 시 fingerprint를 대조한다.

적용 버전의 모델·연결 설정은 고정한다. 사용자 변경을 참조 에이전트에 반영하려면 재적용한다. UI는 모델·프로바이더 변경 이후 재적용 필요를 표시한다. 인증값은 실행 시작 시 credential_ref에서 읽고 메모리에서 해당 실행 동안 고정한다. 키 교체는 실행 중 요청에 영향을 주지 않는다.

호출 접수 시 적용 버전과 입력을 runs에 복사한다. 시험 실행은 초안 및 현재 모델 설정을 해석하여 스냅샷을 만들며 agent_version_id=null이다. 실행 스냅샷의 `execution.workspace`에는 검증·정규화된 실제 작업 폴더 또는 null, `execution.workspaceSource`에는 none/fixed/caller를 기록한다. 편집과 실행이 경합해도 스냅샷 일부가 섞이지 않아야 한다.

## 5. 가져오기·내보내기

파일 envelope: format="mcpex-config", schemaVersion=1, exportedAt, providers, models, agents, templates.

실행 기록·비밀값·credential_ref·절대 작업 폴더·실행 명령 경로는 제외한다. 가져오기는 최대 5MiB, JSON만, 미리보기 후 단일 트랜잭션 적용. 새 UUID로 참조를 재매핑하고 이름 충돌을 표시한다. 기존 항목을 자동 덮어쓰지 않는다. 가져온 에이전트는 초안/비활성이고 인증·모델 바인딩·작업 폴더를 재설정한다. 미래 schemaVersion은 오류로 반환한다.

현재 설정 이동 API는 JSON envelope를 반환하고, 미리보기에서 provider 이름·agent toolName·template 이름과 파일 내부 모델 중복 충돌을 표시한다. 적용은 `confirm=true`를 요구하고 모든 항목을 새 UUID로 재매핑해 한 트랜잭션으로 삽입한다. 가져온 provider는 인증값이 없고 agent는 모델·workspace·명령 설정이 제거된 비활성·미적용 초안이다.

DB 백업은 설정 내보내기와 다르다. DB 백업에도 입력·답변이 포함되며 DPAPI 비밀 파일은 별도이다. 수동 백업은 `backups` 디렉터리에 SQLite 온라인 백업을 만들고, schema migration 전에는 기존 DB의 migration 백업을 만든다. 다른 OS 계정으로 비밀 파일을 복사해도 복호화 가능하다고 보장하지 않는다.
