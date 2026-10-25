# HTTP 작업 진입과 완료 관측 (#396, source 130)

이 문서는 소스 계약이며 실제 활성화·DB 적용·삭제 승인이 아니다. 128의 private admission을
HTTP 업무 경로에 연결할 수 있도록 service 전용 RPC를 제공한다. 요청이 성공했다는 이유로
미완료 작업을 지우지 않는다. 실제 DB·Auth·provider 호출과 SQL 회귀는 이번 개발에서 NOT RUN이다.

## 유한 경로와 원장

정본은 `src/modules/developer-reset/http-admission-routes.json`이다. 99개 경로 중 65개는
기존 `private.command_executions` 완료 원장을 확인할 수 있다. 이 중 62개는 실제 업무 RPC의
`p_request_hash`를 받고, 가능일 명령 3개는 원래 SQL의 UUID/날짜/enum/정규 날짜 배열로 해시를
다시 계산한다. 암호화 전 HTTP body digest를 원장 hash로 대신하지 않는다.

6개 읽기/고정 거절 경로와 `markNotificationRead`의 별도 원자 dispatch 1개에는 일반 admission을
발급하지 않는다. 나머지 27개 Auth/PIN/사진 등 외부 효과 경로는 OPAQUE이며 이 RPC로 완료할 수 없다.
읽기 요청과 인증 오류의 감사 쓰기도 별도 고정 dispatch 범위에 포함해야 한다. 감사 기록을 생략해
유지보수 장벽을 우회하지 않는다. 경로 개수만으로 실제 배포와 전체 쓰기 차단을 증명하지 않는다.

`generate-operation-admission-sql.mjs`는 이 정본의 검증된 유한 행만 SQL에 고정한다. 임의 RPC 실행,
동적 SQL, 사용자 지정 command 승격은 없다. `operation-admission.sql.in`이 생성 원본이다.

## 호출과 전환

- `get_operation_admission_control(p_target)`은 설정 행 부재에서만 `INACTIVE`를 반환한다.
  이는 기존 업무를 보존하는 관측이며 운영 시작 전 상태나 초기화 허가가 아니다. 대상 불일치와
  설정된 UNKNOWN은 거절한다. OPEN 관측 뒤 실제 acquire가 control row를 잠가 version/상태를 다시 확인한다.
- `acquire_operation_http_admission`은 target/version, 유한 route, actor/Auth user/session,
  password version, nonce와 유한 deadline을 결합한다. 명령별 key/hash를 private 열에 결합하고
  원래 key/session/nonce 원문과 가능일 인수는 저장하지 않는다. actor와 password version을 전후 재검사한다.
- `complete_operation_http_admission`은 같은 actor/Auth user/session/password version/nonce와
  정확한 완료 원장의 actor/command/key digest/hash를 확인한 뒤 1회 완료한다. entity_id가 없는 정상 no-op,
  이 admission보다 먼저 완료된 멱등 replay도 허용한다. 과거 다른 hash의 원장은 허용하지 않는다.
  이 조회에는 같은 네 필드의 명시적 digest index를 추가해 actor의 전체 과거 원장을 순회하지 않도록 한다.
- REQUESTED 이후 새 acquire는 거절하지만 이미 시작한 효과의 정확한 완료 확인은 가능하다.
  deadline은 관측 한계이며 권한 TTL이나 자동 release가 아니다. 만료 뒤에도 미확인 효과는 UNKNOWN이다.

새 임시 비밀번호를 바꾸는 `changePassword`만 기존 must-change 상태를 허용한다. 7개 제한 세션 경로는
`assert_attempt_actor_session_fresh`의 기존 제한 세션 계보를 재사용한다. 일반 active guard로 늦은 기록을
차단하지 않는다. Admission은 업무 capability를 발급하지 않으며 원래 RPC가 attempt/소유권/action/revision을
다시 검증한다. 완료 확인 때 이미 종료된 업무 capability를 다시 발급받도록 요구하지 않는다.
현재 세션/비밀번호를 확인할 수 없게 된 경우 자동 완료하지 않고 별도 재조정 대상으로 남긴다.

## 활성화와 coverage 경계

기본 앱 설정은 비활성이다. server opt-in과 정확한 project/control이 함께 있어야 경로를 설치한다.
control이 없는 동안 진행한 기존 요청은 나중에 control을 만든다고 소급 등록되지 않는다.
따라서 최초 control 설치/활성화는 새 요청 중단·기존 작업 종료 확인을 포함하는 별도 전환 절차가 필요하다.
이 초기 전환을 일반 OPEN 관측이나 설정 Boolean으로 증명하지 않는다.

source 130은 보존 후보 admissions에 nullable 열만 추가하므로 127의 관계 목록/지문을 재생성하지 않는다.
combined preview collector를 덮어쓰지 않아 129의 templateEvidence와 기존 inventory/rowImpact/gateEvidence를 유지한다.
HTTP hook, worker의 claim→provider→finalize, Auth 응답 유실 재조정, owner DB/Auth 관리/외부 Drive 접근은
각각 완료 증거가 필요하다. 전체 설치가 확인되기 전 `coverage=NOT_INTEGRATED`와 초기화 실행 차단을 유지한다.

Supabase service role과 배포된 서버 코드는 신뢰 경계에 포함된다. 현재 command 원장의 service insert 권한을
이 기능이 제거하거나 악성 owner/service를 암호학적으로 방어한다는 주장은 하지 않는다. 외부 입력은 원래
API 권한/검증을 통과해야 하며 새 RPC는 anon/authenticated에 공개하지 않는다.

## 검증

합성 source 검사는 유한 경로의 command/key 결합, read/atomic 제외, 알려지지 않은 manifest 값 거절,
정본 생성 일치, PG15/17 AST parse를 실행한다. HTTP adapter의 별도 Node/Edge 합성 검사는 실제 RPC 인수를
전달하고 응답 성공·timeout·원장 부재를 완료로 바꾸지 않는 경계를 검증한다.
`supabase/tests/operation_http_admission.sql`은 exact receipt, nonce, 재사용, maintenance, 날짜 정규화,
다른 actor/임의 필드 거절의 준비된 회귀다. 실제 SQL·RLS·경합 검증은 실행별 승인 뒤 최종 입력에서만 수행한다.
