# API 구현·Edge 배포·운영 사용 상태 정본

이 문서는 백엔드 API의 **개발 완료 여부**, **Supabase Edge 이식 여부**, **production 배포 여부**, **현재 실제 사용 가능 여부**를 한 곳에서 추적하는 정본이다.

API/DB/Edge 관련 PR은 상태가 바뀌면 반드시 이 문서를 같은 PR에서 갱신한다. Fastify 코드나 DB RPC가 존재한다는 이유만으로 production에서 사용할 수 있다고 표시하지 않는다.

> 정본 효력: 이 파일이 `dev`에 병합된 이후부터 API 상태 판단의 우선 정본으로 사용한다. production 상태는 Git branch가 아니라 Supabase Edge Function readback과 hosted HTTP smoke를 우선한다.

## 1. 상태 판정 규칙

| 표시 | 의미 |
|---|---|
| ✅ | 해당 단계 완료 및 검증됨 |
| 🟡 | 소스는 완료됐으나 아직 상위 브랜치 승격 또는 production 반영 전 |
| ⚠️ | 배포는 됐지만 smoke/계정/secret/runtime 또는 클라이언트 사용 조건이 남음 |
| ⛔ | 의도적으로 fail-closed / 비활성 상태 |
| ❌ | 해당 단계 미구현 또는 미배포 |
| — | 해당 단계가 필요하지 않음 |

각 열의 의미:

- **DB/RPC**: 필요한 table/RLS/RPC/command 계약이 Git source와 검증에 존재하는가.
- **Fastify HTTP**: 기존 Fastify adapter에 HTTP endpoint가 존재하는가.
- **Edge source**: `supabase/functions/api` 또는 별도 Edge Function에 동일 업무 계약이 이식됐는가.
- **Production Edge**: 승인된 `main` source가 운영 Supabase Edge runtime에 실제 배포됐는가.
- **현재 사용**: hosted runtime에서 필요한 role/account/secret/smoke까지 만족해 실제 클라이언트가 사용할 수 있는가.

### Edge 배포의 의미

Git에 TypeScript 코드가 있거나 DB RPC가 존재하는 것만으로는 Edge 배포가 아니다.

이 프로젝트에서 Edge 배포는 승인된 `main`의 Deno Function source를 운영 Supabase 프로젝트의 Edge runtime에 업로드해 실제 `/functions/v1/...` URL에서 실행되도록 만드는 작업이다.

현재 구조는 endpoint마다 Function을 따로 만들지 않는다.

```text
/functions/v1/api
  ├─ /health
  ├─ /openapi.json
  ├─ /docs
  ├─ /v1/auth/*
  ├─ /v1/accounts/*
  ├─ /v1/developer/*
  ├─ /v1/rooms/*
  ├─ /v1/availability/*
  ├─ /v1/reservations/*
  ├─ /v1/payroll
  ├─ /v1/payroll/entries
  ├─ /v1/payroll/start
  ├─ /v1/complaints
  ├─ /v1/complaints/{complaintId}/*
  ├─ /v1/notifications
  ├─ /v1/push-subscriptions/*
  ├─ /v1/attempts/*/submissions
  └─ /v1/inspections/*

/functions/v1/reservation-scheduler
  └─ scheduler 전용 POST

/functions/v1/photo-purge                 # source/dev, production 미승격
  └─ 사진 purge worker 전용 POST

/functions/v1/notification-delivery       # source/dev, production 미승격
  └─ Web Push delivery worker 전용 POST
```

따라서 메이드 API를 추가한다고 `maid` Function을 새로 만드는 것이 아니라 기존 `api` Function에 route/adapter를 추가하고 다시 배포한다.

## 2. 현재 기준 스냅샷

production 최종 확인: **2026-09-03 KST** (아래 기존 운영 evidence). 개발 통합 기준 갱신: **2026-09-12 KST**. 이번 개발에서 운영을 재검증하거나 변경하지 않았다.

- 현재 GitHub 운영 릴리즈 정본: `main@035f3b2f3b4a88340e70ef6dc1d6e6a3def8231b`
  - v0.2.0 통합 source 승격: `main@2a683fa`
  - production Edge 배포 bundle source: diagnostics zero-byte hosted 호환 hotfix PR #64 / `main@cd635b116f451a39481f496f2bd368776385a409`
- 이 문서 갱신의 integration base: `dev@569bbb62e07a484fe2f6aa67520d6f10797e44f5`; 기능 snapshot은 **45 migrations / 98 paths / 105 operations**다. #112 VAPID/provider HTTP source gate는 승인 exact head `eb243c54ebf24cd932d70cb1c6423fa4f319c050`에서 required CI와 독립 QA를 통과하고 PR #119로 `dev@dfc98b1474f9f890851d49bd904869181d0d7880`에 병합됐으며, PR #122의 상태 문서와 #124의 pgTAP fixture 안정화를 이 base가 포함한다. Issue #112는 hosted 활성화 완료까지 OPEN이며 main/recovery/production은 변경하지 않았다.
- 개발 통합 기능 기준: #25~#31, #4, #7A/B/C, #83/#84/#85 및 #93/#95/#96 source/dev 완료, production 미승격
- #85는 PR #90으로 source/dev 병합 완료했다. accepted/orphan/folder purge worker와 45초 absolute deadline, blocked false-green 방지 계약은 개발 정본에 있으며 production Google/Cron hosted 검증은 별도 release gate다.
- #31은 PR #91로 source/dev 병합 완료했다. 당시 개발 정본은 **34 migrations / 74 paths / 80 operations**이며 전체 제출·폭탄방 신고/선판정·관리자 검수·반려 재청소의 Fastify/Edge source와 OpenAPI를 포함한다. production 배포·현재 사용은 아직 ❌이다.
- #93/#95는 PR #95로 source/dev 병합 완료했다. 개발 통합 계약은 **35 migrations / 76 paths / 82 operations**이며 conceptual OPEN 조회, OPEN→PAYING 잠금과 4개 payroll table의 active+비밀번호 변경 완료+admin/maid-self RLS를 포함한다.
- #96은 PR #97로 source/dev 병합 완료했다. bounded keyset pagination과 signed cursor, nested preview/continuation, 128 KiB 응답 상한을 포함한 개발 통합 계약은 **36 migrations / 77 paths / 83 operations**이다. Python developer 콘솔 16 operations는 유지하며 production에는 아직 승격하지 않았다.
- #94는 2026-09-10 Decision Issue로 정책 승인됐다. #100~#103은 각각 PR #104/#105/#106/#107로 **source/dev 병합 완료**했다. #108은 PR #108, #109는 PR #114, #110은 PR #115, #111은 PR #116, #112는 PR #119로 source/dev 병합 완료했고 #117 concurrency 회귀도 통합됐다. 현재 dev는 **45 migrations / 98 paths / 105 operations**다. Issue #112의 hosted 활성화는 pending이며 main/recovery/production은 변경하지 않았다.
- #69 승인 PIN 계약은 프런트가 선행 0을 보존한 4~8자리 숫자 부분만 보내고, 서버가 현재 `rooms.room_number`로 `<room_number>-<pin_digits>` canonical credential을 조합해 private encrypted immutable revision/current pointer에 저장하는 방식이다. Phase A source는 아직 미구현이며 PIN 평문·암호문을 public table, audit, outbox, URL, error, 로그에 저장하지 않는다.
- 다음 source critical path는 **#73 → #34 → #46 → #69 Phase A**다. #12 backup/recovery는 병행 가능하되 실제 production/recovery 실행은 별도 승인이고, #13 전체 frontend/generated client/browser E2E는 release와 프런트 정본 대조 뒤 진행한다.
- 운영 migration: **19건** (`developer_operations_projections`, `actor_activity_audit_contract` 포함)
- 운영 Edge Functions readback:
  - `api` version 9 — ACTIVE, 배포 source는 위 `main@cd635b1` bundle 기준
  - `reservation-scheduler` version 8 — ACTIVE, 배포 source는 위 `main@cd635b1` bundle 기준
  - version 증가는 source 변경 외 Function Secret 환경 revision도 포함하므로 source identity로 사용하지 않는다.
- production OpenAPI: **39 paths / 43 operations**, version `0.2.0`
- active 계정 readback: developer/admin/maid 각각 1명, 모두 `must_change_password=false`
- developer/admin/maid hosted role smoke와 diagnostics: PASS
- 객실 121건, 예약 0건. 예약 고객명 대상이 없어 PII 상세 smoke는
  `SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION`이다.
- Availability/Reservation/Room의 안전한 read 및 role denial smoke는 PASS다. 운영 데이터를
  만들거나 바꾸는 성공 mutation smoke는
  `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`로 v0.2.0 release acceptance
  exception을 적용한다.
- scheduler actor/invoke secret과 Vault 2개 항목이 구성됐고 `pg_cron`/`pg_net`이 활성화됐다.
  job `reservation-transition-every-minute`은 `* * * * *` cadence로 active이며,
  활성화 gate에서 5회를 관찰했다. 2026-09-03 readback은 **1866/1866 succeeded**,
  latest HTTP 200, heartbeat succeeded, transition 0, scheduler state `healthy`다.
- GitHub Pages 읽기 전용 Swagger 포털은 workflow run `33718438975`에서 exact
  `main@cd635b1`을 배포했다. 공개 portal/OpenAPI/manifest HTTP smoke와 production Edge
  OpenAPI path·operationId 집합 비교가 PASS했다.
- v0.2.0의 Pages fail-closed 보강, diagnostics hotfix, 최종 운영 활성화 문서는 tag 전에
  `dev`로 역반영됐다. 이후 `dev`의 #25/#26 assignment source는 다음 release 대상이며
  production에 아직 적용하지 않는다.
- production `/docs`는 HTTP 200이지만 hosted 기본 domain의 HTML 렌더링 제약 때문에
  사람용 문서는 GitHub Pages 포털을 사용한다.

## 3. System / 문서 API

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /health` | public | — | ✅ | ✅ | ✅ | ✅ | production HTTP 200 확인 |
| [x] | `GET /openapi.json` | public | — | — | ✅ | ✅ | ✅ | production HTTP 계약 정본 |
| [ ] | `GET /docs` | public | — | — | ✅ | ✅ | ⚠️ | route/200은 존재. hosted domain 브라우저 Swagger UI 사용 제한 |
| [x] | GitHub Pages Swagger portal | public read-only | — | — | — | — | ✅ | https://wrongstory.github.io/room-management-system-backend/ 공개 smoke PASS |

GitHub Pages 포털은 Supabase Edge Function이 아닌 별도 정적 배포다. 따라서 위 행의 `Edge source`와 `Production Edge`는 `—`로 두고, source 완료와 production Pages 배포 완료를 비고와 아래 배포 gate에서 구분한다.

### GitHub Pages Swagger 배포 gate — #49 / PR #50

- [x] 읽기 전용 portal source·build 검증 완료
- [x] SSRF 경계, CSP/SRI, Try-it-out·Authorization 차단, Pages 최소 권한 독립 리뷰 완료
- [x] 승인된 source의 `main@cd635b116f451a39481f496f2bd368776385a409` 승격
- [x] production Edge OpenAPI 39 paths / 43 operations 확인
- [x] GitHub Pages `workflow_dispatch` 수동 실행 — run `33718438975`
- [x] 공개 portal과 same-origin OpenAPI snapshot HTTP smoke
- [x] Pages와 production Edge의 path set·operationId set 동일

## 4. Auth API

developer/admin/maid의 실제 hosted login과 role 경계를 검증했다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/auth/login` | all accounts | ✅ | ✅ | ✅ | ✅ | ✅ | developer/admin/maid hosted login PASS |
| [x] | `GET /v1/auth/me` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | 최신 role/session hosted smoke PASS |
| [x] | `POST /v1/auth/password` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | 최초 비밀번호 변경 PASS; timeout retry 의미는 후속 #46 |

