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
  ├─ /v1/room-pin-sheet-sync/status
  ├─ /v1/room-pin-sheet-sync/full-resync
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

/functions/v1/photo-purge                 # production bundle 배포; Google/Cron activation 별도
  └─ 사진 purge worker 전용 POST

/functions/v1/notification-delivery       # production bundle 배포; provider/invoke/Cron 비활성
  └─ Web Push delivery worker 전용 POST

/functions/v1/room-pin-sheet-sync         # production bundle 배포; Google target/secret/ACL/Cron activation 별도
  └─ PIN Sheet incremental worker 전용 POST
```

따라서 메이드 API를 추가한다고 `maid` Function을 새로 만드는 것이 아니라 기존 `api` Function에 route/adapter를 추가하고 다시 배포한다.

## 2. 현재 기준 스냅샷

production 최종 source/readback evidence: **2026-09-20 KST** (Issue #220, PR #221 및 Pages run `35481531782`). v0.4.0 release source 기준은 PR #219의 `dev@9c197ad12ed5cb45db0b451f69f9f91053b139d7`이며, 실제 production source는 아래 `main` exact SHA로 고정한다.

- 현재 GitHub·production API source 정본: `main@80f935016d5581d500136fba29c206f6ee797bc0`.
  - PR #221의 v0.4.0 release source가 `main`에 병합됐고 승인 release tree와 병합 tree가 일치한다.
  - tag/GitHub Release 발행 여부와 `main`/production source 배포 완료는 별도 상태로 관리한다.
- production은 **73 migrations / `api` ACTIVE v17 / OpenAPI 0.4.0 120 paths / 130 operations**다. 기존 56개 이력과 업무 원장을 보존한 채 manifest의 57~73을 순서대로 적용했고, public RLS 49/49, FK 384건 위반 0, DB lint error 0을 read-only로 확인했다.
- v0.4.0의 공개 `/health`, `/docs`, `/openapi.json`은 HTTP 200이다. Health와 OpenAPI 계약은 직접 확인했지만 보호 API의 역할별 hosted read와 실제 예약·PIN mutation은 이번 배포에서 재실행하지 않았으므로 별도 완료로 표시하지 않는다.
- #187 Phase C는 PR #190으로 `dev@1571565b9e361e890cba6502aa3acbf9a08816c3`에 source/dev 병합 완료했다. 현재 개발 정본은 기존 61개를 수정하지 않은 **62 migrations / OpenAPI 113 paths / 121 operations**이며 `reservation_stays`/`stay_room_segments`, DURING_STAY preview·commit, source-room checkout cleanup 및 미래 PIN cutoff를 포함한다. `main`/production에는 아직 반영하지 않았으므로 운영 수치와 사용 가능 상태는 기존 production readback을 유지한다.
- #137 Phase C의 API와 `room-pin-sheet-sync` bundle source는 production에 반영됐다. 다만 hosted mapping, secret, ACL, Google 호출, Vault/Cron과 positive full-resync smoke는 별도 activation gate이므로 현재 사용은 ⚠️다. recovery는 immutable self-FK root와 exact execution fence를 함께 검증하고, 성공 시 같은-root 과거 block을 최대 32건만 정리한다. 초과/부분 정리와 recovery `SNAPSHOT_STALE`은 healthy/success 없이 operator-blocked로 유지된다.
- 아래 기능별 source gate 절은 병합 당시의 이력을 보존한다. 현재 production source 포함 여부는 이 §2의 73 migrations / 120 paths / 130 operations와 5개 Edge bundle snapshot을 우선하고, hosted provider·Google·Cron 및 positive mutation 사용 가능 여부는 별도 gate로 판정한다.
- #85는 PR #90으로 source/dev 병합 완료했다. accepted/orphan/folder purge worker와 45초 absolute deadline, blocked false-green 방지 계약은 개발 정본에 있으며 production Google/Cron hosted 검증은 별도 release gate다.
- #31은 PR #91로 source/dev 병합 완료했고 해당 API source는 현재 production `api` bundle에 반영됐다. 당시 개발 정본은 **34 migrations / 74 paths / 80 operations**이었다. hosted 역할별 positive mutation smoke는 미확인이므로 현재 사용은 ⚠️다.
- #93/#95는 PR #95로 source/dev 병합 완료했다. 개발 통합 계약은 **35 migrations / 76 paths / 82 operations**이며 conceptual OPEN 조회, OPEN→PAYING 잠금과 4개 payroll table의 active+비밀번호 변경 완료+admin/maid-self RLS를 포함한다.
- #96은 PR #97로 source/dev 병합 완료했다. bounded keyset pagination과 signed cursor, nested preview/continuation, 128 KiB 응답 상한을 포함한 당시 개발 통합 계약은 **36 migrations / 77 paths / 83 operations**다. 해당 API source는 production `api` bundle에 반영됐지만 hosted 역할별 read/mutation smoke는 미확인이다.
- #94는 2026-09-10 Decision Issue로 정책 승인됐다. #100~#103은 각각 PR #104/#105/#106/#107로 **source/dev 병합 완료**했다. #108은 PR #108, #109는 PR #114, #110은 PR #115, #111은 PR #116, #112는 PR #119로 source/dev 병합 완료했고 #117 concurrency 회귀도 통합됐다. 이 알림 트랙의 완료 당시 snapshot은 **45 migrations / 98 paths / 105 operations**다. Issue #112의 hosted 활성화는 pending이며 main/recovery/production은 변경하지 않았다.
- #131은 현재 **production 56-migration historical snapshot**에 반영된 #69 PIN Phase A다. 프런트는 선행 0을 보존한 4~8자리 숫자 부분만 보내고 서버가 current room number를 다시 확인해 canonical credential을 암호화한다. 이 운영 snapshot은 private immutable revision/current pointer, physical-change mismatch lifecycle과 authoritative maid access lease를 change/reveal 양쪽에 사용한다. #194의 64번째 source candidate는 물리 PIN change의 exact in-progress access-lease 경계는 유지하되 reveal만 exact current/notified assignment entitlement + 30초 lease로 대체하며 아직 production 사용 가능 계약이 아니다. 양쪽 모두 PIN 평문·암호문을 public table, audit, outbox, URL, error, 로그에 저장하지 않는다.
- #140은 빈 DB의 PIN 미설정 상태를 예약 차단에서 분리하고, secret 기반 active-admin bounded bootstrap을 추가한다. 예약은 PIN 경고와 무관하게 가능하지만 실제 체크인·PIN 접근은 verified 전까지 차단한다. legacy `pin-sync-events`는 current PIN을 만들지 못하므로 신규 프런트에서 사용하지 않는다.
- #184 현재 시각 객실 projection, #187 Phase A~C 예약 임박·체크인 전 변경·투숙 중 이동, #180 `extra-proof` 0~10장 collection source는 v0.4.0 production DB/API에 포함됐다. 각 기능의 실제 mutation smoke와 프런트 사용 완료는 별도다.
- 현재 critical path는 **Issue #222 운영 상태·release gate의 `dev` 역반영 → 보호 API 역할별 hosted read → 안전 fixture가 있을 때만 예약·PIN lifecycle mutation smoke**다. 안전 fixture가 없으면 임의 production 데이터를 만들지 않는다.
- 운영 migration: **73건**
- 운영 Edge Functions readback:
  - `api`, `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync` 5개 bundle 배포
  - `api`는 ACTIVE v17이며 version은 runtime revision metadata일 뿐 source identity는 `main@80f9350...`로 판정한다.
  - Issue #152에서 `notification-delivery` zero-byte 요청을 의도한 503 fail-closed로 보강했으며, provider invoke secret/credential 미활성 상태를 성공으로 표시하지 않는다.
  - version 증가는 source 변경 외 Function Secret 환경 revision도 포함하므로 source identity로 사용하지 않는다.
- production OpenAPI: **120 paths / 130 operations**, version `0.4.0`
- Issue #228 source 후보는 기존 production 73개 migration을 수정하지 않는 **74 migrations / 121 paths / 131 operations**다. 관리자 전용 occupancy correction과 canonical segment 기반 점유, 객실 문제 전용 `allocationBlocked`, 전체 readiness인 `allocationReady`를 포함하며 production DB/Edge에는 아직 적용하지 않았다.
- production `/health`, `/docs`, `/openapi.json` HTTP 200과 OpenAPI readback은 확인됐다. 전체 hosted role/domain positive mutation smoke는 안전한 fixture 부재로 미완료이며, Issue #112/#137의 provider/Google target·credential·Vault/Cron/실기기 smoke도 별도 activation gate다.
- GitHub Pages portal은 run `35481531782`에서 `main@80f9350...`의 fail-closed build를 사용해 production Edge와 0.4.0 / 120 / 130 parity를 확인했다. `portal-manifest.json`의 SHA-256은 공개 `openapi.json` artifact와 일치한다. build 시각 metadata 때문에 raw production JSON과 artifact byte hash가 같다는 뜻은 아니다.
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
- [x] 승인된 production source `main@80f935016d5581d500136fba29c206f6ee797bc0` snapshot 반영
- [x] production Edge OpenAPI 0.4.0, 120 paths / 130 operations와 Pages parity 확인 — Issue #222
- [x] GitHub Pages `workflow_dispatch` 수동 실행 — run `35481531782`
- [x] 공개 portal과 same-origin OpenAPI snapshot HTTP smoke
- [x] Pages와 production Edge의 path set·operationId set 동일

## 4. Auth API

developer/admin/maid의 실제 hosted login과 role 경계를 검증했다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/auth/login` | all accounts | ✅ | ✅ | ✅ | ✅ | ✅ | developer/admin/maid hosted login PASS |
| [x] | `GET /v1/auth/me` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | 최신 role/session hosted smoke PASS |
| [x] | `POST /v1/auth/password` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | #46 safe receipt 기반 timeout/response-loss replay source도 v0.4.0 production에 포함 |

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
| [x] | `GET /v1/developer/database-status` | developer only | ✅ | — | ✅ | ✅ | ✅ | production migration 56 readback; drift/RLS/RPC 정상 |
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

