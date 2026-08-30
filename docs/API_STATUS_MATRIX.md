# API 구현·Edge 배포·운영 사용 상태 정본

이 문서는 백엔드 API의 **개발 완료 여부**, **Supabase Edge 이식 여부**, **production 배포 여부**, **현재 실제 사용 가능 여부**를 한 곳에서 추적하는 정본이다.

API/DB/Edge 관련 PR은 상태가 바뀌면 반드시 이 문서를 같은 PR에서 갱신한다. Fastify 코드나 DB RPC가 존재한다는 이유만으로 production에서 사용할 수 있다고 표시하지 않는다.

## 1. 상태 판정 규칙

| 표시 | 의미 |
|---|---|
| ✅ | 해당 단계 완료 및 검증됨 |
| 🟡 | 소스는 완료됐으나 아직 상위 브랜치 승격 또는 production 반영 전 |
| ⚠️ | 배포는 됐지만 계정·secret·runtime activation 등 선행조건 때문에 실제 업무 사용은 아직 제한됨 |
| ⛔ | 의도적으로 fail-closed / 비활성 상태 |
| ❌ | 해당 단계 미구현 또는 미배포 |
| — | 해당 단계가 필요하지 않음 |

각 열의 의미:

- **DB/RPC**: 필요한 table/RLS/RPC/command 계약이 Git source와 검증에 존재하는가.
- **Fastify HTTP**: 기존 Fastify adapter에 HTTP endpoint가 존재하는가.
- **Edge source**: `supabase/functions/api` 또는 별도 Edge Function에 동일 업무 계약이 이식됐는가.
- **Production Edge**: 승인된 `main` source가 운영 Supabase Edge runtime에 실제 배포됐는가.
- **현재 사용**: migration, secret, 계정/역할, runtime smoke까지 만족해 실제 클라이언트가 호출 가능한가.

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
- 현재 `dev`: `02d5089ead35f10485bac58011d617682312e863`
- PR #48 / #43 developer 운영 API: `dev` 병합 완료
- 운영 migration: **17건**
- 운영 Edge Functions:
  - `api` version 2 — ACTIVE
  - `reservation-scheduler` version 2 — ACTIVE
- production `api` 실제 HTTP operation: **13개**
- production `api`에는 아직 `/v1/developer/*`, `/v1/availability/*`, `/v1/reservations/*`, 객실 상세/변경 API가 없음
- business admin: 아직 생성하지 않음
- scheduler actor/invoke secret: 아직 미설정, 현재 `reservation-scheduler` 503 fail-closed가 정상
- #48 developer API 6개는 `dev` source 완료 상태지만 release/main/production 미반영

> production의 실제 배포 여부는 Git branch 상태가 아니라 Supabase Edge Function readback과 HTTP smoke를 기준으로 갱신한다.

