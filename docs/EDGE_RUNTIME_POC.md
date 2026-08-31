# Supabase-only production runtime PoC

## 목표와 상태

월 비용 `$0`을 우선해 Fastify production process를 Supabase Edge Functions와 Cron으로 대체할 수 있는지 검증한다. 이 문서와 `supabase/functions/` 코드는 Issue #36의 PoC이며, 운영 smoke와 독립 리뷰가 끝나기 전에는 Fastify를 제거하거나 production runtime 전환이 완료됐다고 간주하지 않는다.

PoC source의 `dev` 병합 조건은 최신 head 독립 리뷰 P0/P1 0과 required CI PASS다. 운영 smoke는 `dev` 병합 선행조건이 아니라 `release → main` 뒤 운영 migration과 계정·secret 준비를 마친 다음 수행하는 runtime 채택 조건이다. 따라서 source가 병합돼도 Issue #36은 운영 smoke가 완료될 때까지 닫지 않으며 기존 Fastify를 rollback 기준선으로 유지한다.

현재 production은 source·migration 17건·Edge API/OpenAPI 배포와 gateway/JWT/CORS 1차 smoke까지 완료됐다. Supabase 기본 도메인은 HTML 응답을 `text/plain`으로 바꾸므로 production `/docs` route 자체는 존재하지만 인터넷 Swagger UI로 렌더링되지 않는다. 사람용 운영 문서는 GitHub Pages 읽기 전용 Swagger 포털에서 제공한다.

운영 `api`의 HTTP surface는 아직 auth/accounts/객실 목록 중심의 부분 이식 상태다. Fastify와 운영 DB에 이미 존재하는 주간 가능일·예약·객실 상세/mutation은 각각 #51·#52·#53에서 Edge parity를 완료한다. business admin과 scheduler/Cron은 #43과 #44 Phase A 뒤 활성화하므로 scheduler 503 fail-closed는 현재 정상이다. `v0.2.0` tag/release는 parity와 operational activation smoke가 끝날 때까지 발행하지 않는다.

```text
Frontend
  └─ Edge Function api
       ├─ Supabase Auth user 검증
       ├─ 최신 profile/session 재검증
       └─ service-role command/RPC

Supabase Cron (pg_cron)
  └─ pg_net 비동기 HTTP
       └─ Edge Function reservation-scheduler
            └─ process_due_reservation_transitions RPC
```

## Free Plan 경계

- Free 프로젝트는 2개이며 운영과 recovery 역할을 그대로 유지한다.
- Edge Functions는 Free에서 월 500,000 invocation을 포함한다.
- 1분 Cron은 30일 기준 약 43,200회로 한도의 약 8.64%다.
- Free Function은 memory 256MB, wall clock 150초, CPU 2초/request 제한을 따른다.
- Free 프로젝트는 7일 저활동 시 pause될 수 있다. 실제 사용자의 매일 DB 요청은 pause 가능성을 낮추지만 무중단을 보장하지 않는다.
- Free에는 SLA와 자동 DB backup이 없다. Git migration과 두 번째 recovery 프로젝트의 논리 복구 절차를 계속 사용한다.

## Edge endpoint

| Function | Method/path | 인증 | 목적 |
|---|---|---|---|
| `api` | `GET /api/health` | 없음 | Edge runtime health |
| `api` | `GET /api/openapi.json` | 없음 | OpenAPI 3.1 계약 |
| `api` | `GET /api/docs` | 없음 | local/self-hosted pinned Swagger UI source. Supabase 기본 hosted domain에서는 HTML 렌더링 불가 |
| `api` | `POST /api/v1/auth/login` | 없음 | 이름형 ID 로그인 |
| `api` | `GET /api/v1/auth/me` | 사용자 bearer JWT | Auth/profile/session 계약 |
| `api` | `POST /api/v1/auth/password` | 사용자 bearer JWT | 개인 비밀번호 변경 |
| `api` | `GET·POST /api/v1/accounts` | developer 또는 active admin | 계정 조회·생성 |
| `api` | `PATCH /api/v1/accounts/:profileId/role` | developer 또는 active admin | 관리자·메이드 역할 변경 |
| `api` | `PATCH /api/v1/accounts/:profileId/status` | developer 또는 active admin | 계정 상태 전이 |
| `api` | `POST /api/v1/accounts/:profileId/unlock` | developer 또는 active admin | 로그인 잠금 해제 |
| `api` | `POST /api/v1/accounts/:profileId/password-reset` | developer 또는 active admin | 임시 비밀번호 초기화 |
| `api` | `GET /api/v1/developer/overview` | active developer | 운영 dashboard 집계 |
| `api` | `GET /api/v1/developer/runtime-status` | active developer | environment·설정 여부 projection |
| `api` | `GET /api/v1/developer/database-status` | active developer | migration·RLS·핵심 RPC 검사 |
| `api` | `GET /api/v1/developer/scheduler-status` | active developer | Cron·actor·heartbeat 상태 |
| `api` | `GET /api/v1/developer/audit-events` | active developer | bounded domain 감사 projection |
| `api` | `GET /api/v1/developer/activity-events` | active developer | bounded 인증·권한·민감접근 projection |
| `api` | `POST /api/v1/developer/diagnostics` | active developer | allowlist read-only 진단 |
| `api` | `GET /api/v1/rooms` | active admin + password changed | 기존 객실 projection RPC |
| `reservation-scheduler` | `POST /reservation-scheduler` | `x-scheduler-secret` | 예약 전이/PII 보존 command |

