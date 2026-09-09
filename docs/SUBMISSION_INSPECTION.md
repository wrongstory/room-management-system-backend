# 전체 제출·검수·재청소 계약 — Issue #31

## 상태와 범위

- 기준: `dev@92c0f97b412e9a4ccf41934b6924bc59ca2f9dd2` 위 feature source.
- source: append-only `20260909120308_submission_inspection_reclean.sql`, Fastify/Edge parity,
  OpenAPI **74 paths / 80 operations**.
- 상태: 로컬 source 검증 완료, 독립 리뷰·dev 병합·release/main·production 미완료.
- 승인 후 고객 컴플레인/보상 재작업과 원 maid inactive/departed 예외 이관은 범위 밖이다.

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

active business admin만 pending queue/detail/decision을 사용한다. stale current submission은
`STALE_VERSION`으로 거부하며, 같은 command scope의 retry는 canonical request hash receipt로
재생하고 다른 payload는 충돌 처리한다. queue는 현재 oldest-first 최대 100건이며 cursor pagination은
후속 hardening이다.

승인은 inspection decision, submission/attempt/target 상태, notification/outbox/audit와 원청소
earning을 하나의 transaction에서 확정한다. 승인된 폭탄방 bonus는 frozen base fee와 같고,
base가 0이면 bonus도 0이다. 반려는 earning을 만들지 않고 원 attempt/submission/decision/maid에
고정된 0원 `inspection_reclean` target과 notified assignment를 같은 transaction에서 만든다.
반려 알림만 `requires_action=true`다. 재청소 attempt는 즉시 생성하지 않고 #28 activation만 만든다.

reclean template은 원 room type의 published `cleaning_kind='reclean'` version이 정확히 한 건이어야
한다. 없거나 모호하면 `RECLEAN_TEMPLATE_NOT_CONFIGURED`로 inspection decision, 상태, 알림,
outbox, audit 전체를 rollback한다. 다른 maid 이관은 허용하지 않는다.

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
