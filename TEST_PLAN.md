# 테스트 및 검증

## 2026-09-25 GitHub 게시 전 작동 확인

- `npm run build`, `npm run typecheck`, `npm run lint` 통과.
- 첫 기본 회귀는 107개 통과·대상 통합 시험 1개 timeout·OS 전용 1개 제외였다. 기존 R13의 해당 시험만 제한을 5초→15초로 조정했다. 제품의 제한시간은 변경하지 않았다.
- Windows OS 조회 허용 환경에서 `MCPEX_R14_OS_TEST=1`로 `npx vitest run --maxWorkers=1` 재실행: 34개 파일·109개 모두 통과(76.89초). 실제 임시 3세대 후손 탐지, 실제 명령 트리 취소, R15 빈/부분 잠금 및 프로세스 간 저장 회귀를 포함한다.
- `npm run test:e2e`: Edge 1개 통과(14.2초). 모의 공급자 등록·모델·에이전트 관리·대상 파일 생성·실행 기록·오류 안내 흐름을 검증했다.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/restart-launcher.test.ps1`: 임시 데이터/자동 할당 포트의 서비스 시작→재시작·PID 변경·health 확인 통과. 테스트 서비스는 종료·정리했다.
- 실제 사용자 서비스·DB는 변경하지 않았으며 유료 외부 모델은 호출하지 않았다. 실제 외부 공급자/클라이언트 연동, 장시간 부하, DB 기록 실패 등 기존 실환경 미검증은 남는다.
- 게시 대상에서 `artifacts/`, 로컬 throughput fixture, 비밀 저장 파일/잠금, DB, 빌드 산출물, 의존성, 브라우저 시험 보고서를 제외했다. 임시 산출물은 로컬에 보존한다.

## 2026-09-25 R15 비밀 저장 잠금 수정 검증

- `npm run build`, `npm run typecheck`, `npm run lint`, 변경 파일 Prettier 확인 통과. `npx vitest run --maxWorkers=1`: 33개 파일·108개 통과, 실제 OS 3세대 opt-in 시험 1개 제외(이번 변경과 무관). 웹 화면 변경이 없어 Edge E2E는 재실행하지 않았다.
- `tests/r15-secret-lock.test.ts` 6개: 실제 `wx` 생성 직후 내용 쓰기를 지연한 빈/부분 잠금 각각에서 두 store의 set/set 결과가 모두 보존됨; 빈/부분/종료 PID 잠금은 삭제하지 않고 timeout; 별도 Node 프로세스 set/set·set/delete 결과 보존; 작성자 프로세스 중단 후 timeout, 모든 작성자 종료 후 잠금 수동 제거·복구를 임시 폴더와 합성 값으로 확인했다.
- `tests/rta02-secret.test.ts`의 실제 Windows DPAPI 합성 값 동시 저장·삭제 시험 1개도 통과했다. 결정적 경합 시험의 변환 단계만 합성 함수이며 실서비스 비밀값을 사용하지 않았다.
- 소유권 불명/중단된 잠금의 자동 회수는 수행하지 않는다. 제한시간 10초 후 오류가 반환되며 운영자가 서비스를 중지하고 잠금 파일만 보관 위치로 옮긴다. 실제 사용자 서비스·DB·비밀 파일은 변경하지 않았다.

## 2026-09-25 R14 수정 후 전체 독립 재검증

- `npm run build`, `npm run typecheck`, `npm run lint` 통과.
- `npx vitest run --maxWorkers=1`: 32개 파일·102개 통과, opt-in 실제 OS 시험 1개 제외(86.86초). target-binding은 이번에는 통과했으나 통합 시험 4881ms로 기본 5초에 가까워 기존 R13 안정성 한계는 남는다.
- `npm run test:e2e`: Edge 1개 통과(14.1초). 전용 `.e2e-data` 및 모의 공급자를 사용했다.
- 기존 R14 합성 입력에서 생존 손자 PID 12 반환을 확인. 후손 보존·재시작·빈 조회 시 409·명시적 수동 해제는 전체 회귀의 API 시험에서 통과했다. 현재 격리 환경에서 `windowsProcessRows()` 조회 불가를 확인했으므로 실제 3세대 opt-in은 재실행하지 않았다.
- R15 신규 재현: 임시 디렉터리에서 첫 잠금의 실제 open(wx)과 내용 쓰기 사이를 지연하고, 두 번째 store의 변환 시점을 제어했다. DPAPI는 합성 변환으로 대체했다. 두 set 모두 성공했으나 최종 keys가 `["fixture-b"]`여서 첫 키 유실을 확인했다. 재현 후 임시 데이터를 정리했다. 별도 프로세스 부하·실제 DPAPI 경합 시험은 미수행이다. 상세 수정 기준은 [검토 R15](docs/IMPLEMENTATION_REVIEW.md)를 따른다.
- 제품 코드·실제 사용자 서비스·DB·비밀값은 변경하지 않았다. 빌드 산출물과 검토 문서만 갱신했다.

## 2026-09-25 R14 수정 검증

- 기존 빌드에서 새 후손 추적/API 회귀가 실패함을 확인한 뒤 수정 빌드를 적용했다. 구현 도중 반환 객체에 불필요한 parentPid가 포함되는 시험 실패를 수정하고 재검증했다.
- `rta04-command` 7개 + `rta04-safety-api` 2개 통과: 모든 저장 조상 기준 후손 탐지, PID 재사용 세대 제외, 실제 자식 생존 + taskkill 실패 모의 주입 시 겹침/full 접근 차단, 정상 취소, 후손 추가 발견·저장·반복 재시작, 생존 시 수동 해제 거부, 빈 조회 시 409 차단 유지, 명시적 수동 해제 확인.
- `$env:MCPEX_R14_OS_TEST='1'; npx vitest run tests/r14-process-tree.test.ts tests/runtime-remediation.test.ts`를 OS 조회 허용 환경에서 실행해 6개 통과. 임시 실제 Windows 부모·자식을 먼저 기록하고 손자 생성 후 두 조상을 종료시켜 생존 손자를 탐지했다. 초기 시험의 트리 크기=2 가정은 Windows 콘솔 보조 프로세스 때문에 실패하여 보조 프로세스를 허용하도록 수정했다. 정상 실제 taskkill 종료 시험도 통과했다. 이 시험은 운영 서비스가 아닌 자체 생성 임시 프로세스만 사용한다.
- `npm run build`, `npm run typecheck`, `npm run lint` 통과. 전체 `npx vitest run --maxWorkers=1` 재실행은 32개 파일·102개 통과, opt-in 실제 OS 시험 1개 제외(위 별도 실행에서 통과). 첫 전체 실행은 기존 target-binding 시험이 5초 제한으로 실패했고 시험·제한 변경 없이 재실행에서 통과(4.8초)했다. 타이밍 여유가 적은 기존 시험이라는 한계는 남는다.
- Edge E2E는 최종 UI 재빌드 후 1개 통과(13.9초). 실제 사용자 서비스·DB, 실제 3세대 프로세스와 관리 API를 한 번에 연결한 종단 시험, PID 재검사~taskkill 사이 원자성 및 DB 쓰기 실패 주입은 미검증이다. 실제 OS 추적 시험과 모의 OS/임시 DB API 시험을 구분한다.
- 빈 스냅샷은 전체 종료 증명이 아니다. 중간 조상 미관측 가능성 때문에 기존 차단 기록까지 자동 해제를 금지한다. 운영자는 독립된 OS 확인 후 수동 해제해야 하며, 전체 트리 부재를 입증할 수 없으면 차단을 유지한다.

## 2026-09-25 RTA-04 후속 독립 재검증 — 후손 누락 재현

- `npm run build` 통과. `npx vitest run tests/rta04-command.test.ts tests/rta04-safety-api.test.ts tests/runtime-remediation.test.ts --maxWorkers=1` 3개 파일·13개 통과.
- 빌드된 `packages/tools/dist/src/process-tree.js`의 `survivingTree([{pid:12,parentPid:11,started:'102'}], [{pid:10,started:'100'},{pid:11,started:'101'}])` 결과는 `[]`. 기록된 자식이 새 손자를 만든 뒤 종료한 상태에서 생존 손자를 놓친다. 상세와 수정 인수 기준은 [R14](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.
- 합성 목록을 사용한 함수 재현이며 실제 3세대 OS 과정 및 verify API 종단 재현은 미수행. 실제 사용자 서비스·DB는 사용하지 않았다. 이번 검토에서 전체 101개/typecheck/lint/Edge E2E는 재실행하지 않았다. 아래 기존 통과 기록과 구분한다.

## 2026-09-25 RTA-04 후속 독립 재검증 — 후손 누락 재현

- `npm run build` 통과. `npx vitest run tests/rta04-command.test.ts tests/rta04-safety-api.test.ts tests/runtime-remediation.test.ts --maxWorkers=1` 3개 파일·13개 통과.
- 빌드된 `packages/tools/dist/src/process-tree.js`의 `survivingTree([{pid:12,parentPid:11,started:'102'}], [{pid:10,started:'100'},{pid:11,started:'101'}])` 결과는 `[]`. 기록된 자식이 새 손자를 만든 뒤 종료한 상태에서 생존 손자를 놓친다. 상세와 수정 인수 기준은 [R14](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.
- 합성 목록을 사용한 함수 재현이며 실제 3세대 OS 과정 및 verify API 종단 재현은 미수행. 실제 사용자 서비스·DB는 사용하지 않았다. 이번 검토에서 전체 101개/typecheck/lint/Edge E2E는 재실행하지 않았다. 아래 기존 통과 기록과 구분한다.

## 2026-09-25 런타임 개선 최종 회귀

- RTA-04 후속 수정까지 `npm run build`, `npm run typecheck`, `npm run lint` 통과. `npx vitest run --maxWorkers=1` 32개 파일·101개 시험 통과. 최종 web 재빌드 후 `npm run test:e2e` Edge 시나리오 1개 통과(13.9초); 관리 화면의 차단 경고·한국어 원인 표시도 모의 API로 확인했다. UI 문구 변경 직후 재빌드 전 E2E는 이전 배포 파일로 실행되어 기대 문구가 달라 실패했고, 재빌드 후 통과했다. 모두 합성·임시 데이터로 수행했고 실제 사용자 서비스는 재시작하지 않았다.
- 전체 `npm run format`은 기존 사용자 문서·산출물을 포함한 91개 파일의 서식 차이로 실패했다. 이 작업에서 수정한 TypeScript 소스·시험 파일은 별도로 Prettier를 적용했다. 전체 포맷 실패를 검증 통과로 기록하지 않는다.
- [RTA-04](docs/RUNTIME_REMEDIATION_PLAN.md)의 종료 확인 실패 차단·재시작 복원·명시적 해제는 후속 구현·자동 검증했다. 실제 느린 SSE 연결, 장시간 힙/RSS, 대량 DB 단일 실행 삭제 지연과 DPAPI 프로세스 간 실패 경로는 별도 실험이 필요하다.

## 2026-09-25 RTA-09 세션

- `tests/rta09-session.test.ts`의 가상 시각 만료 정리, 같은 쿠키 교환 시 이전 세션 폐기, 다른 브라우저의 유효 세션 보존을 확인했다. 교환 요청이 없는 유휴 기간의 Map 정리는 구현·검증하지 않았다.

## 2026-09-25 RTA-08 보존 정리

- `tests/p6-config-retention.test.ts`에서 만료 terminal 실행 205개의 100/100/5 배치 정리와 진행 중 실행의 본문·이벤트 유지를 확인했다. 설정 변경·종료 중첩, 한 실행의 대량 이벤트 삭제 시간, 실제 API 응답 지연은 미측정이다.

## 2026-09-25 RTA-05 공급자·대화 크기

- `tests/rta05-response-budget.test.ts`에서 멀티바이트 응답, 거짓 Content-Length에도 실제 수신량 초과 및 reader 취소, 반복 모델 턴의 8 MiB 누적 상한을 확인했다. providers/runtime/server 빌드·typecheck, P1/P5 포함 9개 통과. 압축·중도 취소의 어댑터별 실제 HTTP 시험은 미수행이다.

## 2026-09-25 RTA-06 디렉터리 열거

- `tests/r12.test.ts`에서 40개 파일 중 탐색 예산 10개로 조기 중단·truncated, 기취소 검색 거부와 Windows 임시 폴더 정리를 확인했다. tools 빌드·typecheck, R12/P4 24개 통과. 10,000개 이상의 실제 대형 폴더 RSS·핸들 수 측정은 미수행이다.

## 2026-09-25 RTA-01 스키마 캐시

- 설치된 Ajv의 `removeSchema(object)` 캐시 제거 동작을 확인했다. `tests/rta01-schema-cache.test.ts`에서 새 객체지만 동일 내용인 스키마의 재컴파일 방지, 서로 다른 100개·실패 20회 후 캐시 64개/512 KiB 이하, 기존 P2 입력 검증 통과를 확인했다.
- server 빌드·lint 통과. 장시간 힙 전후 측정은 미수행이다.

## 2026-09-25 RTA-02 비동기 DPAPI

- `tests/rta02-secret.test.ts`에서 합성 비밀값 set/set, set/delete와 병렬 초기 로컬 토큰 생성, 평문 미기록, DPAPI 작업 중 이벤트 루프 timer 진행을 확인했다.
- 전체 build/typecheck/lint 및 단일 worker Vitest 28개 파일·87개 테스트 통과. 실제 사용자 비밀 파일·서비스는 사용하지 않았다. 프로세스 간 경합, PowerShell timeout/과대 출력·stdin 실패 모의는 미검증이다.

## 2026-09-25 RTA-07 SSE 연결

- `tests/p6-events.test.ts`에서 terminal 실행의 150건 추가 이벤트를 cursor 이후 모두 수신하고 관리 API 서비스 티어 151건 집계가 유지됨을 확인했다. 별도 running 실행의 타이머 중 잘못된 JSON 이벤트가 해당 SSE 연결만 종료하고 health는 200을 유지함을 확인했다.
- storage/server 빌드·typecheck와 해당 테스트 통과. 느린 실제 TCP reader의 write(false) 재현, 응답 중간 종료의 listener/handle 수 측정은 미검증이다.

## 2026-09-25 RTA-04 명령 프로세스 수명

- 기취소 명령의 미시작과 정상 완료 후 listener 제거를 확인했다. 임시 Node 부모·분리된 하위 프로세스에서 `taskkill` 시작 오류를 모의하자 부모 종료 뒤에도 하위 프로세스가 살아 있었고, 같은 폴더 대기/후속 작업 및 전체 접근 작업이 `WORKSPACE_BLOCKED`로 거절됐다. 독립 폴더는 실행됐으며 하위 프로세스 종료 뒤 명시적 차단 해제 후 동일 폴더가 다시 실행됐다. 정상 취소·반복 취소에서 종료 보조 호출 1회와 잠금 해제, PID 생성 시각 변경 시 `taskkill` 미호출도 확인했다.
- `tests/rta04-safety-api.test.ts`에서 인증 없는 조회 401, 살아 있는 동일 PID·생성 시각의 확인 해제 409, 서비스 재시작 후 차단 복원, 프로세스 종료 확인 뒤 해제·재시작 후 빈 차단 목록을 검증했다. 목록 조회 실패로 프로세스 기록이 비어 있으면 자동 해제 409, 수동 해제는 정확한 작업 폴더와 확인 문구가 있어야 했다.
- 권한 허용 Windows에서 `Win32_Process` 조회(309개)와 임시 부모·자식의 실제 `taskkill` 성공 및 트리 종료를 확인했다. 기본 격리 환경에서는 조회가 `Access denied`라 안전 차단 분기로 동작한다. 실제 사용자 서비스·명령·DB는 사용하지 않았다. PID 조회와 종료 사이의 극단적 재사용 경합, OS 조회 불가 상태의 사용자 수동 확인, DB 기록 실패, 무응답 보조 프로세스와 `child.kill()` 자체 실패는 미검증이다.

## 2026-09-25 RTA-03 취소 경계

- 수정 전 `tests/runtime-remediation.test.ts`의 후속 도구 차단·기취소 파일 쓰기 2개가 실패해 문제를 재현했다.
- 수정 후 모델 응답 지연 취소를 포함한 3개 통과. runtime/tools/server 관련 빌드, typecheck, lint와 `tests/runtime-remediation.test.ts tests/p4.test.ts tests/target-binding.test.ts tests/r06.test.ts`의 24개 통과.
- 실제 MCP 클라이언트 취소 및 쓰기 commit 전후의 결정적 경합·파일 변경 기록 검증은 아직 수행하지 않았다.

## 2026-09-25 런타임 정적 검수

- [런타임 정적 검수](docs/RUNTIME_AUDIT.md): 현재 제품 소스의 메모리·CPU·비동기 취소·오류 처리·리소스 수명을 정적으로 검토했다. Critical 0 / High 6 / Medium 2 / Low 1의 위험을 기록했다.
- 애플리케이션·테스트·빌드를 실행하지 않았으며 수정도 적용하지 않았다. 힙·CPU·장애 재현 및 개선 효과는 미검증이다. 후속 검증 조건은 리포트 4절에 기록했다. 기존 검증 이력과 구별한다.

## 2026-09-25 재시작 실행기

- `MCPex Restart.bat`와 `scripts/restart-mcpex.ps1`의 PowerShell 구문을 확인했다. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/restart-launcher.test.ps1` 통과: 임시 데이터 폴더·동적 로컬 포트에서 BAT 첫 실행의 서비스 시작·health, 두 번째 실행의 PID 변경과 새 서비스 health를 확인했다. 첫 시도에서는 기본 브라우저 오류가 재시작을 실패 처리해 브라우저와 분리했고, 이후 종료 직후의 일시적 프로세스 열거를 실패로 오판해 종료 대기로 수정했다. 격리 재시작에서 schema v7도 확인했고 테스트 서비스·임시 데이터는 정리했다. 실제 사용자 서비스 재시작, 실행 중 작업 중단, 사용자 DB 마이그레이션은 미검증이다.