### #137 PIN Sheet 운영 status/full resync — production bundle 반영, hosted activation 미완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/room-pin-sheet-sync/status` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | API와 worker bundle 배포; hosted role/config read smoke 미확인, 현재 config invalid가 과거 success보다 우선 |
| [ ] | `POST /v1/room-pin-sheet-sync/full-resync` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | strict `{expectedVersion}` + Idempotency-Key; Google target/secret/ACL/Cron과 positive repair smoke 미완료 |

- [x] 51번째 append-only migration; 기존 50 migrations 무수정
- [x] environment/project/spreadsheet/tab exact target digest를 request/run/claim에 immutable binding
- [x] Sheet 삭제·정렬·변조를 DB 정본으로만 `A1:H122` repair; Sheet→DB 0
- [x] retryable failed full run 중복 차단, incremental/full claim 1-winner fence, provider marker 이전 outbox만 안전 supersede
- [x] requested/succeeded developer audit safe summary와 PIN/envelope/credential/token/raw response 비노출
- [x] independent QA와 required CI 및 release/main source·54번째 production migration·API/worker bundle 반영
- [ ] production mapping/secret/ACL/Google/Vault/Cron activation과 hosted role/positive repair smoke

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
- [x] KST 현재/다음 주 any-day 직접 제출·변경, 일요일 primary reminder, CAS version, Idempotency-Key 계약 유지
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

#25는 미통보 `draft_assigned`까지만 소유한다. source gate, `dev` 병합, production migration과
`api` bundle source 반영은 완료됐으나 hosted 역할별 positive mutation smoke는 미확인이다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/assignments?serviceDate=...` | maid / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | #213 카드 snapshot 계약 추가; production hosted card read smoke 미확인 |
| [x] | `GET /v1/assignments/{cleaningTargetId}/history` | maid / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | #213 과거 notified 객실 snapshot 보존; production hosted smoke 미확인 |
| [x] | `POST /v1/assignments/drafts` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ | positive mutation fixture 미확인; notification/outbox/attempt 없음 |

### #25 source gate

- [x] 기존 `cleaning_targets`·`cleaning_assignments` 재사용 설계
- [x] service date/access window snapshot과 current maid/date/sequence unique 구현
- [x] target row lock + assignmentVersion CAS + scoped request hash/idempotency 구현
- [x] admin write, maid own read, developer/direct DML 차단 구현
- [x] OpenAPI 3 operation·한글 연동 계약 반영
- [x] #213 카드용 immutable target snapshot·이월·attempt/submission projection 및 Fastify parity
- [x] local Edge/application/DB/concurrency 전체 검증
- [x] feature PR 독립 보안/API 리뷰 P0/P1=0
- [x] feature PR `dev` 병합 (`dev@c7e0b03` 기준)
- [x] release/main 승격 후 production migration·Edge source 배포
- [ ] hosted role read와 positive mutation smoke

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
| [x] | `GET /v1/assignments/commit-impact?serviceDate=...` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ | side-effect 없는 fingerprint preflight; hosted role smoke 미확인 |
| [x] | `POST /v1/assignments/commit` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ | positive mutation fixture 미확인; 선택 부분집합 atomic commit |

### #26 source gate

- [x] KST 오늘/내일 및 source별 현재 상태·일정 재검증 구현
- [x] impact fingerprint + assignment/availability version CAS 구현
- [x] `assignment.commit_notify` scoped idempotency와 partial all-or-nothing 구현
- [x] notification/private outbox/`assignment.notified` safe audit 구현
- [x] admin-only Edge route·한글 OpenAPI·Python generated audit contract 반영
- [x] local fresh 22 migrations·DB/RLS 330건·Edge 69건·계획 경합 concurrency·DB lint 최종 재검증
- [x] PR #68 독립 보안/API 리뷰 P0/P1=0
- [x] PR #68 `dev` 병합 — `6f8d84c8c9d1a659fdebb142b0cad424f590572a`
- [x] release/main 승격 후 production migration·Edge source 배포
- [ ] hosted admin read/positive mutation smoke

### #27 Pre-start Change — production source 반영, hosted smoke 미확인

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/assignments/{cleaningTargetId}/change` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/assignments/{cleaningTargetId}/unassign` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/assignments/{cleaningTargetId}/cancellation-requests` | maid self | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `GET /v1/assignment-change-requests` | admin / maid self | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/assignment-change-requests/{requestId}/decision` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |

- [x] immutable request/source와 pending/decision/superseded lifecycle, scoped RLS/RPC
- [x] 재배정/해제 CAS, non-superseded attempt 차단, 원 담당·planned checkout identity 보존
- [x] 실제 `create_manual_cleaning_request`의 `stayover_request + stayover` 일정 축소와 active reservation 점유 경계
- [x] draft 무통보 / notified old resolve + new notice/outbox/audit 원자 처리
- [x] 감사 4개 event 및 한국어 OpenAPI/Python generated contract
- [x] local fresh 23 migrations·DB/RLS 426건·Edge 76건·application 96건·Python 34건·동시성·DB lint/로컬 Security Advisor
- [x] exact head 전체 CI 최종 확인
- [x] #27 독립 보안/API 리뷰 P0/P1=0
- [x] #27 PR `dev` 병합 — `dev@b529614b287e3c69750f0e91f3ac539b8e8e33b8`
- [x] release/main 후 production migration·Edge source 반영
- [ ] hosted role read/positive mutation smoke

신규 migration `20260904154536_assignment_prestart_change.sql`은 로컬 23번째다.
source OpenAPI는 49 paths / 53 operations이며 운영 39 / 43 snapshot은 변경하지 않았다.
중단·인계(#7), PIN/Sheets(#69), 실제 push worker(#10)는 제외한다.

### #28 Attempt Activation — scheduler bundle 반영, lifecycle positive smoke 미확인

#28은 public 업무 API를 추가하지 않는다. `reservation-scheduler`의 기존 secret/exact-admin 경계가
예약 전이 뒤 service-owned `process_due_assignment_lifecycle` RPC를 호출하며, 대상별 core는 같은
reservation-command → target → assignment 잠금 순서를 사용한다.

| 체크 | Command / 기능 | 권한 | DB/RPC | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| [x] | 오늘 notified → scheduled attempt | scheduler + active admin actor | ✅ | ✅ | ✅ | ⚠️ |
| [x] | 내일/checkout materialization gate | scheduler + active admin actor | ✅ | ✅ | ✅ | ⚠️ |
| [x] | unassigned/notified attempt-0 rollover | scheduler + active admin actor | ✅ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 후 production migration·scheduler bundle 재배포
- [ ] #28 lifecycle effect를 만들 수 있는 hosted positive smoke

신규 migration `20260905002657_assignment_attempt_activation.sql`은 로컬 24번째다. public
OpenAPI operation은 추가하지 않아 source 49 paths / 53 operations를 유지한다. 실제 메이드 시작,
중단·인계(#7), PIN(#69), 자동 배정(#29)은 포함하지 않는다.

### #29 Assignment Preview — production source 반영, hosted smoke 미확인

PR #72는 `dev@8bdb5db2cd65359adca13e132959bcdf5f808324`에 병합됐다.
source/dev 완료와 운영 배포는 별도 gate다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/assignments/preview` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `GET /v1/assignment-preview/duration-policy` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/assignment-preview/duration-policy` | admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |

- [x] confirmed versioned duration 정책 / 데모·fallback·confirmed seed 없음
- [x] STABLE snapshot + 순수 bounded optimizer / 기존 고정 부하와 reclean 원 maid 보존
- [x] count → fee spread/deviation → route → seed 최종 동률 비교
- [x] 오늘/내일·source schedule·actual interval 재검증 / fingerprint와 expected versions
- [x] 한국어 OpenAPI / safe duration policy 감사 / Python developer filtered generated contract
- [x] local fresh 25 migrations·DB/RLS 575건(Preview 65건)·동시성·Edge 84건·application 122건·Python 34건·package source 검증
- [x] PR #72 exact head GitHub application / migration PASS
- [x] #29 독립 보안/API 리뷰 P0/P1=0
- [x] #29 PR #72 `dev` 병합
- [x] release/main 후 production migration·Edge source 반영
- [ ] 역할별 hosted smoke 및 운영 소요시간 별도 확정

신규 migration은 `20260907143843_assignment_preview_duration_policy.sql` 하나이며 기존
24개는 변경하지 않는다. Source OpenAPI는 51 paths / 56 operations, production은 계속
39 paths / 43 operations다. 성공 Preview의 assignment/attempt/알림/outbox/audit/receipt write는
0이며, 설정 확정 POST만 별도 audit/receipt를 기록한다. `55/65/70/80`분은 운영값이 아니다.
정책 미확정은 409 / `decisionReady=false` / 빈 제안이다. 상세 한계는
[Preview 계약](./ASSIGNMENT_PREVIEW.md)을 따른다. 자동 apply/notify/PIN/#7 실행은 포함하지 않는다.
DB lint 오류 0, local Security Advisor WARN/ERROR 0이다. `notification_outbox`와 새 duration
정책의 RLS/no-policy INFO 2건은 직접 접근을 막고 RPC만 허용하는 의도된 경계다.

### #4 Maid Assignment Visibility — production source 반영, hosted smoke 미확인

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

### #73 Planned checkout 예약 객실 변경 — production schema 반영, hosted smoke 미확인

46번째 append-only migration은 기존 즉시 `cleaning_targets_reservation_room_fk`의 검사 시점만
planned graph의 다른 복합 FK처럼 commit으로 맞춘다. FK와 commit-time graph validation은 유지하며
제약 disable/drop이나 target 복제를 하지 않는다. public HTTP/OpenAPI 수는 그대로다.

- [x] unassigned와 미통보 draft의 원자적 reservation/obligation/planned-target room move
- [x] draft stale 처리, notified explicit-replan 거부, checked-in room lock
- [x] command replay/hash conflict, 실패 transaction rollback, target creation snapshot 불변
- [x] 실제 notify→unassign→move 뒤 과거 maid notified room snapshot 불변·새 target 비노출
- [x] room-change↔notify 및 room-change↔checkout 직렬화·exactly-one 회귀
- [x] release/main 이후 production migration 반영
- [ ] hosted reservation positive mutation smoke

### #7A Attempt Execution Core — production source 반영, hosted smoke 미확인

기준 `dev@7bdc2a3981e55e235de569527f7cc68f5ef80db1`에서 만든 별도 feature PR #75는
`dev@c68e65e49362d4fef0ec903d836818f54834d3b2`에 squash 병합됐다.
source OpenAPI는 **54 paths / 59 operations**이며 production은 계속 **39 / 43**이다.
신규 append-only `20260908110343_attempt_execution_core.sql`은 27번째 source migration이다.
기존 26개 migration은 불변이고 production 19개 history는 변경하지 않았다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `GET /v1/attempts/current?assignmentId=...` | active maid self/current notified | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/attempts/{attemptId}/start` | active maid self | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/attempts/{attemptId}/complete-field-work` | active maid self | ✅ | ❌ | ✅ | ✅ | ⚠️ |

- [x] execution version CAS/scoped request-hash receipt/서버 시각 start·물리 완료 구현
- [x] latest actor/session/password/own current notified identity 및 start source·점유 검증
- [x] maid in_progress 최대1 / 자정·마감·정상 checkout 후 물리 완료 / 사진 전제 없음
- [x] #7B 전 진행 maid 일반 role/status 변경 거부 / audit 원자성 / safe projection
- [x] 최종 로컬: Edge 95건, application 123건, fresh 27 migrations / DB·RLS 695건, 전체 concurrency, Python 34건·ruff/format/mypy/package/generated contract PASS
- [x] exact-head GitHub application / migration PASS — run `34221384259`
- [x] exact-head 독립 QA P0/P1=0 — `c3fb595c034d3c501ee21b8361c9aef0f14be031`
- [x] 사용자 위임 기준 Codex 평가 96/100 및 source/dev 승인
- [x] PR #75 `dev` squash 병합 — `c68e65e49362d4fef0ec903d836818f54834d3b2`
- [x] release/main 이후 production migration·Edge source 반영
- [ ] hosted maid role/positive mutation smoke

target coarse `in_progress`를 실제 현장 수행중으로 해석하지 않는다. current attempt의 status와
fieldCompletedAt/endedAt이 물리 완료 정본이다. field_completed만으로 사진 업로드·submission·
검수·ready·earning을 생성하지 않는다. #7B 인계/capability, #7C offline/lease, #73 FK 수정은
포함하지 않는다. [상세 실행 계약](./ATTEMPT_EXECUTION_CORE.md)을 따른다.
DB lint 오류 0, local Security Advisor WARN/ERROR 0이며 기존 RPC-only INFO 2건은 유지된다.
승인 head와 병합 결과의 tree는 `cc971a2217e7985767782b0da5670ba1380bd8d6`로 동일하다.
독립 QA·required CI·Codex 점수·병합 증거를 별도로 기록하며 운영 DB/hosted 테스트는 실행하지 않았다.

### #7B Attempt Lifecycle — production source 반영, hosted smoke 미확인

2026-09-08 사용자 승인으로 미착수 만료 `scheduled`의 superseded 보존·다음날 재배정과
만료 `in_progress`의 명시적 새 인계 일정 정책을 확정했다. `dev@bcc74c0`에서 분기한
`codex/7b-handover-limited-capability`의 구현은 PR #77로 dev에 병합됐다. 정확한 계약은
[Attempt Lifecycle](./ATTEMPT_LIFECYCLE.md)을 따른다.

#7B 병합 당시 dev OpenAPI는 **58 paths / 63 operations**이며 아래 4개 operation을 포함한다.
이후 #7C를 포함한 최신 통합 수치는 §2를 따른다. production OpenAPI는 계속 **39 / 43**이다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `GET /v1/attempts/lifecycle-impact?assignmentId=...` | active business admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/attempts/{attemptId}/lifecycle` | active business admin | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `GET /v1/limited/attempts/{attemptId}?assignmentRevision=...` | own maid + live capability/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/limited/attempts/{attemptId}/complete-field-work` | own maid + finish_current/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 이후 production migration·Edge source 반영
- [ ] 역할별 hosted read/positive mutation smoke

승인 exact head와 dev 병합 결과의 tree는 `1add0ec8668513ece4acc8f9d09b9509e91e2145`로 동일하다.
독립 QA·required CI·Codex 점수·병합을 구분해 기록한다. #7B source/dev 완료는 production
사용 가능 선언이 아니다. #7C offline lease/replay/quarantine도 아래 별도 증거에 따라 source/dev 완료다.
production DB/Edge/Pages 변경은 없다.

### #7C Offline — production source 반영, hosted/client smoke 미확인

`codex/7c-offline-lease-quarantine`는 `dev@695c10c`에서 시작했다. 2026-09-08 사용자가
replay 최대90일 후 만료거부와 현재 유효한 in_progress 회차의 관리자 물리완료 정정을 승인했다.
과거 회차 복구 및 ready/검수/수익 생성은 금지한다. [Offline 계약](./ATTEMPT_OFFLINE.md)을 따른다.
PR #79는 2026-09-09 KST에 dev로 squash 병합됐다. 운영 migration/API/Pages 값은 그대로다.
통합 source의 OpenAPI는 63 paths / 68 operations이며 신규 offline 5 operations를 포함한다.
이는 dev 완료 수치이지 production 공개 계약 수치가 아니다.

| Method / Path | 권한 | DB/RPC | Fastify | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|
| `POST /v1/attempts/{attemptId}/start-with-lease` | active own maid/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/offline-events` | own known lease/session; metadata와 실제 효력 별도 검사 | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `GET /v1/offline-quarantines` | active business admin/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `GET /v1/offline-quarantines/{quarantineId}` | active business admin/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |
| `POST /v1/offline-quarantines/{quarantineId}/resolve` | active business admin/session | ✅ | ❌ | ✅ | ✅ | ⚠️ |

