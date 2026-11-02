# 초기화 운영 안전 장치 (#396, source 128)

2026-10-25 최신 정책: R1 재인증 유효기간5분을 선택했다. 아래 source128 당시의 TTL 미정
설명은 이력이며, [승인 정책 연결](RESET_APPROVED_HANDOVER_POLICY.md)은 실제 control 값을
300초와 대조한다. 선택만으로 DB 설정·재인증·유지보수·운영 시작을 실행하지 않는다.

이 문서는 실행 승인이 아니다. 128은 운영 시작 잠금, 최근 재인증, 유지보수 admission의 공통 소스와 합성 검증을 제공한다. 실제 DB/SQL 적용, 비밀번호 로그인, 실제 계정 입력, 유지보수 활성화, 운영 시작 기록, 초기화와 사진 삭제는 실행하지 않았다. D01 복구 보호 범위와 D02 실제 삭제는 미승인이다. 예약 전용 백업은 Auth/PIN/청소/주급/사진의 복구 증거가 아니다.

## 설정과 운영 시작

`private.developer_operation_control`은 seed가 없다. 행이 없으면 `UNKNOWN`이며 초기화와 새 admission을 거절한다. 신규 코드가 기존 요청 경로에 자동 적용되지는 않는다. target, 정책 문서 해시, 재인증 TTL, 실제 운영 전 상태는 정확한 사용자 결정과 현황 확인 후 별도 승인된 owner 실행으로 설정해야 한다. 해시는 검토 문서를 결합하는 값이며 사람의 승인을 암호학적으로 인증하지 않는다. TTL 기본값을 정하지 않았다.

control은 target 불변, 매 전환 version +1, `STARTED` 이후 `PROVISIONING` 복귀 및 marker 삭제 금지다. 운영 시작 전환은 되돌릴 수 없는 잠금이므로 실제 실행 승인은 별도다. `private.transition_developer_operation`은 현재 developer/활성 세션/비밀번호 버전/target/policy/version/action/nonce/만료를 모두 확인하고 READY receipt를 1회 소비한 뒤 append-only event를 같은 transaction에 기록한다. service role에는 이 전환 권한을 주지 않는다. owner 권한의 trigger 해제·직접 시스템 변경까지 방어한다는 주장은 하지 않는다.

## 최근 재인증

`operation-reauth.ts`는 아직 HTTP route에 연결하지 않은 실제 Supabase adapter다. 기존 비밀번호 확인 rate limit(10회/60초)을 재사용하고, 서버에서 얻은 target/version과 actor를 challenge에 결합한다. 새 TTL 정책을 고정하지 않는다.

1. `begin_developer_operation_reauth`: DB의 최신 developer singleton과 원래 활성 세션을 전후 확인하고, control row를 잠근 뒤 nonce digest/비밀번호 버전/목적/대상/정책/version/절대 만료시각을 기록한다.
2. 별도 비영속 Auth client로 비밀번호 로그인한다. 실제 사용자 비밀번호와 token은 메모리에서만 사용한다. token의 session_id를 디코딩한 값은 조회 힌트일 뿐이다.
3. `verify_developer_operation_probe`: DB가 Auth 소유 `auth.sessions`와 `auth.mfa_amr_claims`를 직접 확인한다. 같은 사용자에게 challenge 이후 생성된 새 session과 `password` AMR만 허용한다. 원래 세션·과거 로그인·다른 사용자·재사용한 probe는 거부한다. Auth credential/AMR 원문을 응답하거나 저장하지 않고 session digest만 보존한다.
4. Auth `signOut(..., 'local')`로 임시 session을 폐기한다. 실패/timeout이면 READY가 되지 않는다. 확인 실패한 probe도 폐기를 시도하되 원래 session은 폐기하지 않는다.
5. `finish_developer_operation_reauth`: DB가 probe session 부재를 확인하고 actor/원래 session/비밀번호 버전/target/policy/version/기한을 다시 확인한 뒤 READY로 바꾼다. 후속 전환 시에도 다시 검사한다.

RPC는 `get_active_auth_context`의 READ COMMITTED 순차 최신 조회를 사용한다. 별도 세션을 만들면 원 세션이 끊기는 Auth 설정에서도 실패를 허용하며 인증을 우회하지 않는다. 외부 요청에는 호출자가 유한 abort budget을 주어야 한다. Auth 응답을 잃어 probe token 자체를 받지 못한 경우나 signOut 실패는 완료가 아니고 별도 재조정 대상이다. 현재 합성 테스트는 adapter 순서/실패를 검증하며 실제 Auth schema/동시성 결과를 증명하지 않는다.

