# #331 송금 표시·금액 근거 재확인

2026-10-03 사용자는 두 권장안을 확정했다. 새로운 on은 종료된 KST 주차·양수 지급
대상 금액에서만 허용하며, 금액 변경 뒤에는 on을 유지하고 별도 재확인 완료를 저장한다.
이는 외부 송금 표시를 관리하는 계약이지 은행 이체나 실제 PAID 원장을 변경하는 승인이 아니다.
기준 dev는 #324 [PR359](https://github.com/wrongstory/room-management-system-backend/pull/359)가
통합된 `8481e219d7fbd92fe3587081efca9f3bc632bba6`/98 migrations다.
이 파일은 검증된 source checkpoint를 기록한다. 최신 CI·dev 통합 판정과 exact source/CI/dev
tree는 [PR361](https://github.com/wrongstory/room-management-system-backend/pull/361)의
최신 기록을 따른다. dev 통합도 운영 배포나 프런트 연결 완료를 뜻하지 않는다.

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

## 최신 진단용 보완 checkpoint

사용자는 기존 경고를 [#363](https://github.com/wrongstory/room-management-system-backend/issues/363)으로
분리하고, **FAIL을 명시한 Draft 진단용 commit/push·CI 재실행만 승인**했다.
Ready·병합·dev 통합·운영 배포는 이 승인에 포함되지 않는다. 아래 초도 RUNNING/NOT RUN은
과거 checkpoint이며 최신 결과는 이 절과 PR361을 따른다.

- root의 추가 INFO Advisor에서 복합 FK 인덱스 coverage3건을 발견했다(P2).
  미적용 신규99 파일의 해당3 index를 전체 child FK 선행 키로 보완했고 DBML도 맞췄다.
  기존148 SQL 검사 본문을 그대로 두고 strict valid/ready/nonpartial/nonexpression B-tree
  full-key 검사3건을 추가했다. 기존98 migration/함수/ACL/RLS·실제 원장은 변경하지 않았다.
- 새99 migration SHA는 `e9d70f667f71c1d1192b3ac4a3ae0f84070041214ba8cdd21c218e61bb8c14bd`다.
  manifest5개: PASS. fresh99·관련3파일292(32+109+151)·전체77파일4604: PASS.
- 새 SHA의 전용98→99 upgrade·실제 blocking edge12개·finally fresh99 cleanup: PASS.
  `ci:quality` Node1220/65·typecheck/build/명세/secret: PASS. API/core는 변경하지 않아 기존
  Edge467 및 Python95/4API6DTO 검사 근거는 유지하며 새 실행으로 가장하지 않는다.
- 새 SHA의 local-synthetic99/rooms121 백업·복구: PASS. commit 이후 source metadata를
  포함한 재실행은 후속 결과로 기록한다.
- 초도 SHA의 전체25 upgrades·KST145·전체6 concurrency scripts는 PASS였지만 새 SHA의
  전체25 upgrades/KST/전체6 concurrency를 다시 한 번 실행한 결과는 아직 없다.
  새 SHA의 영향 범위는 위 전용 upgrade/12경합과 전체SQL로 재검증했고 전체 chain은 새 CI에서 실행한다.
- strict `db lint --level warning --fail-on warning`: **FAIL**, 기존10함수의 경고17개.
  정확 dev8481e21/fresh98에서도 동일 명령·경고 상세17개·함수 정의 MD5/volatility/securityDefiner가
  일치했다(comparison PASS). 신규 표시 함수 경고0이며 comparison이 lint FAIL을 바꾸지 않는다.
- `db advisors --type all --level info --fail-on info`: **FAIL**, INFO490개/WARN·ERROR0.
  기존98 INFO484개는 상세 객체까지 동일했다. 새 표시6개는 fresh unused index4개와
  raw 권한을 revoke한 private deny-by-default RLS2개다. 새 FK coverage 지적은0이다.
  INFO0을 만들기 위해 필요한 인덱스를 삭제하거나 private 조회 권한을 주지 않는다.
- 독립 코드 QA98/100. 초도 parser P2와 이후 root가 발견한 FK P2는 발견·보완 이력으로
  보존한다. 새3 index/3검사/manifest/DBML의 교차 검토와 실제 재실행 뒤 source 내 미해결
  P0/P1/P2=0이며 exact commit freeze의 최종 검토는 후속이다. 작성자 본인 하네스는
  독립 코드 판정에서 제외하고 별도 peer review/root 실행과 구분한다.
- 새 exact-head CI: 재실행 대기. PR은 Draft 유지, Issue331/360/362/363은 종료하지 않는다.
  운영·main·프런트·원격DB/API·recovery·PIN·provider·release/tag는 변경하지 않는다.

## 초도 검증 checkpoint (과거 이력)

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
- local-synthetic 백업·복구99: PASS. 전체25 upgrade: PASS(동일99 migration SHA).
  최초 전체 `npm run db:test`는 이전 developer head 기대3건과 기존 room-move preview의
  단발성 CAS 중단으로 FAIL했다. developer 기대값만 최신/직전 head로 보완하며32 assertions는
  유지했다. 관련3파일289 및 전체77파일4601 재실행: PASS. 원래 명령의 FAIL은 삭제하지 않으며
  upgrade와 SQL을 따로 실행한 결과를 한 번의 전체 `npm run db:test` PASS로 합쳐 쓰지 않는다.
  KST145: PASS. 기존+신규 전체 경합·최종fresh99/advisors: RUNNING.
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
- 초도 source f61198b CI37106808450: application PASS1:41/migration FAIL20:34.
  CI의 실패는 developer 이전 head 기대3건뿐이며 전체77/4601 및 기존 room-move109를 실행했다.
  보완 head CI·dev 통합: NOT RUN.
- 운영 배포·프런트 UAT: 범위 밖, NOT RUN.

하네스 교차 리뷰도98/100·범위 내 P0/P1/P2=0이다. reset/up의 전체 실행은 CI 유한40분 예산에
포함되며, 강제 종료나 엔진 장애에서 finally 복구는 보장되지 않는다. 중단 뒤 재검증은 local
identity를 확인하고 fresh reset부터 시작해야 한다.

기존 room-move의 최초 로컬 중단은 [#362](https://github.com/wrongstory/room-management-system-backend/issues/362)에
원인 추적용으로 분리했다. 같은99에서 단독109·관련289·전체4601·초도CI room-move109가 통과했고
원본 fixture63 assertions 및 default/12 EXPLAIN-only 계획에서 올바른 source/version/선행 조인을
확인했지만 최초 실패 원인을 확정하지 않았다. 기존 test109/CAS/production SQL은 바꾸거나
skip하지 않았으며 #331 완료가 그 원인까지 수정했다는 뜻은 아니다.

실제 후속 실행 결과와 실패/보완 이력은 이 절과
[Issue331](https://github.com/wrongstory/room-management-system-backend/issues/331)의 연결 PR에
갱신하며 구현 중 source를 완료/운영 제공으로 표현하지 않는다.