- [x] 90일 replay/metadata 경계와 관리자 정정의 현재회차 한정 정책 승인
- [x] 시작 base application 123 tests PASS
- [x] lease/ingest/quarantine/resolution/purge 구현 및 역할·시각·경합 로컬 검증
- [x] OpenAPI/Python/문서 정합화와 전체 로컬 검증 (Edge114/application123/DB910/Python36/전체 concurrency PASS)
- [x] exact-head independent QA P0/P1=0 — `25ceabd2d9d781bb26e68be2230ab6d08ddd3e87`
- [x] required CI application/migration PASS — run `34243676126`
- [x] Codex 위임 평가96/100 및 PR #79 source/dev 병합 허가 — comment `5587516395`
- [x] PR #79 squash 병합 — `dev@e2648de4e40a84e60d19cbb1e4d01974a2f3d369`
- [x] release/main 및 production schema·Edge source 반영
- [ ] 보존 worker·hosted/client offline E2E

승인 head와 병합 결과의 tree는 `6768b63f64fdea6dba7d4eda32a70807b7274823`로 동일하다.
GitHub COMMENTED 리뷰·독립 서브에이전트 QA·Codex 위임 허가를 구분한다. #7A/B/C는
source/dev 완료이며 #30 / PR #81, #83 / PR #86, #84 / PR #88, #85 / PR #90과 #31 / PR #91도 source/dev 완료했다. 현재 본선은 #8 earning/payroll 정산이다. production purge 주기/backlog/실패감시와
hosted/client offline E2E는 아직 실행하지 않았다. #7은 해당 후속 gate 추적을 위해 Open 유지한다.

## 13. 후속 업무 API·모델 개발 상태

아래는 v0.2.0 이후 업무 기능의 통합 이력이다. 현재 production source 반영 여부는 §2의 `main@80f9350` 73 migrations / 120 paths / 130 operations를 따르며, hosted positive smoke와 provider activation은 별도 상태다.

