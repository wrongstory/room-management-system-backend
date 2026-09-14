# v0.3.0 릴리즈·운영 승격 계획

> 상태: source/dev 완료, release 준비 중, main/production 미승격

이 문서는 Issue #148의 release gate와 운영 활성화 순서를 기록한다. v0.2.0의 과거 evidence는
[`RELEASE_V0.2.0.md`](./RELEASE_V0.2.0.md)에 그대로 보존하며 이 문서에서 소급 수정하지 않는다.

## 1. Source와 브랜치 gate

| 경계 | 승인 기준 | 현재 상태 |
|---|---|---|
| production/main | `main@035f3b2f3b4a88340e70ef6dc1d6e6a3def8231b`, v0.2.0 | 유지, 변경 없음 |
| source/dev | `dev@5798e882495e42763db6c227b7cb804527ccde47`, 54 migrations, OpenAPI 108/115 | #133 및 #146/#147 보완 완료 |
| release | `release/v0.3.0`, main ancestry 포함, release 계약 변경 외 dev tree 보존 | 준비 중 |
| target | `release/v0.3.0 → main` PR | 미생성·미병합 |

- `dev` 또는 `main`에 직접 push하지 않는다.
- release exact head에서 `application`과 `migration`, 독립 QA 90점 이상, P0/P1=0, 충돌 없음,
  migration manifest 일치를 확인한 뒤에만 main 승격을 요청한다.
- main 병합 전에는 production migration, Function Secrets, Edge, Cron/Vault, Pages를 변경하지 않는다.
- main 병합 뒤에도 backup/recovery evidence와 운영 승인 없이는 production을 변경하지 않는다.
- production smoke 완료 뒤에만 annotated `v0.3.0` tag와 GitHub Release를 발행한다.

## 2. 현재 production read-only 기준선

Issue #148 착수 시 운영 환경을 쓰지 않고 확인한 기준선이다.

| 항목 | 실제 read-only 결과 |
|---|---|
| stable migrations | 19, head `actor_activity_audit_contract` |
| Edge Functions | 2 ACTIVE: `api` version 9, `reservation-scheduler` version 8 |
| OpenAPI | version 0.2.0, 39 paths / 43 operations |
| 객실 / 예약 | 121 / 0 |
| reservation Cron | healthy |

이 값은 v0.3.0이 배포됐다는 뜻이 아니다. 현재 운영은 계속 v0.2.0이며 release source의
35개 pending migration과 3개 추가 Edge Function은 아직 운영에 없다.

## 3. Migration manifest와 적용 범위

정본은 [`migration-manifest.v0.3.0.json`](../supabase/migration-manifest.v0.3.0.json)이다.
각 SQL은 Git timestamp가 아닌 stable name, 정렬된 order, LF-normalized UTF-8 content SHA-256으로
고정한다. `npm run db:manifest:verify`는 정확히 54개, baseline 19개, pending 35개와 최종 head
`checkout_not_completed_incident_workflow`를 검증한다. 원격 적용 version이 Git timestamp와 달라도
stable name과 실제 SQL 내용을 대조하며 자동 `db push`, history repair, 재적용을 사용하지 않는다.

운영 pending 범위는 다음 20~54번 35건이다.

| 순서 | stable migration name |
|---:|---|
| 20 | `assignment_core` |
| 21 | `assignment_commit` |
| 22 | `planned_checkout_targets` |
| 23 | `assignment_prestart_change` |
| 24 | `assignment_attempt_activation` |
| 25 | `assignment_preview_duration_policy` |
| 26 | `maid_assignment_visibility` |
| 27 | `attempt_execution_core` |
| 28 | `attempt_handover_limited_capability` |
| 29 | `attempt_offline_lease_quarantine` |
| 30 | `photo_submission_base` |
| 31 | `photo_storage_operations` |
| 32 | `photo_drive_upload_read` |
| 33 | `photo_purge_reconciliation` |
| 34 | `submission_inspection_reclean` |
| 35 | `payroll_cycle_assembly_start` |
| 36 | `payroll_bounded_pagination` |
| 37 | `complaint_lifecycle` |
| 38 | `complaint_compensation_earning` |
| 39 | `payroll_adjustments` |
| 40 | `payroll_payment_results` |
| 41 | `notification_inbox_read_contract` |
| 42 | `notification_catalog_grouping_writers` |
| 43 | `web_push_subscription_revisions` |
| 44 | `notification_delivery_worker` |
| 45 | `web_push_vapid_binding` |
| 46 | `planned_checkout_room_change_fk` |
| 47 | `password_change_replay_receipt` |
| 48 | `assignment_notification_coverage` |
| 49 | `room_encrypted_pin_domain` |
| 50 | `room_pin_sheet_sync_worker` |
| 51 | `room_pin_sheet_full_resync` |
| 52 | `pin_bootstrap_reservation_readiness` |
| 53 | `room_pin_nonce_reservation_hardening` |
| 54 | `checkout_not_completed_incident_workflow` |