`verify_jwt=false`는 공개 허용을 뜻하지 않는다. 하나의 API Function 안에서 health와 인증 endpoint를 함께 라우팅하기 위해 gateway 검사를 끄고, 보호 경로에서 `auth.getUser`와 최신 DB profile/session을 매 요청 재검증한다. scheduler Function은 32자 이상의 별도 secret을 HMAC 방식으로 비교한 뒤에만 service-role RPC를 호출한다.

단일 `developer`도 `/v1/auth/me`에서 자신의 실제 역할로 인증되지만 객실·예약 같은 업무 API에서는 `admin`으로 간주하지 않는다. `/v1/rooms`와 예약 scheduler actor는 최신 active profile의 역할이 정확히 `admin`일 때만 허용하며, developer를 scheduler actor로 지정하면 DB command가 `ADMIN_REQUIRED`로 거부한다.

로그인 endpoint는 Edge instance 메모리를 제한 상태로 사용하지 않는다. hosted Supabase에서는 platform이 붙이는 `cf-connecting-ip`만 client 정본으로 사용하고 이 값이 없으면 fail-closed한다. `x-real-ip`과 마지막 forwarded hop fallback은 reverse proxy가 해당 헤더를 덮어쓰도록 구성한 local/self-hosted 환경에서만 허용한다. production smoke에서는 caller가 보낸 spoof header보다 platform 값이 우선하는지 확인해야 한다. 원문 client address와 로그인 ID는 응답·DB·로그에 저장하지 않고 `ACCOUNT_PHONE_PEPPER`로 domain-separated HMAC-SHA256 key만 만든다. 하나의 원자 DB command가 **client별 30회/분 → 로그인 ID별 10회/분 → emergency global 600회/분** 순서로 소비한다. 공격 client가 ID를 바꿔도 자기 bucket에서 차단되어 다른 client의 정상 `admin` 로그인을 막지 못한다. 첫 차단 뒤 saturated bucket은 더 갱신하지 않고 hot path의 만료 row 정리도 호출당 최대 64건으로 제한한다. 제한 초과는 `429`와 `Retry-After`, 신뢰할 client metadata가 없으면 `503 LOGIN_CLIENT_ID_UNAVAILABLE`을 반환한다. 이 검사는 alias 조회보다 먼저 수행하며, 계정이 존재하는 경우에는 기존 5회 실패/15분 계정 잠금도 별도로 적용한다. 알 수 없는 ID와 잘못된 비밀번호는 모두 `INVALID_CREDENTIALS`로 응답한다.

로컬 `/api/docs`는 `/api/openapi.json`을 읽는 한글 Swagger UI다. Swagger asset version과 SRI hash를 소스에 고정하고 CSP를 적용하며 bearer token은 브라우저 저장소에 유지하지 않는다. Supabase Free 기본 domain에서는 HTML이 `text/plain`으로 강제되므로 운영 사람용 문서는 `https://wrongstory.github.io/room-management-system-backend/`의 정적 Swagger 포털이 담당한다. Pages workflow는 배포된 production OpenAPI를 최대 2MiB·HTTPS·project domain·title/version/필수 path 기준으로 검증한 뒤 same-origin snapshot으로 포함한다. 공개 portal은 `Try it out`과 Authorization UI를 비활성화한다. 프론트와 프론트 Codex는 [API 연동 가이드](./FRONTEND_API_INTEGRATION.md)에 따라 이 snapshot에서 타입을 생성하고 endpoint·role·error code를 와이어프레임에서 추측하지 않는다.

Scheduler 시간값은 두 역할로 분리한다. 요청의 `scheduledAt`은 해당 Cron 호출을 식별하는 minute bucket과 idempotency key에만 사용하며 업무 전이의 기준 시각으로 사용하지 않는다. 실제 `p_as_of`는 Function이 RPC를 실행하는 현재 시각이다. 따라서 같은 `scheduledAt` 재시도는 같은 호출로 처리하면서도 pause나 전달 지연 뒤에는 실제 실행 시각까지 누락된 예약 전이를 catch-up한다.

