# 배정 Preview API — #29 feature 계약

기준 integration은 `dev@a98e2ccc0bf86d760b144691aacb0807215ca09e`다. 이 문서는 feature source
계약이며 production/recovery에 적용하거나 Edge/Pages/Cron을 배포했다는 의미가 아니다.
HTTP 기계 판독 정본은 source OpenAPI, 운영 상태 정본은 [API 상태표](./API_STATUS_MATRIX.md)다.

## 권한과 경로

| 경로 | 의미 | 업무 write |
|---|---|---|
| `POST /v1/assignments/preview` | 오늘/내일 배정 초안 계산 | 없음 |
| `GET /v1/assignment-preview/duration-policy` | 현재 confirmed 정책 또는 null | 없음 |
| `POST /v1/assignment-preview/duration-policy` | 네 타입 시간의 새 version 확정 | 정책 + audit + receipt |

세 operation 모두 최신 active business admin, 비밀번호 변경 완료, 유효 Auth/session을 요구한다.
developer/maid는 업무 권한을 상속하지 않는다. DB에서도 exact admin을 다시 검증한다. Fastify
동일 route와 Python 관리자 업무 UI는 이번 범위 밖이다.

Preview body는 `serviceDate`(KST 오늘/내일)와 선택 `previewSeed`만 허용한다. Seed는
1~128자의 영문·숫자·`_`·`-`이며 생략하면 Edge가 UUID를 생성해 반환한다. Preview에 멱등성
receipt를 만들지 않으며 저장을 자동 수행하지 않는다.

## 운영 소요시간 입력

정책 확정 body는 `expectedVersion`, `standardMinutes`, `premiumMinutes`,
`oceanPremiumMinutes`, `oceanFamilyMinutes`다. 네 값 모두 양수 PostgreSQL integer 범위이며
부분 설정은 거부한다. 최초 expectedVersion은 0, 이후 현재 version을 사용한다. POST에는
기존 `Idempotency-Key` 계약을 적용한다. 같은 scope/hash 재시도는 replay, 다른 hash는 conflict다.

`draft | confirmed | retired`를 구분하고 confirmed 정책은 최대 한 건이다. 새 확정은 이전 값을
수정하지 않고 retired로 전환 후 새 version을 append한다. 원장 DELETE와 직접 Data API DML은
금지된다. 확정 event는 정책 version/status/네 duration 값만 safe audit에 제공한다.

Fresh DB의 confirmed 0건은 정상이다. 이 경우 preview는
`ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED`, `decisionReady=false`, 빈 제안을 반환한다.
55/65/70/80분은 데모이며 실제 운영 입력이 아니다. Template duration·평균·60분 등의 fallback도 없다.
이번 PR에서는 실제 운영 정책을 확정하지 않는다.

## Snapshot과 고정 부하

DB의 STABLE RPC 한 번으로 정책, active/current availability, target/schedule/source identity,
기존 assignment/attempt를 읽는다. SQL이 planned/materialized checkout, stayover 점유 구간,
additional 예약 overlap, reclean 원 maid/source를 검증한다. Pure TypeScript optimizer는 I/O를
하지 않고 이 snapshot만 계산한다.

- 유효한 당일 미배정 target만 신규 proposal 후보다.
- draft/notified와 진행 업무는 기존 담당·sequence를 유지하는 고정 fee/time 부하다.
- 실제 진행 중인 attempt의 남은 시간은 정책 duration으로 추정하지 않는다. 불확실한 메이드의
  추가 배정은 blocked로 남긴다. 미래 날짜의 scheduled 업무를 오늘 업무로 당겨 넣지 않는다.
- reclean은 원 maid만 후보이며 그 maid가 inactive/미제출/불가능이면 미배정으로 남긴다.
- planned checkout은 계획만 가능하다. Attempt/PIN/현장 실행 활성화는 하지 않는다.

`planningAt`은 DB snapshot 시각이며 오늘의 신규 수행을 과거에 시작시키지 않는다. 순차 시작은
그 시각과 이전 업무 완료 cursor 및 target `availableFrom` 중 늦은 시각이다. Confirmed duration을
더한 종료가 `dueAt`을 넘으면 제안하지 않는다. `dueAt=null`은 null 그대로 보존하며 임의 마감이나
09~18시 shift/휴게시간/객실 수 상한을 만들지 않는다. 서비스 날짜를 넘기는 신규 수행은 후속 현장
계약 확정 전 보류한다.