## 2026-09-25 독립 전체 재검증

- 최신 전체 build/typecheck/lint 통과.
- `npx vitest run --maxWorkers=1`: 25개 파일 중 24개 통과·1개 실패, 80개 테스트 중 79개 통과·1개 실패(97.30초). 실패는 target-binding 통합 시나리오의 기본 5000ms timeout이다.
- 진단용 `npx vitest run tests/target-binding.test.ts --maxWorkers=1 --testTimeout=15000`: 2개 통과, 통합 시나리오 6750ms. 테스트 소스/전역 설정은 변경하지 않았으며 기본 전체 명령의 실패를 통과로 대체 집계하지 않는다.
- `npm run test:e2e`: 삭제 이름 재사용·서비스 티어 UI·대상 결과 표시를 포함한 Edge 시나리오 1개 통과(17.4초).
- UX15/UX16/T01의 코드·모의/브라우저 연결은 확인했다. 실제 사용자 DB 마이그레이션, OpenAI 계정 티어 적용, 다른 공급자 티어, 대상 ID 방식 실제 라이트 호출, 대상 정책 전체·경합, 실제 콘솔 비노출은 이번 검증 범위 밖이다. 제품 코드·사용자 설정·실행 중 사용자 서비스는 변경하지 않았다.

## 2026-09-25 UX16 서비스 티어

- `tests/service-tier.test.ts` 모의 OpenAI Chat Completions 응답에서 모델 기본 `default`, 에이전트 상속/`provider-default`/`auto`/`flex`, 고급 `extraBody.service_tier` 덮어쓰기·필드 제거를 확인했다. 응답의 실제 티어가 요청값과 다르거나 없을 때 별도로 기록하고, `priority` 거부는 자동 재시도 없이 실패로 끝났다.
- 공식 MCP SDK 클라이언트 호출은 적용 버전의 `flex`를 유지했고, 그 뒤 모델 기본 설정을 바꿔도 이전 적용 스냅샷에 영향이 없었다. 템플릿 generation 묶음과 설정 내보내기/가져오기의 티어 보존, 미확인 호환 공급자 전용 선택 400도 확인했다.
- build/typecheck/lint, Vitest 단일 worker 25개 파일·80개 테스트와 Edge E2E 1개 통과. E2E에서 미확인 공급자의 명시 티어 비활성, OpenAI 직접 연결 모델의 `flex` 등록·새로고침 후 유지, 에이전트 `auto` 초안 저장·새로고침 후 유지를 확인했다. 실제 OpenAI 계정·모델·프로젝트 허용 정책과 청구/지연 효과는 호출하지 않았고 미검증이다. 다른 공급자 서비스 티어 매핑도 미구현이다.

## 2026-09-25 UX15 삭제 이름 재사용 자동 검증

- v5 DB에 삭제된 에이전트·적용 버전·실행을 넣고 v6로 마이그레이션했다. 이전 참조와 `PRAGMA foreign_key_check` 정상, 삭제 이름 재사용과 미삭제 동명 이름 거부, 백업 생성 및 FK 활성화를 확인했다.
- API에서 복제한 비활성 에이전트를 삭제한 뒤 같은 `toolName`으로 새 ID의 비활성·미적용 초안을 만들고, 그 이름의 추가 생성은 409로 거부됨을 확인했다. 동시 생성 2건은 201/409로 갈렸으며, 가져오기 미리보기와 적용은 삭제된 동명 이름을 충돌로 처리하지 않았다.
- 공식 SDK 모의 MCP 클라이언트의 목록에서 삭제 직후 동명 도구가 없고, 새 에이전트를 적용·활성화한 뒤 새 설명과 프롬프트의 도구가 목록·호출에 반영됨을 확인했다. 이전 실행 조회의 agentId는 옛 ID로 유지됐다.
- build/typecheck/lint 통과, Vitest 단일 worker 24개 파일·79개 테스트 통과. Edge E2E 1개도 삭제 후 동명 재생성과 중복 이름 안내를 포함해 통과했다. 전체 병렬 Vitest 첫 실행은 다른 기존 테스트 5개가 5초 제한으로 시간 초과됐으나 단일 worker에서 모두 통과했다. 실제 사용자 DB와 외부 MCP 클라이언트의 재연결은 미검증이다.

## 2026-09-24 light·advance 운영 프롬프트 적용 확인

- 사용자 변경 후 DB를 읽기 전용으로 확인했다. code_light/code_advance 모두 적용 v7이며 초안과 적용 설정이 일치한다. 새 역할 설명·변경 제한·실패 중단·검증 대기 보고 지침이 저장됐고 userPromptTemplate에 task/workspace/scope/requirements 네 필드가 모두 연결됐다.
- light는 로컬 openai/gpt-oss-20b, advance는 llmgtw deepseek-v4.1-flash. 둘 다 fixed/C:\Users, targetBinding=off, 파일 도구 5개, commands 빈 배열. 실행 제한은 light 120초/advance 240초, 대기 제한은 각각 120초, 최대 모델 20턴·도구 50회다. 같은 오류 1회 보정 지침은 프롬프트이며 별도의 반복 오류 강제 제한을 검증한 것은 아니다.
- code_middle은 여전히 enabled=1(v9)이고 기존 일반 작업 설명을 유지한다. 기본 배정 제외와 실제 비활성 상태는 구분해야 한다.
- 현재 대화의 도구 메타데이터에는 이전 light→middle 승급 설명이 남아 있다. DB의 최신 적용 설명은 light→advance다. 저장 실패로 단정하지 않으며 클라이언트 도구 목록 갱신 후 확인이 필요하다. 메인 에이전트 지침을 사용자가 어느 위치에 등록했는지는 이번 확인 범위에 포함하지 않았다.
- 설정 조회만 수행했고 모델 호출·동작 재시험·설정 변경은 하지 않았다. 진행 중 실행 0건.

## 2026-09-24 02:21 KST 코딩 에이전트 최종 설정·수정·인계 검증

- code_light v4(로컬 GPT OSS 20B), code_middle v8(NVIDIA Muse Glimmer 30B), code_advance v5(llmgtw Deepseek V4.1 Flash)의 새 description/systemPrompt 적용, 초안 일치, 활성 상태, fixed/C:\Users를 DB로 확인했다. 실행 제한은 light/middle 120초, advance 240초, 최대 모델 턴은 모두 20이다. 공개 도구의 이 세션 노출 설명은 이전 일반 문구이며 신규 세션/목록 갱신 후 반영 확인이 필요하다. 저장된 새 설명이 누락된 것은 아니다.
- 세 적용 userPromptTemplate은 여전히 scope를 렌더링하지 않는다. 이번 시험은 범위 조건을 task/requirements에도 넣었다. run_command와 commands가 없어 에이전트 자체 실행 테스트는 불가능하며 메인이 별도로 검증했다. 대상 ID 방식은 이번 공개 입력 스키마에 없어 직접 절대 경로를 사용했다.
- artifacts/code-final-2026-09-23T17-21-51-524Z에 독립 input.json·calc.mjs를 생성하고 light→middle→advance를 순차 호출했다. 합산의 감산 버그 최소 수정, 입력 분석, output.json 생성, 두 변경 파일 재읽기를 요구했다. 세 모델 모두 calc.mjs를 정확히 1문자 수정했으며 실제 Node 실행으로 일반 합·빈 배열·유한 수 필터·비배열 예외·음수 합·원본 비변경 6개 검사를 각각 통과했다.
- light 독립 시험: c5fc62b6-d002-42a6-b027-71d7ac4f3037, 서버 19.098초/왕복 24.350초. 도구 7회, 경로 오류 2회 및 불필요한 목록 조회. output.json에 리터럴 백슬래시+n을 써 JSON 파싱 실패. 변경 파일 재읽기 없이 완료·LF 보존을 보고했다. 코드 수정은 통과, 산출물 전체는 실패.
- middle 독립 시험: b0c18690-bc21-4ba0-ac06-ca7daf79064c, 서버 116.462초/왕복 121.122초. 도구 21회 중 write_file BAD_INPUT 16회, MODEL_TURN_LIMIT으로 종료. 코드 수정은 통과했지만 출력 없음. 로그에서 invalid_arguments와 expectedHashProvided=false를 확인했으나 정확한 잘못된 필드는 보존되지 않아 확정하지 않는다. 프롬프트의 반복 중단 지시를 지키지 못했다.
- advance 독립 시험: cd5d7273-cf0c-4b7e-9052-722e2209b387, 서버 27.478초/왕복 31.775초. 도구 6회 모두 성공, 코드 수정·유효한 JSON 내용·재읽기 확인. 마지막 실제 LF는 없었는데 있다고 보고했다. 줄바꿈 제외 시 기능·내용 검증 통과, 엄격한 파일 형식 조건은 실패.
- light→middle 복구: a7558514-c2b8-4ec0-9930-d0cd99d06693, 서버 120.011초/왕복 129.411초, 도구 5회, ACCESS_DENIED/BAD_INPUT 후 EXECUTION_TIMEOUT, 변경 없음.
- 최종 advance 복구: f9f43cf8-8189-4134-87fc-76f9374019f0, 서버 118.202초/왕복 124.249초. light/middle/advance의 output만 복구하도록 인계했다. 세 JSON 모두 파싱·nonce·한글·수치 일치로 복구했으나 마지막 LF는 모두 없었다. 도구 32회, 성공 변경 20회, 모델 20턴 한도로 실패. usage 누적 totalTokens=201217로 유료 반복 비용 위험이 확인됐다(청구 토큰·요금과 동일하다는 뜻 아님). 추가 모델 재시도는 중단했다.
- 로컬 executeWorkspaceTool→WorkspaceTools 대조 시험에서 실제 LF 문자열이 디스크에 바이트 그대로 보존되고 끝바이트 10임을 확인했다. 저장 도구가 항상 LF를 잘라낸다는 가설은 재현되지 않았다. 실 공급자 원문 인수를 확보하지 않아 개별 누락을 어느 계층에서 만들었는지 완전히 확정하지 않는다.
- 최종 세 입력 원본 해시와 수정 완료 코드 보존, queued/running 0건 확인. 독립 시험 결과는 verification-before-recovery.json, 복구 결과는 verification-after-recovery.json, 호출 응답은 runs.json과 이벤트 JSON에 보존했다. 복구 전 파일도 .before-recovery로 보존했다. 제품 코드·사용자 설정 변경 없음. 수동 검증·승급 흐름은 실행했지만 자동 승급 기능이 구현됐다는 증거는 아니다.
- 결론: 새 프롬프트 적용은 확인했으나 무검증 자동 사용의 인수 조건은 충족하지 못했다. scope 전달, 반복 실패/무변경 재쓰기 중단, 산출물 검증과 실제 판정이 필요하다. prompt만으로 종료·재읽기·정확한 완료 보고가 보장되지 않는다.

## 2026-09-24 02:03 KST code_middle 단일 재시험

- artifacts/code-middle-io-2026-09-23T17-03-19-755Z에 nonce·한글·마지막 LF 입력과 최초 해시를 생성하고 공개 code_middle에 절대 경로 읽기→새 파일 쓰기→재읽기를 요청했다. 현재 실행 모델은 OpenRouter nex-agi/nex-n2.5-pro:free, workspace는 fixed/C:\Users였다. 이전 NVIDIA Nemotron 구성과 구분한다.
- run ff5a7534-fb8c-43f2-a226-e609c88f31ae: 서버 전체 120.009초, 호출 왕복 126.072초, EXECUTION_TIMEOUT. 도구 0회·출력 없음. 원본 해시 일치. 파일 접근 전에 종료되어 읽기·쓰기 기능은 미검증이며 지연의 근본 원인은 확정하지 않는다. 설정·제품 코드는 변경하지 않고 시험 파일을 보존했다.

