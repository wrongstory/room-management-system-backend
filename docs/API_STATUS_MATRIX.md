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

최종 확인: **2026-08-30 KST**

- 운영 승인 source: `main@2bc6c634ab95c2cdc758df39bb11eb310715575e`
- PR #50 통합 기준 `dev`: `ce2d1374b6eaf3416ad295f7d494a93840ccaba4` — 이 문서의 최초 정본 병합본
- PR #48 / #43 developer 운영 API: `dev` 병합 완료, production 미반영
- 운영 migration: **17건**
- 운영 Edge Functions:
  - `api` version 2 — ACTIVE
  - `reservation-scheduler` version 2 — ACTIVE
- production `api` 실제 HTTP operation: **13개**
- production `api`에는 아직 `/v1/developer/*`, `/v1/availability/*`, `/v1/reservations/*`, 객실 상세/변경 API가 없음
- business admin: 아직 생성하지 않음
- scheduler actor/invoke secret: 아직 미설정, `reservation-scheduler` 503 fail-closed가 정상
- production `/docs`: HTTP route는 존재하고 200이지만 Supabase hosted 기본 domain에서 HTML이 브라우저 Swagger UI로 렌더링되지 않아 사람용 운영 문서로는 사용 제한
- PR #50 GitHub Pages 읽기 전용 Swagger 포털: source·독립 보안/배포 리뷰 완료, production Pages 미배포

## 3. System / 문서 API

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /health` | public | — | ✅ | ✅ | ✅ | ✅ | production HTTP 200 확인 |
| [x] | `GET /openapi.json` | public | — | — | ✅ | ✅ | ✅ | production HTTP 계약 정본 |
| [ ] | `GET /docs` | public | — | — | ✅ | ✅ | ⚠️ | route/200은 존재. hosted domain 브라우저 Swagger UI 사용 불가 |
| [ ] | GitHub Pages Swagger portal | public read-only | — | — | — | — | ❌ | 별도 정적 배포 source·리뷰 완료. `main` 승격 후 Pages deploy/smoke 필요 |

GitHub Pages 포털은 Supabase Edge Function이 아닌 별도 정적 배포다. 따라서 위 행의 `Edge source`와 `Production Edge`는 `—`로 두고, source 완료와 production Pages 배포 완료를 비고와 아래 배포 gate에서 구분한다.

### GitHub Pages Swagger 배포 gate — #49 / PR #50

- [x] 읽기 전용 portal source·build 검증 완료
- [x] SSRF 경계, CSP/SRI, Try-it-out·Authorization 차단, Pages 최소 권한 독립 리뷰 완료
- [ ] 승인된 source의 `main` 승격
- [ ] GitHub Pages workflow 실행
- [ ] 공개 portal과 same-origin OpenAPI snapshot HTTP smoke

## 4. Auth API

valid account hosted smoke가 아직 남아 있으므로 production route 배포와 실제 사용 검증을 구분한다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `POST /v1/auth/login` | all accounts | ✅ | ✅ | ✅ | ✅ | ⚠️ | limiter/gateway는 검증됨. developer valid-login smoke 대기 |
| [ ] | `GET /v1/auth/me` | authenticated | ✅ | ✅ | ✅ | ✅ | ⚠️ | valid developer session hosted smoke 대기 |
| [ ] | `POST /v1/auth/password` | authenticated | ✅ | ✅ | ✅ | ✅ | ⚠️ | valid account smoke 대기; timeout retry 의미는 후속 #46 |

## 5. 계정 관리 API

Edge와 DB 계약은 production에 배포됐지만 developer 실제 로그인 이후 hosted account smoke가 남아 있다. business admin/maid 생성은 #44 Phase A Python 운영도구에서 수행한다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | developer hosted smoke 대기 |
| [ ] | `POST /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | #44에서 business admin 생성 시 실제 smoke |
| [ ] | `PATCH /v1/accounts/{profileId}/role` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | developer 생성/승격 금지 |
| [ ] | `PATCH /v1/accounts/{profileId}/status` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | 마지막 active admin 보호 |
| [ ] | `POST /v1/accounts/{profileId}/unlock` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | developer 대상 금지 |
| [ ] | `POST /v1/accounts/{profileId}/password-reset` | developer / admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | developer는 self-change만 허용 |

