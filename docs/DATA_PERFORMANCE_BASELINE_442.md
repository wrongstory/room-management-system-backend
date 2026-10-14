# 전 화면 데이터 성능 기준선과 개선 순서 — #442

후속 구현 후보는 [공통 인증 조회 통합](./AUTH_CONTEXT_PERFORMANCE_442.md)에 기록한다.
아래는 PR #443 당시 기준선이며, 운영 개선 결과로 재해석하지 않는다.

2026-10-10 23:24 KST 기준. 사용자: 일부 화면이 아니라 대부분 화면이 전반적으로 느림.
운영 v0.9.4/API45, 개발 기준 dev `d7db64e`.
**진단·안전 회귀 검사 단계이며 성능 개선 코드의 운영 반영 완료가 아니다.**

## 운영 읽기 전용 근거

Supabase Logs의 조회 당시 최근 24시간 중 API version45, GET/200만 추출했다.
경로의 UUID를 `:id`로 바꾼 집계만 수집하며 사용자·토큰·PIN·사진·query string을 저장하지 않는다.
아래 execution_time_ms는 플랫폼 요청 실행 시간이다. 화면 렌더링/브라우저 전송 완료,
Server-Timing의 api_total 또는 SQL 단독 시간과 동일하지 않다.
표본이 적고 같은 입력·동시 부하로 통제하지 않았으므로 SLA나 개선율 기준으로 확정하지 않는다.

| 경로 | 건수 | 중앙값(ms) | p95(ms) |
| --- | ---: | ---: | ---: |
| /v1/room-types | 12 | 481 | 573 |
| /v1/availability | 15 | 506 | 690 |
| /v1/notifications | 50 | 506 | 1,117 |
| /v1/reservations | 30 | 513 | 1,202 |
| /v1/payroll | 10 | 560 | 679 |
| /v1/auth/me | 42 | 584 | 988 |
| /v1/assignments | 47 | 597 | 1,134 |
| /v1/rooms | 34 | 683 | 1,645 |
| /v1/photos/:id/content | 253 | 1,609 | 2,026 |

같은 조건의 비사진 GET 성공은 KR/ICN→ap-northeast-2 505건(중앙값516ms),
US/SEA→us-west-2 1건이었다. 국내 요청이 전부 해외 Edge로 가는 문제라는 근거는 없다.
성공 조회와 과거 #441 500 오류를 섞지 않았다.

최근24h Data API/Auth origin_time의 별도 집계:

| 내부 경로 | 건수 | 중앙값(ms) | p95(ms) |
| --- | ---: | ---: | ---: |
| /auth/v1/user | 1,283 | 18 | 179 |
| /rest/v1/profiles | 1,368 | 18 | 204 |
| /rest/v1/rpc/is_active_auth_session | 1,283 | 15 | 56 |
| /rest/v1/rpc/get_room_board_projection | 53 | 178 | 559 |
| /rest/v1/rpc/list_payroll_cycles_page | 15 | 149 | 235 |

이 로그에는 v45 외 요청도 포함될 수 있고 개별 외부 요청과 연결하지 않았다.
서로 다른 분포의 중앙값을 더하거나 빼서 인증/네트워크 비중을 계산하지 않는다.
공통 인증 소스는 Auth getUser → profile → live session 순차 요청을 확인했다.

DB 추정 live row는 rooms121/reservations27/profiles3이며 정확한 업무 count는 아니다.
작은 테이블의 순차 스캔 횟수만으로 인덱스 누락 또는 병목이라 단정하지 않는다.
pg_stat_statements는 2026-08-25T05:23:01.485797Z 이후 누적이며 dealloc2다.
현재 릴리스만의 측정이 아니므로 과거 get_room_operational_projection 평균681~852ms를
현행 API 지연으로 오인하지 않는다. 현행 get_room_board_projection 누적79calls/평균261ms,
list_payroll_cycles_page148calls/평균85ms는 다음 정밀 점검 대상을 선정하는 근거일 뿐이다.
통계 reset/ANALYZE/VACUUM/EXPLAIN ANALYZE/DDL/업무 DML은 수행하지 않았다.