## 2026-09-24 01:00~01:34 KST mid_test1/2 교대 20세트·40 RPM 제한 시험

- 사용자의 반복 시험 요청에 따라 test1 완료→test2 완료를 20세트, 각 20회 총 40회 순차 실행했다. 공식 MCP SDK로 현재 공개 에이전트를 호출했으며 설정 변경·실패 자동 재시도는 없었다. 사용자에게 20세트/40호출 해석을 시작 전에 알렸다. 에이전트 실행 제한은 기존 120초, 클라이언트 대기는 180초였다.
- artifacts/mid-repeat-runner.mjs로 각 실행 전 61초 창의 동일 공급자 model.started 수에 다음 실행의 최대 20턴을 더해 40 이내일 때만 시작했다. 실제 관측 최고치는 연속 60초 기준 10 RPM, 총 모델 요청 test1 59회/test2 49회, 429 없음. 로컬 MCPex의 해당 공급자 관측 범위이며 외부 계정 사용량까지 보장하지 않는다.
- test1 / NVIDIA meta/muse-glimmer-30b: 정확한 출력·재읽기·nonce 응답 11/20(55%), 120초 초과 9회. 정확한 출력 파일은 13개(시간 초과 중 2개 포함). 전체 평균 85.391초, 중앙값 104.408초, 범위 24.732~120.020초. 통과 실행 평균 57.063초. 17세트는 입출력 검증을 통과했으나 금지한 list_files 1회 추가로 지시 준수까지 포함한 통과는 10/20이다.
- test2 / NVIDIA nvidia/nemotron-3-super-120b-a12b: 입출력 검증 0/20, HTTP 500 18회, completed 2회(4·10세트)도 마지막 LF 누락으로 실패. 생성된 출력 9개 전부 마지막 LF만 빠진 93바이트(원본 94바이트). 전체 평균 13.547초, 중앙값 9.332초, 범위 0.084~43.376초. 빠른 실패 시간을 성공 작업 성능으로 비교하지 않는다.
- 40개 원본 해시 보존. 호출된 파일 도구 자체의 실패는 0회였으며 공급자 오류·지연과 모델 출력 정확성 문제를 구분한다. 기존 파일 수정이나 일반 코딩 능력을 검증한 결과는 아니다.
- KST 01:00:44~01:34:15, 약 33분 31초. 실행기 exit 0, 전체 queued/running 0건 확인 후 종료했다. 초기 샌드박스 DPAPI 복호화 실패는 모델 호출 0건으로 40회 집계에서 제외했고 일반 사용자 권한에서 실행했다.
- 상세 시간표: [반복 시험 결과](artifacts/mid-repeat-2026-09-23T16-00-44-653Z/report.md). 같은 폴더에 results.jsonl(40행), summary.json, analysis.json, 회차별 입력·출력·도구 이벤트를 보존했다. 제품 코드·에이전트 설정은 변경하지 않았다.

## 2026-09-24 00:44 KST mid_test1~4 재시험 — NVIDIA 구성

- artifacts/mid-io-2026-09-23T15-44-59-094Z에 각 94바이트 nonce·한글·마지막 LF 입력과 최초 해시 manifest를 생성했다. 이전과 동일한 절대 경로 읽기→createOnly 쓰기→재읽기 프롬프트로 1→2→3→4 각 1회 순차 호출했다. 설정은 변경하지 않았다. 실행 스냅샷 모두 fixed/C:\Users이며 모델·공급자는 이전 OpenRouter 구성에서 NVIDIA 구성으로 변경되어 있었다. 이전 모델의 반복 안정성 시험으로 해석하지 않는다.
- test1 / meta/muse-glimmer-30b: run 90e64725-cf63-4b8c-982d-efc7b9861d9b. 서버 76.571초, 왕복 77.613초. read/write/read 3회 모두 성공, 오류 0회. 실제 출력 94바이트, 원본과 완전 일치, 최종 nonce 일치. 이번 과제 통과.
- test2 / nvidia/nemotron-3-super-120b-a12b: run a88708e6-01a9-4079-b3d3-d3ef71a62224. 서버 43.283초, 왕복 44.117초. read/write/read/write 4회 성공, 도구 오류 없음. IO_OK 응답과 달리 최종 출력은 93바이트로 마지막 LF만 누락. 마지막 수정 뒤 재읽기도 없어 정확 복사 과제 실패.
- test3 / nvidia/nemotron-3.5-lightning-30b-a3b: run 36304169-9a8a-4421-b4e2-daa8c922c94d. 서버 120.019초, 왕복 121.020초. 도구 0회, timed_out, 출력 없음. 지연 원인은 이 결과만으로 확정하지 않는다.
- test4 / poolside/laguna-xs-2.1: run ea381f84-32b4-44df-88d3-8b369f4c3139. 서버 94.856초, 왕복 96.062초. 도구 11회 모두 실패(ACCESS_DENIED/ENOENT/PATH_FORBIDDEN/AMBIGUOUS_PATH), 변경 없음. 최종 답변은 폴더 탐색 계획과 불완전한 도구 호출 형식 텍스트였고 completed/succeeded지만 실제 과제 실패다.
- 종료 후 네 입력의 최초 해시 일치 확인. 출력은 test1/test2만 존재하며 정확한 파일 복사와 재읽기 완료는 1/4다. 서버 시간은 전체 실행시간이며 순수 추론 속도가 아니다. 시험 파일 보존.

## 2026-09-24 00:35 KST mid_test 정책 수정 후 재시험

- DB에서 네 초안과 적용 버전 모두 fixed/C:\Users 반영을 확인했다. 적용 버전은 test1/2/4 v2, test3 v3. 실제 네 실행 스냅샷도 workspace=C:\Users/workspaceSource=fixed였다. 사용자 수정 반영을 확인했으며 이번 작업에서는 설정을 변경하지 않았다.
- artifacts/mid-io-2026-09-23T15-35-44-436Z에 각 94바이트의 nonce·한글·마지막 LF 입력과 원본 해시 manifest를 생성했다. 기존과 같은 절대 경로 읽기→createOnly 쓰기→재읽기 요청으로 test1→2→3→4 각 1회 순차 호출했다.
- test1 / Nemotron: run 8e76856e-64a4-4263-8cd7-48c4786d0c94. 서버 12.629초, 왕복 13.779초. read/write 2회 성공 후 텍스트·도구 호출 없는 공급자 응답으로 실패. 출력 93바이트이며 입력의 마지막 LF 1바이트만 누락된 것을 디스크 비교로 확인했다. 재읽기 미수행, 완전 복사 실패.
- test2 / Laguna: run 86aee418-3aad-49a9-b23e-f302fa357d06. 서버 0.310초, 왕복 0.975초. 공급자 429, 도구 0회, 출력 없음.
- test3 / Cohere: run 8b974d22-88ac-49e6-96a7-cb00f1d54d5a. 서버 120.008초, 왕복 120.689초, timed_out. 도구 7회 중 입력 읽기·목록 각 1회 성공, 쓰기 HASH_CONFLICT 3회·없는 출력 읽기 ENOENT·기준 폴더 목록 ACCESS_DENIED. 실패 쓰기는 모두 output.txt 절대 경로에 expectedHashProvided=true였다. 새 파일에 기대 해시를 지정한 호출 오류에서 복구하지 못했다. 출력 없음.
- test4 / Nex: run 92246e45-ed42-4f7f-866f-1bff06fd2474. 서버 120.021초, 왕복 121.025초, timed_out. 도구 0회, 출력 없음. 이 결과만으로 원격 지연의 근본 원인을 확정하지 않는다.
- 종료 후 네 원본 모두 최초 해시와 일치. 파일 도구 제공을 막던 none 설정은 해결됐지만 이번 완전 복사·재읽기 과제는 0/4 완료다. 각 1회 결과이며 모델의 일반적 안정성 순위로 확대하지 않는다. 입력과 test1 출력은 보존했다.

## 2026-09-24 mid_test 작업 폴더 none 원인 확인

- mid_test1~4의 DB 초안·적용 버전·직전 실행 스냅샷을 대조했다. 네 초안은 fixed로 저장됐으나 allowedRoots의 실제 문자열은 `C\Users`로, 드라이브 콜론이 빠져 있다. `C:\Users`와 다르며 Windows 절대 경로가 아니다.
- 네 공개 적용 버전은 모두 workspacePolicy.mode=none/allowedRoots=[]였다. 적용 버전 생성 시각은 KST 00:24:01~00:25:24, 최신 초안 저장은 00:25:52~00:26:17로 폴더 설정 저장 이후 새 버전 적용이 성공한 기록은 없다. 공개 MCP는 초안이 아닌 적용 버전의 snapshot.agent를 사용하므로 실제 실행의 none은 저장된 적용 버전과 일치한다.
- 웹 saveAgent는 초안 PATCH만 수행하고 applyAgent는 별도 적용 API를 호출한다. 적용 API의 workspaceRoots는 isAbsolute로 경로를 검증하므로 현재 `C\Users`로 적용하면 INVALID_CONFIG로 거부된다. 과거 실제 적용 시도·오류 노출 여부는 이번 자료로 확정하지 않는다. 입력 문자열이 저장 과정에서 변조됐다는 증거도 없다.
- 결론: 폴더 선택이 없었던 것이 아니라 초안과 공개 적용 버전의 차이이며, 초안 경로의 콜론 누락도 수정이 필요하다. 올바른 `C:\Users`를 초안 저장한 뒤 적용 버전 생성이 성공해야 공개 호출에 반영된다. 조사만 수행했고 설정은 변경하지 않았다.

## 2026-09-24 00:28 KST mid_test1~4 파일 입출력 시험

- artifacts/mid-io-2026-09-23T15-28-34-557Z에 에이전트별 고유 nonce·한글·LF 입력과 최초 해시 manifest를 생성했다. 공개 MCP mid_test1→2→3→4 각 1회 순차 호출, 절대 경로로 읽기→새 output.txt 쓰기→재읽기를 요청했다.
- 네 실행 스냅샷 모두 runtime.mode=tools 및 파일 도구 목록은 있으나 workspacePolicy.mode=none, execution.workspace=null이었다. 서버는 workspace 또는 fullAccess가 있어야 내부 파일 도구를 제공하므로 이번 실행에는 파일 도구가 제공되지 않았다. input.workspace는 문맥이며 실행 정책을 바꾸지 않는다. 모델의 입출력 능력은 미검증이다.
- mid_test1 / OpenRouter nvidia/nemotron-3-super-120b-a12b:free: run 460a4896-b2a5-4207-8bbc-c3577e4a4c50, 서버 전체 8.759초, 왕복 9.752초. 실제 호출 없이 read_file JSON 예시만 응답했다.
- mid_test2 / OpenRouter poolside/laguna-s-2.1:free: run be8d5e6b-e339-459e-9211-1799c077a754, 서버 전체 0.278초, 왕복 1.131초. 공급자 HTTP 429, 도구 0회.
- mid_test3 / OpenRouter cohere/north-mini-code:free: run ea7e99b7-6ecc-4e77-b007-e73c3489b7c5, 서버 전체 4.642초, 왕복 5.317초. 도구 미제공 실행에서 tool call 응답이 반환되어 MCPex가 거부했다. 실제 도구 실행 0회. 오류 코드 PROVIDER_ERROR만으로 외부 서비스 장애로 분류하지 않는다.
- mid_test4 / OpenRouter nex-agi/nex-n2.5-pro:free: run 56fdcaa3-9095-4c62-b341-57190c617ddc, 서버 전체 97.802초, 왕복 98.465초. 파일 도구가 없어 수행할 수 없다고 응답, 도구 0회.
- 네 입력의 최초 해시 일치와 출력 없음 확인. test1/4의 completed/succeeded는 파일 작업 성공이 아니다. 사용자 설정·제품 코드는 변경하지 않았고 시험 파일은 보존했다. 파일 작업 폴더 정책을 설정·적용한 뒤 재시험이 필요하다.

## 2026-09-24 00:16 KST CODE 에이전트 순차 파일 입출력 재시험

- 새 합성 입력을 artifacts/io-retest-2026-09-23T15-16-26-869Z/<agent>/input.txt에 생성하고 공개 MCP code_light → code_middle → code_advance를 각 1회 순차 호출했다. 입력에는 고유 nonce·한글·마지막 LF를 포함했다. 읽기→새 output.txt 생성→재읽기를 요청했고, 이번에는 도구 path에 절대 경로를 그대로 사용하고 상대 input.txt로 줄이지 말라는 지시를 명시했다. 이전 시험과 프롬프트가 완전히 동일하지 않다.
- light / 로컬 openai/gpt-oss-20b: run a630a4a9-3646-45d0-9d76-7acc2a5c5dc9. 서버 전체 13.186초, 호출 왕복 18.515초. read/write/read 3회 모두 성공, 오류 0회. 실제 디스크 입력/출력 113바이트 완전 일치, SHA-256 d9005073d094aaaa100ecbc2d438c1bb7d3bf64ff2658d481561eddbabcebc72. 응답 nonce 일치.
- middle / NVIDIA nvidia/nemotron-3-super-120b-a12b: run 6eb8e11e-8b67-495b-b754-b271646caf8e. 서버 전체 0.274초, 호출 왕복 3.927초. 공급자 HTTP 500 Internal server error, 도구 0회, 출력 없음. 기존 Groq Qwen 구성과 달라 이전 429 시험과 동일 모델 비교가 아니다. 읽기·쓰기 미검증.
- advance / llmgtw deepseek-v4.1-flash: run 1e879ac0-eb3b-466e-99fc-19cf14ea080b. 서버 전체 14.708초, 호출 왕복 18.905초. read/write/read 3회 모두 성공, 오류 0회. 실제 입력/출력 115바이트 완전 일치, SHA-256 f769d53fb670af57494c2f1899abc052d308fdd51d9e3f49fbfcaf0d4322cc47. 응답 nonce 일치.
- light와 advance 모두 한글·마지막 LF 보존을 디스크 비교로 확인했다. 각 1회 새 파일 복사 결과이며 기존 파일 수정·반복 안정성·순수 추론 속도를 검증한 것은 아니다. 시험 파일을 보존하고 제품 코드·에이전트 설정은 변경하지 않았다.

## 2026-09-24 T01 독립 재검증

