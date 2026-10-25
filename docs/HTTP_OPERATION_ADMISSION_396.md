# #396 HTTP 쓰기 진입과 DB 완료 관측

이 문서는 런타임 source 계약이다. migration 실행, 실제 DB/Auth/Drive 호출,
운영 활성화, 전체 drain, 초기화 또는 v1.0.0 운영 완료 증거가 아니다.
최종 사용자 선택/승인 기록은 인계 디렉터리의 `USER_DECISIONS.md` 하나로 유지한다.

## 기본 동작과 활성화 조건

- `DEVELOPER_OPERATION_ADMISSION_MODE` 미설정/`disabled`: 진입 제어용 DB 호출을 하지 않는다.
- `required`: 서버가 지정한 `DEVELOPER_OPERATION_TARGET`과 양의 정수
  `DEVELOPER_OPERATION_BUDGET_MS`가 모두 필요하다. 기본 budget/재인증 TTL을 만들지 않는다.
  target은 실제 서버의 `SUPABASE_URL`에 있는 20자리 프로젝트 ref와 같아야 한다.
  HTTPS 정본 host 외 사용자정보/경로/query/custom·local endpoint는 활성화하지 않는다.
- 130 `get_operation_admission_control`의 정확한 `INACTIVE`(control 없음)는 기존 업무를 허용한다.
  다른 target, 잘못된 DTO, 관측 실패/`UNKNOWN`, 유지보수 `REQUESTED`는 새 쓰기를 차단한다.
- `OPEN` 관측과 명령 사이에 유지보수가 요청되어도 acquire가 동일 control을 다시 검사하고
  DB lock으로 직렬화한다. 프런트의 헤더/boolean이 모드나 승인을 정하지 않는다.
- budget은 관측 기한이다. 기한 만료/abort/HTTP timeout은 원격 작업 취소, 성공 또는 lease 해제가 아니다.
  control·identity·acquire·업무 DB RPC·완료 관측이 같은 deadline을 공유한다. Auth identity 또는
  업무 응답이 멈춰도 관측은 503으로 종료하고 새 실행/완료를 만들지 않는다. 실제 SDK RPC에는
  기존 caller signal과 합성한 signal을 전달한다. 원래 업무 오류는 그대로 보존한다.
- 설정을 켜기 전에 130과 일치하는 source/DB, target, 명시 budget, 전체 경로 범위와
  이전 비활성 인스턴스/진행 중 요청의 종료 증거가 필요하다. 설치 사실만으로 coverage를 완성하지 않는다.

## 실제 연결

정본은 `src/modules/developer-reset/http-admission-routes.json`이다. SQL 130과
Node/Edge 생성 manifest가 같은 유한 route ID, RPC, command identity를 사용한다.
일반 응답 success나 임의 RPC 이름으로 완료 권한을 만들지 않는다.

- Fastify: 기존 route preHandler 후 handler를 감싼다. `AsyncLocalStorage`가 요청별 context를
  분리한다. 정상 앱의 공통 admin client는 그 context의 정확한 RPC만 감싼다.
- 감사 3개와 알림 읽음은 131의 고정 원자 RPC로 연결한다. Node는 공통 client 생성 시,
  Edge는 인증 전 client 생성 직후 전역 wrapper를 설치해 GET/인증 실패의 감사도 포함한다.
  실제 원래 RPC를 별도로 실행하지 않으며, 원자 RPC의 결과만 기존 형태로 돌려준다.
- Edge: 요청별 client 컨테이너를 복사한다. 기존 active/limited 인증 경로를 통과한 다음
  같은 controller를 호출한다. supplemental handler도 기존 인증을 유지한다.
- Supabase RPC builder는 `then()`에서 I/O를 시작한다. wrapper는 정확한 대상 builder의
  `abortSignal`/`single`/`maybeSingle` chaining을 보존하면서 실제 실행 직전에 acquire한다.
  같은 builder를 다시 await해도 별도 effect를 시작하지 않는다. 일반 read RPC는 그대로 동작한다.
- body 검증 중 종료되어 대상 RPC에 도달하지 않은 DB 명령에는 lease를 만들지 않는다.
- 실제 service가 계산한 actor/idempotency key/request hash를 사용한다. HTTP body hash로
  대체하지 않는다. 고정 `p_action`을 사용하는 객실 명령은 route와 action도 일치해야 한다.
- availability 세 명령만 기존 SQL의 `private.availability_request_hash`와 날짜 정규화를
  사용하는 130 전용 경로에 유한 인수 subset을 전달한다. raw args를 원장/로그에 저장하지 않는다.
- postapproval 세 명령은 기존 `p_idempotency_key_digest`를 그대로 원장 키로 사용한다.

현재 source 분류는 99개 HTTP 경로 중 65개 DB command receipt 후보, 6개 무효과 본체,
1개 알림 읽음 원자 처리, 27개 효과별 reconciliation 필요 경로다. 65개는 예약·객실·배정·가용일·제출/검수·주급·민원·
템플릿·후속 객실 신고·Web Push 구독 DB 등록/회수 등을 포함한다. 사용자 송금이나 push 전달을
수행/완료했다는 뜻이 아니다. 신규 후속 원장 adapter가 추가되면 이 수치와 manifest를 함께 갱신한다.
계정 잠금 해제는 `unlock_account/account.unlock`의 DB 원장으로 확인한다. 역할·상태 변경은
실제 Auth provider 변경이 앞뒤로 존재하므로 이 DB-only 계약으로 완료하지 않는다.

예약 전환은 내부 receipt가 아닌 `reservation.process_due_transitions.v66`을 사용한다.
검수는 `inspection.approved`/`inspection.rejected`이다. no-op 지급 메모의 `entity_id=NULL`도
정상 terminal receipt일 수 있으므로 entity 존재만으로 판정하지 않는다.
다음 read 조회가 실패해도 이미 commit된 업무 명령을 되돌렸다고 판단하지 않는다.

