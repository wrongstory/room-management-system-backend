# v0.5.0 릴리즈 후보·운영 적용 계획

> 상태: `dev@49214bb67f2cf346178bc12321948a810e050234`에서 release candidate를 고정했다. `release/v0.5.0 → main` 병합, production migration/API 배포, Pages 갱신은 아직 수행하지 않았다.

이 문서는 v0.5.0 source gate와, `main` 병합 이후 별도 운영 승인으로 수행할 Supabase·GitHub Pages 적용 절차를 구분한다. 개발 브랜치나 release 브랜치를 production에 직접 배포하지 않는다.

## 1. 기준 snapshot

| 경계 | 기준 |
|---|---|
| release source | `dev@49214bb67f2cf346178bc12321948a810e050234` |
| release base | `main@e2f2efacb27addfb5c9692f083def6f4631b9f4a` |
| production DB | 73 migrations, head `generated_room_pin_confirmation` |
| production API | `api` ACTIVE v19, OpenAPI 0.4.0 / 120 paths / 130 operations |
| production data readback | rooms 121 / active reservations 4 |
| release result | 77 migrations, OpenAPI 0.5.0 / 128 paths / 138 operations |

Production은 이 문서를 작성한 시점에도 기존 `main`/DB/API 상태다. release candidate를 만들었다는 사실만으로 production 사용 가능 상태를 변경하지 않는다.

## 2. Migration manifest

정본은 [`migration-manifest.v0.5.0.json`](../supabase/migration-manifest.v0.5.0.json)이다.

- 전체: 77개
- 적용 전 production baseline: 73개, head `generated_room_pin_confirmation`
- pending: 정확히 4개
- pending first: `availability_any_day_submission`
- 적용 순서:
  1. `availability_any_day_submission`
  2. `retire_assignment_duration_policy`
  3. `developer_room_catalog_capacity`
  4. `room_status_admin_correction`
- release head: `room_status_admin_correction`
- 검증: stable name, strict order, LF-normalized UTF-8 SHA-256

기존 73개 migration SQL은 수정·재적용하지 않는다. 자동 `db push`, migration history repair, 기존 원장 삭제로 운영 상태를 맞추지 않는다.

## 3. 포함 범위

### #229 가능일 상시 제출

- 일요일 알림 정책은 유지한다.
- active maid는 현재 주와 다음 주 가능일을 요일에 관계없이 직접 제출·변경할 수 있다.
- 기존 version/CAS/idempotency/RLS와 과거 이력을 보존한다.

### #231 예상시간 기반 배정 정책 폐기

- `POST /v1/assignments/preview` Fastify/Edge parity를 유지한다.
- `GET/POST /v1/assignment-preview/duration-policy`는 과거 policy 조회와 retired 전이만 제공한다.
- 청소 예상시간을 새 배정 최적화 또는 운영 필수값으로 다시 사용하지 않는다.

### #236 개발자 객실·인원 관리

- developer room catalog, 객실 추가, 안전 비활성화 preview/commit을 제공한다.
- 객실 유형 인원 변경은 impact preview, fingerprint, CAS, idempotency를 요구한다.
- 기존 예약·객실·감사 이력을 hard delete하거나 자동 보정하지 않는다.

### #228 객실 상태와 관리자 표시 보정

- canonical 점유/readiness와 관리자 표시 override를 별도 축으로 유지한다.
- 관리자는 객실별 표시를 `BLOCKED`, `OCCUPIED`, `ARRIVAL_PENDING`, `RESERVATION_PRESENT`, `CLEANING_REQUIRED`, `READY` 또는 override 해제로 조정할 수 있다.
- 표시 override는 예약·stay·객실 이동 원장을 바꾸지 않는다. 실제 업무 차단은 기존 operation-block 계약을 사용한다.

### #238 미등록 객실 PIN 최초 등록 hotfix

- `expectedPinVersion=0`인 admin PIN 수정 요청의 `ADMIN_PHYSICAL_CHANGE`를 서버가 최초 등록로 정규화한다.
- 이 hotfix는 이미 `main@e2f2efa...`와 production `api` v19에 반영됐고, dev backport도 release source에 포함된다.
- PIN 원문·암호문·token을 release 기록이나 검증 로그에 남기지 않는다.

## 4. 제외 범위

- `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync` 재배포
- Function Secrets, Vault, pg_cron, pg_net 또는 provider credential 변경
- Google Sheets/Web Push hosted activation과 실제 PIN bootstrap
- Pages 자동 배포, tag/GitHub Release 발행
- 안전 fixture가 없는 production 업무 mutation

이번 release의 runtime 변경 대상은 `api` bundle뿐이다. 네 worker bundle과 기존 Secrets/Cron은 그대로 유지한다.

## 5. Source gate