- 최신 전체 build/typecheck/lint 통과. 성공한 write_target/replace_target 이벤트만 targetChanges로 변환하며 상세/목록 API와 시험 결과/실행 기록에 연결된 것을 확인했다. 부분 실패 시 변경 유지와 보존 만료 null 처리를 확인했다.
- 새 대상 편집·생성·결과 ID·기록 새로고침을 포함한 Edge E2E 1개 통과(14.2초, exit 0).
- 대상 테스트는 E2E·정적 검사와 동시 실행할 때 통합 시나리오가 기본 5000ms 제한으로 1회 실패했다. 다른 검사 종료 후 동일 코드·동일 명령 `npx vitest run tests/target-binding.test.ts --maxWorkers=1`을 재실행하여 2개 모두 통과(통합 시나리오 4456ms). 제품 동작 assertion 실패는 아니지만 시간 제한 여유가 작아 CI 부하에서 재발 가능하다. 시험 분리 또는 해당 통합 시험 timeout 조정을 후속 검토한다.
- T01 연결 누락은 이번 범위에서 해결 확인했다. 제품 코드·사용자 설정은 변경하지 않았다. 전체 Vitest 재실행, 실제 라이트 모델, 정책 조합 전체·파일 경합 검증은 수행하지 않았다.

## 2026-09-24 T01 대상 변경 결과 연결

- 모의 공급자에서 `read_target`만 성공한 실행은 `targetChanges=[]`, `write_target`·`replace_target` 성공은 실제 ID·작업만 표시됨을 확인했다. 새 파일 생성 후 공급자 500으로 실패한 실행에도 변경이 조회·새로고침 후 유지된다. 보존 만료 후 `targetChanges=null`로 확인 불가가 된다.
- 새 대상 UI Edge E2E: 폼에서 출력 대상 추가→미리보기 경로 비노출→파일 생성→시험 결과의 ID 표시→실행 기록 재조회 후 동일 표시를 확인했다.
- 실제 라이트 모델과 caller/full/none 경계 전체, 대기 중 교체·동시 생성 경합은 별도 미검증이다.

## 2026-09-24 대상 지정 1차 구현 독립 확인

- 최신 전체 `npm run build` 통과. `npx vitest run tests/target-binding.test.ts --maxWorkers=1`: 1개 파일·2개 테스트 통과(4.86초).
- 코드 대조에서 실제 변경 targetId의 시험 UI 표시 및 관리 API 데이터 연결 누락(T01)을 확인했다. 수정 기준은 IMPLEMENTATION_REVIEW의 같은 날짜 절을 따른다.
- 이번에는 전체 테스트/E2E·실제 라이트 모델 호출을 수행하지 않았다. 현재 모의 서버 통합 시험은 read_target 흐름이며, 서버 경유 읽기→출력 생성/변경 ID 표시 검증도 추가해야 한다. 제품 코드·사용자 설정은 변경하지 않았다.

## 2026-09-23 대상 파일 지정 1차 검증

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1`: 통과(24개 파일·78개 테스트). 기존 `npm run test:e2e` Edge 1개도 통과했다.
- `npx vitest run tests/target-binding.test.ts --maxWorkers=1`: 2개 통과. ID·접근 권한·해시 충돌·새 파일 배타 생성과 모의 공급자 UI/MCP 실행에서 대상 경로의 모델·공개 결과 비노출, 대상 전용 도구 제공, 범위 밖 경로 및 중복 경로 접수 거부를 확인했다.
- 이후 2026-09-24 T01에서 새 대상 편집 화면 Edge E2E를 수행했다. 아직 수행하지 않음: fixed/caller/full/none 전체 조합, 대기 중 파일 교체·동시 생성 경합, 실제 라이트 모델의 파일 생성 결과. 모델이 도구 없이 응답하는 경우 과제 성공으로 합산하지 않는다.

## 2026-09-23 14:05 UTC 활성 코딩 에이전트 파일 입출력 재시험

- 활성 공개 MCP 도구 code_light → code_middle → code_advance를 각 1회 순차 호출했다. artifacts/io-retest-2026-09-23T14-05-13-519Z/<agent>/input.txt에 nonce·한글·마지막 LF를 포함한 합성 입력을 만들었다. 모델에는 내용 없이 절대 경로만 전달해 읽기 → 새 output.txt 쓰기 → 재읽기를 요청했다. 제품 코드·설정은 변경하지 않았다.
- light (a8f61363-d700-4d93-8334-7c4d70589873): 서버 전체 11.894초, 왕복 18.821초. 도구 2회 모두 실패(read_file 상대 input.txt ENOENT, list_files 상대 . ACCESS_DENIED). 읽기 성공·출력 없음. completed/succeeded이나 과제 실패, verification=not_verified.
- middle (73585eb2-918d-4153-8566-f2928cf4e733): 서버 전체 2.039초, 왕복 8.504초. 도구 4회 중 읽기 1회 성공(117바이트), 경로/목록 오류 3회. 후속 모델 요청에서 Groq ITPM 7000의 429로 종료. 출력 없음. 읽기 확인, 쓰기 미완료.
- advance (b602fec3-a357-4191-95e4-5d9cd6789e39): 서버 전체 11.504초, 왕복 16.524초. 도구 6회 중 성공 4회, 초기 상대 input.txt/. 오류 2회에서 복구. 읽기·생성·재읽기 완료. 실제 입력/출력 118바이트 완전 일치, SHA-256 d8dc2a6dccb411ea5acd9c4b356473e803d1201829df25987d873d0ba11b1b4b. 한글·마지막 LF·응답 nonce 일치.
- 이번 로그에는 diagnostic.pathNotation/relativeTarget/reason이 있어 세 모델의 최초 읽기 호출이 상대 input.txt였음을 확인했다. 이전 조사 당시의 로그 부족 상태와 구분한다. 시험 입력과 advance 출력은 artifacts에 보존했다. 각 1회 새 파일 복사 시험이며 기존 파일 수정·반복 안정성·코딩 실력·순수 추론 속도는 평가하지 않았다.

## 2026-09-23 UX13 프로바이더 편집 검증

- 서버 API: 같은 ID의 설정 PATCH와 revision 충돌, 키 교체·제거 및 선택적 expectedRevision 충돌, 숨겨진 headers·extraBody 보존과 extraBody 부분 변경 병합을 확인했다. `tests/p6-crud.test.ts` 1개 통과.
- Edge E2E: 편집 취소·프로필 변경 미리보기, 이름·시간·동시성·그룹 저장과 새로고침 후 유지, 모델 선택기의 새 프로바이더명, 키 교체·제거, 충돌 시 입력 보존/최신값 조회, 설정 저장 후 키 변경 실패와 재시도, 편집 대상 전환, 별도 모델 조회 결과를 확인했다. `npm run test:e2e` 1개 통과. build/typecheck/lint도 통과했다.
- 실제 외부 공급자의 새 URL·어댑터 호환성과 기존 사용자 데이터의 수동 확인은 수행하지 않았다.

## 2026-09-23 B01 독립 재확인

- 수정된 pathRecoveryHint가 scoped/full 및 list_files 허용 여부를 구분하고 ENOENT/ENOTDIR·PATH_ERROR에 공통 적용되는지 소스를 확인했다.
- 도구 패키지를 재빌드한 뒤 `npx vitest run tests/p4.test.ts tests/io-diagnostics.test.ts --maxWorkers=1` 실행: 2개 파일·20개 테스트 통과(9.46초). full의 절대 경로 목록 조회, scoped의 `.` 조회, 목록 미허용 시 실행 불가능한 안내 제외, 오류 메시지의 실제 루트 비노출 회귀를 확인했다.
- B01은 수정·재검증 완료다. 이번에는 제품 코드·사용자 설정을 변경하지 않았으며 전체 테스트/E2E 및 실환경 검증을 반복하지 않았다.

## 2026-09-23 B01 복구 안내 회귀 검증

- scoped/full × 목록 도구 허용/미허용 조합에서 실제 ENOENT·ENOTDIR를 재현했다. 허용된 경우 안내에 맞는 `.` 또는 상위 폴더 절대 경로의 list_files 실행 성공을 확인했다. 미허용 상태는 목록 호출을 안내하지 않으며 파일 내용은 유지됐다.
- 경로 포함 OS 오류를 모의 주입해 PATH_ERROR도 같은 정책을 따르고 원시 루트·예외 메시지를 노출하지 않는지 확인했다.
- `npx vitest run tests/p4.test.ts tests/io-diagnostics.test.ts --maxWorkers=1`: 2개 파일·20개 통과. 도구 패키지 빌드, 전체 typecheck/lint 통과. 이번에는 UI 변경이 없어 전체 Vitest와 Edge E2E를 재실행하지 않았다. 아래 독립 재검토의 B01 미해결 판정은 수정 전 이력이다.

## 2026-09-23 개선 후 독립 재검증

- 최신 소스에서 `npm run build`, `npm run typecheck`, `npm run lint` 통과.
- `npx vitest run --maxWorkers=1`: 23개 파일·75개 테스트 통과(55.93초). `npm run test:e2e`: Edge 1개 통과(9.4초), 수동 종료 없이 exit 0.
- 추가 읽기 전용 검사: full WorkspaceTools에서 없는 절대 파일 read_file → ENOENT와 list_files(".") 안내 → 해당 안내 실행 시 PATH_FORBIDDEN을 재현했다. 자동 테스트 전체 통과와 별개로 복구 안내 결함 B01은 미해결이다. [검토 보고서](docs/IMPLEMENTATION_REVIEW.md) 참조.
- 제품 코드·사용자 설정은 변경하지 않았다. 빌드 산출물은 갱신했으며 사용자 서비스는 재시작하지 않았다. 실제 콘솔 비노출·외부 클라우드 입출력·외부 클라이언트 시간 제한은 미검증이다.

## 2026-09-23 UX10–UX12 검증

- UX10: 모델 이름 단위 검사에서 서로 다른 프로바이더, 사용자 label, 프로바이더 이름 변경·누락·중복을 확인했다. Edge E2E에서 동일 modelId 두 개가 프로바이더별로 다른 선택지에 나타나고 기존 선택 흐름이 유지됨을 확인했다.
- UX11: DPAPI `spawnSync`의 `windowsHide` 설정과 다른 제품 내부 spawn 경로를 코드로 대조했다. Windows 실제 화면에서 VBS 설정 열기·서비스 재연결·키 저장/읽기·반복 모델 호출·유휴 상태를 관찰하고 창의 프로세스 이름/PID/부모 PID/시각만 대조하는 수동 확인은 미수행이다. 명령줄 원문·비밀값은 수집하지 않는다.
- UX12: 고정 루트 아래 동명 파일 두 개 중 지정 대상만 해시 기반 수정, 상대·절대 경로 동등성, 한국어·공백 경로, 모호한 드라이브/루트 경로와 따옴표·file URI·`~` 거부, 파일 없음 오류의 안전한 재탐색 안내를 자동 확인했다. 기존 caller·링크·범위 밖·명령 allowlist·해시 회귀도 함께 실행한다. 외부 클라우드 모델·UNC·실제 다중 드라이브는 미검증이다.
- build/typecheck/lint, Vitest 단일 worker 23개 파일·75개 테스트, Edge E2E 1개 통과. ENOTDIR 재탐색 보완 후 P4 18개 테스트를 재실행해 통과했다.

## 2026-09-23 A07 실행 완료와 과제 검증 분리

- 일반 무변경 응답의 기존 MCP `completed/succeeded` 필드와 새 `verification.status=not_verified`를 함께 확인한다. 도구 실패 4건 후 최종 답변을 생성한 실행도 과제 검증은 미검증으로 남고 실패 코드가 근거에 보존되는지 확인한다. 명령 exit 0은 관측 근거로만 표시하고 자동 통과로 판정하지 않는다.
- 공급자 단일 요청 시간 초과는 `PROVIDER_TIMEOUT`/timed_out, 모델 반복·도구 호출 한도는 `MODEL_TURN_LIMIT`·`TOOL_CALL_LIMIT`/failed로 구분한다. 실제 외부 모델의 과제 합격 여부와 별도 검증 모델은 미검증·미구현이다.
- 이번 변경은 build/typecheck/lint, Vitest 단일 worker 22개 파일·73개 테스트, Edge E2E 1개가 통과했다. 외부 공급자의 실제 시간 초과와 실사용 과제의 충족 여부는 확인하지 않았다.

## 2026-09-23 A06 도구 실패 진단 검증

- 로컬 모의 공급자의 연속 도구 호출로 `PATH_FORBIDDEN`(범위 밖 절대 경로), `ENOENT`(상대 경로 없음), `EXPECTED_HASH_REQUIRED`, `HASH_CONFLICT`를 재현했다. 실패 이벤트의 `diagnostic`에 경로 표기·안전한 상대 대상·해시 제공 여부·정형 이유가 남는지 확인했다.
- 같은 SSE 본문에 고정 작업 루트, 범위 밖 절대 경로, 해시 원문, 파일 본문이 포함되지 않는지 확인했다. build/typecheck/lint, Vitest 단일 worker 22개 파일·72개 테스트, Edge E2E 1개 통과. 실제 사용자 실행 이력과 외부 모델의 복구 행동은 이 자동 시험에 포함하지 않았다.

## 2026-09-23 A02·A04·A05 시간 정책 검증

- 분리 정책에서 대기 후 실행 예산이 새로 시작되고 대기 만료는 `QUEUE_TIMEOUT`, 실행 만료는 `EXECUTION_TIMEOUT`으로 구분되는 큐 회귀를 확인했다. 기존 `DEADLINE`·사용자 `CANCELLED` 회귀도 유지한다.
- 브리지 카탈로그의 유효 timeout 메타데이터 전파와 가상 시간으로 61초 뒤 도착한 backend 응답을 확인했다. 실제 61초 벽시계 대기 및 외부 MCP 클라이언트의 고유 timeout은 별도 미검증이다.
- DB schema v1→v5 백업·마이그레이션과 재개방을 확인했다. 실제 사용자 DB 백업/마이그레이션과 장시간 외부 모델 호출은 이번 자동 검증 대상이 아니다.
- `npm run build`, `npm run typecheck`, `npm run lint`, Vitest 단일 worker 22개 파일·72개 테스트, Edge E2E 1개 통과. E2E에서 분리 정책 45초/180초 입력과 저장 후 복원을 확인했다. 기본 병렬 Vitest는 72개 중 69개 통과, 다른 기존 3개가 공통 5초 상한에 걸렸으나 해당 파일 단독·단일 worker 전체 실행에서 모두 통과했다.

## 2026-09-23 A01 scope 전달 및 기존 설정 보존 검증

- 저장된 builtin 코드 템플릿을 이전 정의로 되돌린 시험 DB를 다시 열어 같은 ID에서 버전이 증가하고 새 scope 메시지·선택 workspace 설명이 반영되는지 확인했다. 기존 에이전트의 초안과 적용 버전 ID는 재시작 후 그대로 유지됐다.
- 기존 에이전트 목록의 적용 버전 scope 누락 표시, 템플릿 차이 미리보기, `prompts`만 초안에 적용한 후 공개 버전 보존, 명시적 재적용 후 표시 해제를 확인했다. 신규 코드 템플릿의 고유 scope 문자열과 workspace 문맥 안내가 로컬 모의 공급자 요청에 실제 포함됐다.
- `npm run build`, `npm run typecheck`, `npm run lint` 통과. Vitest 22개 파일·70개 테스트 통과. Edge E2E 1개 통과(약 9.7초, 수동 개입 없이 exit 0).
- 실제 사용자 DB의 영향 에이전트 개수, 외부 클라우드 모델 호출 및 UX12의 모호한 경로·오류 복구는 이번 검증에 포함하지 않았다.

## 2026-09-23 후속 개선 조사와 검증 계획

- 이번 작업은 소스·기존 검토 문서 대조와 해결 방안 작성만 수행했다. 제품 코드·사용자 설정 변경, 새 자동 테스트, 외부 모델 호출, 창 깜빡임 재현, 로컬 DB 재조회는 하지 않았다.
- 모델 중복 표시는 ModelOptions의 label/modelId 조합과 등록 시 동일 값 저장으로 확인했다. DPAPI PowerShell 호출의 windowsHide 누락은 확인했으나 실제 깜빡이는 창과의 인과는 미검증이다. scoped 상대/절대 경로 지원은 기존 구현으로 재확인했다.
- 후속 검증은 [검토 해결 계획](docs/IMPLEMENTATION_REVIEW.md)과 [UX10–UX12](docs/USABILITY_ISSUES.md)의 인수 기준을 따른다. scope 실제 요청 도달, 60초 초과 브리지 응답, 대기/실행 제한 분리, 동일 모델의 프로바이더 구분, Windows 실제 창 비노출, 모호한 경로/동명 파일 오수정 방지가 핵심이다. 아직 통과한 시험으로 집계하지 않는다.

## 2026-09-23 과거 실사용 평가 해석 정정

현재 소스·설치 SDK·실행 DB를 대조한 재검토는 [전체 구현 검토](docs/IMPLEMENTATION_REVIEW.md)의 같은 날짜 절을 따른다. 아래 과거 기록의 측정값은 유지하되 다음 원인 추정과 평가 해석을 정정한다.

- expectedHash/replace_text 지침은 이미 도구 정의에 있었다. '지침이 없어 실패했다'는 설명을 철회한다. 오류 인수가 저장되지 않아 HASH_CONFLICT의 세부 원인은 미확정이다.
- test3 동시 접수 배치의 뒤 세 건은 약 119초 대기하고 약 1초 실행 후 제한시간에 도달했다. 넓은 공통 workspace 잠금과 접수 시점부터 계산하는 deadline의 영향이므로 test3·4 배치 결과를 모델 자체의 동시 처리 능력 부족으로 단정하지 않는다.
- durationMs는 대기·모델·도구를 포함한 서버 전체 시간이다. providerMs/순수 추론 속도로 해석하지 않는다. STDIO 브리지에는 SDK 기본 60초와 서버 기본 120초의 불일치가 있다. 개별 외부 클라이언트 timeout 계층은 별도 구분이 필요하다.
- middle의 외부 계정 사용량과 실패 요청 누적 때문에 429가 지속됐다는 설명은 입증되지 않았다. 실제 성공한 읽기 도구 실행 뒤 후속 모델 요청에서 한도 오류가 발생했다. advance의 400도 원인 미확정이며 tool-call 비호환 확정 판정을 철회한다.
- 코딩 템플릿은 scope를 전달하지 않았다. 파일이 변경되지 않았다는 관측만으로 범위 지시 준수를 검증할 수 없다. completed/succeeded는 과제 인수 성공을 보장하지 않는다. 세 코딩 에이전트의 변경 없는 기준선 점수는 구현 능력 비교 결과가 아니다.
- 이번에는 공급자 재호출·제품 코드 변경·새 회귀 테스트 없이 기록과 구현을 조사했다. 아래 과거 시험의 수행 사실과 현재 해석을 구분한다.

## 2026-09-21 UX09 scoped 상대·절대 경로 검증

- `WorkspaceTools`에서 동일 파일을 상대 경로와 범위 내부 절대 경로로 읽어 내용·hash·상대 결과 path가 같은지 확인했다. 절대 경로 쓰기·수정, 기준 폴더 절대 목록, Windows 대소문자·혼합 구분자·공백 경로도 통과했다.
- 범위 밖 절대 경로, `..` 부모 이동, 유사 접두사 형제 폴더, junction root·중간 경로·실행 중 교체를 거부했다. scoped `run_command.cwd`는 범위 내부 절대 경로로 실행되고 범위 밖 cwd는 명령 실행 전에 거부됐다. full의 상대 경로 거부와 기존 전역 잠금도 유지됐다.
- 로컬 모의 공급자→실제 서버→파일 도구 통합 흐름에서 기준 폴더의 절대 목록, 상대 생성, 절대 읽기·해시 수정, 범위 밖 절대 목록 거부 후 정상 완료를 확인했다. 내부 모델 설명과 공개 MCP 설명·도구 결과에 설정 root가 포함되지 않았다.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers=2`: 22개 파일·69개 테스트 통과. `npm run test:e2e`: Edge 1개 통과, 11.3초, 수동 개입 없이 exit 0.
- UNC·실제 다중 드라이브는 미검증으로 유지한다. 실제 NVIDIA HTTP 500은 도구 호출과 별개로 재현된 공급자 오류이며 UX09 완료로 처리하지 않는다.