## 5. 계정 관리 API

Edge와 DB 계약은 production에 배포됐고 Python 운영도구를 통해 business admin/maid를 생성해
hosted account 경계를 확인했다. 운영에 불필요한 추가 상태변경·초기화는 실행하지 않았다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | developer hosted read PASS |
| [x] | `POST /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | business admin/maid 운영 계정 생성 경로 확인 |
| [ ] | `PATCH /v1/accounts/{profileId}/role` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production success mutation 미실행; developer 생성/승격 금지 계약 유지 |
| [ ] | `PATCH /v1/accounts/{profileId}/status` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production success mutation 미실행; 마지막 active admin 보호 계약 유지 |
| [ ] | `POST /v1/accounts/{profileId}/unlock` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | 잠긴 운영 fixture 없음; developer 대상 금지 계약 유지 |
| [ ] | `POST /v1/accounts/{profileId}/password-reset` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | 불필요한 운영 reset 미실행; developer는 self-change만 허용 |

## 6. Developer 운영 API — #43 / PR #48

PR #48/#59 source와 hotfix #64가 승인된 `main` 및 production에 반영됐다. developer hosted
login 이후 같은 메모리 세션에서 전체 projection·diagnostics·업무 권한 거부를 검증했다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/developer/overview` | developer only | ✅ | — | ✅ | ✅ | ✅ | hosted 200 |
| [x] | `GET /v1/developer/runtime-status` | developer only | — | — | ✅ | ✅ | ✅ | production target 일치, secret은 configured boolean만 |
| [x] | `GET /v1/developer/database-status` | developer only | ✅ | — | ✅ | ✅ | ✅ | migration 19, drift/RLS/RPC 정상 |
| [x] | `GET /v1/developer/scheduler-status` | developer only | ✅ | — | ✅ | ✅ | ✅ | `healthy`, raw Cron/Vault/net body 비노출 |
| [x] | `GET /v1/developer/audit-events` | developer only | ✅ | — | ✅ | ✅ | ✅ | 승인된 domain summary만 반환 |
| [x] | `GET /v1/developer/activity-events` | developer only | ✅ | — | ✅ | ✅ | ✅ | 권한 거부 aggregate hosted readback PASS |
| [x] | `POST /v1/developer/diagnostics` | developer only | ✅ | — | ✅ | ✅ | ✅ | PR #64 zero-byte hosted hotfix 후 200 |

### #43 production 반영 조건

- [x] PR #48 `dev` 병합
- [x] parity 작업 #51/#52/#53과 release scope 확정
- [x] `release/v0.2.0 → main` source 승격
- [x] `developer_operations_projections` migration 1회 적용
- [x] production `api` 재배포
- [x] production `reservation-scheduler` 재배포 — heartbeat source 포함
- [x] developer / admin / maid 권한 smoke
- [x] redaction / migration drift / critical RPC production smoke

### #58 Actor Activity / Audit source gate

- [x] 성공한 account/availability/reservation/room/scheduler mutation audit event inventory
- [x] immutable `audit_events`의 승인된 domain event projection 확장
- [x] private activity event + unknown-login/authorization-denial bounded aggregate 원장
- [x] login success/known failure/authorization denial 기록과 민감조회 공통 helper
- [x] developer-only 31일/100건/cursor activity API와 OpenAPI/Python 화면 분리
- [x] raw table 및 privileged RPC의 PUBLIC/anon/authenticated 접근 차단
- [x] fresh DB/RLS/Edge/Python 로컬 회귀 검증
- [x] PR #59 독립 보안/API 재검토 P0/P1=0
- [x] PR #59 `dev@4c897fa7eceea6cb128c2e0d201569b71b236b25` 병합
- [x] release/main 승격 후 migration 적용·production Edge 재배포·hosted role smoke
- [x] production activity/audit readback 및 bounded authorization denial aggregate 확인

## 7. 객실 API — Edge parity #53 (P1)

목록·상세·관리자 mutation source가 production Edge에 배포됐다. 안전한 목록/상세와 role denial은
hosted PASS이며 성공 mutation은 release acceptance exception을 적용한다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms` | admin | ✅ | ✅ | ✅ | ✅ | ✅ | admin 121, developer/maid 403 |
| [x] | `GET /v1/rooms/{roomId}` | admin | ✅ | ✅ | ✅ | ✅ | ✅ | 안전한 production 상세 200 |
| [ ] | `PATCH /v1/rooms/{roomId}/master-data` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks/{blockId}/release` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/candles` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/issues` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/issues/{issueId}/resolve` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/rooms/{roomId}/pin-sync-events` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | PIN 원문 비수용; success mutation hosted smoke release exception |

### #53 source gate

- [x] 기존 Fastify와 동일한 8개 operation·camelCase projection·stable error code
- [x] exact active business admin + password changed + active session 경계
- [x] 기존 객실 RPC의 CAS·scoped Idempotency-Key·request hash·감사 계약 재사용
- [x] 생성 entity ID를 request hash에서 제외하고 동시 동일 명령을 단일 logical event로 수렴
- [x] 연락처 설명 차단 및 PIN 원문·credential·provider secret 입력/응답 비노출
- [x] #58 `edge.authorization.rooms` 권한 거부 aggregate와 domain audit projection 재사용
- [x] OpenAPI/Swagger 한글 계약과 Edge 단위·동시성 회귀 추가
- [x] Issue #53 구현 PR #61 독립 보안/API 재검토 P0/P1=0
- [x] Issue #53 구현 PR #61 `dev` 병합 — `dev@2adb7a7de2474883d892232395295dcf643b20a4`
- [x] `release → main` 후 production `api` 재배포
- [x] hosted admin 목록/상세 및 developer/maid denial smoke
- [x] 배포 OpenAPI 및 Pages snapshot 갱신
- [ ] 성공 mutation hosted smoke — `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`

## 8. 메이드 주간 가능일 API — Edge parity #51 (P0)

#51은 새 도메인 개발이 아니라 #6 DB/Fastify 계약의 Edge HTTP parity다. production Edge 배포,
maid/admin/developer read·role smoke와 Pages snapshot을 완료했다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/availability?weekStart=...` | maid / admin | ✅ | ✅ | ✅ | ✅ | ✅ | maid self/admin hosted read PASS |
| [ ] | `POST /v1/availability/submissions` | maid | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/availability/change-requests` | maid | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [x] | `GET /v1/availability/change-requests` | maid / admin | ✅ | ✅ | ✅ | ✅ | ✅ | role/read hosted smoke PASS |
| [ ] | `POST /v1/availability/change-requests/{requestId}/decision` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [x] | `GET /v1/availability/candidates?workDate=...` | admin | ✅ | ✅ | ✅ | ✅ | ✅ | admin 200, maid/developer 403 |

### #51 완료 조건

- [x] Fastify 계약과 동일한 validation/error code/camelCase projection
- [x] maid self-only / admin exact-role / developer 차단 회귀
- [x] must-change/inactive/revoked/upload-only 차단
- [x] KST 제출창, CAS version, Idempotency-Key 계약 유지
- [x] OpenAPI/Swagger/codegen 갱신
- [x] Edge Deno tests + required CI + 독립 리뷰 P0/P1=0
- [x] `dev` 병합
- [x] `release → main`
- [x] production `api` 재배포 및 maid/admin/developer hosted read/role smoke
- [x] 배포 OpenAPI 및 GitHub Pages snapshot 갱신
- [ ] 성공 mutation hosted smoke — `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`

## 9. 예약·청소요청 API — Edge parity #52 (P1)

예약 API 9개 operation이 production Edge에 배포됐다. 운영 예약이 0건이므로 목록과 role denial만
hosted 검증했고 상세 PII와 성공 mutation은 release acceptance exception을 적용한다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/reservations` | admin | ✅ | ✅ | ✅ | ✅ | ✅ | admin 200/0건, developer·maid 403, 고객명·암호문 비노출 |
| [ ] | `GET /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | `SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION` |
| [ ] | `POST /v1/reservations` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `PATCH /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/reservations/{reservationId}/cancel` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/reservations/{reservationId}/manual-checkout` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/reservations/cleaning-requests` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [ ] | `POST /v1/reservations/cleaning-requests/{targetId}/cancel` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | success mutation hosted smoke release exception |
| [x] | `POST /v1/reservations/transitions/process` | admin | ✅ | ✅ | ✅ | ✅ | ✅ | scheduler manual/replay 및 reserved namespace 계약 PASS |

### #52 source gate

- [x] Fastify와 동일한 9개 operation·camelCase projection·stable error code
- [x] exact active business admin + password changed + active session 경계
- [x] 각 RPC의 예약/객실 CAS, scoped Idempotency-Key, request hash, audit 계약 유지
- [x] AES-256-GCM 고객명 암호화·목록 비노출·상세 sensitive.read 기록
- [x] OpenAPI/Swagger/codegen 문서 갱신, Python 운영도구 generated client 제외 유지
- [x] Edge Deno·TypeScript·Python 로컬 회귀 검증
- [x] Issue #52 구현 PR 독립 보안/API 재검토 P0/P1=0
- [x] Issue #52 구현 PR `dev` 병합 — `dev@1275b62bc9d628059433dd926ddcccc0b70e72d5`
- [x] `release → main` 후 production `api` 재배포
- [x] hosted admin list와 developer/maid denial, scheduler manual/replay idempotency smoke
- [x] 배포 OpenAPI 및 Pages snapshot 갱신
- [ ] PII 상세 — `SKIPPED_WITH_REASON=NO_GUEST_NAME_RESERVATION`
- [ ] 성공 mutation hosted smoke — `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`

## 10. Reservation Scheduler Edge Function

| 체크 | Function / Path | 권한 | DB/RPC | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /functions/v1/reservation-scheduler` | scheduler secret + active admin actor | ✅ | ✅ | ✅ | ✅ | actor/secret configured, invalid 401, manual/replay 200 |
| [x] | scheduler heartbeat 기록/조회 | scheduler + developer projection | ✅ | ✅ | ✅ | ✅ | Vault/Cron active, state healthy, latest HTTP 200 |

운영 scheduler 정본:

- actor configured/valid, invoke secret configured
- Vault `scheduler_function_url`/`scheduler_invoke_secret` 각각 1개
- `pg_cron`/`pg_net` enabled
- job `reservation-transition-every-minute` 정확히 1개, active, `* * * * *`
- command에는 secret/service-role/URL literal 없이 Vault lookup만 존재
- 수동 동일 `scheduledAt` replay에서 logical receipt 1개와 side effect 0 확인
- 활성화 gate 5회 succeeded; 2026-09-03 readback 1866/1866 succeeded, latest HTTP 200,
  heartbeat succeeded, transition 0, rooms 121/reservations 0

## 11. Assignment Core — #25

#25는 미통보 `draft_assigned`까지만 소유한다. source gate와 `dev` 병합은 완료됐으며 production
Supabase migration·Edge 배포·현재 사용은 아직 하지 않는다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/assignments?serviceDate=...` | maid / admin | ✅ | ❌ | ✅ | ❌ | ❌ | source/dev 완료, production 미승격 |
| [x] | `GET /v1/assignments/{cleaningTargetId}/history` | maid / admin | ✅ | ❌ | ✅ | ❌ | ❌ | maid self revision만 |
| [x] | `POST /v1/assignments/drafts` | admin | ✅ | ❌ | ✅ | ❌ | ❌ | notification/outbox/attempt 없음 |

### #25 source gate

- [x] 기존 `cleaning_targets`·`cleaning_assignments` 재사용 설계
- [x] service date/access window snapshot과 current maid/date/sequence unique 구현
- [x] target row lock + assignmentVersion CAS + scoped request hash/idempotency 구현
- [x] admin write, maid own read, developer/direct DML 차단 구현
- [x] OpenAPI 3 operation·한글 연동 계약 반영
- [x] local Edge/application/DB/concurrency 전체 검증
- [x] feature PR 독립 보안/API 리뷰 P0/P1=0
- [x] feature PR `dev` 병합 (`dev@c7e0b03` 기준)
- [ ] release/main 승격 후 production migration·Edge 배포·hosted role smoke

