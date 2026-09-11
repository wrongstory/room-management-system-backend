# 알림 이벤트 카탈로그 v1

이 문서는 Issue #109에서 확정한 28개 공개 category와 42개 event family의 정본이다. DB의
`private.notification_event_catalog`와 테스트가 이 표를 그대로 검증한다. `source`는 알림 생성과
해결의 typed provenance이며 audit payload나 문자열 dedupe는 권한 근거가 아니다.

공통 규칙:

- inbox는 수신자 상태와 임시 비밀번호 여부와 무관하게 도메인 transaction 안에서 보존한다.
- typed delivery outbox는 `push=yes`, `requiresAction=yes`, active/password-complete 수신자이고
  actor와 수신자가 다를 때만 생성한다.
- 그룹은 `(recipient, groupFamily, scopeKind, scopeId)`별 최초 event 시각부터 고정 10분
  `[startedAt, startedAt + 10m)`이다. 경계 시각은 새 UUID `groupId`를 만든다.
- 공개 deep link kind는 `cleaningTarget`, `assignmentRequest`, `submission`, `complaintCase`,
  `payrollCycle`, `payrollProfile`만 허용한다.
- resolver가 `none`이면 informational history이며, 그 밖의 resolver는 표의 exact source와
  terminal domain evidence가 일치할 때만 `resolved_at`을 최초 1회 기록한다.

| event family | category | recipient capability | action/push | source | resolver | deep link | group family/scope |
|---|---|---|---|---|---|---|---|
| assignment.commit_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| assignment.prestart_new_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| attempt.handover_next_notified | cleaning_assignment_notified | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_notified/room |
| reservation.extension_revoked | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| reservation.cancelled_revoked | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| cleaning_request.cancelled_revoked | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| assignment.prestart_old_revoked | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| assignment.prestart_unassigned | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| attempt.handover_previous_revoked | cleaning_assignment_revoked | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_revoked/room |
| reservation.manual_checkout_rescheduled | cleaning_schedule_changed | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_schedule_changed/room |
| assignment.prestart_same_maid_changed | cleaning_assignment_changed | maid.assignment_party | yes/yes | cleaning_assignment | assignment_terminal | cleaningTarget | cleaning_assignment_changed/room |
| assignment.cancellation_requested | assignment_cancellation_requested | admin.assignment_decider | yes/yes | assignment_change_request | assignment_request_terminal | assignmentRequest | assignment_cancellation_requested/room |
| assignment.cancellation_approved | assignment_cancellation_approved | maid.assignment_party | no/no | assignment_change_request | none | assignmentRequest | assignment_cancellation_approved/room |
| assignment.cancellation_rejected | assignment_cancellation_rejected | maid.assignment_party | no/no | assignment_change_request | none | assignmentRequest | assignment_cancellation_rejected/room |
| assignment.scheduled_rolled_over | cleaning_assignment_rolled_over | maid.assignment_party | no/no | cleaning_assignment | none | cleaningTarget | cleaning_assignment_rolled_over/room |
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
`private.notification_delivery_outbox`가 #111 worker의 유일한 향후 입력이다. #109에서는 pending append와
권한 차단만 정의하며 claim, lease, retry, provider 호출은 구현하지 않는다.