| 체크 | 영역 | 상태 | 관련 Issue | 비고 |
|---|---|---|---|---|
| [x] | 청소 담당 배정·revision·현재 pointer·순서 | production source 반영 | #25 | hosted role/positive mutation smoke 미확인 |
| [x] | 배정 저장 시 가능일 재검증·부분 알림 | production source 반영 | #26 | hosted role/positive mutation smoke 미확인 |
| [x] | 시작 전 재배정·취소 요청·관리자 결정 | production source 반영 | #27 | hosted role/positive mutation smoke 미확인 |
| [x] | 오늘/내일 activation·rollover | production scheduler 반영 | #28 | scheduler health는 확인; #28 positive effect smoke 미확인 |
| [x] | 배정 preview algorithm | production source 반영 | #29 | hosted role/positive mutation smoke 미확인 |
| [x] | maid notified-only 조회 정합화 | production source 반영 | #4 / PR #74 | hosted maid read smoke 미확인 |
| [x] | 온라인 현장 시작·물리 완료 | production source 반영 | #7 / PR #75 | hosted positive smoke 미확인; 사진·submission·ready와 별도 |
| [x] | handover/capability | production source 반영 | #7 / PR #77 | hosted role/positive mutation smoke 미확인 |
| [x] | offline lease/conflict | production source 반영 | #7 / PR #79 | purge 운영·hosted client E2E 별도 |
| [x] | 사진 template/slot snapshot·submission version | production schema 반영 | #30 / PR #81 | owner-only 모델; hosted end-to-end 증빙 미확인 |
| [x] | 사진 업로드 작업 원장·권한 계약 | production schema 반영 | #83 / PR #86 | 실제 Google/HTTP/purge activation 별도 |
| [x] | Google Drive 업로드·조회 | production source 반영 | #9 / #84 | OAuth·Google hosted positive smoke 미완료 |
| [x] | 7일 영구삭제·orphan 운영 worker | production bundle 반영 | #9 / #85 / PR #90 | provider/Cron hosted purge activation 미완료 |
| [x] | 제출·검수·재청소 | production source 반영 | #31 / PR #91 | hosted role/positive mutation smoke 미확인; pagination P2 후속 |
| [x] | earning/payroll 주차 조회·PAYING 시작 | production source 반영 | #8 / #93 / PR #95 | hosted role/positive mutation smoke 미확인 |
| [x] | payroll pagination·응답 크기 상한 | production source 반영 | #96 / PR #97 | hosted role read/mutation smoke 미확인; 비차단 P2 2건 후속 |
| [x] | complaint·appeal·correction | production source 반영 | #8 / #94 / #100 / PR #104 | hosted role/positive mutation smoke 미확인 |
| [x] | complaint 재작업·typed compensation earning | production source 반영 | #8 / #94 / #101 / PR #105 | hosted role/positive mutation smoke 미확인 |
| [x] | signed adjustment·carry-forward | production source 반영 | #8 / #94 / #102 / PR #106 | hosted role/positive mutation smoke 미확인 |
| [x] | 외부 지급 결과 | production source 반영 | #8 / #94 / #103 / PR #107 | provider 호출 없음; hosted positive mutation smoke 미확인 |
| [x] | 알림함 조회·읽음 처리 | production source 반영 | #10 / #108 / PR #108 | hosted role/read mutation smoke 미확인 |
| [x] | notification catalog·grouping·writer 정합성 | production schema 반영 | #10 / #109 / PR #114 | hosted writer effect smoke 미확인 |
| [x] | encrypted Web Push subscription revision ledger/API | production source 반영 | #10 / #110 / PR #115 | provider/실기기 activation 미완료 |
| [x] | notification delivery ledger·provider-neutral worker | production bundle 반영 | #10 / #111 / PR #116 | zero-byte 503 fail-closed 확인; provider/invoke/Cron 비활성 |
| [x] | claim/resume 교차 동시성 회귀 | source/dev 완료 | #10 / #117 | 기능·migration 변경 없이 실제 RPC Promise.all 경합 고정; `dev@cc15f47a74959943cf72a95e69da278243020f15` |
| [x] | VAPID/provider HTTP source 계약 | production source 반영 | #10 / #112 / PR #119 | Issue #112 OPEN, Cron/Vault/provider/실기기 활성화 미완료 |
| [x] | 배정 변경·취소 및 청소 완료 알림 coverage | production source 반영 | #128 | informational push/action 분리, active-admin completion fanout, exact notified replan/revocation provenance; provider 미활성 |
| [x] | encrypted room PIN Phase A | production source 반영 | #69 / #131 | **production 56-migration historical 계약**은 physical change/reveal 모두 authoritative access lease; #194 source candidate는 change만 유지하고 reveal을 durable assignment entitlement로 대체; hosted role/positive mutation smoke 미확인 |
| [x] | Google Sheets PIN projection worker Phase B | production bundle 반영 | #69 / #136 / PR #138 | `room-pin-sheet-sync` source 배포; hosted target/secret/ACL/Google/Cron activation 미완료 |
| [x] | PIN Sheet 안전 상태·full resync Phase C | production source 반영 | #69 / #137 | exact target digest, 121실 snapshot, singleton fence/CAS/audit; Google target/secret/ACL/Cron activation은 Issue OPEN |
| [~] | 초기 PIN 자동 생성·현장 확인 | production source 반영 | #169 | 73번째 append-only 및 API 배포 완료; 실제 bootstrap·물리 확인 mutation 미실행 |
| [x] | 자동 checkout 후 퇴실 미진행 신고·관리자 재배정 | source/main·production bundle 반영 | #133 | 54 migrations / 108 paths / 115 operations; Issue #148/#152 production source에 포함, 전체 hosted positive mutation smoke는 별도 pending |
| [ ] | backup/restore 운영 자동화 | 미개발 | #12 | 핵심 체인과 병행 |
| [ ] | frontend generated client / browser E2E | 미개발 | #13 | OpenAPI 정본 사용 |

### #31 Submission / Inspection source gate

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/attempts/{attemptId}/bomb-room-reports` | own active maid | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |
| [x] | `GET /v1/attempts/{attemptId}/submissions` | own maid | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted maid read smoke 미확인 |
| [x] | `POST /v1/attempts/{attemptId}/submissions` | own maid / exact `upload_submit` capability | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |
| [x] | `GET /v1/inspections` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted admin read smoke 미확인 |
| [x] | `GET /v1/inspections/{submissionId}` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted admin read smoke 미확인 |
| [x] | `POST /v1/inspections/{submissionId}/bomb-room-decision` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |
| [x] | `POST /v1/inspections/{submissionId}/approve` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |
| [x] | `POST /v1/inspections/{submissionId}/reject` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |

- [x] append-only `submission_inspection_reclean` migration 및 8개 Fastify/Edge operation 구현
- [x] role/capability/CAS/idempotency/concurrency/redaction 로컬 검증
- [x] field_completed 단독 상태에서 submission/readiness/earning 0 유지
- [x] 폭탄방 report·증빙은 최초 immutable submission에 seal되고 다른 version으로 이동 금지
- [x] 반려는 정확히 같은 transaction에서 actionable notification/outbox와 원 maid notified reclean을 생성하며 earning과 attempt는 생성하지 않음
- [x] PR #91 exact head `3c283683d8bce5e5b6351c1de1c9271c2099163f` 독립 QA P0/P1=0, P2=inspection queue pagination — 96/100
- [x] required CI application/migration PASS — run `34368041871`
- [x] PR #91 `dev` squash 병합 — `f22005d8af6087a3bbab215c76cf7cc7e45b49fb`; 승인 head와 병합 tree `9e97e1299a76923982fb848ec488f8fa99e0dc8e` 동일
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted 역할별 read/positive mutation smoke

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

### #131 encrypted room PIN API — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/rooms/{roomId}/pin-changes/prepare` | active business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/rooms/{roomId}/pin-changes/{leaseId}/confirm` | preparing admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/rooms/{roomId}/pin-changes/{leaseId}/rollback` | preparing admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/rooms/{roomId}/pin/reveal` | current notified maid + durable assignment entitlement + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |

Production `api` bundle에는 네 operation이 포함됐지만 PIN 원문이 필요한 hosted positive mutation을
안전한 운영 fixture 없이 실행하지 않았으므로 현재 사용을 ✅로 올리지 않는다.

### #194 assignment PIN entitlement — production source 반영, hosted smoke 대기

- [x] 기존 63개 migration 불변 + 64번째 append-only migration
- [x] exact typed delivery outbox와 같은 transaction에서 current/notified assignment entitlement grant
- [x] `availableFrom` 전부터 field/upload/submission/inspection pending까지 durable authority 유지
- [x] final approve/reject/cancel, 재배정/revision 교체, inactive/departed 최종 정리에서 atomic end/reveal revoke
- [x] PIN rotation 시 current workflow + 이미 통보된 객실별 다음 근무일만 successor; 더 먼 미래·비활성화 진행/종료 actor 제외
- [x] maid PIN 변경의 exact in-progress attempt + authoritative access lease 경계 유지
- [x] 63→64 이력 보존/backfill, RLS, replay/rotation/account concurrency source 검증
- [x] feature/dev 병합 및 exact-head independent QA
- [x] release/main·production migration/API 배포
- [ ] hosted role/PIN mutation smoke

이 계약은 공개 path/operation 수를 늘리지 않고 OpenAPI `0.4.0`의 기존 PIN reveal 설명과 stable
`PIN_ENTITLEMENT_REQUIRED` 오류를 정합화한다. 실제 PIN/Google provider 활성화는 별도다.

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

## 15. 통합 이력과 현재 우선순위

아래 1~45번은 각 source/dev 병합 당시의 순서와 당시 production 상태를 보존한 이력이다.
`운영 미적용`/`production 미승격` 표기는 당시 상태이며 현재 production 정본은 §2와 각 상세 표를 우선한다.

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

### #93 Payroll Cycle Assembly — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/payroll` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/start` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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

### #96 Payroll Pagination / Response Bound — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/payroll` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `GET /v1/payroll/entries` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/start` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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
| typed earning provenance | 승인 / #101 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| complaint / appeal / correction | 승인 / #100 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| 타 메이드 compensation entitlement | 승인 / #101 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| signed adjustment / carry-forward | 승인 / #102 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| external full-payment result / `CHECK` / `PAID` | 승인 / #103 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| own notification inbox / mark read | 승인 / #108 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| notification catalog / typed grouping / writer atomicity | 승인 / #109 production schema 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| encrypted Web Push subscription register / retire | 승인 / #110 production source 반영 | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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

### #100 Complaint / Appeal / Correction source gate — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/complaints` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `GET /v1/complaints/{complaintId}` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `GET /v1/complaints/{complaintId}/history` | admin / maid self | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints/{complaintId}/review` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints/{complaintId}/decision` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints/{complaintId}/response` | own active password-complete maid | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints/{complaintId}/corrections` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/complaints/{complaintId}/close` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted role/read/positive mutation smoke

### #101 Complaint Rework / Typed Compensation Earning — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/complaints/{complaintId}/rework` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted role/positive mutation smoke

