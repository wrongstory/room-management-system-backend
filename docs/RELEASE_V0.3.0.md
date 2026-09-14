# v0.3.0 릴리즈·운영 승격 계획

> 상태: #156 source/dev 완료, 추가 release 준비 중, production 55번째 migration/API 미승격

이 문서는 Issue #148의 release gate와 운영 활성화 순서를 기록한다. v0.2.0의 과거 evidence는
[`RELEASE_V0.2.0.md`](./RELEASE_V0.2.0.md)에 그대로 보존하며 이 문서에서 소급 수정하지 않는다.

## 1. Source와 브랜치 gate

| 경계 | 승인 기준 | 현재 상태 |
|---|---|---|
| production/main | `main@e3397e00e5538871d80610c9f0c7ab88535d7be0`, 54 migrations, OpenAPI 0.3.0 108/115 | #148/#152 source·bundle 반영, annotated tag/Release pending |
| source/dev | `dev@ab10249aaf1d671419389615ad8a22984c9849ac`, 55 migrations, OpenAPI source 109/117 | #156/#158 및 #162 KST boundary fixture 완료 |
| release | `release/v0.3.0`, 위 main과 dev를 no-ff 통합하고 release 계약만 추가 | 준비 중 |
| target | `release/v0.3.0 → main` | 새 승인 PR pending |

- `dev` 또는 `main`에 직접 push하지 않는다.
- release exact head에서 `application`과 `migration`, 독립 QA 90점 이상, P0/P1=0, 충돌 없음,
  migration manifest 일치를 확인한 뒤에만 main 승격을 요청한다.
- main 병합 전에는 production 55번째 migration, Edge, 운영 템플릿, Cron/Vault, Pages를 변경하지 않는다.
- main 병합 뒤에도 backup/recovery evidence와 운영 승인 없이는 production을 변경하지 않는다.
- production smoke 완료 뒤에만 annotated `v0.3.0` tag와 GitHub Release를 발행한다.

## 2. 현재 production read-only 기준선

Issue #148/#152 완료 뒤 운영 환경을 변경하지 않는 readback으로 확인한 현재 기준선이다.

| 항목 | 실제 read-only 결과 |
|---|---|
| stable migrations | 54, head `checkout_not_completed_incident_workflow` |
| Edge Functions | 5 bundles: `api`, `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync` |
| OpenAPI | version 0.3.0, 108 paths / 115 operations |
| 객실 / 예약 | 121 / 0 |
| reservation Cron | healthy |

이 값은 #156이 배포됐거나 운영 예약 차단이 해소됐다는 뜻이 아니다. 현재 production에는
55번째 migration과 `GET·POST /v1/cleaning-templates` 1 path / 2 operations가 없으며,
provider·Google·Cron 활성화와 annotated `v0.3.0` tag/GitHub Release도 별도 gate로 남는다.

## 3. Migration manifest와 적용 범위

정본은 [`migration-manifest.v0.3.0.json`](../supabase/migration-manifest.v0.3.0.json)이다.
각 SQL은 Git timestamp가 아닌 stable name, 정렬된 order, LF-normalized UTF-8 content SHA-256으로
고정한다. `npm run db:manifest:verify`는 전체 history 55개의 order/name/content SHA와 이번 deployment
baseline 54개, pending 1개, 최종 head `cleaning_template_admin_api`를 검증한다. baseline head는
`checkout_not_completed_incident_workflow`이고 pending first/head는 모두 `cleaning_template_admin_api`다.
원격 적용 version이 Git timestamp와 달라도 stable name과 실제 SQL 내용을 대조하며 자동 `db push`,
history repair, 재적용을 사용하지 않는다.

manifest의 1~54번 entry는 이미 배포된 전체 history reference이며 이번 적용 범위가 아니다. 별도
`test-production-baseline-upgrade.mjs`만 v0.2.0 synthetic baseline의 19→55 누적 호환성을 검증한다.
운영 적용 대상은 다음 **55번 1건만**이다.

| 적용 순서 | stable migration name | production 상태 |
|---:|---|---|
| 55 | `cleaning_template_admin_api` | pending |

현재 54번 history/content를 먼저 재대조한 뒤 55번만 적용한다. 실패하면 다음 단계로 진행하지 않는다.
55번 적용 뒤 manifest head, RLS/FORCE RLS, service-role-only RPC grant, Security Advisor와 별도
19→55 누적 upgrade evidence를 다시 확인한다.

