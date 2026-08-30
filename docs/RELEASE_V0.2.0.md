# v0.2.0 릴리즈 적용 기록

## 범위와 기준

- release candidate: `release/v0.2.0`
- 최초 기준 commit: `dev@4da80cb2ddcb5de2f5b3dd5bd41354b80a3f7ae5`
- 최신 운영 source: `main@2bc6c634ab95c2cdc758df39bb11eb310715575e`
- 운영 project: `aodikrxcczbogjpsjwjt`
- recovery project: `matalcofimnhuzslfhdd`
- 상태 추적: GitHub Issue #24

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

## 적용 완료 기록 — 재적용 금지

최초 source와 #42 follow-up source는 `main@2bc6c63`까지 승격됐다. 아래 migration은 운영 history 17건에 이미 포함되며 `apply_migration`이나 `db push`로 다시 실행하지 않는다.

| 단계 | 적용 완료 migration |
|---|---|
| 최초 release | notification 권한 제한, room/reservation commands, weekly availability, developer enum, developer account contract |
| #42 follow-up | `edge_login_rate_limit`, `harden_account_receipts_and_login_limits`, `isolate_login_rate_limit_clients` |

production Edge `api`와 `reservation-scheduler`도 승인된 main source에서 배포됐다. health/OpenAPI/Swagger 200, invalid JWT 차단, CORS, Supabase gateway client-header spoof 차단 smoke를 통과했다. business admin과 scheduler actor/secret은 아직 없으므로 scheduler 503 fail-closed는 현재 의도된 상태다.

현재 상태명은 **v0.2.0 source + Edge API deployed / operational activation pending**이다.

## #43·#44 Phase A 운영 활성화 gate

business admin을 one-off DB/Fastify 경로로 지금 만들지 않는다. 공식 운영 UI를 준비한 뒤 아래 순서를 따른다.

1. #43 developer 운영 API를 `feature → dev → release/v0.2.0 → main`으로 승격
2. #43 append-only migration을 main 병합 후 운영에 1회 적용
3. production Edge를 해당 main source에서 재배포하고 developer-only 권한·redaction smoke
4. #44 Phase A API-only Python 콘솔 구현·패키징·독립 보안 리뷰
5. 콘솔에서 developer 로그인 후 `POST /v1/accounts`로 active business admin 생성
6. business admin 최초 로그인과 개인 비밀번호 변경
7. business admin profile을 scheduler actor로 지정하고 invoke secret 구성
8. Vault + `pg_cron` + `pg_net` 활성화
9. 수동 scheduler와 실제 Cron의 heartbeat·audit·idempotency smoke
10. 모든 gate 통과 후 `v0.2.0` annotated tag와 GitHub Release 발행

#44 Phase B read-only DB 진단과 Phase C maintenance action catalog는 v0.2.0 비차단 후속이다. custom least-privilege role과 Shared Pooler 경계가 검증되기 전 direct DB mode는 비활성으로 출고한다.

## 후속 source·migration 적용 원칙

- feature/dev source와 migration을 production에 직접 배포·적용하지 않는다.
- release PR의 `application`·`migration`, fresh reset, 전체 DB/RLS·동시성 검증, 독립 리뷰 P0/P1 0을 먼저 확인한다.
- main 병합 직전과 적용 직전에 `list_migrations`를 다시 확인한다.
- 이미 같은 migration이 존재하면 재적용하지 않고 중단해 Issue #24 기록을 갱신한다.
- 적용 도중 실패하면 뒤 migration과 Edge 배포를 중단하고 destructive down/history 조작 없이 append-only forward-fix를 만든다.
- Security Advisor의 source/DDL 차단사항과 Performance ERROR/WARN을 확인한다. Free Plan의 leaked-password protection WARN은 알려진 제한으로 기록한다.
- Edge 장애 시 Cron을 먼저 중지하고 이전 Function/Fastify rollback 기준으로 전환하며 DB 원장과 적용 migration은 rewind하지 않는다.

Swagger UI는 운영 secret 입력·보관 수단이 아니다. 실제 token은 smoke 중에만 Authorize에 입력하고 브라우저 저장소에 유지하지 않으며, 캡처·로그·Issue에 남기지 않는다.
