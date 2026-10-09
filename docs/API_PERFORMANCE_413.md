# 전체 처리 속도 개선 — #413

2026-10-09 사용자 승인 순서: 공통 계측 → 가능일·주급 요청 감소 → 배정 조회 통합 → 느린 SQL 개선 → 사진 썸네일.
현재 이 문서의 공통 계측은 source 후보이며 운영 적용이나 실제 속도 개선 완료를 뜻하지 않는다.

## 1차 구현: 공통 handler 시간

Fastify와 Edge에서 성공한 업무 API에 `Server-Timing: api_total;dur=<ms>`를 추가한다.
값은 소수점 한 자리의 0..3,600,000 ms 숫자이며 식별자/URL/SQL/오류/토큰/PIN/사진을 포함하지 않는다.
기존 사진 timing, Content-Disposition, Cache-Control, CORS Origin/Vary와 body를 보존한다.
허용 Origin의 브라우저는 `response.headers.get('Server-Timing')`으로 읽을 수 있다.
Timing-Allow-Origin이나 공개/영속 캐시는 추가하지 않는다.

적용 대상은 2xx 성공 응답 중 `/v1/` 아래 다음 경로 계열이다:
rooms, room-types, reservations, assignments, availability, payroll, cleaning-history,
work-history, inspections, attempts, submissions, notifications, complaints,
cleaning-templates, photos, photo-uploads. 정확한 경로 구분자를 검사하며 HEAD/OPTIONS는 제외한다.
계정/인증/복구/개발자 진단/health/docs 및 오류 응답에는 공통 헤더를 추가하지 않는다.
공통 middleware는 인증을 승인하지 않으며 기존 route의 인증/역할/세션/CAS 검증을 그대로 수행한다.

측정 의미:

- Fastify: onRequest부터 응답 직전 onSend까지. Edge: handler 호출부터 Response 생성까지.
- 요청 처리 중 인증/DB 대기는 포함하지만 단계별 분해나 DB 호출 수는 제공하지 않는다.
- 서버 플랫폼의 handler 이전 대기·콜드 시작 전체, 네트워크 전송 완료, 브라우저 준비/렌더링 시간과 다르다.
- Fastify/Edge는 body 수신·직렬화 경계가 다르므로 동일 환경·동일 입력끼리 비교한다.
- Body를 읽거나 복제하지 않고 스트림을 그대로 전달한다. 사진의 photo_total과 합산하지 않는다.
- 요청별 로컬 시각만 사용하고 global mutable collector/사용자 데이터 로그를 만들지 않는다.

## 이후 순서와 인계

| 순서 | 작업 | 추적 | 상태 |
| --- | --- | --- | --- |
| 1 | 공통 handler timing와 회귀 검사 | #413 | source 후보 |
| 2 | 가능일 관리자 전체 조회 활용·첫 화면 핵심 데이터 우선 표시 | frontend #207 | 프런트 인계 |
| 3 | 주급 marker 일괄 반환·상세 반복 집계 감소 | #414 | 설계/계측 후 구현 |
| 4 | 배정 카드 hydration의 다중 DB 왕복 통합 | #415 | 설계/계측 후 구현 |
| 5 | 객실/주급 실행계획과 인덱스·반복 계산 | #416 | 실행계획 미측정 |
| 6 | private 썸네일·안전한 사진 병렬 계약 | #411 | 후속 |

사진 선택 snapshot/단계 계측 #409/PR412는 별도 후보이며 이 PR에 섞지 않는다.
과대 배정 확정의 전체 잠금 전 상한 #342와 중복 구현하지 않는다.

## 프런트 확인 결과와 주의사항

정본 repo dev `314f0d74288b8017ec3a902cc30cf149e77e550a`의 사진·조회 경로를 읽기 전용 조사했다.
제품 가이드의 전체 정책 snapshot을 이 commit으로 교체하지 않는다.

- `loadLiveAvailability`: 관리자에서 메이드별 GET. 기존 backend는 maidProfileId 생략 시 admin 전체 조회를 지원한다. 메이드 self/RLS와 UI의 departed 제외를 보존하고 전체 응답 완전성/서버 row 상한을 확인한 뒤 사용한다.
- `loadLivePayroll`: 페이지 전체 수집 뒤 marker를 순차 조회한다. 첫 페이지 우선 표시와 marker batch 계약이 후보다. 금액 불일치/세대 검사나 PAID 원장을 없애지 않는다.
- `loadLiveViewData`: 여러 task 뒤 최종 surface 갱신 경로가 있다. 일부 loader는 자체 render도 하므로 실제 화면을 측정하고 필요한 영역만 분리한다.
- 기존 coalescing/freshness/authGeneration/loadRevision이 있으므로 중복 구현하지 않는다. 로그인·권한 변경 시 폐기 규칙을 보존한다.

## 성능 판정 기준

변경 전후 동일한 합성 데이터·동일 역할·동일 클라이언트/네트워크 조건에서 cold/warm을 분리한다.
대상 규모 1/10/20명, 배정 1/100/1000건, 사진 1/5/20장으로 요청 수·첫 의미있는 표시·전체 표시·응답 크기·오류/409 비율 및 p50/p95를 기록한다.
운영 표본과 충분한 반복 측정 없이 개선율을 선언하지 않는다. 이후 DB 구간은 고정 라벨의 숫자 duration/count만 계측한다.
SQL은 로컬 합성 자료의 EXPLAIN(ANALYZE,BUFFERS)로 확인하며 운영 mutation을 EXPLAIN ANALYZE하지 않는다.
이번 단계는 DB/migration 변경 없음. 필요한 SQL 변경은 개발에서 검증하고 승인된 최종 릴리스에서만 운영 반영한다.

스킬 적용: 격리된 기존 worktree를 재사용했고 Supabase 지침에 따라 live 권한/세션/RLS를 성능 개선을 이유로 생략하지 않았다.

## 실제 검증

2026-10-09: `npm run ci:quality` PASS (2689 tests, secrets/OpenAPI/lint/typecheck/build),
`npm run edge:check` PASS (493 tests + candidate runtime 65, bundle 19,199,664 bytes),
독립 QA 96 tests 및 생성 원본 일치/diff 검사 PASS. 기존 clean baseline 2666 tests PASS.
DB 검증/운영 성능 실측/Python 소비자 로컬 검증은 NOT RUN (DB/API 본문 계약 변경 없음).
필수 GitHub CI·보호 규칙 확인과 운영 승격은 별도다.