## 12. Assignment Commit — #26

#26은 오늘/내일 배정의 preflight와 선택 부분집합 알림 확정만 소유한다. 확정 transaction은
최신 객실 일정·현재 assignment version·현재 availability version·active maid를 다시 검증하고,
업무 notification과 private outbox 및 `assignment.notified` 감사만 기록한다. cleaning attempt와
외부 push/network 호출은 만들지 않는다.

PR #68 P1 보강: 예약 저장부터 `planned_cleaning_target_id`가 배정 계획을 제공한다.
의무는 private/current=null을 유지하며, 실제 checkout 때 같은 target을 current로 승격한다.
미통보 일정 변경은 schedule revision/draft stale, 통보 후 변경은 explicit replan,
취소는 soft cancel/current 종료/회수 notification으로 처리한다. attempt/PIN 실행은 checkout
전 차단하며 #28의 활성화 기능은 이번 PR에 포함하지 않는다. 운영 19 migrations는 변경하지 않았다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/assignments/commit-impact?serviceDate=...` | admin | ✅ | ❌ | ✅ | ❌ | ❌ | side-effect 없는 fingerprint preflight |
| [x] | `POST /v1/assignments/commit` | admin | ✅ | ❌ | ✅ | ❌ | ❌ | 선택 부분집합 atomic commit, persistent outbox |

### #26 source gate

- [x] KST 오늘/내일 및 source별 현재 상태·일정 재검증 구현
- [x] impact fingerprint + assignment/availability version CAS 구현
- [x] `assignment.commit_notify` scoped idempotency와 partial all-or-nothing 구현
- [x] notification/private outbox/`assignment.notified` safe audit 구현
- [x] admin-only Edge route·한글 OpenAPI·Python generated audit contract 반영
- [x] local fresh 22 migrations·DB/RLS 330건·Edge 69건·계획 경합 concurrency·DB lint 최종 재검증
- [x] PR #68 독립 보안/API 리뷰 P0/P1=0
- [x] PR #68 `dev` 병합 — `6f8d84c8c9d1a659fdebb142b0cad424f590572a`
- [ ] release/main 승격 후 production migration·Edge 배포·hosted admin smoke

### #27 Pre-start Change — source/dev 완료, production 미적용

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/assignments/{cleaningTargetId}/change` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/assignments/{cleaningTargetId}/unassign` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/assignments/{cleaningTargetId}/cancellation-requests` | maid self | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET /v1/assignment-change-requests` | admin / maid self | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/assignment-change-requests/{requestId}/decision` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |

- [x] immutable request/source와 pending/decision/superseded lifecycle, scoped RLS/RPC
- [x] 재배정/해제 CAS, non-superseded attempt 차단, 원 담당·planned checkout identity 보존
- [x] 실제 `create_manual_cleaning_request`의 `stayover_request + stayover` 일정 축소와 active reservation 점유 경계
- [x] draft 무통보 / notified old resolve + new notice/outbox/audit 원자 처리
- [x] 감사 4개 event 및 한국어 OpenAPI/Python generated contract
- [x] local fresh 23 migrations·DB/RLS 426건·Edge 76건·application 96건·Python 34건·동시성·DB lint/로컬 Security Advisor
- [x] exact head 전체 CI 최종 확인
- [x] #27 독립 보안/API 리뷰 P0/P1=0
- [x] #27 PR `dev` 병합 — `dev@b529614b287e3c69750f0e91f3ac539b8e8e33b8`
- [ ] release/main 후 production migration·Edge·hosted role smoke

신규 migration `20260904154536_assignment_prestart_change.sql`은 로컬 23번째다.
source OpenAPI는 49 paths / 53 operations이며 운영 39 / 43 snapshot은 변경하지 않았다.
중단·인계(#7), PIN/Sheets(#69), 실제 push worker(#10)는 제외한다.

### #28 Attempt Activation — source/dev 완료, production 미적용

#28은 public 업무 API를 추가하지 않는다. `reservation-scheduler`의 기존 secret/exact-admin 경계가
예약 전이 뒤 service-owned `process_due_assignment_lifecycle` RPC를 호출하며, 대상별 core는 같은
reservation-command → target → assignment 잠금 순서를 사용한다.

| 체크 | Command / 기능 | 권한 | DB/RPC | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| [x] | 오늘 notified → scheduled attempt | scheduler + active admin actor | ✅ | ✅ | ❌ | ❌ |
| [x] | 내일/checkout materialization gate | scheduler + active admin actor | ✅ | ✅ | ❌ | ❌ |
| [x] | unassigned/notified attempt-0 rollover | scheduler + active admin actor | ✅ | ✅ | ❌ | ❌ |

- [x] attempt exactly-once, current assignment/version/snapshot/active maid 재검증
- [x] planned checkout은 materialized current target·actual checkout 전 attempt 0 유지
- [x] 이전 객실 active workflow 차단과 retry 후 활성화 계약
- [x] rollover 시 target identity/original date 보존, effective date/carryover/version revision append
- [x] 이월 전 next source-window 검증: 연박 예약 점유 범위/KST 날짜 및 추가 청소 예약 overlap; invalid는 blocked/mutation 0, 자동 취소·종류 변환 없음
- [x] notified 미착수 assignment 종료, 기존 알림 resolve, informational notification/outbox append
- [x] activation/rollover safe audit 및 developer OpenAPI/Python 생성 계약
- [x] local fresh 24 migrations·DB/RLS 510건·Edge 76건·application 97건·동시성 검증
- [x] #28 독립 보안/API 리뷰 P0/P1=0 — PR #71 최종 리뷰
- [x] #28 PR `dev` 병합 — `a98e2ccc0bf86d760b144691aacb0807215ca09e`
- [ ] release/main 후 production migration·scheduler 재배포·hosted smoke

신규 migration `20260905002657_assignment_attempt_activation.sql`은 로컬 24번째다. public
OpenAPI operation은 추가하지 않아 source 49 paths / 53 operations를 유지한다. 실제 메이드 시작,
중단·인계(#7), PIN(#69), 자동 배정(#29)은 포함하지 않는다.

### #29 Assignment Preview — source/dev 완료, production 미적용

PR #72는 `dev@8bdb5db2cd65359adca13e132959bcdf5f808324`에 병합됐다.
source/dev 완료와 운영 배포는 별도 gate다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/assignments/preview` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET /v1/assignment-preview/duration-policy` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/assignment-preview/duration-policy` | admin | ✅ | ❌ | ✅ | ❌ | ❌ |

- [x] confirmed versioned duration 정책 / 데모·fallback·confirmed seed 없음
- [x] STABLE snapshot + 순수 bounded optimizer / 기존 고정 부하와 reclean 원 maid 보존
- [x] count → fee spread/deviation → route → seed 최종 동률 비교
- [x] 오늘/내일·source schedule·actual interval 재검증 / fingerprint와 expected versions
- [x] 한국어 OpenAPI / safe duration policy 감사 / Python developer filtered generated contract
- [x] local fresh 25 migrations·DB/RLS 575건(Preview 65건)·동시성·Edge 84건·application 122건·Python 34건·package source 검증
- [x] PR #72 exact head GitHub application / migration PASS
- [x] #29 독립 보안/API 리뷰 P0/P1=0
- [x] #29 PR #72 `dev` 병합
- [ ] release/main 후 production migration·Edge·역할별 hosted smoke 및 운영 소요시간 별도 확정

신규 migration은 `20260907143843_assignment_preview_duration_policy.sql` 하나이며 기존
24개는 변경하지 않는다. Source OpenAPI는 51 paths / 56 operations, production은 계속
39 paths / 43 operations다. 성공 Preview의 assignment/attempt/알림/outbox/audit/receipt write는
0이며, 설정 확정 POST만 별도 audit/receipt를 기록한다. `55/65/70/80`분은 운영값이 아니다.
정책 미확정은 409 / `decisionReady=false` / 빈 제안이다. 상세 한계는
[Preview 계약](./ASSIGNMENT_PREVIEW.md)을 따른다. 자동 apply/notify/PIN/#7 실행은 포함하지 않는다.
DB lint 오류 0, local Security Advisor WARN/ERROR 0이다. `notification_outbox`와 새 duration
정책의 RLS/no-policy INFO 2건은 직접 접근을 막고 RPC만 허용하는 의도된 경계다.

### #4 Maid Assignment Visibility — source/dev 완료, production 미적용

2026-09-08 승인 A안: maid는 실제 본인 통보 revision만 조회한다. 종료·superseded된 본인
통보 history는 허용하며 미통보 draft/다른 maid/미통보 revision은 RLS와 Edge 모두 차단한다.
과거 projection은 통보 당시 revision을 사용하고 현재 target version/새 담당을 노출하지 않는다.

- [x] notified-only RLS/projection/Edge 및 로컬 회귀 검증 완료
- [x] exact-head GitHub application / migration PASS — run `34216520932`
- [x] GPT exact-head 독립 검토 P0/P1=0 — `a95ff2efb351d9089b0b664568206db777103252`, review `5140718794` (COMMENTED)
- [x] 사용자 최신 위임에 따른 Codex 96/100 승인 후 PR #74 `dev` squash 병합 — `7bdc2a3981e55e235de569527f7cc68f5ef80db1`
- [ ] release/main 이후 운영 migration·Edge·hosted smoke

로컬 fresh 26 migrations, DB/RLS 627건(조회 39 + 실제 command 실패/원자성 13), Edge 87건,
application 122건, Python 34건 및 generated client 재생성 content 동일성을 확인했다.
동시성·DB lint PASS, local Security Advisor WARN/ERROR 0이며 기존 RPC-only INFO 2건을 유지한다.
승인 head와 병합 결과의 tree는 `18353afd22d9e5edce11bce8bb7a66a282a8e811`로 동일하다.
위임 승인 기록은 PR #74 comment `5584063601`이다. 점수·독립 리뷰·CI·병합을 구분해 기록한다.

기존 25개 migration은 불변이며 append-only migration으로 정합화한다. API 수는 기존
51 paths / 56 operations를 유지한다. production 39 paths / 43 operations 및 운영 snapshot은
변경하지 않는다. #4 선행 gate 완료 후 별도 feature로 진행한 #7A도 아래와 같이 source/dev gate를 완료했다.

별도 발견 #73: planned target이 있는 예약 객실 변경은 기존 즉시 FK 때문에 실패한다.
이는 #4 변경과 무관한 기존 예약 기능 문제로 분리했으며 이번 PR에서 고치지 않는다.
실제 command 테스트는 notify/unassign 이후 객실 변경의 실패·원자적 무변경을 확인하고,
snapshot의 이동 후 비노출은 별도 합성 DB/Edge 회귀로 검증한다. 실제 객실 변경 성공
smoke로 표현하지 않는다. 향후 #73 수정 뒤에도 과거 통보 snapshot을 보존해야 한다.

### #7A Attempt Execution Core — source/dev 완료, production 미적용

기준 `dev@7bdc2a3981e55e235de569527f7cc68f5ef80db1`에서 만든 별도 feature PR #75는
`dev@c68e65e49362d4fef0ec903d836818f54834d3b2`에 squash 병합됐다.
source OpenAPI는 **54 paths / 59 operations**이며 production은 계속 **39 / 43**이다.
신규 append-only `20260908110343_attempt_execution_core.sql`은 27번째 source migration이다.
기존 26개 migration은 불변이고 production 19개 history는 변경하지 않았다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `GET /v1/attempts/current?assignmentId=...` | active maid self/current notified | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/attempts/{attemptId}/start` | active maid self | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/attempts/{attemptId}/complete-field-work` | active maid self | ✅ | ❌ | ✅ | ❌ | ❌ |