## 4. Edge Functions와 필수 설정

현재 production bundle inventory는 정확히 5개다. #156은 이 가운데 `api` bundle만 변경하며 새
Function이나 새 secret을 추가하지 않는다.

| Function | 역할 | 활성화 전제 |
|---|---|---|
| `api` | 109 paths / 117 operations 업무 API | 55번째 migration과 기존 API secrets |
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
2. 현재 54개 stable migration과 head를 read-only로 재대조한 뒤 55번 `cleaning_template_admin_api`만 적용한다.
3. migration history, RLS/grant, critical RPC, Security Advisor를 확인한다. 실패 시 Edge 배포로 진행하지 않는다.
4. #156 exact release source의 `api` bundle만 배포한다. 나머지 4개 bundle과 provider·Google·Cron 설정은 이 변경 때문에 재배포하거나 활성화하지 않는다.
5. active business admin의 positive catalog read와 developer/maid/inactive/temp-password/revoked-session 권한 negative smoke, 잘못된 body/query 차단을 구분해 확인한다.
6. `standard`, `premium`, `oceanPremium`, `oceanFamily` 네 room type의 checkout catalog를 읽고 모두 unpublished임을 확인한다.
7. 운영 책임자가 승인한 duration/photo slot 값만 한 타입씩 새 idempotency key와 현재 expected version으로 게시한다. migration seed, 빈 template, fallback, 임의 추정값을 사용하지 않는다.
8. 네 타입이 각각 current published version exactly-one인지 재조회하고, 동일 key replay·stale version·key reuse conflict를 확인한다.
9. 승인된 되돌릴 수 있는 예약 fixture가 있을 때만 게시 전 `CLEANING_TEMPLATE_NOT_CONFIGURED` 409, 게시 후 예약 성공과 planned checkout target snapshot을 확인한다. fixture가 없으면 skip 사유를 남기며 PASS로 쓰지 않는다.
10. production OpenAPI가 0.3.0 / 109 / 117인지 확인한다. main-only `workflow_dispatch`의 읽기 전용 Swagger Pages 배포와 parity 대조는 별도 운영 승인을 받은 경우에만 수행하며 이번 source 승격만으로 실행하지 않는다.

## 6. Hosted smoke와 명시적 제외

필수 hosted smoke:

- production health/OpenAPI/runtime Swagger의 version·path·operationId 0.3.0·109/117 parity
- active business admin의 checkout template 조회·게시와 developer/maid/inactive/temp-password/revoked-session
  차단, immutable version/CAS/idempotency, raw slot/audit 비노출
- 기존 scheduler healthy, 121 rooms / 0 reservations와 rooms/reservations read-only 응답 안정성

기존 worker evidence는 유지 여부만 확인하고 이번 #156 증분 smoke에서 다시 실행하지 않는다.
`photo-purge`, `notification-delivery`, `room-pin-sheet-sync` invoke, Drive/Sheets/Web Push provider 호출,
PIN/photo mutation과 새 Cron 생성·변경·실행은 각각 별도 승인 gate이며 이번 release source 검증 범위가 아니다.
기존 bounded status/heartbeat 증거를 참조하되 재실행하지 않은 항목을 PASS로 새로 기록하지 않는다.

Swagger Pages artifact build/deploy와 Edge parity는 별도 승인 optional gate다. 이번 필수 hosted smoke나
source 승격만으로 Pages를 배포하지 않으며, 미실행 상태를 PASS로 기록하지 않는다.

