# LLM Gateway 서비스 티어 확장 작업 인계

## 1. 목적과 상태

2026-09-26 사용자 요청. **OpenAI 호환 Chat Completions 형식 구현 완료 / 모의 검증 완료 / 실제 LLM Gateway 미검증**. 직접 OpenAI 연결에 한정됐던 서비스 티어 선택을 공식 LLM Gateway 연결로 확장했다. 신규 프리셋과 공식 URL 판정을 추가했으며 기존 등록·저장 설정을 변경하지 않았다.

사용자 확정 요구:

- 모델 기본 티어와 에이전트별 상속/재정의를 LLM Gateway에서도 사용한다.
- 응답 시험의 `서비스 티어 — 요청: …, 실제: …` 표시는 그대로 둔다. 필드 생략/확인 불가일 때 숨기는 변경은 하지 않는다.
- 기존 등록된 프로바이더·모델·에이전트를 삭제하거나 재등록하도록 요구하지 않는다.

## 2. 조사 근거와 현재 코드

2026-09-26 확인한 공식 자료:

- [LLM Gateway Service Tiers](https://docs.llmgateway.io/features/service-tiers): 요청의 `service_tier`로 `auto`, `default`, `flex`, `priority`를 지정한다. 지원 여부는 공급자/모델 매핑에 달려 있으며 미지원 티어는 400 `unsupported_service_tier`, 일부 플랜의 Priority 제한은 403이다. 필드 생략 시 게이트웨이 기본 설정의 영향을 받을 수 있다. 실제 처리 티어 관련 `used_service_tier` 메타데이터도 설명한다.
- [Chat Completions API](https://docs.llmgateway.io/v1_chat_completions): OpenAI 호환 Chat Completions 요청 계약. 이번 조사에서 응답 예시에는 `metadata`가 있지만 `used_service_tier`의 정확한 중첩 경로는 확인되지 않았다. 구현자는 공식 소스 또는 비밀정보를 제거한 응답으로 확인해야 한다.
- [공식 시작점](https://docs.llmgateway.io/): 기본 API 주소는 `https://api.llmgateway.io/v1`.

모델 이름만으로 티어 지원을 추정하지 않는다. 사용자가 표시한 모델의 실제 지원·계정 자격·요금은 이번에 시험하지 않았다. 위 외부 서비스 계약은 구현 시 재확인한다.

작업 전 구현의 연결 지점(아래 표는 조사 이력):

| 위치 | 현재 동작 / 수정 검토 지점 |
| --- | --- |
| `packages/providers/src/index.ts` | `providerProfiles`에 LLM Gateway 프리셋 없음. openai-chat 어댑터는 이미 `service_tier`를 전송하고, 응답 최상위 `service_tier`만 읽음 |
| `apps/server/src/index.ts` | `supportsServiceTier`가 openai 프로필 + openai-chat + 공식 OpenAI URL만 허용 |
| 동일 파일 | `requireServiceTierSupport`, `effectiveServiceTier`, 모델 probe의 별도 계산, provider DTO의 지원 표시를 함께 확인해야 함 |
| `apps/web/src/main.tsx` | 서버의 `serviceTierSupport`로 모델/에이전트 선택을 비활성화. 프로바이더/모델 변경 시 티어 처리도 확인 |
| `tests/service-tier.test.ts` | 기존 직접 OpenAI 회귀를 확장할 기준 |

## 3. 구현 범위와 결정

### 3.1 공급자 인식

1. LLM Gateway 프리셋을 추가한다. 제안 ID `llmgateway`, 어댑터 `openai-chat`, cloud, 공식 기본 URL, 인증 필수로 구성한다. 기존 프리셋 저장 구조를 재사용한다.
2. 기존 사용자 등록은 표시 이름 `llmgtw` 등의 문자열로 판정하지 않는다. **openai-chat + 공식 LLM Gateway 엔드포인트**이면 기존 profileId와 무관하게 티어 요청을 지원하도록 한다. 기존 OpenAI 판정도 유지한다.
3. URL은 URL 파서로 프로토콜·호스트·포트·경로를 검사하고 `/v1`의 끝 슬래시를 정규화한다. 유사 도메인·하위 도메인·다른 경로·HTTP·다른 어댑터는 자동 지원으로 간주하지 않는다. 기존 URL 보안 검증을 약화하지 않는다.
4. LLM Gateway 프리셋을 선택했어도 URL을 임의 프록시로 변경하면 자동 지원 판정은 해제한다. 모든 OpenAI 호환 서버에 선택을 풀지는 않는다.
5. self-hosted/별도 도메인은 1차 자동 판정 범위 밖이다. 사용자의 실제 주소가 공식 주소와 다르면 공식 URL로 강제 변경하지 말고 해당 연결 계약을 확인한 뒤 명시적 capability 설정 등의 후속 범위를 결정한다. 실제 주소·API key를 문서에 복사하지 않는다.

`supported`는 티어 요청 형식을 지원한다는 의미다. 모든 모델·계정이 모든 티어를 사용할 수 있다는 보증으로 표시하지 않는다.

### 3.2 저장·상속·전송

기존 모델 `serviceTier`, 에이전트 `inherit`/재정의와 적용 스냅샷을 재사용한다. 새로운 티어 저장 테이블이나 별도 어댑터는 필요하지 않다.

| 선택 | 전송 정책 |
| --- | --- |
| 에이전트 inherit | 모델의 설정을 따른다 |
| provider-default | 요청에서 `service_tier` 제거. 게이트웨이 기본 처리에 맡기며 `default`로 치환하지 않는다 |
| auto/default/flex/priority | 선택한 문자열을 요청 본문 `service_tier`로 전송 |
| 기존 null/미설정 | 기존 고급 `extraBody.service_tier` 호환 동작 유지 |

- 우선순위는 에이전트 명시 선택 → 모델 선택 → 기존 고급 값/생략을 유지한다.
- 명시 선택은 고급 값보다 우선하고, provider-default는 요청 사본에서만 해당 키를 제거한다. 저장된 extraBody·다른 헤더·다른 생성 옵션은 보존한다.
- probe와 에이전트 실행의 분기된 계산을 함께 수정한다. 모델 시험, 초안 시험, 적용된 MCP 실행 및 모든 반복 턴에 동일 정책이 적용되어야 한다.
- 모델/에이전트의 저장·검증·preview·적용·가져오기/내보내기·프로바이더 URL 변경 시 재검증을 확인한다. 이미 접수된 실행의 스냅샷은 변경하지 않는다.
- 게이트웨이가 미지원/플랜 제한으로 거절하면 HTTP 상태와 오류를 사용자에게 전달한다. MCPex가 티어를 빼거나 더 비싼 티어/다른 모델로 자동 재시도하지 않는다. 게이트웨이 자체 라우팅 설정은 이 작업에서 바꾸지 않는다.

### 3.3 실제 처리 티어와 화면

- 기존 요청/실제 티어 구분과 결과 문구를 유지한다. 요청 `flex`를 실제 값으로 복사하지 않는다.
- 최상위 `service_tier` 처리 회귀를 유지한다. LLM Gateway가 다른 메타데이터 필드로만 반환한다면 공식 응답 경로를 먼저 확정하고 최소한의 공급자별 추출을 추가한다. 임의 필드를 재귀 검색하거나 요청 메타데이터를 실제 값으로 사용하지 않는다.
- **후속 확인 항목:** `used_service_tier`의 정확한 경로와 최상위 값이 함께 있을 때의 의미/우선순위. 첨부된 provider-manager-v1.15.3.js에는 이 필드가 없고 요청 생성용 `service_tier`만 있다. 이번 구현은 OpenAI 호환 응답의 최상위 `service_tier`만 실제값으로 읽는다. 반환 근거가 없으면 actual=null/확인 불가이며 메타데이터 값은 읽지 않는다.
- 모델 기본 티어, 에이전트 상속/재정의 선택을 LLM Gateway에서도 활성화한다. 도움말에는 공급자/모델/플랜에 따른 제한이 있음을 표시한다. 요금 배수·모델 목록은 하드코딩하지 않는다.
- DB 스키마·공개 MCP 인자·큐/제한시간을 불필요하게 변경하지 않는다. Responses/이미지 API 신규 지원은 이번 범위에 포함하지 않는다.

## 4. 검증과 인수 기준

1. 공식 URL로 이미 등록된 generic/custom/openai 계열 프로필의 openai-chat 연결이 재등록 없이 티어 지원으로 표시된다. 표시 이름은 판정에 영향이 없다. 프리셋 신규 생성도 검증한다.
2. 유사 호스트·다른 어댑터·다른 URL에서는 잘못 활성화되지 않는다. 기존 직접 OpenAI와 지원 미확인 공급자 회귀를 유지한다.
3. 모의 게이트웨이로 모델 기본값, 에이전트 상속/재정의, provider-default 키 제거, 구형 고급 값, 설정 보존을 실제 전송 body 기준으로 검증한다. 테스트용 로컬 URL을 제품 허용 목록에 추가하지 않는다.
4. 모델 probe → 초안 시험 → preview/적용 → 공식 SDK MCP 실행을 확인한다. 요청별 이벤트·실행 기록·스냅샷의 티어가 일치해야 한다.
5. 요청과 실제 티어가 다른 최상위 응답, 실제 값 누락을 각각 검증한다. 메타데이터 경로는 이번 OpenAI 호환 형식 구현에서 읽지 않으며, 확인된 응답 계약을 확보한 뒤 별도 확장한다. 미확인 값을 성공 적용으로 표시하지 않는다.
6. 400 unsupported_service_tier 및 403 거절에서 티어를 바꾸는 재시도가 없어야 한다. 저장/불러오기/가져오기 후 같은 정책을 유지한다.
7. Edge E2E에서 기존 LLM Gateway 연결의 모델/에이전트 선택 가능 여부와 응답 시험 티어 문구 유지를 확인한다. build/typecheck/lint, 관련 시험과 전체 회귀를 실행한다.
8. 실제 LLM Gateway 시험은 별도 수행 여부를 기록한다. 자격 있는 모델·플랜에서 합성 프롬프트만 사용하고 외부 API 과금/호출 권한이 확보된 환경에서 수행한다. 모의 시험만으로 실계정 티어·청구 검증 완료라 하지 않는다.

## 5. 문서 동기화와 인계 지시

2026-09-26 구현: `llmgateway` 프리셋과 엄격한 공식 HTTPS URL 인식을 추가했다. `openai-chat` 연결이라면 기존 profileId·표시 이름에 관계없이 `https://api.llmgateway.io/v1` 및 끝 슬래시를 지원한다. 다른 경로·호스트·포트·프로토콜·어댑터는 미확인이다. 기존 모델/에이전트 티어 상속과 요청 본문 로직을 재사용했다. 최상위 응답 `service_tier`가 없으면 실제값은 확인 불가로 유지한다. 임시 서비스·모의 응답에서 probe, 초안 실행, MCP SDK 실행, 400/403 단일 실패, URL 경계와 Edge 화면을 확인했다. 실제 Gateway 호출·계정 자격·청구는 미검증이다.

구현 후 API_SPEC의 직접 OpenAI 전용 제약, PRODUCT_SPEC/DATA_MODEL의 관련 설명, README 사용법, UX16 이력 및 IMPLEMENTATION_STATUS/TEST_PLAN을 실제 변경에 맞게 갱신한다. 이 문서는 계획과 구현/검증 결과를 구분해 유지한다.

> 이 문서와 현재 서비스 티어 공통 로직을 읽고 LLM Gateway 지원을 구현하세요. 응답 시험의 티어 표시는 유지하세요. 기존 등록은 이름이나 profileId 변경 없이 공식 엔드포인트로 인식하고, 모델·에이전트 상속과 모든 실행 경로에 동일하게 적용하세요. 실제 처리 티어 메타데이터 경로는 공식 근거로 확인한 뒤 연결하세요. 범용 호환 서버의 무조건 허용이나 티어 자동 변경 재시도는 추가하지 마세요. 모의 body·오류·SDK MCP·브라우저 회귀를 수행하고 실제 API 미검증은 별도로 기록하세요. 사용자 DB·비밀값을 문서나 fixture에 복사하지 마세요.