## 2026-09-21 UX09 구현 전 기준선

- 요구를 “실제 작업 폴더 경로 비공개, scoped 범위 내부의 상대·절대 경로 모두 허용”으로 확정했다. 이 단계에서는 제품 코드를 변경하지 않았다.
- `npx vitest run tests/p4.test.ts tests/io-diagnostics.test.ts --maxWorkers=1`: 2개 파일·16개 테스트 통과.
- 당시 진단 통합 테스트는 고정 폴더의 절대 경로를 `PATH_FORBIDDEN`으로 기록하고 상대 경로 create/read/replace를 완료했다. 위 UX09 완료 검증에서는 범위 내부 절대 경로 성공과 실제 범위 밖 절대 경로 거부로 기준을 변경했다.

## 2026-09-21 파일 입출력 및 오류 진단 검증 (UX09 이전 이력)

- `tests/io-diagnostics.test.ts`: 로컬 모의 공급자 → 실제 관리 API/실행 루프/파일 도구 통합 시험. 절대 경로 요청의 `PATH_FORBIDDEN`을 모델에 반환하고 이벤트에 저장한 뒤, 상대 경로로 파일 생성·읽기·해시 기반 수정이 완료되어 실제 디스크 내용이 `alpha=2`인지 확인했다. 모델에 기준 폴더와 상대 경로 설명이 전달되는 것도 검증했다.
- `npm run build`, `npm run typecheck` 통과. 전체 lint는 신규 테스트의 explicit-any 경고가 있었으며 타입 수정 후 해당 파일 ESLint 재검사는 경고 없이 통과했다. `npx vitest run --maxWorkers=2`: 22개 파일·69개 테스트 통과. 이번 변경의 브라우저 E2E는 수행하지 않았다.
- 실제 등록된 고급 NVIDIA 모델에 인공 파일만 대상으로 상대 경로 입출력을 요청했으나 약 410ms 후 `PROVIDER_ERROR` HTTP 500으로 실패했다. 도구 호출 0회, 입력 그대로, 출력 미생성 확인. 시험 파일은 정리했고 사용자 설정·서버 프로세스는 변경하지 않았다.
- 기존 경량 실패 두 건은 도구 실행 전 HTTP 500, 고급 실패 한 건은 `list_files` 실패 후 HTTP 500이었다. 과거 이벤트에는 파일 오류 코드가 없어 원인을 복원할 수 없다. 로컬 입출력 통과와 실제 NVIDIA 모델의 미검증 상태를 구분한다.

## 2026-09-20 작업 폴더 안내 문구 변경

- 웹 Vite 빌드와 전체 typecheck 통과. main.tsx 대상 ESLint는 현재 설정에서 매칭되지 않아 ignored 경고를 반환했으며 해당 파일 lint 검증 완료로 간주하지 않는다.
- Edge E2E 첫 실행은 초안 복원 후 시스템 프롬프트 값 확인(기존에도 실패 이력 있음)에서 실패했다. 남아 있던 시험 폴더 안내 표현을 통일하고 웹 재빌드 후 재실행하여 1 passed(10.6초), exit 0 확인. 초안 복원 실패의 근본 원인을 수정한 것은 아니다.
- 폴더 정책의 표시명·경로 입력명·하위 포함 범위·시험 실행 설명을 변경했다. 권한 정책의 구현과 사용자 저장 설정은 변경하지 않았다.

## 2026-09-18 실제 MCPex 호출 및 수정 재확인

- build/typecheck/lint 통과, Vitest 21개 파일·68개 테스트 통과, Edge E2E 1개 통과(8.2초, 수동 개입 없이 exit 0).
- N04 junction root 거부와 N05 commandId enum·label 전달/실행 파일 비노출/빈 allowlist 도구 제외를 빌드 산출물로 확인했다.
- 실제 등록된 chat/doc_tool/architecture/code_research/coding 5개 호출 모두 completed/succeeded. 응답 3개와 읽기 전용 파일 작업 2개를 수행했다. 후자는 각각 read_file 1회·성공 이벤트를 확인하고 package.json 실제 값과 대조했다. changes/checks는 전부 빈 배열이었다.
- T14/T15는 부분 검증으로 갱신한다. 실제 클라이언트 재연결·동적 목록 변경·취소, 쓰기/명령 실행과 다른 모델은 미검증이다. 사용자 설정은 변경하지 않았다.

## 2026-09-18 N05 commandId 모델 전달 검증

- 실제 서버가 로컬 모의 모델에 보낸 `run_command` 정의에서 임의 ID `private_test_runner_942`가 commandId enum에, `Run test suite`가 설명에 포함되고 실제 executable 경로는 포함되지 않는 것을 확인했다. 같은 ID의 allowlist 명령 실행도 exit 0으로 완료됐다.
- allowlist가 비어 있으면 `run_command` 정의가 생성되지 않고 MCP 연결 정보의 `effectiveTools=[]`, `workspaceState=no_tools`가 되는 것을 확인했다.
- 전체 build/typecheck/lint와 Vitest 21개 파일·68개 테스트 통과. Edge E2E는 초안 복원 값 반영 단계에서 1회 실패했지만 동일 빌드 즉시 재실행은 1개 시나리오 통과·exit 0이었다.

## 2026-09-18 N04 junction workspace 경계 검증

- 정상 작업 폴더는 실제 경로로 확정되고, 작업 폴더 자체와 중간 상위 경로가 심볼릭 링크 또는 Windows junction이면 `PATH_FORBIDDEN`으로 거부되는 것을 확인했다.
- caller 허용 루트 아래 junction을 workspace로 전달한 실제 관리 API 요청은 HTTP 403 `WORKSPACE_NOT_ALLOWED`로 거부됐다. 정상 caller UI/MCP 실행과 실행 스냅샷은 기존대로 통과했다.
- 전체 build/typecheck/lint, Vitest 21개 파일·68개 테스트, Edge E2E 1개(약 8초, exit 0) 통과. 경로 구성요소의 악의적인 동시 교체와 UNC·다중 드라이브 실환경 검증은 별도다.

## 2026-09-18 수정 후 독립 재검증

- build/typecheck/lint와 diff 공백 검사 통과. Vitest 21개 파일·67개 테스트 통과.
- Edge E2E 1개 통과, 약 8초 후 수동 개입 없이 exit 0. 이전 종료 정리 실패와 구분해 수정 확인.
- 실제 동시 자동 시작 두 호출 모두 fulfilled·health 200. full 도구 필수 경로 스키마와 `..cache` 잠금 재확인.
- 임시 Windows junction·로컬 모의 모델 통합 검사에서 caller 허용 루트 밖 시험 파일이 모델 요청에 전달됨을 재현했다(N04). 허용 명령을 등록해도 해당 ID와 label은 모델 요청에 없음을 확인했다(N05). [최신 검토 보고서](docs/IMPLEMENTATION_REVIEW.md)에 기록했다.
- 임시 데이터·junction·데몬은 정리했다. 기본 사용자 데이터·실제 외부 모델은 사용하지 않았다. N04·N05는 기존 67개 테스트가 탐지하지 못한 추가 경계이며 미해결이다.

## 2026-09-18 Playwright E2E 무인 종료 회귀 검증

- Playwright가 셸 명령으로 별도 서버 프로세스를 관리하던 구성을 `globalSetup`/반환 teardown 구조로 변경했다. teardown은 MCPex Fastify 서버와 모의 모델 HTTP 서버를 직접 닫는다.
- `npm run test:e2e`를 연속 2회 실행했다. 두 실행 모두 Microsoft Edge 수직 흐름 1개 통과 후 각각 약 13초·10초 안에 exit 0으로 종료됐다.
- 첫 실행 뒤 두 번째 실행이 같은 47931/47932 포트로 정상 기동했고, 두 번째 종료 뒤 47931 LISTENING 항목이 없음을 확인했다. 수동 프로세스 종료 없이 반복 실행과 포트 정리가 통과했다.

## 2026-09-18 N03 workspace 잠금 경계 검증

- 부모 workspace 잠금을 유지한 상태에서 일반 `child`와 이름이 `..`로 시작하는 실제 하위 폴더 `..cache` 모두 `canRun=false`가 되는 것을 확인했다.
- 같은 부모와 무관한 독립 workspace는 `canRun=true`이고, 반대로 일반 자식 잠금을 유지한 상태에서는 부모가 `canRun=false`인 양방향 포함 관계를 확인했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·67개 테스트 통과.

## 2026-09-18 N02 전체 접근 도구 스키마 검증

- scoped 정의에서 `list_files.path`와 `run_command.cwd`가 선택 항목인 기존 계약을 유지하고, full 정의에서는 두 필드와 나머지 파일 도구 path가 required이며 절대 경로 설명을 갖는 것을 확인했다.
- `WorkspaceTools(null)`에 full 스키마가 요구하는 절대 경로를 전달해 `list_files`가 성공하고, 허용한 Node 명령이 절대 cwd에서 exit 0으로 실행되는 것을 확인했다.
- 서버 통합 모의 모델 요청에서 full 에이전트의 OpenAI tool schema에 `list_files.path` required와 절대 경로 설명이 실제로 포함되는지 검사했다. 모의 모델이 해당 절대 경로로 도구를 호출해 `full-schema-complete`로 종료하고 실행 스냅샷이 `workspaceSource=full`인 것도 확인했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·66개 테스트 통과.

## 2026-09-18 N01 동시 자동 시작 경쟁 검증