## 비교와 재현성

비교 순서는 완료 가능한 신규 target 수 최대 → 고정+신규 기본요금 spread 최소 → 전체 금액 편차
최소 → 엘리베이터 구역 전환 최소 → 호수 차이 합 최소 → seed에 따른 최종 동률 선택이다.
편차는 `Σ(n × maidTotalFee − totalFee)^2` 정수로 계산하고 JSON에는 정수 문자열로 반환한다.

Bounded multi-start greedy와 제한된 move/swap/reorder 개선을 사용한다. 전역 최적해 증명이나
전수조합 탐색은 아니다. Seed는 탐색 순서를 바꾸지 않고 같은 최상위 score 집합의 마지막 동률에만
쓰므로 동일 snapshot의 다른 seed가 상위 목적함수 값을 나쁘게 만들지 않는다. 입력이 바뀌지 않으면
같은 seed의 결과는 같다.

최대 신규 후보 121/계산 대상 maid 20은 자원 보호 상한이지 숙소 인원 정책이 아니다. 고정 업무까지
포함한 snapshot target은 최대 242, 비활성·미제출 이력을 포함한 maid snapshot은 최대 1,000으로
별도 제한한다. 탐색은 4개 시작 순서, 최대 3회 개선 pass, 최대 100,000번 score 평가다. 상한이나 계산
budget을 초과하면 `ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED`로 전체 요청을 fail-closed하며 부분 결과를
`decisionReady=true`로 반환하지 않는다. 실제 탐색 상한은 core의 `PREVIEW_LIMITS`가 정본이다.
Target별 active 예약 schedule도 최대 122건이며 DB는 123번째 sentinel이 있으면 제한 오류로
거부한다. 예약 이력을 잘라서 안전하다고 오판하지 않는다.

Fingerprint는 정렬된 snapshot의 SHA-256이다. 정책 version/시간, planningAt, target assignment
version, source schedule identity, fixed assignment/attempt, 후보 status/current availability를
포함하고 seed는 제외한다. 별도 HTTP 호출은 DB snapshot 시각·상태가 달라 fingerprint가 달라질 수
있다. Fingerprint는 DB lock이나 저장 허가가 아니다.

## 프론트 연결과 보안

`fixedAssignments`, `proposedAssignments`, `remainingUnassignedTargets`, `blockedTargets`,
`maidSummaries`, `objectiveScore`를 구분해서 표시한다. Proposal의 expected assignment/availability
version과 sequence를 보존하되, 사용자가 확인·편집한 뒤 기존 #25 draft command와 #26 commit을
별도로 호출한다. 저장 시 conflict면 snapshot을 다시 읽고 사용자에게 변경을 보여 준다.

응답에는 room/maid/fee/schedule/CAS 등 승인 필드만 포함하고 raw domain snapshot, requestHash,
PIN, guest name, token, ciphertext를 제공하지 않는다. 알 수 없는 DB 오류는
`ASSIGNMENT_PREVIEW_FAILED`로 redaction한다. 성공 preview는 audit/receipt/outbox를 쓰지 않는다.
권한거부는 기존 bounded security activity 계약을 유지한다.

`additional`의 마감 없는 작업도 고정 부하 때문에 실제 시작이 늦어질 수 있다. 원 availableFrom에서의
예약 overlap 검사만 신뢰하지 않고 실제 simulated `[start, finish)` 구간을 active 예약 점유 구간과
다시 비교한다. 이 안전한 예약 schedule snapshot도 fingerprint에 포함하며 고객명은 포함하지 않는다.

## 검증 경계

SQL 회귀는 preview 전후 target/assignment/attempt/change request/availability/notification/outbox/
audit/command receipt/reservation/obligation/schedule revision을 비교한다. Optimizer 테스트는
동일 입력 비변경, 목적함수 반례, 고정 부하, reclean, capacity, seed/fingerprint 및 자원 상한을
검사한다. 운영 smoke나 실제 정책 확정은 source 테스트로 대체해 PASS 표시하지 않는다.
