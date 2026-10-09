# #416 조회 계획 점검 — 1차 합성 근거

2026-10-09, `dev@3e91d88` 기준. **진단 도구·근거만 추가**하며 운영 API/DB/index/migration을
변경하지 않는다. #416 전체 완료가 아니며 실제 적용 전 아래 후속 검증을 수행한다.

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

다음은 최종 스키마의 local synthetic 실제 RPC/역할별 계획과 쓰기 비용을 검증한다.
근거가 유지될 때만 후속 append migration을 만들고 기존 인덱스 유지/중복을 검토한다.
주급 날짜·summary와 issue_count도 같은 단계에서 측정하며 #416은 계속 열어둔다.
이번 PR은 도구/문서뿐이어서 서비스 배포·DB rollback이 필요하지 않다.

Supabase/Postgres 성능 스킬에 따라 EXPLAIN 근거와 과잉 인덱스 비용을 함께 검토했다.
[공식 query optimization 가이드](https://supabase.com/docs/guides/database/query-optimization).
