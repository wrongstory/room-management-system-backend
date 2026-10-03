# #331 송금 표시·금액 근거 재확인

2026-10-03 사용자는 두 권장안을 확정했다. 새로운 on은 종료된 KST 주차·양수 지급
대상 금액에서만 허용하며, 금액 변경 뒤에는 on을 유지하고 별도 재확인 완료를 저장한다.
이는 외부 송금 표시를 관리하는 계약이지 은행 이체나 실제 PAID 원장을 변경하는 승인이 아니다.
기준 dev는 #324 [PR359](https://github.com/wrongstory/room-management-system-backend/pull/359)가
통합된 `8481e219d7fbd92fe3587081efca9f3bc632bba6`/98 migrations다.

## 제품·금전 경계

- 표시 identity는 maid/week다. cycle이 없는 conceptual 주차도 조회할 수 있지만 조회/표시
  때문에 cycle이나 조정 book을 생성하지 않는다. 표시 version은 cycle/book CAS와 별개다.
- false→true는 종료된 KST 월요일 시작 주차이면서 `lockedAmount ?? payableAmount > 0`일 때만
  허용한다. false→false/true→true는 새 history/version 없이 no-op receipt다.
- off는 현재 금액이0이어도 오표시 정정으로 허용한다. 이체 취소·환불·PAID→OPEN·재지급 권한이 아니다.
- on 뒤 금액 근거가 달라져도 자동 off하지 않는다. `needsReconfirmation=true`를 별도 표시한다.
  관리자는 off→on 없이 reconfirm 명령으로 현재 근거를 확인한다. 당시 on 변경자/시각은 유지하며
  확인자/시각과 표시 version만 새로운 불변 revision을 통해 갱신한다.
- 기존 on의 재확인은 현재 금액이0이어도 가능하다. 표시 자체가 없거나 근거 변화가 없으면409다.
- 앱은 송금 provider를 호출하지 않고 참조번호·계좌·수취인 PII를 요구하거나 합성하지 않는다.
  기존 earning/item/adjustment/carry/payment attempt/result·PAID·actual 지급 제한은 그대로다.
  기존 PAID를 표시 on으로 추측 backfill하지 않는다. 두 축이 달라도 서로 덮어쓰지 않는다.

## API 인계

| 메서드·경로 | 입력 | 의미 |
|---|---|---|
| GET `/v1/payroll/remittance-marker` | query maidProfileId, weekStart | 표시와 현재 근거·관리자 advisory |
| PUT 같은 경로 | maidProfileId, weekStart, marked, expectedVersion, expectedBasisFingerprint | on/off 저장 |
| POST `/v1/payroll/remittance-marker/reconfirm` | 위 본문에서 marked 제외 | on 유지·현재 금액 근거 재확인 |
| GET `/v1/payroll/remittance-marker/history` | maidProfileId, weekStart, limit?, cursor? | 불변 이력 |

두 쓰기는 Idempotency-Key(8~128 ASCII allowlist)를 요구한다. 조회한 `version`과
`basisFingerprint`를 정확히 보내며409에는 다시 GET을 조회한다. 응답 유실은 같은 본문/key로
재시도하고 성공/replay 뒤 GET을 갱신한다. receipt는 당시 응답만 replay하므로 이전 key 재시도가
새 금액 변화를 재확인한 것으로 처리하지 않는다.

표시 응답의 필수 필드:
`maidProfileId,weekStart,marked,version,lastChangedBy,lastChangedAt,confirmedBy,confirmedAt,
needsReconfirmation,basis,confirmedBasis,basisFingerprint,canSet,canClear,canReconfirm,setBlockedReason`.
off/미생성은 confirmed 필드를 null로 제공하지만 과거 확인 이력은 삭제하지 않는다.
메이드는 본인 표시·근거·이력만 읽고 세 관리 capability는 false/ADMIN_REQUIRED다.
관리자와 메이드의 marked/version/금액·재확인 필요 상태는 같은 정본이다.

`basis`의 exact8필드는 기존 aggregate의
`accrualAmount,totalAmount,adjustmentAmount,carryInAmount,carryOutAmount,payableAmount,
lateEarningAmount,lockedAmount`다. signed 금액은 정수 원 단위, lockedAmount만 nullable이다.
DB가 같은 snapshot에서 계산한 canonical JSON(lockedAmount 제외)에
`payroll-remittance-basis:v1:` domain을 붙인 SHA-256 fingerprint를 제공한다.
앱은 자체 재계산하거나 fingerprint를 권한 증명으로 사용하지 않는다.

잠긴 실제 지급액만 비교하면 지급 뒤 늦은 승인을 놓치므로 **7개 금액 근거 전체**를 비교한다.
lockedAmount는 설명 metadata로만 제공하며 비교에서 제외한다. 실제 지급 시작만으로 null→잠금액이
되더라도 payableAmount가 같으면 재확인을 요구하지 않는다.
조정·이월·late 구성 이동도 재확인 대상일 수 있어 UI는 “금액 근거 변경·재확인 필요”로 안내한다.
순 금액만 달라졌다는 주장이나 추가 지급 필요 판단이 아니다. 미확정 expected/pending, 실제
지급 status, cycle/global-book version, 항목 수는 비교 입력이 아니며 기술 상태 변화만으로
재확인 경고를 만들지 않는다.

모든 business 응답은 no-store, UTF-8 JSON128KiB 상한이며 path/method/query를 엄격히 검사한다.
history는 version ASC exclusive keyset, 기본20/최대100이다. HMAC cursor는 별도 domain으로
actor/role/live session/maid/week/sort에 묶고 기존 payroll cursor와 교차 사용을 거부한다.
history에는 revisionId/version/eventType/marked/actorProfileId/occurredAt/basis만 반환하며
session UUID·token·request hash·bank reference는 노출하지 않는다.

