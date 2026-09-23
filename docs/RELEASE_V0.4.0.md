# v0.4.0 릴리즈·운영 적용 기록

> 상태: `main@80f935016d5581d500136fba29c206f6ee797bc0`을 production DB/API와 GitHub Pages에 반영 완료. 보호 API 역할별 read와 안전 fixture 기반 mutation smoke는 별도 대기.

이 문서는 Issue #220의 `release/v0.4.0 → main` source gate와, 그 이후 별도 승인이 필요한 Supabase 운영 적용 순서를 구분한다.

## 1. 기준 snapshot

| 경계 | 기준 |
|---|---|
| production DB | 73 migrations, head `generated_room_pin_confirmation` |
| production API | `api` ACTIVE v17, OpenAPI 0.4.0 / 120 paths / 130 operations |
| repository·production `main` | `80f935016d5581d500136fba29c206f6ee797bc0` |
| release source | `dev@9c197ad12ed5cb45db0b451f69f9f91053b139d7` |
| release result | 73 migrations, OpenAPI 0.4.0 / 120 paths / 130 operations |

`dev` 코드나 release 브랜치를 운영 Supabase에 직접 배포하지 않는다. required CI와 release QA를 통과한 `release/v0.4.0`을 `main`에 병합한 후에만 별도 운영 승인으로 적용한다.

## 2. Migration manifest

정본은 [`migration-manifest.v0.4.0.json`](../supabase/migration-manifest.v0.4.0.json)이다.

- 전체: 73개
- 적용 전 production baseline: 56개, head `cleaning_template_duration_optional`
- 적용 완료: 17개
- pending first: `photo_slot_contract_v8`
- release head: `generated_room_pin_confirmation`
- 검증: stable name, 순서, LF-normalized UTF-8 SHA-256

57~73번 정확한 append-only migration을 적용했다. 기존 56개를 수정·재적용·history repair하지 않았고, 적용 전 production data를 recovery 프로젝트에 복원한 뒤 동일 누적 upgrade를 먼저 검증했다.

## 3. 포함 기능

- v8 사진 슬롯과 extra-proof collection
- 현재 객실 lifecycle/readiness/PIN projection
- 체크인 전 및 투숙 중 객실 이동
- 사진 retention v2
- assignment PIN entitlement
- 예약 구간 bookability, 장기 투숙·종료 미정
- 객실 유형 catalog, 청소·주간 근무 이력
- 객실 운영 항목·event timeline, payroll cycle resolver
- 초기 4자리 객실 PIN 자동 생성·제한 열람·물리 확인

## 4. Source gate

1. `main`/`dev` 충돌을 해소하되 업무 코드·Edge·OpenAPI·테스트는 최신 `dev` 정본을 유지한다.
2. `main` 전용 release manifest·Pages fail-closed gate를 v0.4.0 / 73 / 120 / 130으로 재구성한다.
3. fresh DB 73개와 production baseline 56→73 누적 upgrade, 전체 DB/RLS·동시성을 검증한다.
4. `application`/`migration` required CI와 exact-head QA P0/P1=0을 통과한다.
5. release PR은 `main`으로만 생성하고 승인 전에 병합하지 않는다.

## 5. 운영 적용 순서

아래 순서로 운영 적용을 완료했다.

1. production migration history·schema를 read-only로 대조하고 logical backup을 암호화 보관했다. recovery 프로젝트에 production app data를 복원해 56→73 누적 upgrade와 원장 보존을 검증했다.
2. manifest의 57~73을 순서대로 적용했다. production은 73개, public RLS 49/49, FK 384건 위반 0, DB lint error 0이다.
3. 병합된 `main@80f935016d5581d500136fba29c206f6ee797bc0`에서 `api` Function만 재배포했다.
   - `reservation-scheduler`, `photo-purge`, `notification-delivery`, `room-pin-sheet-sync`는 이번 release에서 source diff가 없으므로 재배포하지 않고 현재 production bundle을 유지
4. `/health`, `/docs`, `/openapi.json` HTTP 200과 OpenAPI 0.4.0 / 120 / 130을 확인했다. 기존 네 Worker 버전은 변경되지 않았다.
5. 보호 API 역할별 read와 예약·객실 상태·PIN lifecycle mutation은 이번 실행에서 재검증하지 않았다. 안전 fixture가 없으므로 mutation은 `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`다.
6. hosted provider·Google·Cron·Web Push는 각 Issue의 자격증명·대상·주기 승인 후 별도 활성화
7. production API parity 확인 후 Pages workflow run `35481531782`를 수동 실행했다. 공개 portal/OpenAPI/manifest는 HTTP 200이고 0.4.0 / 120 / 130 및 artifact SHA-256이 일치한다.

## 6. 중단·rollback

- migration 실패 시 이미 적용된 원장과 history를 삭제·rewind하지 않고 새 append-only forward-fix를 사용한다.
- API 이상 시 schema 호환성이 입증된 직전 승인 bundle로만 돌리거나 forward-fix한다.
- Pages 장애는 API를 rollback하지 않고 Pages deployment만 중단한다.
- PIN·PII·token·secret·provider credential은 검증 로그·Issue·PR에 남기지 않는다.

## 7. Closure checklist

- [x] PR #219 `dev` 통합 — `dev@9c197ad12ed5cb45db0b451f69f9f91053b139d7`
- [x] release branch에 `main@a12595edf68644b94215c4792e0d3aadd64772c6` 이력 결합
- [x] 73-migration manifest·Pages 0.4.0/120/130 source gate 작성
- [x] production 56→73 upgrade 회귀 PASS
- [x] 전체 application/Edge/Python/DB/concurrency PASS
- [x] required CI PASS
- [x] exact-head QA 96점, P0/P1=0
- [x] `release/v0.4.0 → main` 병합 — `main@80f935016d5581d500136fba29c206f6ee797bc0`
- [x] production 57~73 migration 적용
- [x] production `api` v17, Health/OpenAPI 0.4.0 / 120 / 130
- [x] GitHub Pages run `35481531782`, portal/OpenAPI/manifest smoke
- [ ] 보호 API 역할별 hosted read 재검증
- [ ] 안전 fixture 기반 예약·PIN mutation smoke — `SKIPPED_WITH_REASON=NO_SAFE_PRODUCTION_MUTATION_FIXTURE`