- [x] execution version CAS/scoped request-hash receipt/서버 시각 start·물리 완료 구현
- [x] latest actor/session/password/own current notified identity 및 start source·점유 검증
- [x] maid in_progress 최대1 / 자정·마감·정상 checkout 후 물리 완료 / 사진 전제 없음
- [x] #7B 전 진행 maid 일반 role/status 변경 거부 / audit 원자성 / safe projection
- [x] 최종 로컬: Edge 95건, application 123건, fresh 27 migrations / DB·RLS 695건, 전체 concurrency, Python 34건·ruff/format/mypy/package/generated contract PASS
- [x] exact-head GitHub application / migration PASS — run `34221384259`
- [x] exact-head 독립 QA P0/P1=0 — `c3fb595c034d3c501ee21b8361c9aef0f14be031`
- [x] 사용자 위임 기준 Codex 평가 96/100 및 source/dev 승인
- [x] PR #75 `dev` squash 병합 — `c68e65e49362d4fef0ec903d836818f54834d3b2`
- [ ] release/main 이후 별도 production migration·Edge·hosted smoke

target coarse `in_progress`를 실제 현장 수행중으로 해석하지 않는다. current attempt의 status와
fieldCompletedAt/endedAt이 물리 완료 정본이다. field_completed만으로 사진 업로드·submission·
검수·ready·earning을 생성하지 않는다. #7B 인계/capability, #7C offline/lease, #73 FK 수정은
포함하지 않는다. [상세 실행 계약](./ATTEMPT_EXECUTION_CORE.md)을 따른다.
DB lint 오류 0, local Security Advisor WARN/ERROR 0이며 기존 RPC-only INFO 2건은 유지된다.
승인 head와 병합 결과의 tree는 `cc971a2217e7985767782b0da5670ba1380bd8d6`로 동일하다.
독립 QA·required CI·Codex 점수·병합 증거를 별도로 기록하며 운영 DB/hosted 테스트는 실행하지 않았다.

### #7B Attempt Lifecycle — source/dev 완료, production 미적용

2026-09-08 사용자 승인으로 미착수 만료 `scheduled`의 superseded 보존·다음날 재배정과
만료 `in_progress`의 명시적 새 인계 일정 정책을 확정했다. `dev@bcc74c0`에서 분기한
`codex/7b-handover-limited-capability`의 구현은 PR #77로 dev에 병합됐다. 정확한 계약은
[Attempt Lifecycle](./ATTEMPT_LIFECYCLE.md)을 따른다.

#7B 병합 당시 dev OpenAPI는 **58 paths / 63 operations**이며 아래 4개 operation을 포함한다.
이후 #7C를 포함한 최신 통합 수치는 §2를 따른다. production OpenAPI는 계속 **39 / 43**이다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `GET /v1/attempts/lifecycle-impact?assignmentId=...` | active business admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/attempts/{attemptId}/lifecycle` | active business admin | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET /v1/limited/attempts/{attemptId}?assignmentRevision=...` | own maid + live capability/session | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/limited/attempts/{attemptId}/complete-field-work` | own maid + finish_current/session | ✅ | ❌ | ✅ | ❌ | ❌ |

일반 Auth active-only/RLS는 유지하며 기존 session과 회차·revision·action에 묶인 DB capability를
전용 limited 경로에서 확인한다. 2시간 execution 및 최대24시간 evidence/submission grant는
발급 시각·만료가 불변이다. 별도 로그인 credential이나 실제 사진/제출 API를 추가하지 않는다.
인계 시 새 담당의 실제 source·점유·예약·현재 실행창을 재검증하고 reclean 원 maid 제약을 유지한다.

- [x] 미착수 만료 해소·만료 진행 회차의 새 인계 일정 정책 승인
- [x] lifecycle/limited RPC·Edge·OpenAPI 및 DB/RLS/경쟁 회귀 완료
- [x] 로컬 전체 Edge 104 / application 123 / fresh 28 migrations / DB·RLS 806(22 files, 신규111) / 전체 concurrency / Python 35 및 ruff·format·mypy·generated/package 검증 PASS
- [x] DB lint 오류0, local Security Advisor WARN/ERROR0; 기본 거부 RPC-only INFO5(기존2+신규private3)
- [x] exact-head independent QA P0/P1=0 — `037bc0652de8d9af1449249cbc3ee4a8f3e6cca9`
- [x] required CI `application` / `migration` PASS — run `34231187656`
- [x] 사용자 위임 기준 Codex 96/100 및 source/dev 승인
- [x] PR #77 squash 병합 → `dev@5882509afed6faf31f5e9d7775a163e19954c4c2`
- [ ] release/main 이후 production migration·Edge·역할별 hosted smoke

승인 exact head와 dev 병합 결과의 tree는 `1add0ec8668513ece4acc8f9d09b9509e91e2145`로 동일하다.
독립 QA·required CI·Codex 점수·병합을 구분해 기록한다. #7B source/dev 완료는 production
사용 가능 선언이 아니다. #7C offline lease/replay/quarantine도 아래 별도 증거에 따라 source/dev 완료다.
production DB/Edge/Pages 변경은 없다.

### #7C Offline — source/dev 완료, production 미적용

`codex/7c-offline-lease-quarantine`는 `dev@695c10c`에서 시작했다. 2026-09-08 사용자가
replay 최대90일 후 만료거부와 현재 유효한 in_progress 회차의 관리자 물리완료 정정을 승인했다.
과거 회차 복구 및 ready/검수/수익 생성은 금지한다. [Offline 계약](./ATTEMPT_OFFLINE.md)을 따른다.
PR #79는 2026-09-09 KST에 dev로 squash 병합됐다. 운영 migration/API/Pages 값은 그대로다.
통합 source의 OpenAPI는 63 paths / 68 operations이며 신규 offline 5 operations를 포함한다.
이는 dev 완료 수치이지 production 공개 계약 수치가 아니다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/attempts/{attemptId}/start-with-lease` | active own maid/session | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/offline-events` | own known lease/session; metadata와 실제 효력 별도 검사 | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET /v1/offline-quarantines` | active business admin/session | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET /v1/offline-quarantines/{quarantineId}` | active business admin/session | ✅ | ❌ | ✅ | ❌ | ❌ |
| `POST /v1/offline-quarantines/{quarantineId}/resolve` | active business admin/session | ✅ | ❌ | ✅ | ❌ | ❌ |

- [x] 90일 replay/metadata 경계와 관리자 정정의 현재회차 한정 정책 승인
- [x] 시작 base application 123 tests PASS
- [x] lease/ingest/quarantine/resolution/purge 구현 및 역할·시각·경합 로컬 검증
- [x] OpenAPI/Python/문서 정합화와 전체 로컬 검증 (Edge114/application123/DB910/Python36/전체 concurrency PASS)
- [x] exact-head independent QA P0/P1=0 — `25ceabd2d9d781bb26e68be2230ab6d08ddd3e87`
- [x] required CI application/migration PASS — run `34243676126`
- [x] Codex 위임 평가96/100 및 PR #79 source/dev 병합 허가 — comment `5587516395`
- [x] PR #79 squash 병합 — `dev@e2648de4e40a84e60d19cbb1e4d01974a2f3d369`
- [ ] 별도 release/main 및 production 배포·보존 worker·hosted 검증

승인 head와 병합 결과의 tree는 `6768b63f64fdea6dba7d4eda32a70807b7274823`로 동일하다.
GitHub COMMENTED 리뷰·독립 서브에이전트 QA·Codex 위임 허가를 구분한다. #7A/B/C는
source/dev 완료이며 #30 / PR #81, #83 / PR #86, #84 / PR #88, #85 / PR #90과 #31 / PR #91도 source/dev 완료했다. 현재 본선은 #8 earning/payroll 정산이다. production purge 주기/backlog/실패감시와
hosted/client offline E2E는 아직 실행하지 않았다. #7은 해당 후속 gate 추적을 위해 Open 유지한다.

## 13. 후속 업무 API·모델 개발 상태

아래는 v0.2.0 이후 업무 기능의 source/dev 진행 상태다. 완료된 내부 모델과 아직 미개발인 기능/API를 구분하며, 실제 route는 각 Issue 구현 PR에서 확정하고 이 문서를 갱신한다.

| 체크 | 영역 | 상태 | 관련 Issue | 비고 |
|---|---|---|---|---|
| [x] | 청소 담당 배정·revision·현재 pointer·순서 | source/dev 완료 | #25 | production 미승격 |
| [x] | 배정 저장 시 가능일 재검증·부분 알림 | source/dev 완료 | #26 | production 미승격 |
| [x] | 시작 전 재배정·취소 요청·관리자 결정 | source/dev 완료 | #27 | production 미승격 |
| [x] | 오늘/내일 activation·rollover | source/dev 완료 | #28 | production 미승격 |
| [x] | 배정 preview algorithm | source/dev 완료 | #29 | production 미승격 |
| [x] | maid notified-only 조회 정합화 | source/dev 완료 | #4 / PR #74 | production 미승격 |
| [x] | 온라인 현장 시작·물리 완료 | #7A source/dev 완료 | #7 / PR #75 | production 미승격; 사진·submission·ready와 별도 |
| [x] | handover/capability | #7B source/dev 완료 | #7 / PR #77 | production 미승격 |
| [x] | offline lease/conflict | #7C source/dev 완료 | #7 / PR #79 | production 미승격; purge 운영·hosted E2E 별도 |
| [x] | 사진 template/slot snapshot·submission version | source/dev 완료 | #30 / PR #81 | production 미승격; owner-only 모델이며 HTTP/Drive/전체 제출 command 제외 |
| [x] | 사진 업로드 작업 원장·권한 계약 | #83 source/dev 완료 | #83 / PR #86 | production 미승격; DB/내부 계약만, 실제 Drive/HTTP/purge 제외 |
| [x] | Google Drive 업로드·조회 | #84 source/dev 완료 | #9 / #84 | PR #88 독립 QA·required CI·source 승인/dev 병합 완료; production OAuth·hosted smoke 미완료 |
| [x] | 7일 영구삭제·orphan 운영 worker | source/dev 완료 | #9 / #85 / PR #90 | accepted/orphan/folder 원장 분리; production 미승격·미사용 |
| [x] | 제출·검수·재청소 | source/dev 완료 | #31 / PR #91 | 34 migrations / 74 paths / 80 operations; production 미승격·미사용; inspection queue pagination은 P2 후속 |
| [x] | earning/payroll 주차 조회·PAYING 시작 | source/dev 완료 | #8 / #93 / PR #95 | 35 migrations / 76 paths / 82 operations; production 미승격·미배포 |
| [x] | payroll pagination·응답 크기 상한 | source/dev 완료 | #96 / PR #97 | 36 migrations / 77 paths / 83 operations; 비차단 P2 2건 후속; production 미승격 |
| [x] | complaint·appeal·correction | source/dev 완료 | #8 / #94 / #100 / PR #104 | exact-head 독립 QA P0/P1/P2 0, required CI PASS; 37 migrations / 85 paths / 92 operations; production 미승격·미사용 |
| [x] | complaint 재작업·typed compensation earning | source/dev 완료 | #8 / #94 / #101 / PR #105 | 38 migrations / 86 paths / 93 operations; production 미승격·미사용 |
| [x] | signed adjustment·carry-forward | source/dev 완료 | #8 / #94 / #102 / PR #106 | 39 migrations / 90 paths / 97 operations; production 미승격 |
| [x] | 외부 지급 결과 | source/dev 완료 | #8 / #94 / #103 / PR #107 | 40 migrations / 93 paths / 100 operations; production 미승격·미사용 |
| [x] | 알림함 조회·읽음 처리 | source/dev 완료 | #10 / #108 / PR #108 | 41 migrations / 95 paths / 102 operations; production 미승격·미사용 |
| [x] | notification catalog·grouping·writer 정합성 | source/dev 완료 | #10 / #109 / PR #114 | 42 migrations / 95 paths / 102 operations; production 미승격·미사용 |
| [x] | encrypted Web Push subscription revision ledger/API | source/dev 완료 | #10 / #110 / PR #115 | 43 migrations / 97 paths / 104 operations; production 미승격·미사용 |
| [x] | notification delivery ledger·provider-neutral worker | source/dev 완료 | #10 / #111 / PR #116 | 44번째 append-only migration, 공개 97 paths / 104 operations 유지; production 미승격·미사용 |
| [x] | claim/resume 교차 동시성 회귀 | source/dev 완료 | #10 / #117 | 기능·migration 변경 없이 실제 RPC Promise.all 경합 고정; `dev@cc15f47a74959943cf72a95e69da278243020f15` |
| [x] | VAPID/provider HTTP source 계약 | source/dev 완료 | #10 / #112 / PR #119 | 45 migrations / 98 paths / 105 operations; 승인 head `eb243c54ebf24cd932d70cb1c6423fa4f319c050`, `dev@dfc98b1474f9f890851d49bd904869181d0d7880`; Issue #112 OPEN, Cron/Vault/production hosted 활성화 미완료 |
| [ ] | backup/restore 운영 자동화 | 미개발 | #12 | 핵심 체인과 병행 |
| [ ] | frontend generated client / browser E2E | 미개발 | #13 | OpenAPI 정본 사용 |