적용은 위 순서를 지키고 각 단계의 stable name/history를 확인한다. 실패하면 다음 migration으로
진행하지 않는다. 53번의 historical nonce conflict 또는 lock timeout은 전체 실패로 취급하고 원 PIN
이력을 고치지 않는다. 54번까지 적용한 뒤 manifest head, RLS/FORCE RLS, service-role-only RPC grant,
Security Advisor와 19→54 누적 upgrade evidence를 다시 확인한다.

## 4. Edge Functions와 필수 설정

v0.3.0의 승인 source에서 함께 배포할 Function은 정확히 5개다.

| Function | 역할 | 활성화 전제 |
|---|---|---|
| `api` | 108 paths / 115 operations 업무 API | 전체 migration과 API secrets |
| `reservation-scheduler` | 예약 시각 전이 | active admin actor, invoke secret, 기존 healthy Cron |
| `photo-purge` | accepted 168시간 만료·orphan·빈 폴더 정리 | Drive OAuth, purge invoke secret, empty/fixture smoke |
| `notification-delivery` | typed Web Push delivery | VAPID·subscription keys, invoke secret, device smoke |
| `room-pin-sheet-sync` | DB→Google Sheets PIN projection | PIN keys, service account, 승인 target/ACL, invoke secret |

다음 이름은 값이 아닌 deployment secret/config 이름이다. 실제 값은 Git, 문서, PR, 로그, audit,
Pages artifact에 넣지 않는다.

- 공통/예약: `RUNTIME_ENVIRONMENT`, `SUPABASE_PROJECT_REF`, `SCHEDULER_INVOKE_SECRET`,
  `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`, `PAYROLL_CURSOR_HMAC_SECRET`,
  `NOTIFICATION_CURSOR_HMAC_SECRET`
- 사진: `PHOTO_PURGE_INVOKE_SECRET`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
  `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- PIN/Sheets: `ROOM_PIN_KEY_BASE64`, `ROOM_PIN_KEY_VERSION`, `ROOM_PIN_KEYRING_JSON`,
  `ROOM_PIN_INITIAL_DIGITS`, `ROOM_PIN_SHEET_SYNC_INVOKE_SECRET`,
  `GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY`,
  `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_ROOM_PIN_TAB`
- Web Push: `WEB_PUSH_SUBSCRIPTION_KEY_BASE64`, `WEB_PUSH_SUBSCRIPTION_KEY_VERSION`,
  `WEB_PUSH_SUBSCRIPTION_KEYRING_JSON`, `WEB_PUSH_BINDING_DIGEST_SECRET`, `VAPID_SUBJECT`,
  `VAPID_CURRENT_KEY_VERSION`, `VAPID_PUBLIC_KEY`, `VAPID_PUBLIC_KEYRING_JSON`,
  `VAPID_PRIVATE_KEY`, `VAPID_KEYRING_JSON`, `NOTIFICATION_DELIVERY_INVOKE_SECRET`

Supabase가 관리하는 URL/service-role 환경과 위 application secret을 구분한다. 서로 다른 목적의
암호키, HMAC, invoke secret을 재사용하지 않는다. `.env.example` 파일에는 placeholder만 둔다.

## 5. Production 활성화 순서

1. 승인된 release exact head와 manifest를 고정하고 production backup 및 recovery restore evidence를 확인한다.
2. 현재 19개 stable migration을 read-only로 재대조한 뒤 20~54번을 명시적 순서로 적용한다.
3. migration history, RLS/grant, critical RPC, Security Advisor를 확인한다. 실패 시 Edge 배포로 진행하지 않는다.
4. 승인된 production target/계정/ACL을 별도 검토하고 모든 Function Secrets를 먼저 주입한다.
5. `api`, `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync`를 같은 source로 배포한다.
6. 잘못된 invoke secret, body/query, role, redirect/host, malformed key/target negative smoke를 먼저 통과한다.
7. API role/read smoke와 승인된 최소 positive smoke를 수행한 뒤 worker backlog/heartbeat를 확인한다.
8. Vault/`pg_cron`/`pg_net` worker 호출을 마지막에 활성화한다. 기존 reservation Cron은 교체 중 중복 실행하지 않는다.
9. worker별 연속 성공 heartbeat, overdue/dead-letter/operator-blocked 0과 최신 heartbeat를 확인한다.
10. Google Drive upload/purge, Sheets 121실 full resync/repair, 실제 기기 Web Push를 각각 별도 evidence로 남긴다.
11. production OpenAPI가 0.3.0 / 108 / 115인지 확인한 뒤 main-only `workflow_dispatch`로 읽기 전용 Swagger Pages를 배포하고 Edge와 parity를 대조한다.

## 6. Hosted smoke와 명시적 제외

필수 hosted smoke:

- health/OpenAPI/Swagger의 version·path·operationId parity와 read-only Pages 설정
- developer/admin/maid/inactive/invalid JWT 역할 차단, `must_change_password` gate, `no-store` 민감 응답
- developer database/runtime/scheduler status의 bounded projection과 secret 비노출
- 121 rooms / 0 reservations readback 및 기존 reservation Cron healthy 유지
- 각 worker의 잘못된 secret 401, 정확한 빈 본문 invocation, bounded heartbeat/backlog 상태
- 승인 fixture가 있을 때 Drive upload/read/purge, Sheets target/full-resync/repair, Web Push provider/device end-to-end

현재 production은 예약 0건이고 안전하게 되돌릴 수 있는 실제 업무 fixture가 없다. 따라서 예약·배정·
attempt·offline·제출·검수·earning/payroll·complaint·checkout incident의 성공 mutation과 guest PII read는
승인 fixture 없이는 실행하지 않고 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE` 또는
`SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION`으로 기록한다. Google Drive 삭제, PIN bootstrap/full resync,
실제 기기 push도 별도 대상·계정·데이터 승인 없이 성공으로 간주하지 않는다. skip은 PASS가 아니다.

