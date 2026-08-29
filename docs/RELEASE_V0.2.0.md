# v0.2.0 릴리즈 적용 기록

## 범위와 기준

- release candidate: `release/v0.2.0`
- 최초 기준 commit: `dev@4da80cb2ddcb5de2f5b3dd5bd41354b80a3f7ae5`
- 최신 통합 기준 commit: `dev@4a62c2e833914d5bdd9e063c8f43fb9644aeab8d`
- 운영 project: `aodikrxcczbogjpsjwjt`
- recovery project: `matalcofimnhuzslfhdd`
- 상태 추적: GitHub Issue #24

최신 release candidate에는 프런트 정본 갱신(#41), singleton developer 계층(#39), Supabase Edge runtime PoC(#37)가 모두 포함된다. `release/v0.2.0 → main` 병합은 **운영 배포 가능한 승인된 source 확정**만 뜻하며, 운영 migration·Edge 배포·runtime 채택·`v0.2.0` 발행 완료를 뜻하지 않는다.

이 문서는 운영 자격증명이나 SQL 결과 데이터를 저장하지 않는다. 실제 적용은 `main` 병합 뒤 Supabase MCP를 통해 수행하고, 각 단계의 성공 여부만 Issue #24에 기록한다.

## 기존 migration version mapping

초기 migration은 각 원격 프로젝트에 수동 적용돼 SQL 내용은 대응하지만 version이 Git과 다르다. 아래 mapping은 2026-08-29 `list_migrations`와 실제 스키마 검사를 함께 대조한 결과다.

| Git migration | 운영 history | recovery history |
|---|---|---|
| `20260825141441_initial_core_schema` | `20260825163223_initial_core_schema` | `20260826115124_20260825163223_initial_core_schema` |
| `20260825163315_harden_data_api_grants` | `20260825163431_harden_data_api_grants` | `20260826115128_20260825163431_harden_data_api_grants` |
| `20260826021457_account_lifecycle_contract` | `20260826022856_account_lifecycle_contract` | `20260826115131_20260826022856_account_lifecycle_contract` |
| `20260826023016_harden_account_command_idempotency` | `20260826023335_harden_account_command_idempotency` | `20260826115135_20260826023335_harden_account_command_idempotency` |
| `20260826114731_harden_domain_integrity` | `20260826120022_harden_domain_integrity` | `20260826115201_20260826114731_harden_domain_integrity` |
| `20260826115804_add_domain_integrity_indexes` | `20260826120028_add_domain_integrity_indexes` | `20260826115833_20260826115804_add_domain_integrity_indexes` |
| `20260827133604_restrict_non_active_data_api_access` | `20260827134735_restrict_non_active_data_api_access` | `20260827134627_restrict_non_active_data_api_access` |
| `20260827141232_close_reviewed_ledger_gaps` | `20260827142157_close_reviewed_ledger_gaps` | `20260827142028_close_reviewed_ledger_gaps` |
| `20260827153805_allow_unsent_payroll_reopen` | `20260827154153_allow_unsent_payroll_reopen` | `20260827154127_allow_unsent_payroll_reopen` |

이 mapping이 정규화되기 전에는 `supabase db push`를 사용하지 않는다. migration history repair는 schema 변경과 분리한 후속 작업이며, 이 릴리즈에서는 원격 기존 version을 수정하지 않는다.

## 운영 적용 순서

다음 파일의 전체 SQL을 Git에서 읽어 Supabase MCP `apply_migration`으로 한 건씩 적용한다. 다음 단계는 직전 단계가 성공하고 `list_migrations`에서 기록된 것을 확인한 뒤에만 진행한다.

1. `20260827211304_restrict_notification_recipient_updates.sql`
   - 현재 운영의 실효 권한은 이미 `read_at` UPDATE만 허용한다.
   - 멱등적인 revoke/grant를 다시 실행해 migration history를 명시적으로 남긴다.
2. `20260827224644_room_reservation_commands.sql`
3. `20260828220417_weekly_availability_contract.sql`
4. `20260829120003_add_developer_role.sql`
5. `20260829120005_developer_account_contract.sql`

적용 도중 실패하면 뒤 migration을 실행하지 않는다. 성공한 migration과 원격 객체 상태를 읽기 전용으로 확인하고, destructive down migration이나 history 조작 없이 새 append-only forward-fix migration을 만든다.

## main 병합 전 source 승인 gate

- release PR의 `application`과 `migration` required checks PASS
- GitHub fresh runner에서 전체 14개 migration 재적용, `db:verify`, DB/RLS 139 tests, 예약 동시성 PASS
- application lint/type/test/build와 Edge format/type PASS, application 69 tests 유지
- 최신 release head 독립 리뷰 P0/P1 0
- 운영 Security Advisor 차단사항 0
- `main...release/v0.2.0` diff에 이후 미완성 기능이나 비밀정보가 없음
- 운영 적용 순서, 실패 시 중단·append-only forward-fix, Fastify rollback 기준이 문서화됨

Issue #36의 Edge 운영 smoke는 이 source 승인 gate의 선행조건이 아니다. #37은 독립 리뷰 P0/P1 0과 required CI PASS로 `dev`에 병합하되, Issue #36은 아래 운영 smoke가 끝날 때까지 열린 상태로 유지한다.

## main 병합 후 운영 순서

1. 위 5개 pending migration을 순서대로 적용하고 각 version과 객체를 확인한다.
2. 계정 생성에 필요한 `ACCOUNT_PHONE_PEPPER`를 Function Secret에 먼저 설정한다. 이어 예약 PII key/version/keyring과 guest-name pepper를 준비한다.
3. 신뢰된 one-off Fastify/CLI 경로로 singleton developer를 bootstrap한다. 로그인 ID는 DB 계약대로 `admin`이며, 비밀번호·휴대전화 원문은 GitHub·문서·로그에 남기지 않는다.
4. developer가 별도의 active business admin을 생성하고 최초 로그인·비밀번호 변경을 확인한다. developer를 scheduler actor로 사용하지 않는다.
5. business admin의 profile ID를 `RESERVATION_SCHEDULER_ACTOR_PROFILE_ID`로 설정하고, 32자 이상 `SCHEDULER_INVOKE_SECRET`과 `CORS_ORIGINS`를 포함한 나머지 Function Secrets를 구성한다.
6. Edge Functions `api`, `reservation-scheduler`를 배포하고 HTTP smoke를 수행한다.
7. HTTP smoke가 통과한 뒤에만 Vault에 scheduler 호출값을 저장하고 `pg_cron`·`pg_net`을 활성화한다.
8. 실제 Cron을 여러 회 관찰해 job run, HTTP response, Edge log, command audit와 재시도 멱등성을 함께 검증한다.
9. 모든 운영 smoke가 통과한 뒤에만 Issue #36·#35·#24를 완료하고 annotated tag와 GitHub Release를 발행한다.

## 적용 후 smoke

- `public.rooms` 기준정보 121건과 public base table RLS 누락 0
- notification recipient의 `read_at` UPDATE 허용, `resolved_at` UPDATE 거부
- 예약·객실 command 함수와 가능일 command 함수 존재 및 service-role 외 실행 권한 차단
- developer login ID/normalized ID/alias가 정확히 `admin`이고 developer singleton·업무 권한 차단 계약이 유지됨
- 운영 migration 목록에 위 5개 이름이 순서대로 존재
- Security Advisor 차단사항 0, Performance Advisor는 ERROR/WARN을 차단하고 초기 unused-index INFO는 기록만 유지
- Edge health 200, developer `/auth/me` 200·rooms 403, active business admin rooms 121건, maid rooms 403, inactive/revoked/invalid JWT 차단
- scheduler secret 오류 차단, 정상 수동 호출 성공, 같은 `scheduledAt` 재호출의 결과·side effect 멱등성
- Vault/Cron 활성화 뒤 `cron.job_run_details`, `net._http_response`, Edge log, command audit 확인
- 위 smoke를 통과하지 못하면 Supabase-only runtime 채택·운영 배포 완료·`v0.2.0` 발행 완료로 표현하지 않음