### #31 Submission / Inspection source gate

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/attempts/{attemptId}/bomb-room-reports` | own active maid | ✅ | ✅ | ✅ | ❌ | ❌ | 제출 전 immutable 증빙 1~20장; reclean 신고 금지 |
| [x] | `GET /v1/attempts/{attemptId}/submissions` | own maid | ✅ | ✅ | ✅ | ❌ | ❌ | 본인 회차 이력, 관리자 review context 비노출 |
| [x] | `POST /v1/attempts/{attemptId}/submissions` | own maid / exact `upload_submit` capability | ✅ | ✅ | ✅ | ❌ | ❌ | 필수 verified current slot 봉인, pointer CAS |
| [x] | `GET /v1/inspections` | business admin | ✅ | ✅ | ✅ | ❌ | ❌ | oldest-first 최대 100건, 안전한 immutable review context |
| [x] | `GET /v1/inspections/{submissionId}` | business admin | ✅ | ✅ | ✅ | ❌ | ❌ | sealed photo ID/slot과 폭탄 증빙 ID만 공개 |
| [x] | `POST /v1/inspections/{submissionId}/bomb-room-decision` | business admin | ✅ | ✅ | ✅ | ❌ | ❌ | current version 1회 선판정 |
| [x] | `POST /v1/inspections/{submissionId}/approve` | business admin | ✅ | ✅ | ✅ | ❌ | ❌ | earning/알림/outbox/audit exactly-once |
| [x] | `POST /v1/inspections/{submissionId}/reject` | business admin | ✅ | ✅ | ✅ | ❌ | ❌ | 원 maid notified 0원 reclean, attempt는 #28만 생성 |

- [x] append-only `submission_inspection_reclean` migration 및 8개 Fastify/Edge operation 구현
- [x] role/capability/CAS/idempotency/concurrency/redaction 로컬 검증
- [x] field_completed 단독 상태에서 submission/readiness/earning 0 유지
- [x] 폭탄방 report·증빙은 최초 immutable submission에 seal되고 다른 version으로 이동 금지
- [x] 반려는 정확히 같은 transaction에서 actionable notification/outbox와 원 maid notified reclean을 생성하며 earning과 attempt는 생성하지 않음
- [x] PR #91 exact head `3c283683d8bce5e5b6351c1de1c9271c2099163f` 독립 QA P0/P1=0, P2=inspection queue pagination — 96/100
- [x] required CI application/migration PASS — run `34368041871`
- [x] PR #91 `dev` squash 병합 — `f22005d8af6087a3bbab215c76cf7cc7e45b49fb`; 승인 head와 병합 tree `9e97e1299a76923982fb848ec488f8fa99e0dc8e` 동일
- [ ] release/main 승격, production migration/Edge 배포, hosted 역할·mutation smoke

## 14. Python 운영도구 — #44 Phase A

Python 운영도구는 Edge Function이 아니라 승인된 Windows PC에서 실행하는 로컬 client다.
따라서 `Edge source`/`Production Edge` 상태를 만들지 않으며, 실제 사용 가능 판정은 source,
Windows artifact, developer hosted smoke를 별도 gate로 관리한다.

| 체크 | 기능 | API source | Python source | Windows artifact | Hosted smoke | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|
| [ ] | developer 로그인·메모리 세션·refresh/logout | ✅ | ✅ | ❌ | ✅ | ⚠️ | 로컬 source 실행 smoke PASS, Windows artifact 미완료 |
| [ ] | business admin/maid 계정 관리 | ✅ | ✅ | ❌ | ✅ | ⚠️ | 운영 계정 생성 경로 PASS, Windows artifact 미완료 |
| [ ] | overview/runtime/database/scheduler | ✅ | ✅ | ❌ | ✅ | ⚠️ | developer hosted smoke PASS, Windows artifact 미완료 |
| [ ] | 안전한 domain 감사 목록·진단 | ✅ | ✅ | ❌ | ✅ | ⚠️ | diagnostics hotfix 후 hosted PASS |
| [ ] | 활동/보안 로그 | ✅ | ✅ | ❌ | ✅ | ⚠️ | 감사/활동 분리 hosted readback PASS |
| [ ] | DB direct 진단 | — | ❌ | ❌ | ❌ | ❌ | Phase B 전까지 의도적으로 비활성 |
| [ ] | maintenance action catalog | — | ❌ | ❌ | ❌ | ❌ | Phase C 전까지 의도적으로 비활성 |

### #44 Phase A source gate

- [x] Python 3.12+, PySide6, httpx exact dependency와 `uv.lock`
- [x] OpenAPI 0.29.0 생성 client + 생성 코드 밖 인증/멱등성/redaction adapter
- [x] environment/project ref 고정 텍스트, developer/last-admin UI 보호
- [x] production/recovery source-controlled exact allowlist + 로그인 후 runtime 대상 재대조
- [x] account response 5개 상태 표시 / status command 3개 target 분리
- [x] 계정·developer dashboard·감사·진단 화면
- [x] DB credential/service role/SQL 기능 미포함
- [x] Windows x64 PyInstaller workflow와 checksum source
- [x] 설치·업데이트·삭제·PC 분실 runbook
- [x] PR #57 exact head required CI + 독립 보안/운영 재검토 P0/P1=0
- [x] PR #57 `dev` 병합 — `dev@388ab3caf92f166bc01d3d58273aee33f2ac9ac9`
- [ ] 승인 source 기반 Windows x64 artifact build/smoke
- [x] developer 로그인 → business admin/maid 생성 hosted smoke

Phase A가 `dev`에 병합돼도 #44 전체 Issue는 Phase B/C와 Windows/hosted gate가 남으므로 Open
유지한다.

## 15. 현재 우선순위

production completeness 기준의 정본 순서다.

1. [x] #48 `dev` 병합
2. [x] **#51 Availability Edge parity source/dev** — production 배포·hosted smoke까지 Issue Open
3. [x] **#44 Python 운영도구 Phase A source/dev** — Windows artifact·hosted smoke는 별도 gate
4. [x] **#58 Actor Activity / Audit 로그 정본화 source/dev (P1)** — production 반영까지 Issue Open
5. [x] **#52 Reservation Edge parity source/dev (P1)** — production 배포·hosted smoke까지 Issue Open
6. [x] **#53 Room detail/mutation Edge parity source/dev (P1)** — production 배포·hosted smoke까지 Issue Open
7. [x] PR #50 GitHub Pages Swagger portal source·독립 리뷰 완료 — parity와 병행 가능
8. [x] 최신 source를 `release/v0.2.0 → main`으로 승격
9. [x] 필요한 신규 migration 순차 적용 — production 19건
10. [x] `api`와 `reservation-scheduler`를 승인된 `main` source로 재배포
11. [x] developer / business admin / maid 실제 hosted HTTP role matrix smoke
12. [x] Python 콘솔에서 business admin 생성 및 최초 비밀번호 변경
13. [x] scheduler actor/invoke secret → Vault/pg_cron/pg_net 활성화
14. [x] Cron heartbeat/audit/idempotency smoke
15. [x] GitHub Pages workflow 수동 실행 및 공개 portal/openapi snapshot smoke
16. [x] 운영 활성화 문서 PR 독립 리뷰·`main` 병합
17. [x] PR #65 `main` 병합 후 별도 backport PR로 아래 변경을 모두 `dev`에 역반영
    - release PR #62 Pages fail-closed 보강
    - hotfix #64 diagnostics 수정
    - PR #65의 `docs/API_STATUS_MATRIX.md`·`docs/RELEASE_V0.2.0.md` 최종 운영 활성화 문서
18. [x] backport 후 `dev` production snapshot과 `main` 일치 + required CI PASS
19. [x] `v0.2.0` annotated tag / GitHub Release
20. [x] #25 Assignment Core source gate·`dev` 병합
21. [x] **#26 Assignment Commit source gate** — PR #68 `dev` 병합 완료
22. [x] **#27 Pre-start Change source gate** — `dev@b529614`; 운영 미적용
23. [x] **#28 Attempt Activation source gate** — PR #71 `dev` 병합; 운영 미적용
24. [x] **#29 Assignment Preview source gate** — PR #72 `dev` 병합; 운영 미적용
25. [x] **#4 notified-only 조회 정합화** — PR #74 독립 리뷰·CI·Codex 위임 승인 → `dev@7bdc2a3` 병합
26. [x] **#7A Attempt Execution Core source gate** — PR #75 독립 QA·required CI·Codex 96/100 승인 → `dev@c68e65e` 병합; 운영 미적용
27. [x] **#7B Attempt Lifecycle source gate** — PR #77 독립 QA·required CI·Codex 96/100 승인 → `dev@5882509` 병합; 운영 미적용
28. [x] **#7C Offline Lease/Replay/Quarantine source gate** — PR #79 독립 QA·required CI·Codex 96/100 승인 → `dev@e2648de` 병합; 운영 미적용
29. [x] **#30 Photo Slot / Submission Base source gate** — PR #81 독립 QA·required CI·Codex 96/100 승인 → `dev@a4f8cb5` 병합; 운영 미적용
30. [x] **#83 Photo Storage Operations source gate** — PR #86 독립 QA·required CI·Codex 96/100 승인 → `dev@cf91753` 병합; 운영 미적용
31. [x] **#84 Drive 업로드·열람 source gate** — PR #88 독립 QA·required CI·source 승인 → `dev@520abe7` 병합; 운영 미적용
32. [x] **#85 source gate** — PR #90 exact head 독립 리뷰·required CI·source 승인 후 `dev@92c0f97` 병합; production 미승격
33. [x] **#31 source gate** — PR #91 exact-head 독립 QA·required CI·96/100 위임 승인 후 `dev@f22005d` 병합; production 미승격
34. [x] **#93/#95 Payroll Cycle Assembly source gate** — exact-head 리뷰 P0/P1=0 후 PR #95 `dev@c3bdece` 병합; production 미승격
35. [x] **#96 Payroll pagination source gate** — PR #97 독립 QA P0/P1=0·94/100 및 required CI 후 `dev@9231d9e` 병합; production 미승격
36. [x] **#100 Complaint lifecycle source gate** — PR #104 독립 QA·required CI 후 `dev@88d1865` 병합; production 미승격
37. [x] **#101 source/dev gate** — PR #105 독립 QA·required CI 후 `dev@a5c4867` 병합; production 미승격
38. [x] **#102 source/dev gate** — PR #106 독립 QA·required CI 후 `dev@cb26650` 병합; production 미승격
39. [x] **#103 source/dev gate** — PR #107 `dev@3297679ca2e903e68cfa2dd9e7bc137341c5b27d` 병합; production 미승격
40. [x] **#108 source/dev gate** — PR #108 독립 QA·required CI 후 `dev@bdb4b25d33aa09efe99112636c60c4da52336318` 병합; production 미승격
41. [x] **#109 source/dev gate** — PR #114 독립 QA·required CI·dev 병합 완료; production 미승격
42. [x] **#110 source/dev gate** — encrypted Web Push subscription revision ledger/API가 PR #115로 dev 병합 완료; production 미승격
43. [x] **#111 source/dev gate** — notification delivery ledger·provider-neutral worker PR #116이 `dev@8fb0886214ef8287f15f2ad2fd149cd271340834`로 병합; production 미승격
44. [x] **#117 concurrency gate** — 실제 claim/resume 교차 경합 회귀가 `dev@cc15f47a74959943cf72a95e69da278243020f15`로 병합; 기능·migration 변경 없음
45. [x] **#112 source/dev gate** — VAPID revision binding·public config·provider/Edge source가 승인 exact head `eb243c54ebf24cd932d70cb1c6423fa4f319c050`에서 독립 QA·required CI를 통과하고 PR #119로 `dev@dfc98b1474f9f890851d49bd904869181d0d7880`에 병합; Issue #112는 hosted 활성화까지 OPEN, production 미승격

### #93 Payroll Cycle Assembly source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/payroll` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/start` | admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] fresh migration·DB/RLS·concurrency 검증
- [x] Fastify/Edge/OpenAPI 76 paths / 82 operations 검증
- [x] 전체 OpenAPI Python ephemeral codegen 검증; developer 콘솔 allowlist 16 operations 유지
- [x] exact head `0041a2b704cf4052760104944787041025f22d21` 독립 재검토 P0/P1=0, P2=#96 비차단
- [x] required CI application/migration exact-head PASS
- [x] PR #95 `dev` squash 병합 — `dev@c3bdece5e5e35fe693212b0c974df19d0e112e42`

GET은 cycle이 없어도 side effect 없이 conceptual OPEN을 반환한다. POST는 종료된 KST 주차의
확정 earning만 서버가 계산해 OPEN→PAYING snapshot을 잠그며 실제 송금 성공을 뜻하지 않는다.
PAYING 이후 늦은 확정 수익은 locked amount와 별도 projection으로 표시한다. 이 feature에서
production DB/Edge/Pages를 변경하지 않는다.

### #96 Payroll Pagination / Response Bound source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/payroll` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `GET /v1/payroll/entries` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/start` | admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] admin-all `maidProfileId ASC` keyset page 기본/최대 10, DB 독립 상한 및 exact total 유지
- [x] cycle별 items/lateEarnings preview 최대 10과 상세 `earnedOn ASC, earningId ASC` page 기본 25/최대 50
- [x] HMAC-SHA256 base64url cursor의 version/schema/길이/서명과 actor role+ID/week/effective maid filter/kind/fixed sort scope 고정
- [x] Fastify/Edge strict query parity, public internal key 비노출, UTF-8 전체 envelope 128 KiB fail-closed
- [x] start/replay bounded receipt 및 120 earning fixture의 exact total·10 preview·50/50/20 무중복/무누락 순회 검증
- [x] append-only `payroll_bounded_pagination` migration, OpenAPI 77 paths / 83 operations, developer 콘솔 16 operations 유지
- [x] 전체 로컬 검증과 exact head `8b2d9ca17b6bcf22325192112f91090f35de8d1c` 독립 QA **P0 0 / P1 0 / P2 2, 94/100** — [comment 5610232229](https://github.com/wrongstory/room-management-system-backend/pull/97#issuecomment-5610232229)
- [x] exact-head required CI `application` / `migration` PASS — [run 34416253694](https://github.com/wrongstory/room-management-system-backend/actions/runs/34416253694)
- [x] PR #97 `dev` squash 병합 — `dev@9231d9e202d1402c67103789101cf8e92cfa0c04`
- [ ] 비차단 P2 후속: service-role RPC의 명시적 NULL fail-closed hardening
- [ ] 비차단 P2 후속: 대량 `lateEarnings` 다중-page 전용 회귀 테스트

이 source gate는 `PAYROLL_CURSOR_HMAC_SECRET`이라는 별도 32-byte 이상 secret을 Fastify와 Edge에
요구한다. production/main/recovery/Pages/Cron/Vault를 이 feature PR에서 변경하지 않으며, 실제 secret
설정·migration 적용·Edge 배포·hosted role smoke는 release gate다.

### #94 Complaint / Compensation / Adjustment / Payment Evidence policy gate — 승인, #100~#102 source/dev 완료

| 영역 | 정책 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| typed earning provenance | 승인 / #101 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| complaint / appeal / correction | 승인 / #100 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 타 메이드 compensation entitlement | 승인 / #101 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| signed adjustment / carry-forward | 승인 / #102 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| external full-payment result / `CHECK` / `PAID` | 승인 / #103 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| own notification inbox / mark read | 승인 / #108 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| notification catalog / typed grouping / writer atomicity | 승인 / #109 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |
| encrypted Web Push subscription register / retire | 승인 / #110 source/dev 완료 | ✅ | ✅ | ✅ | ❌ | ❌ |

- 원청소 entitlement와 타 메이드 compensation entitlement는 실제 typed FK이고 `earnings`의 source별
  nullable FK는 exactly-one CHECK를 가진다. 임의 polymorphic UUID를 도입하지 않으며 #31 identity/history는
  future append-only migration으로 보존한다.
- 컴플레인은 원 청소 승인 후 30일 안에 source-controlled reason code로 접수한다. 자유형 고객 정보와
  PII는 금지한다. immutable decision/current pointer CAS의 판정은 `confirmed / unverifiable / false`, 벌점은
  정수 0~10 평가 전용이며 자동 급여 차감이 아니다. 본인 maid appeal은 최초 decision 뒤 7일 안에 1회다.
  종결 후 reopen하지 않고 active business admin correction version만 추가한다.
- 같은 maid의 승인 후 재작업은 earning 0원이다. 다른 maid는 0원 이상 원 target base fee snapshot 이하의
  정수 원화 immutable compensation decision을 가지며 field completion과 승인 뒤 exactly-once earning을 만든다.
- adjustment는 signed append-only다. 음수는 실제 prior entitlement/adjustment의 correction/reversal만 허용하고
  `reversal_of` provenance·maid·currency·amount를 검증한다. complaint penalty는 자동 음수 adjustment가 아니다.
  `PAID` cycle은 불변이고 이후 cycle에서 정정한다. payable amount가 0 이하이면 지급 시작·0원 `PAID` event를
  금지하고 residual을 다음 positive cycle로 이월한다.
- 시스템은 provider를 호출하지 않고 관리자가 확인한 외부 전액 지급 결과만 기록한다. 전이는
  `OPEN → PAYING → PAID`, 불확실하면 `PAYING → CHECK`다. `NO_TRANSFER_CONFIRMED` reason과 확인 actor/time이
  있을 때만 `PAYING/CHECK → OPEN`이며 재시도는 새 event다. `PAID → OPEN`은 금지한다.
- payment method는 source-controlled code이고 provider/reference ID는 제한된 형식·길이와 PII/secret 금지를
  적용한다. `paidAt`은 server 시각이며 actor, cycle `expectedVersion`, scoped idempotency/request hash, audit이
  필수다. 영수증·계좌·수취인 PII를 저장하거나 실제 송금 확인 전 `PAID`를 응답하지 않는다.

#100~#103 정산·complaint source와 #108~#112 알림·Web Push source는 모두 dev에 통합됐다.
#112만 Function Secrets, 승인 `api`/`notification-delivery` Edge bundle, hosted smoke,
Vault/`pg_cron`/`pg_net`, 연속 heartbeat와 실제 기기 smoke의 production activation이 남았다.
main/recovery/production migration·Edge/Pages/Cron/Vault는 그대로 유지한다.

### #100 Complaint / Appeal / Correction source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/complaints` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `GET /v1/complaints/{complaintId}` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `GET /v1/complaints/{complaintId}/history` | admin / maid self | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints/{complaintId}/review` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints/{complaintId}/decision` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints/{complaintId}/response` | own active password-complete maid | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints/{complaintId}/corrections` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/complaints/{complaintId}/close` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] append-only `complaint_lifecycle` migration 1개; 기존 36 migrations 수정 없음
- [x] 승인된 원 청소 allowlist target + non-null exact submission entitlement/current earning typed FK와 30일 inclusive intake; reclean/alternate compensation source fail-closed
- [x] immutable decision/maid response/event, current pointer CAS, 7일 inclusive 1회 응답, 종결 후 reopen 금지
- [x] 벌점 0~10 평가 전용 및 earning/payroll/adjustment side effect 0
- [x] source-controlled category/appeal code만 허용하고 자유형 고객·직원 content와 PII/PIN/photo locator 비저장
- [x] bounded 31일 list, 최대 100 keyset page/history, actor·scope 바인딩 signed cursor
- [x] RLS/Data API/SECURITY DEFINER 최소 권한; JWT session_id와 같은 사용자 active auth.sessions exact match, revoked/missing/malformed/mismatch 0행
- [x] 감사·알림/outbox·멱등성 원자성; correction 알림은 새 응답 요구 없는 informational(false)
- [x] Fastify/Edge/OpenAPI parity — 전 응답 no-store, 빈 cursor도 INVALID_COMPLAINT_CURSOR; 85 paths / 92 operations; developer 콘솔 16 operations 유지
- [x] PR #104 exact head `8b7357ba7a9b8460c65f98fde7c2225f2057d5cc` 독립 QA **P0 0 / P1 0 / P2 0, 97/100**, required CI `application` / `migration` PASS
- [x] PR #104 `dev` squash 병합 — `dev@88d1865bdaafb6dc2afa556452ae80c91569f393`
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

### #101 Complaint Rework / Typed Compensation Earning source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/complaints/{complaintId}/rework` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] 기존 37 migrations 수정 0, append-only `complaint_compensation_earning` 38번째 migration 1개
- [x] `post_approval_complaint_reclean`과 confirmed complaint decision/원 target/assignee typed FK; inspection reclean 혼용 금지
- [x] server-proven current safe room window, published template, target/version/notified assignment revision 원자 snapshot; client schedule 금지
- [x] same maid decision amount 0 + entitlement/earning 0; other maid 0..base integer KRW + 승인 뒤 0원 포함 entitlement/earning 1
- [x] original/compensation earning nullable typed FK exactly-one CHECK, 기존 #31 identity/history 보존
- [x] field completion/current submission approval 전 0건, 승인 retry/concurrency exactly-once, actual compensation earningId 응답
- [x] pre-start semantic correction 차단, penalty-only correction activation/start 허용, started work의 source/current divergence 노출
- [x] generic prestart reassignment/handover assignee drift와 bomb report/bonus 재생성 차단
- [x] raw compensation decision RLS admin-only + live auth.sessions; maid actor-aware projection cross-maid UUID/타 보상액 비노출
- [x] `complaint.rework_materialized`/`compensation.earned` developer 감사 safe summary; raw state/request hash/maid cross-sensitive 필드 비노출
- [x] Fastify/Edge/OpenAPI parity, no-store, strict body, stable errors; 86 paths / 93 operations
- [x] PR #105 독립 QA, required GitHub `application` / `migration` PASS, `dev@a5c48673ff339e5a338356c77ce83e8cf40ee21a` 병합
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

