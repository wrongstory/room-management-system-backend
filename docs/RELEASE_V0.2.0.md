# v0.2.0 릴리즈 적용 기록

## 범위와 기준

- release candidate: `release/v0.2.0`
- 최초 기준 commit: `dev@4da80cb2ddcb5de2f5b3dd5bd41354b80a3f7ae5`
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

## 운영 적용 순서

다음 파일의 전체 SQL을 Git에서 읽어 Supabase MCP `apply_migration`으로 한 건씩 적용한다. 다음 단계는 직전 단계가 성공하고 `list_migrations`에서 기록된 것을 확인한 뒤에만 진행한다.

1. `20260827211304_restrict_notification_recipient_updates.sql`
   - 현재 운영의 실효 권한은 이미 `read_at` UPDATE만 허용한다.
   - 멱등적인 revoke/grant를 다시 실행해 migration history를 명시적으로 남긴다.
2. `20260827224644_room_reservation_commands.sql`
3. `20260828220417_weekly_availability_contract.sql`

적용 도중 실패하면 뒤 migration을 실행하지 않는다. 성공한 migration과 원격 객체 상태를 읽기 전용으로 확인하고, destructive down migration이나 history 조작 없이 새 append-only forward-fix migration을 만든다.

## 적용 전 gate

- release PR의 `application`과 `migration` required checks PASS
- local fresh reset, application 60 tests, DB 126 tests, 예약 동시성, DB lint PASS
- 독립 리뷰 P0/P1 0
- 운영 Security Advisor 차단사항 0
- 예약 PII key/version/keyring, guest-name pepper가 production Function Secrets에 존재
- 운영 DB에 활성 관리자 계정이 있고 그 profile ID가 scheduler actor secret으로 설정됨
- Issue #36 Edge API/Auth/rooms/scheduler PoC의 운영 smoke와 독립 리뷰 통과

## 적용 후 smoke

- `public.rooms` 기준정보 121건과 public base table RLS 누락 0
- notification recipient의 `read_at` UPDATE 허용, `resolved_at` UPDATE 거부
- 예약·객실 command 함수와 가능일 command 함수 존재 및 service-role 외 실행 권한 차단
- 운영 migration 목록에 위 3개 이름이 순서대로 존재
- Security Advisor 차단사항 0, Performance Advisor는 ERROR/WARN을 차단하고 초기 unused-index INFO는 기록만 유지
- Edge `api/health`, 실제 관리자 Auth/rooms, Cron scheduler HTTP smoke를 통과하지 못하면 배포 완료로 표현하지 않음