Auth 구조 근거: [Supabase Auth MFA schema migration](https://github.com/supabase/auth/blob/master/migrations/20221003041349_add_mfa_schema.up.sql), [세션과 폐기 확인](https://supabase.com/docs/guides/auth/sessions). 운영 Auth 행/AMR/token/password 원문은 이번 개발에서 읽지 않았다. 해당 내부 Auth schema의 호환성 검사는 승인된 DB 검증 단계에 남는다.

## 유지보수와 drain 경계

`REQUEST_MAINTENANCE`는 control row lock으로 새 공통 admission과 직렬화된다. `acquire_developer_operation_admission`은 target/version/상태/owner digest/nonce/유한 deadline을 결합한다. 기존 effect는 요청 전 얻은 admission으로 종료할 수 있다. `complete_developer_operation_admission`은 owner와 nonce를 확인해 1회 완료한다. TTL이 지났다는 이유로 지우거나 완료로 바꾸지 않는다. deadline 이후 미종료 effect는 `UNKNOWN`으로 남고 재조정이 필요하다.

이 함수는 owner-only 내부 capability이며 호출자의 `true`를 proof로 받지 않는다. 하지만 실제 effect의 terminal 결과는 향후 신뢰하는 adapter가 관측해야 한다. 현재 모든 경로에 admission을 설치하지 않았으므로 128 collector의 `coverage=NOT_INTEGRATED`를 설정값으로 바꿀 수 없고 전체 drain을 주장하지 않는다. signed worker mode도 admission 설치 증거가 아니다. 미종료 admission, 만료된 미종료 admission, 미완료 password change/reset receipt의 실제 count를 따로 반환한다.

후속 독립 개발은 다음과 같다.

- Fastify·Edge의 모든 업무 write 진입 경로를 정본 목록으로 고정하고 opt-in 공통 wrapper를 연결한다. 목록과 실제 설치 coverage 검사를 추가한다.
- 로그인/계정/비밀번호 변경의 Auth 외부 호출과 DB receipt 전 구간에 admission을 유지한다. 계정 생성·재설정의 기존 미완료 receipt도 재조정해야 한다.
- 각 scheduler/notification/PIN/photo worker의 claim→외부 provider→finalize 전체 효과에 admission을 유지하고, 실제 terminal readback 후에만 release한다. 단순 Promise resolve나 lease 만료를 완료로 보지 않는다.
- DB 직접 DML, owner SQL, Supabase Auth 관리 API, 외부 Drive 직접 호출은 앱 wrapper만으로 봉쇄되지 않는다. 실제 reset 실행 전에는 별도 접근 중지/현재 작업 재조정 증거가 필요하다. coverage manifest를 설치해도 이 외부 범위를 자동 충족시키지 않는다.

설치되지 않은 경로나 알 수 없는 effect가 있으면 fail closed다. 기본 운영 동작을 변경하거나 사용자를 임의 차단하는 활성화는 하지 않는다. 위 후속 개발은 보존 범위/삭제 승인과 독립적으로 진행할 수 있으며 128 완료를 전체 초기화 기능 완료로 보고하지 않는다.

## 진단과 migration 경계

128은 127의 STABLE combined collector에 `gateEvidence`를 추가한다. inventory, row impact, gate count가 같은 SQL statement snapshot을 공유하고 public wrapper의 전후 live Auth 검사는 그대로 유지된다. 과거 DTO에서 gateEvidence가 없으면 `OPERATION_GATES_NOT_COLLECTED`, 새로운 형식이 손상되면 503이다. 집계와 상태만 반환하며 session/actor/nonce/target 원문은 반환하지 않는다. snapshotId와 count는 승인 token이나 row content CAS가 아니다. `executionEnabled=false`는 유지된다.

4개 신규 private table은 명시적 보존 **후보**다: control, reauth, admissions, events. 계정 FK를 두지 않아 account cascade로 안전장치가 소실되지 않는다. event→reauth FK는 RESTRICT다. 실제 삭제 허용 목록은 아니다.

2026-10-25 확인 시 운영 head는 122이고 127/128은 어디에도 적용하지 않은 source 후보다. 이에 따라 기존 generator로 127의 후보 목록과 fingerprint만 185→189, preserve 3→7로 재생성한다. 업무 데이터와 적용 migration history는 불변이다. **v1 source 동결 또는 어떤 환경의 실제 적용 이후에는 127을 재생성하지 않는다. 후속 분류 변경은 append migration과 고정된 baseline generator로 전환한다.**

`supabase/tests/developer_operational_safety_gates.sql`은 준비된 SQL 회귀이며 이번 작업에서 NOT RUN이다. 실제 DB 적용/재적용/RLS/AMR/경쟁 검증은 `FINAL_DB_VALIDATION.md`의 실행별 승인 뒤에만 진행한다.

## 공개 계약 재검토

최초 source 128의 단위/전체/Edge 검사와 독립 source QA가 통과한 뒤, 후속 검토에서
`operationGates`가 strict OpenAPI 응답에 누락된 P2 결함을 발견했다. 배포하지 않은 상태에서
nullable 필수 필드와 전용 schema를 보완했다. 실제 Node/Edge projection 5종과 Fastify 응답
전체를 AJV로 검증하고 같은 실제 응답의 Python 생성 모델 roundtrip을 추가했다.
기존 PASS가 공개 계약 완전성을 증명하지 못했던 검사 공백을 이 회귀로 보완한다.