### #102 Signed Payroll Adjustment / Carry-forward source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/payroll/adjustments/corrections` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/adjustments/reversals` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/carry-forward` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/late-earnings/{earningId}/carry` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] 기존 38 migrations 수정 0, append-only `payroll_adjustments` 39번째 migration 1개
- [x] correction/reversal/late carry five-way typed source와 source-derived reason; 임의 polymorphic ID·자유형 reason 없음
- [x] full exact inverse reversal source당 1회, reversal chain 이력, root cumulative entitlement 0 미만 차단
- [x] receipt → global → actor → adjustment book → cycle → sorted source 단일 lock order와 book/cycle CAS
- [x] payable 0 이하 start 무변경 실패; immutable offset settlement, zero payment event 0, negative residual만 바로 다음 KST week 순차 carry
- [x] offset-settled OPEN cycle 경제적 동결; PAID/offset late earning은 explicit unique positive carry 뒤 원본 재claim 차단
- [x] PAYING/CHECK/PAID/offset source의 미처리 positive late earning이 있으면 다음 주차 start/offset freeze 차단; 반대 race도 earning insert fail-closed
- [x] settlement↔residual carry source/id·maid·currency·amount·바로 다음 week 양방향 불변식을 deferred constraint trigger로 commit 검증
- [x] live-session RLS와 admin/maid-self Data API, developer/cross-maid 금액 비노출 safe audit
- [x] signed adjustment/carry/payable bounded projection, 128 KiB·signed cursor·no-store Fastify/Edge parity; 90 paths / 97 operations
- [x] PR #106 exact head `ede399c9d307f1aa3e29d9bad163e5e2410433f5`, 독립 QA 및 required GitHub `application` / `migration` PASS
- [x] PR #106 `dev` squash 병합 — `dev@cb26650221b3e47804edafd51cad5bfc8872c349`
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