각 인증된 scheduler 실행은 업무 RPC 완료 뒤 `private.scheduler_invocation_heartbeats`에 7일 app-owned 상태를 기록한다. 같은 invocation key 재시도는 attempt count와 마지막 결과만 갱신하며 secret·Authorization·HTTP body·원문 DB 오류는 저장하지 않는다. developer scheduler projection은 Cron SQL이나 `net._http_response` raw row를 공개하지 않고 활성 여부·cadence·최근 run 시각, exact-admin actor 유효성, 안전한 heartbeat 필드만 반환한다.

developer 운영 API는 exact `developer` 역할만 허용한다. DB·Cron·감사 원본은 app-owned `SECURITY DEFINER` projection 뒤에 두며 service-role도 private heartbeat/limiter/activity table을 직접 조회하지 않는다. 성공한 업무 mutation은 immutable `public.audit_events`에 남기고 account·availability·reservation·room·scheduler 승인 event만 안전한 summary로 공개한다. 로그인·권한 거부·민감정보 조회는 별도 private activity 원장에 기록하며, 알 수 없는 로그인 실패는 원문 ID 없이 분 단위 bounded aggregate로만 집계한다. 두 projection 모두 최대 31일·100건 cursor pagination을 적용하고 raw before/after state를 반환하지 않는다. diagnostics는 임의 URL·SQL·RPC 입력 없이 10회/분 durable 제한을 사용한다. 모든 developer 응답은 `Cache-Control: no-store`다.

## 로컬 검증

```bash
npm run db:start
copy supabase/functions/.env.example supabase/functions/.env.local
npm exec supabase -- functions serve api reservation-scheduler --env-file supabase/functions/.env.local
npm run edge:check
```

로컬 Function이 실행 중이면 `http://127.0.0.1:54321/functions/v1/api/docs`에서 상호작용용 Swagger UI를 열 수 있다. 운영 문서 배포는 source가 release를 통해 `main`에 승격된 뒤 GitHub Pages workflow로 수행한다. Edge Function 재배포 후에는 workflow를 수동 실행하고 portal manifest의 version·path count·SHA-256을 확인한다.

Swagger 상단의 **OpenAPI JSON 내려받기** 또는 `/api/openapi.json`을 사용하면 프론트 저장소에서 codegen 가능한 계약을 받을 수 있다. 현재 Edge 객실 응답은 Fastify와 동일한 camelCase `RoomProjection`을 사용하며 DB RPC의 snake_case column을 브라우저에 노출하지 않는다.

`.env.local`은 Git에 넣지 않는다. 로컬 active admin UUID와 무작위 scheduler secret만 넣고, 실제 운영 비밀값을 복사하지 않는다.

## 운영 secret과 Cron

Function Secret:

- `ACCOUNT_PHONE_PEPPER`
- `RESERVATION_PII_KEY_BASE64`
- `RESERVATION_PII_KEY_VERSION`
- `RESERVATION_PII_KEYRING_JSON`
- `RESERVATION_GUEST_NAME_PEPPER`
- `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`
- `SCHEDULER_INVOKE_SECRET`
- `CORS_ORIGINS`
- `RUNTIME_ENVIRONMENT` — `production | recovery | local`; 운영 콘솔의 연결 대상 badge

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 Edge runtime이 자동 제공한다. custom secret은 `SUPABASE_` prefix를 사용할 수 없으며 service-role 값은 응답·로그·Vault·Git에 복제하지 않는다.

운영 Function 배포와 scheduler secret 설정을 완료한 뒤에만 SQL Editor에서 환경별 값을 Vault에 저장하고 Cron을 만든다. 아래 placeholder를 그대로 실행하지 않는다.

```sql
select vault.create_secret('https://PROJECT_REF.supabase.co', 'edge_project_url');
select vault.create_secret('RANDOM_32_PLUS_CHARACTER_SECRET', 'scheduler_invoke_secret');

select cron.schedule(
  'reservation-transition-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_project_url')
      || '/functions/v1/reservation-scheduler',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-scheduler-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_invoke_secret')
    ),
    body := jsonb_build_object('scheduledAt', date_trunc('minute', now()))
  );
  $$
);
```

Cron은 외부 HTTP 응답을 DB transaction 안에서 기다리지 않는 `pg_net` 비동기 호출만 사용한다. 운영 확인에는 `cron.job_run_details`, `net._http_response`, Edge Function log와 command audit replay 결과를 함께 본다.

## 전환·rollback 기준

PoC 통과 뒤 별도 Issue에서 나머지 Fastify route를 Edge adapter로 옮긴다. 같은 endpoint 계약이 Edge에서 검증되기 전까지 Fastify 코드는 삭제하지 않는다. 운영 Edge 배포에 문제가 생기면 Cron을 먼저 unschedule하고 해당 Function의 이전 version으로 되돌리며, DB migration이나 원장은 되돌리지 않는다.
