# #326 배정 대상 snapshot·등록 근거·취소 capability 조회 계약

## 상태와 범위 — 2026-10-02 구현 후보

선행 #348 B안은 `dev@f72c43d4ac9d8b5abc4e700dd38392cc01ba804a`의 93 migrations 기준으로 통합됐다.
이번 #326은 94번째 append-only `20261002074234_assignment_target_read_metadata.sql`과
Fastify/Edge의 기존 조회 projection을 함께 변경하는 **구현 후보**다. 새로운 endpoint나 명령을
추가하지 않으며 OpenAPI 경로/operation 수는 131/141로 유지한다. 신규 후보의 최종 CI·독립 QA·
PR·dev 통합은 아직 완료로 선언하지 않는다. `main@1780728a02144c0816565ba091e43a8b3e126c4f`,
production/recovery DB·Edge·프런트·실제 PIN·release/tag·운영 UAT는 이번 범위 밖이다.

source/dev 완료 상태의 효력은 이 문서와 승인 exact source가 dev 정본에 포함되고, 연결된 GitHub
Issue/PR에서 해당 head의 required application/migration CI·최종 독립 QA 승인·실제 dev 통합
근거를 확인한 경우에만 발생한다. 현재 local PASS나 아래 조건부 문구는 이미 병합됐다는 뜻이 아니다.
아직 확인하지 않은 commit/PR/CI run/승인 번호를 만들지 않는다.

제품 경계는 [제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)의 immutable snapshot 및
[수동 요청 취소 계약](./MANUAL_CLEANING_CANCEL.md)의 #348 B안·PIN 제한 제거 결정을 따른다.
자동 퇴실 의무 취소, #27 일반 담당 해제, #264 수행 불가 처리, 새로운 자동 취소 정책은 추가하지 않는다.
이 문서는 조회 정보의 출처와 표현을 정의하며 이미 확정된 취소 명령 정책을 바꾸지 않는다.

## 기존 응답의 additive 정보

다음 응답이 같은 출처의 메타데이터를 제공한다.

- 배정 목록/이력의 `AssignmentCard`.
- commit-impact의 `committableDrafts`, `blockedDrafts`, `remainingUnassignedTargets`.
- Preview의 제안 target, 기존 고정 부하, 미배정/차단 target 행.
- 새로운 commit/notify 성공 응답의 배정 행. 이전 완료 receipt 재조회는 아래 legacy 규칙을 따른다.

| 필드 | 출처와 해석 |
|---|---|
| `cleaningKind` | target에 저장된 청소 종류. 등록 근거로 역추론하지 않는다. |
| `sourceKind` | target의 실제 `source`. 수동 추가/연박 source는 `manual_room_request`/`stayover_request`다. 원시 `source_key`나 새 provenance ID를 공개하지 않는다. |
| `roomTypeSnapshot` | 저장된 `room_type_snapshot`의 `{code, name, elevatorZone}`. 선택 key의 누락/null/빈 문자열/비문자 값은 unknown `null`로 정규화하며 현재 객실·카탈로그로 채우지 않는다. |
| `roomTypeCode`, `roomTypeName`, `elevatorZone` | snapshot의 호환용 평탄화. Preview의 기존 routing classifier 예외는 아래에 설명한다. |
| `feeSnapshot` | 저장된 고정 요금. **0은 유효한 값**이며 현재 기본 요금으로 대체하지 않는다. |
| `originalServiceDate` | target 생성 시의 원 서비스일. 날짜가 다르다는 이유만으로 이월로 판정하지 않는다. |
| `effectiveServiceDate` | target 조회에서는 현재 유효 서비스일, 배정 카드에서는 해당 immutable assignment의 `service_date`. 이력 카드를 이후 target 날짜로 덮지 않는다. |
| `rolloverCount`, `rolloverReason` | 실제 schedule revision의 `ROLLED_OVER_UNASSIGNED`/`ROLLED_OVER_NOT_STARTED` 근거만 집계한다. |
| `canCancel`, `cancelReasonCode` | 조회 시점의 advisory 표시. 실제 취소 권한이나 성공을 보장하지 않는다. |

