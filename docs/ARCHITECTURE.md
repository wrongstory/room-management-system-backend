# 백엔드 서버 설계

> 문서 지위: 설계 검토 초안이다. 구현 전에 [백엔드 AI 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 먼저 읽는다. 이 문서와 ERD/DBML은 제품 가이드와 reconcile되기 전에는 목표 계약이 아니며, `[미확정]` 정책을 기존 코드나 이 문서만으로 확정하지 않는다.

## 기술 선택

- 개발 기준 API: Node.js 22, Fastify 5, TypeScript
- production PoC: Supabase Edge Functions(Deno 2) + Supabase Cron
- 데이터·인증: Supabase Auth, PostgreSQL 17
- 사진 파일: Google Drive API, 전용 비공개 폴더
- 입력 검증: Zod
- API 계약: OpenAPI 3.1 + 로컬 pinned Swagger UI + GitHub Pages 읽기 전용 운영 snapshot + [프론트·Codex 연동 가이드](./FRONTEND_API_INTEGRATION.md)
- 테스트: Vitest, Fastify injection, Deno Edge type check
- 배포 후보: 운영 Supabase의 Edge Functions·Cron + Supabase 복구검증 프로젝트

Fastify는 현재 개발 기준선이며 Edge PoC가 실패할 때의 rollback 경로다. 월 `$0` 운영을 위해 Issue #36에서 HTTP adapter만 Edge Functions로 교체할 수 있는지 검증한다. 핵심 정합성은 어느 adapter에서도 API 메모리가 아니라 PostgreSQL 제약과 트랜잭션에 둔다.

## 신뢰 경계

### #84/#85 사진 HTTP adapter와 보존 정리 worker — feature source 검증 중

`src/modules/photos`의 순수 binary validator/Drive adapter/application service를 Fastify와 generated Deno bridge가 공유한다.
인증→DB durable admission/quota→bounded raw body/실파일 검증→begin/claim→사전 provider identity 저장→외부 HTTP→provider 성공 기록→finalize 순서이며 외부 요청 중 DB transaction을 유지하지 않는다.
#83 legacy primitive service-role grant는 #84 migration에서 회수하고 admitted wrapper만 HTTP 서비스 경계로 사용한다.
slot/status metadata와 original content 권한은 분리한다. limited upload는 일반 active guard를 완화하지 않으며 content는 provider wait 이후에도 최신 권한을 재검증한다.
decoder packaging은 pinned glue+단일 gzip WASM과 양쪽 SHA/license 재생성 검증이며 runtime CDN fallback이 없다. actual local worker(memory256MB/CPU2초) 합성4MP JPEG/WebP gate는 통과했으며 운영 Google/hosted 검증은 release 후 별도다. ignored asset 재생성 때문에 배포 전 `npm ci`와 `npm run edge:check`가 모두 성공해야 한다. 실패/누락 시 deploy 금지다.
상세는 [사진 저장 계약](./PHOTO_STORAGE.md)과 [사진 상태 gate](./API_STATUS_MATRIX.md)를 따른다. #84 업로드·열람은 dev에 병합됐고, #85는 별도 `photo-purge` Function source와 append-only migration을 구현 중이다. 원격 Google·production·#31 제출 구현은 제외한다.

#85 worker는 accepted 보존 만료, never-accepted orphan 보상, 확인된 빈 room/date 폴더를 서로 다른 durable 원장으로 처리한다. 한 실행의 세 단계 claim 합계는 10 이하이고 45초 wall budget 안에서만 동작하며 Edge에서 sleep하지 않는다. provider `204/404`만 성공이고 retry는 DB `next_attempt_at`이 결정한다. 폴더 retirement는 operation→room-folder binding 및 upload state를 함께 잠가 reserve/provider-success/finalize와 경쟁해도 진행 중 업로드를 삭제하지 않는다. room 폴더를 먼저 정리하고 모든 child가 terminal인 경우에만 date 폴더를 정리한다. raw Drive locator는 terminal settle에서 지우고 private digest tombstone과 immutable cleanup event만 남긴다.

```mermaid
flowchart LR
  UI[개발자·관리자·메이드 PWA] -->|Bearer access token| API[Fastify 또는 Edge API adapter]
  DOCS[GitHub Pages 읽기 전용 Swagger] -->|배포 시 검증한 snapshot| OPENAPI[Production OpenAPI JSON]
  OPS[Python API-only 운영 콘솔] -->|developer bearer token| API
  API -->|사용자 JWT| DATA[Supabase Data API · RLS]
  API -->|서버 secret| ADMIN[Auth 관리·원자 명령]
  DATA --> DB[(PostgreSQL)]
  API -->|서버 OAuth · drive.file| DRIVE[Private Google Drive folder]
  DB --> CRON[Supabase Cron · pg_net]
  CRON --> JOBS[Edge scheduler · 예약 전이·보존]
```

- 브라우저에는 publishable key만 허용합니다.
- secret/service-role 키는 서버에서만 사용하고 로그에 남기지 않습니다.
- 조회는 가능한 한 사용자 JWT와 RLS를 통과시킵니다.
- 계정 생성·비밀번호 초기화·여러 원장을 함께 바꾸는 명령만 서버 secret과 DB 함수를 사용합니다.
- Google Drive access/refresh token은 서버 secret으로만 보관하며 브라우저는 Drive에 직접 접근하지 않습니다.
- GitHub Pages에는 production OpenAPI snapshot과 정적 UI만 배포합니다. token 입력과 API 실행을 비활성화하고 service-role key나 repository secret을 artifact에 포함하지 않습니다.

developer 운영 상태는 `private` 원본이나 Supabase 내부 schema를 Edge에서 직접 직렬화하지 않습니다. DB catalog·Cron·감사 원장은 developer role을 다시 검증하는 app-owned `SECURITY DEFINER` projection을 거치고, Edge는 camelCase 응답과 안정적인 error code만 공개합니다. runtime secret은 소스 allowlist의 `configured` boolean만 반환하며 값·길이·해시·부분문자열은 반환하지 않습니다. Python 운영도구 연동은 [developer 운영 API 가이드](./DEVELOPER_OPERATIONS_API.md)를 따른다.

## 인증

1. 서버가 먼저 불변 profile UUID를 만들고, 관리자가 그 ID로 Supabase Auth 사용자를 생성합니다.
2. 내부 이메일은 `user-{profile_id}@auth.castletheart.invalid` 형식으로 서버만 계산합니다.
3. 사용자가 이름형 `loginId`와 최초 휴대전화 끝 4자리 임시 비밀번호 또는 허용된 개인 비밀번호를 보냅니다. 개인 비밀번호는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합이며, 4자리 임시값은 서버 내부에서만 Supabase 최소 길이를 만족하는 namespace 값으로 변환합니다.
4. 서버가 활성 alias와 프로필을 찾고 5회 실패/15분 잠금을 검사합니다.
5. 서버가 Supabase Auth password 로그인을 수행해 access/refresh token을 반환합니다.
6. 이후 API는 `auth.getUser(accessToken)`과 `auth.sessions`의 `session_id`를 검증하고 최신 프로필 역할·상태를 다시 읽습니다.

권한은 사용자 수정 가능한 `user_metadata`에 의존하지 않습니다. 역할 변경과 비활성화가 JWT 갱신 전에도 반영되도록 DB 프로필을 매 요청 확인합니다.

Edge 로그인은 alias 조회 전에 PostgreSQL fixed-window 제한을 **Supabase gateway가 확인한 client HMAC bucket(30회/분) → 정규화 ID별 HMAC bucket(10회/분) → 높은 emergency global bucket(600회/분)** 순서로 원자적으로 소비합니다. 공격 client가 ID를 계속 바꿔도 자기 bucket만 소진하며 다른 정상 client의 로그인을 막지 못합니다. global cap은 여러 client를 동원한 비상 상황의 최종 안전장치입니다. 원문 IP와 로그인 ID는 저장하지 않고, 첫 차단을 기록한 `limit + 1` 이후 같은 window의 추가 거부는 saturated row를 갱신하지 않습니다. 만료 row 정리도 요청당 최대 64개만 수행합니다. Edge instance 메모리는 cold start와 수평 확장 때 공유되지 않으므로 보안 제한 상태를 두지 않습니다. 사용자별 5회 실패/15분 잠금은 이 abuse 제한과 별도로 유지합니다.

성공한 업무 상태 변경은 `public.audit_events`에 immutable domain audit로 남깁니다. 로그인 성공·알려진 계정 로그인 실패·실제 민감정보 조회는 별도의 `private.actor_activity_events`에 개별 기록합니다. 알 수 없는 로그인 ID 실패는 ID/IP/HMAC 없이 분 단위 aggregate로, 인증된 actor의 중요 capability 거부는 `(actor, source, reason, UTC minute)` 단위 aggregate로 집계하며 count는 600에서 포화됩니다. activity 원장에 영구 저장되는 `request_id`는 Edge가 직접 생성한 UUID v4만 허용하고 caller의 `X-Request-ID`는 응답 correlation에만 transient하게 사용합니다. 모든 private 원본은 Data API에 노출하지 않고 fixed `search_path`와 exact server-only grant를 가진 app-owned RPC를 통해서만 append/projection합니다.

## 데이터 모델

```mermaid
erDiagram
  PROFILES ||--o{ LOGIN_ALIASES : authenticates
  ROOM_TYPES ||--o{ ROOMS : classifies
  ROOMS ||--o{ RESERVATIONS : books
  RESERVATIONS ||--o{ RESERVATION_SCHEDULE_REVISIONS : revises
  RESERVATIONS ||--|| PREPARATION_OBLIGATIONS : requires
  RESERVATIONS ||--|| CHECKOUT_CLEANING_OBLIGATIONS : creates
  RESERVATIONS ||--o{ ROOM_OCCUPANCY_EVENTS : changes
  ROOMS ||--o{ CLEANING_TARGETS : requires
  CHECKOUT_CLEANING_OBLIGATIONS o|--o| CLEANING_TARGETS : materializes
  CLEANING_TARGETS ||--o{ CLEANING_ASSIGNMENTS : revises
  CLEANING_ASSIGNMENTS ||--o{ CLEANING_ATTEMPTS : executes
  CLEANING_ATTEMPTS ||--o{ CLEANING_SUBMISSIONS : versions
  CLEANING_SUBMISSIONS ||--o| INSPECTION_DECISIONS : decides
  CLEANING_SUBMISSIONS ||--o| EARNINGS : earns
  PROFILES ||--o{ PAYROLL_CYCLES : paid
  PROFILES ||--o{ NOTIFICATIONS : receives
  PROFILES ||--o{ AUDIT_EVENTS : acts
  PROFILES ||--o{ ACTOR_ACTIVITY_EVENTS : generates
```

색상이나 `투숙 중/청소 필요/배정 가능/배정 불가` 같은 복합 UI 상태는 저장하지 않습니다. 예약·수동 점유 보정·운영 중지·청소 단계·촛불·차단 이슈에서 파생합니다.

## 동시성과 멱등성

### #83 사진 업로드 작업 원장 — source/dev 완료, production 미승격

[PR #86](https://github.com/wrongstory/room-management-system-backend/pull/86)은 exact head
`3dfbb70176533a69257c68c2b2af2ee19cc9bd22`의 독립 QA P0/P1/P2=0·required CI·Codex 96/100 승인 후
`dev@cf91753de8b80ce5abef3c8dc0aa8bf5e85b479b`에 병합됐다. 현재 개발 통합은
31 migrations / 63 paths / 68 operations다. 기존 production 19 migrations / 39 paths / 43 operations는
변경하지 않았다. 다음 구현은 #84 → #85 → #31이며 실제 Drive/HTTP/purge는 아직 미구현이다.

`photo_storage_operations`는 #30 뒤의 append-only 개발 migration이다. private operation/object,
mutable lease/state, immutable acceptance/event를 분리한다. scoped key digest + canonical request hash와
실제 binding tuple 비교로 retry를 동일 작업에 수렴시킨다. raw key/session/provider locator는 공개 응답이나
audit에 복제하지 않는다. provider object UUID는 작업당 하나이고 locator는 provider 전체에서 unique다.

외부 업로드 전 작업 identity와 claim/fence를 commit한다. 실제 Drive 호출은 #84가 DB transaction 밖에서
수행한 뒤 최초 성공 시각을 기록한다. finalize는 최신 actor/session/capability와 photo CAS를 재검증하고,
verified photo/current/history/acceptance/`photo.upload_accepted` audit를 한 transaction으로 확정한다.
helper의 metadata 주장은 실제 bytes/provider 검증을 대체하지 않는다.

DB 응답 유실은 실패 확정이 아니다. worker reconciliation은 기존 사용자의 session 폐기와 무관하게
accepted 연결을 조회하며, 과거 current 사진·submission에서도 사용된 파일을 고아로 판정하지 않는다.
unknown provider 결과는 reconciliation_pending으로 보존한다. never-accepted임을 확인하고 비즈니스 finalize를
차단하는 compensation_pending fence를 획득한 candidate만 후속 adapter의 보상 대상이다.
accepted 파일의 7일 삭제 worker/Cron과 HTTP 열람은 #85/#84 후속이며 이번에 구현하지 않는다.

서비스 RPC만 private 원장을 쓴다. global domain lock → profile NO KEY UPDATE → live Auth session SHARE →
attempt → storage state/object 순서와 마지막 clock을 사용한다. actor당 30/min 포화 row, provider 호출 가능한 in-flight 8건,
slot당 1건, lease 5분·최대8회 claim은 구현 자원 상한이고 제품 capability TTL은 그대로다.
lease claim digest와 fence를 모두 검사하며 다른 worker가 유효 claim을 공유하거나 만료 claim으로 확정하지 못한다.
세부 state/권한/후속 범위는 [사진 저장 운영안](./PHOTO_STORAGE.md)을 따른다.

### #30 사진·제출 기반 모델 — source/dev 완료, production 미승격

[PR #81](https://github.com/wrongstory/room-management-system-backend/pull/81)은 독립 QA P0/P1=0,
required CI와 Codex 위임 평가96/100 승인을 거쳐 `dev@a4f8cb5b3c551b6df641491f5ac02c209d71f26d`에
병합됐다. 당시 개발 통합은 30 migrations / 63 paths / 68 operations였으며, 기존 production
19 migrations / 39 paths / 43 operations는 변경하지 않았다. 최신 통합 상태와 다음 작업은 위 #83 절을 따른다.

사진 객체의 업로드, 제출본 작성, 검수와 물리 현장 완료는 분리한다.
target 생성 당시 고정한 사진 슬롯을 attempt별 사진 version이 참조하고,
현재 사진 pointer와 불변 제출본의 사진 binding은 서로 다른 관계로 관리한다.
인계 전 사진이 새 maid의 attempt로 승계되거나 재촬영으로 과거 제출 증빙이 바뀌면 안 된다.

이번 #30은 모델과 내부 완전성 검증 기반이며 새 HTTP API나 Drive worker를 제공하지 않는다.
서버 내부 metadata 검증은 파일의 magic bytes·EXIF·Drive 업로드 성공 검증을 대체하지 않는다.
빈/불명확한 legacy template은 보존하면서 새 제출은 fail-closed하고, 현재 v7을 과거 작업에
자동 적용하지 않는다. 기존 사진 없는 물리적 현장 완료 계약은 유지한다.
상세 범위와 검증 상태는 [사진·제출 기반 모델](./PHOTO_SUBMISSION_BASE.md)을 따른다.

| 작업 | 서버 보장 |
|---|---|
| 계정 명령 | `(actor_profile_id, command_type, idempotency_key)` receipt + canonical request hash. 같은 scope·같은 payload는 동일 결과를 재생하고, 같은 scope·다른 payload는 거부하며, 서로 다른 actor/command의 동일 raw key는 충돌하지 않음. 동시 계정 생성에서 DB winner 외 Auth 사용자는 보상 삭제 |
| 객실·예약 명령 | actor 최신 상태·admin 역할 + 객실 `state_version`/예약 `version` CAS + actor/명령별 idempotency key + 짧은 전역 advisory lock으로 lock 순서 고정 |
| 예약 저장 | KST 기준 최소 1박·분 단위 + `[check_in_at, check_out_at)` `tstzrange` GiST exclusion으로 겹침 차단 |
| 입·퇴실 전이 | 고유 event key + 예약 lock으로 예정/수동 전이 중복 차단. 한 batch에서는 퇴실을 먼저 닫아 같은 instant의 다음 입실을 지연시키지 않고, worker 중단 중 완전히 지난 미입실 예약도 가짜 check-in 없이 checkout으로 catch-up |
| 주간 가능일 | 일요일 12:00–23:59 KST + 메이드/주차 current version CAS + canonical request hash |
| 마감 후 가능일 변경 | pending 요청 1건 + 관리자 결정 row lock + 승인 때만 새 immutable version |
| 청소 요청 | 예약·객실·checkout obligation·target을 양방향 복합키로 고정하고 동일 obligation을 한 번만 materialize. 연박/추가 수동 요청은 점유·접근 구간과 겹침을 검증한 안정적인 target ID 및 CAS soft cancel |
| 입실 준비 증명 | preparation obligation의 current attempt와 approved submission을 같은 수행으로 묶고, target 접근 가능 시각 이후 `attempt 시작 → 현장 완료 → 종료 → 제출 → 승인` 순서가 직전 점유 종료 이후부터 해당 체크인 이전까지 같은 객실에서 완결된 경우만 `approved` 허용. submission 소비 원장은 append-only·전역 unique라 다른 예약에 재사용할 수 없음 |
| PIN lease | 객실·예약·target·현재 assignment·현재 attempt·담당 메이드·최신 verified PIN version을 한 계약으로 묶음. 수동 checkout은 stale lease를 폐기하고 현재 verified version으로 현재 미공개 lease 한 건만 새 revision으로 재발급 |
| 담당 변경 | 대상 `assignment_version` CAS + 현재 담당 partial unique |
| 미통보 draft 배정 | target row lock + immutable assignment revision + 현재 `(maid, service_date, sequence)` partial unique. 저장 시 target 날짜·접근 가능·마감 시각 snapshot 고정 |
| 배정 알림 확정 | 서비스 날짜 global lock + target/assignment row lock + maid/week availability advisory lock + impact fingerprint + assignment/availability version CAS. 선택 부분집합 전체를 한 transaction으로 notification/outbox/audit와 함께 확정 |
| 청소 시작 | 메이드별 `in_progress` partial unique |
| 제출 | `client_submission_id` unique + 회차별 현재 제출 unique |
| 검수 | 제출별 decision unique, 현재 `submitted` 버전만 조건부 전이 |
| 수익 | submission/entitlement unique |
| 지급 | `(maid_profile_id, week_start)` unique + earning의 `earned_on` 주차 일치 + `payroll_items.earning_id` exclusive claim + PAYING 이후 snapshot 불변 + 미송금 사유 기록 reopen + version CAS |
| 알림 | 수신자별 dedupe key unique, 10분 group key |

복수 테이블을 바꾸는 예약 저장·변경·취소·체크아웃과 배정 알림 확정은 SQL RPC의 짧은 transaction으로 원장, projection, 감사 이벤트를 함께 커밋합니다. 검수·지급도 같은 원칙으로 후속 구현합니다. 외부 Drive·push 호출은 transaction 밖에서 outbox worker가 처리합니다.

#25의 미통보 draft 배정은 기존 `cleaning_targets`와 `cleaning_assignments`를 재사용합니다. active business admin만 service-role RPC를 호출하며 DB가 actor를 다시 검사합니다. target의 `assignment_version`을 CAS로 잠근 뒤 기존 current draft를 `DRAFT_REVISED`로 닫고 새 immutable revision을 추가합니다. 이 단계는 `draft_assigned`까지만 전이하며 notification, outbox, cleaning attempt는 생성하지 않습니다.

### #4 통보된 배정 조회 경계 — 2026-09-08 승인

메이드 조회는 active profile/self ownership/notified revision을 모두 요구합니다. current 목록과
history 모두 미통보 draft를 제외하며, 본인에게 실제 통보됐던 종료·superseded revision은
history에 남깁니다. 다른 maid와 한 번도 본인에게 통보되지 않은 revision은 숨깁니다.
RLS 외에도 Edge query에서 self/notified를 다시 제한하며 파생 target·schedule·attempt 조회가
새 계획을 노출하는지 함께 검증합니다. 읽기 권한은 activation/start/PIN 권한이 아닙니다.

통보 시점의 객실 ID/번호는 assignment에 immutable snapshot으로 저장합니다. 메이드 history는
현재 target의 이동된 객실이나 최신 assignment version을 service-role hydration으로 읽지 않습니다.
근거 없는 legacy 통보 행의 객실 snapshot은 null이며 현재 객실로 추측해서 채우지 않습니다.
메이드 `targetAssignmentVersion`은 해당 통보 revision의 version이고 관리자는 현재 CAS를 봅니다.
별도 Fastify assignment route는 기존에 없으므로 이번에 만들지 않습니다.

PR #74는 기존 25개 migration을 그대로 두고 `20260908101844_maid_assignment_visibility.sql`만
추가해 dev에 병합됐습니다. 그 PR에는 #7A/B/C의 실행/lease/limited session을 포함하지 않았습니다.
field_completed는 물리적 완료 선언, 필수사진은 submission gate라는 최신 제품 가이드를 따릅니다.

검증 중 발견한 기존 예약 객실 변경의 즉시 FK 충돌은 #73에서 별도 추적합니다. 현재 실제
`change_reservation` 경로는 planned target 참조 때문에 실패하므로 이번 검증을 객실 변경 성공으로
표현하지 않습니다. 현재 실패의 원자성과 별도 합성 relocation의 과거 snapshot 비노출을 구분합니다.

### #7A 온라인 실행 경계

시작/물리 완료와 실행 version은 [Attempt Execution Core](./ATTEMPT_EXECUTION_CORE.md)를 따릅니다.
기존 #28 활성화는 scheduled 회차를 만들고 #7A의 exact own active maid 명령이 실행합니다.
일반 active/session guard를 완화하지 않으며, physical completion과 사진/submission/검수/ready는
별도 축으로 유지합니다. 시간창·source·실제 점유는 시작 시 다시 검증하되 정상 시작 후 자정·마감·
scheduled checkout만으로 물리 완료를 막지 않습니다. #7B 전 일반 계정 변경이 진행 업무를 고립시키지
않도록 DB에서 거부하며 #7A 자체에는 limited capability/Auth 방법을 포함하지 않았습니다.

### #7B 인계·제한 권한 경계 — source/dev 완료

[Attempt Lifecycle](./ATTEMPT_LIFECYCLE.md)은 일반 active-only 인증/RLS와 별도로 기존 Auth
session을 검증하는 limited 경로를 정의합니다. private grant와 revocation 원장은 불변이며
2시간 실행/최대24시간 증빙 권한을 attempt·assignment revision·action에 묶습니다. 별도 로그인
token을 발급하지 않고 만료·완료·인계·회수 뒤 권한을 복원하거나 다른 key로 TTL을 연장하지 않습니다.
admin 전용 명령이 account lifecycle CAS, 실행 전이, 알림/outbox, 감사, receipt를 함께 commit합니다.
일반 인계는 계정 비활성화와 구분하고 명시한 경우에만 이전 담당 계정을 제한 상태로 변경합니다.

미착수 만료 scheduled는 관리자 명령으로 superseded 보존 후 다음날 재배정·재통보할 수 있습니다.
진행 회차의 인계는 새 일정과 실제 source/점유/예약·접근창을 다시 검증합니다. reclean은 다른
maid에게 이관하지 않습니다. #7C offline, 사진/PIN/제출 구현이나 production 활성화는 포함하지 않습니다.

source/dev 승인·서브에이전트 독립 리뷰는 [오케스트레이션 기준](./DEVELOPMENT_ORCHESTRATION.md)을
따릅니다. 점수 90점 이상도 운영 승격 권한을 뜻하지 않습니다.

### #7C 오프라인 완료 경계 — 구현 중

[Offline 계약](./ATTEMPT_OFFLINE.md)에 따라 온라인 시작과 work lease 발급을 원자적으로
처리하고, 오프라인에서는 완료 1종만 기록합니다. 기존 온라인 start DTO를 바꾸지 않는 별도
start-with-lease 경로를 사용합니다. PIN lease나 별도 bearer credential을 재사용하지 않습니다.

서버가 발급한 lease와 본인 Auth/session을 확인한 뒤 현재 유효한 완료는 실행하고, 알려진
만료/회수/재배정 완료는 제한된 metadata로 격리합니다. unknown/다른 사람의 lease는 해당
원장을 만들지 않습니다. lease별 canonical completion 한 건으로 UUID 변경 공격의 row 증가를
제한하고, 모든 잠금 뒤 시각으로 2시간 및 서버발급 후90일 한도를 검사합니다.

90일 metadata/replay 이후에는 재실행하지 않습니다. 영구 command receipt나 audit로 client
UUID/시각/offset/hash/응답을 복제하는 예외는 없습니다. 관리자 correction은 현재 유효한
진행 회차의 물리완료만 별도 불변 결정/provenance로 기록하고 과거 회차를 복구하지 않습니다.
이 구현은 production 자동 purge/HTTP 활성화나 ready/검수/수익을 만드는 작업이 아닙니다.

#26의 알림 확정은 `GET /v1/assignments/commit-impact`에서 반환한 비민감 fingerprint와 선택 항목의 assignment/availability version을 `POST /v1/assignments/commit`에서 재검증합니다. 서비스 날짜는 KST 오늘/내일로 제한하고 source별 예약·점유·재청소 계약과 active maid/current availability를 다시 검사합니다. 성공한 선택 항목은 한 transaction에서 `notified`로 전이하고 `notifications`, private `notification_outbox`, `assignment.notified` 감사 원장을 함께 추가합니다. 일부 항목 실패 시 선택 부분집합 전체가 롤백되며 cleaning attempt와 외부 네트워크 호출은 생성하지 않습니다.

## 시작 전 배정 변경 — #27

네 개의 service-only RPC(change/unassign/cancellation request/decision)가 같은 private command helper를 사용합니다. Edge는 Auth user → active profile → active session → 비밀번호 변경 완료 → exact admin/maid를 확인하고, DB는 actor·ownership·current assignment·target version·transition을 다시 검증합니다.

잠금 순서는 scoped command receipt → 기존 reservation-command advisory lock → target → current assignment → 요청 row이며, 담당 변경은 그 뒤 maid/week availability lock을 사용합니다. attempt INSERT 경계도 같은 reservation/target/assignment 순서를 사용하고 stale assignment revision을 차단합니다. non-superseded attempt가 하나라도 있으면 네 명령 모두 실패합니다. activation 기능 자체는 추가하지 않습니다.

`assignment_change_requests`는 source identity 불변, assignment별 pending partial unique, terminal 수정/DELETE 금지입니다. authenticated에는 SELECT만 주며 RLS는 active admin 전체/maid 자기 요청만 허용합니다. developer는 business 요청을 읽지 못합니다. source assignment 종료 trigger가 pending을 superseded로 바꾸므로 예약 취소/조기 checkout 같은 기존 command도 ghost pending을 남기지 않습니다.

변경은 과거 snapshot을 수정하지 않고 current 종료와 새 revision을 기록합니다. draft에는 알림이 없고 notified에는 기존 actionable notice resolve 및 새 notification/outbox가 receipt/audit와 함께 commit됩니다. 승인 결정은 request를 terminal로 만든 뒤 담당을 해제하며 반려는 담당을 유지합니다. source가 바뀐 요청은 새 assignment를 해제할 수 없습니다.

일정 변경은 생성 command의 정확한 `manual_room_request + additional` 또는 `stayover_request + stayover` 조합에서 같은 날짜의 기존 창 축소만 구현합니다. stayover는 actual check-in 이후 active reservation의 같은 객실·점유 구간을 다시 검증합니다. source-kind 불일치와 checkout 원장 시간 변경은 거부합니다. 미래 planned checkout 재배정도 target identity를 그대로 쓰며 실제 checkout/PIN/attempt를 활성화하지 않습니다.

요청 목록은 최대 31일/100건, `(requested_at,id)` cursor와 maid/page indexes로 제한합니다. reason detail은 길이/형식 제한된 business 데이터이며 관리자/본인에게만 반환하고 감사/알림에서 제외합니다. 4개 audit event는 developer safe projection/OpenAPI/Python 생성 모델에 동기화합니다. 운영/recovery/Pages 및 #7/#69/#10 실행 기능에는 변경이 없습니다.

## 수행 회차 활성화와 이월 — #28

기존 `reservation-scheduler`는 예약 전이와 같은 실제 실행 시각을 사용해 service-only
`process_due_assignment_lifecycle`을 이어서 호출합니다. command receipt는 예약 전이와 별도
`assignment.process_due_lifecycle` scope를 사용하며, target별 core는 #27과 같은
reservation-command advisory lock → target → current assignment 순서로 재검증합니다. public admin/maid
activation route는 추가하지 않았고 메이드의 실제 `in_progress` 시작은 #7 소유입니다.

오늘 KST의 notified current assignment만 접근 가능 시각과 source별 실행 조건을 통과하면
`scheduled` attempt를 정확히 한 건 만듭니다. attempt는 current assignment/maid/revision과 target의
template/room snapshot을 고정합니다. 미래 날짜와 실제 checkout 전 planned target은 attempt 0이며,
checkout obligation이 materialized/current가 되고 reservation actual checkout까지 확인된 뒤에만 같은
target으로 활성화합니다. 같은 객실의 이전 active workflow가 있으면 assignment를 유지한 채
`PREVIOUS_ROOM_WORKFLOW_ACTIVE`로 보류합니다.

실행 창이 끝난 unassigned 또는 notified attempt-0 target은 ID와 original service date를 유지하고
effective service date를 하루 이동하며 carryover/version/schedule revision을 한 번만 증가시킵니다.
notified assignment는 이력으로 종료하고 actionable 알림을 resolve한 뒤 informational notification과
outbox만 append합니다. active attempt가 있는 업무는 이월하지 않습니다. activation/rollover 감사에는
승인된 ID·revision·날짜·count만 노출하며 request hash와 raw state는 developer projection에서 제외합니다.

이월 write 전 다음 schedule을 계산하고 source-domain을 검증합니다. 연박은 exact
`stayover_request + stayover`이며 같은 객실의 active/actual check-in/미퇴실 예약에
다음 접근·마감 창이 포함되고 접근 KST 날짜가 다음 service date와 같아야 합니다.
추가 청소는 activation과 동일한 active reservation overlap 검사를 다음 창에 적용합니다.
실패하면 stable blocked reason만 반환하고 assignment/notification/outbox/target/version/revision/audit는
변경하지 않습니다. 자동 취소·종류 변환도 없습니다. reservation-command lock 아래 검증하므로 예약 전이와 직렬화됩니다.

## 미래 checkout 계획과 실행 경계 — #1/#4/#26/#28

`checkout_cleaning_obligations.planned_cleaning_target_id`는 예약 생성 시점의 배정 identity이고,
`current_cleaning_target_id`는 실제 checkout 이후 운영 pointer입니다. private 의무도 계획 target으로
오늘/내일 배정·통보할 수 있지만 점유/입실 준비 projection은 바꾸지 않습니다. 예정/수동 checkout은
같은 target을 materialized/current로 승격하고, 수동 조기 퇴실의 일정 변경은 새 schedule/assignment
revision 및 변경 notification/outbox로 보존합니다. #28은 materialization·actual checkout·접근 시각을
다시 확인한 뒤에만 이 current revision을 scheduled attempt로 활성화합니다.

예약 변경·취소와 draft/commit은 동일 reservation-command transaction lock을 먼저 취득합니다.
미통보 draft는 일정 변경 후 stale이며 재저장이 필요합니다. notified 일정은 explicit replan 없이
변경하지 않고 취소 시 current assignment 종료와 회수 통보를 함께 기록합니다. checkout attempt/PIN
테이블의 실행 guard는 실제 checkout/current pointer/access 시각을 재검증합니다.

append-only `20260904144209_planned_checkout_targets.sql`은 기존 target identity를 재사용하며
private 기존 의무만 계획 target으로 backfill합니다. 새 target에는 해당 객실 타입의 published
checkout template이 필수이며 누락 시 migration/예약 저장을 fail-closed합니다. 운영 템플릿을
임의 seed하지 않습니다. 생성 시 fee/template/room snapshot은 이후 예약 일정 수정에도 보존합니다.

## RLS 원칙

### #29 Assignment Preview: snapshot과 순수 계산 분리

`get_assignment_preview_snapshot`은 `STABLE SECURITY DEFINER` 조회 RPC다. exact active business
admin을 DB에서 재검증하고 고정 search_path/EXECUTE 최소 권한 아래 한 statement snapshot의
정책·가능일·target·기존 배정·attempt·원 domain schedule을 반환한다. 이 RPC는 업무 DML,
advisory write lock, audit, command receipt, outbox를 만들지 않는다.

Edge의 platform-neutral `assignment-preview-core`는 snapshot만 입력으로 받는 bounded 순수
계산 모듈이다. DB가 source lifecycle 유효성을 판정하고 optimizer가 고정 부하·capacity·fee·route를
계산한다. 계획만 반환하며 저장은 기존 #25/#26 CAS 명령으로 분리한다. Fastify preview route는
이번 범위가 아니므로 Edge source와 Fastify rollback parity를 같다고 표시하지 않는다.

`assignment_duration_policy_versions`는 네 타입의 양수 minute 값과 version/상태/확정자를
보존한다. 확정 정책은 최대 한 건이며 새 관리자 확정 command는 전역 policy lock과 expectedVersion
CAS, actor/command/key + request hash receipt를 사용해 기존 confirmed를 retired로 전환하고
새 version 및 `assignment.duration_policy_confirmed` 감사만 append한다. 기존 확정 값 변경·삭제,
직접 Data API DML은 금지된다. 정책 확정은 preview 자체와 별도 명령이다. confirmed seed나
template/default 시간 fallback은 없고 production 운영값 설정은 이번 PR에서 하지 않는다.

상세 입력·출력·계산 한계는 [배정 Preview API 계약](./ASSIGNMENT_PREVIEW.md)을 따른다.

- `public`의 모든 테이블은 RLS를 활성화합니다.
- `anon`에는 테이블 권한을 주지 않습니다.
- 메이드는 본인 담당·수행·제출·수익·지급·알림만 읽습니다.
- developer는 계정 수명주기만 관리하고 업무 권한을 상속하지 않습니다. active admin은 운영 테이블을 관리하지만 객실 PIN 원문은 전용 조회 함수로만 받습니다.
- view는 `security_invoker = true`를 사용합니다.
- 일반 Data API RLS의 profile/role 보조 함수는 `active` 계정만 식별합니다. `deactivation_pending`과 `upload_only`는 일반 역할이 아니라 만료 가능하고 업무 revision에 묶인 서버 전용 제한 capability로만 처리합니다.
- 알림 수신자가 직접 바꿀 수 있는 필드는 `read_at`뿐입니다. `resolved_at`은 관련 업무 command만 service-role transaction에서 변경합니다.
- 내부 권한 함수는 `private` 스키마, 고정 `search_path`, 최소 반환값, 명시적 EXECUTE 권한을 사용합니다.
- 사진 파일은 Drive에서 공개 공유하지 않습니다. API가 사용자 역할과 제출 소유권을 검사한 뒤 업로드·열람·삭제를 대행합니다.
- Supabase에는 Drive 파일 ID·해시·크기·삭제예정일만 저장하고, 사진 레코드 쓰기는 서버 역할에만 허용합니다.
- 인증 사용자의 직접 DML은 본인 알림의 `read_at`으로 제한합니다. `resolved_at`과 업무 상태 변경은 서버 명령/RPC만 사용합니다.
- 상세 역할 매트릭스와 상태 변경 규칙은 [Auth·RLS 계약](./AUTH_RLS_CONTRACT.md)을 따릅니다.

## API 단계

현재:

- `GET /health`
- `GET /openapi.json`, `GET /docs` (OpenAPI 3.1·pinned Swagger UI)
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/password`
- `GET·POST /v1/accounts`
- `PATCH /v1/accounts/:profileId/role`
- `PATCH /v1/accounts/:profileId/status`
- `POST /v1/accounts/:profileId/unlock`
- `POST /v1/accounts/:profileId/password-reset`
- `GET /v1/rooms`, `GET /v1/rooms/:roomId` (관리자 전용 운영 projection)
- `GET /v1/developer/overview`, `/runtime-status`, `/database-status`, `/scheduler-status`
- `GET /v1/developer/audit-events`, `GET /v1/developer/activity-events`, `POST /v1/developer/diagnostics` (singleton developer 전용 bounded projection)
- 객실 기준정보 변경, 운영 차단·해제, 촛불 수량 event, 이슈 등록·해결, PIN 동기화 결과 기록
- `GET·POST /v1/reservations`, `GET /v1/reservations/:reservationId`
- `POST /v1/reservations/cleaning-requests`, `POST /v1/reservations/cleaning-requests/:targetId/cancel`
- 예약 일정 변경·취소·수동 체크아웃과 예약 시각 기반 전이 처리
- `GET /v1/availability`, `POST /v1/availability/submissions`
- `GET·POST /v1/availability/change-requests`, 관리자 승인·반려
- `GET /v1/availability/candidates` 활성·가능 메이드 후보 조회

다음 구현:

- 오늘/내일 청소 대상, 배정·순서 통보
- 300KiB 사진 업로드, 인증된 사진 스트리밍, 현장 완료, 전체 제출
- 검수 승인/반려, 폭탄방 판정, 재청소
- 메이드별 주급과 지급 상태
- 역할별 알림함과 푸시 구독

Edge `/v1/rooms*`와 `/v1/availability/*`는 DB의 snake_case column을 그대로 노출하지 않고 Fastify와 같은 camelCase projection으로 변환한다. 객실 상세·기준정보·운영 차단·촛불·이슈·PIN 동기화 adapter는 `get_room_operational_projection`, `change_room_master_data`, `mutate_room_operation`만 재사용하며 raw table DML을 하지 않는다. actor는 exact active business admin이고 비밀번호 변경과 active session까지 확인한다. 생성 entity UUID는 request hash에서 제외해 같은 payload 재시도가 동일 logical event로 수렴하고, PIN 원문·door code·credential·provider secret은 입력 단계에서 거부한다. 가능일 조회는 Bearer token으로 만든 요청별 Supabase client가 기존 RLS를 통과하고, 제출·변경·결정은 service-role RPC가 actor profile의 최신 exact role/status를 다시 검증한다. 프론트는 OpenAPI의 재사용 schema와 안정적인 `operationId`로 타입을 생성하고, error message 문자열 대신 `ErrorCode` union으로 분기한다.

Edge `/v1/reservations*`도 기존 예약·청소요청 RPC 9개만 재사용하며 raw DML을 허용하지 않는다. actor는 exact active business admin이고 최초 비밀번호 변경과 active session까지 매 요청 확인한다. 목록·mutation projection에는 고객명과 암호문이 없고, 단건 상세에서 고객명을 실제 복호화할 때만 server-generated request ID를 가진 `sensitive.read` activity를 append한다. activity append가 실패하면 상세 응답도 fail-closed한다. Edge Web Crypto AES-256-GCM envelope와 HMAC request fingerprint는 Fastify 계약과 호환하며, scheduler와 관리자 수동 전이의 인증·멱등성 namespace는 분리한다.

developer API의 DB 상태는 적용 시점에 따라 달라지는 원격 migration version이 아니라 안정적인 Git migration name으로 source head를 찾은 뒤 실제 원격 순서를 `ahead | equal | behind | unknown`으로 정규화한다. public base table RLS 누락 수와 allowlist RPC 상태만 제공하며, critical RPC는 exact signature와 `service_role` 전용 EXECUTE 경계를 모두 만족해야 정상이다. scheduler 상태는 Cron SQL·Vault·`pg_net` 응답 본문 대신 정규화된 Cron metadata와 `private.scheduler_invocation_heartbeats` projection을 사용한다. domain 감사와 활동/보안 조회는 각각 최대 31일·100건 cursor pagination이고 raw state·request body·자격증명·PII를 노출하지 않는다. diagnostics는 임의 URL·SQL·RPC 이름을 받지 않으며 durable 10회/분 제한을 적용한다.

## 원격 환경 현황

- Free 조직: `yeosucastletheart@gmail.com's Org`
- 운영: 서울 `room-management-system-prod` (`aodikrxcczbogjpsjwjt`)
- 복구검증: 뭄바이 기존 프로젝트 (`matalcofimnhuzslfhdd`), 사용자 트래픽 금지
- 두 프로젝트 생성 비용은 월 `$0`로 확인

아직 필요한 설정:

- Data API 노출 스키마 확인
- publishable/secret key를 로컬·배포 환경에 각각 저장
- 단일 developer bootstrap 후 별도 업무 관리자 생성·로그인·RLS 통합 테스트
- Google Cloud Drive API OAuth 앱, 전용 운영 계정, 비공개 루트 폴더와 refresh token 설정

예약 고객명은 API 서버에서 AES-256-GCM으로 암호화해 `reservations.guest_name_encrypted`에만 저장합니다. 현재 키와 버전은 `RESERVATION_PII_KEY_BASE64`, `RESERVATION_PII_KEY_VERSION`, 이전 복호화 키는 secret인 `RESERVATION_PII_KEYRING_JSON`으로 관리합니다. 목록에는 이름을 포함하지 않고 관리자 단건 상세에서만 복호화하며, 체크아웃 또는 투숙 전 취소 후 180일이 지나면 예약 전이 worker가 암호문을 제거합니다. 멱등성 hash에는 평문 대신 서버 키 HMAC fingerprint만 사용하고 응답·감사 event에는 암호문이나 원문을 복제하지 않습니다. 객실 PIN도 원문 대신 동기화 상태와 PIN version만 일반 업무 원장에 기록합니다.

`RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`는 production에서 활성 관리자 profile ID로 반드시 설정합니다. 현재 Fastify 기준선은 시작 시 첫 실행으로 actor를 검증하지만, Supabase-only PoC는 Cron이 1분마다 별도 secret으로 scheduler Function을 호출하고 DB command가 actor의 최신 역할·상태를 매 실행 재검증한다. 어느 runtime이든 퇴실을 먼저 처리하므로 반개구간 경계의 다음 입실이 같은 batch에서 진행되고, 중단 기간 전체가 지난 미입실 예약도 가짜 check-in 없이 예정 checkout으로 종결된다. 자세한 PoC/rollback 계약은 [Edge runtime PoC](./EDGE_RUNTIME_POC.md)를 따른다.

다음 예약이 바뀌면 앞 예약의 준비 마감은 종결되지 않은 obligation만 다시 계산합니다. 아직 미배정인 materialized target은 CAS version과 schedule revision을 함께 올리고, 이미 배정·통보된 target은 암묵적으로 덮어쓰지 않고 `CLEANING_DUE_REPLAN_REQUIRED`로 거부해 명시적 재계획을 요구합니다.

고객명 암호화 key version과 idempotency HMAC pepper는 분리합니다. 암호화 키를 회전해도 안정적인 `RESERVATION_GUEST_NAME_PEPPER`는 계획된 별도 migration 전까지 유지하므로 기존 idempotency key 재시도가 다른 요청으로 오인되지 않습니다.

2026-08-28에 운영·복구검증 프로젝트에 P0·계정 수명주기·도메인 무결성 migration을 적용했다. 두 프로젝트에서 구조 검사 22건과 rollback DML 검사 17건이 통과했고 Security Advisor 경고는 0건이다. Performance Advisor에는 아직 업무 데이터가 없어 예상되는 unused-index 정보만 남아 있다. Issue #1 객실·예약 migration은 아직 두 원격 프로젝트에 적용하지 않았다.

## 백업·복구

- 마이그레이션 SQL은 GitHub의 `supabase/migrations/`를 정본으로 사용한다.
- Free Plan의 두 번째 프로젝트는 최신 논리 dump를 실제로 복원하는 warm recovery copy로 사용한다.
- 매일 roles·schema·data dump를 만들고 recovery 프로젝트에 복원한 뒤 핵심 행 수·RLS·관리자·객실 seed를 검사한다.
- DB dump는 Google Drive 사진 파일을 포함하지 않으므로 사진은 업로드 후 7일 자동삭제 정책으로 별도 운영한다.
- 전체 주기와 복원 명령은 [백업·복구 운영안](./BACKUP_AND_RECOVERY.md)에 정의한다.