## 7. 중단·rollback·forward-fix

- migration 실패 시 즉시 후속 적용을 중단하고 transaction rollback 여부와 기존 19개 원장을 확인한다.
- 적용된 migration과 migration history, audit/domain/earning/payment/PIN 원장은 rewind·삭제·repair하지 않는다.
  DB 결함은 새 Issue와 append-only forward-fix migration으로 해결한다.
- worker 오류, non-200 반복, stale heartbeat, operator-blocked가 발생하면 해당 Cron/Vault invocation을 먼저
  중지한다. 다른 정상 worker와 API를 무조건 함께 중지하지 않고 영향 범위를 분리한다.
- Edge 오류는 invoke를 중지한 뒤 schema 호환성을 확인한 승인 이전 bundle로만 되돌린다. 호환성이
  증명되지 않으면 이전 runtime을 강제로 올리지 않고 forward-fix한다.
- Drive/Sheets 자격증명 또는 ACL 노출은 worker 중지, credential 폐기·교체, ACL 회수 후 새 승인으로 복구한다.
  PIN/PII/secret을 조사 로그나 Issue에 복제하지 않는다.
- Pages 장애는 API를 rollback하지 않고 Pages deployment만 중단하거나 이전 안전 artifact로 복구한다.

## 8. Release blocker와 제외 범위

- #146은 PR #150으로 deterministic target identity와 full-first/incremental-first barrier를 추가해
  fresh reset 및 전체 concurrency 2회, required CI, 독립 QA를 통과하고 dev에 반영됐다.
- #147은 PR #149로 developer runtime의 expected migration head를 54번으로 맞추고 54=`equal`,
  53=`behind` 회귀와 required CI, 독립 QA를 통과해 dev에 반영됐다.
- #132의 informational push 문서 정합화는 이 release 계약에 포함하지만 코드/migration/OpenAPI를 바꾸지 않는다.
- #12 backup/recovery 자동화, #13 전체 frontend/generated client/browser E2E, #34 별도 CI 유지보수는 독립 범위다.
- 실제 운영 계정·OAuth/VAPID key·PIN 초기 숫자·spreadsheet ID/ACL·worker cadence는 이 문서에서 값을 확정하지 않는다.

## 9. Closure checklist

- [x] #133 source/dev 병합: PR #145, `dev@0411f04f2c4abd74b969f826365dc2d4b678b473`
- [x] release branch main ancestry 구성
- [x] OpenAPI source version 0.3.0, Pages expected 108/115 계약 작성
- [x] 54개 migration stable name/order/content SHA manifest 작성
- [x] #146 / #147 source/dev 완료
- [x] synthetic production baseline 19→54 누적 upgrade: v19의 38개 public/private base table·auth identity 보존, 121 rooms / 0 reservations, final head/RLS 검증 PASS
- [ ] release exact-head 전체 application/migration 재검증
- [ ] 독립 QA 90점 이상, P0/P1=0, required CI PASS
- [ ] `release/v0.3.0 → main` 승인·병합
- [ ] production backup/recovery evidence
- [ ] production migration 20~54 순차 적용과 Security Advisor
- [ ] 5개 Edge Function secrets/bundle/negative-positive smoke
- [ ] reservation/photo/notification/PIN Sheet Cron/Vault 및 연속 heartbeat
- [ ] 실제 Google Drive/Sheets와 기기 Web Push 결과·skip 분리 기록
- [ ] Swagger Pages main-only manual deploy와 0.3.0 / 108 / 115 parity
- [ ] hosted smoke와 rollback readiness 확인
- [ ] annotated tag/GitHub Release
