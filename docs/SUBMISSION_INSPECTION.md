# 전체 제출·검수·재청소 계약 — Issue #31 / #170

## 상태와 범위

- 개발 기준: `dev` 79 migrations / OpenAPI 0.5.1 129 paths / 139 operations 위에 #170의 80번째 append-only migration을 추가한다.
- source: `20260909120308_submission_inspection_reclean.sql`과
  `20260923020000_inspection_queue_pagination.sql`, Fastify/Edge/OpenAPI parity.
- 상태: #31 source는 production에 포함됐다. #170은 검수 대기열의 bounded keyset pagination, signed cursor,
  응답 상한을 source 계약에 추가하며 production 승격과 hosted smoke는 별도 release gate다.
- 승인 후 고객 컴플레인/보상 재작업은 별도 도메인이다. 원 maid 퇴사·부상 등 수행 불가 예외는
  2026-09-23 결정과 #264 계약에 따라 일반 취소·재배정을 사용한다.

## 상태 전이

```text
field_completed
  → immutable submission vN + sealed current photo versions
  → inspection_pending
      ├─ approved → earning exactly once + informational notification
      └─ rejected → original-maid notified zero-fee reclean + actionable notification
```

`field_completed`만으로 submission, ready, earning은 생기지 않는다. 제출 시점에 current notified
assignment/attempt/version과 필수 verified·accepted·미만료·미삭제 photo slot 전체를 DB에서 다시
검증한다. 일반 재제출은 새 immutable version을 만들고 과거 version을 `superseded`로 보존한다.
current pointer는 expected revision CAS다.

폭탄방 신고는 원 maid의 attempt에 제출 전에 기록하며 선택한 current photo version 1~20장과
memo를 불변 보관한다. 최초 submission에 seal된 신고·증빙은 다른 version으로 이동하지 않으므로
폭탄 신고가 있는 version의 재제출은 `BOMB_REPORT_SEALED`로 차단한다. 폭탄 선판정만으로 earning은
생기지 않는다.

## 검수와 재청소

active password-complete business admin의 live session만 pending queue/detail/decision을 사용한다. stale current submission은
`STALE_VERSION`으로 거부하며, 같은 command scope의 retry는 canonical request hash receipt로
재생하고 다른 payload는 충돌 처리한다. queue는 `(submittedAt ASC, id ASC)` keyset으로 oldest-first
조회하며 page 기본 50건·최대 100건이다. `nextCursor`는 actor profile/role/stream/fixed sort와 마지막
key를 HMAC-SHA256으로 묶은 opaque 값이고, 응답은 `hasMore`와 `nextCursor`를 함께 반환한다. cursor는
다른 사용자·목록·정렬에서 재사용할 수 없다. Fastify와
Edge는 동일 계약으로 `Cache-Control: no-store`를 설정하고 직렬화된 응답이 128 KiB를 넘으면
`INSPECTION_RESPONSE_TOO_LARGE`로 fail-closed한다.

승인은 inspection decision, submission/attempt/target 상태, notification/outbox/audit와 원청소
earning을 하나의 transaction에서 확정한다. 승인된 폭탄방 bonus는 frozen base fee와 같고,
base가 0이면 bonus도 0이다. 반려는 earning을 만들지 않고 원 attempt/submission/decision/maid에
고정된 0원 `inspection_reclean` target과 notified assignment를 같은 transaction에서 만든다.
반려 알림만 `requires_action=true`다. 재청소 attempt는 즉시 생성하지 않고 #28 activation만 만든다.

reclean template은 원 room type의 published `cleaning_kind='reclean'` version이 정확히 한 건이어야
한다. 없거나 모호하면 `RECLEAN_TEMPLATE_NOT_CONFIGURED`로 inspection decision, 상태, 알림,
outbox, audit 전체를 rollback한다. 원 maid가 수행 가능하면 다른 maid에게 임의 이관하지 않는다.

원 maid가 퇴사·부상 등으로 재청소를 수행할 수 없으면 관리자가 현재 배정을 취소한다. 기존 0원 `inspection_reclean` target은 완료로 위장하거나 다른 maid에게 이관하지 않고 취소 이력으로 보존한다. 대신 원 유상 청소의 fee/template snapshot을 가진 별도 ordinary replacement target을 미배정으로 만들고 관리자에게 재배정 필요 알림을 보낸다. 새 담당자는 일반 완료·검수·earning·payroll 규칙을 따르며 별도 compensation 원장이나 원 담당자의 미완료 earning은 만들지 않는다.

checkout obligation 완료는 root target status만 신뢰하지 않는다. `completion_submission_id`가
승인된 terminal descendant인지 recursive reclean chain으로 증명하며 새 completed row의 NULL proof는
거부한다.

## 공개 정보 경계

관리자 queue/detail의 review context는 notified assignment의 immutable room snapshot을 사용한다.
detail의 일반 증빙은 `photoId`, target slot ID/key/label/order/required, photo version만 반환하며,
폭탄 증빙도 sealed opaque photo ID만 반환한다. 실제 이미지는 기존 관리자 photo content API로
조회한다.

다음 값은 submission/inspection API와 developer audit projection에 노출하지 않는다.

- Drive locator, provider object ID, file name, hash, 바이너리
- PIN, 고객 PII, token/session/secret
- request hash와 raw before/after state
- 폭탄 memo/evidence ID(일반 developer audit와 maid history)

`upload_only` 메이드는 정확한 live `upload_submit` capability가 있을 때만 본인 attempt의
submission POST를 사용할 수 있다. `deactivation_pending`의 `finish_current` capability는 제출
권한으로 확대하지 않는다. evidence-only, expired/revoked capability, inactive 계정은 차단한다.
폭탄 신고와 관리자 검수는 이 제한 인증 경계를 공유하지 않는다.
