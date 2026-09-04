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
  └─ /v1/reservations/*

/functions/v1/reservation-scheduler
  └─ scheduler 전용 POST
```

따라서 메이드 API를 추가한다고 `maid` Function을 새로 만드는 것이 아니라 기존 `api` Function에 route/adapter를 추가하고 다시 배포한다.

## 2. 현재 기준 스냅샷

최종 확인: **2026-09-03 KST**

- 운영 승인 source: `main@cd635b116f451a39481f496f2bd368776385a409`
  - v0.2.0 통합 source 승격: `main@2a683fa`
  - diagnostics zero-byte hosted 호환 hotfix: PR #64 / `main@cd635b1`
- 개발 통합 source 기준: `dev@c7e0b03dea309e09b720184975413fd5d42bc527`
- 운영 migration: **19건** (`developer_operations_projections`, `actor_activity_audit_contract` 포함)
- 운영 Edge Functions readback:
  - `api` version 9 — ACTIVE, source identity는 위 승인 `main` 기준
  - `reservation-scheduler` version 8 — ACTIVE, source identity는 위 승인 `main` 기준
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
- [ ] PR 독립 보안/API 리뷰 P0/P1=0
- [ ] PR `dev` 병합
- [ ] release/main 승격 후 production migration·Edge 배포·hosted admin smoke

## 13. 아직 개발하지 않은 후속 API 영역

아래는 Edge 누락이 아니라 **기능/API 자체가 아직 후속 개발 대상**이다. 실제 route는 각 Issue 구현 PR에서 확정하고 이 문서를 갱신한다.

| 체크 | 영역 | 상태 | 관련 Issue | 비고 |
|---|---|---|---|---|
| [x] | 청소 담당 배정·revision·현재 pointer·순서 | source/dev 완료 | #25 | production 미승격 |
| [ ] | 배정 저장 시 가능일 재검증·부분 알림 | feature 구현·검증 중 | #26 | 위 source gate 참조 |
| [ ] | 시작 전 재배정·취소 요청·관리자 결정 | 미개발 | #27 | #4 분할 |
| [ ] | 오늘/내일 activation·rollover | 미개발 | #28 | #4 분할 |
| [ ] | 배정 preview algorithm | 미개발 | #29 | #4 분할 |
| [ ] | 현장 수행·offline lease·handover/conflict | 미개발 | #7 | 배정 이후 |
| [ ] | 사진 template/slot snapshot·submission version | 미개발 | #30 | 사진 전 단계 |
| [ ] | Google Drive 업로드·조회·7일 영구삭제 | 미개발 | #9 | Drive only / <=300KiB |
| [ ] | 제출·검수·재청소 | 미개발 | #31 | #30/#9 이후 |
| [ ] | earning/payroll 정산 API | 미개발 | #8 | append-only |
| [ ] | notification/outbox/Web Push | 미개발 | #10 | domain event 연계 |
| [ ] | backup/restore 운영 자동화 | 미개발 | #12 | 핵심 체인과 병행 |
| [ ] | frontend generated client / browser E2E | 미개발 | #13 | OpenAPI 정본 사용 |

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
21. [ ] **#26 Assignment Commit source gate** — 이 PR의 독립 리뷰·`dev` 병합 대기

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