### #102 Signed Payroll Adjustment / Carry-forward — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/payroll/adjustments/corrections` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/adjustments/reversals` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/carry-forward` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/late-earnings/{earningId}/carry` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted role/positive mutation smoke

#103의 `CHECK/PAID`·외부 전액 지급 결과/provider reference는 #102 source gate에 포함하지 않는다.

### #103 External Full Payment Result — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/check` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/paid` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/payroll/payment-attempts/{attemptId}/reopen` | active password-complete business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ |

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
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted role/positive mutation smoke

실제 bank/provider reference format은 아직 미확정이다. 현재 allowlist는 fail-closed source 계약이며 실제 provider
연동이 승인되면 별도 migration/API 검토가 필요하다. 이 source는 provider를 호출하지 않는다.

### #108 Notification Inbox / Mark Read — production source 반영, hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/notifications` | active admin/maid self + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/notifications/{notificationId}/read` | recipient self + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |

- [x] 기존 40 migrations 수정 0, 41번째 append-only migration 1개
- [x] 본인 알림 `(occurred_at DESC, id DESC)` bounded keyset 조회와 actor/role/stream/sort 바인딩 signed cursor
- [x] 최초 server timestamp를 보존하는 멱등·동시 안전 markRead와 cross-recipient stable 404
- [x] raw notification Data API SELECT/UPDATE 회수, immutable content/recipient/resolution guard, live-session service-only RPC
- [x] Fastify/Edge/OpenAPI parity, 128 KiB fail-closed와 전 응답 `Cache-Control: no-store`; 95 paths / 102 operations
- [x] PR #108 독립 QA, required GitHub `application` / `migration` PASS, `dev@bdb4b25d33aa09efe99112636c60c4da52336318` 병합
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted role/read mutation smoke

### #109 Notification Catalog / Grouping / Writer — production schema 반영, hosted effect smoke 미확인

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
- [x] release/main 승격과 production migration/Edge source 반영
- [ ] hosted writer/notification effect smoke

### #110 Encrypted Web Push Subscription — production source 반영, provider activation 미완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/push-subscriptions` | active password-complete admin/maid self + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| [x] | `POST /v1/push-subscriptions/{subscriptionId}/retire` | active password-complete admin/maid owner + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ |

- [x] 기존 42 migrations 수정 0, 43번째 append-only migration 1개
- [x] logical/current, immutable revision, AES-256-GCM secret envelope, 최소 lifecycle event, durable 10/min profile limiter 분리
- [x] live session당 active 1, profile당 최대 5, active endpoint digest 전역 1; 자동 LRU·교차 profile 이전 없음
- [x] exact replay와 expected subscription ID/version CAS rotation, stale fail-closed, retire crypto-shred·no resurrection
- [x] private raw table/helper PUBLIC/anon/authenticated/service_role 권한 차단, app-owned RPC만 service_role EXECUTE
- [x] Fastify/Edge/OpenAPI strict 2 paths/2 operations, no-store·128 KiB, raw endpoint/key/digest/session 비노출; 97 paths / 104 operations
- [x] PR #115 독립 QA, required GitHub `application` / `migration` PASS, `dev@6e22eaf1150063511356db03d9845c5bb5175723` 병합
- [x] #111 delivery target/attempt/claim/retry source/dev 및 #112 VAPID/provider HTTP source/dev
- [x] production migration과 `api`/`notification-delivery` bundle source 배포
- [ ] #112 Function Secrets/Cron/Vault/provider·실기기 hosted 활성화

### #111 Notification delivery worker — production bundle 반영, 의도적 fail-closed

- [x] Issue #111 정책 댓글 `5638391812`: permit 선형화, 24시간 TTL, no-subscription terminal, max8/2분 lease/backoff, operator-blocked, local retirement
- [x] 기존 43 migrations 수정 0, 44번째 append-only migration 1개
- [x] immutable typed outbox intent와 private job/target/attempt/result/permit/event/heartbeat 분리
- [x] 최초 fanout exact subscription/version/revision snapshot, envelope 비복제, stable `notificationId` payload
- [x] provider-neutral 45초 worker core와 bounded service-only claim/context/permit/settle/resume/purge RPC
- [x] 기존 developer database-status operation에 bounded backlog/heartbeat 추가; 공개 97 paths / 104 operations 유지
- [x] PR #116 독립 QA, required GitHub `application` / `migration` PASS, `dev@8fb0886214ef8287f15f2ad2fd149cd271340834` 병합
- [x] #117 실제 claim/resume 교차 동시성 회귀 `dev@cc15f47a74959943cf72a95e69da278243020f15` 병합
- [x] `notification-delivery` production bundle 배포; zero-byte 요청 503 fail-closed 확인
- [ ] #112 hosted VAPID/Cron/invoke secret/provider 활성화

### #112 VAPID Web Push — production source/bundle 반영, hosted activation 미완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/push-subscriptions/config` | active password-complete admin/maid + live session | ✅ | ✅ | ✅ | ✅ | ⛔ |

- [x] Issue #112 정본 정책 댓글 `5641979910`과 RFC 8030/8291/8292 source 계약 반영
- [x] 기존 44 migrations 수정 0, 45번째 append-only VAPID revision binding migration 1개
- [x] authenticated active/password-complete admin·maid 전용 public-key config 1 path/operation 추가; source/dev 계약 **45 migrations / 98 paths / 105 operations**
- [x] config→register 10분 actor/profile/live-session HMAC binding proof; current/prior overlap replay와 removed/expired/tampered scope fail-closed
- [x] actual P-256 curve/pair 검증, 최대 5개 public/private ring exact identity 대조, config drift durable degraded heartbeat
- [x] provider allowlist·manual redirect·bounded status mapping·generic 3 KiB payload·stable notification ID 구현
- [x] distinct invoke secret의 전용 `notification-delivery` Edge source와 33/39/45초 budget 연결
- [x] PR #119 승인 exact head `eb243c54ebf24cd932d70cb1c6423fa4f319c050` 독립 QA P0/P1/P2 0·98/100, required GitHub `application` / `migration` PASS, `dev@dfc98b1474f9f890851d49bd904869181d0d7880` 병합
- [x] release/main, production migration과 `api`/`notification-delivery` bundle source 배포
- [ ] Issue #112 OPEN 유지: Function Secrets·Vault/pg_cron/pg_net·5회 success·real-device hosted smoke

### #85 사진 purge/reconciliation — production bundle 반영, Google/Cron activation 미완료

- [x] accepted `uploaded_at + 168h`와 never-accepted orphan authority 분리
- [x] room/date folder durable retirement, reserve→identity barrier, raw locator clear + private digest tombstone
- [x] accepted → orphan → folder 순서와 blocked 전환 포함 전체 claim 10/run·45초 absolute deadline(DB/OAuth/Drive/settle/heartbeat), DB `nextAttemptAt` retry
- [x] 기존 developer database/runtime status에 bounded count·heartbeat와 secret configured boolean만 추가
- [x] public business/OpenAPI path·operation **67/72 유지**
- [x] fresh 33 migrations와 DB/RLS 1,404건 PASS
- [x] exact head `93524b680608fa54a2be2d9f826ba960a621dc12` 독립 보안/API 리뷰 P0/P1=0
- [x] exact head required GitHub application/migration PASS
- [x] PR #90 `dev` squash 병합 — `92c0f97b412e9a4ccf41934b6924bc59ca2f9dd2`
- [x] release/main 후 production migration과 `photo-purge` bundle source 배포
- [ ] production OAuth/Google/Cron activation과 hosted purge smoke

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

### #9 Stage 1 사진 retention v2 — production schema/API 반영, provider/Cron 대기

- [x] 신규 63번째 append-only migration으로 policy/anchor/`retentionStartsAt`/`expiresAt`/`purgedAt`/`mediaAvailability` private 원장 추가
- [x] pending inspection `expiresAt=NULL`, final approve/reject+168시간, complaint close·admin interruption/offline resolution+180일, true orphan uploadedAt+30일 계약 구현
- [x] 기존 62 migrations와 PIN/사진/audit 이력 불변인 62→63 upgrade fixture 및 hash 보존 검증
- [x] actual performer maid+admin content 권한, no-store, provider read 전후 재인가와 stable unavailable/expired/purged 오류
- [x] claim/settle 직전 late binding 재검증, expiry 변경 시 stale fence 무효화, unchanged claim/retry/blocked 상태 보존
- [x] provider DELETE 전 exact object/fence/claim/authoritative expiry permit 영구 기록과 공통 barrier 적용; permit 뒤 late binding 및 purged resurrection 차단
- [x] current pointer가 이동한 historical decided submission도 자체 `decidedAt+168h`까지 active evidence로 보존하며 superseded pending은 final decision 전 무기한 보호
- [x] Fastify/Edge/OpenAPI/Python 생성 계약에 permanent retention metadata와 승인된 source candidate version `0.4.0` 반영
- [x] 독립 exact-head QA와 source/dev 병합
- [x] release/main 및 production 63번째 migration/API 반영; 기존 `photo-purge` bundle 유지
- [ ] 운영 Google provider/Cron hosted smoke

`room_issue`는 실제 resolved entity anchor 검증은 있으나 현재 대응 attachment source가 없어 schema-ready policy enum일 뿐이다. complaint closed event, admin interruption handover, server-owned offline resolution anchor는 실제 domain row로 검증한다. Issue/complaint/interruption/sync-conflict 종류를 attachment API/hosted 완료로 과대평가하지 않는다. schema/API 반영은 Google provider/Cron purge 활성화 완료를 뜻하지 않는다.

### #83 사진 업로드 작업 원장 — production schema 반영, provider smoke 미확인

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