#103의 `CHECK/PAID`·외부 전액 지급 결과/provider reference는 #102 source gate에 포함하지 않는다.

### #103 External Full Payment Result source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/check` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/paid` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/reopen` | active password-complete business admin | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] 기존 39 migrations 수정 0, append-only `payroll_payment_results` 40번째 migration 1개
- [x] 기존 `payment_started` event와 attempt typed identity; 과거 attempt만 deterministic backfill하고 CHECK/PAID result 추측 없음
- [x] `PAYING → CHECK → PAID`, `PAYING → PAID`, fixed `NO_TRANSFER_CONFIRMED` `PAYING/CHECK → OPEN`; reopen 후 start는 새 attempt
- [x] client amount/paidAt 없음, PAID amount=positive locked payable snapshot, server paidAt, PAID cycle/evidence UPDATE·DELETE·reopen 금지
- [x] method `bank_transfer`; strict ASCII reference를 uppercase canonicalize하고 `(method, reference)` global unique
- [x] canonical reference는 admin command/result만 노출; maid/developer audit/notification에 reference·cross-maid 금액·raw payload 비노출
- [x] active/password/role/session/IDOR 재검증, cycle version CAS, scoped canonical idempotency hash
- [x] immutable result·cycle·safe audit·maid notification/outbox 원자 transaction; provider HTTP/receipt/계좌/수취인 PII/secret 없음
- [x] future payment projection transition ↔ event/attempt/result deferred 양방향 invariant; evidence 없는 privileged DML은 commit 시 `PAYROLL_PAYMENT_EVIDENCE_REQUIRED`, 과거 CHECK/PAID 추측 backfill 없음
- [x] Fastify/Edge/OpenAPI parity, 128 KiB/no-store 유지; 93 paths / 100 operations
- [x] PR #107 독립 QA, required GitHub `application` / `migration` PASS, `dev@3297679ca2e903e68cfa2dd9e7bc137341c5b27d` 병합
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

실제 bank/provider reference format은 아직 미확정이다. 현재 allowlist는 fail-closed source 계약이며 실제 provider
연동이 승인되면 별도 migration/API 검토가 필요하다. 이 source는 provider를 호출하지 않는다.

### #108 Notification Inbox / Mark Read source gate — source/dev 완료, production 미승격

- [x] 기존 40 migrations 수정 0, 41번째 append-only migration 1개
- [x] 본인 알림 `(occurred_at DESC, id DESC)` bounded keyset 조회와 actor/role/stream/sort 바인딩 signed cursor
- [x] 최초 server timestamp를 보존하는 멱등·동시 안전 markRead와 cross-recipient stable 404
- [x] raw notification Data API SELECT/UPDATE 회수, immutable content/recipient/resolution guard, live-session service-only RPC
- [x] Fastify/Edge/OpenAPI parity, 128 KiB fail-closed와 전 응답 `Cache-Control: no-store`; 95 paths / 102 operations
- [x] PR #108 독립 QA, required GitHub `application` / `migration` PASS, `dev@bdb4b25d33aa09efe99112636c60c4da52336318` 병합
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

### #109 Notification Catalog / Grouping / Writer source gate — source/dev 완료, production 미승격

- [x] 기존 41 migrations 수정 0, 42번째 append-only migration 1개
- [x] 28-category source-controlled catalog와 typed actor/event-family/source/deep-link provenance
- [x] 최초 server event 기준 fixed 10분 grouping과 공개 UUID `groupId`
- [x] 자기 행동 push 억제, 비활성·임시 비밀번호 수신자의 inbox/history 보존과 push fail-closed
- [x] legacy outbox 보존·worker 영구 제외, 신규 typed delivery outbox만 후속 #111 입력
- [x] 모든 현행 writer 원자 helper 전환, initial/reinspection admin fanout, manual-checkout 중복 제거
- [x] source entity/terminal command exact resolver와 bounded capability-expiry resolver RPC source
- [x] Fastify/Edge/OpenAPI `deepLink`/`groupId` parity; 128 KiB/cursor/no-store 유지
- [x] 로컬 검증: DB/RLS 1,969건, Edge 172건, application 266건, 전체 concurrency,
  Python 46건·ruff/format/mypy/generated/package, DB lint와 로컬 Advisor warning/error 0
- [x] PR #114 독립 QA, required GitHub `application` / `migration` PASS, `dev@0e1c8756a5201440ff5b33bdd7e33b2ba93ba657` 병합
- [ ] release/main 승격, production migration/Edge 배포, hosted role/mutation smoke

