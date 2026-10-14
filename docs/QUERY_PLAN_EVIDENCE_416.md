# #416 조회 계획 점검 — 합성 component 및 실제 로컬 RPC 근거

## 2026-10-11 최신 통합 상태

PR #420은 최신 dev(#444 포함, dev113 소스)에 통합해 `de15bbe`로 squash 병합했다.
필수 application/migration(manifest-only) CI run38063617037 PASS, 실제 DB NOT RUN.
후속 [객실 issue count 후보](./ROOM_BOARD_ISSUE_COUNTS_416.md)는 별도 dev114 소스이며 미배포다.
아래 2026-10-09의
111개 migration 기준 실측은 **과거 기준선**이며 최신 스키마 재검증 결과가 아니다.
두 effective 정렬 인덱스는 이미 migration112에 있으므로 다시 추가하지 않는다.
현재 실제 RPC 실행기의 111 history/본문 fingerprint gate는 그대로 보존한다.
113 환경에서 실행되도록 조건을 느슨하게 바꾸거나 과거 실행값을 새 PASS로 사용하지 않는다.

이번 갱신은 문서 충돌 해결·최신 application/manifest 및 합성 source 검사만 수행한다.
DB benchmark/DDL/migration/reset은 실행하지 않는다. 실제 DB 실행 필요 시 사전 승인을 받는다.
남은 범위는 객실당 issue_count/blocking_issue_count의 중복 조회와 주급 반복 집계다.
먼저 경계/응답 동등성 후보·비교 fixture를 준비하고, 최종 통합 DB 검증에서 실제 계획과
읽기/쓰기 비용을 측정한다. 이 PR은 진단 근거 통합이지 #416 전체 구현 완료가 아니다.

최신 통합 검증: `ci:quality` 117파일/2,967 tests·typecheck/build PASS,
독립 합성2파일/46 PASS, manifest113 소스/해시 PASS, diff check PASS.
이 회차의 실제 DB/benchmark/SQL/경합/운영 검증은 NOT RUN이다.

## 2026-10-09 과거 측정 기록

2026-10-09, `dev@3e91d88` 기준. **진단 도구·근거만 추가**하며 운영 API/DB/index/migration을
영속 변경하지 않는다. 2차 실제-table 실험도 로컬 transaction 안에서만 수행하고 rollback한다.
#416 전체 완료가 아니며 실제 적용 전 아래 후속 검증을 수행한다.

## 실행과 보안 경계

```text
node scripts/benchmark-query-plans.mjs
```

Docker Safe Start 규칙을 먼저 따른다. 실행기는 Docker를 시작하지 않으며, default context의
local endpoint, 정확한 Supabase container/label/port를 확인하고 container 내부 PostgreSQL
Unix socket으로만 접속한다. 원격 URL/비밀번호/CLI 인자는 받지 않고 Docker/Supabase 대상
override를 거부한다. stdin의 고정 SQL만 실행하며 raw 오류·SQL/filter/행은 출력하지 않는다.

고정된 합성 UUID·시각·정수값만 session-local 임시 테이블에 만든다. 후보 index도 임시
테이블에만 생성하고 최종 rollback한다. 앱 public/private/auth table·함수·RLS·원장·migration
history를 읽거나 변경하지 않으며 운영 PIN 원문도 필요 없다. 두 source migration의
event predicate/order와 기존 recorded index 선언을 확인하되, 설치된 DB 함수 전체 fingerprint
검증이나 향후 migration 변경 감지는 아니다. 현재 운영 실행계획을 수집했다고 해석하지 않는다.

## 확인한 정렬 불일치

- `private.room_board_candle_count_at`: room + effective_at 상한, effective_at/recorded_at/id DESC.
- `private.room_board_pin_sync_status_at`: 같은 최신-event 선택 구조.
- 기존 두 테이블의 room index: `(room_id, recorded_at DESC)`.
- 비교 후보: `(room_id, effective_at DESC, recorded_at DESC, id DESC)`.
- LIVE PIN은 후속 compatibility migration에서 `current_pin_sync_status`로 분기한다.
  따라서 이번 결과를 LIVE PIN 또는 객실 현황 전체의 성능 개선이라고 부르지 않는다.

