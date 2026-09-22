# 배정 Preview API — #29/#231 계약

기준 integration은 `dev@a98e2ccc0bf86d760b144691aacb0807215ca09e`다. 이 문서는 feature source
계약이며 production/recovery에 적용하거나 Edge/Pages/Cron을 배포했다는 의미가 아니다.
HTTP 기계 판독 정본은 source OpenAPI, 운영 상태 정본은 [API 상태표](./API_STATUS_MATRIX.md)다.

## 권한과 경로

| 경로 | 의미 | 업무 write |
|---|---|---|
| `POST /v1/assignments/preview` | 오늘/내일 배정 초안 계산 | 없음 |
| `GET /v1/assignment-preview/duration-policy` | 폐기 전 confirmed 정책 또는 null (deprecated) | 없음 |
| `POST /v1/assignment-preview/duration-policy` | 폐기된 호환 경로, 항상 410 | 없음 |

세 operation 모두 최신 active business admin, 비밀번호 변경 완료, 유효 Auth/session을 요구한다.
developer/maid는 업무 권한을 상속하지 않는다. DB에서도 exact admin을 다시 검증한다. Edge와
Fastify rollback adapter는 같은 세 경로, RPC, 순수 optimizer, camelCase 응답과 오류 code를 사용한다.
Python 관리자 업무 UI는 이번 범위 밖이다.

Preview body는 `serviceDate`(KST 오늘/내일)와 선택 `previewSeed`만 허용한다. Seed는
1~128자의 영문·숫자·`_`·`-`이며 생략하면 HTTP adapter가 UUID를 생성해 반환한다. Preview에 멱등성
receipt를 만들지 않으며 저장을 자동 수행하지 않는다.

## 예상시간 정책 폐기

예상시간 정책은 폐기됐다. Fresh DB에 confirmed 정책이 없어도 preview는 `decisionReady=true`이며
`durationPolicy=null`, `durationPolicyStatus=retired`, `durationPolicyRequired=false`를 반환한다.
과거 `assignment_duration_policy_versions`, template `durationMinutes`, target/attempt snapshot,
`assignment.duration_policy_confirmed` 감사 및 receipt는 삭제·재해석하지 않는다. 과거 GET은
read-only로 남지만 그 결과는 신규 preview 입력이 아니다. POST는 active business admin 확인 뒤
`ASSIGNMENT_DURATION_POLICY_RETIRED(410)`를 반환하며 새 원장·감사·receipt를 만들지 않는다.

## Snapshot과 고정 부하

DB의 STABLE RPC 한 번으로 active/current availability, target/schedule/source identity,
기존 assignment/attempt를 읽는다. SQL이 planned/materialized checkout, stayover 점유 구간,
additional 예약 overlap, reclean 원 maid/source를 검증한다. Pure TypeScript optimizer는 I/O를
하지 않고 이 snapshot만 계산한다.

- 유효한 당일 미배정 target만 신규 proposal 후보다.
- draft/notified는 기존 담당·sequence를 유지하는 고정 fee/route 부하다.
- 실제 진행 중인 attempt의 남은 시간은 정책 duration으로 추정하지 않는다. 불확실한 메이드의
  추가 배정은 blocked로 남긴다. 미래 날짜의 scheduled 업무를 오늘 업무로 당겨 넣지 않는다.
- reclean은 원 maid만 후보이며 그 maid가 inactive/미제출/불가능이면 미배정으로 남긴다.
- planned checkout은 계획만 가능하다. Attempt/PIN/현장 실행 활성화는 하지 않는다.

`planningAt`, `availableFrom`, `dueAt`은 명시된 시각 사실로 보존한다. `dueAt`이 이미 지났거나
`availableFrom >= dueAt`인 target은 거부하지만 예상 분수를 더한 종료시각이나 순차 cursor를 만들지 않는다.
수동 additional은 두 끝점이 모두 명시된 `[availableFrom,dueAt)`만 실제 예약 점유 구간과 비교한다.
`dueAt=null`은 열린 상태로 유지하고 임의 마감·1분·09~18시 shift·휴게시간·객실 수 상한을 만들지 않는다.

## 비교와 재현성

비교 순서는 배정 가능한 신규 target 수 최대 → 고정+신규 기본요금 spread 최소 → 전체 금액 편차와
기존/reclean 제약 → 엘리베이터 구역 전환 최소 → 호수 차이 합 최소 → 안정적인 ID 최종 동률 선택이다.
편차는 `Σ(n × maidTotalFee − totalFee)^2` 정수로 계산하고 JSON에는 정수 문자열로 반환한다.

Bounded multi-start greedy와 제한된 move/swap/reorder 개선을 사용한다. 전역 최적해 증명이나
전수조합 탐색은 아니다. Seed는 과거 client와 응답 상관관계를 위한 호환 필드일 뿐 탐색·점수·동률
선택에 쓰지 않는다. 같은 snapshot은 seed와 무관하게 같은 결과다.

최대 신규 후보 121/계산 대상 maid 20은 자원 보호 상한이지 숙소 인원 정책이 아니다. 고정 업무까지
포함한 snapshot target은 최대 242, 비활성·미제출 이력을 포함한 maid snapshot은 최대 1,000으로
별도 제한한다. 탐색은 4개 시작 순서, 최대 3회 개선 pass, 최대 100,000번 score 평가다. 상한이나 계산
budget을 초과하면 `ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED`로 전체 요청을 fail-closed하며 부분 결과를
`decisionReady=true`로 반환하지 않는다. 실제 탐색 상한은 core의 `PREVIEW_LIMITS`가 정본이다.
Target별 active 예약 schedule도 최대 122건이며 DB는 123번째 sentinel이 있으면 제한 오류로
거부한다. 예약 이력을 잘라서 안전하다고 오판하지 않는다.

Fingerprint는 정렬된 snapshot의 SHA-256이다. planningAt, target assignment
version, source schedule identity, fixed assignment/attempt, 후보 status/current availability를
포함하고 폐기된 정책 및 seed는 제외한다. 별도 HTTP 호출은 DB snapshot 시각·상태가 달라 fingerprint가 달라질 수
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

`additional`의 마감 없는 작업에는 종료시각을 추측하지 않는다. 명시된 dueAt이 있을 때만 그 실제
구간을 active 예약 점유와 비교한다. 예약 schedule identity는 안전한 fingerprint에 포함하되 고객명은
포함하지 않는다.

## 검증 경계

SQL 회귀는 preview 전후 target/assignment/attempt/change request/availability/notification/outbox/
audit/command receipt/reservation/obligation/schedule revision과 과거 정책 원장을 비교한다. Optimizer
테스트는 동일 입력 비변경, 정책 유무·값 무영향, 목적함수 반례, 고정 부하, reclean, 결정적 tie-break,
fingerprint 및 자원 상한을 검사한다.