- `ensureService` 두 호출이 모두 서비스 부재를 확인한 뒤 start를 시도하고, 두 번째 start가 실제 자식 exit 형식의 오류를 반환하는 회귀 테스트를 추가했다. 승리한 서비스가 준비되면 두 호출 모두 완료된다.
- 명시적 `DATA_DIR_LOCKED` 시작 오류는 polling에 들어가지 않고 즉시 반환하는 기존 검사를 유지했다. 준비되지 않는 정상 start는 제한 시간 후 오류가 되며, 다른 서비스 응답과 외부 주소 자동 시작도 계속 거부한다.
- 빌드 산출물을 임시 데이터 폴더와 임의 loopback 포트에서 실제 `ensureService` 두 개로 동시에 실행했다. 두 결과가 fulfilled이고 `/health`가 HTTP 200인 것을 확인한 뒤 PID·포트·health·잠금 소유자를 대조해 해당 테스트 서비스와 임시 폴더만 정리했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·65개 테스트 통과.

## 2026-09-18 독립 재검증

- build/typecheck/lint 통과, Vitest `--maxWorkers=2` 21개 파일·64개 테스트 통과.
- Edge E2E 기능 1개 통과. 테스트 서버 정리 대기 때문에 해당 테스트 PID만 수동 종료한 뒤 최종 exit 0 확인. 무인 종료는 실패로 분리해 관리한다.
- 기존 테스트 외 경계 재현: 임시 DB·임의 포트의 동시 ensureService 2개 중 1개 실패(서비스 health 200), full 도구의 스키마상 유효한 경로 생략 호출 2종이 PATH_FORBIDDEN, 부모 잠금 중 `..cache` 하위 폴더 실행 허용을 확인했다. [검토 N01–N03](docs/IMPLEMENTATION_REVIEW.md)에 재현·수정 기준을 기록했다.
- 실제 사용자 DB·서비스 설정은 변경하지 않았다. 실제 모델·사용자 MCP 클라이언트·원격 연결·전체 복구 검증은 미수행이다.

## 2026-09-18 P4 외부 영향 범위 안내 검증

- 실제 MCP SDK client의 `tools/list`에서 파일 도구가 실효 권한인 적용 에이전트 설명에 클라우드 모델 외부 전송 안내가 포함되는 것을 확인했다.
- MCP 연결 정보 API에서 파일 도구와 `run_command`가 실효 권한인 에이전트 설명에 외부 전송 및 현재 OS 사용자 권한·비-sandbox 안내가 모두 포함되는 것을 확인했다.
- Edge E2E에서 전체 접근의 파일 도구 안내, `run_command` 선택 시 명령 실행 권한 안내, 적용·활성화 후 MCP 연결 화면의 외부 전송 설명을 확인했다. 기능 시나리오는 통과했으며 기존 runner 종료 정리 지연 때문에 성공 출력 후 수동 종료했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·64개 테스트 통과.

## 2026-09-18 실사용 개선 UX07 전체 파일 접근 검증

- 임시 폴더 두 곳을 사용해 `full` 정책이 서로 다른 루트의 절대 경로를 읽고, 상대 경로는 `PATH_FORBIDDEN`으로 거부하는 것을 확인했다.
- 읽기 전용 도구 구성에서 쓰기가 `TOOL_DISABLED`로 거부되고, 쓰기 도구를 선택한 구성에서는 새 파일 작성이 가능한 것을 확인했다. 기존 파일 기대 해시와 명령 allowlist 등 기존 실행 제한은 변경하지 않았다.
- 전체 접근 잠금이 실행 중일 때 scoped 작업이 시작되지 않고 해제 후 실행되는 회귀 테스트로 전체 접근과 모든 고정·호출자 폴더 작업의 전역 직렬화를 확인했다.
- 정책 `full`을 저장·적용·활성화한 에이전트가 MCP 연결 API에서 `workspaceMode=full`, `workspaceState=full`, 선택한 실효 도구를 반환하는 것을 확인했다. 웹 정책 요약도 전체 접근 상태를 별도로 표시한다.
- Edge E2E에서 `전체 접근 (고위험)` 선택 후 OS 사용자 권한·절대 경로 안내, 저장·적용·활성화, MCP 연결 화면의 전체 접근 실효 상태를 확인했다. 비동기 활성화 완료 뒤 에이전트를 전환하도록 테스트 경쟁 조건도 제거했다. 기능 시나리오는 통과했으며 기존 runner 종료 정리 지연 때문에 성공 출력 후 수동 종료했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·64개 테스트 통과.
- 실제 Windows 다중 드라이브·UNC 공유, junction 및 ACL 거부 경로는 수동 미검증이다. 자동 테스트는 권한 상승을 수행하지 않으며 실제 사용자 파일을 읽거나 변경하지 않는다.

## 2026-09-18 실사용 개선 UX08 호출자 폴더·실효 도구 검증

- 실효 도구 계산 단위 테스트 3개에서 응답 모드, Workspace 도구+정책 `none`, 고정 폴더, 호출자 폴더와 알 수 없는 도구 필터링을 확인했다. 정책 `none`에서는 선택 도구가 있어도 실효 목록이 비어 있다.
- MCP 연결 API 테스트에서 적용 버전이 도구 모드·정책 `none`일 때 `runtimeMode=tools`, `workspaceMode=none`, `effectiveTools=[]`, `workspaceState=workspace_disabled`를 반환하고 이후 미공개 초안의 고정 폴더 설정은 섞이지 않는 것을 확인했다.
- 기존 P4 회귀 테스트로 UI 시험 본문의 별도 `workspace`, MCP `_meta["io.mcpex/workspace"]`, 누락 422, 허용 루트 밖 403, 실행 스냅샷 고정을 다시 확인했다.
- Edge E2E에서 코드 템플릿의 `Workspace 도구 + 사용 안 함` 조합이 실효 도구 ‘없음’과 해결 안내를 표시하고, 적용·활성화 후 MCP 연결 화면도 내부 파일·명령 도구 0개로 구분하는 것을 확인했다. 기능 시나리오는 통과했으며 기존 runner 종료 정리 지연 때문에 성공 출력 후 수동 종료했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 21개 파일·61개 테스트 통과.
- 실제 Codex가 MCPex 전용 `_meta`를 자동으로 보내는 동작은 공식 문서에서 확인되지 않았고 실제 대상 클라이언트 검증도 미수행이다. UI는 자동 전달을 보장하지 않고, 지원하지 않는 클라이언트에는 고정 폴더 정책을 안내한다.

## 2026-09-18 실사용 개선 UX06 Codex 등록 안내 검증

- 연결 안내 생성기 단위 테스트 2개에서 공백이 있는 Windows 실행 경로, 순서가 있는 인자 2개, 환경 변수 키/값 정렬, 빈 패스스루·`cwd`, 공식 `[mcp_servers.mcpex]` TOML 출력을 확인했다. 필드별 command/args는 JSON 따옴표·배열·중복 백슬래시가 없는 원시 값이다.
- Edge Playwright 수직 흐름에서 Codex 등록 화면과 같은 필드 순서, `STDIO`, 인자별 표시, 두 번째 인자 `mcp`의 실제 클립보드 값, 전체 TOML 복사, 원격 미지원 안내와 비밀 제외 문구를 확인했다. 기능 시나리오는 통과했으며 기존 runner 종료 정리 지연 때문에 성공 출력 후 수동 종료했다.
- 설치된 Codex CLI의 영구 설정을 바꾸지 않고 `-c`로 생성한 command/args를 주입해 `codex mcp get mcpex --json`이 `stdio`, 실행 명령, 인자 2개, 빈 `env_vars`, `cwd: null`로 해석하는 것을 확인했다.
- `npm run build`, `npm run typecheck`, `npm run lint`와 `npx vitest run --maxWorkers=2`: 20개 파일·58개 테스트 통과.
- 실제 사용자 Codex 설정에 저장한 뒤 `/mcp` 도구 목록, 도구 호출, 동적 목록 갱신과 재연결을 확인하는 T14는 미수행이다. 다른 호스트의 인증 연결/미인증 거부는 원격 기능 자체가 미지원이므로 후속 설계 범위다.

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
| T09 | 파일 도구       | fixture 읽기/검색/생성/교체, 경로 이탈·junction·충돌 차단, 출력 한도                  | 부분 통과: 읽기·검색·새 파일 생성, 기존 파일 expectedHash 강제·불일치 차단·원자적 쓰기·경로 이탈, root·중간 상위 junction 거부, 초과 파일 검색 제외와 목록·검색 직렬화 상한 통과; 경로 구성요소 동시 교체 경쟁은 미검증                                                                       |
| T10 | 명령·루프       | 명령 opt-in, argv 보존, 환경 격리, 도구 오류 재입력, 반복 한도, 프로세스 트리 취소    | 부분 통과: allowlist·shell=false argv·부모 비밀 환경 차단·최소 PATH 유지·반복 루프와 stdout/stderr 수집 단계 합산 상한 통과; 실제 프로세스 트리 취소와 장시간 RSS는 미검증                                                                                                                    |
| T11 | 복구·이벤트     | 재시작 interrupted, 변경 보존, SSE seq 재개, terminal 멱등 취소                       | 부분 통과: 재시작 interrupted, terminal 취소 멱등, 이벤트 순서·live SSE·커서 재개·model/tool/cancel 기록과 보존 만료 410 통과; 실제 CLI signal은 미검증                                                                                                                                       |
| T12 | 설정 이동·보존  | export 비밀 제외, import 충돌·ID 재매핑·비활성, 기간 정리·백업                        | 부분 통과: 민감정보·로컬 경로 제외, 충돌 무변경, UUID/참조 재매핑, 비활성 초안, 기간 정리와 읽을 수 있는 온라인 백업 통과; UI 조작·전체 복구 재기동은 미검증                                                                                                                                  |
| T13 | UI 수직 흐름    | Playwright로 등록→에이전트 2개→시험→활성→MCP 정보→기록→편집 재적용→초안 정리·삭제     | 모의 검증 완료: Edge에서 fragment 인증, provider/model, 스키마 입력, 시험 진행·결과·재조회, 고정 알림, 활성·적용, MCP 등록 필드·활성 도구, 기록, 초안 정리, 삭제 확인·참조 충돌·선행 순서 통과                                                                                                |
| T14 | 실제 클라이언트 | 사용자 MCP 클라이언트에서 목록·호출·재연결 동작                                       | 부분 통과: Codex에 등록된 5개 도구 노출·실제 호출 성공. 재연결·동적 변경·취소는 미검증.                                                                                                                                                                                                       |
| T15 | 실제 모델       | 선택한 local/cloud 모델에서 응답·JSON·도구 호출, 결과 관측 대조                       | 부분 통과: 등록 모델의 응답 3개·read_file 2개 성공, 실제 파일·이벤트 대조. JSON·쓰기·명령·다른 모델은 미검증.                                                                                                                                                                                 |

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

## 2026-09-21 상대·절대 경로 파일 입출력 시험

- 실제 coding_light MCP 호출: 상대 경로 시험(runId 8f72579f-3a91-4cb7-8d61-22af1fc97557)은 공급자 HTTP 500으로 내부 도구 실행 0회. 절대 경로 시험(runId e0d31721-26f7-4e64-aeac-8f1dea1e116c)은 read_file 1회 실패 후 다음 모델 요청에서 HTTP 500. 이벤트에는 read_file 실패의 상세 오류/인자가 없어 원인은 확정하지 않음. 모델 경유 파일 입출력은 검증 실패.
- 같은 환경의 빌드된 @mcpex/tools WorkspaceTools와 executeWorkspaceTool을 직접 호출하고 고정 루트 C:\Users를 적용: 상대 경로와 허용 루트 내부 절대 경로 모두 read_file → write_file(createOnly) → read_file → replace_text(expectedHash) → read_file 통과. 실제 디스크의 value=17 → value=23 변경과 입력 원본 보존을 assert로 확인.
- 시험에는 임시 합성 파일만 사용했고 모두 정리함. 직접 모듈 검증은 Codex→MCPex→NVIDIA 모델 경유 성공을 의미하지 않음. 사용자 설정은 변경하지 않음.

## 2026-09-21 파일 I/O 재시험 및 HTTP 500 발생 단계 확인

- 초기 재호출은 fetch failed였고 127.0.0.1:47831 health가 ECONNREFUSED, 새 실행 기록 없음. CLI ensureService로 백그라운드 서비스 시작 후 재시험.
- coding_light 상대 경로(runId 0d006bfe-9917-44df-9af0-aafc5f62a72f): completed/succeeded, read_file → write_file → read_file 3회 성공.
- coding_light 절대 경로(runId 7499e115-e2fd-4b52-9d4d-a2c4936c5428): read_file과 write_file 모두 tool.finished ok=true. 그 결과를 포함한 3번째 모델 요청에서 PROVIDER_ERROR HTTP 500 Internal server error. 재읽기 단계는 도달하지 못함.
- 실행 snapshot의 API는 https://integrate.api.nvidia.com/v1, openai-chat adapter. 어댑터는 /chat/completions HTTP 응답이 비정상일 때 실제 response.status로 ProviderError를 생성한다. 이번 500의 반환 지점은 NVIDIA API이며 MCPex 파일 도구 예외가 아니다. NVIDIA 내부 장애인지 요청 내용/호환성에 따라 발생하는 오류인지 근본 원인은 미확정.
- 실제 디스크 검사: 두 출력 파일 모두 생성되어 기본 텍스트는 일치하나 마지막 LF가 빠짐(입력 29바이트, 출력 28바이트). 따라서 입출력 수행과 바이트 단위 완전 복사는 구분한다. 모든 합성 시험 파일 정리 완료, 사용자 설정·구현 코드 변경 없음.

## 2026-09-21 신규 테스트 에이전트 재시작 및 비교 시험

