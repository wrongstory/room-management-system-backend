# #7A — 온라인 현장 수행 계약

작업 기준: `dev@7bdc2a3981e55e235de569527f7cc68f5ef80db1` 이후 별도 feature.
#4 notified-only 조회 gate는 PR #74로 완료됐다. 이 문서는 #7A의 source 계약이며 운영 사용 가능
선언이 아니다. 실제 구현·검증·병합 상태는 `API_STATUS_MATRIX.md`와 PR evidence를 따른다.

## 범위와 상태 축

`#28 scheduled 활성화 → #7A in_progress 시작 → #7A field_completed 물리적 완료`

#28이 실제 실행 가능한 현재 통보 revision의 scheduled attempt를 생성한다. #7A는 attempt를
새로 만들거나 assignment를 선택·변경하지 않는다. 서버가 생성한 회차의 실행 version을 CAS로
검사해 전이한다. maid별 in_progress는 최대 한 건이며 완료 후 이 제한이 해제된다.

field_completed는 물리적 청소 완료 선언이다. 사진·제출은 #30/#9/#31의 별도 gate이며 사진
0건도 현장 완료가 가능하다. 완료만으로 room ready, 청소/검수 승인, submission, earning,
payroll entitlement를 만들지 않는다. `endedAt` 등 다른 lifecycle 시각과 혼동하지 않는다.

물리 완료 시 `fieldCompletedAt`과 실행 종료 `endedAt`은 서버 시각으로 기록된다. target의 coarse
`in_progress`는 미승인 workflow가 남았다는 기존 상태로 유지한다(target에 field_completed enum 없음).
사진 미전송 여부를 모르는 단계에서 `upload_pending`으로 추측하지 않는다. 현장 수행 UI는 target
상태만으로 "청소 중"을 표시하지 말고 current attempt의 `status/fieldCompletedAt`을 사용한다.

## HTTP 계약

| Method / path | 용도 | 권한 |
|---|---|---|
| `GET /v1/attempts/current?assignmentId=UUID` | 본인 current notified 배정의 실행 회차/CAS 조회, 활성화 전은 null | active maid self |
| `POST /v1/attempts/{attemptId}/start` | scheduled → in_progress | active maid self |
| `POST /v1/attempts/{attemptId}/complete-field-work` | in_progress → field_completed | active maid self |

두 POST는 `Idempotency-Key`와 `expectedExecutionVersion`, `expectedAssignmentId`,
`expectedAssignmentRevision`을 받는다. actor·시각·status·snapshot·고객명·PIN·사진 payload는
입력받지 않는다. 서버 시각으로 처리하며 offline client occurredAt/lease는 #7C에서 별도 계약한다.
구체 DTO와 stable error enum은 같은 source의 OpenAPI를 따른다.

조회는 전체 목록/history가 아니다. 본인 실제 current notified assignment만 허용하며 과거
통보 history를 조회할 권한이 현재 실행 권한으로 승격되지 않는다. 다른 maid·미통보 draft를
hydration하거나 현재 객실·예약 PII를 가져오지 않는다. 기존 Fastify에 attempt HTTP가 없으므로
Edge-only source로 표시하며 Fastify rollback에 새 실행 endpoint가 있다고 가정하지 않는다.

## 권한·시간 검증

Edge는 Auth user → 최신 active profile → 유효·미폐기 session → 비밀번호 변경 완료 → exact maid를
검증한다. DB command도 최신 actor, 본인 attempt, current notified assignment/revision, target 관계,
CAS와 상태 전이를 확인한다. service-role 호출이나 idempotency replay도 현재 권한을 우회하지 않는다.

