# #535 최초 비밀번호 변경 실패와 재시도 복구

## 현재 상태

2026-10-30 KST: 수정 후보 작성. 운영 적용·장애 계정 복구·전체 DB 검증은 **NOT RUN**.
로컬/CI/운영 migration 실행은 매번 사전 승인 대상이다.

## 원인과 수정

운영 read-only 기록에서 최초 POST 500 후 후속 POST 409를 확인했다. OPTIONS 204는
비밀번호 변경 성공이 아니다. 해당 초기 메이드의 receipt는 auth_pending/attempt1,
Auth shadow version 회전 시각은 계정 생성 시각이며 변경 준비보다 이전이었다.
실제 비밀번호·Auth hash·토큰·로그인 ID는 조회하거나 문서에 저장하지 않았다.

prepare_password_change의 execute/recover 응답에서 effectMarker가 누락됐다.
API가 필수 확인값을 검사하는 단계에서 중단됐고 미완료 receipt가 새 요청을 막았다.
139번 후보는 기존 SQL을 수정하지 않고 위 두 응답에 저장된 marker를 반환한다.
recover는 재시도에서 새로 제안한 marker가 아니라 원 receipt marker를 반환한다.
API/Swagger의 공개 요청·응답, 권한, 세션, 비밀번호 정책은 그대로다.

Node mock의 자동 marker 채움을 제거하고 실제 응답 그대로 검증한다.
누락/null/잘못된 marker에서 Auth 호출·완료 처리가 없는 Node/Edge 회귀를 추가한다.
SQL prepare 최초/복구의 전체 JSON과 저장 marker를 확인하도록 보강했다.

## 기존 장애 계정 복구 — 승인 후 제한 실행

반환 수정만으로 기존 auth_pending 요청이 사라지지는 않는다. 일반적인 응답 유실이나
crash-before-Auth를 임의로 재실행하지 않는다. 다음 절차는 **확인값 누락 장애로
Auth가 호출되지 않은 것이 운영 증거로 확인된 초기 계정 요청 한 건**에 한정한다.

1. 수정 릴리스와 승인된 DB 검증을 완료한다. 운영 적용 직전에 별도 승인받는다.
2. 대상의 비밀번호 변경·관리자 초기화 요청을 중지하고, 모든 이전 API 실행이 종료된
   시각을 기록한다. 최소 15분 drain을 확보한다. 단순 사용자 대기만으로 drain을
   증명하지 않는다. 강제 종료를 보장할 수 없으면 복구를 실행하지 않는다.
3. 읽기 전용으로 exact receipt ID/created_at/updated_at과 private nonsecret password
   version을 다시 확인한다. 원문 비밀번호/Auth hash/토큰은 조회하지 않는다.
4. 승인된 DB owner 세션의 짧은 transaction에서
   `supabase/tests/password_change_incident_repair_helper.psql`을 로드한다.
   이 파일은 세션 한정 pg_temp 함수 정의만 하며 자동 호출하지 않는다.
   검토한 다섯 인자(receipt ID, created_at, updated_at, password version, drain 시각)로
   `pg_temp.repair_unstarted_password_change`를 정확히 한 번 호출한다.
5. helper는 actor advisory/profile/receipt/Auth/version 잠금을 NOWAIT로 획득한다.
   초기 active admin/maid, exact snapshot, attempt1, auth_pending, 만료 lease,
   Auth 미회전, reset 없음만 허용한다. 변경/경합/증거 누락이면 전부 중단한다.
6. 실패 receipt는 삭제하지 않고 failed/AUTH_PASSWORD_CHANGE_FAILED로 보존한다.
   claim/lease만 종료한다. 비밀번호, must_change_password, session, 감사 이력은 보존한다.
   실제 결과를 확인 후 commit한다. 불일치·오류는 rollback하고 재평가한다.
7. 사용자는 기존 임시 비밀번호로 로그인해 **새 요청 키**로 본인 비밀번호를 다시
   입력한다. 정상 API의 현재 비밀번호 확인·횟수 제한·세션 검증을 모두 거친다.
   이전 실패 키는 재사용하지 않는다. 204 성공과 /auth/me 갱신은 사용자 UAT로 확인한다.

운영 실행에서 실제 비밀번호를 대신 설정하거나 must_change_password를 임의로 내리지 않는다.
helper는 public RPC/서비스 계정에 권한을 주지 않고 세션 종료 시 제거된다.
test fixture와 helper를 같은 Supabase tests mount에 두어 승인된 SQL 회귀에서 동일 코드를 읽는다.

## 프런트 인계

- 기존 POST /v1/auth/password와 currentPassword/newPassword, Idempotency-Key 계약 유지.
- 결과 불명확/네트워크 유실은 같은 로그인 세션·같은 키·같은 입력으로 재시도한다.
  복구 완료가 통보된 이번 failed 요청만 새 키로 다시 시작한다. 409마다 키를 바꾸지 않는다.
- PASSWORD_CHANGE_IN_PROGRESS: 이전 요청 확인 중. 중복 클릭·자동 반복 금지.
- PASSWORD_CHANGE_RECEIPT_FAILED/PASSWORD_STATE_UPDATE_FAILED: 서버 상태 확인 실패.
  성공 화면으로 넘어가거나 최초 비밀번호 변경 gate를 클라이언트에서 해제하지 않는다.
- PASSWORD_STATE_INCONSISTENT/PASSWORD_CHANGE_SESSION_MISMATCH/IDEMPOTENCY_KEY_REUSED는 자동 재시도를
  반복하지 않고 운영 확인 안내와 문의 번호를 제공한다. 비밀번호·토큰은 로그/분석/저장소 금지.
- 이번 수정은 백엔드 원인이다. 프런트 오류 안내·키 수명과 사용자 UAT는 별도 확인한다.

## 검증

- Node 인증/소스 27 PASS; Edge 인증 32 PASS; typecheck/build/manifest PASS.
- ci:quality PASS: Node 전체 5,488건, 타입/빌드/비밀정보/공개 계약/lint 검사 완료.
- 독립 QA: 인증/계약/소스246건 PASS, PostgreSQL17 최상위 parser PASS, P0/P1/P2 없음.
- Edge 전체 PASS: 후보 bundle 19,986,598 bytes. 원격 CI는 PR 생성 후 확인.
- pgTAP 신규 복구 fixture/기존 비밀번호 fixture: 작성, **NOT RUN**.
- 실제 DB/운영 migration·복구·UAT: **NOT RUN**, 승인 전 실행하지 않음.

Refs: #535, #46. 원 권한·일반 response-loss 정책은 ARCHITECTURE의 #46을 유지한다.

프런트 인계: https://github.com/makee-ham/room-management-system/issues/271
