# v0.6.0 운영 승격 실행 기록

> 상태: release candidate. `dev@15257164d4256e56f0f334b3036cc61987756b71`을 변경 없이 승격하며, 운영 적용은 release PR이 `main`에 병합된 뒤에만 수행한다.

## 1. 범위

- 운영 기준선: 78 migrations, head `reservation_bookability_optional_guest_count`
- release 정본: 83 migrations, head `maid_pin_immediate_reveal`
- pending migrations: 아래 5개를 버전 순서대로 한 번씩만 적용한다.
  1. `assignment_unavailability_reassignment`
  2. `inspection_queue_pagination`
  3. `room_operations_pagination`
  4. `backend_console_readonly_diagnostics`
  5. `maid_pin_immediate_reveal`
- Edge Function: exact merged `main` source의 `api`만 재배포한다.
- OpenAPI 기대값: 0.5.1 / 129 paths / 139 operations
- Android Motion Photo와 Samsung SEF trailer를 제거하고 primary JPEG만 정규화하는 수정이 포함된다.

다른 Function, Secrets, Cron, 공개 Pages와 운영 업무 데이터는 변경하지 않는다. 임의 객실, 배정, 사진 슬롯 또는 QA fixture를 만들지 않는다.

## 2. Migration manifest

정본은 [`migration-manifest.v0.6.0.json`](../supabase/migration-manifest.v0.6.0.json)이다.

- 전체: 83개
- 적용 전 baseline: 78개, head `reservation_bookability_optional_guest_count`
- pending: 정확히 5개
- pending first: `assignment_unavailability_reassignment`
- release head: `maid_pin_immediate_reveal`
- 검증: v0.5.1 첫 78개 entry와 hash 동일, stable name, strict order, LF-normalized UTF-8 SHA-256

기존 migration SQL과 발행된 manifest를 수정하거나 재적용하지 않는다. 자동 `db push`, migration history repair, 기존 원장 삭제로 운영 상태를 맞추지 않는다.

## 3. 배포 전 gate

1. `npm ci`
2. `npm run ci:quality`
3. `npm run edge:check`
4. `npm run db:manifest:verify`
5. fresh local Supabase에서 `npm run db:verify`, `npm run db:test`, `npm run db:test:concurrency`
6. release branch가 `dev@15257164d4256e56f0f334b3036cc61987756b71`의 전체 history를 포함하고 추가 변경이 릴리스 문서·manifest·검증 스크립트뿐인지 확인
7. release PR의 `application`/`migration` required checks 통과 및 리뷰 승인 확인

로컬 release candidate 검증 결과:

- `npm ci`: PASS, 취약점 0건
- `npm run ci:quality`: PASS, Vitest 48 files / 541 tests 및 OpenAPI 129 paths / 139 operations
- `npm run edge:check`: PASS, Deno 283 tests 및 bundle 17,108,359 bytes
- `npm run db:manifest:verify`: PASS, v0.6.0 83/78/5 경계와 hash 검증
- `npm run db:verify`: PASS, fresh local DB에 83 migrations 적용
- `npm run db:test`: PASS, pgTAP 64 files / 3,326 tests 및 누적 upgrade 회귀
- `npm run db:test:concurrency`: PASS, 예약·배정·사진·지급·알림·PIN 동시성 회귀

## 4. `main` 병합 후 운영 적용 순서

1. production migration history가 78개/head `reservation_bookability_optional_guest_count`인지 read-only로 재확인한다. 다르면 중단한다.
2. exact merged `main`의 79~83번째 migration을 순서대로 적용하고 각 실행의 성공 여부와 최종 history를 확인한다.
3. 운영 history가 83개/head `maid_pin_immediate_reveal`인지 확인한다.
4. Node 22에서 `node scripts/generate-photo-edge.mjs --assets-only`로 ImageMagick 자산을 생성한다.
5. exact merged `main` source를 로컬 Edge bundle로 만들고 `api`만 배포한다. 서버 번들링 API의 413 경로는 사용하지 않는다.
6. Function이 `ACTIVE`인지 확인하고 `/health`, `/openapi.json`을 읽기 방식으로 검증한다.
7. OpenAPI가 0.5.1 / 129 paths / 139 operations이고 JPEG/WebP/HEIC/HEIF 입력 최대 5 MiB, 저장 결과 JPEG/WebP 최대 300 KiB 계약을 유지하는지 확인한다.
8. 승인된 운영 배정과 사진 슬롯이 있을 때만 실제 사진 업로드를 검증한다.

## 5. Rollback과 실패 처리

- DB migration은 원장을 되돌리거나 이미 적용된 SQL을 수정하지 않고 후속 migration으로 forward-fix한다.
- API 배포가 실패하면 DB 상태를 유지하고 마지막 정상 `api` bundle을 재배포한다.
- migration 실패, OAuth/Drive 실패, 이미지 decode·정규화 실패, DB finalize/CAS 실패를 서로 구분하고 HTTP 상태, 안정적인 error code, request ID만 기록한다.
- 비밀값, 사진 원본, 고객 정보와 객실 PIN은 로그·PR·이 문서에 남기지 않는다.

## 6. 완료 기준

- 운영 migration 83개/head `maid_pin_immediate_reveal`
- 운영 `api` Function `ACTIVE`
- `/health` 200
- OpenAPI 0.5.1 / 129 paths / 139 operations 및 사진 계약 유지
- 운영 업무 레코드의 임의 변경 없음
- 실제 사진 업로드는 승인된 기존 대상에서 별도로 검증하고, 미실행이면 잔여 항목으로 보고
