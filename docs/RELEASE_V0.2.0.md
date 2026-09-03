# v0.2.0 릴리즈·운영 활성화 정본

## 1. 승인 source와 현재 상태

- 개발 통합 source: `dev@2adb7a7de2474883d892232395295dcf643b20a4`
- v0.2.0 release 승격: `main@2a683fa`
- production 승인 source: `main@cd635b116f451a39481f496f2bd368776385a409`
- hotfix: PR #64 — hosted Supabase gateway의 zero-byte diagnostics POST 호환 수정
- 운영 상태 추적: Issue #24
- production migration: **19건**
- production Edge Functions:
  - `api` version 9 — ACTIVE
  - `reservation-scheduler` version 8 — ACTIVE
  - Function version은 secret 환경 revision에도 증가하므로 source identity는 승인 `main` SHA로 기록한다.
- production OpenAPI: **3.1 / version 0.2.0 / 39 paths / 43 operations**
- active developer/admin/maid: 각각 1명, 모두 `must_change_password=false`
- production rooms/reservations: **121 / 0**
- GitHub Pages Swagger: https://wrongstory.github.io/room-management-system-backend/
- `v0.2.0` annotated tag/GitHub Release: 아직 미발행

`main` source 승인, production 활성화, tag/Release 발행은 서로 다른 gate다. 이 문서는 실제
production readback과 hosted smoke를 기록하며 비밀번호, token, secret, actor UUID 또는 Vault
복호화 값을 포함하지 않는다.

## 2. 릴리즈 범위

포함:

- #42 Auth/Account Supabase Edge API와 한글 OpenAPI
- #43 developer operations Edge API와 scheduler projection
- #44 Python backend console Phase A source와 로컬 운영 smoke
- #49/#50 GitHub Pages 읽기 전용 Swagger portal
- #51 Availability Edge parity 6 operations
- #52 Reservation Edge parity 9 operations
- #53 Room detail/mutation Edge parity 8 operations
- #58 Actor Activity/Audit private ledger와 bounded developer projection
- PR #64 diagnostics zero-byte body hosted 호환 hotfix
- 관련 Fastify rollback parity, RLS, CAS, 멱등성, 동시성, redaction 회귀

제외:

- #25 이후 배정·현장 수행·사진·검수·정산·알림 기능
- Google Drive 실제 upload/purge worker
- #44 Phase B direct read-only DB 및 Phase C maintenance action catalog
- production 검증만을 위한 가짜 예약·가능일·객실 mutation

## 3. production DB·migration 결과

기존 17개 stable migration에 아래 2건을 append-only로 적용했다.

| 순서 | stable migration name | 결과 |
|---|---|---|
| 18 | `developer_operations_projections` | 적용·projection/RPC 권한 검증 완료 |
| 19 | `actor_activity_audit_contract` | 적용·audit/activity/aggregate 권한 검증 완료 |

최종 migration history는 19건이다. Git filename timestamp와 remote application version은 다를 수
있으므로 stable migration name과 실제 schema를 함께 대조한다. 기존 migration/history를 수정·재적용하거나
`supabase db push`, repair, down migration을 실행하지 않았다.

운영 검증:

- public base table RLS와 privileged RPC signature/grant 정상
- private activity 원장과 Vault raw 값의 anon/authenticated Data API 접근 차단
- audit/activity UPDATE/DELETE 차단 및 safe summary projection 유지
- Security Advisor의 신규 DB/RLS 차단사항 없음
- Free Plan의 `Leaked Password Protection Disabled` 경고는 알려진 플랫폼 제한으로 유지

## 4. Edge runtime·계정 hosted smoke

승인된 `main` source에서 `api`와 `reservation-scheduler`를 배포했다.

- health 200, OpenAPI 39 paths / 43 operations
- developer/admin/maid 모두 active, 최초 비밀번호 변경 완료
- developer `/auth/me`와 developer operations 200
- developer의 rooms/reservations/admin-only availability 접근 403
- business admin rooms 121, room detail 200, reservations list 200/0건
- admin availability read/candidates 200
- maid 본인 availability read 200
- maid rooms/reservations/admin-only availability 접근 403
- inactive/revoked/invalid JWT 차단 계약 유지
- PR #64 적용 후 developer diagnostics 200
- authorization denial activity aggregate와 domain audit readback PASS
- secret은 runtime-status의 configured boolean으로만 확인

Fastify는 Supabase-only production 채택 후에도 즉시 삭제하지 않고 rollback baseline으로 유지한다.

## 5. Scheduler·Vault·Cron 활성화

설정:

- scheduler actor: 기존 active business admin, configured/valid
- invoke secret: Function Secret과 Vault에 구성, 원문 비기록
- Vault: `scheduler_function_url`, `scheduler_invoke_secret` 각각 정확히 1개
- extensions: `pg_cron`, `pg_net` enabled
- job: `reservation-transition-every-minute` 정확히 1개
- cadence/active: `* * * * *` / true
- Cron command: URL·secret·service-role literal 없이 Vault runtime lookup만 사용

검증:

- 잘못된 scheduler secret → 401, RPC/heartbeat 없음
- 정상 수동 호출 → 200, transition 0
- 동일 `scheduledAt` replay → 200, logical receipt 1개, side effect 증가 없음
- activation gate에서 Cron 5회 연속 succeeded/HTTP 200/heartbeat succeeded 관찰
- 2026-09-03 readback: **1866/1866 Cron succeeded**, latest HTTP 200
- scheduler-status: `healthy`, actor valid, cron active, heartbeat 최근 5분 이내
- rooms 121 / reservations 0 유지
- pg_net response, Edge log, audit/activity에 scheduler secret 없음

