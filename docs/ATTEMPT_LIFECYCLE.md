# #7B — 인계·비활성화 제한 권한

개발 시작 기준: `dev@bcc74c0515624ce8c9f3dfd8e167cd8b1030454c`.
현재 통합 source: `dev@5882509afed6faf31f5e9d7775a163e19954c4c2` (PR #77 squash 병합).
이 문서는 #7B source/dev 완료 계약이며 production 배포 선언이 아니다. 실제 gate는
`API_STATUS_MATRIX.md`와 해당 exact-head PR evidence를 따른다.

## 승인 범위

- 진행 중 한 건 마무리: 현재 회차에만 2시간 execution capability.
- 즉시 인계: old attempt interrupted, 새 담당의 새 assignment/attempt, old evidence upload-only.
- 물리 완료 후 증빙 유예: 최대 24시간 upload/validate/submit capability.
- 미착수 만료 scheduled: superseded 보존 후 다음날 재배정·재통보를 거쳐 새 회차.
- 만료 in_progress의 명시적 새 접근/마감 일정: 현재 예약·점유·source 재검증.

#7C offline lease/replay/quarantine, PIN 공개, 실제 Drive 업로드, submission/inspection/earning은
이번 구현 범위가 아니다. capability의 미래 allowed action이 실제 HTTP endpoint 존재를 뜻하지 않는다.

## 일반 인계와 계정 비활성화 구분

일반 인계만으로 이전 메이드의 전체 계정을 암묵적으로 비활성화하지 않는다. 명령이
비활성화를 명시한 경우에만 해당 profile 상태를 제한 상태로 옮긴다. 이전 회차의 증빙 권한은
회차 단위이며 다른 업무에 대한 일반 권한을 만들거나 회수한 것으로 오해하지 않는다.

| 상황 | 수행 결과 | 제한 권한 |
|---|---|---|
| 현재 한 건 마무리 | 같은 in_progress 유지, deactivation_pending | 같은 회차 완료만 2시간 |
| 제한 상태에서 물리 완료 | 같은 회차 field_completed, execution 종료 | upload_only, 필요한 증빙/제출 최대24시간 |
| 즉시 인계 | old interrupted / new scheduled | old는 증빙 upload만, current submission/earning 금지 |
| 미착수 만료 해소 | old scheduled → superseded | 이전 회차 실행 권한 없음, 새 통보 전 새 attempt 없음 |

재청소는 원 maid 불변·다른 maid 이관 금지를 우선한다. 원 maid가 수행할 수 없는 예외를
일반 인계로 우회하지 않는다. 승인된 별도 예외 정책 없이는 관리자 확인 상태로 남긴다.

## 인증과 capability

일반 `authenticate()`와 Data API RLS는 active-only를 유지한다. 제한 경로는 별도로
`Auth.getUser → 최신 DB profile → 유효 auth.sessions → 허용 action/capability`를 확인한다.
JWT metadata의 role, 클라이언트가 보낸 actor/session/시각은 권한 근거가 아니다.

capability는 profile/attempt/assignment revision/kind/actions/issuedAt/expiresAt에 묶인 DB
기록이다. 별도 bearer token, opaque 로그인 secret, 복구 credential을 발급하지 않는다.
capability ID만 알아서는 사용할 수 없으며 폐기된 Auth session을 우회할 수 없다.

- 발급 시각/만료/소유자/action은 불변, 회수는 별도 불변 이력이다.
- 동일 key 재시도뿐 아니라 다른 key를 사용해도 같은 회차의 TTL을 연장하지 않는다.
- execution은 최대2시간이고 물리 완료/인계 시 즉시 끝난다.
- 정상 완료의 upload/submit은 발급 후 최대24시간, interrupted의 evidence upload는
  current submission/earning에 연결하지 않는다.
- 서버가 lock을 획득한 뒤의 시각으로 검사하며 `now >= expiresAt`에서 새 행위를 차단한다.
- 이미 성공한 명령의 안전한 receipt 조회와 새 실행 권한은 구분한다. 성공 재조회가 TTL,
  종료 capability, old attempt를 되살리면 안 된다. revoked session은 재조회도 차단한다.
- 일반 계정 변경·재활성화가 회수된 capability를 부활시키면 안 된다.

기존 일반 계정 status command는 세션을 폐기하고 Auth ban을 수행한다. 이를 먼저 호출한 뒤
capability를 붙이지 않는다. 전용 lifecycle transaction이 제한 상태와 capability를 함께 만들며
필요한 기존 세션은 유지한다. 만료 차단은 worker나 Auth ban 성공을 기다리지 않는다.

## 관리자 command와 시간창

관리자는 좁은 impact 조회에서 현재 attempt/profile/assignment version을 확인한 후
명시적인 lifecycle action과 CAS를 보낸다. 정확한 route/body/response는 같은 source의
OpenAPI가 정본이다. 자유문 사유·snapshot·actor·시각을 입력받지 않고 reason code를 사용한다.

즉시 인계의 새 scheduled는 오늘의 현재 열린 실행창을 대상으로 한다. 미래 날짜나 아직
닫힌 접근창의 통보만 저장하는 작업은 즉시 인계와 같지 않으며 여기서 자동 활성화하지 않는다.
새 일정을 제출해도 실제 checkout/materialization, 현재 점유, 예약 충돌, 다음 입실 준비 마감,
active 새 담당·가능일·순서·source 검증을 우회할 수 없다. 후속 start에서도 다시 검증한다.

미착수 해소는 관리자 전용이다. 기존 scheduled를 superseded로 보존하고 같은 target·최초
계획일을 유지해 다음날 재배정 가능 상태로 옮긴다. 다음 source 창이 유효하지 않으면 회차,
담당, schedule, 알림, outbox, audit 모두 변경 없이 실패한다. scheduler가 자동으로 새 담당을
선택하지 않으며 새 통보 후 기존 #28 조건에서 새 회차를 정확히 한 번 활성화한다.
미착수 후 기존 담당이 비활성·퇴사·역할 변경된 경우도 관리자의 해소 대상에서 빠지지 않는다.
현재 profile version과 과거 assignment/attempt 정체성을 검증하되 이 해소로 기존 담당의
계정 상태·역할을 복원하거나 capability를 발급하지 않는다. 권한 부여 action의 maid/상태
제한 및 limited endpoint의 인증 경계는 그대로 유지한다.

인계가 여러 번 이어져도 과거 interrupted를 지우지 않는다. 같은 target의 더 큰 회차 번호로
넘겼음을 증명하는 불변 인계 관계만 재계획의 live-work 차단 검사에서 제외한다. 현재 live
회차는 여전히 차단하고, 증명이 없거나 다른 target·역방향 관계인 경우에는 예외를 적용하지 않는다.
이후 회차가 다시 인계되거나 superseded가 되어도 과거 인계 관계의 정체성은 유지한다.

만료 해소와 다른 담당에게 넘기는 인계의 source 검증은 구분한다. 원 maid를 유지하는 reclean
재계획을 타 maid 인계로 간주하지 않고, due가 없다고 가짜 마감을 생성하지 않는다. 다음 source
창과 점유 안전성을 증명할 수 없으면 변경 없이 거부한다.

## 원자성·데이터 노출

scoped receipt → 공통 domain lock → 일정한 profile/target/assignment/attempt lock 순서를
사용한다. 상태·capability·회수·알림/outbox·domain audit·receipt는 한 transaction이며
외부 Auth/Drive/push 호출을 그 안에서 기다리지 않는다.

일반 관리자 impact와 본인 limited projection은 명시적 ID/version/status/time/action만
반환한다. private raw capability/회수 원장에 Data API 권한을 주지 않는다. session ID, token,
PIN, guest PII, 전화번호, raw request/body/error, request hash를 감사 공개 summary에 넣지 않는다.
제한 상태의 정상적인 403이 activity logging 실패 때문에 500으로 바뀌지 않아야 한다.

## 검증 gate

- [x] admin/own maid/other maid/developer/inactive/departed/limited/revoked persona
- [x] exact RPC privileges, raw table DML/조회 차단, immutable grant/revocation
- [x] 2h/24h 경계, lock wait 뒤 expiry, 다른 key의 TTL 연장 차단
- [x] 제한 완료 성공 응답 유실 replay, old attempt 재활성 차단
- [x] complete/handover/계정 변경 및 start/expire 경쟁
- [x] 만료 해소·새 인계 일정 source/점유 검증 실패 시 전체 rollback
- [x] 감사 safe summary / bounded denial / OpenAPI / Python generated contract
- [x] fresh migration/DB/RLS/concurrency/lint/advisor 및 Edge/application/Python
- [x] exact-head independent QA P0/P1=0 — `037bc0652de8d9af1449249cbc3ee4a8f3e6cca9`
- [x] required CI `application` / `migration` PASS — run `34231187656`
- [x] 사용자 위임 기준 Codex 96/100 및 source/dev 승인
- [x] PR #77 dev squash 병합 — `5882509afed6faf31f5e9d7775a163e19954c4c2` (production 승격과 별도)

승인 head와 병합 결과의 tree는 `1add0ec8668513ece4acc8f9d09b9509e91e2145`로 동일하다.
다음 #7C offline lease/replay/quarantine/resolution은 착수 준비 단계이며 아직 미구현이다.
독립 QA·CI·위임 승인·dev 병합 완료를 production 활성화 완료로 해석하지 않는다.

기존 27개 migration은 수정하지 않는다. production/recovery/main/release/Edge/Pages/Cron/Vault,
secret/tag/GitHub Release는 별도 승인 전 변경하지 않는다.

로컬 검증: Edge104 / application123 / fresh28 migrations / DB·RLS806(신규111) / 전체 concurrency /
Python35 및 lint·format·mypy·package/generated contract PASS. SQL fixture는 deferred constraint까지
실제 확인한다. DB lint0, Security Advisor WARN/ERROR0 및 RPC-only 기본 거부 INFO5다.