- 실행 중 작업이 없는 상태에서 확인된 MCPex serve 프로세스를 재시작하고 health 정상 확인. 공식 MCP SDK로 /mcp에 연결해 coding_advanced/coding_light/test1/test2/test3 목록을 확인하고 테스트 3개를 순차 호출. 사용자 설정 변경 없음.
- 입력은 임시 합성 파일(Synthetic MCPex agent test, value=17)만 사용. 상대·절대 경로 읽기/쓰기/재읽기를 요청했으며 제공된 경로 이외 탐색을 금지했다.
- test1(openai/gpt-oss-20b), runId 3f87d8cf-7de6-490e-a67c-f9522b6c66c2: 119.866초 completed/succeeded이나 인수 조건 미충족. read_file ENOENT, write_file ACCESS_DENIED, 금지한 list_files ACCESS_DENIED, 마지막 read_file 성공. 출력 파일 없음. 답변의 절대 경로 쓰기 실패 주장은 해당 호출 기록이 없어 검증된 사실로 취급하지 않음.
- test2(poolside/laguna-xs-2.1), runId 78ce8c4b-0a80-4277-bd62-83f352d3901a: 120.020초 DEADLINE. list_files 2회 ACCESS_DENIED, read_file 3회 BAD_INPUT 및 1회 ENOENT, 총 6회 도구 시도. 읽기/쓰기 성공 없음.
- test3(meta/muse-glimmer-30b), runId a3cbccf6-ab38-4dd8-898d-9f4dc5d12d0d: 120.013초 DEADLINE. read_file ENOENT, list_files ACCESS_DENIED, 마지막 read_file 성공. 출력 파일 없음.
- 이번 세 실행에서는 PROVIDER_ERROR/HTTP 500이 관측되지 않음. 경로 선택·인자 형식·지시 준수와 작업 deadline 문제가 관측됐으며, 모델 답변의 성공 주장을 실제 도구 기록과 분리해 평가함. 입력 원본 보존 및 생성 출력 없음 확인 후 임시 파일 정리.

## 2026-09-21 Wireshark 관측용 재호출

- 고정 루트 C:\Users 기준 전체 상대 경로를 그대로 사용하도록 명시해 test1→test2→test3 순차 실행. 모두 completed/succeeded, 각각 read_file→write_file→read_file 3회 수행, HTTP 500 없음.
- 한국 시간 클라이언트 호출 구간: test1 01:21:41~~01:23:23(runId 80620aad-59d3-4b31-9c0c-413f14d0b421), test2 01:23:32~~01:24:13(a2e86b28-c12d-498f-931c-ea73922590a7), test3 01:24:23~01:25:00(8d5009a0-5294-4afb-b41e-36e90cadb1fa).
- 실제 디스크 비교: 입력 38바이트. test1/test2 출력은 마지막 LF가 빠진 37바이트라 바이트 동일성 실패. test3 출력은 38바이트로 원본과 완전히 동일. 답변 서술 대신 디스크 비교를 기준으로 판정.
- 합성 파일만 사용하고 정리 완료. 사용자 설정 변경 없음. 패킷 캡처 자체는 사용자가 수행하며 본 기록은 MCP 호출 결과임.

## 2026-09-21 Nemotron 캡처용 비교 재호출

- 동일한 합성 파일의 상대 경로 read→write→read를 Super→Ultra 순서로 요청.
- Super(coding_light), runId 3f621a20-5aba-4ddb-b320-155cf0cfd529: 한국 시간 호출 구간 01:26:43~~01:26:49, 서버 실행 01:26:48.772~~48.959. 첫 모델 요청에서 HTTP 500, 도구 실행 0회.
- Ultra(coding_advanced), runId bbd4fca3-8498-472b-b327-505a68f23da9: 한국 시간 호출 구간 01:27:01~~01:27:09, 서버 실행 01:27:05.585~~08.649. read_file 성공 후 두 번째 모델 요청에서 HTTP 500. 쓰기 미실행.
- 두 실행 모두 생성 출력 없음. 임시 합성 파일 정리. 직전 test1/test2/test3의 성공과 비교해 이번 Nemotron 요청에서는 500이 재현됐으나 모델/요청/공급자 내부 원인을 확정하지 않음.

## 2026-09-21 LLMGateway Nemotron Ultra 비교 시험

- 신규 활성 도구 llmgtw_test, 공급자 https://api.llmgateway.io/v1, 모델 nemotron-3-ultra-550b를 공식 MCP SDK로 호출. 기존 NVIDIA 도구와 다른 기본 코드 작업 프롬프트이므로 공급자만 통제한 A/B 시험은 아님.
- 텍스트 runId 76b50e41-cd4f-44e5-91fa-a503acf7fe60: 17+25에 42 반환, completed/succeeded, 도구 0회, 서버 실행 2.036초.
- 합성 파일 runId 72fb77a1-e9e7-4420-83e8-df8142f48c93: completed/succeeded, 49.585초. read/write/re-read 과정에서 총 도구 9회. 최초 출력은 끝 LF 누락, 한 번 EXPECTED_HASH_REQUIRED 후 다시 읽고 쓰기를 반복해 최종 원본 38바이트와 완전히 동일한 출력 생성 확인. write_file 성공 4회, read_file 성공 4회, write_file 실패 1회. HTTP 500 없음.
- 입력 원본 보존 및 최종 파일 바이트 비교 후 임시 합성 파일 정리. 사용자 설정 변경 없음. 일회 성공으로 장기 안정성 또는 NVIDIA 직접 연결 오류 원인이 확정되는 것은 아님.

## 2026-09-22 coding_light / coding_advanced 재호출

- 합성 파일 상대 경로 read→write→read 시험을 순차 수행. 설정 변경 없음.
- coding_light runId 422196f7-0ec5-4633-bd83-a8d0250fb3b7: read_file 성공 후 PROVIDER_ERROR HTTP 500. 쓰기 없음, 10.371초.
- coding_advanced runId 857ce801-97f4-490e-aeff-79e2da4a2983: Codex 호출은 Request timed out. 서버는 계속 실행되어 약 100.203초 후 PROVIDER_ERROR HTTP 500으로 종료. read_file→write_file→read_file 성공 후 write_file이 EXPECTED_HASH_REQUIRED로 실패하고 이후 모델 요청 500. 실제 출력은 입력 36바이트에서 마지막 LF가 빠진 35바이트로 완전 복사 실패.
- 서버 terminal 상태를 확인한 뒤 합성 입력/출력 파일 정리. 사용자 프로젝트 파일 변경 없음.

## 2026-09-22 test1~test4 동일 조건 MCP 직접 호출

- 동일 합성 파일의 read_file→write_file(createOnly)→read_file을 Codex 노출 도구로 순차 호출. 시간 초과 시 서버 terminal 상태까지 확인해 중복 실행하지 않음.
- test1 / GPT-OSS 20B: runId bad21649-99d4-49f8-88b3-94e99fa71bbf. 도구 실행 0회, 서버 120.028초 DEADLINE. 출력 없음.
- test2 / Laguna XS 2.1: runId f2a6bfad-8cd1-477c-9683-d4025d30868d. read_file 성공 후 6.132초에 HTTP 503 ResourceExhausted: Worker local total request limit reached (32/32). 출력 없음.
- test3 / Muse Glimmer 30B: runId da6826a1-12a8-41fa-83a7-a94789f6a7c3. Codex 호출 Request timed out 이후 서버 68.269초 completed. read/write/read 모두 성공, 실제 디스크에서 36바이트 원본과 완전 일치.
- test4 / GLM 5.3 Flash: runId 6458d9ed-3327-4c60-8340-d6e4b61014d1. Codex 호출 Request timed out 이후 서버 74.120초 completed. read/write/read 모두 성공, 실제 디스크에서 36바이트 원본과 완전 일치.
- 이번 실행에서 HTTP 500은 관측되지 않음. 합성 입력 원본 보존, 임시 파일 정리 완료. 모델/공급자/권한 설정은 변경하지 않음.

## 2026-09-22 test1/test2 OpenRouter 재시험

- 실제 실행 snapshot에서 test1은 OpenRouter nvidia/nemotron-3-ultra-550b-a55b:free, test2는 OpenRouter poolside/laguna-s-2.1:free로 확인. 이전 모델 이름을 재사용해 판단하지 않음.
- test1 runId ea3f3746-1f84-446c-85bf-f800c9290ba5: Codex Request timed out 이후 서버 약 63.768초 failed. read_file ENOENT 이후 read/write/read 성공, 후속 응답에 텍스트나 도구 호출이 없어 PROVIDER_ERROR. 실제 출력 35바이트로 입력 36바이트의 마지막 LF 누락.
- test2 runId 0b55f8de-eab0-4ab0-91a0-7921237ab4aa: 약 0.270초 HTTP 429 Provider returned error, 도구 0회·출력 없음.
- 이번에는 HTTP 500 없음. 합성 파일만 사용했으며 종료 확인 후 임시 파일 정리, 사용자 설정 변경 없음.

## 2026-09-22 test1/test2 모델 변경 후 재시험

- 실제 snapshot: test1=OpenRouter nex-agi/nex-n2.5-pro:free, test2=OpenRouter cohere/north-mini-code:free.
- test1 runId c92c5a2b-e58d-4ad7-bfaf-f2dc3b03b111: 16.781초 completed/succeeded. read_file→write_file→read_file 모두 성공, 도구 3회.
- test2 runId b67cc45c-fd36-47e5-a527-4648048e4769: 5.958초 completed/succeeded. read_file 성공, 추가 read_file ENOENT 1회 후 write_file/read_file 성공, 도구 4회.
- 두 출력 모두 실제 디스크에서 입력 36바이트와 마지막 LF까지 완전 일치. 최종 답변 정상 수신, HTTP 429/500 및 시간 초과 없음. 임시 합성 파일 정리, 사용자 설정 변경 없음.

## 2026-09-22 test1~test4 20회 연속 안정성 평가

- 한국 시간 02:40:56~02:52:15에 공식 MCP SDK로 test1부터 test4까지 에이전트별 20회, 총 80회를 순차 호출했다. 매 호출은 서로 다른 `STABILITY_OK_testN_NN` 한 줄만 반환하도록 요구했고 파일·환경·네트워크·도구 사용을 금지했다. 실행 종료 후 이번 구간 80건과 queued/running 0건을 DB에서 재확인했다.
- 실제 실행 snapshot 기준 구성: test1=OpenRouter `nex-agi/nex-n2.5-pro:free`, test2=OpenRouter `cohere/north-mini-code:free`, test3=NVIDIA `meta/muse-glimmer-30b`, test4=NVIDIA `z-ai/glm-5.3-flash`. 네 에이전트 모두 실행 제한시간은 120초였다.
- test1: 20/20 완료·정확 응답(100%), 오류 0회, 도구 호출 0회. 클라이언트 왕복 지연은 평균 5.009초, 최소 2.130초, p95 12.396초, 최대 26.617초였다.
- test2: 17/20 완료·정확 응답(전체 호출 대비 85%, 완료 응답 정확도 100%), 오류 3회. 클라이언트 왕복 지연은 실패 포함 평균 3.432초, 최소 1.380초, p95 5.598초, 최대 6.732초였다. 18~20번째 호출은 모두 OpenRouter가 `cohere/north-mini-code:free`에 명시한 분당 15회 제한의 HTTP 429로 실패했다.
- test2의 18번째 호출은 최종 429 전에 모델이 금지 지시를 어기고 `list_files` 2회와 `search_text` 2회를 호출했다. 성공 2회·실패 2회였고 쓰기 도구 호출은 없었다. 나머지 79회는 도구 호출 0회였다. 따라서 test2는 공급자 처리량 제한 외에도 지시 준수 안정성 문제 1회를 기록한다.
- test3: 20/20 완료·정확 응답(100%), 오류 0회, 도구 호출 0회. 클라이언트 왕복 지연은 평균 3.403초, 최소 2.189초, p95 5.020초, 최대 12.156초였다.
- test4: 20/20 완료·정확 응답(100%), 오류 0회, 도구 호출 0회. 클라이언트 왕복 지연은 평균 22.148초, 최소 2.667초, p95 36.325초, 최대 48.582초였다. 정확성과 완료율은 안정적이지만 네 구성 중 지연이 가장 크고 편차도 컸다.
- 종합 판정: test1과 test3은 이번 조건에서 안정적이었다. test4는 완료 안정성은 높지만 대기 시간이 길다. test2는 완료된 응답의 내용은 모두 정확했으나 짧은 연속 호출에서 공급자 rate limit과 1회의 불필요한 조회 도구 사용이 발생해 burst 호출 안정성이 낮다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 test2 20회 연속 재평가

- 한국 시간 01:43:44~01:47:05에 이전 평가와 같은 정확 문자열 응답 조건으로 test2를 20회 순차 재호출했다. 실제 snapshot은 OpenRouter `cohere/north-mini-code:free`였으며 파일·환경·네트워크 조사와 모든 도구 호출을 금지했다.
- 20/20 completed/succeeded, 정확 응답 20/20(100%), 오류 0회, 도구 호출 0회였다. 실행 종료 후 최근 실행 20건과 queued/running 0건을 DB에서 재확인했다.
- 클라이언트 왕복 지연은 평균 9.658초, 최소 6.946초, p95 14.635초, 최대 21.791초였다. MCPex가 기록한 provider 처리시간은 평균 2.200초, 최소 0.777초, p95 5.066초, 최대 6.314초였다.
- 직전 평가의 17/20 및 HTTP 429 3회는 이번 재평가에서 재현되지 않았고, 당시 발생한 불필요한 조회 도구 호출도 재현되지 않았다. 다만 OpenRouter 무료 모델의 명시적 분당 제한이 제거됐다고 단정할 수는 없으며, 이번 호출 간 클라이언트 지연이 길어 요청 밀도가 낮아진 영향이 있을 수 있다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 test5 파일 입출력 시험

- 실제 snapshot은 NVIDIA `google/diffusiongemma-26b-a4b-it`, openai-chat adapter, 고정 작업 루트 `C:\Users`, 실행 제한시간 120초였다. 입력의 `workspace` 값은 고정 루트를 바꾸지 않으므로 프로젝트 기준 상대 경로가 아니라 `C:\Users` 기준 상대 경로를 사용해야 한다.
- 최초 상대·절대 경로 복합 시험(runId `9510e64a-97ef-4d73-9242-d38702c307a1`)은 금지한 `list_files`를 호출해 ENOENT로 실패한 뒤, 후속 모델 요청이 HTTP 400 `Empty content is not allowed for assistant messages`로 종료됐다. 단순 상대 경로 재시험(runId `10876919-da66-4ba7-b2d5-9891d95f8bea`)은 `C:\Users` 기준 경로 불일치로 read_file ENOENT가 발생하고 같은 400으로 종료됐다.
- 절대 경로 단일 쓰기 시험(runId `c44c153f-a450-4e47-bdb9-abcf46fec176`)은 write_file 1회가 성공했다. 생성 파일은 원본과 26바이트 및 SHA-256 `E33817AFFE08B050B789537644BC8FD110C4ECCB4625D8D80C1AF67A5CD76CB0`가 일치했다. 단일 읽기 시험(runId `f9c51831-d34e-4d6f-bf96-aec7811c6263`)도 read_file 1회 성공, originalBytes=26을 기록했다.
- 성공한 읽기·쓰기 두 실행도 도구 결과를 모델에 전달하는 다음 요청에서 동일한 공급자 HTTP 400으로 최종 실패했다. 따라서 MCPex 파일 도구와 절대 경로 권한은 정상이나 test5는 현재 도구 사용 후 답변을 완료할 수 없다. 공급자 오류 문구상 assistant tool-call 메시지의 빈 content 처리에 관한 모델/API 호환 문제로 판단하며, 요청 직렬화와 해당 NVIDIA 모델의 tool-call 계약 대조가 필요하다.
- 모든 실행 종료와 queued/running 0건을 확인했고, 합성 입력·출력 파일을 정리했다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 test5 모델 교체 후 재시험

