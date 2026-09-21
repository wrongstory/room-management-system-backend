# v0.5.1 예약 가능 미리보기 hotfix 적용 계획

> 상태: #245 hotfix는 `main@dda676dc6527a75a2271140d83ae6d2dbfb7cadf`, production 78 migrations, `api` ACTIVE v24, OpenAPI 0.5.1 / 128 / 138까지 반영됐다. dev backport와 Pages v0.5.1 공개 readback은 별도 gate다.

## 1. 범위

- `POST /v1/reservations/bookability/preview`의 `guestCount` 생략과 `null`을 같은 `null`로 정규화한다.
- `guestCount=null`이면 임의 1명을 넣지 않고 기간 overlap과 기존 운영 차단 조건만 판정한다.
- 양의 정수이면 객실 유형의 최신 최대 인원 검사를 유지한다.
- 예약 create/change의 `guestCount` 필수 및 최종 DB 최대 인원 검증은 바꾸지 않는다.
- OpenAPI info version은 0.5.1로 올리고, 공개 계약 수는 128 paths / 138 operations를 유지한다. Pages는 이 세 값이 모두 일치할 때만 수동 배포한다.

## 2. Migration manifest

dev 정본의 v0.5.0 snapshot [`migration-manifest.v0.5.0.json`](../supabase/migration-manifest.v0.5.0.json)은 77개 migration, integration baseline 74개, pending 3개를 나타내며 backport에서도 byte-identical로 보존한다. production에 발행된 main artifact의 baseline metadata와 다르더라도 첫 77개 migration entry와 hash는 동일하다.

이번 hotfix 정본은 [`migration-manifest.v0.5.1.json`](../supabase/migration-manifest.v0.5.1.json)이다.

- 전체: 78개
- 적용 전 baseline: 77개, head `room_status_admin_correction`
- pending: 정확히 1개
- pending migration: `reservation_bookability_optional_guest_count`
- release head: `reservation_bookability_optional_guest_count`
- 검증: v0.5.0 첫 77개 entry와 hash 동일, stable name, strict order, LF-normalized UTF-8 SHA-256

기존 77개 migration SQL과 v0.5.0 manifest를 수정하거나 재적용하지 않는다. 자동 `db push`, migration history repair, 기존 원장 삭제로 운영 상태를 맞추지 않는다.

## 3. Source gate

1. exact `main@ed34abe5c5375323dc6952c330183b73c9211547`에서 `hotfix/245-bookability-guest-count-optional`을 구성한다.
2. fresh 78 migrations와 별도 77→78 upgrade를 검증한다.
3. Fastify, Edge, OpenAPI, Python generated contract와 DB/RLS/concurrency 검증을 실행한다.
4. v0.5.0 manifest가 원본과 byte-identical인지 확인한다.
5. required `application`/`migration` CI와 exact-head 독립 QA P0/P1=0을 통과한다.
6. hotfix PR은 `main`으로 생성하되 승인 전에는 병합·운영 변경을 하지 않는다.

## 4. `main` 병합 후 운영 적용 순서

1. production migration history와 schema가 77개/head `room_status_admin_correction`인지 read-only로 확인한다. 다르면 중단한다.
2. 기존 77개 hash와 backup/recovery 근거를 확인한다.
3. 78번째 `reservation_bookability_optional_guest_count` 한 건만 적용하고 history, 함수 signature, 권한과 원장 보존을 확인한다.
4. hotfix가 병합된 `main` exact SHA에서 만든 `api` bundle만 배포한다.
5. `/health`, `/docs`, `/openapi.json`의 200 및 0.5.1 / 128 paths / 138 operations를 확인한다.
6. admin 세션에서 `guestCount` 생략, 명시적 `null`, 양의 정수 요청을 확인한다. 생략/`null`에서는 capacity reason이 없어야 하고, 양의 정수에서는 기존 capacity 판정을 유지해야 한다.
7. create/change 예약의 `guestCount` 필수 계약이 유지되는지 확인한다.
8. 앞선 운영 검증이 모두 통과한 뒤 `main`의 `swagger-pages.yml`을 수동 실행한다. Pages build는 production OpenAPI가 0.5.1 / 128 / 138과 정확히 일치하지 않으면 fail-closed한다.
9. 공개 Pages의 index, same-origin `openapi.json`, `portal-manifest.json`이 HTTP 200이고 version/count/artifact hash가 배포 계약과 일치하는지 확인한다.

이번 hotfix는 다른 Function, Secrets, Cron, worker 또는 production 업무 데이터를 변경하지 않는다. Pages는 API 배포와 hosted 계약 검증 뒤 별도 수동 단계로만 갱신한다.
