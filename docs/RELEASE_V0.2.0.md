# v0.2.0 릴리즈 후보와 운영 적용 정본

## 1. 기준과 현재 상태

- release branch: `release/v0.2.0`
- release source: `dev@2adb7a7de2474883d892232395295dcf643b20a4`
- 비교 기준: `main@2bc6c634ab95c2cdc758df39bb11eb310715575e`
- 상태 추적: GitHub Issue #24, Edge runtime Issue #36
- 현재 production DB: migration 17건 적용
- 현재 production Edge: `api` version 2, `reservation-scheduler` version 2
- 현재 production OpenAPI: 13 operations
- release source OpenAPI: 39 paths / 43 operations

이 후보는 최신 `dev` 전체를 운영 승인 대상으로 고정한다. `main`에 source가 들어가는 것과
production 활성화 완료는 서로 다른 상태다. release PR 생성·검증만으로 production DB,
Edge Functions 또는 GitHub Pages가 바뀌지 않는다.

현재 production에는 developer bootstrap과 기존 Edge 배포까지 완료돼 있다. business admin은
아직 생성하지 않았고 scheduler actor/invoke secret, Vault, `pg_cron`, `pg_net`은 미설정이다.
따라서 scheduler의 503 fail-closed는 현재 의도된 상태다.

## 2. 릴리즈 범위

포함되는 source:

- #42 Auth/Account Supabase Edge API와 한글 OpenAPI
- #43 developer operations Edge API와 scheduler heartbeat
- #51 Availability Edge parity 6 operations
- #52 Reservation Edge parity 9 operations
- #53 Room detail/mutation Edge parity 8 operations
- #58 Actor Activity/Audit private ledger와 developer projection
- #44 Python backend console Phase A source, tests, packaging workflow
- #49/#50 GitHub Pages 읽기 전용 Swagger portal source와 workflow
- 관련 Fastify parity, 문서, DB/RLS/동시성 회귀 테스트

production 활성화와 분리되는 항목:

- Python source의 `main` 포함은 허용하지만 Windows artifact와 hosted smoke는 운영 gate다.
- Pages source의 `main` 포함은 허용하지만 Pages workflow는 `workflow_dispatch` 전용이다.
  production Edge 배포·hosted smoke와 39 paths / 43 operations 검증 후 운영자가 명시적으로 실행한다.
- #43/#58 migration과 최신 Edge source는 `main` 승인 후 production 적용 대상이다.
- #25 이후 배정·현장수행·사진·검수·정산·알림 기능은 이 릴리즈에서 제외한다.
- #44 Phase B direct read-only DB와 Phase C maintenance action catalog는 제외한다.

## 3. migration history와 pending inventory

초기 migration은 원격 프로젝트에 수동 적용돼 Git filename timestamp와 remote history version이
다를 수 있다. 원격 적용 여부는 timestamp 단순 비교가 아니라 **stable migration name**과 실제
schema를 함께 대조한다. 기존 17건은 적용 완료 기록이며 재적용하지 않는다.

이번 `main...release/v0.2.0`의 pending migration은 아래 2건뿐이다.

| 순서 | Git migration filename | stable migration name | 목적 | production 적용 |
|---|---|---|---|---|
| 1 | `20260830123241_developer_operations_projections.sql` | `developer_operations_projections` | developer-only 운영 projection, migration/RPC 권한 상태, scheduler heartbeat와 bounded diagnostics 원장 | 필요 |
| 2 | `20260831124140_actor_activity_audit_contract.sql` | `actor_activity_audit_contract` | domain audit projection 확장, 인증·권한거부·민감조회 activity private ledger와 bounded aggregate | 필요 |

`actor_activity_audit_contract`는 developer audit/activity 조회 계약을 확장하므로
`developer_operations_projections` 다음에 적용한다. 적용 직전에 production history를 다시 읽어
같은 stable name이 이미 있으면 중단한다.

이 릴리즈에서는 다음 작업을 금지한다.

- `supabase db push`
- migration history repair/rewrite
- 기존 migration 수정 또는 재적용
- down migration이나 production schema rewind

## 4. Edge 재배포 inventory

| Function | main 대비 source 변경 | production 재배포 | 이유 |
|---|---|---|---|
| `api` | 있음 | 필요 | developer/activity, Availability, Reservation, Room route와 43-operation OpenAPI 반영 |
| `reservation-scheduler` | 있음 | 필요 | #43 scheduler heartbeat 기록 source 반영 |

두 Function 모두 승인된 `main`의 exact source에서 배포한다. 현재 production readback 13 operations와
release source 43 operations를 혼동하지 않으며, 재배포와 hosted smoke 전에는 신규 operation을
production 사용 가능으로 표시하지 않는다.

## 5. runtime configuration inventory

값은 Git, PR, 로그, 문서 또는 채팅에 기록하지 않는다. 아래는 이름과 요구 조건만 기록한다.

Supabase Edge가 제공하며 두 Function에서 사용하는 값:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

production `api`에 필요한 설정:

- `CORS_ORIGINS`
- `ACCOUNT_PHONE_PEPPER`
- `RESERVATION_PII_KEY_BASE64`
- `RESERVATION_PII_KEY_VERSION`
- `RESERVATION_PII_KEYRING_JSON`
- `RESERVATION_GUEST_NAME_PEPPER`
- `RUNTIME_ENVIRONMENT`

production scheduler 활성화에 필요한 설정:

- `SCHEDULER_INVOKE_SECRET`
- `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`

`RUNTIME_ENVIRONMENT`는 production에서 `production`으로 고정하고 runtime-status의 project ref와
승인된 운영 대상이 일치하는지 확인한다. scheduler actor는 active business admin이어야 하며
developer를 지정하지 않는다.

Fastify rollback 기준선에는 별도로 `SUPABASE_PROJECT_REF`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `RESERVATION_SCHEDULER_INTERVAL_SECONDS`와 일반 runtime 설정
`APP_ENV`, `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`이 필요하다. 이 값들도 source나 운영 기록에
원문을 남기지 않는다.

## 6. release source 검증 gate

release PR의 exact head에서 다음을 모두 통과해야 한다.

- `npm run edge:check`
- `npm run ci:quality` (`secrets:check`, lint, typecheck, application tests, build 포함)
- `npm run db:verify`
- `npm run db:test`
- `npm run db:test:concurrency`
- local DB lint / Security Advisor 검토
- Python `ruff`, `ruff format --check`, `mypy`, `pytest`, package/build source check
- OpenAPI 3.1 구조 검증과 39 paths / 43 operations 확인
- GitHub required checks `application`, `migration`
- 독립 release review P0/P1 0

검증 실패를 skip하거나 기준을 완화하지 않는다. Free Plan의 leaked-password protection 경고는
알려진 제한으로 기록하되 source/RLS/RPC/secret 차단사항과 혼동하지 않는다.

## 7. `main` 병합 후 production 적용 순서

아래 순서는 release PR이 `main`에 병합된 후에만 시작한다.

1. production DB, Edge, secret-name, migration history 상태를 다시 read한다.
2. pending migration 2건을 stable name과 선후관계대로 정확히 1회 append-only 적용한다.
3. migration, RLS, privileged RPC signature/grant와 private raw table 차단을 검증한다.
4. 승인된 `main` exact source에서 `api`를 배포한다.
5. 같은 `main` exact source에서 `reservation-scheduler`를 배포한다.
6. public health와 배포 OpenAPI 43-operation HTTP smoke를 수행한다.
7. developer hosted login과 developer operations/redaction smoke를 수행한다.
8. Python 운영도구로 business admin을 생성하고 최초 비밀번호를 변경한다.
9. business admin으로 Room/Reservation/Availability positive smoke를 수행한다.
10. developer/maid/inactive/revoked 계정의 권한 negative smoke를 수행한다.
11. PII 암복호화, `sensitive.read`, domain audit와 activity projection을 smoke한다.
12. active business admin을 scheduler actor로 지정하고 invoke secret을 구성한다.
13. scheduler 수동 호출과 동일 `scheduledAt` 재호출의 멱등성을 확인한다.
14. Vault, `pg_cron`, `pg_net`을 활성화한다.
15. 실제 Cron 실행, HTTP response, Edge log, heartbeat, audit/idempotency를 관찰한다.
16. production OpenAPI가 39 paths / 43 operations인지 다시 확인한 뒤 운영자가
    GitHub Pages `workflow_dispatch`를 수동 실행해 Swagger snapshot을 배포한다.
17. `API_STATUS_MATRIX.md`의 Production Edge/현재 사용 상태를 실제 smoke 결과로 갱신한다.
18. #49/#51/#52/#53/#58/#36 등 Issue 완료 여부를 각 완료조건으로 판단한다.
19. 모든 운영 gate 통과 후에만 annotated `v0.2.0` tag와 GitHub Release를 발행한다.

## 8. 중단·복구·forward-fix 기준

- migration 전에 문제가 발견되면 production을 변경하지 않고 release PR을 수정한다.
- migration 적용 중 실패하면 뒤 migration과 Edge 배포를 중단한다. 이미 적용된 migration을
  내리거나 history를 조작하지 않고 append-only forward-fix migration을 새 리뷰 대상으로 만든다.
- DB 적용 후 Edge 문제가 나면 Cron을 활성화하지 않거나 즉시 중지하고 기존 Function/Fastify
  rollback 기준선으로 트래픽을 전환한다. DB 원장과 migration은 rewind하지 않는다.
- Edge smoke가 실패하면 business admin/scheduler/Pages 활성화를 진행하지 않는다.
- Pages 실패는 API runtime을 rollback하지 않고 Pages만 이전 artifact 또는 비활성 상태로 유지한다.
- 비밀값 노출이 의심되면 즉시 해당 secret을 폐기·교체하고 노출 범위를 별도 보안 Issue로 기록한다.

Swagger UI는 운영 secret 입력·보관 수단이 아니다. smoke 중 token을 사용하더라도 브라우저 저장소,
캡처, 로그, Issue나 PR에 남기지 않는다.