시작은 현재 KST 서비스 날짜·접근 시간창·source 관계·실제 checkout/materialization·점유를 다시
검증한다. additional의 과거 activation 창이 유효했다는 이유로 현재 투숙 중인 객실에서 시작할 수
없다. demo/fallback duration을 새로운 최대 청소시간이나 미래 점유 예측 정본으로 쓰지 않는다.
처음 통보 당시 객실 identity와 immutable attempt room snapshot이 현재 target의 객실과 일치해야
시작할 수 있다. legacy snapshot null/missing을 현재 객실로 추측해서 채우지 않는다.

완료는 합법적으로 시작한 물리 수행의 종료 선언이다. 자정, dueAt 경과 또는 stayover 시작 뒤
정상 scheduled checkout이 발생했다는 이유만으로 거부하지 않는다. 현재 actor/ownership,
assignment/attempt identity·revision·CAS·in_progress 상태 및 명시적 취소/담당 종료는 계속 검사한다.
새 최대 수행 시간·클라이언트 시각 인정·offline 정책은 이번 단계에서 추가하지 않는다.

## #7B 전 계정 안전 경계

진행 중인 메이드를 일반 role/status 변경으로 비활성화하면 기존 계정 명령이 session을 폐기해
작업이 고립될 수 있다. #7B 전에는 해당 DB 변경을 `ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED`로
거부한다. profile row와 시작 전이를 직렬화하며 guard 안에서 다른 전역 lock을 잡지 않는다.

상태 변경은 기존 DB-first 경로라 DB 거부 시 Auth ban 호출이 없다. 역할 변경은 기존
Auth metadata update → DB → 실패 시 metadata 보상 순서를 유지한다. 따라서 역할 변경 거부를
"Auth 호출 0회"로 표현하지 않는다. 실제 권한은 metadata가 아니라 최신 DB role을 따른다.

#7B가 현재 한 건 마무리/즉시 인계와 제한 capability 전용 경로를 구현하기 전까지는 이 거부를
UI에서 정상 업무 제한으로 표시한다. 일반 active guard를 완화하거나 우회 credential을 발급하지 않는다.

## 원자성·노출

command receipt는 actor/command/key와 canonical request hash로 분리한다. 같은 요청은 기존
논리 결과를 반환하고 같은 scope/key의 다른 payload는 conflict다. receipt·실행 전이·domain audit는
같은 짧은 transaction이며 실패하면 함께 rollback한다. 외부 Drive/push 호출은 없다.

실행 response와 developer 감사 projection은 명시적인 ID/version/status/time allowlist만 사용한다.
raw before/after state, template/room snapshot, request hash, PIN, PII, auth/session/secret을
반환하거나 감사 payload로 복제하지 않는다. 실행 권한 거부는 기존 bounded activity aggregate를 따른다.

## 후속 및 배포 경계

- #7B: interrupt/handover, deactivation_pending/upload_only, execution 2시간·upload/submit 최대24시간
  capability. 기존 Auth session과 DB capability만 사용하며 opaque credential은 금지한다.
- #7C: online-start-only work lease, client replay/quarantine/resolution. #7A는 offline 성공을 주장하지 않는다.
- #30 → #9 → #31: 사진 slot, Drive 7일 보존, submission/검수·재청소.
- #73: 기존 planned checkout 예약 객실 변경 FK 문제는 별도 후속이며 #7A에서 수정하지 않는다.
- 기존 #28은 scheduled를 포함한 non-superseded attempt가 있으면 이월하지 않고 #27도 변경을
  거부한다. 따라서 활성화만 되고 시작하지 않은 scheduled가 마감/자정을 넘으면 start가
  fail-closed되며 현재 관리자 해소 경로는 없다. #7B 사전 분석에서 별도 해소 정책을 확인해야
  하며, 이번 #7A가 이를 자동 이월·취소·재활성화하거나 해결했다고 표현하지 않는다.

기존 dev26 migrations는 수정하지 않고 append-only migration을 추가한다. 운영 19 migrations,
production OpenAPI 39 paths / 43 operations, main/recovery/Edge/Pages/Cron/tag는 이번 작업에서 변경하지 않는다.