현재 production은 예약 0건이고 안전하게 되돌릴 수 있는 실제 업무 fixture가 없다. 따라서 예약·배정·
attempt·offline·제출·검수·earning/payroll·complaint·checkout incident의 성공 mutation과 guest PII read는
승인 fixture 없이는 실행하지 않고 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE` 또는
`SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION`으로 기록한다. Google Drive 삭제, PIN bootstrap/full resync,
실제 기기 push도 별도 대상·계정·데이터 승인 없이 성공으로 간주하지 않는다. skip은 PASS가 아니다.

## 7. 중단·rollback·forward-fix

- migration 실패 시 즉시 후속 적용을 중단하고 transaction rollback 여부와 기존 54개 원장을 확인한다.
- 적용된 migration과 migration history, audit/domain/earning/payment/PIN 원장은 rewind·삭제·repair하지 않는다.
  DB 결함은 새 Issue와 append-only forward-fix migration으로 해결한다.
- worker 오류, non-200 반복, stale heartbeat, operator-blocked가 발생하면 해당 Cron/Vault invocation을 먼저
  중지한다. 다른 정상 worker와 API를 무조건 함께 중지하지 않고 영향 범위를 분리한다.
- Edge 오류는 invoke를 중지한 뒤 schema 호환성을 확인한 승인 이전 bundle로만 되돌린다. 호환성이
  증명되지 않으면 이전 runtime을 강제로 올리지 않고 forward-fix한다.
- Drive/Sheets 자격증명 또는 ACL 노출은 worker 중지, credential 폐기·교체, ACL 회수 후 새 승인으로 복구한다.
  PIN/PII/secret을 조사 로그나 Issue에 복제하지 않는다.
- Pages 장애는 API를 rollback하지 않고 Pages deployment만 중단하거나 이전 안전 artifact로 복구한다.
- #156 게시값 rollback은 row 수정·삭제나 과거 version 재활성화가 아니다. 직전 승인 내용을 검토해 새
  immutable version으로 다시 게시하며 이미 생성된 planned target snapshot은 바꾸지 않는다.

## 8. Release blocker와 제외 범위

- #146은 PR #150으로 deterministic target identity와 full-first/incremental-first barrier를 추가해
  fresh reset 및 전체 concurrency 2회, required CI, 독립 QA를 통과하고 dev에 반영됐다.
- #147은 PR #149로 당시 developer runtime head를 54번에 맞췄고, #156이 이를 append-only 55번
  `cleaning_template_admin_api`로 전진시켰다. runtime과 DB drift는 stable name으로 판정한다.
- #156은 PR #157과 후속 #158 정합화로 `dev@ab10249aaf1d671419389615ad8a22984c9849ac`에
  통합됐다. checkout template만 지원하며 네 room type의 값을 seed/fallback 없이 명시적으로 게시하기
  전에는 production 예약 409가 해소됐다고 선언하지 않는다.
- #162는 PR #163으로 자정 경계 checkout/complaint fixture를 고정했으며 production runtime·migration을
  변경하지 않는다.
- #132의 informational push 문서 정합화는 이 release 계약에 포함하지만 코드/migration/OpenAPI를 바꾸지 않는다.
- #12 backup/recovery 자동화, #13 전체 frontend/generated client/browser E2E, #34 별도 CI 유지보수는 독립 범위다.
- 실제 운영 계정·OAuth/VAPID key·PIN 초기 숫자·spreadsheet ID/ACL·worker cadence는 이 문서에서 값을 확정하지 않는다.

## 9. Closure checklist

- [x] #156/#158/#162 source/dev 병합: `dev@ab10249aaf1d671419389615ad8a22984c9849ac`
- [x] release branch에 `main@e3397e00e5538871d80610c9f0c7ab88535d7be0`과 dev ancestry 통합
- [x] OpenAPI source version 0.3.0, Pages expected 109/117 계약 작성
- [x] 55개 migration stable name/order/content SHA manifest 작성
- [x] #132 / #146 / #147 문서·fixture 계약 보존
- [x] synthetic production baseline 19→55 누적 upgrade: v19 원장·auth identity, 121 rooms / 0 reservations, final head/RLS 재검증
- [x] release exact-head 전체 application/migration 재검증
- [ ] 독립 QA 90점 이상, P0/P1=0, required CI PASS
- [ ] `release/v0.3.0 → main` 승인·병합
- [ ] production backup/recovery evidence
- [ ] production migration 55 1건 적용과 Security Advisor
- [ ] #156 `api` bundle 및 admin negative/positive smoke
- [ ] 네 room type checkout template 승인값 게시와 exactly-one 확인
- [ ] 승인 fixture 기반 reservation 409→success/snapshot smoke 또는 명시적 skip
- [ ] provider/Google/Cron 활성화는 별도 Issue evidence와 분리
- [ ] Swagger Pages main-only manual deploy와 0.3.0 / 109 / 117 parity
- [ ] hosted smoke와 rollback readiness 확인
- [ ] annotated tag/GitHub Release