## DB·권한·동시성

99번째 `20261003064220_payroll_remittance_marker.sql`만 append하며 기존98개는 수정하지 않는다.
private current pointer와 append-only revision을 분리하고 동일 maid/week/version의 FK·unique,
immutable trigger·current/history commit 정합성 및 FK/keyset index로 보존한다.
raw table 접근은 anon/authenticated/service_role에 허용하지 않는다. private RLS도 활성화한다.
public RPC는 service_role-only SECURITY DEFINER, 빈 search_path 및 명시 schema다.

매 요청 최신 profile role/status/password, adapter 초기 role binding, live Auth session ownership 및
엄격한 not_after를 확인한다. 쓰기는 receipt→공통 global fence→UUID 순서 profile→session→표시
순서로 잠그고 기다린 뒤 deadline과 최신 role을 다시 확인한다. 같은 key replay도 이를 우회하지 않는다.
재확인/표시와 승인·정정·지급은 같은 global fence 아래 최신 aggregate/표시 CAS를 검증한다.
서로 다른 관리자 stale CAS, 금액 변화409, same-key duplicate/replay는 실제 DB에서 검증한다.
불변 표시 event와 safe audit는 함께 commit하며 실제 financial event/알림/provider를 위장하지 않는다.

## 프런트와 운영 범위

scoped 프런트 기준은 makee-ham/room-management-system의 main
`d509b44b1371f25d73891e04d355b0cb0e923f5f`, dev
`09ed28446a4fd43919cddb29ebe442b848548ab8`의 DOCS/30 B02/livePayrollAction이다.
live의 disabled switch/cycle.status 기반 표시 및 데모의 PAID→OPEN을 그대로 복제하지 않는다.
프런트 담당자는 별도 marker API를 연결하고 marked와 실제 지급 상태를 구별해야 한다.
전역 제품 snapshot·프런트 source·운영 main/DB/Edge/recovery/PIN/이체·릴리스/tag는 변경하지 않는다.

## 검증 checkpoint

- 기존98 기준 npm ci/ci:quality: PASS, Node1106/63, typecheck/build 및 기존 명세 검사.
- Docker: 사용자 지정 Safe Start1회 후 실제 server29.7.2/running 확인. 다른 시작/데이터 삭제 없음.
- 신규 구현 `ci:quality`: PASS(Node1220/65 files, typecheck/build, source OpenAPI137/148,
  lint 기존5 infos만 유지). 신규 구현 테스트는 Node112/Edge79다.
- Python Ruff/format/mypy25/pytest95/전체 OpenAPI의 신규4 API·6 DTO 생성 및 compile/build check: PASS.
  기존 #355 생성기 warning은 남으며 신규 표시 API 생성은 확인했다.
- fresh99 `db:reset` 및 신규 pgTAP148/1file: PASS. 첫 pgTAP은 공유 deferred trigger에서
  서로 다른 NEW row 타입의 CASE 필드 접근 오류로123 subtests 뒤 abort해 FAIL했다.
  IF 분기로 보완·manifest 갱신·fresh reset 후148 전체 재실행 PASS를 확인했다.
- 전용98→99 업그레이드: PASS. 전체 기존 행/receipt/catalog/ACL/RLS/index와 실제 PAID 불변,
  조회 무변경·PAID 표시 backfill 없음·on/off 금융/알림 무변경·fresh99 cleanup을 검증했다.
- 전용 동시성: PASS, 실제 PostgreSQL blocking PID12 edges. CAS·same-key replay·금액 변화·별도
  ACK·actual START 잠금 metadata 무경고·PAID late earning 경고·세션/role/password/receipt wait
  재검증 및 무효 명령 효과0을 확인했다.
- local-synthetic 백업·복구99: PASS. 전체25 upgrade/전체SQL·KST·기존+신규 경합·최종fresh99:
  RUNNING. 최종 local advisors: NOT RUN.
- Edge 전체: 최종467/bundle17,477,907 bytes PASS(공통 코어 mirror 동일).
  최초 전체 Edge는 index.ts 포맷에서 FAIL했고 pinned Deno 포맷 뒤 재실행했다.
- 초도 독립 QA의 P2(off 응답에 확인 정보가 남아도 parser가 수락함)는 strict guard와
  Node/Edge get/set/reconfirm 손상 응답 회귀로 보완했다. 최종 독립 QA: RUNNING.
- 독립 코드 QA98/100, 미해결 P0/P1/P2=0. 검토자가 작성한 upgrade/concurrency 하네스는
  독립 코드 판정에서 제외하며 SQL 작성자의 읽기 전용 peer review finding0과 root 실제 실행
  PASS를 별도 근거로 구분한다.
- #360 CI 유한 예산: 직전 migration CI28:11/기존30분 여유109초와 신규 로컬84+104초를
  근거로 migration timeout만30→40분으로 조정했다. application20·모든step·required checks·
  always cleanup·통과 기준·개별 SQL/process 상한은 유지한다. 같은 기능 PR에서 별도 CI
  목적 commit으로 기록하며 실제 신규 CI의30분 초과나 PASS를 예상으로 단정하지 않는다.
- exact-head application/migration CI·dev 통합: NOT RUN.
- 운영 배포·프런트 UAT: 범위 밖, NOT RUN.

실제 후속 실행 결과와 실패/보완 이력은 이 절과
[Issue331](https://github.com/wrongstory/room-management-system-backend/issues/331)의 연결 PR에
갱신하며 구현 중 source를 완료/운영 제공으로 표현하지 않는다.
