# #548 지연 예약 등록과 실제 입실 상태

상태: 개발 후보. 운영 배포·720호 데이터 복구 완료가 아니다.

## 사용자 결정과 원인

2026-11-01 사용자는 16:00 이후 당일 예약과 누락한 전날 예약의 지연 입력을 허용했다.
기존 `create_reservation_v2`는 과거 시작 시각을 거부하지 않는다. 최소 1박, 기간 겹침,
현재 권한·객실 version·멱등성은 그대로 검사한다. 등록 시각을 입실 예정 시각으로 바꾸지 않는다.
예약 저장 뒤 다른 객실까지 처리하는 전체 전환 worker를 호출하지 않는다.

720호는 10/31 15:29 등록·16:00 입실 예정이므로 과거 등록 사례 자체는 아니다.
읽기 전용 조사에서 예약 준비 의무 pending, 실제 입실 없음, 11/1 11:00 예정 퇴실만 확인했다.
등록 성공과 실제 입실·청소 승인 완료는 구분해야 한다. 일반 카드의 READY 판정과
실제 체크인 준비 조건이 달랐던 부분을 아래 읽기 후보에서 보완한다.

## API / Swagger 후보

기존 `GET /v1/rooms` 및 `GET /v1/rooms/{roomId}`에 nullable `arrival`을 추가한다.
Fastify와 Edge는 동일 parser를 사용하며 새 RPC를 호출한다.

| 필드 | 의미 |
|---|---|
| status=NONE | 해당 LIVE 카드에 활성 예약 없음 |
| SCHEDULED | 이 객실의 입실 예정 시각 전 |
| CHECKIN_PENDING | 입실 시각 경과·실제 입실 처리 없음 |
| CHECKED_IN | 실제 입실한 예약의 현재 객실 구간 |
| ROOM_MOVE_PENDING | 이미 입실한 예약이 앞으로 이동할 객실 |
| checkInReady | 당일/지난 시작 시각의 미입실 예약 준비 여부, 적용 대상 외 null |
| reasonCodes | 실제 체크인과 같은 준비 검사 사유, 미평가 null, 준비 완료 [] |
| actualCheckInAt | 원 예약의 실제 입실 처리 시각; 미래 이동 대상의 도착 시각 아님 |
| recordedAt | 원 예약을 실제 등록한 시각 |

과거·미래 날짜 projection의 `arrival`은 null이다. 현재 준비 행으로 과거 준비 상태를
추론하지 않는다. 이미 종료·취소된 예약의 이력은 기존 예약 목록/상세에서 조회한다.
기존 `occupied`/`reservationLifecycle`의 일정 기반 의미와 이력은 바꾸지 않는다.

당일 미입실의 준비 조건이 남아 있으면 `allocationReady=false`와 정확한 `readinessStatus`를
반환한다. 원 카드의 `primaryDisplayStatus`, `cleaningRequired`, `readinessReasonCodes`는
기존 축이므로 미입실 안내는 `arrival.status`와 `arrival.reasonCodes`를 우선 사용한다.
예: `CHECKIN_PENDING + CLEANING_REQUIRED` → ‘입실 대기 · 준비 승인 필요’.
오래된 API에서 arrival가 없거나 null이면 실제 입실 여부를 추정하지 않는다.

## 프런트 #290 인계

검토 snapshot: makee-ham/room-management-system main9c86a044.
`liveQuickCellMarkup`의 과거 날짜 ‘지난 날짜 · 조회만 가능’ 잠금을 제거하고 서버 검증을 사용한다.
16:00 이후 당일 입력과 어제 날짜 입력을 검사한다. 데모 함수만 수정하고 live 연동 완료로
표시하지 않는다. 예약·입실·준비 상태를 별도 표시하며 ROOM_MOVE_PENDING을 투숙 중으로
표시하지 않는다. 프런트 소스는 프런트 측 담당이며 이 백엔드 PR에 수정하지 않는다.

## 검증과 배포

- Node 서비스 합성 검사는 15:59/16:00/16:01, 전날 시작·미래 종료, 종료 시각도 지난 기록,
  종료 미정 입력을 실제 서비스에 전달해 일정과 등록 시각 보존, 단일 create RPC 호출을 검사한다.
  실제 SQL 저장 성공 증거와 구분한다.
- 독립 소스 QA에서 미래 이동 오표시와 parser 불변식 보완 후 합성14/관련60 PASS.
- 최종 Node 전체 215파일/5,699건 PASS (`npm test -- --maxWorkers=2 --reporter=dot`).
  typecheck/build/lint, manifest143, 두 OpenAPI 계약 검사, secrets/diff 검사 PASS.
  Edge 전체 PASS, 실제 후보 포함 번들 19,982,293 bytes. 실제 DB 검증과 구분한다.
- `supabase/tests/room_arrival_readiness.sql`은 최종 승인된 격리 DB gate용 후보이며 NOT RUN.
- 마이그레이션 `20261101104125_room_arrival_readiness_projection.sql`은 읽기 함수1개만 추가.
  기존 함수·업무 데이터·예약 시각·실제 입실·준비 승인·Auth·PIN을 변경하지 않는다.
- 로컬/CI/운영 migration과 전체 DB 검증은 실행 전 사용자 별도 승인 필요. 이번에 실행하지 않았다.
- 배포 순서: 승인된 DB 검증 → 필수 CI/리뷰/릴리스 → 별도 승인 운영 함수 적용 → API → 프런트 연동/UAT.
  API만 먼저 배포하면 새 RPC가 없어 조회가 실패하므로 금지한다.
- rollback: API를 이전 코드로 복귀하면 기존 RPC로 읽는다. 새 읽기 함수는 데이터 변환이 없으며
  운영에서 임의 삭제하지 않는다. 실제720호 이력을 승인 없이 backfill하지 않는다.