기존 recorded index는 다른 current/timeline/trigger 접근에도 사용되므로 삭제 후보로
자동 지정하지 않는다. `effective_at`을 `recorded_at`으로 바꿔 과거 상태 의미를 바꾸지도 않는다.

## 실제 실행 결과

로컬 Docker PostgreSQL 17.6, 121 합성 객실, 객실당 1/100/1,000개 이벤트.
before/middle/latest 평가 시점 × 기존/후보 × warm-up 후 3회 = **54회 EXPLAIN ANALYZE/BUFFERS**.
동일 시각/기록 시각 tie와 역순 기록을 포함하며, mode별 전체121행의 ordered 결과 해시를
비교해 같음을 확인했다. 아래는 마지막 실행의 latest 시점 3회 중앙값이다.

| 객실당 이력 | 총 이력 | 기존 ms | 후보 ms | 기존/후보 local buffer 접근 | 추가 index bytes |
| --- | --- | --- | --- | --- | --- |
| 1 | 121 | 0.819 | 0.817 | 243 / 243 | 16,384 |
| 100 | 12,100 | 5.336 | 0.283 | 12,356 / 364 | 835,584 |
| 1,000 | 121,000 | 157.783 | 0.306 | 121,351 / 485 | 8,224,768 |

buffer는 대표 두 번째 sample의 root local hit+read 합이며 하위 node를 중복 합산하지 않는다.
1건/객실에서는 후보 index가 사용되지 않았고 더 빠르다는 근거도 없다. 100/1,000에서는
후보 index가 선택되어 per-room 탐색 비용이 줄었다. `sortNodes`는 최종 room 정렬도 포함하므로
값이1이라는 이유만으로 event 내부 sort가 남았다고 판단하지 않는다.

이 수치는 **축소된 임시 테이블의 최신-event 부분 쿼리**만 측정한다. 실제 table 폭·FK·trigger·
RLS·SECURITY DEFINER 호출 비용·전체 projection/HTTP·provider·네트워크·동시 부하는 제외됐다.
temp local buffers와 fixture 배치는 실제 shared-cache/물리 데이터 분포와 다르다.
1,000건 baseline에는 local read가 발생해 cache 효과도 포함된다. 실행 순서는 기존→후보이고
둘 다 별도 warm-up하지만 장비/캐시 편향을 제거한 비교 실험은 아니다. 운영 개선 배율·p95로
외삽하거나 위 수치를 테스트 통과 임계치로 고정하지 않는다.

추가 공간은 한 축소 event table의 한 index이며 촛불+PIN 운영 합계가 아니다.
index 유지에 따른 INSERT 지연·WAL·lock·쓰기 증폭은 아직 측정하지 않았다.

## 주급·중복 계산의 source 점검

| 항목 | 확인한 근거 | 다음 검증 |
| --- | --- | --- |
| 객실 issue_count | 날짜 projection이 일반/차단 이슈 수를 각각 요청 | 전체 함수의 실제 중첩 계획에서 반복 scan 확인 후 FILTER 집계 비교 |
| 주급 workflow 날짜 | 완료 KST 날짜와 target effective 날짜의 coalesce가 두 relation에 걸침 | 완료/미완료 분리 candidate와 날짜·자정·주 경계·NULL 동등성 및 실제 plans 비교 |
| 송금 표시 summary | private remittance basis가 project_payroll_cycle_bounded 호출 | #414 batch 후에도 남는 메이드별 반복 집계 비용 계측 |

