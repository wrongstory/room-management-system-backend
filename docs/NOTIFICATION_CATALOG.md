# 알림 이벤트 카탈로그 v1

2026-10-02 현재 source/dev 기준은 `dev@4fe6c981`의 92 migrations다.
#308 [PR #340](https://github.com/wrongstory/room-management-system-backend/pull/340)과
#343 [PR #346](https://github.com/wrongstory/room-management-system-backend/pull/346)은 각각
승인 source/dev tree 동일성·required CI application/migration PASS·독립 QA98/100으로 통합 완료했다.
#305 종료는 문서 정합화 PR의 exact-head CI·독립 QA·dev 통합 확인 뒤에만 수행하며
최종 근거는 [Issue #305](https://github.com/wrongstory/room-management-system-backend/issues/305)에서 추적한다.
[종료 감사](./WORK_DEADLINE_CLOSURE.md)의 별도 후속을 따른다.
이 기록은 main/production/recovery·프런트·tag·실기기 UAT 변경이나 최신 운영 재검증이 아니다.

#305/#308의 dev 계약은 시간 만료에 따른 rollover/`scheduled_expired` 신규 이벤트를 만들지 않는다.
이 카탈로그의 기존 관련 family는 과거 typed 이력의 유효성·조회 증명을 위해 유지한다.
2차로 통합한 `cleaning.overdue_admin`은 미완료 현장 청소의 최초 지연을 관리자에게 알린다.
target별 immutable event와 수신자별 enrollment로 10분 grouping 경계를 넘어도 중복하지 않는다.
3차로 통합한 `cleaning.started_admin`은 정상 청소 시작을 업무관리자에게 알린다.
자기 push를 만들지 않으며 기존 검수 승인 등의 inbox/push 정책은 바꾸지 않는다. 운영 전달 완료가 아니다.
[계약과 단계별 과거 검증](./CLEANING_OVERDUE.md)을 따른다.

6차로 통합한 계약은 성공한 폭탄방·특이사항 신고를 관리자에게, 폭탄방 선판정을 해당 메이드에게
즉시 informational inbox/outbox로 기록한다. 실제 기기 전달 완료를 뜻하지 않는다. 기존 전체 제출/최종 검수 알림과 다른 사건이며,
과거 이력 backfill·단순 사진 업로드 알림·원문 복제는 없다.
[상대 역할 알림 검증](./CLEANING_REPORT_NOTIFICATIONS.md)을 따른다.

#343의 dev 계약은 최초 판정의 기존 7일 응답 기준을 지난 미응답 사건에 관리자 주의 알림을 추가한다.
새 SLA·권한 만료·자동 종결·반복 경고가 아니며 [주의 알림 계약](./COMPLAINT_RESPONSE_ATTENTION.md)을 따른다.

이 문서는 Issue #109의 기반 계약과 Issue #128/#264/#308/#343의 보완을 반영한 현재 dev의
42개 공개 category와 59개 event family 정본이다. DB의
`private.notification_event_catalog`와 테스트가 이 표를 그대로 검증한다. `source`는 알림 생성과
해결의 typed provenance이며 audit payload나 문자열 dedupe는 권한 근거가 아니다.
이번 문서 감사에서 기존 표의 #133 checkout 3행과 #187 DURING_STAY room-move 1행 누락을
보완했다. 이미 적용된 `20260913141655_checkout_not_completed_incident_workflow.sql`과
`20260916210000_reservation_during_stay_room_move.sql`의 catalog 계약을 그대로 문서화하며
새 category/family·권한·runtime 변경은 없다.

2026-09-23 사용자 UAT에서 실제 기기 Web Push 수신을 확인한 이력은 보존한다. 이 확인은
당시 공개 알림 계약의 전달 가능성에 한정하며 #308/#343 새 family의 운영 전달·UAT나 현재 worker
health를 대신 검증하지 않는다. provider secret·개별 subscription 원문도 공개하지 않는다.

공통 규칙:

- inbox는 수신자 상태와 임시 비밀번호 여부와 무관하게 도메인 transaction 안에서 보존한다.
- typed delivery outbox는 `push=yes`, active/password-complete 수신자이고
  actor와 수신자가 다를 때만 생성한다.
- `push`와 `requiresAction`은 독립 축이다. 취소·회수·결정·현장 완료 같은 informational event도
  `no/yes`로 즉시 전달할 수 있으며 inbox의 행동 상태를 거짓으로 올리지 않는다.
- 그룹은 `(recipient, groupFamily, scopeKind, scopeId)`별 최초 event 시각부터 고정 10분
  `[startedAt, startedAt + 10m)`이다. 경계 시각은 새 UUID `groupId`를 만든다.
- 공개 deep link kind는 `cleaningTarget`, `assignmentRequest`, `submission`, `complaintCase`,
  `payrollCycle`, `payrollProfile`만 허용한다.
- resolver가 `none`이면 자동 terminal resolve를 하지 않는다. 행동 필요 여부는 별도
  `requiresAction` 계약이며 resolver로 추측하지 않는다. 그 밖의 resolver는 표의 exact source와
  terminal domain evidence가 일치할 때만 `resolved_at`을 최초 1회 기록한다.

| event family | category | recipient capability | action/push | source | resolver | deep link | group family/scope |
|---|---|---|---|---|---|---|---|
| assignment.commit_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| assignment.prestart_new_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| attempt.handover_next_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| reservation.extension_revoked | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| reservation.cancelled_revoked | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| cleaning_request.cancelled_revoked | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| assignment.prestart_old_revoked | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| assignment.prestart_unassigned | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| attempt.handover_previous_revoked | cleaning_assignment_revoked | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| reservation.manual_checkout_rescheduled | cleaning_schedule_changed | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_schedule_changed/room |
| reservation.notified_schedule_changed | cleaning_schedule_changed | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_schedule_changed/room |
| reservation.notified_guest_count_changed | cleaning_assignment_changed | maid.assignment_party | no/yes | audit_event_assignment | none | cleaningTarget | cleaning_assignment_changed/room |
| reservation.room_moved_during_stay | reservation_room_moved | admin.assignment_decider | yes/yes | reservation | none | cleaningTarget | reservation_room_moved/room |
| checkout.presence_reported_admin | checkout_presence_reported | admin.assignment_decider | yes/yes | checkout_presence_incident | checkout_incident_terminal | cleaningTarget | checkout_presence_reported/room |
| checkout.presence_resolved_maid | checkout_presence_resolved | maid.assignment_party | no/yes | checkout_presence_incident_decision | none | cleaningTarget | checkout_presence_resolved/room |
| checkout.presence_previous_maid_resolved | checkout_presence_resolved | maid.assignment_party | no/yes | checkout_presence_incident_decision | none | cleaningTarget | checkout_presence_resolved/room |
| assignment.prestart_same_maid_changed | cleaning_assignment_changed | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_changed/room |
| assignment.cancellation_requested | assignment_cancellation_requested | admin.assignment_decider | yes/yes | assignment_change_request | assignment_request_terminal | assignmentRequest | assignment_cancellation_requested/room |
| assignment.cancellation_approved | assignment_cancellation_approved | maid.assignment_party | no/yes | assignment_change_request | none | assignmentRequest | assignment_cancellation_approved/room |
| assignment.cancellation_rejected | assignment_cancellation_rejected | maid.assignment_party | no/yes | assignment_change_request | none | assignmentRequest | assignment_cancellation_rejected/room |
| assignment.reassignment_required | assignment_reassignment_required | admin.assignment_decider | yes/yes | assignment_unavailability_cancellation | none | cleaningTarget | assignment_reassignment_required/room |
| assignment.scheduled_rolled_over | cleaning_assignment_rolled_over | maid.assignment_party | no/yes | cleaning_assignment | none | cleaningTarget | cleaning_assignment_rolled_over/room |
| cleaning.field_completed_admin | cleaning_field_completed | admin.inspection_queue | no/yes | cleaning_attempt | none | cleaningTarget | cleaning_field_completed/room |
| cleaning.started_admin | cleaning_started | admin.assignment_decider | no/yes | cleaning_attempt | none | cleaningTarget | cleaning_started/room |
| cleaning.overdue_admin | cleaning_overdue | admin.assignment_decider | no/yes | cleaning_overdue_event | none | cleaningTarget | cleaning_overdue/room |
| bomb.reported_admin | bomb_room_reported | admin.inspection_queue | no/yes | bomb_room_report | none | cleaningTarget | bomb_room_reported/room |
| room_issue.reported_admin | room_issue_reported | admin.inspection_queue | no/yes | attempt_room_issue_report | none | cleaningTarget | room_issue_reported/room |
| bomb.decided_maid | bomb_room_decided | maid.inspection_subject | no/yes | bomb_room_decision | none | submission | bomb_room_decided/room |
| room.operation_block_changed | cleaning_room_operation_changed | maid.assignment_party | no/yes | audit_event_assignment | none | cleaningTarget | cleaning_room_operation_changed/room |
| room.issue_status_changed | cleaning_room_issue_changed | maid.assignment_party | no/yes | audit_event_assignment | none | cleaningTarget | cleaning_room_issue_changed/room |
| room.pin_sync_status_changed | cleaning_pin_sync_changed | maid.assignment_party | no/yes | audit_event_assignment | none | cleaningTarget | cleaning_pin_sync_changed/room |
| capability.finish_current_issued | cleaning_capability_changed | maid.limited_grantee | yes/yes | attempt_capability_grant | capability_terminal | cleaningTarget | cleaning_capability_changed/room |
| capability.upload_submit_admin_issued | cleaning_capability_changed | maid.limited_grantee | yes/yes | attempt_capability_grant | capability_terminal | cleaningTarget | cleaning_capability_changed/room |
| capability.upload_submit_self_issued | cleaning_capability_changed | maid.limited_grantee | yes/yes | attempt_capability_grant | capability_terminal | cleaningTarget | cleaning_capability_changed/room |
| capability.evidence_upload_handover_issued | cleaning_capability_changed | maid.limited_grantee | yes/yes | attempt_capability_grant | capability_terminal | cleaningTarget | cleaning_capability_changed/room |
| capability.upload_submit_offline_resolution_issued | cleaning_capability_changed | maid.limited_grantee | yes/yes | attempt_capability_grant | capability_terminal | cleaningTarget | cleaning_capability_changed/room |
| submission.initial_requested | cleaning_inspection_requested | admin.inspection_queue | yes/yes | cleaning_submission | submission_terminal | submission | cleaning_inspection_requested/room |
| submission.reinspection_requested | cleaning_reinspection_requested | admin.inspection_queue | yes/yes | cleaning_submission | submission_terminal | submission | cleaning_reinspection_requested/room |
| inspection.original_approved | cleaning_inspection_approved | maid.inspection_subject | no/no | inspection_decision | none | submission | cleaning_inspection_approved/room |
| inspection.reclean_approved | cleaning_inspection_approved | maid.inspection_subject | no/no | inspection_decision | none | submission | cleaning_inspection_approved/room |
| inspection.complaint_rework_approved | cleaning_inspection_approved | maid.inspection_subject | no/no | inspection_decision | none | submission | cleaning_inspection_approved/room |
| inspection.original_rejected_reclean_created | cleaning_inspection_rejected | maid.inspection_subject | yes/yes | inspection_decision | reclean_submission | cleaningTarget | cleaning_inspection_rejected/room |
| inspection.complaint_rework_rejected | cleaning_inspection_rejected | maid.inspection_subject | no/no | inspection_decision | none | submission | cleaning_inspection_rejected/room |
| complaint.received | complaint_received | maid.complaint_party | no/no | complaint_case_event | none | complaintCase | complaint_received/room |
| complaint.decided | complaint_decided | maid.complaint_party | yes/yes | complaint_case_event | complaint_response | complaintCase | complaint_decided/room |
| complaint.corrected | complaint_corrected | maid.complaint_party | no/no | complaint_case_event | none | complaintCase | complaint_corrected/room |
| complaint.acknowledged | complaint_acknowledged | admin.complaint_decider | no/no | complaint_case_event | none | complaintCase | complaint_acknowledged/room |
| complaint.appealed | complaint_appealed | admin.complaint_decider | yes/yes | complaint_case_event | complaint_admin_response | complaintCase | complaint_appealed/room |
| complaint.closed | complaint_closed | maid.complaint_party | no/no | complaint_case_event | none | complaintCase | complaint_closed/room |
| complaint.response_attention_admin | complaint_response_attention | admin.complaint_decider | no/yes | complaint_response_attention_event | none | complaintCase | complaint_response_attention/room |
| complaint.rework_assigned | complaint_rework_assigned | maid.rework_assignee | yes/yes | complaint_compensation_decision | rework_submission | cleaningTarget | complaint_rework_assigned/room |
| payroll.adjustment_recorded | payroll_adjustment_recorded | maid.payroll_owner | no/no | payroll_adjustment | none | payrollProfile | payroll_adjustment_recorded/payrollProfile |
| payroll.adjustment_reversed | payroll_adjustment_reversed | maid.payroll_owner | no/no | payroll_adjustment | none | payrollProfile | payroll_adjustment_reversed/payrollProfile |
| payroll.late_earning_carried | payroll_late_earning_carried | maid.payroll_owner | no/no | payroll_adjustment | none | payrollProfile | payroll_late_earning_carried/payrollProfile |
| payroll.payment_started | payroll_payment_started | maid.payroll_owner | no/no | payroll_payment_attempt | none | payrollCycle | payroll_payment_started/payrollCycle |
| payroll.offset_settled | payroll_offset_settled | maid.payroll_owner | no/no | payroll_offset_settlement | none | payrollCycle | payroll_offset_settled/payrollCycle |
| payroll.payment_check_recorded | payroll_payment_check | maid.payroll_owner | no/no | payroll_payment_result | none | payrollCycle | payroll_payment_check/payrollCycle |
| payroll.payment_paid | payroll_payment_paid | maid.payroll_owner | no/no | payroll_payment_result | none | payrollCycle | payroll_payment_paid/payrollCycle |
| payroll.payment_reopened | payroll_payment_reopened | maid.payroll_owner | no/no | payroll_payment_result | none | payrollCycle | payroll_payment_reopened/payrollCycle |

`private.notification_outbox`는 provenance가 없는 legacy history로만 보존하며 어떤 worker도 읽지 않는다.
`private.notification_delivery_outbox`가 #111 worker의 유일한 입력이다. 과거 #109 자체 범위에서는
pending append와 권한 차단만 정의했으며 claim, lease, retry, provider 호출은 후속 #111/#112로 구현했다.

## #111 delivery 계약

`private.notification_delivery_outbox`는 계속 변경 불가능한 typed intent다. #111은 별도 private
job/target 원장에서 최초 claim 때 active subscription의 exact logical ID/version/revision을 한 번만
snapshot한다. 당시 구독이 없으면 `NO_ACTIVE_SUBSCRIPTION`, enqueue 후 24시간이 지나면
`STALE_NOTIFICATION` terminal이며 이후 등록으로 과거 push를 재생하지 않는다.

#343 신규 `complaint.response_attention_admin`만 늦게 자격을 갖춘 수신자의 최초 enrollment
시각을 새 outbox의 enqueue 기준으로 쓴다. inbox/group의 원 event 시각은 그대로이며
기존 수신자 outbox 재발행·24시간 TTL 연장은 없다. 반면 `cleaning.overdue_admin`은 원 event-clock을
유지하여 24시간 뒤 새 admin push가 즉시 만료될 수 있다. 이 기존 family 한계는
[#345](https://github.com/wrongstory/room-management-system-backend/issues/345) OPEN이며 #343 완료로 해결되지 않았다.

send 권한의 선형화점은 encrypted envelope 복호화와 live `auth.sessions` 확인 뒤의 exact-current
fenced permit이다. permit 전 rotation/retire는 전송을 막는다. permit 직후 동시 retire 또는 provider
성공 뒤 settle 전 crash는 old endpoint 전송/재전송을 최대 한 번 더 만들 수 있으므로 delivery는
at-least-once다. payload의 안정적인 `notificationId`가 client dedupe identity이며 dedupeKey/groupKey,
recipient, endpoint/key/session/provider 원문은 payload·원장·로그에 포함하지 않는다.

lease는 2분, provider attempt는 최대 8회다. retry는 DB server time 기준 30초 지수 backoff(최대 1시간)
+ deterministic 0~15초 jitter이고 worker는 sleep하지 않는다. attempt/result/event는 terminal 뒤 90일
bounded purge 대상이지만 실제 purge Cron은 #112다. 401/403 계열 provider configuration 오류는 endpoint를
retire하지 않고 operator-blocked로 멈추며 service-only bounded resume 후에도 총 8회 상한을 유지한다.

`claim limit=10`은 한 run이 반환하거나 target 없이 terminal 처리하는 workload의 hard bound다. 최초
fanout으로 10개보다 많은 target이 고정돼도 10개만 claim하고 나머지는 다음 run에 남긴다. 한 target의
provider configuration failure가 parent job을 막으면 모든 non-terminal sibling은 lease가 만료돼도
재claim되지 않으며, `resume_blocked_notification_deliveries()`만 parent와 sibling 전체를 함께 재개한다.
developer health의 `jobOnlyDeadLetter`는 target 생성 전 contract 실패만 별도로 세고 target dead-letter와
중복하지 않는다.

## #112 Web Push payload/provider 계약

각 subscription revision은 registration/rotation 당시 서버가 선택한 immutable VAPID key version에
결합된다. legacy NULL binding은 current key로 추측하지 않고 `VAPID_KEY_UNBOUND` / `suppressed`
dead-letter로 push만 종결한다. 사용자가 새 public config로 명시적으로 구독을 rotate하면 이후 새
revision부터 다시 delivery 대상이 되며 과거 notification은 재생하지 않는다.
config가 발급한 10분 opaque proof는 exact actor/profile/live session, key version과 public-key identity를
결합하며 register는 client version 입력을 받지 않는다. 회전 overlap은 bounded prior keyring에 남은 proof만
허용하고 removed/unknown/expired/tampered/cross-session proof는 fail-closed한다.

provider plaintext는 catalog의 원문 title/body/category를 전달하지 않는다. 잠금화면 문구는
`새 업무 알림`과 `앱에서 확인해 주세요`로 고정하고, data payload는 `payloadVersion=1`, stable
`notificationId`, 아래 source-controlled deep-link kind 중 하나와 entity UUID만 허용한다.

- `cleaningTarget`
- `assignmentRequest`
- `submission`
- `complaintCase`
- `payrollCycle`
- `payrollProfile`

plaintext는 UTF-8 3072 bytes, RFC8291 encrypted body는 4096 bytes를 넘지 않는다. accepted 결과는
push service 수락이며 device 표시 보장이 아니다. service worker는 stable notification ID를 tag로 쓰고
`renotify=false`, 24시간/최대 1000건 bounded dedupe로 at-least-once 재전송을 수렴시킨다.
