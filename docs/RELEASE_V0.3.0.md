# v0.3.0 릴리즈·운영 승격 계획

> 상태: #165 `main`·production 56번째 migration·`api` v16·네 template v7·Pages 109/117 반영 완료. 예약 success mutation과 tag/GitHub Release는 대기

이 문서는 Issue #148의 release gate와 운영 활성화 순서를 기록한다. v0.2.0의 과거 evidence는
[`RELEASE_V0.2.0.md`](./RELEASE_V0.2.0.md)에 그대로 보존하며 이 문서에서 소급 수정하지 않는다.

## 1. Source와 브랜치 gate

| 경계 | 승인 기준 | 현재 상태 |
|---|---|---|
| production/main source | `main@6604b2215e06b9e9ebf0b3138e3716a000c57ddb`, 56 migrations, OpenAPI 0.3.0 109/117 | #165 source·migration·`api` v16·template 게시 완료 |
| source/dev 기능 통합 | PR #167의 `dev@75983b3a0fb1bdc109fd57ca2a8c04bff2e4a925`, 56 migrations, OpenAPI 109/117 | 이후 문서 commit은 기능 기준을 바꾸지 않음 |
| hotfix | `hotfix/165-cleaning-template-duration-optional` | 독립 QA·required CI·main 병합·dev 역반영 완료 |
| 남은 release gate | Issue #148 | 예약 success mutation 결과, 제외 범위 정리, annotated tag/GitHub Release |

- `dev` 또는 `main`에 직접 push하지 않는다.
- release exact head에서 `application`과 `migration`, 독립 QA 90점 이상, P0/P1=0, 충돌 없음,
  migration manifest 일치를 확인한 뒤에만 main 승격을 요청한다.
- #165 배포는 승인된 backup/recovery와 운영 실행 순서를 거쳐 완료됐다. 이후 적용된 56번째 migration을 수정하거나 재적용하지 않는다.
- 추가 production 변경은 다시 별도 승인하며 Google/Push/PIN/Cron activation을 이번 완료 범위에 소급 포함하지 않는다.
- production smoke 완료 뒤에만 annotated `v0.3.0` tag와 GitHub Release를 발행한다.

## 2. 현재 production read-only 기준선

Issue #148/#152/#156/#165 후속 운영 적용 뒤 readback으로 확인한 현재 기준선이다.

| 항목 | 실제 read-only 결과 |
|---|---|
| stable migrations | 56, head `cleaning_template_duration_optional` |
| Edge Functions | 5 bundles: `api`, `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync` |
| `api` runtime | ACTIVE v16, source `main@6604b2215e06b9e9ebf0b3138e3716a000c57ddb` |
| OpenAPI | version 0.3.0, 109 paths / 117 operations |
| 객실 / 예약 | 121 / 0 |
| checkout template | 네 room type 각각 v7 exactly-one, 슬롯 10/11/13/15, `durationMinutes=null` |
| reservation Cron | healthy |