`complete_operation_http_admission`만 exact actor/key/hash terminal 원장을 확인해 완료할 수 있다.
RPC 응답이 유실된 경우에도 이 DB 관측을 시도한다. receipt 부재, 권한/세션 변경, 관측 실패,
만료, 비정상 proof는 미완료를 유지하며 원래 API 결과를 성공/실패로 바꾸지 않는다.
실패 뒤 재실행을 승인하거나 DB/외부 작업을 자동 재실행하지 않는다.

## 별도 완료 증거가 필요한 경계

- 로그인, 비밀번호, 계정, 사진/증빙, PIN/Sheets 등 OPAQUE 경로는 시작을 추적하되
  HTTP 200/오류/Promise 종료로 lease를 완료하지 않는다. 특히 sign-in 응답 유실로
  session ID를 받지 못한 상태, cleanup 실패, provider 응답 유실은 UNKNOWN이다.
- 기존 limited-session 경로의 최신 session/attempt/capability 권한은 130의 해당 route
  authority와 함께 검증해야 한다. active-only 인증으로 대체하지 않는다.
- POST preview 다섯 개는 DB read-only snapshot/앱 계산이다. 폐기된 기간 정책 POST는
  기존 410을 유지한다. 이 본체의 무효과와 별도 실패 감사의 완료는 다른 근거다.
- `record_actor_activity_event`, `record_unknown_login_failure`,
  `record_authorization_denial`은 GET/인증 실패에서도 DB에 기록한다. Fastify preHandler나
  Edge catch에서 수행되는 감사는 HTTP handler 완료 원장만으로 보호됐다고 볼 수 없다.
  연결된 131의 유한 transaction이 동일 DB lock 아래 감사와 admission을 함께 완료한다.
  INACTIVE도 원자 RPC 안에서 재확인하며, 설정이 바뀌면 503으로 거절한다. 기존 감사를 생략하지 않는다.
- offline 원장, lifecycle 및 domain별 완료 증거는 일반 command receipt와
  같다고 추정하지 않는다. SQL 내 하위 receipt와 전체 명령의 terminal도 구분한다.
  diagnostics는 rate-limit 쓰기가 있으므로 read-only로 분류하지 않는다. OPAQUE handler 전체의
  외부 provider 종료·상쇄 성공을 이 DB 명령 관측 기한으로 보장하지 않는다.
- worker/outbox, 기존 진행 중 프로세스, 직접 DB/Auth 접근, 다른 배포 인스턴스의 coverage와
  실제 운영 감시는 별도로 증명해야 한다. 현재 HTTP source는 전체 drain/초기화를 허용하지 않는다.

## 검증 기록

- Node HTTP admission 합성 49 tests 및 원자 helper/source 29 tests, typecheck: PASS.
- 실제 Edge HTTP handler 합성 9 tests: PASS. DB/Auth/provider는 모두 합성 대역.
- 실제 Supabase SDK builder를 가짜 fetch로 실행하여 lazy I/O, fluent chaining, 반복 await,
  유한 RPC 선택과 동시 요청 context 분리를 검증했다. 실제 네트워크 요청 0.
- 첫 Edge 준비 과정의 ignored report/photo asset 부재 및 잘못 선택한 기본 lock의 FAIL은
  기존 생성기로 준비하고 정본 `post-approval-report.deno.lock`을 사용해 해결했다.
  의존성/검증 기준을 낮추거나 lock을 임의 변경하지 않았다.
- 최신 dev 첫 전체 application 실행은 4,422 PASS / 1 FAIL이었다. 기존 source-order 검사가
  요청별 client 복사 이전의 문자열을 찾던 부분을 실제 새 구문으로 갱신했다.
  public `/docs` 뒤에서 client를 생성한다는 기존 순서 조건은 유지한다.
- 첫 source-order 수정 뒤 전체 application 160파일/4,432 tests + lint/typecheck/build: PASS.
  이후 unlock receipt/공통 기한 보완은 focused 검사 PASS이며 통합 후 전체 재검사한다.
- 131 연결 이전 전체 Edge 65/548/68 tests PASS; main 19,111,368 B,
  report 19,777,069 B, backup 99,006 B. 20,000,000 B 상한을 그대로 사용했다.
- 130/131 통합 전체 Edge 65/552/68 tests PASS; main 19,194,069 B,
  report candidate 19,859,770 B, backup 99,006 B. 상한 변경 없음.
- dev577의 순수 Node snapshot 6파일 정상 통합 후 전체 application 168파일/4,680 tests와
  lint/typecheck/build PASS. Edge 입력은 직전 성공과 같아 결과를 재사용했다.
- Python ephemeral API 생성 및 실제 gate/template projection 8개 roundtrip PASS.
  기존 lifecycle 중복 모델 경고는 유지하며 최종 계약 검사는 성공했다.
- 독립 QA: HTTP/SQL130/atomic131/Node·Edge 연결과 기존 제한 세션을 검토하고 161 tests PASS,
  차단사항 없음. 실제 SQL 실행을 요구하지 않는 source 검토 결과다.
- 기존 별도 Node 제한 세션 client를 공통 보호 client로 연결했고, 사진 전용 오류 handler가
  고정 admission 503을 보존하는 실제 Fastify 요청 회귀를 추가했다. 첫 profile abortSignal
  위치의 타입 오류는 single 변환 이전에 signal을 적용해 해결하고 전체 검사를 통과했다.
- 실제 SQL, pgTAP, DB, Auth, provider, 운영 활성화/배포/초기화: NOT RUN.