참고: [Supabase pg_stat_statements](https://supabase.com/docs/guides/database/extensions/pg_stat_statements).

## 프런트 인계 대조

프런트 dev `82bc34009abd27dea57e3e37913c5f7aa6e62529`의
`DOCS/33_DATA_PERFORMANCE_INTEGRATION.md` 및 #207/PR211을 확인했다.
이미 가능일 N회→1회, 주급 페이지별 표시·10명 CSV marker batch, 독립 홈 표시가 반영됐다.
합성20명 HTTP22→4는 실제 운영 속도 개선율이 아니다.
단건 marker fallback은 정확한 ROUTE_NOT_FOUND만 허용하며 금액 검증·권한 세대·CAS를 유지한다.
동일 요청 감소를 다시 개발하거나 프런트 미연결을 원인으로 단정하지 않는다.
프런트 코드는 수정하지 않았다. 기존 문서의 v0.9.3 표기는 이번 v0.9.4 운영 기준과 구분한다.

## 개선 순서와 승인 경계

1. **공통 인증 DB 왕복 통합(#442)**: getUser 검증을 유지하고 profile→session 순서를
   DB 내부에서 보존하는 최소 읽기 RPC를 설계한다. 최종 session snapshot/만료 시각을
   검토해야 하며 단순 STABLE wrapper로 병행화 결함을 숨기지 않는다. 공개 actor shape,
   오류 우선순위, 강제로그아웃/역할 변경, limited 경로, 무캐시를 보존한다.
   아직 이 RPC/마이그레이션을 구현·검증하지 않았다.
2. **객실 상태 반복 계산(#416)**: LIVE/과거/미래 조회의 raw_state와 issue_count 중복,
   조인 확장 뒤 helper 재평가 여부를 실행계획으로 확인한다. 현재 인덱스2개는 이미112차에
   적용됐다. 추가 인덱스만 계속 늘리지 않고 동일 결과를 한 번 계산하는 안과 비교한다.
   과거 시간·점유/청소/촛불/PIN 축을 합치지 않는다. PR420의 합성 측정 도구는 별도 미병합이다.
3. **주급 집계 통합(#414)**: HTTP batch 이후에도 남은 N DB RPC와 페이지별 summary
   반복 계산을 줄인다. 금액 전역 캐시/부분 합계 표시/PAID 원장 변경은 금지한다.
4. **배정 관계 조회(#415)**: hydration 병렬 분기는 이미 반영됐다. DB 왕복 감소가 다음
   범위이며 마지막 actor/session/ownership 재검사를 제거하지 않는다.
5. **사진 목록용 비공개 썸네일(#411)**: 현재 원본 전달 비용을 별도 최적화한다.
   권한·7일 보존·삭제 barrier를 지키며 공개 URL/캐시로 전환하지 않는다. 사진 삭제 개발은 보류다.

모든 단계에서 같은 데이터의 응답 동등성, 조회 p50/p95, DB 호출 수, 쓰기 지연·WAL,
권한 거부·CAS·멱등성·경합을 분리해 검증한다. 인증만 최적화했다고 전체 완료로 표시하지 않는다.
로컬/CI/운영 migration·DB reset·재구축은 **실행 직전마다 사용자 명시 승인**이 필요하다.
최종 통합에 전체 DB 검증1회를 모으고 중간 단계에서 반복 실행하지 않는다.
현재 운영 DB/배포/프런트·백업/복원/초기화는 변경하지 않았다.

## 독립 QA로 배제한 안

profile과 live session을 Promise.allSettled로 병행하는 후보는 P1 경합으로 **FAIL**했다.
session=true → profile 응답 대기 중 revoke → active profile 반환 시 Node/Edge 모두
성공할 수 있었다. /auth/me와 계정 목록 등 공통 인증에 의존하는 소비자에 영향이 있다.
오류 검사 순서 보존만으로 해결되지 않는다. 후보 두 파일은 원복하여 dev와 동일하다.
`tests/auth-read-order.test.ts`가 실제 Node/Edge 인증 함수를 대상으로 다음을 보호한다:

- Auth 검증 전 service-role 읽기 금지.
- 지연 profile 도중 세션 폐기 후 SESSION_REVOKED.
- inactive/upload_only/deactivation_pending 거부 및 누락 profile 우선순위.
- 성공 결과를 요청 간 캐시하지 않음.

이는 네트워크 합성 회귀 검사이며 실제 DB 경합/운영 속도 개선 증거가 아니다.
기준 전체 Node2865 PASS. 후보는 `ci:quality`(secrets/OpenAPI/lint/typecheck/Node2879/build),
112개 migration manifest, 전체 `edge:check` 및 최종 bundle19,284,587bytes PASS다.
동일 인스턴스 보완 후 Node/Edge 전체 검사를 병행했을 때 Node가 Edge 임시 테스트5개를
발견했으나 Edge 종료 정리와 충돌하여 파일 없음으로 FAIL했다(본래112파일/2879건은 PASS).
테스트 제외나 기준 완화 없이 Edge 종료 뒤 `ci:quality`를 순차 재실행해
112파일/2879건·typecheck/build까지 exit0 PASS했다. CI도 원래 두 검사를 순차 실행한다.
독립 QA는14건을 직접 재실행하고 runtime 두 파일의 dev 동일성 및 문서 경계를 확인했다.
미해결 P0/P1/P2 없음. 운영 원로그 독립 재측정과 Full DB/운영 배포는 NOT RUN이다.
