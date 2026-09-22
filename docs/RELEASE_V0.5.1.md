# v0.5.1 예약 가능 미리보기 hotfix 적용·발행 상태

> 상태: PR #246은 `main@dda676dc6527a75a2271140d83ae6d2dbfb7cadf`에 병합됐다. 2026-09-23 read-only 재확인에서 production migration은 78건/head `reservation_bookability_optional_guest_count`, `api`는 ACTIVE v24였다. 운영 API와 공개 Pages의 OpenAPI는 모두 0.5.1 / 128 paths / 138 operations였다. 이 readback의 기준 `main@273d85f7cbefac0187519e7955e23de48056f927`에는 이후 Pages workflow 변경까지 포함된다. `v0.5.1` tag/GitHub Release는 아직 없다.

## 1. 범위

- `POST /v1/reservations/bookability/preview`의 `guestCount` 생략과 `null`을 같은 `null`로 정규화한다.
- `guestCount=null`이면 임의 1명을 넣지 않고 기간 overlap과 기존 운영 차단 조건만 판정한다.
- 양의 정수이면 객실 유형의 최신 최대 인원 검사를 유지한다.
- 예약 create/change의 `guestCount` 필수 및 최종 DB 최대 인원 검증은 바꾸지 않는다.
- OpenAPI info version은 0.5.1로 올리고, 공개 계약 수는 128 paths / 138 operations를 유지한다. Pages는 이 세 값이 모두 일치할 때만 수동 배포한다.

## 2. Migration manifest

v0.5.0 정본 [`migration-manifest.v0.5.0.json`](../supabase/migration-manifest.v0.5.0.json)은 77개 migration, production baseline 73개, pending 4개를 나타내는 발행 당시 artifact이므로 byte-identical로 보존한다.

이번 hotfix 정본은 [`migration-manifest.v0.5.1.json`](../supabase/migration-manifest.v0.5.1.json)이다.

- 전체: 78개
- 적용 전 baseline: 77개, head `room_status_admin_correction`
- pending: 정확히 1개
- pending migration: `reservation_bookability_optional_guest_count`
- release head: `reservation_bookability_optional_guest_count`
- 검증: v0.5.0 첫 77개 entry와 hash 동일, stable name, strict order, LF-normalized UTF-8 SHA-256

기존 77개 migration SQL과 v0.5.0 manifest를 수정하거나 재적용하지 않는다. 자동 `db push`, migration history repair, 기존 원장 삭제로 운영 상태를 맞추지 않는다.

## 3. Source gate 완료 기록

1. 당시 `main@ed34abe5c5375323dc6952c330183b73c9211547`에서 `hotfix/245-bookability-guest-count-optional`을 구성했다.
2. PR #246에서 fresh 78 migrations, 별도 77→78 upgrade, Fastify/Edge/OpenAPI/Python 계약과 DB/RLS/concurrency를 검증했다.
3. 기존 v0.5.0 migration entries와 hash를 변경하지 않았고, required `application`/`migration` 및 exact-head 독립 QA P0/P1=0을 통과했다.
4. PR #246을 `main@dda676dc6527a75a2271140d83ae6d2dbfb7cadf`로 병합했다. 이후 `main`의 Pages-only 변경은 API 명령 계약을 변경하지 않았다.

## 4. 당시 `main` 병합 후 운영 적용 순서

아래는 당시 승인한 절차의 기록이며 이미 완료된 DB/API/Pages 배포를 재실행하라는 지시가 아니다. 운영 DB 이력은 2026-09-23 읽기 전용으로 재확인했지만 `guestCount` 역할별 positive smoke는 이번 문서 정정만으로 PASS 처리하지 않는다.

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

## 5. 2026-09-22~23 readback과 남은 발행 gate

| 항목 | 현재 증거 |
|---|---|
| 운영 `/health` | HTTP 200 |
| 운영 `/openapi.json` | HTTP 200, 0.5.1 / 128 paths / 138 operations |
| 공개 Pages index / `openapi.json` / `portal-manifest.json` | 모두 HTTP 200, manifest 0.5.1 / 128 / 138; workflow run `35627903617` 성공 |
| 운영 migration 78건·head | Supabase production read-only list로 78건, head `reservation_bookability_optional_guest_count` 확인 |
| `guestCount` 생략/null/양수 hosted admin smoke | 이번 턴 미실행; 개수·버전 readback으로 대체하지 않음 |
| `v0.5.1` annotated tag / GitHub Release | 미발행. production DB history와 hosted 계약을 확인한 뒤 별도 발행 판단 |

PR #251의 진행 중 메이드 후속 배정 Preview는 `dev` 후보이며 이 v0.5.1 운영 release의 완료 기능으로 표시하지 않는다. 해당 변경의 병합·새 릴리즈·운영 배포는 별도 gate다.