`roomTypeSnapshot`은 canonical 표시 정보다. 기존 Preview의 `roomTypeCode`와 `elevatorZone`은
계산/호환용 classifier로 누락 시 문자열 `unknown`을 유지하지만 canonical snapshot의 해당 key는
`null`이다. 이를 현재 카탈로그 값으로 채우거나 `unknown`을 실제 객실 타입으로 저장하지 않는다.
저장 원문 객체의 선택 key를 읽는 **raw normalizer**와 새 응답 metadata pack을 검사하는 **strict
parser**는 다른 경계다. 전자는 빈/비문자 선택 key도 unknown null로 정규화하여 SQL projection과
Fastify/Edge 카드가 같은 canonical 객체를 제공한다. 후자는 canonical key 누락·잘못된 타입 등
malformed 신규 metadata pack을 안전한 500으로 거부한다. raw 저장값의 선택 key 문제를 전체
카드 실패로 만들거나 malformed 신규 응답을 legacy로 간주해 조용히 보정하지 않는다.
독립 QA 1차의 SQL null 대 TS 500 불일치는 raw normalizer/strict parser 분리 및 SQL Preview
classifier 보완으로 정적 resolved다. 최종 QA·upgrade/CI 통과 여부는 아래 gate로 별도 추적한다.

기존 카드/공개 text·DB `room_types.name TEXT`·OpenAPI에는 표시 이름의 100자 상한이 없다.
공통 표시 metadata에 임의 100자 제한을 추가하면 기존 긴 이름 조회를 실패시키는 호환성 회귀다.
QA 2차에서 이 P2를 확인한 뒤 임의 표시 상한을 제거했고 1,001자 이름 회귀를 실제 검증했다.
기존 optimizer의 routing `code`/`elevatorZone` `str(100)` 검사는 별도 입력 계약으로 유지하며
fresh pack의 타입/nonempty/partial-pack reject도 유지한다. 현재 구현 후보의 정적 P0/P1 및
미해결 코드 P2는 0이며 exact-head 최종 QA 승인은 여전히 별도 gate다.

이월 count는 target `carryover_count`를 상한으로 하고 조회 대상 revision까지의 실제 이월
schedule 행만 센다. 카드는 해당 assignment revision, target-only 행은 현재 target version이
상한이다. 실제 근거를 조회한 결과가 없으면 `0/null`이며 예약 일정 변경·날짜 차이는 근거가 아니다.
나중 이월을 과거 통보 카드에 소급하지 않는다. #305/#308 이후 자동 이월을 다시 활성화하지 않는다.

## ID·CAS는 기존 계약을 재사용

수동 청소 요청 ID는 기존 target ID다. 기존 행의 `cleaningTargetId`/`targetId`를 취소 경로의
`{targetId}`로 사용하고, `targetAssignmentVersion`을 body의 `expectedVersion`으로 전달한다.
Preview는 기존 `expectedAssignmentVersion`도 유지한다. `manualCleaningRequestId`, `targetVersion`
별칭이나 별도 요청 식별자를 새로 만들지 않는다. 생성 응답의 기존 `id/version` 계약도 유지한다.

관리자 카드는 현재 target CAS를 제공한다. 메이드 카드는 해당 통보 revision의 version을 유지하며
관리자 취소 command의 CAS로 사용하지 않는다. target soft cancel과 배정 unassign은 서로 다른 명령이다.

## 취소 capability: #348 실제 predicate와 동일한 표시

관리자용 target 행/현재 카드는 다음 조건일 때만 `canCancel=true`, `cancelReasonCode=null`이다.

1. source가 `manual_room_request` 또는 `stayover_request`다. 종류만으로 source를 추측하지 않는다.
2. target phase가 `unassigned`, `draft_assigned`, `notified` 중 하나다.
3. 현재 assignment에 연결된 **모든** 비-`superseded` attempt에 대해 `started_at`이 null이고
   status가 `scheduled`다. 최신 표시 회차 하나만 검사하거나 과거 assignment의 수행을 섞지 않는다.

PIN 조회·공개·숨김·만료·회수 이력, 서비스일·dueAt 경과, access window, draft의 stale schedule은
이 표시의 별도 취소 제한이 아니다. 새 날짜·시간 제한이나 cleaning-kind 조건을 추가하지 않는다.
현재 assignment가 없는 수동 미배정 target도 위 source/phase 조건으로 판정한다.