### #84 Drive 업로드·열람 — production source 반영, Google hosted smoke 미확인

개발 시작 기준은 `dev@46c5f91e968556d1a13ecee398e98e8062839508`이고,
[PR #88](https://github.com/wrongstory/room-management-system-backend/pull/88)의 승인 exact head는
`7a3cfec2994b02569b3004c6f94c051c581cb213`, dev squash 결과는
`520abe7b80501ed9a4573e2251b9b640476d87b5`다. 최신 통합 source는 **32 migrations / 67 paths / 72 operations**이며
승인 head와 병합 결과의 tree는 `2e430f83ba6f8c5e46166d3f6f5d5e991781b3ba`로 동일하다. source 승인·병합은 production 배포 증거가 아니다.

| API | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|
| `GET /v1/attempts/{attemptId}/photo-slots` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `POST /v1/attempts/{attemptId}/photo-slots/{slotId}/upload` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `POST /v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}/upload` | ✅ | ✅ | ✅ | ❌ | source 후보 |
| `DELETE /v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}` | ✅ | ✅ | ✅ | ❌ | source 후보 |
| `GET /v1/photo-uploads/{operationId}` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `GET /v1/photos/{photoId}/content` | ✅ | ✅ | ✅ | ✅ | ⚠️ |

- [x] 실제 local Edge v1.74.3 oneshot worker 합성1280×960/2048×2048 JPEG/WebP cold-start CPU/메모리·20MB bundle gate 완료(운영 hosted smoke 아님; PHOTO_STORAGE evidence 참고)
- [x] 전체 local DB/RLS/concurrency·Edge/Fastify·OpenAPI·Python 계약 최종 검증
- [x] exact head 독립 QA **P0 0 / P1 0** — PR #88 승인 head 기준
- [x] exact head required GitHub `application` / `migration` PASS — [run 34269466800, attempt 2](https://github.com/wrongstory/room-management-system-backend/actions/runs/34269466800/attempts/2)
- [x] Codex 위임 source 승인 및 PR #88 dev squash 병합 — `520abe7b80501ed9a4573e2251b9b640476d87b5`
- [x] release/main과 production migration/Edge source 반영
- [ ] 운영 OAuth/Google 설정과 hosted role/positive upload/read smoke
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
#46 password replay feature gate — source/dev 완료:

- [x] private actor+command+key+origin session scoped receipt와 Auth/DB response-loss recovery 구현
- [x] password-specific private effect version으로 completed replay를 실제 Auth 효과에 결합하고 후속 변경·관리자 reset·별도 Auth password 변경 뒤 과거 key 차단
- [x] actor당 1행·10회/분 durable Auth password verification limiter로 session/client/key 회전 우회 차단
- [x] 관리자 reset은 Auth 성공 확인 뒤 finalize하여 inconsistent receipt를 supersede; reset 실패는 unresolved 유지
- [x] Fastify / Edge / OpenAPI / DB / 문서 계약 정합화
- [x] 비밀번호·파생 verifier·token·raw session ID 비저장 회귀
- [x] PR exact-head 독립 QA P0/P1=0, 90점 이상
- [x] required `application` / `migration` PASS
- [x] `dev@1eca96393bb353124c099f6f3923298df20d9bb5` 병합
- [ ] release/main 및 production Edge 승격 — 이번 feature PR 범위 밖

### #140 초기 PIN bootstrap·예약 readiness 분리 — production source 반영, secret/hosted smoke 미확인

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/rooms/pins/bootstrap` | active password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; secret과 positive bootstrap smoke 미확인 |
| [~] | `POST /v1/rooms/{roomId}/pin/generated/confirm` | active password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | v0.4.0 production source 포함; 실제 PIN bootstrap·물리 확인 mutation 미실행 |

- [x] 예약 생성·변경·객실 projection에서 `unconfigured`/`mismatch` PIN 경고를 allocation blocker와 분리
- [x] actual check-in preparation context와 reveal/change의 verified-only fail-closed 유지
- [x] active admin 전용 `POST /v1/rooms/pins/bootstrap`, 최대 25건, idempotent receipt, 기존 current/mismatch 비덮어쓰기
- [x] #169 candidate에서 고정 초기 PIN secret을 제거하고 CSPRNG batch-unique 4자리 자동 생성으로 교체
- [x] 생성 직후 mismatch/no Sheet, admin 30초 no-store reveal, 현장 확인 후 verified/Sheet outbox 계약 추가
- [x] `POST /v1/rooms/{roomId}/pin/generated/confirm` 추가; 최신 dev 통합 candidate는 73 migrations / 120 paths / 130 operations
- [x] 최초 #169 exact source에서 application 409, Edge 244, DB 47 files / 2,692 assertions, 전체 concurrency, fresh 57 migrations reset·build·typecheck·lint·secret scan PASS
- [x] `release/v0.4.0` 통합 candidate의 fresh 73 migrations·production 56→73 누적 upgrade·전체 application/Edge/Python/DB·동시성 로컬 재검증 PASS
- [x] Fastify/Edge/OpenAPI 및 frontend handoff 계약 정합화; legacy `pin-sync-events` deprecated
- [x] 최신 `dev` 병합 후 fresh local DB reset, 43 SQL files / 2,536 assertions, 전체 concurrency, DB lint, Edge 226 tests·bundle gate PASS
- [x] PR #141 exact-head required `application` / `migration` PASS와 `dev@322eb363ae9fe6d3f4a497437e4d38f7e3694578` 병합
- [x] 53번째 append-only nonce reservation: prepare/bootstrap 공통 충돌 차단, 52→53 history-preserving fail-closed upgrade
- [x] bootstrap 전용 별도 DB session 병렬/응답 유실 replay와 원장 exactly-once 보완의 exact-head 독립 QA·required CI
- [x] release/main·production migration/Edge source 반영
- [ ] production bootstrap secret과 hosted positive mutation smoke

### #133 자동 checkout 후 퇴실 미진행 신고·관리자 재배정 — source/main·production bundle 반영

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/attempts/{attemptId}/checkout-not-completed` | current notified maid | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |
| [x] | `GET /v1/checkout-incidents/{incidentId}` | 관련 maid / business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted role read smoke 미확인 |
| [x] | `POST /v1/checkout-incidents/{incidentId}/decision` | business admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 반영; hosted positive mutation smoke 미확인 |

- [x] 신고와 attempt/PIN/offline/capability 동결, immutable audit, 전체 active password-complete admin inbox/outbox를 단일 transaction으로 처리
- [x] `EXTEND_CHECKOUT | CONFIRM_DEPARTED | FALSE_REPORT` 결정과 기존 checkout target 재사용, assignment/attempt 이력 보존, 중단 업무 earning·벌점 0
- [x] 일반 reservation/assignment/attempt/PIN/submission/inspection 경로가 open incident를 직접 검사하며, 기존 공개 PIN의 회수를 주장하지 않고 이후 lease·조회·실행만 차단
- [x] 동일 요청 replay와 상반 신고/판정 경쟁이 exactly-once/CAS로 수렴하며 global advisory → command receipt → domain row 잠금 순서와 서버 계산 impact fingerprint를 사용
- [x] 최신 checkout 종료 원장이 현재 예약·객실·실제 종료 시각의 `scheduled_checkout`인 경우만 신고를 허용하고 manual/과거 증거는 부작용 없이 차단
- [x] 신규 결정은 domain 잠금·상태 재검증 뒤 실제 시각으로 유효 마감을 검사하며, 완료 receipt replay는 시간 경과 후에도 최초 결과를 반환
- [x] 재배정은 공통 일정 검증으로 KST serviceDate, 서비스일 종료, 다음 예약 체크인 30분 전 상한을 원자적으로 강제
- [x] incident timestamp는 Fastify/Edge 요청·응답 모두 초·offset·실제 달력 날짜를 검사하는 strict RFC 3339 계약 사용
- [x] 사건 해결 안내는 정보성으로 분리하고 새 담당의 기존 assignment 행동 알림·resolver·outbox는 중복 없이 유지
- [x] 기존 53 migrations 불변, 53→54 업무 원장 hash 보존 upgrade, fresh 54 migration 적용 검증
- [x] Fastify/Edge/OpenAPI/Python generated contract parity — **108 paths / 115 operations**
- [x] Issue #148 release evidence에서 required GitHub `application` / `migration` 및 독립 QA 확인
- [x] `dev` 통합과 v0.3.0 source/main·production 54 migrations·5 Edge bundle·OpenAPI 108/115 반영
- [ ] annotated `v0.3.0` tag/GitHub Release와 남은 hosted role·mutation/provider/Google activation smoke

### #156/#165 퇴실 청소 템플릿 운영 게시 — migration/API/네 타입 게시 완료, 예약 success smoke 대기

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 |
|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/cleaning-templates?cleaningKind=checkout` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ✅ |
| [x] | `POST /v1/cleaning-templates` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ✅ |

- [x] 네 stable `roomTypeCode`를 한 번에 조회하며 미설정은 `configured=false/currentPublished=null/expectedVersion=0`으로 명시하고 fallback·seed를 만들지 않음
- [x] 한 객실 타입씩 `expectedVersion` CAS와 actor/command/key/request-hash scoped idempotency로 새 immutable version 게시
- [x] 새 publication은 `greatest(existing max + 1, 8)`, 이후 단조 증가; 기존 pre-A v7+ published는 retired 이력과 frozen snapshot으로 보존하고 타입/kind별 published exactly-one 유지
- [x] `maxPhotos` 없는 pre-A checkout은 version 8 이상도 10/11/13/15개로 계속 검증하고, 모든 slot에 metadata가 있는 v8+ A-contract는 9/10/12/14개, 필수 8/9/11/13개, required `tv-on`·`entry-storage`, 마지막 optional `extra-proof(maxPhotos=10)`, `entry-number` 금지와 연속 순서·중복·문자열 경계를 DB/Fastify/Edge에서 검증
- [x] raw template Data API DML/SELECT 차단, service-only RPC에서 최신 actor/session/password/role 재검증
- [x] audit은 `roomTypeCode`, `cleaningKind`, `version`, `durationMinutes`, `slotCount`만 저장·노출; 게시 자체는 수신자 행동이 없어 notification/outbox 미생성
- [x] 예약 전 409 fail-closed를 유지하고 게시 뒤 예약당 planned target 1건과 불변 template/slot snapshot 생성
- [x] `publishedAt`/`createdAt` DB projection은 Fastify/Edge 모두 실제 달력·시간·offset을 검사하는 strict RFC 3339로 fail-closed
- [x] PR #157 exact-head 독립 QA·required GitHub `application` / `migration` PASS 및 `dev@897c4b845c657401873a08136bd31f351fdb04a8` 병합
- [x] #156 main·production 55번째 migration/API Edge 배포
- [x] #165 checkout `durationMinutes` 선택화 source 구현: 56번째 append-only migration, 기존 값 보존, 미확정 시간·1분 종료 추정 금지, 계획과 동일 객실 실행 충돌 분리
- [x] #165 최종 exact head required GitHub `application` / `migration` PASS, 독립 QA P0/P1=0·90점 이상 및 `main@6604b2215e06b9e9ebf0b3138e3716a000c57ddb` 병합
- [x] PR #167로 `dev@75983b3a0fb1bdc109fd57ca2a8c04bff2e4a925`에 squash 역반영 — QA 97/100, P0/P1=0, required CI PASS, 승인·병합 tree 동일
- [x] production 56번째 `cleaning_template_duration_optional` migration 적용과 기존 55개 원장 보존 확인
- [x] 승인된 v0.3.0 `main` exact source의 `api` ACTIVE v16 배포, health/OpenAPI 200
- [x] 네 타입 checkout template v7 exactly-one 게시 — 슬롯 10/11/13/15, `durationMinutes=null`, audit 4건, notification/outbox 0건
- [x] 운영 OpenAPI와 GitHub Pages 0.3.0 / 109 / 117 parity — workflow run `35051144073`
- [ ] 예약 success hosted smoke — `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`; 임의 운영 예약을 만들지 않음
- [x] #179 Decision A source/dev 완료: 57번째 append-only migration, pre-A v7+ 이력 보존, v8 A-contract 슬롯 수·key·`maxPhotos` DB/Fastify/Edge/OpenAPI parity — `dev@3587761b12d97c977bf874ab5e9ac0db1b971ab4`
- [x] #179 exact-head 독립 QA·required CI·사람 리뷰와 `dev` 병합
- [x] #180 `extra-proof` 0~10장 collection, stable item/order, append·replace·개별 삭제 CAS/멱등, 과거 제출 binding 불변, collection 폭탄방 증빙·bounded developer audit, 실제 병렬 transaction 경쟁 회귀, Node/Edge/OpenAPI parity
- [x] #180 exact-head required CI·사람 리뷰와 `dev@0f58d4778523ea2a2e6dfe05a3aa8cb80bb0052e` 병합
- [x] 승인된 v0.4.0 release의 production 57~73 migration/API 배포 — `main@80f9350...`, `api` ACTIVE v17, OpenAPI 0.4.0 / 120 / 130
- [ ] 기존 v7→A template 신규 게시와 예약/객실이동·PIN success hosted smoke — 안전 fixture·별도 운영 승인 대기

### #184 현재일 기준 객실 현황 projection — production source 배포, hosted 역할 검증 대기

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | v0.4.0 production source 포함; 최신 역할별 hosted read 미실행 |
| [x] | `GET /v1/rooms/{roomId}` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | 목록과 동일한 `evaluatedAt`/`reservationPhase` 계약; 최신 hosted read 미실행 |

- [x] 미래 active 예약의 pending preparation obligation을 현재 `CLEANING_REQUIRED`로 오인하던 projection 수정
- [x] 서버 snapshot 시각 `evaluatedAt`과 `[checkInAt, checkOutAt)` 기반 `reservationPhase=none|upcoming|current` 추가
- [x] 미래 planned checkout은 현재 청소·배정 차단을 활성화하지 않고, 실제 checkout materialization 뒤에만 청소 필요로 전환
- [x] Fastify/Edge/OpenAPI 계약 및 프런트 5단계 대표 mapper 문서화 — 공개 path/operation은 109/117 유지
- [x] append-only `current_room_status_projection` migration과 future/current/checkout 경계 회귀 추가
- [x] exact-head 독립 QA 98/100·P0/P1/P2=0과 required GitHub `application` / `migration` PASS
- [x] `dev@fb50775289b14f16b27679af471e282504b5f5f6` 병합
- [x] v0.4.0 production 57~73 migration/API 배포
- [ ] hosted 예약·객실이동 회귀 확인
- 프런트 카드·요약·필터 mapper/browser E2E는 프런트 담당 저장소에서 별도 진행한다.

### #187 예약 임박 lifecycle projection Phase A — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | v0.4.0 production source 포함; lifecycle/readiness 최신 hosted read 미실행 |
| [x] | `GET /v1/rooms/{roomId}` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | 목록과 동일한 lifecycle/readiness/next reservation projection |

- [x] `serverTime === evaluatedAt` 단일 snapshot과 KST D-day/D+1/D+2 lifecycle 분류 추가
- [x] `occupancyStatus`, `reservationLifecycle`, `readinessStatus`, `primaryDisplayStatus` 독립 축 및 next future reservation 요약 추가
- [x] 청소-only 상태를 `BLOCKED`에서 제외하고, current check-in PIN 경고만 readiness 사유로 분리
- [x] 병합 당시 기존 58 migrations 불변, 신규 append-only migration 및 SECURITY DEFINER fixed search path/execute revoke 적용; #180 병합 후 합산 정렬상 60번째
- [x] route·stay/segment·room-change preview/commit·Python codegen 변경 없음
- [x] local fresh DB reset·SQL 회귀 및 exact-head application/migration CI
- [x] PR #188 / `dev@07a07fcc77907b7d229b8c0df5ce06973c85a01b` source/dev 병합
- [x] v0.4.0 production migration/API 배포
- [ ] 역할별 hosted read 및 프런트 mapper/browser E2E

### #187 체크인 전 객실 변경 Phase B — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/reservations/{reservationId}/room-change/preview` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; 안전 fixture 기반 hosted preview 미실행 |
| [x] | `POST /v1/reservations/{reservationId}/room-change` | 동일 + Idempotency-Key | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; hosted mutation 미실행 |

- [x] Phase B 생성 시 기존 59 migrations 불변, 신규 `reservation_room_change_before_checkin` append-only migration; #180 병합 후 합산 정렬상 61번째
- [x] generic PATCH/Data API/direct update의 `room_id` 변경을 전용 command 표식 없이는 fail-closed
- [x] 예약 일정·고객·인원과 기존 planned target identity를 보존하고 private obligation/target만 원자 이동
- [x] public/assigned/notified/attempt cleaning, active PIN lease, target block, interval overlap을 stable conflict로 차단
- [x] safe `reservation.room_moved` 감사 projection; 고객명/PIN/request body/fingerprint와 self notification/outbox 없음
- [x] #180 dev와 Phase B를 합친 candidate OpenAPI 113 paths / 121 operations와 ephemeral Python codegen 계약 추가; production 109/117은 미변경
- [x] local fresh DB pgTAP·별도 세션 concurrency·application/migration 전체 검증
- [x] Phase C DURING_STAY stay/segment 모델과 별도 승인 — PR #190 / `dev@1571565b9e361e890cba6502aa3acbf9a08816c3`
- [x] v0.4.0 production 57~73 migration/API 배포
- [ ] 안전 fixture 기반 hosted smoke

현재 critical path는 **Issue #224 프런트 v0.4.0 인계 정본 → generated client 갱신과 lifecycle/bookability/room-move/청소관리 연결 → 사용자의 browser 기능 확인 → 안전 fixture가 승인되면 예약·객실 이동·PIN hosted mutation smoke → tag/GitHub Release**다.

### #187 Phase C — DURING_STAY room move source/dev 완료

- [x] 기존 61 migrations 불변, 신규 `reservation_during_stay_room_move` append-only migration 추가
- [x] `reservation.room_id` 최초 입실 계약 이력 유지, current/final room은 bounded stay segment로 분리
- [x] `serverNow <= effectiveAt < checkOutAt`, 동일 경계 source 종료/target 시작, segment exclusion/CAS/idempotency 적용
- [x] 원 객실 segment checkout target exactly-once, 최종 checkout target은 마지막 예정 객실 유지
- [x] 미래 source PIN cutoff는 effectiveAt 전 접근 유지·이후 authority/RLS 차단
- [x] Fastify/Edge/OpenAPI/Python contract parity; 공개 API 수 113 paths / 121 operations 유지
- [x] 61→62 upgrade, fresh 62 migration, 전체 DB/RLS·별도 세션 concurrency, Edge·application·Python local 검증 PASS
- [x] exact head `6389d9d20d4d2d7c5aba2738e4db5a1394d2d05f` GitHub `application` / `migration` required CI PASS — run `35150261542`
- [x] 독립 QA 99/100, P0/P1/P2=0/0/0 및 PR #190 `dev@1571565b9e361e890cba6502aa3acbf9a08816c3` 병합
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] 안전 fixture 기반 hosted smoke

Phase C는 production source에 포함됐지만 안전 fixture 기반 hosted mutation은 별도다. source 배포만으로 현재 사용 ✅로 판정하지 않는다.

### #196 예약 bookability preview·bounded calendar — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/reservations/bookability/preview` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; 최신 hosted 역할 검증 미실행 |
| [x] | `GET /v1/reservations?from&to&roomId&cursor` | 동일 | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; bounded 계약 유지, 최신 hosted read 미실행 |

- [x] 기존 64 migrations 불변, 65번째 append-only `reservation_bookability` migration과 range index/read RPC 2개 추가
- [x] query 없는 기존 `GET /v1/reservations`의 `{reservations}` 응답 호환 유지; range query response만 `nextCursor`/`serverTime`을 additive하게 제공
- [x] `intervalBookable`과 `checkInReady` 분리; PIN mismatch/unconfigured는 readiness만 변경하며 create/change의 최종 overlap authority 유지
- [x] cursor는 신규 배포 secret 없이 기존 `RESERVATION_GUEST_NAME_PEPPER`에서 목적 분리한 HMAC key 사용; actor/from/to/roomId/sort/keyset scope와 tamper 검증
- [x] room filter는 요청 범위와 겹친 stay segment history를 기준으로 cancelled/retired segment도 보존; preview overlap은 non-retired scheduled/active segment만 사용
- [x] OpenAPI `0.4.0` 114 paths / 122 operations와 ephemeral Python generated contract 갱신
- [x] local fresh 65 migration, 신규 pgTAP, Fastify/Edge contract 검증
- [x] 전체 local application/DB/concurrency quality gate
- [x] 독립 리뷰·required CI 및 `dev@3a3409bd38458796126fb5ea2590949c8b807985` 통합 완료
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read/mutation smoke

#196은 production source에 포함됐지만 hosted 역할 검증은 별도다. preview 성공을 예약 확정으로 표시하지 않고 실제 생성·변경 409를 최종 판정으로 사용한다.

### #200 장기 투숙·종료 미정 예약 — production source 반영

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/reservations/bookability/preview` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | `long_stay` nullable checkout source 배포; hosted preview 미실행 |
| [x] | `POST /v1/reservations` | 동일 | ✅ | ✅ | ✅ | ✅ | ⚠️ | source 배포 완료; 안전 fixture 부재로 hosted mutation 미실행 |
| [x] | `PATCH /v1/reservations/{reservationId}` | 동일 | ✅ | ✅ | ✅ | ✅ | ⚠️ | null→fixed만 허용하고 obligation/target exactly-once; hosted mutation 미실행 |
| [x] | 기존 room-move / manual checkout / scheduler paths | 기존 exact role | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; hosted mutation 재검증 미실행 |

- [x] 기존 65 migrations 불변, 66번째 append-only `long_stay_open_ended_reservations`
- [x] 공개 API 면 114 paths / 122 operations 유지; reservation response에 `reservationType`, nullable `checkOutAt` additive 확장
- [x] fresh 66 migrations와 실제 65→66 ledger 보존 검증
- [x] open-ended future block, graph exactly-once, replay/CAS, manual/scheduled checkout, precheckin/during-stay move 회귀
- [x] 종료 미정 long-stay의 bounded stayover 생성·배정·attempt 활성화·현장 시작 회귀
- [x] 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev` 병합
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted mutation smoke

#200은 production source에 포함됐고 #196 경로 수를 늘리지 않고 nullable 의미만 확장한다. 안전 fixture 기반 hosted mutation은 별도다.

### #202 객실 타입 카탈로그 — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/room-types` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; 최신 hosted read 미실행 |

- [x] 기존 66 migrations 불변, 67번째 append-only `room_type_catalog`에 실제 관리형 `version`과 app-owned projection 추가
- [x] `id/code/displayName/baseCleaningFee/active/version/roomCount` camelCase 계약 및 Fastify/Edge/OpenAPI/Python parity
- [x] 공개 API 후보 115 paths / 123 operations
- [x] PR #203 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev@3f6db953a569f7ebe16adcc0326e2e59ff7768ea` 병합 — 67 migrations / 115 paths / 123 operations
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#202는 production source에 포함됐다. 비활성 타입을 목록에 포함하는 것은 새 선택 허용이 아니며 최신 hosted read는 별도다.

### #204 최근 7일 청소 완료 이력 — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/cleaning-history` | active/password-complete admin·maid + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; admin/maid hosted read 미실행 |

- [x] 기존 67 migrations 불변, 68번째 append-only `cleaning_history_projection`
- [x] admin 전체/maidProfileId/query와 maid self-only bounded projection
- [x] attempt의 불변 객실 번호·타입 snapshot만 사용; 수행자 표시명은 현재 profile label임을 계약에 명시
- [x] PIN·guest PII·사진 locator/content 비노출, 사진은 count/availability/expiry metadata만 반환
- [x] Fastify/Edge/OpenAPI 및 ephemeral Python business codegen parity
- [x] 공개 API 후보 116 paths / 124 operations
- [x] PR #205 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev@c12c773d1ba427254fdd36faeede54c0c844a7c5` 병합 — 68 migrations / 116 paths / 124 operations
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#204는 production source에 포함됐다. 완료 이력은 실제 `fieldCompletedAt`만 포함하고 현재 객실 master-data로 과거 표시를 보정하지 않는다. hosted read는 별도다.

### #206 주간 업무 기록 — source/dev 완료

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/work-history` | active/password-complete admin·maid + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; admin/maid hosted read 미실행 |

- [x] 기존 68 migrations 불변, 69번째 append-only `weekly_work_history_projection`
- [x] current availability, immutable notified assignment history, `fieldCompletedAt` KST 날짜를 독립 집계
- [x] 같은 메이드·날짜 다중 작업 1일 dedupe, 전체 필터 summary와 bounded opaque cursor
- [x] 메이드별 availability `submittedAt/currentVersion/versionCount`와 월~일 flags
- [x] 표시명은 현재 profile label임을 계약에 명시; Fastify/Edge/OpenAPI parity
- [x] 공개 API 후보 117 paths / 125 operations
- [x] 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev@12f51b131fa6f616d204ef3bee814dae02cd337d` 병합 — 69 migrations / 117 paths / 125 operations
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#206은 production source에 포함됐다. 통보·가능일을 실제 완료로 해석하지 않고, 객실/작업 상세는 #204를 사용한다. hosted read는 별도다.

### #210 객실 운영 차단·이슈 조회 — production source 반영

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms/{roomId}/operation-blocks?status=actionable` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; hosted read 미실행 |
| [x] | `GET /v1/rooms/{roomId}/issues?status=open` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; hosted read 미실행 |

- [x] 기존 69 migrations 불변, 70번째 append-only `room_operations_read`
- [x] 새 세션에서 조회한 entity ID와 `roomStateVersion`으로 기존 release/resolve mutation 연결
- [x] PIN·guest PII·raw audit state를 포함하지 않는 app-owned projection
- [x] Fastify/Edge/OpenAPI parity, 공개 API 후보 117 paths / 127 operations
- [x] 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev` 병합
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#210은 production source에 포함됐다. `actionable`은 아직 release되지 않아 운영자가 처리할 수 있는 차단을 뜻하며, 시간이 지난 차단도 `expired`로 남아 명시적 release 대상이다. hosted read는 별도다.

### #215 객실 이벤트 타임라인 — production source 반영

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms/{roomId}/events?limit=30` | active/password-complete business admin + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; hosted read 미실행 |

- [x] 기존 70 migrations 불변, 71번째 append-only `room_event_timeline`
- [x] 새 테이블·backfill·index 없이 기존 두 immutable 원장의 safe projection
- [x] 다른 객실 격리, command replay 중복 0, 최대 50건, unknown room 404 SQL 회귀
- [x] PIN·guest PII·raw audit before/after·request hash 비노출
- [x] Fastify/Edge/OpenAPI parity, 공개 API 후보 118 paths / 128 operations
- [x] 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev` 병합
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#215는 production source에 포함됐다. 청소·근무 이력 합산과 cursor·기간 통계는 이 endpoint에 포함하지 않으며 hosted read는 별도다.

### #217 주급 주기 stable-ID 조회 — production source 반영

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/payroll/{cycleId}` | active/password-complete admin·maid + live session | ✅ | ✅ | ✅ | ✅ | ⚠️ | production source 포함; admin/maid hosted read 미실행 |

- [x] 기존 71 migrations 불변, 72번째 append-only `payroll_cycle_resolver`
- [x] 기존 `PayrollCycleEnvelope`와 bounded projector 재사용, conceptual OPEN 제외
- [x] PAYING/CHECK/PAID/offset-settled projection parity와 stable 404
- [x] `Cache-Control: no-store`, UTF-8 JSON 128 KiB 상한, read side effect 0
- [x] Fastify/Edge/OpenAPI/Python 생성 계약 정합화, 공개 API 후보 119 paths / 129 operations
- [x] 독립 리뷰 P0/P1=0 및 exact-head `application`/`migration` PASS
- [x] `dev` 병합
- [x] v0.4.0 release/main 및 production migration/API 배포
- [ ] hosted read smoke

#217은 production source에 포함됐다. 지급 mutation, complaint, cursor 계약을 변경하지 않으며 hosted read는 별도다.

Issue #112/#137의 provider·Google·Cron activation은 source bundle 배포와 분리한다. #12 Backup/Recovery는 병행하고, #13 frontend/generated client/browser E2E는 운영·프런트 정본 대조 뒤 진행한다.
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
- checkout cleaning template admin: #156 (P0)
- Assignment Core: #25
- `docs/AI_BACKEND_PRODUCT_GUIDE.md`
- `docs/FRONTEND_API_INTEGRATION.md`
- `docs/FRONTEND_CODEX_HANDOFF_V0.4.0.md`
- `docs/DEVELOPER_OPERATIONS_API.md`
- `docs/EDGE_RUNTIME_POC.md`
- `docs/RELEASE_V0.2.0.md`
