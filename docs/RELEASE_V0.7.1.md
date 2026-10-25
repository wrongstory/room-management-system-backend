# v0.7.1 객실 PIN Edge 설정 복구

## 승인과 범위

2026-09-29 사용자가 필수 검증/독립 QA 통과 후 release PR을 통한 운영 API 코드 배포를 승인했다. #315 / source PR #316의 PIN runtime 프로젝트 식별자 해석만 승격한다. DB, Secrets, 암호키, 실제 객실 PIN, Auth 설정과 다른 Function은 변경하지 않는다. 실제 PIN 변경·물리 확인 smoke는 승인 범위 밖이다. 진단 로그 개선 #317은 후속이다.

- 운영 기준: v0.7.0 / API ACTIVE v37 / OpenAPI 0.6.0, 131 paths / 141 operations.
- runtime이 제공하는 canonical SUPABASE_URL에서 hosted project Ref를 도출한다. 필수 SUPABASE_PROJECT_REF custom secret 의존을 제거하며 reserved prefix secret을 추가하지 않는다.
- 명시 ref 충돌과 비정규 URL은 fail-closed한다. local/test에는 exact Kong 내부 URL 호환을 유지한다.
- 저장 AAD·키 version·PIN revision, admin/maid 권한·최종 감사·30초 TTL·no-store, 물리 확인·CAS·멱등성은 유지한다.
- HTTP 계약 및 프런트 소스 변경 없음. 프런트 main d509b44b의 generated PIN API 경로와 호환된다.

## Migration 및 보존

운영 read-only 확인: 85 migrations, head flat_cleaning_evidence_history_payroll (20260928095656), 객실 121개. 이번 릴리스의 pending migration은 0개다. migration SQL/hash와 기존 원장을 변경하지 않는다. db push/history repair/키 재발급/bootstrap/PIN mutation은 실행하지 않는다.

## 검증과 보안

- 수정 전 hosted 환경의 reveal 503 재현 → 수정 후 PASS.
- 독립 QA의 local Kong 호환 P1을 RED 재현 후 수정, 재리뷰 P0/P1/P2=0, 98/100.
- ci:quality PASS: typecheck/lint/build, 580 application tests, OpenAPI 계약 검사.
- 충돌 해소 후 ci:quality/edge:check 재실행 PASS: 580/288 tests, Windows candidate bundle 17,169,459 bytes. source PR Linux CI bundle은 17,094,183 bytes이며 줄바꿈/번들 경로 차이를 포함하므로 바이트 동일성 대신 exact Git source를 기준으로 배포한다.
- fresh local db:verify 및 12 upgrade 경로/db:test PASS: 64 files / 3,366 assertions.
- manifest 5종 PASS, 기존 85 migration 변경 없음.
- 로컬 전체 동시성·KST 자정 경계 5개 시각·fresh 합성 복구 PASS. 동시성 테스트 직후의 backup 단독 실행은 121실 precondition에 걸렸으며, 정해진 backup:dry-run:fresh 재실행으로 통과했다. 검사 기준 완화 없음.
- release exact HEAD의 application/migration CI와 독립 QA를 병합 직전에 확인한다. 실행 중 결과를 PASS로 미리 표시하지 않는다.
- 운영 Security Advisor 사전 확인: DB/RLS WARN/ERROR 없음, 의도적인 private RLS/no-policy INFO. 기존 auth_leaked_password_protection WARN 1건은 이번 코드 수정과 무관하며 설정을 변경하지 않는다.
- 운영 PostgreSQL 17.6 / btree_gist 1.7 / pgcrypto 1.3 확인. 이번 릴리스는 DB runtime/extension 업그레이드를 포함하지 않는다.

## 운영 적용 및 smoke

1. release/v0.7.1 → main PR에서 필수 checks, 독립 QA, 변경 범위·충돌·미해결 리뷰를 확인하고 squash merge한다.
2. merged main exact source와 기존 85 migration parity를 확인한다. api만 기존 verify_jwt=false 및 static assets 설정을 유지하여 배포한다. 보호 API의 DB session/profile 검증은 유지한다.
3. Function ACTIVE 새 version, health 200, OpenAPI 0.6.0 / 131 / 141, CORS와 인증 없는 PIN 접근 거부를 검사한다.
4. 기존 로그인 관리자 세션에서 350호 PIN 조회를 검증한다. 표시 성공 여부·30초 이내 숨김·finalize 여부만 증거로 기록하고 원문 PIN/화면의 원문 캡처는 남기지 않는다.
5. 실제 PIN 변경·확인은 실행하지 않는다. 조회 복구와 물리 변경 검증을 구분해 #315에 최종 상태를 기록한다. 조회 후에도 오류가 있으면 다른 key/config 원인을 조사하고 복구 완료로 표시하지 않는다.

## Rollback과 제한사항

직전 운영 main source 5303fd5를 이용해 api만 재배포할 수 있으나 종전 503이 재발할 수 있다. DB/키/PIN을 변경하지 않았으므로 데이터 rollback 또는 재암호화를 하지 않는다. 운영 API source 변경과 실제 관리자 조회 smoke 결과는 배포 후 #315 및 release PR에 갱신한다. GitHub Release 발행은 이 배포의 필수 단계가 아니다.