1. exact `dev@49214bb...`에서 `release/v0.5.0`을 구성하고 `main@e2f2efa...`와의 충돌을 해소한다.
2. 77개 migration manifest와 production 73→77 누적 upgrade를 검증한다.
3. fresh DB, 전체 DB/RLS, 동시성, application, Edge, Python/codegen, Pages fail-closed 검증을 실행한다.
4. OpenAPI가 0.5.0 / 128 paths / 138 operations인지 확인한다.
5. required `application`/`migration` CI와 exact-head 독립 QA P0/P1=0을 통과한다.
6. release PR을 `main`으로만 생성하고 승인 전에는 병합·운영 변경을 하지 않는다.

## 6. `main` 병합 후 운영 적용 순서

1. production migration history, schema, rooms 121, active reservations 4를 read-only로 다시 확인한다. baseline이 73/head `generated_room_pin_confirmation`과 다르면 중단한다.
2. 현재 운영 논리 backup·recovery 근거와 manifest의 73개 기존 hash를 확인한다.
3. pending 4개를 manifest 순서대로 적용하고 각 단계의 history, 권한, RLS, 핵심 RPC를 read-only로 확인한다.
4. 승인된 병합 `main` exact SHA에서 만든 `api` bundle만 배포한다.
5. `/health`, `/docs`, `/openapi.json` HTTP 200과 OpenAPI 0.5.0 / 128 / 138을 확인한다.
6. developer/admin/maid read-only role smoke와 아래 사용자 확인 항목을 수행한다. 안전한 mutation fixture가 없으면 임의 production 데이터를 만들지 않고 `SKIPPED_WITH_REASON`을 기록한다.
7. production OpenAPI parity가 확인된 뒤에만 `swagger-pages.yml`을 `workflow_dispatch`로 수동 실행한다.
8. 공개 portal, `openapi.json`, `portal-manifest.json` HTTP 200과 128/138 및 artifact SHA-256을 확인한다.

## 7. Rollback과 중단 기준

- migration history/name/hash/schema가 manifest와 다르면 첫 write 전에 중단한다.
- migration 실패 시 이미 적용된 원장과 history를 rewind/delete하지 않고 새 append-only forward-fix를 사용한다.
- 새 API 이상 시 77 schema와의 호환성이 확인된 직전 승인 `api` bundle로만 rollback하거나 forward-fix한다.
- worker bundle, Secrets, Cron, provider 설정은 이번 release에서 건드리지 않으므로 rollback 대상이 아니다.
- Pages 장애는 API/DB를 rollback하지 않고 Pages deployment만 중단한다.
- PIN, PII, token, secret, provider credential을 console, Issue, PR, release artifact에 남기지 않는다.

## 8. 사용자 직접 확인 체크리스트

### 메이드 가능일

- [ ] 일요일이 아닌 요일에도 현재 주/다음 주 가능일 제출이 성공한다.
- [ ] 같은 주를 다시 변경하면 최신 version으로 보이고 중복 row가 생기지 않는다.
- [ ] 다른 메이드의 가능일은 보이지 않거나 변경할 수 없다.

### 배정 미리보기

- [ ] 예상 청소시간 정책이 없어도 배정 Preview가 정상 결과를 반환한다.
- [ ] 과거 duration policy 조회는 가능하지만 새 confirmed policy를 만들 수 없다.
- [ ] 기존 draft/commit/notification 흐름은 유지된다.

### 개발자 객실 관리

- [ ] developer 화면에서 전체 객실 수와 객실 유형·활성 상태를 확인한다.
- [ ] 승인된 테스트 객실이 있을 때만 추가/비활성화 preview와 commit을 확인한다.
- [ ] 현재 점유·미래 예약·진행 청소가 있는 객실 비활성화는 차단된다.

### 관리자 객실 상태

- [ ] 실제 투숙 중은 canonical `OCCUPIED`로 표시된다.
- [ ] 입실 예정·예약 있음·청소 필요·배정 가능이 날짜와 원장에 따라 구분된다.
- [ ] 관리자가 객실별 표시 override를 설정·해제할 수 있다.
- [ ] 표시 override가 예약 객실이나 stay segment를 다른 객실로 이동시키지 않는다.

### PIN 회귀

- [ ] current PIN이 없는 객실에서도 관리자 PIN 등록이 성공한다.
- [ ] 등록 후 version과 sync 상태가 갱신되며 PIN 원문은 영구 화면·로그에 남지 않는다.

## 9. Closure checklist

- [x] release source `dev@49214bb67f2cf346178bc12321948a810e050234` 고정
- [x] production base `main@e2f2efacb27addfb5c9692f083def6f4631b9f4a` 고정
- [x] 77-migration manifest, production baseline 73, pending 4 계약 작성
- [x] Pages fail-closed source gate 0.5.0 / 128 / 138 구성
- [ ] 전체 local release 검증 PASS
- [ ] required `application`/`migration` CI PASS
- [ ] exact-head 독립 QA 90점 이상, P0/P1=0
- [ ] `release/v0.5.0 → main` 병합
- [ ] production 74~77 migration 적용
- [ ] production `api` 배포 및 128/138 readback
- [ ] 역할별 read-only/user 기능 확인
- [ ] GitHub Pages 수동 배포 및 public smoke
