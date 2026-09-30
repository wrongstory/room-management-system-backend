# 배정 Preview API — #29/#231/#320 계약

## #320 진단 보강 — feature source, 운영 미배포

기준 backend는 `dev@e19f81fabe1ff202b5a42ba37b9d5dccbf8215c2`다. Preview 연동만
프런트 `dev@09ed28446a4fd43919cddb29ebe442b848548ab8`의 `WIREFRAME/index.html`
9322/9335/9346/9452행과 대조했다. 제품 전체의 프런트 기준 snapshot을 승격한 것은 아니다.
프런트는 이미 `reasonCodes` 우선, 없으면 기존 `reason`을 표시하지만 한국어 조치 문구는
매핑하지 않는다. 프런트 수정은 프런트 담당 작업으로 남긴다.

기존 `reason`과 proposed/remaining/blocked 분류, 점수, fingerprint는 유지한다.
`remainingUnassignedTargets[].reasonCodes`는 아래 우선순위에 따라 정확히 한 코드를 추가한다.

| 순서 | 코드 | 의미와 관리자 확인 사항 |
|---|---|---|
| 1 | RECLEAN_MAID_UNAVAILABLE | 재청소 원담당자가 활성·제출·당일 가능 후보가 아님. 해당 담당자 가능일 확인 |
| 2 | RECLEAN_MAID_FIXED_ASSIGNMENT_CONFLICT | 원담당자의 기존 업무 정합성 확인. 타 메이드로 자동 우회하지 않음 |
| 3 | NO_ACTIVE_MAID | 활성 메이드 0명. 계정 상태 확인 |
| 4 | AVAILABILITY_NOT_SUBMITTED | 활성 메이드의 현재 유효 제출 version이 모두 없음. 해당 주 가능일 제출 확인 |
| 5 | NO_AVAILABLE_MAID | 유효 제출은 있으나 당일 가능 후보 0명. 가능일 확인(일부 미제출이 섞일 수 있음) |
| 6 | FIXED_ASSIGNMENT_CONFLICT | 가능일 후보 모두 기존 업무 정합성 검증에서 제외. fixedExclusions 확인 |
| 7 | NO_FEASIBLE_ASSIGNMENT | 위 사유로 설명되지 않는 미배정. 재조회 후 계속되면 지원 문의; 정책 원인 단정 금지 |

`diagnostics`는 동일 read-only RPC snapshot에서 파생하며 추가 DB 조회를 하지 않는다.

- `evaluatedAt`: snapshot의 planningAt. 별도 availability/commit-impact 호출과 같은 시점 보장은 없음.
- `activeMaidCount`: role=maid, status=active 인원.
- `submittedAvailabilityMaidCount`: 그중 현재 유효 가능일 제출 version이 있는 인원.
- `availableMaidCount`: 그중 대상일 available=true인 인원.
- `fixedExcludedMaidCount`: 가능일 후보 중 기존 고정 업무 때문에 제외된 **고유 메이드 수**.
- `eligibleMaidCount = availableMaidCount - fixedExcludedMaidCount`: 재청소 소유권 적용 전 후보 수.
  특정 재청소의 후보 수나 실시간 확정 인원 수가 아니다.
- `fixedExclusions`: 최대 242개 고정 target 진단(maidProfileId, cleaningTargetId, reasonCodes).
  미래 scheduled를 당일 고정 업무에서 생략하는 기존 규칙은 이 목록과 별개다.
  한 메이드의 여러 target·한 target의 여러 사유가 있을 수 있어 배열 길이·사유 합계를 인원으로 더하지 않는다.

고정 업무 사유는 중복 없는 복수 코드이며 순서는
`FIXED_SEQUENCE_CONFLICT` → `FIXED_SERVICE_DATE_MISMATCH` →
`FIXED_ASSIGNMENT_VERSION_MISMATCH` → `FIXED_SCHEDULE_MISMATCH` →
`FIXED_SOURCE_BLOCKED` → `FIXED_ATTEMPT_OWNER_MISMATCH` →
`FIXED_ATTEMPT_WORKFLOW_UNRESOLVED`다.
SQL의 고정 업무 blockedReason은 FIXED_SOURCE_BLOCKED로만 집계하고 raw payload를 새 진단에
복사하지 않는다. 진행 중 업무의 단순 ASSIGNMENT_WINDOW_EXPIRED 예외는 유지한다.
고정 업무를 삭제하거나 무시해 제안을 만드는 복구 명령이 아니다.

예: active=2, submitted=2, available=2, fixedExcluded=2, eligible=0이면 신규 제안 0 /
미배정 12 / target 차단 0이 가능하다. 각 미배정에는 기존 NO_ELIGIBLE_MAID와 새
FIXED_ASSIGNMENT_CONFLICT가 함께 온다. **합성 재현이며 사용자 신고 건의 실제 원인이 아니다.**

권한·CAS·멱등성·RPC·migration·현재 마감 정책은 변경하지 않는다. Fastify/Edge 응답은 no-store다.
실제 신고 건은 서비스일/당시 응답 및 배포 commit이 없어 아직 미확인이다. 같은 날짜의
preview, availability candidates, commit-impact를 민감정보 없이 대조하기 전 #320을 종료하지 않는다.
한국어 조치 문구 매핑, 기능 배포 후 UAT는 별도 프런트/운영 gate다.

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
- 실제 진행 중인 attempt는 현재 담당·sequence를 고정한 채 유지한다. 그 메이드는 당일 후속
  sequence의 계획 후보가 될 수 있지만, 남은 시간이나 종료시각을 추정하지 않는다. Preview·draft·notify는
  다른 작업의 동시 현장 시작 허가가 아니며 시작 명령의 in_progress 제한은 그대로 적용한다.
  진행 중인 기존 작업의 dueAt이 지났다는 이유만으로 그 메이드의 후속 계획을 제외하지 않는다.
  미래 날짜의 scheduled 업무를 오늘 업무로 당겨 넣지 않는다.
- 일반 reclean은 원 maid만 후보이며 그 maid가 inactive/미제출/불가능이면 미배정으로 남긴다.
  관리자가 #264 수행 불가를 확정하면 기존 0원 target은 종료하고, 원 유상 청소의 fee/template snapshot을
  가진 별도 ordinary replacement target만 일반 미배정 후보로 다른 active maid에게 제안한다.
- planned checkout은 계획만 가능하다. Attempt/PIN/현장 실행 활성화는 하지 않는다.

`planningAt`, `availableFrom`, `dueAt`은 명시된 시각 사실로 보존한다. 신규 후보의 `dueAt`이 이미
지났거나 `availableFrom >= dueAt`이면 거부하지만 진행 중인 고정 작업의 지난 마감은 종료 증거로
간주하지 않는다. 예상 분수를 더한 종료시각이나 순차 cursor를 만들지 않는다.
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