위 세 항목은 정적 후보이지 실측 병목 확정이 아니다. 특히 두 table을 참조하는 coalesce를
한 table의 단순 expression index로 해결한다고 가정하지 않는다. 과거 earning snapshot,
현장 완료 KST 날짜, current pointer와 CAS/송금 표시 정책을 변경하지 않는다.

## 검증 및 후속 순서

- PASS: 합성 component 54회, 결과 동등성9조합, remote override/출력 allowlist 등 unit20.
- PASS: `npm run ci:quality` — secret/OpenAPI/lint/typecheck、107파일/2,686건、build.
  lint는 기존 info19이며 새 warning/error는 없다.
- PASS: 독립 QA가 unit20 및 local PG17.6 component54를 직접 재실행했다.
  로컬/socket·stdin·timeout·임시 객체·rollback·aggregate-only 검토, 차단 결함 없음.
- NOT RUN: 전체 실제 room-board/payroll RPC 역할별·경합 계획, index INSERT/WAL 비용,
  운영 aggregate 통계·UAT, fresh migration 적용. schema/RLS/migration 변경0.
- 첫 도구 실행은 생성 전 index의 regclass 해석 때문에 실패했다. 후보 생성 뒤에만 size를
  읽도록 고친 후 실제54회 재실행 PASS. 타입 선언도 추가하여 TypeScript 검사를 유지했다.
- 최종 fixture에서 effective/recorded 완전 동률을 보장하고 SQL assertion으로 확인했다.
  위 표는 이 보완 뒤 재실행 값이며, 이전 fixture의 수치를 최종 결과로 재사용하지 않는다.

위 NOT RUN은 1차 시점이며 실제 RPC/쓰기 후속 결과는 아래 2차를 따른다.
근거가 유지될 때만 후속 append migration을 만들고 기존 인덱스 유지/중복을 검토한다.
주급 날짜·summary와 issue_count도 후속 측정하며 #416은 계속 열어둔다.
이번 PR은 도구/문서뿐이어서 서비스 배포·DB rollback이 필요하지 않다.

