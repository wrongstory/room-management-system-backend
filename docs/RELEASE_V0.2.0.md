# v0.2.0 릴리즈 적용 기록

## 범위와 기준

- release candidate: `release/v0.2.0`
- 최초 기준 commit: `dev@4da80cb2ddcb5de2f5b3dd5bd41354b80a3f7ae5`
- 최신 통합 기준 commit: `dev@2a73c1b76b89e54f6325bff22effae32bb790df1`
- 운영 project: `aodikrxcczbogjpsjwjt`
- recovery project: `matalcofimnhuzslfhdd`
- 상태 추적: GitHub Issue #24

최신 release candidate에는 프런트 정본 갱신(#41), singleton developer 계층(#39), Supabase Edge runtime PoC(#37), Edge 계정 관리·Swagger source(#45)가 포함된다. `release/v0.2.0 → main` 병합은 **운영 배포 가능한 승인된 source 확정**만 뜻하며, 운영 migration·Edge 배포·runtime 채택·`v0.2.0` 발행 완료를 뜻하지 않는다.

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

## follow-up main 병합 전 source 승인 gate

- release PR의 `application`과 `migration` required checks PASS
- fresh local DB에 전체 17개 migration 재적용, DB/RLS 169 tests, 예약·계정·로그인 동시성 PASS
- application lint/type/test/build 80 tests와 Edge format/type/unit 15 tests PASS
- PR #45 최신 head 독립 리뷰 P0/P1 0
- follow-up release PR 최신 head 독립 리뷰 P0/P1 0
- 운영 Security Advisor의 source/DDL 차단사항 0
- `main..release/v0.2.0` content diff가 #42 source와 신규 migration 3건으로 제한되고 이후 미완성 기능이나 비밀정보가 없음
- 운영 적용 순서, 실패 시 중단·append-only forward-fix, Fastify rollback 기준이 문서화됨

Issue #36의 Edge 운영 smoke는 source 승인 gate의 선행조건이 아니다. Issue #36은 아래 운영 smoke가 끝날 때까지 열린 상태로 유지한다.

운영 Security Advisor의 `Leaked Password Protection Disabled` WARN은 Supabase Pro 이상에서만 활성화 가능한 기능으로, Free Plan 고정 정책에서는 해소할 수 없는 알려진 플랫폼 제한이다. 이 항목은 source/DDL 차단사항으로 분류하지 않되 강제 초기 비밀번호 변경, 계정 잠금, durable 로그인 limiter를 유지하고 운영 기록에 남긴다.

## 적용 후 smoke

- `public.rooms` 기준정보 121건과 public base table RLS 누락 0
- notification recipient의 `read_at` UPDATE 허용, `resolved_at` UPDATE 거부
- 예약·객실 command 함수와 가능일 command 함수 존재 및 service-role 외 실행 권한 차단
- 운영 migration 목록에 위 3개 이름이 순서대로 존재
- Security Advisor의 source/DDL 차단사항 0. Free Plan의 leaked-password protection WARN은 알려진 제한으로 기록하고, Performance Advisor는 ERROR/WARN을 차단하며 초기 unused-index/FK-index INFO는 기록만 유지
- Edge `api/health`, 실제 관리자 Auth/rooms, Cron scheduler HTTP smoke를 통과하지 못하면 배포 완료로 표현하지 않음

## #42 follow-up source와 운영 적용

위 3건은 최초 `main@c25e234` 이후 운영에 적용 완료된 기존 기록이다. Issue #42의 Edge 인증·계정 관리 API는 `dev@2a73c1b`에 병합됐고 follow-up release PR을 통해 `main` 승격을 기다린다. 이 source가 `main`에 도달하기 전에는 production Edge Function을 배포하거나 아래 신규 migration을 운영에 적용하지 않는다.

1. `20260830015035_edge_login_rate_limit.sql`
   - 로그인 alias 조회보다 앞선 durable fixed-window 저장소 기반
2. `20260830045832_harden_account_receipts_and_login_limits.sql`
   - rotating login ID의 write/cardinality 상한 기반 추가
   - 계정 command를 actor·command·key + canonical request hash receipt로 전환
   - 기존 service-role용 per-login-only/account RPC 실행 권한 회수
3. `20260830054446_isolate_login_rate_limit_clients.sql`
   - trusted client → login ID → emergency global 순서로 로그인 DoS 격리
   - saturated bucket의 추가 거부 write 중단, 기존 client-unaware RPC 권한 회수
4. production Function 재배포 후 `/api/openapi.json`, `/api/docs`, 로그인·비밀번호 변경, developer/admin/maid 계정 관리 권한 smoke
5. production gateway가 spoofed client header보다 platform client address를 우선하는지 smoke
6. 기존 developer를 다시 bootstrap하지 않고, developer가 별도 active business admin을 생성
7. business admin의 임시 비밀번호 변경과 scheduler actor 지정 후 Edge/Cron smoke

Swagger UI는 운영 secret 입력·보관 수단이 아니다. 실제 token은 smoke 중에만 Authorize에 입력하고 브라우저 저장소에 유지하지 않으며, 캡처·로그·Issue에 남기지 않는다.