## 3. System / 문서 API

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /health` | public | — | ✅ | ✅ | ✅ | ✅ | runtime 응답 확인 |
| [x] | `GET /openapi.json` | public | — | — | ✅ | ✅ | ✅ | production HTTP 계약 정본 |
| [x] | `GET /docs` | public | — | — | ✅ | ✅ | ✅ | 한글 Swagger UI |

## 4. Auth API

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `POST /v1/auth/login` | all accounts | ✅ | ✅ | ✅ | ✅ | ✅ | durable client/login/global limiter |
| [x] | `GET /v1/auth/me` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | Auth user + latest active profile + active session 재검증 |
| [x] | `POST /v1/auth/password` | authenticated | ✅ | ✅ | ✅ | ✅ | ✅ | timeout 응답 유실 retry 의미는 후속 #46 |

## 5. 계정 관리 API

현재 developer 계정으로 호출 가능하다. business admin/maid 계정 생성은 운영 Python 도구 #44 Phase A에서 수행할 계획이다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | 전체 전화번호 미노출 |
| [x] | `POST /v1/accounts` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | `admin | maid`만 생성 가능 |
| [x] | `PATCH /v1/accounts/{profileId}/role` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | developer 생성/승격 금지 |
| [x] | `PATCH /v1/accounts/{profileId}/status` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | 마지막 active admin 보호 |
| [x] | `POST /v1/accounts/{profileId}/unlock` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | developer 대상 금지 |
| [x] | `POST /v1/accounts/{profileId}/password-reset` | developer / admin | ✅ | ✅ | ✅ | ✅ | ✅ | developer는 self-change만 허용 |

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
- [ ] `release/v0.2.0 → main` source 승격
- [ ] `developer_operations_projections` migration 1회 적용
- [ ] production `api` 재배포
- [ ] production `reservation-scheduler` 재배포 — heartbeat source 포함
- [ ] developer / admin / maid 권한 smoke
- [ ] redaction / migration drift / critical RPC production smoke

## 7. 객실 API

DB와 Fastify에는 상세·변경 command까지 구현되어 있으나 production Edge는 현재 **전체 객실 목록 1개만** 이식·배포돼 있다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [x] | `GET /v1/rooms` | admin | ✅ | ✅ | ✅ | ✅ | ⚠️ | endpoint는 배포됨. business admin 생성 전 실제 admin smoke 대기 |
| [ ] | `GET /v1/rooms/{roomId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `PATCH /v1/rooms/{roomId}/master-data` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/operation-blocks/{blockId}/release` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/candles` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/issues` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/issues/{issueId}/resolve` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |
| [ ] | `POST /v1/rooms/{roomId}/pin-sync-events` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | Edge parity 필요 |

## 8. 메이드 주간 가능일 API

**현재 가장 명확한 메이드 Edge 누락 영역이다.**

DB/RLS/RPC와 Fastify HTTP는 구현 완료됐지만 `/v1/availability/*`는 Edge `api`에 아직 이식되지 않아 production에서 사용할 수 없다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/availability?weekStart=...` | maid / admin | ✅ | ✅ | ❌ | ❌ | ❌ | maid는 본인 데이터만 |
| [ ] | `POST /v1/availability/submissions` | maid | ✅ | ✅ | ❌ | ❌ | ❌ | `submit_weekly_availability` |
| [ ] | `POST /v1/availability/change-requests` | maid | ✅ | ✅ | ❌ | ❌ | ❌ | 마감 후 변경 요청 |
| [ ] | `GET /v1/availability/change-requests` | maid / admin | ✅ | ✅ | ❌ | ❌ | ❌ | maid는 본인 요청만 |
| [ ] | `POST /v1/availability/change-requests/{requestId}/decision` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 승인/반려 |
| [ ] | `GET /v1/availability/candidates?workDate=...` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 배정 후보 조회 |

### Availability Edge parity 완료 조건

- [ ] Fastify 계약과 동일한 validation/error code/camelCase projection
- [ ] maid self-only / admin 권한 회귀
- [ ] must-change password 차단
- [ ] Idempotency-Key 계약 유지
- [ ] OpenAPI/Swagger 추가
- [ ] Edge Deno tests
- [ ] `dev → release → main`
- [ ] production `api` 재배포 및 maid/admin HTTP smoke

## 9. 예약·청소요청 API

운영 DB와 Fastify에는 구현돼 있으나 production Edge `api`에는 아직 없다.

| 체크 | Method / Path | 권한 | DB/RPC | Fastify HTTP | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|---|
| [ ] | `GET /v1/reservations` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 목록 |
| [ ] | `GET /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 상세 |
| [ ] | `POST /v1/reservations` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 예약 생성 |
| [ ] | `PATCH /v1/reservations/{reservationId}` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 예약 변경 |
| [ ] | `POST /v1/reservations/{reservationId}/cancel` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 예약 취소 |
| [ ] | `POST /v1/reservations/{reservationId}/manual-checkout` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 수동 체크아웃 |
| [ ] | `POST /v1/reservations/cleaning-requests` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 연박/추가 청소 요청 |
| [ ] | `POST /v1/reservations/cleaning-requests/{targetId}/cancel` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 수동 청소 요청 취소 |
| [ ] | `POST /v1/reservations/transitions/process` | admin | ✅ | ✅ | ❌ | ❌ | ❌ | 관리자 수동 transition 실행. scheduler와 별도 |

## 10. Reservation Scheduler Edge Function

| 체크 | Function / Path | 권한 | DB/RPC | Edge source | Production Edge | 현재 사용 | 비고 |
|---|---|---|---|---|---|---|---|
| [x] | `POST /functions/v1/reservation-scheduler` | scheduler secret + active admin actor | ✅ | ✅ | ✅ | ⛔ | Function은 ACTIVE지만 actor/secret 미설정으로 503 fail-closed |
| [ ] | scheduler heartbeat projection | developer 조회 | ✅ | ✅ | ❌ | ❌ | #48 dev source. migration + scheduler 재배포 필요 |

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

현재 production completeness 관점의 권장 순서다.

1. [x] #48 `dev` 병합
2. [ ] #44 Python 운영도구 Phase A 진행
3. [ ] **Availability `/v1/availability/*` Edge 이식** — 메이드 핵심 API
4. [ ] Reservation `/v1/reservations/*` Edge 이식
5. [ ] Room detail/mutation Edge 이식
6. [ ] 최신 source를 `release/v0.2.0 → main`으로 승격
7. [ ] 필요한 신규 migration 순차 적용
8. [ ] `api`와 `reservation-scheduler`를 승인된 `main` source로 재배포
9. [ ] developer / business admin / maid 실제 HTTP role matrix smoke
10. [ ] Python 콘솔에서 business admin 생성 및 최초 비밀번호 변경
11. [ ] scheduler actor/invoke secret → Vault/pg_cron/pg_net 활성화
12. [ ] Cron heartbeat/audit/idempotency smoke
13. [ ] `v0.2.0` tag / GitHub Release

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
- production Function readback + HTTP smoke 통과 → Production ✅
- production에 있어도 actor/secret/account 등 prerequisite 미충족 → 현재 사용 ⚠️ 또는 ⛔
- 실제 role별 smoke까지 통과 → 현재 사용 ✅

Swagger/OpenAPI에 표시된 operation 수와 이 문서의 **Production Edge ✅** endpoint 수가 다르면 배포 drift로 보고 확인한다.

## 14. 연결 문서·Issue

- Roadmap: #14
- v0.2.0 release: #24
- Supabase runtime decision: #35
- Edge runtime PoC: #36
- developer 운영 API: #43 / PR #48
- Python 운영도구: #44
- self password retry 후속: #46
- `docs/AI_BACKEND_PRODUCT_GUIDE.md`
- `docs/FRONTEND_API_INTEGRATION.md`
- `docs/DEVELOPER_OPERATIONS_API.md`
- `docs/EDGE_RUNTIME_POC.md`
- `docs/RELEASE_V0.2.0.md`
