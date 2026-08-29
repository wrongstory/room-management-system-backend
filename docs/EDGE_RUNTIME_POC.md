# Supabase-only production runtime PoC

## 목표와 상태

월 비용 `$0`을 우선해 Fastify production process를 Supabase Edge Functions와 Cron으로 대체할 수 있는지 검증한다. 이 문서와 `supabase/functions/` 코드는 Issue #36의 PoC이며, 운영 smoke와 독립 리뷰가 끝나기 전에는 Fastify를 제거하거나 production runtime 전환이 완료됐다고 간주하지 않는다.

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

## PoC endpoint

| Function | Method/path | 인증 | 목적 |
|---|---|---|---|
| `api` | `GET /api/health` | 없음 | Edge runtime health |
| `api` | `GET /api/v1/auth/me` | 사용자 bearer JWT | Auth/profile/session 계약 |
| `api` | `GET /api/v1/rooms` | active admin + password changed | 기존 객실 projection RPC |
| `reservation-scheduler` | `POST /reservation-scheduler` | `x-scheduler-secret` | 예약 전이/PII 보존 command |

`verify_jwt=false`는 공개 허용을 뜻하지 않는다. 하나의 API Function 안에서 health와 인증 endpoint를 함께 라우팅하기 위해 gateway 검사를 끄고, 보호 경로에서 `auth.getUser`와 최신 DB profile/session을 매 요청 재검증한다. scheduler Function은 32자 이상의 별도 secret을 HMAC 방식으로 비교한 뒤에만 service-role RPC를 호출한다.

Scheduler 시간값은 두 역할로 분리한다. 요청의 `scheduledAt`은 해당 Cron 호출을 식별하는 minute bucket과 idempotency key에만 사용하며 업무 전이의 기준 시각으로 사용하지 않는다. 실제 `p_as_of`는 Function이 RPC를 실행하는 현재 시각이다. 따라서 같은 `scheduledAt` 재시도는 같은 호출로 처리하면서도 pause나 전달 지연 뒤에는 실제 실행 시각까지 누락된 예약 전이를 catch-up한다.

## 로컬 검증

```bash
npm run db:start
copy supabase/functions/.env.example supabase/functions/.env.local
npm exec supabase -- functions serve api reservation-scheduler --env-file supabase/functions/.env.local
npm run edge:check
```

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