템플릿 미게시로 발생하던 `CLEANING_TEMPLATE_NOT_CONFIGURED` 구성 원인은 해소됐다. 다만 운영 예약은 0건이고
안전하게 되돌릴 fixture가 없어 예약 success mutation은 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`다.
provider·Google·Cron 활성화와 annotated `v0.3.0` tag/GitHub Release는 각각 별도 gate로 남는다.

## 3. Migration manifest와 적용 범위

정본은 [`migration-manifest.v0.3.0.json`](../supabase/migration-manifest.v0.3.0.json)이다.
각 SQL은 Git timestamp가 아닌 stable name, 정렬된 order, LF-normalized UTF-8 content SHA-256으로
고정한다. `npm run db:manifest:verify`는 전체 history 56개의 order/name/content SHA와 #165 배포 계획 당시의
baseline 55개, pending 1개, 최종 head `cleaning_template_duration_optional`을 검증한다. 당시 baseline head는
`cleaning_template_admin_api`이고 pending first/head는 모두 `cleaning_template_duration_optional`이었다.
원격 적용 version이 Git timestamp와 달라도 stable name과 실제 SQL 내용을 대조하며 자동 `db push`,
history repair, 재적용을 사용하지 않는다.

manifest의 1~56번 entry는 현재 모두 production에 적용된 history reference다. 별도
`test-production-baseline-upgrade.mjs`는 배포 전에 v0.2.0 synthetic baseline의 19→56 누적 호환성을, 전용 회귀는
55→56 template/reservation 원장 보존을 검증했다. 현재 이 릴리즈 manifest의 미적용 migration은 없다.

| 적용 순서 | stable migration name | production 상태 |
|---:|---|---|
| 56 | `cleaning_template_duration_optional` | production 적용 완료 |

운영 적용에서는 기존 55번 history/content를 먼저 재대조한 뒤 56번만 적용했다. 이후에는 56번을 수정·재적용하거나
history를 강제 보정하지 않는다. 추가 DB 보완은 새 append-only migration과 별도 승인으로 진행한다.

## 4. Edge Functions와 필수 설정

현재 production bundle inventory는 정확히 5개다. #156은 이 가운데 `api` bundle만 변경하며 새
Function이나 새 secret을 추가하지 않는다.

| Function | 역할 | 활성화 전제 |
|---|---|---|
| `api` | 109 paths / 117 operations 업무 API | 56번째 migration과 기존 API secrets |
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

## 5. Production 활성화 순서와 실행 결과

1. 승인된 release exact head와 manifest를 고정하고 production backup 및 recovery restore gate 뒤에만 적용을 진행했다.
2. 기존 55개 stable migration과 head를 read-only로 재대조한 뒤 56번 `cleaning_template_duration_optional`만 적용했다.
3. migration 적용 결과와 주요 함수·권한을 확인한 뒤에만 Edge 배포로 진행했다.
4. 독립 QA와 required CI를 통과한 #165 hotfix의 **병합 후 `main@6604b221...` exact source**에서 `api` bundle만 빌드·배포했다. 나머지 4개 bundle과 provider·Google·Cron 설정은 변경하지 않았다.
5. active business admin catalog read/publish와 선택형 duration 계약을 확인했고 raw secret·profile UUID를 결과에 남기지 않았다.
6. 게시 전 네 room type catalog가 unpublished임을 확인하고, 승인된 photo slot 값만 타입별 새 idempotency key와 현재 expected version으로 게시했다. duration은 미확정이므로 생략해 `null`로 보존했다.
7. 재조회 결과 `standard`, `premium`, `oceanPremium`, `oceanFamily`가 각각 current v7 exactly-one이며 슬롯 수 10/11/13/15, audit 4건, notification/outbox 0건임을 확인했다.
8. production OpenAPI 0.3.0 / 109 / 117, duration 생략·`null` 요청과 조회의 `null` 보존을 확인했다.
9. 예약 0건이고 안전하게 되돌릴 fixture가 없어 예약 성공과 planned checkout target snapshot은 실행하지 않았다. `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`이며 PASS가 아니다.
10. 별도 승인된 main-only `workflow_dispatch` run `35051144073`으로 읽기 전용 Swagger Pages를 배포하고 production Edge와 path·operationId parity를 확인했다. Pages manifest SHA-256은 배포된 `openapi.json` artifact와 일치한다.

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

Swagger Pages artifact는 별도 승인된 main-only workflow run `35051144073`에서 재배포했다. 공개 index,
`openapi.json`, `portal-manifest.json`은 모두 200이며 production Edge와 0.3.0 / 109 / 117 및
path·operationId set이 일치한다. manifest SHA-256은 공개 Pages `openapi.json` artifact와 일치하며,
build 시각 metadata 때문에 raw production JSON과 artifact byte hash가 같다는 의미는 아니다.

현재 production은 예약 0건이고 안전하게 되돌릴 수 있는 실제 업무 fixture가 없다. 따라서 예약·배정·
attempt·offline·제출·검수·earning/payroll·complaint·checkout incident의 성공 mutation과 guest PII read는
승인 fixture 없이는 실행하지 않고 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE` 또는
`SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION`으로 기록한다. Google Drive 삭제, PIN bootstrap/full resync,
실제 기기 push도 별도 대상·계정·데이터 승인 없이 성공으로 간주하지 않는다. skip은 PASS가 아니다.

## 7. 중단·rollback·forward-fix

- 이후 새 append-only migration이 실패하면 즉시 후속 적용을 중단하고 transaction rollback 여부와 현재 56개 원장을 확인한다.
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

production 변경은 별도 승인된 backup/recovery gate 뒤에 진행됐다. 아래 evidence 항목의 미완료 표시는 gate를
건너뛰었다는 뜻이 아니라, Issue #148에서 다시 확인할 수 있는 영구 backup/restore artifact reference가 아직
이 문서에 연결되지 않았다는 뜻이다.

- [x] #156/#158/#162 source/dev 병합: `dev@ab10249aaf1d671419389615ad8a22984c9849ac`
- [x] #156 release를 production 55번/API에 반영
- [x] OpenAPI source version 0.3.0, Pages expected 109/117 계약 작성
- [x] 56개 migration stable name/order/content SHA manifest 작성
- [x] #132 / #146 / #147 문서·fixture 계약 보존
- [x] synthetic production baseline 19→56 누적 upgrade와 55→56 template/reservation 원장 보존 회귀 작성
- [x] #156 release exact-head 전체 application/migration 재검증
- [x] #165 독립 QA 90점 이상, P0/P1=0, required CI PASS
- [x] `hotfix/165-cleaning-template-duration-optional → main` 승인·병합 — `main@6604b2215e06b9e9ebf0b3138e3716a000c57ddb`
- [ ] production backup/recovery evidence
- [x] production migration 55와 #156 `api` bundle 반영
- [x] production migration 56 1건 적용과 `api` ACTIVE v16 재배포
- [x] 네 room type checkout template v7 게시와 exactly-one 확인 — `durationMinutes=null`
- [x] 예약 mutation을 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`로 명시; PASS로 표현하지 않음
- [ ] provider/Google/Cron 활성화는 별도 Issue evidence와 분리
- [x] Swagger Pages main-only manual deploy와 0.3.0 / 109 / 117 parity — run `35051144073`
- [x] production health/OpenAPI와 template hosted read/publish smoke 확인
- [ ] annotated tag/GitHub Release