## 6. Hosted mutation·PII release acceptance exceptions

production에 예약이 0건이고 안전하게 되돌릴 수 있는 mutation fixture가 없다. 검증을 위해 가짜
예약·가능일·객실 상태를 만들지 않는다는 release owner 결정을 적용한다.

| 범위 | 실제 결과 |
|---|---|
| Auth/Developer | positive/negative hosted smoke PASS |
| Availability | role/read hosted smoke PASS |
| Reservation | admin list 200/0건, developer/maid denial PASS |
| Room | admin list 121/detail 200, developer/maid denial PASS |
| DB/RLS/CAS/idempotency | exact-main CI와 production readback PASS |
| Availability/Reservation/Room success mutation | `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE` |
| Reservation PII/sensitive.read | `SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION` |

이 skip은 성공했다고 표현하지 않는다. 기능 source·DB/RLS/CAS/멱등성 회귀와 route/role read smoke는
통과했지만 production 성공 mutation은 실행하지 않은 상태다. 운영 데이터가 생긴 뒤 실제 업무 흐름에서
관찰하며, 실패가 확인되면 append-only forward-fix 대상으로 처리한다.

## 7. GitHub Pages Swagger 결과

- workflow: `swagger-pages`, `workflow_dispatch` 수동 실행
- run: https://github.com/wrongstory/room-management-system-backend/actions/runs/33718438975
- exact source: `main@cd635b116f451a39481f496f2bd368776385a409`
- `build-pages`: PASS
- `deploy-pages`: PASS
- public `index.html`, `openapi.json`, `portal-manifest.json`: HTTP 200
- snapshot: OpenAPI 3.1.x, version 0.2.0, 39 paths, 43 operations, `readOnly=true`
- production Edge와 Pages의 path set·operationId set 동일
- Pages OpenAPI server는 production Edge API base URL
- same-origin OpenAPI snapshot 사용
- Try it out·Authorization 입력 비활성, `persistAuthorization=false`
- token/service-role/secret 없음

Supabase hosted `/docs` route는 200이어도 기본 domain의 HTML 렌더링 제약이 있으므로 사람용 Swagger는
GitHub Pages를 사용한다. 실행 HTTP 계약의 최종 정본은 계속 production Edge `/openapi.json`이다.

## 8. 중단·rollback·forward-fix 기준

- Cron 오류, non-200 반복, heartbeat 실패 또는 예상 밖 업무 mutation이 발생하면
  `reservation-transition-every-minute`을 먼저 비활성화/unschedule한다.
- Edge 운영 장애는 Cron 중지 후 직전 Function bundle 또는 Fastify baseline으로 전환한다.
- production migration/history와 audit/domain 원장은 rewind하거나 삭제하지 않는다.
- DB 결함은 append-only forward-fix migration을 새 Issue/PR/독립 리뷰 대상으로 만든다.
- Pages 장애는 API runtime을 rollback하지 않고 Pages만 이전 artifact 또는 비활성 상태로 둔다.
- secret 노출이 의심되면 해당 secret을 즉시 폐기·교체하고 별도 보안 Issue로 추적한다.

## 9. release closure gate

- [x] v0.2.0 source `main` 승격
- [x] diagnostics hotfix #64 `main` 반영과 production `api` 배포
- [x] production migration 19건
- [x] `api`/`reservation-scheduler` ACTIVE와 hosted role smoke
- [x] scheduler manual/replay 및 Vault/pg_cron/pg_net 반복 실행 smoke
- [x] GitHub Pages deploy·public HTTP·39/43 parity smoke
- [x] release acceptance exceptions 기록
- [ ] 운영 활성화 docs-only PR required CI·독립 리뷰 P0/P1=0
- [ ] docs-only PR `main` 병합
- [ ] PR #65 `main` 병합 후 별도 backport PR로 다음 변경을 모두 `dev`에 역반영
  1. release PR #62의 Pages fail-closed 보강
  2. hotfix #64 diagnostics 수정
  3. PR #65의 최종 운영 활성화 문서
     - `docs/API_STATUS_MATRIX.md`
     - `docs/RELEASE_V0.2.0.md`
- [ ] backport 후 `dev`의 production snapshot이 `main`과 동일함을 확인
- [ ] backport PR required CI PASS
- [ ] Issue #24 최종 gate 완료
- [ ] `v0.2.0` annotated tag
- [ ] GitHub Release

Issue #24는 tag/Release 직전까지 Open으로 유지한다. 이 문서 PR은 코드, migration, API schema 또는
production runtime을 변경하지 않는다. 2026-09-03 비교에서 `main`에는 `dev@2adb7a7d`에 없는
release Pages 보강 5개 파일과 diagnostics hotfix 2개 파일이 확인됐다. PR #65가 `main`에 병합되면
이 두 변경뿐 아니라 위 최종 운영 활성화 문서 2개도 같은 별도 backport PR로 `dev`에 반영한다.
세 범위가 모두 반영되어 `dev`의 production snapshot이 `main`과 동일하고 required CI가 PASS하기
전에는 source 정합성 gate를 완료하거나 `v0.2.0` tag/GitHub Release를 발행하지 않는다.