| `cancelReasonCode` | 표시 의미 |
|---|---|
| `NOT_MANUAL_CLEANING_REQUEST` | 기존 수동 요청 취소 command의 source 범위 밖이다. |
| `CLEANING_REQUEST_CANCEL_CONFLICT` | 보호 phase 또는 현재 assignment의 실제 착수/terminal 회차 근거가 있다. |
| `ASSIGNMENT_NOT_CURRENT` | 관리자 이력 카드이며 현재 담당 row가 아니다. |
| `ADMIN_REQUIRED` | 메이드 등 관리자 취소 UI 범위 밖이다. 메이드 이력에도 우선 적용한다. |
| `CAPABILITY_UNAVAILABLE` | legacy receipt/출처·회차 정보 부족으로 가능 여부를 입증할 수 없다. |

이 값들은 **조회 표시 코드**이지 취소 endpoint의 신규 HTTP 오류 계약이 아니다. HTTP adapter의
기존 오류 매핑을 바꾸지 않는다. `canCancel=true`여도 실행 시 최신 active 관리자·비밀번호 변경 완료·
live session·target CAS·current assignment/attempt transition을 DB가 다시 확인한다. 동시 변경이나
409 뒤에는 관련 projection을 다시 조회하고, timeout/replay는 기존 멱등 규칙을 따른다.

메이드 current/history의 취소 표시는 `false/ADMIN_REQUIRED`이며 관리자 history는
`false/ASSIGNMENT_NOT_CURRENT`다. 읽기 권한이나 현재 target hydration으로 과거 담당자의
일정·CAS·객실 snapshot을 최신 업무처럼 노출하지 않는다.

## DB·receipt 보존과 fingerprint 경계

94번째 migration은 table/업무 enum/RLS 정책을 추가하거나 source·snapshot 원장을 UPDATE하지 않는다.
private helper `assignment_target_read_metadata`, `assignment_target_read_rows`,
`assignment_commit_read_metadata`는 출력 projection 전용이며 public/anon/authenticated/service_role의
직접 EXECUTE를 모두 회수한다. 기존 권한 검사된 private RPC 내부에서만 사용한다.

impact/preview의 출력 construction과 새로운 성공 commit 행에만 metadata를 더한다. 기존
impact fingerprint 및 Preview snapshot fingerprint의 입력에서 새 표시 metadata는 제외한다.
다만 legacy snapshot에 `elevatorZone`이 없을 때 과거 `rooms.elevator_zone` fallback(A/B 등)을
제거하면 기존 routing classifier가 `unknown`으로 바뀐다. 이는 새 metadata 추가와 별개의
**계획 입력 변경**이므로 모든 legacy Preview fingerprint가 byte-identical하다고 보장하지 않는다.
이런 기존 Preview 결과는 다시 조회·계산하여 새 fingerprint와 제안을 확인해야 한다. 저장 원장이나
완료 receipt를 바꾸지 않는 것과 live planning 입력/새 fingerprint가 같은 것은 별개다.
기존 완료 command receipt의 JSON을 재작성하거나 현재 DB로 다시 hydrate하지 않고, 조회로 감사·
알림·receipt·target·assignment·schedule·attempt를 쓰지 않는다. 역사 데이터 backfill도 없다.

이전 완료 receipt에 새 metadata pack이 전혀 없으면 adapter의 additive 필드는 unknown `null`,
취소 표시는 `false/CAPABILITY_UNAVAILABLE`이다. 원래 있던 commit 결과·ID·version·fingerprint는
유지한다. Preview의 legacy 입력은 이미 제공된 종류/source/fee만 보존한다. unknown 이월은
`null/null`이며 실제 근거를 조회한 신규 행의 `0/null`과 구분한다. 이전 완료 receipt replay에
현재 source·요금·날짜·취소 권한을 재조회하여 과거 성공 결과에 붙이지 않는다.

## 프런트 인계 — scoped read-only 확인