- 실제 snapshot에서 test5가 로컬 공급자의 `openai/gpt-oss-20b`로 교체된 것을 확인했다. 고정 작업 루트는 이전과 동일하게 `C:\Users`였다.
- 일반 텍스트 시험(runId `af5b0d68-8d65-4a2a-830b-952a2fcaa3cb`): 도구 0회, 정확히 `TEST5_TEXT_OK`를 반환하고 completed/succeeded. 서버 실행 0.428초, 클라이언트 왕복 5.656초.
- 파일을 읽고 답하는 시험(runId `12ba0064-4f0b-4f26-b89b-ff80598600ff`): 절대 경로 read_file 1회 성공 후 파일의 `answer=73`을 읽어 정확히 `TEST5_READ_OK:73`을 반환하고 completed/succeeded. 서버 실행 1.067초, 클라이언트 왕복 5.858초.
- 읽기→쓰기→재읽기 시험(runId `a2e34e64-6b31-4133-a8d3-377d412e39da`): 지정한 순서대로 read_file, write_file(createOnly), read_file 총 3회 성공 후 정확히 `TEST5_RW_OK`를 반환하고 completed/succeeded. 생성 파일은 원본과 27바이트 및 SHA-256 `F3E06EDF2282A25520990EF208678398B09AD9EA966C76D2C5099D9D3266F50B`가 일치했다. 서버 실행 1.632초, 클라이언트 왕복 6.885초.
- 이전 NVIDIA DiffusionGemma 구성에서 발생한 후속 요청 HTTP 400은 세 재시험 모두 재현되지 않았다. 모든 실행 종료와 queued/running 0건을 확인했고 합성 파일을 정리했다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 test1~test5 파일 입출력 처리량 시험

- 공통 70바이트 합성 입력을 사용해 각 호출이 절대 경로 `read_file → write_file(createOnly) → read_file`을 수행하고 고유 출력 파일을 만들도록 했다. 모델 전환 비용을 줄이기 위해 test1부터 test5까지 모델별로 묶었고, 출력은 SHA-256 `1171CE798B107167FD24FF96AD7448B415091128EC11B67A3D21A0032581D95A`와 바이트 길이를 원본과 비교했다.
- 적용 모델과 제한: test1=OpenRouter `nex-agi/nex-n2.5-pro:free`, test2=OpenRouter `cohere/north-mini-code:free`, test3=NVIDIA `meta/muse-glimmer-30b`, test4=NVIDIA `z-ai/glm-5.3-flash`, test5=로컬 `openai/gpt-oss-20b`. 실행 제한시간은 모두 120초였고 provider/resource-group 동시성은 OpenRouter 2/1, NVIDIA 2/2, 로컬 1/1이었다.
- 첫 시도에서 Codex 내부 도구 호출을 `Promise.all`로 구성했지만 MCP 호출 생성 시각이 순차적으로 벌어져 실제 병렬 제출이 아니었다. 이 예비 직렬 측정에서 test1은 4/4 성공·65.426초·3.67작업/분, test2는 4/4 성공·70.147초·3.42작업/분이었다. 각 호출은 정확히 도구 3회와 정확 응답을 기록했고 8개 출력 모두 원본과 완전히 일치했다.
- 같은 예비 측정의 test3은 Codex 클라이언트 대기 제한 때문에 네 호출 응답이 모두 timeout으로 보였으나 서버 기록상 뒤의 2건은 각각 105.043초와 90.066초에 completed/succeeded, 정확 응답과 도구 3회를 기록했다. 앞의 2건은 서버 120초 deadline, 도구 0회였다. 성공한 출력 2개는 원본과 완전히 일치했다. 이 단계의 4건은 순차 전달이므로 병렬 처리량으로 사용하지 않는다.
- 실제 처리량은 공식 MCP SDK의 단일 연결에서 모델별 4건을 동시에 `callTool`하여 다시 측정했다. 네 run 생성 시각과 종료 시각이 겹치는 것을 확인했고 클라이언트 제한은 180초로 설정해 MCPex의 120초 실행 결과를 기다렸다.
- test1 실제 동시 배치: 4/4가 6.307초 안에 OpenRouter HTTP 429 `free-models-per-day`로 실패, 도구 0회. test2도 4/4가 5.821초 안에 같은 일일 무료 호출 한도 429로 실패, 도구 0회. 현재 계정 할당량 소진이므로 두 모델의 병렬 파일 처리량은 측정 불가이며 0건/분을 모델 성능으로 해석하지 않는다.
- test3 실제 동시 배치: 4/4가 120초 deadline, 배치 125.630초, 전체 도구 호출 1회, 완료 처리량 0건/분. test4: 4/4가 120초 deadline, 배치 125.639초, 한 실행만 read/write/read 3회까지 성공해 원본과 동일한 출력 파일을 만들었으나 최종 답변 전에 종료, 완료 처리량 0건/분. NVIDIA 두 모델은 동시 4건 파일 작업을 현재 제한시간 안에 완료하지 못했다.
- test5 실제 동시 배치: 4/4 completed/succeeded 및 정확 응답, 배치 22.024초, 완료 처리량 10.90작업/분. 개별 왕복은 11.350~22.024초, 평균 16.819초였다. 출력 4개는 모두 원본 70바이트 및 SHA-256과 완전히 일치했다.
- test5는 요구한 호출당 3회보다 많은 총 17회 도구를 사용했다. 1건만 정확히 3회였고 나머지는 4·5·5회였다. 실패 후 복구한 write_file ENOENT 1회와 HASH_CONFLICT 2회, 중복 성공 write/read가 있었으므로 결과 정확성과 별개로 고부하 시 도구 호출 효율은 불안정했다.
- 종합 판정: 이번 조건에서 검증된 최고 완료 처리량은 test5의 10.90작업/분이다. test1·2는 저부하 파일 입출력은 4/4 성공했지만 실제 동시 시험은 외부 일일 할당량 때문에 비교할 수 없었다. test3·4는 동시 4건에서 완료 안정성이 부족했다. 존재한 출력 파일은 전부 원본과 바이트 단위로 일치했다. 모든 실행 종료와 queued/running 0건을 확인하고 합성 파일 및 임시 측정 스크립트를 정리했다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 test1~test5 단일 순차 파일 작업 속도 비교

- 사용자 의도에 맞춰 병렬 제출을 중단하고 test1→test5 순서로 한 번에 하나만 실행했다. 각 실행이 terminal 상태가 된 뒤 다음 에이전트를 시작했고, 동일한 70바이트 입력을 절대 경로로 `read_file → write_file(createOnly) → read_file`한 후 고유 정확 문자열을 답하도록 했다. MCP SDK 클라이언트 대기는 180초, MCPex 실행 제한은 120초였다.
- 네트워크 단절 전 첫 실행은 백그라운드에서 끝까지 완료됐다. test1 114.096초 성공(도구 3회), test2 121.414초 deadline(도구 2회), test3 74.961초 성공(도구 3회), test4 66.693초 `fetch failed`(도구 1회), test5 3.852초 성공(도구 3회)이었다. test4의 공급자 연결 오류 때문에 이 세트를 최종 속도 비교로 사용하지 않았다.
- 네트워크 복구 후 전체를 같은 순서로 재실행했다. test1은 121.420초 deadline 및 도구 0회, test2는 12.818초 completed/succeeded 및 정확 응답·도구 3회, test3은 121.363초 deadline 및 read_file 1회 성공, test4는 121.356초 deadline이지만 read_file→write_file→read_file 3회는 모두 성공, test5는 2.223초 completed/succeeded 및 정확 응답·도구 3회였다. 이번 재실행에서는 `fetch failed`가 재현되지 않았다.
- 재실행의 test2·test4·test5 출력은 모두 원본과 70바이트 및 SHA-256 `516CB20F05772A3FAEF5F22C89A42638675A105281C38B86BABCC1C4EF62A4CD`가 일치했다. test4는 파일 작업 자체는 완료했지만 최종 답변이 없어 실행 성공으로 판정하지 않았다. test1 출력은 없고 test3은 읽기만 수행했다.
- 완료 기준 속도 순위는 test5 2.223초, test2 12.818초이며 test5가 약 5.77배 빨랐다. test1·test3·test4는 재실행에서 120초 안에 최종 답변을 만들지 못해 비교 하한만 `120초 초과`로 기록한다.
- 두 순차 실행을 함께 보면 test5만 3.852초와 2.223초로 모두 빠르고 안정적으로 완료됐다. test1은 114.096초 성공 후 deadline, test2는 deadline 후 12.818초 성공, test3은 74.961초 성공 후 deadline으로 원격 모델의 실행 간 변동이 컸다. 모든 실행 종료와 queued/running 0건을 확인하고 합성 파일 및 임시 실행기를 정리했다. 사용자 설정과 프로젝트 구현 코드는 변경하지 않았다.

## 2026-09-23 code_light / code_middle / code_advance 코딩 에이전트 평가

- 실행 중 작업 0건과 47831 비수신 상태를 확인한 뒤 MCPex 서비스를 새 프로세스(PID 27068)로 시작하고 `/health`의 service=mcpex/status=ok를 확인했다. 세 에이전트는 적용 버전과 초안이 있으나 모두 비활성 상태여서 공개 MCP 도구를 활성화하지 않고 초안 시험 실행 API로 평가했다. 사용자 설정은 변경하지 않았다.
- 동일한 독립 JavaScript ESM 프로젝트를 세 개 제공했다. 과제는 README 명세를 조사해 `buildLeaderboard`와 `formatLeaderboard`를 구현하는 것으로, 입력 검증, 파싱, 잘못된 행 집계, 대소문자 무시 중복, 최고 점수·동점 규칙, 필터·정렬·limit 순서, 결정적 포맷과 비변경 조건을 포함했다. 수정 허용 범위는 두 src 파일뿐이었다. 기준선은 공개 테스트 0/2였다.
- 평가 항목은 작업 폴더 탐색, 파일 읽기·쓰기, 다중 파일 이해, 명세 준수, 기존 파일 수정 계약 처리, 오류 복구, 변경 범위 통제, 공개·별도 인수 테스트 정확도, 최종 보고의 사실성, 전체 작업시간으로 정했다. 세 runtime에는 명령 도구가 없으므로 에이전트 자체 테스트 실행 능력은 평가할 수 없었고, 테스트는 외부에서 수행했다.
- code_light / 로컬 `openai/gpt-oss-20b`: 자율 과제는 18.857초에 completed로 끝났지만 list_files 6회가 모두 PATH_FORBIDDEN 또는 ACCESS_DENIED였고 읽기·쓰기·변경은 0회였다. 파일을 보지 못한 상태에서 실제 API와 다른 이름을 추정해 구현 계획만 보고했다. 정확한 절대 파일 경로를 준 보조 시험은 19.320초, 도구 8회 중 성공 3회·실패 5회였다. README와 두 src 파일은 읽었지만 기존 파일에 write_file을 사용해 HASH_CONFLICT가 난 뒤 복구하지 못했고, 코드를 최종 답변에 붙였을 뿐 실제 파일은 수정하지 않았다.
- code_light의 제안 코드는 핵심 로직 대부분을 설명했지만 옵션 문자열을 숫자로 강제 변환해 타입 오류를 내지 않는 문제와 빈 score를 0으로 인정하는 문제가 남았다. 실제 작업 복사본은 공개 테스트 0/2, 별도 인수 테스트 1/8이며 변경 0건이었다. 금지 파일은 건드리지 않았고 테스트를 실행했다고 허위 보고하지 않은 점은 통과했다.
- code_middle / Groq `qwen/qwen3.8-27b`: 여러 실행에서 list_files와 read_file로 프로젝트·README·source·test를 실제로 읽었고, 가장 진행된 실행은 write_file까지 도달했다. 그러나 기존 파일 쓰기에서 EXPECTED_HASH_REQUIRED가 발생한 직후 또는 다음 모델 턴에서 모두 Groq ITPM 7,000 한도의 HTTP 429로 종료됐다. 공급자 안내에 따라 최대 70초 동안 요청을 비우고 프롬프트 중복을 줄여도 외부 계정 사용량과 실패 요청 누적으로 429가 지속됐다. 최종 답변과 변경 파일이 없어 정확성·완료 속도는 평가 불가이며 실제 복사본은 공개 0/2, 별도 1/8의 기준선 그대로였다.
- code_advance / llmgtw `deepseek-v4.1-flash`: 동일 과제를 두 번 시도했으나 각각 약 1.45초 안에 공급자 HTTP 400 `The request was rejected`로 끝났고 모델 응답·도구 호출·파일 변경이 모두 0회였다. 현재 provider/model 조합은 도구가 포함된 코딩 요청을 수락하지 않아 코딩 능력과 작업시간을 평가할 수 없다.
- 세 복사본 모두 README, package.json, 공개 테스트 파일 해시가 template과 같아 범위 밖 변경은 없었다. 허용된 두 src 파일도 최종적으로 모두 기준선과 같았다. 공개 테스트는 각 0/2, 별도 인수 테스트는 각 1/8이었다. 이 점수는 모델 구현 품질의 동점이 아니라 실행 또는 쓰기 완료 실패로 코드가 적용되지 않은 결과다.
- 현재 구성의 핵심 장애: (1) 세 userPromptTemplate이 inputSchema에 있는 `scope`를 렌더링하지 않아 범위 지시가 모델에 전달되지 않는다. (2) 고정 루트가 `C:\Users`라 프로젝트 경로에 비해 지나치게 넓고 code_light가 경로를 반복 오판했다. (3) 기존 파일 수정 시 expectedHash/replace_text 사용 지침이 없어 light와 middle이 쓰기 계약 오류에서 멈췄다. (4) code_middle의 Groq ITPM 7,000은 여러 도구 턴 코딩 작업에 부족하다. (5) code_advance의 모델/provider는 tool-call 요청 호환성을 먼저 해결해야 한다. (6) run_command가 없어 에이전트가 스스로 테스트를 실행할 수 없다.
- 종합 판정: 현재 상태에서 세 에이전트 중 실제 코딩 작업을 완료한 에이전트는 없다. code_light는 파일 경로와 수정 도구 계약이 보완되면 가장 먼저 재평가할 수 있고, code_middle은 탐색·읽기 능력은 관측됐지만 공급자 한도 상향 또는 컨텍스트 절감이 선행돼야 한다. code_advance는 provider/model tool-call 호환성 해결 전에는 코딩 에이전트로 사용할 수 없다. 모든 실행 종료와 queued/running 0건을 확인하고 평가용 파일을 정리했다.