## 6. Developer 운영 API — #43 / PR #48

PR #48은 `dev@02d5089`로 병합 완료됐다. 아직 release/main 승격, production migration, Edge 재배포는 하지 않았다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/developer/overview` | developer only | ✅ | — | ✅ | ❌ | ❌ | dev 완료, production 미반영 |
| [ ] | `GET /v1/developer/runtime-status` | developer only | — | — | ✅ | ❌ | ❌ | secret은 configured boolean만 |
| [ ] | `GET /v1/developer/database-status` | developer only | ✅ | — | ✅ | ❌ | ❌ | migration name drift + exact RPC privilege 검사 |
| [ ] | `GET /v1/developer/scheduler-status` | developer only | ✅ | — | ✅ | ❌ | ❌ | raw Cron/Vault/net body 비노출 |
| [ ] | `GET /v1/developer/audit-events` | developer only | ✅ | — | ✅ | ❌ | ❌ | allowlist + 31일/100건 cursor |
| [ ] | `POST /v1/developer/diagnostics` | developer only | ✅ | — | ✅ | ❌ | ❌ | body/임의 URL·SQL·RPC 입력 금지, 10/min |

### #43 production 반영 조건

- [x] PR #48 `dev` 병합
- [ ] parity 작업 #51/#52/#53과 release scope 확정
- [ ] `release/v0.2.0 → main` source 승격
- [ ] `developer_operations_projections` migration 1회 적용
- [ ] production `api` 재배포
- [ ] production `reservation-scheduler` 재배포 — heartbeat source 포함
- [ ] developer / admin / maid 권한 smoke
- [ ] redaction / migration drift / critical RPC production smoke

## 7. 객실 API — Edge parity #53 (P1)

DB와 Fastify에는 상세·변경 command까지 구현되어 있으나 production Edge는 현재 **전체 객실 목록 1개만** 이식·배포돼 있다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | business admin 생성 전 실제 admin smoke 대기 |
| [ ] | `GET /v1/rooms/{roomId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `PATCH /v1/rooms/{roomId}/master-data` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks/{blockId}/release` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/candles` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/issues` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/issues/{issueId}/resolve` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |
| [ ] | `POST /v1/rooms/{roomId}/pin-sync-events` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #53 |

## 8. 메이드 주간 가능일 API — Edge parity #51 (P0)

**현재 최우선 메이드 Edge 누락 영역이다.** #51은 새 도메인 개발이 아니라 이미 완료된 #6 DB/Fastify 계약의 Edge HTTP parity이며 `v0.2.0` operational activation P0 gate다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/availability?weekStart=...` | maid / admin | ✅ | ✅ | ❌ | ❌ | ❌ | #51, maid는 본인 데이터만 |
| [ ] | `POST /v1/availability/submissions` | maid | ✅ | ✅ | ❌ | ❌ | ❌ | #51, `submit_weekly_availability` |
| [ ] | `POST /v1/availability/change-requests` | maid | ✅ | ✅ | ❌ | ❌ | ❌ | #51, 마감 후 변경 요청 |
| [ ] | `GET /v1/availability/change-requests` | maid / admin | ✅ | ✅ | ❌ | ❌ | ❌ | #51, maid는 본인 요청만 |
| [ ] | `POST /v1/availability/change-requests/{requestId}/decision` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #51, 승인/반려 |
| [ ] | `GET /v1/availability/candidates?workDate=...` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #51, 배정 후보 조회 |

### #51 완료 조건