정본 `makee-ham/room-management-system`의 확인 ref는 main
`d509b44b1371f25d73891e04d355b0cb0e923f5f`, dev
`09ed28446a4fd43919cddb29ebe442b848548ab8`이다. 이는 #326 소비 지점의 scoped 확인이며
[제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)의 전역 프런트 제품 snapshot 갱신이 아니다.

- dev [B04 요구](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/DOCS/30_DEPLOYED_WIREFRAME_API_PARITY.md#L55)는 미배정/Preview 행의 종류·요금·이월·등록 근거 부족을 기록한다.
- dev [live 행 병합](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/WIREFRAME/index.html#L9348)은 impact → current assignments → Preview → 로컬 수정 순서다. 각 행의 snapshot 정보와 ID/CAS를 유지해야 한다.
- dev [기본 요금 fallback](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/WIREFRAME/index.html#L9357)은 `feeSnapshot ?? currentType.baseCleaningFee`다. 0은 보존하지만 unknown null을 최신 요금으로 채우므로 snapshot 표시에서는 제거해야 한다. 타입/구역의 `||` catalog fallback도 같은 경계다.
- dev [취소 버튼](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/WIREFRAME/index.html#L9379)은 생성되지 않는 `manualCleaningRequestId`/`targetVersion` 별칭을 요구한다. 기존 target ID/CAS와 서버 `canCancel`에 연결해야 하며 등록 근거 문구는 `sourceKind`를 소비해야 한다.
- [generated client](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/src/api/generated/room-management-api.ts#L4473)는 기존 UnassignedTarget DTO다. 검증·승격된 OpenAPI로 프런트 담당자가 재생성하고 consumer를 변경한다. 생성 파일을 수작업 수정하지 않는다.

프런트 변경·실제 화면 UAT는 수행하지 않았다. 취소 성공 후 객실뿐 아니라 배정/미배정/impact를
재조회하는 연결도 프런트 담당자의 회귀 범위다. 서버 후보 존재를 프런트 연결 또는 운영 사용 완료로
간주하지 않는다. 후속 메이드 일정 projection은 #328, 사건 목록은 #327로 별도 진행한다.

## 검증 기록과 남은 gate

아래 최신 quality/Edge/focused 및 full DB PASS는 QA 2차 긴 이름 보완과 추가 fixture를 포함한
실제 로컬 실행 기록이다. exact-head CI·최종 QA·source/dev 통합·운영 완료로 확대하지 않는다.

- PASS(선행 기준선): #348/dev의 Node 715 tests. 신규 #326 전체 검증 결과로 재사용하지 않는다.
- PASS(신규 migration): fresh local `npm run db:verify` 94 migrations 및 보완 후 fresh 94 reset
  재실행. 운영 DB 적용이 아니다.
- PASS(최신 focused): Node 156 tests / Deno 34 tests 및 typecheck/lint. 이전 Node 137/150,
  Deno 31/32, 기존 SQL 3파일 132, OpenAPI 10 tests는 중간 실행 기록이다.
- PASS(전용 SQL 당시 실행): 135 tests, 정상 7일 fixture 및 `SET CONSTRAINTS ALL IMMEDIATE`
  보완 후 PASS다. 이후 긴 이름 회귀가 더해진 **137 tests는 아래 full suite에 포함된 결과**이며
  별도 최신 전용 실행을 수행했다고 표현하지 않는다.
- PASS(93→94 upgrade 3차): 정상 7일 fixture로 보완하여 실제 upgrade/replay/no-backfill 검증이
  통과했고 이후 cleanup fresh 94도 PASS다. 로컬 실행 근거는 `.tmp/326-upgrade-3.log`다.
  뒤에 추가한 긴 이름 assertion은 아래 full suite의 해당 upgrade 단계에서도 실제 PASS했다.
- PASS(전체 DB): `npm run db:test` exit 0, 명시된 20 upgrade phases 모두 PASS 및 72 SQL files /
  4,068 tests PASS. 신규 실제 요청/receipt의 1,001자 이름·기존 receipt 보존·#326 SQL 137 tests를
  포함한다. 로컬 실행 근거는 `.tmp/326-full-db-test-1.log`다.
- PASS(KST): 5 clocks × 29 checks = 145, `.tmp/326-kst.log`.
- PASS(전체 실제 경합): `npm run db:test:concurrency` exit 0, 예약/배정/수행/PIN/알림/사진/지급
  전체 회귀 및 complaint-attention·manual-cancel의 start/disclosure/session ordering·exact-once
  회귀가 통과했다. 마지막 cleanup fresh 94도 PASS다. `.tmp/326-concurrency.log`를 근거로 한다.
- PASS(QA 2차 보완 후 전체 quality): `npm run ci:quality` Vitest 795 tests / 55 files와
  secrets/lint/typecheck/build/OpenAPI 12. `.tmp/326-quality-qa2.log`를 근거로 한다.
  이전 quality 789/55는 보완 전 실행이다. Python console 95 tests·full Ruff·mypy·codegen·build도 PASS다.
- PASS(QA 2차 보완 후 전체 Edge): 318 tests와 bundle 17,204,763 bytes,
  `.tmp/326-edge-qa2.log`. 이전 315 / 17,203,351 및 316 / 17,204,821은 중간 실행 기록이다.
  bundle 존재를 hosted 배포로 간주하지 않는다.
- PASS(로컬 readback): 5 manifests 검사, candidate backup의 94 migrations 검증, DB lint exit 0.
  기존 10 functions warning은 유지하며 #326 새 helper의 추가 경고는 없다. public base tables
  49개 / RLS 누락 0개 및 SECURITY DEFINER fixed search_path 누락 0개를 확인했다.
  local `supabase db advisors --local --type all --level warn --fail-on error`는 결과 0건/exit 0으로
  PASS했다(`.tmp/326-advisors-final.log`). candidate backup은 아직 exact-source 복구 gate의 대체가 아니다.
- FAIL(첫 focused 시도 이력): additive 필드로 기존 기대 객체 7건이 불일치하여 65/72 통과.
  기존 테스트를 보존한 채 기대 계약을 보완하고 위 focused 재검증에서 PASS했다. 실패 이력은 지우지 않는다.
- FAIL(첫 전체 Edge check 이력): OpenAPI 한 파일의 Deno format 검사 실패. 해당 파일 formatter를
  적용한 뒤 전체 Edge 재실행에서 PASS했다. 테스트 삭제/기준 완화는 하지 않았다.
- FAIL(초기 lint 이력): explicit ReturnType 누락 1건. 보완 후 최신 전체 quality는 PASS이며
  기존 실패를 지우지 않는다.
- QA 1차 P2: raw 저장 snapshot의 빈/비문자 선택 key를 SQL은 null, TS 카드는 500으로 처리한
  불일치. core raw normalizer/fresh strict parser 분리와 SQL Preview classifier를 보완했고
  정적 검토상 resolved다. 최종 독립 QA 승인을 뜻하지 않는다.
- QA 2차 P2: 기존 표시 text 계약에 없는 신규 `metadataText` 100자 상한. 공통 표시 상한 제거
  및 1,001자 이름 카드/신규 metadata/실제 신규 receipt·보존 회귀 후 정적 resolved다.
  정적 P0/P1/미해결 코드 P2=0이며 exact-head 최종 QA 승인과 구분한다. 기존 routing 문자열
  상한이나 fresh pack 검증은 함께 완화하지 않았다.
- FAIL(93→94 upgrade 1·2차 이력): fixture commit의 deferred
  `AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS` / SQLSTATE `23514`. 기존 제약을 위반하는 1일 fixture가
  원인이며 실제 제약은 유지한다. 정상 7일 fixture 보완 후 위 upgrade 3차에서 PASS했다.
- PENDING: clean source commit 이후의 exact-source backup, exact-head application/migration CI·
  최종 독립 QA·새 PR·dev 통합. 완료 근거는 연결 Issue/PR에서 해당 source/tree에 대해 확인한다.
  기존 candidate backup PASS를 최종 source의 backup 검증 완료로 대체하지 않는다.

최종 source 승인 시 실제 실행 결과와 exact head/CI/QA 근거로 이 절을 갱신한다. #326은 그 gate 전까지
완료/종료로 표시하지 않으며 운영 승격은 별도 승인된 release 절차를 따른다.