Supabase/Postgres 성능 스킬에 따라 EXPLAIN 근거와 과잉 인덱스 비용을 함께 검토했다.
[공식 query optimization 가이드](https://supabase.com/docs/guides/database/query-optimization).

## 2차 — 실제 로컬 room-board RPC 및 이벤트 쓰기 비용

```text
node scripts/benchmark-room-board.mjs
```

동일한 local Docker/socket 제한을 재사용한다. 121개 객실, migration history111개,
profiles/Auth users·sessions/예약/두 event table이 빈 상태, board 및 두 historical helper의
설치된 본문 MD5 일치를 요구한다. **모든 앱 테이블이 빈 상태임을 전수 검증하는 것은 아니다.**
history 개수/3함수 본문 fingerprint는 전체 schema/의존 함수·ACL fingerprint도 아니다.
변경된 설치본은 이 기준을 명시적으로 재검토해야 하며 drift를 자동 승인하지 않는다.

합성 관리자·메이드와 세션, 촛불/PIN 상태 이벤트 각12,100건을 실제 table에 transaction 내
삽입한다. FK/check/촛불 기록 순서 trigger를 끄지 않는다. PIN 원문·키·실제 사용자 자료는
필요 없다. 후보 인덱스 두 개는 transaction 안에서만 추가한다. 실제 RPC는 `service_role`로
호출하며 관리자 허용, 메이드 `ADMIN_REQUIRED`, 없는 세션 `SESSION_REVOKED`를 전후 확인한다.
전체 RLS/역할/상태/만료·경합 행렬을 재검증한 것은 아니다.

한 DO statement의 같은 `statement_timestamp`에서 과거2일/오늘/미래1일을 조회한다.
서버 시각을 포함한 **전체121행 DTO**를 ID순으로 해시 비교하여 세 경우 모두 동일했다.
warm-up 후3회 × 날짜3 × index모드2 = **18 read samples**.
Function Scan의 시간·root buffer를 기록한다. 중첩 함수 각각의 내부 실행계획이나 특정
index 사용 여부를 전체 RPC EXPLAIN으로 확인했다고 주장하지 않는다.

2026-10-09 로컬 PG17.6, 마지막 부모 실행 3회 중앙값:

| 실제 RPC 평가 날짜 | 기존 ms | 후보 ms | 기존/후보 shared buffer 접근 |
| --- | --- | --- | --- |
| 과거2일 | 71.421 | 23.039 | 87,699 / 3,677 |
| 오늘(LIVE) | 65.265 | 29.064 | 51,360 / 3,300 |
| 미래1일 | 81.761 | 26.064 | 87,693 / 3,663 |

각 event table에121건씩 INSERT RETURNING을 실행해 warm-up 후3회 × table2 × mode2 =
**12 write samples**를 추가했다. 실제 제약/trigger 포함 시간이며 command RPC의 actor/CAS/
idempotency 비용은 아니다. 매 sample의 subtransaction을 의도된 SQLSTATE로 rollback하여
가시 행 수 각12,100건 유지도 확인했다. 다른 SQL 오류는 삼키지 않는다.

| 121건 INSERT | 기존/후보 ms | 기존/후보 executor WAL bytes | 기존/후보 trigger ms |
| --- | --- | --- | --- |
| 촛불 상태 이벤트 | 5.187 / 6.324 | 44,572 / 57,523 | 4.125 / 4.793 |
| PIN 동기화 상태 이벤트(원문 없음) | 1.942 / 2.948 | 48,519 / 57,052 | 1.257 / 1.681 |

WAL은 EXPLAIN root의 executor counter이며 cluster LSN 차이·전체 background/commit WAL이
아니다. trigger 시간은 별도 관찰값이며 전체 Execution Time에 다시 더하지 않는다.
두 추가 index 공간 합은 **1,671,168 bytes**(각event12,100건 기준)였다.

판정: 이 합성 workload에서 조회 비용 감소가 재현됐지만 추가 공간·INSERT/WAL 비용도
늘었다. 따라서 두 effective 정렬 인덱스는 **후속 append migration 후보**로 유지한다.
현재 recorded index는 current/trigger 경로에도 사용하므로 그대로 둔다. latency 임계값을
테스트에 고정하거나 운영 p95/개선 배율로 외삽하지 않는다.

제한: 예약/점유/업무 이력은 빈 상태여서 전체 room-board의 모든 경로를 부하 생성하지는
않았다. 기존→후보 고정 순서, warm cache, 앞선 write의 dead tuple·page 배치와 ANALYZE가
결과에 영향을 준다. 최종 rollback 및 사후 확인으로 합성 Auth/profile/session/event와
후보 index의 가시 잔존은 없지만 **WAL·dead tuple·물리 공간·통계 영향까지 되돌리지는 않는다.**
실험 timeout/에러는 성공으로 출력하지 않는다. 운영·recovery 프로젝트에서는 실행하지 않는다.

- PASS: 부모 실제18read+12write, 전체DTO 동등성3조합 및 권한 거부4회, 최종 정리 확인.
- PASS: 독립 QA 별도 실제30samples 및 신규26+기존20 단위 검증, P0/P1/P2 없음.
- PASS: `npm run ci:quality` — secrets/OpenAPI/lint/typecheck、108파일/2,712건、build.
  lint는 기존 info19이며 새 warning/error는 없다. 신규 unit26 포함.
- NOT RUN: HTTP/프런트 UAT, 전체 역할/RLS·동시성, 주급 실행계획, 신규 migration 적용.
- 변경 없음: 운영 API/Swagger 계약, migration 파일·원격 DB·배포·Auth/PIN 원문.

다음 순서: candidate index의 append migration/최종 DB 회귀 → #414/#415와 개발 통합 →
릴리스 범위 및 프런트 인계 갱신. 주급 날짜·summary와 중복 issue_count는 #416 잔여 범위다.