### #110 Encrypted Web Push Subscription source gate — source/dev 완료, production 미승격

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/push-subscriptions` | active password-complete admin/maid self + live session | ✅ | ✅ | ✅ | ❌ | ❌ |
| [x] | `POST /v1/push-subscriptions/{subscriptionId}/retire` | active password-complete admin/maid owner + live session | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] 기존 42 migrations 수정 0, 43번째 append-only migration 1개
- [x] logical/current, immutable revision, AES-256-GCM secret envelope, 최소 lifecycle event, durable 10/min profile limiter 분리
- [x] live session당 active 1, profile당 최대 5, active endpoint digest 전역 1; 자동 LRU·교차 profile 이전 없음
- [x] exact replay와 expected subscription ID/version CAS rotation, stale fail-closed, retire crypto-shred·no resurrection
- [x] private raw table/helper PUBLIC/anon/authenticated/service_role 권한 차단, app-owned RPC만 service_role EXECUTE
- [x] Fastify/Edge/OpenAPI strict 2 paths/2 operations, no-store·128 KiB, raw endpoint/key/digest/session 비노출; 97 paths / 104 operations
- [x] PR #115 독립 QA, required GitHub `application` / `migration` PASS, `dev@6e22eaf1150063511356db03d9845c5bb5175723` 병합
- [x] #111 delivery target/attempt/claim/retry source/dev 및 #112 VAPID/provider HTTP source/dev
- [ ] #112 Function Secrets/Cron/Vault/production Edge 배포·hosted 활성화

### #111 Notification delivery worker source gate — source/dev 완료, production 미승격

- [x] Issue #111 정책 댓글 `5638391812`: permit 선형화, 24시간 TTL, no-subscription terminal, max8/2분 lease/backoff, operator-blocked, local retirement
- [x] 기존 43 migrations 수정 0, 44번째 append-only migration 1개
- [x] immutable typed outbox intent와 private job/target/attempt/result/permit/event/heartbeat 분리
- [x] 최초 fanout exact subscription/version/revision snapshot, envelope 비복제, stable `notificationId` payload
- [x] provider-neutral 45초 worker core와 bounded service-only claim/context/permit/settle/resume/purge RPC
- [x] 기존 developer database-status operation에 bounded backlog/heartbeat 추가; 공개 97 paths / 104 operations 유지
- [x] PR #116 독립 QA, required GitHub `application` / `migration` PASS, `dev@8fb0886214ef8287f15f2ad2fd149cd271340834` 병합
- [x] #117 실제 claim/resume 교차 동시성 회귀 `dev@cc15f47a74959943cf72a95e69da278243020f15` 병합
- [ ] #112 hosted VAPID/Cron/invoke secret/production 활성화

### #112 VAPID Web Push source gate — source/dev 완료, production 미승격

- [x] Issue #112 정본 정책 댓글 `5641979910`과 RFC 8030/8291/8292 source 계약 반영
- [x] 기존 44 migrations 수정 0, 45번째 append-only VAPID revision binding migration 1개
- [x] authenticated active/password-complete admin·maid 전용 public-key config 1 path/operation 추가; source/dev 계약 **45 migrations / 98 paths / 105 operations**
- [x] config→register 10분 actor/profile/live-session HMAC binding proof; current/prior overlap replay와 removed/expired/tampered scope fail-closed
- [x] actual P-256 curve/pair 검증, 최대 5개 public/private ring exact identity 대조, config drift durable degraded heartbeat
- [x] provider allowlist·manual redirect·bounded status mapping·generic 3 KiB payload·stable notification ID 구현
- [x] distinct invoke secret의 전용 `notification-delivery` Edge source와 33/39/45초 budget 연결
- [x] PR #119 승인 exact head `eb243c54ebf24cd932d70cb1c6423fa4f319c050` 독립 QA P0/P1/P2 0·98/100, required GitHub `application` / `migration` PASS, `dev@dfc98b1474f9f890851d49bd904869181d0d7880` 병합
- [ ] Issue #112 OPEN 유지: release/main 후 Function Secrets·Edge deploy·Vault/pg_cron/pg_net·5회 success·real-device hosted smoke

### #85 사진 purge/reconciliation source gate — source/dev 완료, production 미승격

- [x] accepted `uploaded_at + 168h`와 never-accepted orphan authority 분리
- [x] room/date folder durable retirement, reserve→identity barrier, raw locator clear + private digest tombstone
- [x] accepted → orphan → folder 순서와 blocked 전환 포함 전체 claim 10/run·45초 absolute deadline(DB/OAuth/Drive/settle/heartbeat), DB `nextAttemptAt` retry
- [x] 기존 developer database/runtime status에 bounded count·heartbeat와 secret configured boolean만 추가
- [x] public business/OpenAPI path·operation **67/72 유지**
- [x] fresh 33 migrations와 DB/RLS 1,404건 PASS
- [x] exact head `93524b680608fa54a2be2d9f826ba960a621dc12` 독립 보안/API 리뷰 P0/P1=0
- [x] exact head required GitHub application/migration PASS
- [x] PR #90 `dev` squash 병합 — `92c0f97b412e9a4ccf41934b6924bc59ca2f9dd2`
- [ ] release/main 후 production migration·secret·Edge 배포·Google hosted purge smoke

production DB/Edge/Pages/Google Drive에는 이번 feature 작업으로 변경을 가하지 않았다. 운영 snapshot은 **19 migrations / 39 paths / 43 operations** 그대로다.

### #30 사진·제출 기반 source gate

개발 시작 기준은 `dev@9ed843ca570d1fccaa95fdb672fb8dc20fe91107`이며,
PR #81 병합 결과는 `dev@a4f8cb5b3c551b6df641491f5ac02c209d71f26d`이다.
[사진·제출 기반 계약](./PHOTO_SUBMISSION_BASE.md)의 모델/내부 검증만 source/dev 완료했으며
새 HTTP route, Drive 업로드, 전체 제출·검수 command는 이번 범위가 아니다.
production migration/Edge/사용 가능 상태와 OpenAPI 39 paths / 43 operations는 변경하지 않는다.

- [x] slot/template/target snapshot 및 attempt별 evidence·불변 submission binding 구현
- [x] 로컬 fresh 30 migrations / DB 1,020 tests / photo 포함 동시성 / Edge 127 / application 136 / Python 36 / DB lint·Advisor 검증
- [x] exact-head required CI application/migration PASS — [run 34252427375](https://github.com/wrongstory/room-management-system-backend/actions/runs/34252427375)
- [x] 독립 보안/계약 리뷰 P0/P1=0 — [review 5144510401](https://github.com/wrongstory/room-management-system-backend/pull/81#pullrequestreview-5144510401), exact `d43feafc3c64e0b722843dd1ee08d31393d6b6b0`
- [x] Codex 위임 평가96/100·명시적 source/dev 병합 허가 — [comment 5588646783](https://github.com/wrongstory/room-management-system-backend/pull/81#issuecomment-5588646783)
- [x] [PR #81](https://github.com/wrongstory/room-management-system-backend/pull/81) dev squash 병합 — `a4f8cb5b3c551b6df641491f5ac02c209d71f26d`
- [ ] 별도 release/main 및 production migration·실제 업로드/제출 기능·hosted 검증

승인 head와 병합 결과의 tree는 `14cd83310840570bb291ef44689c41ea7e128b7f`로 동일하다.
독립 QA·GitHub 리뷰·required CI·Codex 위임 허가·병합 증거를 구분한다. 미설정/legacy 빈 snapshot은
완전한 사진 증빙으로 간주하지 않으며, #7 물리 완료에 사진 선행조건을 추가하지 않는다.
후속 #83 / PR #86, #84 / PR #88, #85 / PR #90과 #31 / PR #91도 source/dev 완료했으며 현재 본선은 #8 earning/payroll 정산이다. #30 내부 모델 검증과 #84의 실제 decoder·HTTP adapter 합성 검증은 별개이며, 운영 Google 업로드/삭제 검증 완료로 표현하지 않는다.

### #83 사진 업로드 작업 원장 source gate — source/dev 완료, production 미승격

개발 시작 기준(당시 base)은 `dev@b7cf567238d162a80841c4dcbca94fc23ee82a01`이고,
[PR #86](https://github.com/wrongstory/room-management-system-backend/pull/86)의 dev squash 결과는
`cf91753de8b80ce5abef3c8dc0aa8bf5e85b479b`이다. append-only
`photo_storage_operations` migration은 private operation/provider object/current state/acceptance/event/rate-limit를
분리하고, raw key 대신 scoped digest와 canonical request hash를 사용한다. claimant digest+monotonic fence로
동시 worker를 분리하며 accepted 이력은 clear·재촬영·인계·계정/session 폐기 뒤에도 compensation 대상이 아니다.

- [x] #9를 #83(DB 작업 원장) → #84(Drive 업로드·열람) → #85(7일 purge/orphan)로 분리
- [x] operation당 provider object 1개, slot provider-call in-flight 1·actor 같은 in-flight 8·begin 30/min·5분 lease/최대8회 기술 상한 구현
- [x] provider-success와 business acceptance 분리, 최신 actor/session/capability/photo CAS finalize 구현
- [x] safe operation/audit projection에서 raw key/hash/claim/provider locator 제외
- [x] 전체 로컬 검증: 500 rotating key, DB lock 대기 중 lease 만료, 실제 handover↔finalize 양순서를 포함한 동시성 검증
- [x] exact-head 독립 QA **P0 0 / P1 0 / P2 0, 96/100** — `3dfbb70176533a69257c68c2b2af2ee19cc9bd22`, [PR #86 리뷰](https://github.com/wrongstory/room-management-system-backend/pull/86)
- [x] exact-head required GitHub `application` / `migration` PASS — [run 34258980846](https://github.com/wrongstory/room-management-system-backend/actions/runs/34258980846)
- [x] Codex 위임 평가96/100·명시적 source/dev 병합 허가 — [comment 5589446371](https://github.com/wrongstory/room-management-system-backend/pull/86#issuecomment-5589446371)
- [x] PR #86 `dev` squash 병합 — `cf91753de8b80ce5abef3c8dc0aa8bf5e85b479b`
- [ ] 별도 release/main 및 production migration·hosted 검증
- [x] #84 실제 JPEG/WebP bytes·magic/MIME/EXIF 검증, Google OAuth/Drive HTTP adapter, 업로드·열람 API source/dev 완료 — PR #88; 운영 자격증명·Google/hosted smoke는 미완료
- [x] #85 정확히 168시간 삭제 worker source/dev 완료 — PR #90 / `dev@92c0f97`
- [ ] #85 운영 provider/hosted purge 검증

이번 source는 공개 upload/read route를 추가하지 않으므로 OpenAPI는 **63 paths / 68 operations**를 유지한다.
승인 exact head와 병합 결과의 tree는 `9e7898af7de2d3025fe53ca848225cbbaa35b5fa`로 동일하다.
독립 QA·GitHub COMMENTED 리뷰·required CI·Codex 위임 승인·병합 증거는 구분한다. 후속 #84, #85와 #31도 source/dev 완료했으며 현재 본선은 **#8 earning/payroll 정산**이다.

### #84 Drive 업로드·열람 source gate — source/dev 완료, production 미승격

개발 시작 기준은 `dev@46c5f91e968556d1a13ecee398e98e8062839508`이고,
[PR #88](https://github.com/wrongstory/room-management-system-backend/pull/88)의 승인 exact head는
`7a3cfec2994b02569b3004c6f94c051c581cb213`, dev squash 결과는
`520abe7b80501ed9a4573e2251b9b640476d87b5`다. 최신 통합 source는 **32 migrations / 67 paths / 72 operations**이며
승인 head와 병합 결과의 tree는 `2e430f83ba6f8c5e46166d3f6f5d5e991781b3ba`로 동일하다. source 승인·병합은 production 배포 증거가 아니다.

| API | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|
| `GET /v1/attempts/{attemptId}/photo-slots` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `POST /v1/attempts/{attemptId}/photo-slots/{slotId}/upload` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /v1/photo-uploads/{operationId}` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /v1/photos/{photoId}/content` | ✅ | ✅ | ✅ | ❌ | ❌ |

- [x] 실제 local Edge v1.74.3 oneshot worker 합성1280×960/2048×2048 JPEG/WebP cold-start CPU/메모리·20MB bundle gate 완료(운영 hosted smoke 아님; PHOTO_STORAGE evidence 참고)
- [x] 전체 local DB/RLS/concurrency·Edge/Fastify·OpenAPI·Python 계약 최종 검증
- [x] exact head 독립 QA **P0 0 / P1 0** — PR #88 승인 head 기준
- [x] exact head required GitHub `application` / `migration` PASS — [run 34269466800, attempt 2](https://github.com/wrongstory/room-management-system-backend/actions/runs/34269466800/attempts/2)
- [x] Codex 위임 source 승인 및 PR #88 dev squash 병합 — `520abe7b80501ed9a4573e2251b9b640476d87b5`
- [ ] 별도 release/main → 운영 OAuth 설정·Google/hosted role smoke
- [ ] #85 7일 purge/backlog/실패 감시 운영 gate

비차단 P2인 admission quota의 장기 전체 이력 SUM 비용은 별도 hardening 후속으로 유지한다.
같은 head의 첫 CI 시도에서 Python Qt 테스트가 exit139로 종료됐고 진단 재실행은 PASS했다.
이는 일시적 실패의 재현 여부를 확인한 결과이며 Qt/thread lifecycle 결함을 수정·해결했다는 증거가 아니다.

원문307200 bytes, 사전 admission/총quota, JPEG/WebP 실제 decode·metadata 제거·최종SHA, 사전발급 provider identity,
accepted 보존/fenced compensation, 원본 반환 직전 재인가가 이번 범위다. 실제 Google 계정 호출은 수행하지 않았고,
파일 상태 accepted는 submission/검수/입실 준비 완료를 뜻하지 않는다. Python developer 콘솔에는 업로드/원본 기능을 추가하지 않는다.
합성 metadata와 provider acknowledgement DB 테스트를 실파일·Drive 검증 완료로 표현하지 않는다.
production DB/Edge/Pages/Google 자격증명 변경은 없다. 기존 production snapshot은 **19 migrations / 39 paths / 43 operations**로 유지하며 이번에 운영을 재검증하지 않았다.

#10 알림/Outbox source는 #108~#112까지 dev 완료이며 #112 운영 활성화만 별도 승인으로 남는다.
다음 source critical path는 **#73 예약 FK → #34 Actions runtime → #46 password replay → #69 PIN Domain Phase A**다.
#12 Backup/Recovery는 병행하고, #13 frontend/generated client/browser E2E는 release와 프런트 정본 대조 뒤 진행한다.
#44 Python Windows artifact·Phase B/C는 별도 운영도구 트랙으로 유지한다.
최신 사용자 위임에 따라 독립 QA·required CI·in-scope P0/P1=0 등 hard gate를 모두 통과하고
Codex 평가가 90/100 이상이면 source/dev 병합을 승인할 수 있다. 미달/차단 시 리뷰를 남기고
사용자 승인을 요청한다. exact head 변경 시 재검토한다. production/main/release 권한은
포함하지 않는다. 상세 기준은 [개발 오케스트레이션](./DEVELOPMENT_ORCHESTRATION.md)을 따른다.

## 16. 이 문서 갱신 규칙

API 관련 PR은 아래 조건 중 하나라도 발생하면 `docs/API_STATUS_MATRIX.md`를 같이 수정한다.

- route 추가/삭제/rename
- 권한 역할 변경
- DB/RPC 신규 구현 또는 제거
- Fastify → Edge adapter 이식
- OpenAPI 계약 변경
- production Edge 배포/rollback
- migration/secret/account 선행조건 충족으로 실제 사용 가능 상태 변경
- API가 별도 Issue로 분할되거나 구현 순서가 변경됨

### 상태 변경 원칙

- DB migration/RPC만 존재 → `DB/RPC ✅`, Edge는 ❌
- Fastify route만 존재 → `Fastify HTTP ✅`, production 사용 가능으로 표시하지 않음
- Edge source가 feature/dev에만 존재 → `Edge source ✅`, Production ❌
- `main`에 존재하나 아직 Supabase 재배포 전 → Edge source ✅, Production ❌
- production Function readback + 기본 HTTP smoke 통과 → Production ✅
- production에 있어도 role/account/secret/client 조건 또는 hosted smoke 미충족 → 현재 사용 ⚠️ 또는 ⛔
- 실제 role별 hosted smoke까지 통과 → 현재 사용 ✅
- `/docs`처럼 route는 배포됐지만 hosted platform 제약으로 목적대로 사용할 수 없으면 Production Edge ✅ / 현재 사용 ⚠️로 표시

Swagger/OpenAPI에 표시된 operation 수와 이 문서의 **Production Edge ✅** endpoint 수가 다르면 배포 drift로 보고 확인한다.

## 17. 연결 문서·Issue

- Roadmap: #14
- v0.2.0 release: #24
- Supabase runtime decision: #35
- Edge runtime PoC: #36
- developer 운영 API: #43 / PR #48
- Python 운영도구: #44
- self password retry 후속: #46
- GitHub Pages Swagger: #49 / PR #50
- Availability Edge parity: #51 (P0)
- Reservation Edge parity: #52 (P1)
- Room Edge parity: #53 (P1)
- Assignment Core: #25
- `docs/AI_BACKEND_PRODUCT_GUIDE.md`
- `docs/FRONTEND_API_INTEGRATION.md`
- `docs/DEVELOPER_OPERATIONS_API.md`
- `docs/EDGE_RUNTIME_POC.md`
- `docs/RELEASE_V0.2.0.md`