- [ ] Fastify 계약과 동일한 validation/error code/camelCase projection
- [ ] maid self-only / admin exact-role / developer 차단 회귀
- [ ] must-change/inactive/revoked/upload-only 차단
- [ ] KST 제출창, CAS version, Idempotency-Key 계약 유지
- [ ] OpenAPI/Swagger/codegen 갱신
- [ ] Edge Deno tests + required CI + 독립 리뷰 P0/P1=0
- [ ] `dev → release → main`
- [ ] production `api` 재배포 및 maid/admin/developer hosted HTTP smoke
- [ ] 배포 OpenAPI 및 GitHub Pages snapshot 갱신

## 9. 예약·청소요청 API — Edge parity #52 (P1)

운영 DB와 Fastify에는 구현돼 있으나 production Edge `api`에는 아직 없다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/reservations` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 목록 |
| [ ] | `GET /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 상세 |
| [ ] | `POST /v1/reservations` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 예약 생성 |
| [ ] | `PATCH /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 예약 변경 |
| [ ] | `POST /v1/reservations/{reservationId}/cancel` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 예약 취소 |
| [ ] | `POST /v1/reservations/{reservationId}/manual-checkout` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 수동 체크아웃 |
| [ ] | `POST /v1/reservations/cleaning-requests` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 연박/추가 청소 요청 |
| [ ] | `POST /v1/reservations/cleaning-requests/{targetId}/cancel` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 청소 요청 취소 |
| [ ] | `POST /v1/reservations/transitions/process` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | #52 관리자 수동 transition |

## 10. Reservation Scheduler Edge Function

| 체크 | Function / Path | 권한 | DB/RPC | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /functions/v1/reservation-scheduler` | scheduler secret + active admin actor | ✅ | ✅ | ✅ | ⛔ | Function ACTIVE, actor/secret 미설정으로 503 fail-closed |
| [ ] | scheduler heartbeat 기록/조회 | scheduler + developer projection | ✅ | ✅ | ❌ | ❌ | #48 dev source 완료. migration + scheduler 재배포 필요 |

## 11. 아직 개발하지 않은 후속 API 영역

아래는 Edge 누락이 아니라 **기능/API 자체가 아직 후속 개발 대상**이다. 실제 route는 각 Issue 구현 PR에서 확정하고 이 문서를 갱신한다.

| 체크 | 영역 | 상태 | 관련 Issue | 비고 |
|---|---|---|---|---|
| [ ] | 청소 담당 배정·revision·현재 pointer·순서 | 미개발 | #25 | #4 분할 |
| [ ] | 배정 저장 시 가능일 재검증·부분 알림 | 미개발 | #26 | #4 분할 |
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

## 12. 현재 우선순위

production completeness 기준의 정본 순서다.

1. [x] #48 `dev` 병합
2. [ ] **#51 Availability Edge parity (P0)** — 최우선
3. [ ] **#44 Python 운영도구 Phase A** — #51과 병행 가능
4. [ ] #52 Reservation Edge parity (P1)
5. [ ] #53 Room detail/mutation Edge parity (P1)
6. [x] PR #50 GitHub Pages Swagger portal source·독립 리뷰 완료 — parity와 병행 가능
7. [ ] 최신 source를 `release/v0.2.0 → main`으로 승격
8. [ ] 필요한 신규 migration 순차 적용
9. [ ] `api`와 `reservation-scheduler`를 승인된 `main` source로 재배포
10. [ ] developer / business admin / maid 실제 hosted HTTP role matrix smoke
11. [ ] Python 콘솔에서 business admin 생성 및 최초 비밀번호 변경
12. [ ] scheduler actor/invoke secret → Vault/pg_cron/pg_net 활성화
13. [ ] Cron heartbeat/audit/idempotency smoke
14. [ ] GitHub Pages workflow 수동 실행 및 공개 portal/openapi snapshot smoke
15. [ ] `v0.2.0` tag / GitHub Release

## 13. 이 문서 갱신 규칙

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

## 14. 연결 문서·Issue

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
- `docs/AI_BACKEND_PRODUCT_GUIDE.md`
- `docs/FRONTEND_API_INTEGRATION.md`
- `docs/DEVELOPER_OPERATIONS_API.md`
- `docs/EDGE_RUNTIME_POC.md`
- `docs/RELEASE_V0.2.0.md`
