# v0.6.5 컴플레인 기한 비차단 운영 승격

> 상태: #309/#310의 2026-09-26 릴리즈 적용 완료 기록. 아래 candidate 검증·배포 순서는 당시 이력이며 이번 문서 정합화에서 운영을 다시 검증하거나 배포하지 않는다.

## 2026-09-26 완료 근거와 남은 hosted 검증

[Issue #309 운영 적용 기록](https://github.com/wrongstory/room-management-system-backend/issues/309#issuecomment-5844084725)에 따라
PR #310의 merged main은 `08ee81693d997c11cbfca194e987f4acd26a3fe8`이다.
당시 production은 84 migrations / head `complaint_deadlines_non_blocking`, `api` ACTIVE v36,
health HTTP 200, OpenAPI 0.5.1 / 129 paths·139 operations, Security Advisor error 0이었다.
기존 rooms 121/reservations 21과 complaint 원장 0건을 보존했다.

Hosted positive mutation은 안전한 기존 complaint fixture가 없어
`SKIPPED_WITH_REASON=NO_SAFE_EXISTING_COMPLAINT_FIXTURE`였으며 PASS로 승격하지 않는다.
실제 역할별 검증은 #13에 남는다. Tag/GitHub Release는 발행하지 않았다.
이 기록은 현재 운영 재검증이 아니며 #308/#343의 이후 dev-only scheduler 변경 적용을 뜻하지 않는다.

## 당시 release candidate

`dev@ab185af2343644a5a2aec85962eb5272243844c4`의 #306 변경을 `release/v0.6.5 → main`으로 승격했다.
아래 숫자와 검증 결과는 v0.6.5 당시 candidate·release 범위다.

## 1. 범위

- 운영 기준선: 83 migrations, head `maid_pin_immediate_reveal`
- release 정본: 84 migrations, head `complaint_deadlines_non_blocking`
- pending migration: `complaint_deadlines_non_blocking` 정확히 1건
- 컴플레인 접수 30일과 메이드 응답 7일을 권한 만료가 아닌 주의 metadata로 유지한다.
- 미응답 판정은 시간이 지났다는 이유만으로 종결하지 않는다.
- 기존의 정확히 1회 응답, correction append-only/CAS, 역할·소유권·멱등성, typed counterpart notification을 유지한다.
- OpenAPI 기대값은 기존 0.5.1 / 129 paths / 139 operations를 유지한다.

#305 전체 overdue 관리자 알림 scheduler, 다른 Function, Secrets, Cron, Pages와 운영 업무 데이터 변경은 제외한다.

## 2. Migration manifest

정본은 [`migration-manifest.v0.6.5.json`](../supabase/migration-manifest.v0.6.5.json)이다.

- 전체: 84개
- 적용 전 baseline: 83개, head `maid_pin_immediate_reveal`
- pending: 정확히 1개
- release head: `complaint_deadlines_non_blocking`
- 검증: 발행된 v0.6.0 첫 83개 entry와 hash 동일, stable name, strict order, LF-normalized UTF-8 SHA-256

기존 migration SQL과 발행된 manifest를 수정하거나 재적용하지 않는다. 자동 `db push`, migration history repair, 기존 원장 삭제로 운영 상태를 맞추지 않는다.

## 3. 배포 전 gate

1. `npm ci`
2. `npm run ci:quality`
3. `npm run edge:check`
4. `npm run db:manifest:verify`
5. fresh local Supabase에서 `npm run db:verify`, `npm run db:test`, `npm run db:test:concurrency`
6. PostgreSQL runtime과 `btree_gist`·`pgcrypto` 설치 상태 및 Security Advisor를 읽기 확인한다.
7. release PR의 exact head `application`/`migration` required checks와 독립 QA 90점 이상, P0/P1=0을 확인한다.

로컬 release candidate 검증 결과:

- `npm run ci:quality`: PASS, Vitest 49 files / 578 tests 및 OpenAPI 129 paths / 139 operations
- `npm run edge:check`: PASS, Deno 286 tests 및 bundle 17,140,596 bytes
- `npm run db:manifest:verify`: PASS, v0.6.5 84/83/1 경계와 기존 manifest hash 검증
- `npm run db:verify`: PASS, fresh local DB에 84 migrations 적용
- `npm run db:test`: PASS, pgTAP 64 files / 3,327 tests 및 누적 upgrade 회귀
- `npm run db:test:concurrency`: PASS, 예약·배정·현장수행·사진·지급·알림·PIN 동시성 회귀
- `npm exec supabase -- db lint --local --level error`: PASS, error 0건

## 4. `main` 병합 후 운영 적용 순서

1. production migration history가 83개/head `maid_pin_immediate_reveal`인지 read-only로 재확인한다. 다르면 중단한다.
2. 백업·복구 근거와 기존 83개 migration hash를 확인한다.
3. exact merged `main`의 84번째 migration만 적용하고 history, 함수 signature, 권한과 원장 보존을 확인한다.
4. exact merged `main` source를 로컬 Edge bundle로 만들고 `api`만 배포한다.
5. Function ACTIVE, `/health` 200, OpenAPI 0.5.1 / 129 / 139를 확인한다.
6. 안전한 기존 complaint fixture가 있으면 30일 이후 접수와 7일 이후 최초 응답의 비차단 계약을 확인한다. 안전한 fixture가 없으면 임의 운영 사건을 만들지 않고 `SKIPPED_WITH_REASON`으로 기록한다.
7. 이상이 없을 때 annotated tag와 GitHub Release 발행 여부를 별도 확인한다.

## 5. 복구와 중단 기준

- migration 이력·schema·runtime이 예상과 다르면 적용 전에 중단한다.
- DB migration은 rollback SQL이나 이력 삭제 대신 후속 append-only migration으로 forward-fix한다.
- API 배포가 실패하면 DB 상태를 유지하고 직전 정상 `api` bundle을 재배포한다.
- secret, token, profile UUID, 고객 정보, 객실 PIN과 raw request body를 로그·PR·보고서에 남기지 않는다.
