# #336 제출·승인 후 특이사항 보고 설계와 결정 경계

## 31차 checkpoint — 2026-10-07 종결 조회 보완과 전체 재검증

30차 독립 QA의 종결 상태 누락을 보완했다. GET/list만 기존 closure 원장을 join하여
`closureRevision`, `closedAt`, `closedByProfileId`를 반환한다. 미종결은0/null/null,
종결은1/시각/실제 관리자 ID다. Node·Edge·Swagger를 동일하게 갱신했다. 불변 finalize
projection과 최초 receipt는 변경하지 않아 종결 뒤 재시도에도 최초 응답을 보존한다.
관리자 공유와 실제 통보 이력이 있는 메이드 접근 정책은 그대로다.

원격 read-only 확인에서 운영 migration85개·복구73개 모두 후보111 설치/closure table/
report projection 존재가 false였다. 따라서 미게시·미적용111 후보의 GET/list 두 함수만
보완하고 manifest를 재생성했다. 이미 적용된 기존110 SQL은 수정하지 않는다. 29차의
후보111 포함 raw SHA 보존은 당시 증거이며 이번 의도적 후보 변경 이후 주장하지 않는다.

- `ci:quality`:99파일/2,524 tests·typecheck·build·secret/frontend 검사 PASS.
- 독립 기능 재QA:6파일/189 PASS, 코드상 종결 누락 해소. 이후 cross-source 부정 테스트가
  DTO 누락으로 먼저 실패하지 않도록 정상 closure 필드를 넣었고 API46 재실행 PASS.
- fresh111 PASS; focused SQL231 및 전체88파일/5,568 assertions PASS.
- 실제110→111 upgrade PASS: 기존 원행/OID/ACL/RLS/receipt·카탈로그 보존과 fresh cleanup.
- 실제18개 잠금 경합 및 fresh cleanup PASS. 실제 Drive 호출은 하지 않았다.
- Edge 전체 exit0 PASS: raw65/기존491/생성본65; 기본18,563,363 bytes·후보19,185,148 bytes.
  둘 다20,000,000 byte 제한 이내이며 #400 frozen lock 검사도 포함했다.
- exact9 DB baseline PASS(3개 함수 지문 일치). 원본 strict lint는 FAIL9/exit1 그대로다.

전체 SQL 로그 SHA256 `bd4badaadb296d44e1dcbe5be6b9145c62decee94ff0b3af216c7be8db796e63`,
upgrade `d443b0e9055e567352328e502e33c236b76841e449bfb476edc44554ae162dbd`,
Edge `5064481b0170a5aab88dad8ba3b5d1fd46469ddfeffd98d7d7e0a4b23cdaa1ef`.
SQL111 LF SHA256 `d5c9933a91f8841b3f31404eccd14bd34725c458ed471bf10c0deac50fc42ee1`.

최종 증거 포함 독립 QA PASS: 별도 검토자가6파일/189 tests를 재실행하고 DB/Edge 로그를
확인했으며 검토 범위 내 미해결 P0/P1/P2 없음으로 판정했다. DB mutation을 독립 검토자가
실행한 것은 아니다. 마지막 mock 보완 후 전체 `ci:quality`2,524 tests/build도 재실행 PASS.
`git diff --check` PASS, 원격 dev는 여전히 ac8c775이며 기존110 migration tracked diff는 없다.
변경 범위 확정·commit/push·PR exact-head CI·보호 규칙 확인·dev 병합은 후속이다.
운영 배포·migration·초기화·Auth/PIN 변경·tag/Release는 수행하지 않았다.

## 30차 checkpoint — 2026-10-07 독립 QA 보완 판정

사용자 승인으로 기능/권한 및 빌드/upgrade를 별도 검토 에이전트가 독립 검토했다.
기능 QA20파일/752 tests, 빌드·upgrade QA3파일/130 tests PASS이나 아래 P2 두 건으로
전체 후보는 보완 필요다. P0/P1은 발견되지 않았으며 DB·실제 provider·운영 재실행을
독립 검토자가 수행한 것으로 표현하지 않는다. 29차 PASS는 그 시점의 실행 증거다.

1. 신고 종결 상태 조회 누락 — 미해결. SQL report projection 및 Node/Edge/Swagger의
   GET/list DTO에 closure metadata가 없다. 관리자 A 종결 후 다른 관리자/새로고침은
   미종결과 같은 응답을 받는다. 독립 재현에서 open/closed projection이 동일하고
   closure 반환 필드가0개였다. 기존 append-only closure 원장·finalize receipt는 보존하고,
   GET/list에 현재 closureRevision·closedAt·실제 처리자 조회를 일관되게 추가해야 한다.
   SQL·Node·Edge·Swagger·DB/권한/receipt/경합 회귀 및 독립 재QA 전에는 완료가 아니다.
2. #400 검사 모드의 fresh dependency resolve — 수정·독립 재QA PASS. `--check`도 빈 임시
   lock과 `--frozen=false`를 사용하여 호환 transitive 패키지 새 버전만으로 CI가 달라질 수
   있었다. 이제 검토된 runtime lock bytes를 먼저 복사하고 `--frozen`으로 검증한다.
   명시적 재생성 모드만 resolve한다. spawn mock은 실행 전 lock bytes/고정 옵션/cleanup과
   원본 보존을 확인한다. focused8·typecheck·lint 및 실제 pinned Deno check PASS.
   별도 검토자의 수정본 focused3파일/131 tests 재실행 PASS로 이 P2를 해소했다.
   주 에이전트의 수정 후 전체 `ci:quality`도99파일/2,518 tests 및 build exit0 PASS다.

ARCHITECTURE/ERD의 과거 미등록 설명도 최신 source 등록·운영 미배포 경계로 보완하고
기능 QA가 재확인했다. 새 변경 전체의 독립 승인·commit/push·PR/CI·병합·운영은 아직 없다.

## 29차 checkpoint — 2026-10-07 전체 동시성·최종 로컬 상태 검증 완료

28차와 동일한 dev `ac8c775` 기반 source 후보에서 전체11종 concurrency chain이 exit0으로
완료됐다. 예약·배정·착수·완료·오프라인·검수·주급·알림·PIN의 기존 통합 경합과 후속
응답주의/수동취소/주급정정/수행명세/송금표시/제한세션/사진 provider context/저장명/촛불/
제출 후 신규 신고 검사를 모두 실행했다. 마지막 #336의 실제18개 잠금 겹침은 관리자 공유,
인계 CAS/이전 실행자 차단, 같은 key, 통합30/min·8개 업로드 상한, provider/봉인/purge,
응답 유실 및 기존 업무 원행 보존을 검증했다. 실제 Drive·운영 데이터는 사용하지 않았다.

- #336 경합 및 fresh cleanup 로그 SHA256:
  `9500fc694b0ac0b537a21065aec17c1967a851f9298b0e18c1edc6cd45e10d15`.
- 최종 cleanup 후 별도 read-only 재확인 PASS: exact111 migration history/manifest,
  객실121·타입4·public RLS 누락0·지정된25개 fixture relation0, 원본 migration/manifest112개
  raw SHA drift0. 이 검사는 개발 로컬 DB이며 운영·복구 프로젝트 점검이 아니다.
- cleanup 뒤 `check-db-lint-baseline.mjs` 재실행 exit0 PASS: 승인 exact9 경고와3개 함수
  지문 일치. 원본 strict lint는 FAIL9/exit1을 유지하며 strict PASS로 표현하지 않는다.
- Node2,517·전체 SQL5,560·Edge 기본18,550,494 bytes/후보19,171,562 bytes·static·KST145
  PASS는28차 실행 증거를 따른다. 최초 aggregate/SQL/번들 FAIL도 그대로 보존한다.

새 변경 전체의 최종 독립 QA·commit/push·exact-head CI·PR/dev 병합은 아직 미완료다.
현재 운영 또는 hosted Swagger/프런트 UAT 완료가 아니다. 다음은 독립 QA와 변경 범위
검토 후 허용된 feature→dev PR이며, 운영 배포·migration·초기화·tag/Release는 실행하지 않는다.

## 28차 checkpoint — 2026-10-07 기본 API·Swagger 등록 및 실제 upgrade 보완

같은 `codex/336-latest-dev-integration`/dev ac8c775 기반에서 신규11개 operation을 기본
Fastify/Edge dispatcher와 전역 source Swagger에 연결했다. source는150 paths/162 operations/
335 unique safe error codes이며 `source-registered-not-deployed` 상태다. 운영·hosted
Swagger/Pages·프런트 UAT·dev 병합은 미완료다. 원본388 후보·v0.8.0은 보존한다.

- 전용 영속32바이트 `POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64`와 공유 사진 provider를
  지연 구성한다. 누락 시 조회는 유지하고 관리자 인계만503으로 거부한다. 인증/역할/입력
  검증 우선순위, 키 재사용 거부, 관리자 공동 상태 조회와 실제 인계 권한 분리를 검증했다.
- 한국어 summary/description11개를 필수 생성 검증에 포함했다. 독립 QA에서 발견한
  원 수행 사실만으로 접근 가능한 듯한 설명을 고쳐 모든 메이드에게 본인 실제 통보
  배정 이력을 요구한다고 명시했다. ownership은 응답 구분이다. 해당 문구 재QA39 PASS,
  이전 P2 해소. 기존140개 path 계약과305개 오류 순서를 유지한다.
- `ci:quality` 최신99파일/2,517 tests·secrets/frontend/typecheck/build PASS. 이전 실행의
  Biome 신규 test non-null warning2개 제거 후 전체 품질 검사도 재실행해 PASS했다.
  기존 info18개는 남아 있다. 앞선97파일/2,493 결과와 현재 결과를 구분한다.
- #400: 기본 API 실제 번들25,498,217 bytes로20,000,000 제한 FAIL을 독립 재현했다.
  runtime lock에 type/test-only npm 패키지가 포함된 원인에 따라 pinned Deno2.1.4의 정상
  entrypoint 설치로 실행용9개 package lock을 생성했다. 타입/전체 테스트는 기존 확정된
  검증용 lock에서 계속 frozen으로 수행한다. SDK 버전/무결성은 두 graph가 정확히 같다.
  기본 번들18,550,494 bytes 및 raw65/기존491/생성본65 PASS를 확인했다. 같은 실행의
  별도 후보 번들만 임시 import-map 기준 경로 오류로 FAIL하여 상대 mapping의 원래
  기준 위치를 보존하도록 보완했다. 최종 전체 Edge exit0 PASS: raw65/기존491/생성본65,
  fmt103, 기본18,550,494 bytes·별도 후보19,171,562 bytes다. 성공 로그 SHA256은
  `09ae6f0ba25124b946d1ec86eb1f4b50c8b09332bd6c5edf6b639a7fb5bf5033`이며 실패 로그 SHA는
  `4a13a5f3ffee15235bbeeac16b2c0223fd92753735b46fe59cd7c0d9e299fe4a`다.
- 기존27 upgrade chain 첫 FAIL을 보존한다. 개별18–20 재실행 PASS 후21번째 일정 upgrade의
  원인(정상 신규 notification catalog1행이 전체 digest에 포함됨)을 재현했다. 기존 전체
  catalog 행을 한 SQL snapshot으로 비교하고 신규1행의11필드를 정확히 검증한 뒤에만
  해당 행을 digest에서 제외한다. unknown/변형/중복/이전 행 손상은 계속 거부한다.
  회귀15 PASS, 실제94→111 일정 upgrade와22–27까지 PASS했다. 기존18–27 및 신규28번
  upgrade는 분할 재실행 결과이며 최초 aggregate 명령의 FAIL을 PASS로 바꾸지 않는다.
- 전체 SQL 첫 실행은88파일/5,502 assertions 중 구 catalog59개 기대값3건과 사진 fixture
  미완료 보상1건을 빠뜨린 동시업로드 예산에서 FAIL했다. catalog 총60개와 신규행11필드
  exact 검사를 추가하고, 사진 fixture는 미완료 보상1건+새 업로드7건=상한8을 검증한다.
  한도·권한·제품 SQL은 완화하지 않았다. 수정4파일/315 assertions 및 전체88파일/5,560
  assertions exit0 PASS다. 전체 성공 로그 SHA256은
  `10f6e0fc2ebc72248e3d2445dd7a13fed1308472a6af72d48b2bce875e78a142`이며 최초 실패는
  `ec53909c93601be8a9c272d887d6c5608d5b0a12c7285a5ca4f11711c70dbffb`로 보존했다.
  원본111개 migration+manifest112파일 raw SHA drift0 및5 manifest verifier PASS다.
- `db:test:static-warning` 실제100→101 보존/rollback/receipt 검사와 최종cleanup exit0 PASS,
  raw strict FAIL9/exit1 및 exact9 warnings·3 fingerprints PASS를 그대로 구분한다.
  `db:test:long-stay-clock` KST 경계5개×29=145 assertions PASS다. 최신 통합 전체11종
  concurrency chain을 실행 중이며 완료 전에는 전체 경합 PASS로 표시하지 않는다.
- 신규28번째110→111 전용 runner를 `db:test`의 기존27개 다음·전체 SQL 앞에 연결했다.
  원110 filename/version/LF-SHA 고정,23개 private table·64개 함수·기존 OID/ACL/RLS 및
  전체 원행 보존, 정확7개 함수 patch/2개 trigger/28개 FK trigger, 이전 실제 receipt replay와
  만료 거부, 새 draft/upload/finalize/replay와 타 메이드 거부, fresh111 cleanup을 실제 PASS했다.
  최초 fixture 충돌 `PREVIOUS_ROOM_WORKFLOW_ACTIVE`는 두 합성 업무를 다른 객실에 배치해
  보완했다. PostgreSQL OID의 JSON 문자열 표현 때문에 실패한 assertion은 catalog query에서
  두 constraint OID를 bigint로 변환해 동일 식별자를 숫자로 비교하도록 고쳤다. migration과
  원 공유 fixture는 수정하지 않았다. 진단에는 단계/SQLSTATE/소스 행 번호만 출력한다.
- 전용 runner의 이전 독립 source/mock QA는95 PASS이며 이후 실제 실행 보완·CI 연결·
  진단 회귀가 추가됐다. 새 변경 전체의 독립 최종 QA를 이 결과로 대체하지 않는다.

후속: 진행 중인 전체11경합·fresh 및 보존 검증 → 최종
독립 QA·새 CI·dev 통합. #396 실행/복구 → #376/#378 실제 fault → #273 실제 Supabase-only B
백업/복원 → v0.9.0 배포 직전 준비 순서를 유지한다. commit/push/운영 반영은 없다.

## 27차 checkpoint — 2026-10-07 최신 dev 격리 통합 (전체 DB 진행 중)

작업공간 `330-latest-dev-integration`의 `codex/336-latest-dev-integration`에서
`dev@ac8c775beb628e4634fa68bf3afb950b819b7c16`을 기준으로 원본 388 후보를 결합했다.
원본 미커밋 후보와 기존 v0.8.0·프런트·운영은 보존한다. 아래는 소스 작업공간의 통합이며
commit/push/PR/dev 병합·운영 반영 완료가 아니다. 이후 checkpoint가 없는 한 최신 기준이다.

- 격리 공간의 `npm ci` 및 기준 Node81파일/1,831 PASS를 먼저 확인했다. 실제 겹침14파일은
  변경 구간별로 결합했고, #329 기존 로그인 세션·#318 날짜 조회·#330 공동 촛불·#332 등록
  신고·#397 `source-map-js 1.2.2`와 기존 `ajv 8.20.0`을 유지했다. 새 direct esbuild는0.28.2다.
- 개발 manifest111 / 기존110의 canonical LF SHA·순서 drift0 / v0.5.1 baseline78 /
  pending33 / head `post_approval_room_issue_ledger`; 전체5 manifest verifier PASS다.
- caller catalog를 원 #329 migration 변경 없이 정확한4확장 서명·속성·ACL로 확장했다.
  새 source read는 STABLE/owner+service-only, private fresh helper는 VOLATILE/owner-only다.
  설치 조합16개 중6/18→7/18→7/19→8/20/core2만 허용하고 partial pair·선행 누락·unknown·
  overload·NULL·helper call·ACL drift를 거부한다. 해당 Node75 PASS, 독립6파일144 PASS·P0–P2 0.
- `npm run ci:quality` PASS: Node96파일/2,363, secrets/frontend/lint/typecheck/build 포함.
  Biome error0·info17이며 모든 info가 기존 항목이라고 표현하지 않는다. 최초2,361 PASS/1 FAIL은
  developer source head를 이전 migration 이름에 고정한 회귀로, 새 exact head를 검사하도록
  정합화한 뒤 다시 PASS했다. 테스트 삭제나 검사 기준 완화는 없다.
- `npm run edge:check` exit0 PASS: 새 source/생성본·reviewed bundle manifest와 데이터-only
  명세를 확인했다. 실제 전체 후보 bundle18,262,301 bytes로20,000,000 byte 제한을 통과했다.
  이전388의18,147,616 결과를 새 통합 결과로 재사용하지 않는다.
- 전역 source OpenAPI는140 paths/151 operations 그대로이고 #336 data-only 후보는10/11/40
  (paths/operations/safe error codes)다. default runtime/API·Swagger에 등록하거나 현재 운영
  기능으로 표시하지 않았다. 실제 사용 가능한 hosted Swagger로 전달하는 작업은 후속이다.
- Python frozen 검사: Ruff/lint/format/mypy·pytest95·ephemeral codegen·package source check PASS.
  기존 binary MIME와 lifecycle schema에 대한 codegen 경고는 남으며 PASS가 무경고 또는 모든
  generated method 제공을 뜻하지 않는다. template client6순열/필드·길이·malformed 거부 PASS,
  `npm audit` 및 production-only audit 취약점0이다.
- LF 격리 검증본은 원본960개 raw SHA 보존을 확인해 생성했다. 생성 도중 부분 사본과 완료
  사본의 `.test.ts`가 Vitest에 중복 수집된 독립 진단 FAIL은 숨기지 않는다. root가 소유한
  생성본111개 unit 복사 파일만 경로 검증 후 정리하고 원본 테스트·SQL은 보존했다. driver는
  이후 tests/fixtures만 복사하며, 제외 옵션 없이 전체96/2,363 및 독립144를 다시 통과했다.
- 이 LF 검증본의 fresh111 `db:verify`, 실제 template contract, exact9 warning/catalog3
  baseline, local-synthetic backup dry-run PASS. 원본 strict lint는 FAIL/exit1이고, 의도적인
  호환 경고9개가 정확히 일치하는 별도 gate만 PASS다. 실제 Supabase-only B 운영 백업·복원을
  local-synthetic 결과로 대체하지 않는다.
- `db:test`의 기존27 upgrade와 전체 SQL은 현재 RUNNING이다. 그 뒤 static/KST/기존10개
  경합 실행기+#33618 actual overlaps·최종fresh/fixture0·새 #336 전용110→111 upgrade 검증을
  완료해야 한다. 실제 경합 실행기를 required migration CI의 `db:test:concurrency` 끝에 연결했고
  연결 회귀를 추가했지만 명령 연결만으로 actual race PASS를 선언하지 않는다.

다음 gate는 전체 DB 결과와 전용 upgrade, 정식 runtime 키 구성/API·Swagger 등록 및 재검증,
최종 독립 QA·exact-head required CI·보호 dev 병합이다. #396 실행·복구, #376/#378 실제 fault,
개발 완료 뒤 #273 실제 B 백업/복원, 별도 v0.9.0 릴리스 준비는 여전히 후속이다.
운영 migration/reset/Auth/PIN 변경·배포·tag/Release는 수행하지 않는다.

> 2026-10-06 선행 #332는 PR338/source1303b9e → dev7eec7b5로 보호 squash 병합됐다.
> exact tree3c31c895c1daa01b7ae200ec6102b906ef8c555d 동일, CI37374758461 attempt2
> application/migration PASS·독립 최종 QA 승인이다. 최초 CI CAS 실패는 원인 미확정
> 추적으로 보존한다. 이 문서의 #336 후보는 아직 새 dev에 통합하지 않았으며 운영도 미배포다.

## 2026-10-06 사용자 확정 — 관리자 공유·메이드 배정 범위

사용자 원문: “수행이나 배정 누가했는지만 기록이 남으면 되고 관리자의 모든 기능은 관리자들 끼리 공유가 가능해야함. 메이드들은 배정받은 것만 언제든 엑세스 가능하면됨.”

- 관리자 업무 기능·정보는 특정 생성 관리자에게 독점시키지 않는다. 다른 활성 관리자도 같은 관리자 기능으로 이어 처리할 수 있고, 실제 배정자·수행자·신고자·후속 처리자를 각각 기록한다.
- 메이드는 본인에게 실제 통보된 배정 이력에 연결된 업무만 접근한다. 제출·승인·담당 종료·경과 일수만으로 #336 신고/이력 접근을 막지 않는다. 원 수행자만이라는 이전 최소안을 배정 이력 기준으로 보완한다. 타 메이드 업무, 미통보 draft, 임의 객실 전체 접근은 허용하지 않는다.
- 기존 제출·봉인 사진·검수·수익·지급은 바꾸지 않고 별도 사건·새 증빙을 추가한다. 기존 사진 보존 만료가 되돌려지거나 과거 사진이 복구된다는 뜻이 아니다.
- 최신 인증 세션·활성 상태·비밀번호 변경·역할·배정 identity와 command CAS/멱등성은 유지한다. 실제 청소 수행·PIN 노출·지급 등 별도 명령의 기존 안전 전이를 무제한으로 여는 결정으로 해석하지 않는다.
- 단순 신고로 새 투숙/고객 배정을 자동 차단하지 않고 관리자의 기존 차단/해결 기능으로 결정한다. 현재 객실에 대한 판단과 과거 청소 참고 이력은 구별한다.

이 결정으로 신고 주체·관리자 공유 범위의 정책 대기를 해소한다. 기존 source 후보의 원 수행자/작성자 전용 guard를 위 기준으로 감사·보완한 뒤 검증한다. 아래 미답변/정책 대기는 과거 기록이며 구현·QA·CI·운영 완료는 아니다.

운영 배포 직전 일시중지(업무 쓰기·로그인 변경·배경 작업)도 사용자 승인됐다. 직전 안내와 복구 계획 아래 필요한 동안만 시행하고 운영 Supabase 프로젝트 자체는 Pause하지 않는다. 실제 B백업/복원·검증은 여전히 운영 반영 전 필수다.

## 2026-10-06 독립 정책 감사 — 구현 보완 순서

정적 독립 QA 결과이며 새 정책의 구현 또는 실행 검증 완료가 아니다. 기존 후보의
원 수행자/초안 작성자 전용 제한을 단순 삭제하면 다중 초안 선택, 처리자 귀속,
알림 provenance, 업로드 fence·quota가 깨질 수 있어 다음 순서로 보완한다.

1. 공동 초안의 불변 식별자와 서버가 검증하는 실제 통보 배정 이력 권한을 분리한다.
   original performer는 출처로 보존하고 권한 principal로 재사용하지 않는다.
2. 최초 작성자·수정자·최종 신고자·종결자와 업로드 실행/인계자를 각각 기록한다.
   관리자 B의 finalize가 A의 작성자 기록을 바꾸지 않도록 FK와 알림 검증을 함께 수정한다.
3. 관리자 공동 업로드·복구에 새 claim/fence를 적용하고 이전 fence를 무효화한다.
   actor별 receipt·quota charge·provider identity와 보상 삭제 증명은 유지한다.
4. 역사 접근 검사와 신규 신고 상태 검사를 분리한다. 원 제출이 반려되거나
   superseded되어도 기존 사건 조회·증빙 열람·관리자 종결은 계속 가능해야 한다.
5. source/draft/list/finalize/evidence/content/close와 Fastify·Edge·OpenAPI를 함께
   통합하고 본인 배정 이력의 과거 사건 발견 경로도 확인한다.
6. 관리자 A→B→C 이어 처리, 메이드 본인 이력/타인 거부, CAS 동시 승자,
   provider 응답 유실·인계, 세션 철회, 원 자료 불변, 보존 만료, 알림 중복 방지를
   실제 DB·동시성 테스트와 최종 독립 QA로 검증한다.

현재 소스 후보는 위 최신 정책에 아직 미충족이며, 이전 테스트 PASS는 변경 전
후보에 대한 결과다. 기존 사진의 168시간 보존 등 별도 수명 정책은 연장하지 않는다.

### 1차 보완: 역사 접근과 신규 신고 상태 분리

원격 미게시·미적용 #336 SQL 후보에 private historical-access helper를 분리했다.
source/초안 복구/목록/단건/증빙 열람/관리자 종결은 이 검사를 사용하고 신규 초안 저장·
최종 신고·업로드의 기존 submitted/approved 조건은 유지한다. 사진 만료·delete barrier·
세션·admin-only 종결·원 자료 불변 검사는 완화하지 않는다. 응답 계약은 반려/대체 상태도
허용하되 이를 새 신고 자격으로 사용하지 않는다.

관련 Node7파일/311 tests, typecheck 및 build PASS. 전체 npm test는1,934 PASS/1 FAIL로,
기존 미등록 SQL 후보 때문에 manifest103/실제104가 불일치하는 검사가 실패했다.
이는 이전과 같은 통합 전제이며 이번 변경을 정상 완료 commit으로 만들지 않는다.
이후 #332 source7f3e5f4의110개와 이 후보를 결합한 SHA 동일 LF 사본에서 fresh111 적용과
전용 SQL106 assertions(기존95+추가11)이 실제 exit0 PASS다. 반려·대체 상태 fixture는
격리 savepoint에서만 구성하고 rollback해 기존 원 자료 digest 불변을 확인했다.
최종 readback은 migration111/profile0/incident report0/helper runtime grant0이며,
원본116개 hash drift0다. 이 결과는 전체111개 SQL/upgrade/동시성 검증의 대체가 아니다.
관리자 공동 초안/업로드 인계와 메이드 실제 통보 이력 권한은 여전히 후속이다.
이 변경은 미등록 후보이며 commit/push/운영 반영 완료가 아니다.

### 2차 보완: 관리자 공동 초안·실제 처리자 분리

2026-10-06 미게시 후보에서 활성 관리자는 다른 작성자의 draft를 조회·메모 수정·최종
신고할 수 있다. `(source_submission_id, client_report_id)` UNIQUE로 같은 초안을 공유하며,
기존 creator/client UNIQUE도 유지한다. draft 최초 작성자는 불변이고 memo revision에는
실제 actor FK/index를 추가했다. report는 최초 draft 작성자와 실제 최종 신고자를 분리해
복합 provenance FK, 기존 actual-actor 감사/알림 검증 및 service 응답 검증을 보존한다.
다른 메이드의 draft 권한이나 upload/quota/compensation 인계를 함께 연 것으로 해석하지 않는다.

실제 검증:

- #332 `1303b9e`의 110 migrations + 미적용 후보 SHA 동일 LF 사본: fresh111 reset PASS.
- 전용 pgTAP121 PASS(기존106 + 관리자 공동 처리15), 관련 Node7파일/312 PASS.
- 실제 두 DB 세션 lock overlap16 PASS: 새 관리자 create/edit/finalize 경합3 + 기존13.
  관리자별 CAS0 중복 생성·stale revision 수정·중복 finalization은 한 승자만 허용한다.
  원 제출/사진/봉인/수익/지급/객실 전체 digest 불변, fresh cleanup PASS.
- typecheck/build/lint PASS(lint 기존 info5, 오류0). 전체 npm test는 1,935 PASS/1 FAIL:
  미등록 source manifest103/실제104 불일치이며 정상 완료 commit을 만들지 않았다.
- local Security Advisor warn/error0, 최종 migration111/profile0/report0/public RLS 누락0.
  검증 원본118개 hash drift0. 실제 Drive 호출·운영 데이터 조작 없음.
- 독립 read-only QA: 이번 좁은 delta 수정 필수 P0/P1/P2 없음. 전체 완료 승인은 아니다.

후속: 관리자 upload 인계의 claim/fence/quota, 실제 통보 이력 메이드 권한, 관리자 role
downgrade 전용 회귀, 최신 dev/정식 manifest/API/Edge 통합과 전체 검증·CI. 전체111개
upgrade/SQL 회귀 실행을 이번 전용 검증으로 대체하지 않는다. commit/push/운영 반영 없음.

### 3차 보완: migration 목록 미등록 테스트 오류 해소

2026-10-06 사용자 요청에 따라 현재 작업 브랜치의 실제 SQL104개를 공식 생성기
`npm run db:manifest:generate`로 개발 manifest에 등록했다. 기존103개 entry/hash는
그대로이며 #336 한 건의 이름·순서·LF SHA와 count/head만 추가했다. Edge 개발자 진단의
expectedMigrationName과 해당 Deno 회귀도 같은 head로 맞췄다. 검사를 skip하거나 허용
기준을 완화하지 않았다. 위 1 FAIL 문구는 수정 전 실행 이력이다.

- `npm run db:manifest:verify`: 5종 PASS.
- `npm run ci:quality`: PASS(전체 Node77파일/1,936개, secret scan, 공개 OpenAPI 검사,
  lint, typecheck, build 포함).
- `npm run edge:check`: Deno476 PASS, bundle17,530,911 bytes gate PASS.
- 독립 QA가 추가 발견한 developer_operations SQL의 이전 head 기대값도 수정했다.
  current/expected/delete는 #336으로 고정하고, 이전 head는 삭제 전 실제 migration history의
  직전 version을 보존해 비교한다. `supabase test db ...developer_operations.sql --local`은
  기존 검증용111 DB에서33 PASS다. 첫 raw psql 시도는 pgTAP 초기화/search_path 부재로
  plan 함수 오류(exit3)였으며 공식 test CLI의 초기화로 해결했다.

이104개는 **현재 feature branch 소스 목록**이다. 선행 #332와 합친 검증용111개 또는
최신 dev 통합 완료를 뜻하지 않는다. SQL 본문·DB 상태·공개 API 등록은 이번에 변경하지
않았다. 앞선 fresh111/SQL121/동시성16 검증은 해당 union에서 실행한 별도 근거로 유지한다.
관리자 upload 인계·메이드 이력 권한과 최신 dev 통합·전체 DB/CI gate는 계속 후속이다.

### 4차 보완: 관리자 역할 변경 후 기존 세션·receipt 차단 회귀

독립 QA 권장 항목을 보완했다. admin B가 다른 관리자의 초안을 조회·수정하고 성공 receipt를
얻은 뒤, 합성 fixture의 DB role만 maid로 바꿔 동일 live session으로 다시 요청한다.
조회·새 수정·기존 성공 receipt 재생·최종 신고는 각각42501 ACCESS_REQUIRED로 거부되고
기존 revision2건은 유지된다. 원 수행자가 아닌 actor의 source 접근 guard 검사이며,
계정 role 변경 lifecycle·creator fence 단독 검사·동시 역할 변경 경합은 이 회귀 범위가 아니다.
fixture 변경 후 trigger를 복구한 상태에서 RPC를 실행하고 savepoint rollback으로 정리한다.

- SHA 동일 LF 검증 union111 fresh reset 및 전용 SQL126 PASS(기존121+5).
- `npm run ci:quality` PASS: Node77파일/1,936개·typecheck·build 등 전체 품질 검사.
- 독립 read-only QA PASS, 수정 필수 문제 없음. 제품SQL/API/권한 정책 변경 없음.
- #332 CI attempt2는 기록 시점 migration의 db:test 실행 중이며 병합·배포 완료가 아니다.

### 5차 보완: 공동 초안에 관리자 본인 명의의 새 사진 업로드

원격 미게시·미적용 SQL 후보에서 admin은 다른 작성자의 draft에 자기 admission/permit으로
새 업로드를 시작한다. draft creator·원 수행자는 보존하고 admission actor가 실제 업로더다.
신규/retry/operation/quota refresh와 compensation에서 현재 admin-or-creator 권한을 확인한다.
operation과 compensation prepare/settle은 admission actor 일치도 별도로 요구한다.
정확한 fence를 안다는 사실 또는 최초 draft 작성자라는 사실만으로 타인의 operation을
실행·정리하지 못한다. 다른 actor의 진행 중 업로드 인계는 아직 구현하지 않았다.

- SHA 동일 LF union111의 fresh reset PASS. 첫 SQL 실행은 이전 safe-integer 테스트가
  revision을 올린 draft를 새 fixture로 재사용해 CAS 오류로 실패했다(57 assertions 후 중단).
  제품 CAS 검사는 그대로 두고 별도6088 초안으로 분리해 SQL136 PASS, provider 합성
  전구간/acceptance/accepted 삭제 거부를 추가한 최종 SQL139 PASS(기존126+13).
- 새 regression은 원 수행자를 잠시 admin으로 올려 타 creator permit/admission을 만든 뒤
  maid로 복귀시킨다. source 접근 자체는 유효한 상태에서도 quota refresh/retry/begin이
  draft 권한 회수로 거부된다. 계정 변경은 격리 합성 fixture이며 실제 lifecycle 검증은 아니다.
- `npm run ci:quality` PASS: Node77파일/1,936개, typecheck/build/lint/secret/OpenAPI 검사.
  공식 manifest 생성·5종 검증 PASS. 기존103개 migration을 바꾸지 않고 후보104만 갱신했다.
- 독립 read-only QA PASS, 수정 필수 P2 이상 없음. 실제 Drive 호출은 NOT RUN이다.
- 기존 실제 lock overlap16/원 자료 digest 불변/fresh cleanup 재실행 PASS. 신규 관리자 간
  업로드 경합 검증으로 승격하지 않는다. local Security Advisor warn/error0, 최종
  migration111/profile0/report0, 검증 원본118개 hash drift0을 확인했다.

후속 회귀: 타 actor settle compensation 직접 호출, downgrade 후 claim/accept/compensation,
provider 왕복 중 역할 변경 경합 및 관리자 간 collection CAS 경쟁을 추가한다. 기존 operation
인계·메이드 실제 통보 이력 접근·정식 API/Edge 등록·최신 dev 통합·전체 release 검증은
미완료다. 이 후보는 commit/push/운영 반영하지 않았다.

### 6차 보완: 업로드 인계 전 권한 회수·보상 삭제 회귀

5차 독립 QA의 누락 회귀를 추가했다. 실제 삭제는 실행하지 않으며 provider metadata와
404 결과는 합성 입력이다. 현재 미게시 제품 SQL/서비스/API는 이 단계에서 바꾸지 않았다.

- 공유 draft의 실제 uploader가 date-mismatch 증거로 prepare에 성공해 얻은 정확한
  operation/fence/delete token을 원 작성자가 사용해도 settle은42501로 거부한다.
- 원 수행자이기도 한 uploader의 DB role을 admin에서 maid로 변경한 뒤 같은 live session과
  기존 fence로 claim/accept/prepare/settle을 호출해 모두42501 ACCESS_REQUIRED를 확인했다.
  source 권한이 남아 있어도 다른 작성자 draft의 관리자 업무 권한은 이어지지 않는다.
- date-mismatch 상태의 accept 거부만으로 충분하다고 보지 않고 별도 provider_succeeded
  정상 객체를 추가했다. 정상 수락 가능한 상태에서도 강등 후 accept가 거부되며 acceptance
  0건과 provider_succeeded 상태가 유지된다. 미종결 delete barrier와 locator도 그대로다.
- 전용 SQL149 PASS(기존139+10), ci:quality Node77파일/1,936개·typecheck/build 등 PASS.
  같은 migration SHA의 기존 local111 DB에서 실행했다. 이번 단계의 fresh reset·전체 DB
  suite·동시성 재실행으로 표현하지 않는다. 최종 migration111/profile0/report0,
  원본118개 hash drift0이다. fixture는 savepoint/transaction rollback으로 정리했다.
- 독립 read-only QA는 최초7개 및 정상 수락 경계 추가3개 모두 PASS, 수정 필수 문제 없음.

다음 인계 구현에서는 최초 admission actor/receipt와 현재 실행 claim actor를 구별해야 한다.
새 실행자·인계 이력을 남기고 새 fence로 이전 실행자를 차단하며, 결과 불명 provider 작업은
동일 identity를 재조회해야 한다. 원 rate/quota 기록 덮어쓰기나 객체 재생성은 허용하지 않는다.
실제 동시 역할 변경·인계 경합과 adapter 복구 진입점은 아직 구현·검증하지 않았다.
이는 인계 완료가 아닌 선행 보안 회귀 완료다. commit/push/병합/운영 변경은 없다.

### 7차 보완: 관리자 인계 요청의 독립 명령 계약

인계의 입력/멱등성 foundation을 `post-approval-room-issue-handover-contract.ts`에 구현했다.
이 파일은 아직 서비스/DB RPC/route에 연결되지 않았으며 실제 권한 판정·인계는 수행하지 않는다.

- client 입력은 operationId와 expectedLeaseVersion뿐이다. 대상 actor·기존 uploader·session·
  provider identity·fence·force 플래그는 strict schema로 거부한다. 새 실행자는 추후 검증된
  인증 actor 본인으로만 결정하고 DB에서 최신 admin/session을 다시 확인해야 한다.
- 현재 upload의 lease 최대8을 유지한다. 인계는 새 version을 필요로 하므로 expected는0..7만
  허용한다. 인계 횟수로 카운터를 초기화하거나 기존 기술 상한을 늘리지 않는다.
- actor+독립 handover command+key를 receipt 범위로, operation/version을 payload hash로
  결합한다. 같은 key로 payload가 바뀌면 DB가 충돌을 판정할 수 있고 session 갱신은 동일
  논리 요청을 유지한다. 기존 upload 명령의 receipt와 섞이지 않는다.
- 새42개 회귀와 전체 ci:quality PASS: Node78파일/1,978개, typecheck/build/lint 등.
  순수계약 변경이므로 이번 DB reset/SQL/Edge/실제 provider 검증은 NOT RUN이다.
- 독립 read-only QA PASS, 수정 필수 P2 이상 없음. 실제 인증/권한/CAS/인계 검증으로
  확대 해석하지 않는다. expectedLeaseVersion0의 실제 인계 가능 상태도 DB에서 판정한다.

다음 필수 구현은 immutable 인계 이력·현재 실행자·lease CAS/fence 회전 DB 명령,
quota/in-flight 제한, 기존 operation의 복구 adapter 및 공개 route/Edge/OpenAPI 연결이다.
아직 관리자가 실행 중인 다른 업로더 operation을 넘겨받을 수 있다고 안내하지 않는다.
전체 #336이 미완료이므로 commit/push/병합/배포하지 않았다.

### 8차 보완: 관리자 업로드 인계 DB 명령과 동시성

2026-10-06 미게시·미적용 후보에 immutable handover 원장과 현재 executor 조회를 추가했다.
활성 관리자 본인으로 인계하며 원 admission actor와 provider identity는 덮어쓰지 않는다.
lease CAS·새 fence·현재 실행자 변경은 같은 transaction이고, 이전 실행자의 후속 operation과
compensation은 차단한다. admit/begin의 최초 receipt identity는 원 actor 기준을 유지한다.
동일 handover receipt는 lease 시간을 늘리지 않으며 이후 인계로 밀려난 receipt는 복구되지 않는다.
원 admission과 새 executor의 in-flight 제한을 모두 유지하되 storage reservation은 복제하지 않는다.

- SHA 동일 LF union111 fresh reset PASS. 전용 pgTAP176 PASS: 타 역할 거부, 현재 executor,
  이전 fence 거부, 실제 accept, receipt 충돌/재생, 원장 불변, rate30/in-flight8 경계,
  만료 세션 receipt 차단 및 기존 업무 자료 digest 보존을 포함한다.
- 실제 DB 동시성18 PASS: 기존16 + 관리자 동시 인계 CAS와 인계 직후 이전 executor 거부2.
  첫 실행은 테스트 harness의 safe error 목록에 `PHOTO_UPLOAD_FENCE_CONFLICT`가 없어
  실패했다. 해당 코드만 추가하고 거부 assertion은 유지해 재실행 PASS, cleanup PASS다.
- `npm run ci:quality` PASS: Node78파일/1,978개, typecheck/build 및 품질 검사.
- 정적 검사에서 발견한 후보 경고6건은 미사용 변수 제거·guard 호출 보존·JSON 명시 타입으로
  해소했다. exact baseline9/catalog3 비교 PASS이며 **원 strict lint는 기존9건으로 FAIL/exit1**다.
  최초 후보 경고 포함 실패 로그도 보존한다. 경고 기준·검사를 완화하지 않았다.
- 최종 local Security Advisor warn/error0. readback migration111/profile0/report0/handover0,
  원본119개 SHA drift0. 실제 Drive 호출 및 운영 데이터 변경 없음.
- 독립 read-only QA: 좁은 DB handover delta에서 수정 필수 P2 이상 없음. SQL/동시성
  실행은 주 작업자의 로그를 검토했으며 QA가 DB를 별도로 재실행한 것은 아니다.

후속은 안정적인 요청별 server fence를 쓰는 복구 adapter, 공개 route/Edge/OpenAPI 연결,
메이드 실제 통보 이력 접근, 상태별 인계/보상 회귀, 최신 dev 통합 및 전체 SQL·CI 검증이다.
공개 기능 또는 #336 전체 완료가 아니며 commit/push/병합/운영 배포는 수행하지 않았다.

### 9차 보완: 인증 actor 기반 인계 서비스 adapter

2026-10-06 별도 미등록 `SupabasePostApprovalRoomIssueHandoverService`를 추가했다.
기존 증빙 서비스의 인증 후 actor/session 추출기를 공유하고 admin·비밀번호 변경 여부를
사전 검사한다. JWT 파싱은 인증 검증을 대체하지 않으며 향후 route는 기존 authenticate를
반드시 먼저 실행해야 한다. 클라이언트는 operation/expected lease/key만 선택할 수 있다.

- 전용 서버32byte 키를 복사해 private field에 보관하고 domain-separated HMAC으로
  actor/command/key/payload에 묶인 fence를 만든다. 같은 요청은 세션 갱신·서버 재시작·
  여러 replica에서도 같은 키가 주입되면 동일 fence를 사용한다. 매 요청 DB RPC를 호출하며
  성공 receipt 캐시로 현재 권한 검사를 건너뛰지 않는다.
- 응답은 기존 안전 projection만 반환하고 operation identity·정확한 다음 lease를 검사한다.
  fence/provider locator/session/원문 DB 오류는 공개하지 않는다. provider 호출·원 업로더
  impersonation·사진 재업로드/삭제는 이 adapter에서 수행하지 않는다.
- 런타임 키 생성/저장/환경변수 연결은 아직 없다. 재생 가능한 **완료 receipt까지** 같은
  키를 유지해야 하며 향후 키 교체에는 명시적 versioned migration 설계가 필요하다.
  임의 키 자동 생성, PIN/기존 인증키 재사용, 운영 secret 변경을 하지 않았다.
- 최초 단위 실행32 PASS/1 FAIL은 accepted 합성 fixture의 revision0 때문이었다.
  실제 accepted 계약인 revision1로 fixture만 수정했다. 응답 유실 재시도 회귀도 추가했다.
- 최종 `npm run ci:quality` PASS: Node79파일/2,012개(신규 adapter34), typecheck/build,
  secret/OpenAPI 검사, lint 오류0·기존 info5. 독립 read-only QA에서 수정 필수 P2 이상 없음.
  QA는 테스트를 별도 실행하지 않았으며 완료 receipt 키 보존 주의사항을 문서에 반영했다.
- SQL/manifest/DB 권한은 이번 단계에서 변경하지 않았다. 이전 fresh111/SQL176/동시성18은
  8차 실행 근거이며 이번 adapter의 실제 DB/HTTP 종단 검증으로 표현하지 않는다.

아직 공개 route/Edge/runtime에 등록하지 않았으며 실제 provider 복구와 메이드 이력 접근,
최신 dev 통합·전체 DB/CI가 후속이다. 전체 #336 미완료로 commit/push/배포하지 않았다.

### 10차 보완: 인계 후 기존 사진 inspect 복구와 만료 lease 재획득

2026-10-06 서버 내부 복구 dependency를 인계 서비스에 연결했다. fresh DB 상태와 원본
operation/evidence/metadata를 확인하고 현재 실행자의 receipt-derived fence로 claim한다.
live lease는 재사용하고 만료 lease만 기존 상한8 안에서 다음 version으로 재획득한다.
동일 요청 receipt는 현재 actor·동일 fence·원 인계 이상 lease일 때 현재 상태를 반환한다.
receipt 재생 자체는 lease를 연장하지 않고 최초 인계 원장도 바꾸지 않는다.

기존 provider identity를 inspect하기 전후로 fresh session/fence를 다시 검사하고 실제
provider 생성 시각을 기록한 뒤 원 evidence CAS로 accept한다. 원 업로더로 위장하거나
새 identity·파일·폴더·quota reservation을 만들지 않는다. decoder·upload·delete도 호출하지 않는다.
identity가 없거나 provider 결과가 불확실하면503으로 보존하고, 날짜 불일치는 compensation_pending에
남긴다. compensation 삭제·원본 재전송은 별도 복구 경로가 필요하다. accepted 응답 유실은
현재 상태 재조회로 복구하며 다른 관리자로 인계된 이전 실행자는 claim을 거부한다.

- 초기 독립 QA P2: 인계 후5분 경과 시 같은 관리자가 재개 불가. 위 same-fence bounded claim과
  immutable receipt 재생으로 수정했다. 재검토에서 코드상 해소, 추가 수정 필수 P2 이상 없음.
- Node 전용2파일149 PASS, 최종 ci:quality79파일/2,032개·typecheck/build PASS.
  첫 품질 실행의 mock MIME string 타입 오류는 fixture literal 타입을 명시해 보완했다.
- 후보 SQL과 manifest만 변경했으며 기존 적용 migration은 수정하지 않았다. SHA 동일 LF
  union111 fresh reset과 SQL185 PASS(기존176+만료/재획득/재시도/원장 보존/타 실행자 거부9).
  DB 검증은 실제 PostgreSQL이고 provider 응답은 Node 합성 stub이다. 실제 Drive/HTTP/Edge
  종단 실행 또는 운영 검증을 완료했다고 표현하지 않는다.
- 최종 실제 DB 동시성18·fresh cleanup PASS. exact lint baseline9/catalog3 PASS이나
  원 strict lint9 FAIL/exit1은 유지된다. local Security Advisor warn/error0,
  readback migration111/profile0/report0/handover0, 검증 원본119 SHA drift0, manifest5종 PASS.

공개 route/Edge/runtime 키 관리, 미연결 업로드·보상 복구, 메이드 통보 이력 권한,
최신 dev 통합·전체 SQL/CI가 남았다. 전체 #336 미완료로 commit/push/병합/배포하지 않았다.

### 11차 보완: 미등록 관리자 인계 HTTP 경계와 로그 비노출

2026-10-06 관리자 인계 서비스의 `recover`를 호출하는 독립 Fastify 경로
`POST /v1/post-approval-room-issue-evidence-uploads/:operationId/handover`를 추가했다.
인증·비밀번호 변경 완료·관리자 역할을 먼저 확인하고 UUID, lease CAS 0–7,
단일 Idempotency-Key, strict body, query 금지, 1KiB body 상한을 검사한다.
응답은 공개 projection으로 다시 제한하고 operation identity 및 증가한 lease를 검증한다.
오류 상세는 숨기며 응답에는 no-store를 적용한다.

독립 QA에서 기본 요청 로그가 거부 전 raw query를 기록하는 P2 1건을 재현했다.
해당 route에 `logLevel: 'silent'`를 적용하고 실제 trace logger가 켜졌음을 확인하는
positive control 및 query canary 비노출 회귀를 추가했다. 독립 재검증 결과는 P0/P1/P2 0건이다.

- PASS: 전용 HTTP 테스트 18건(독립 QA 재실행 포함).
- PASS: `npm run ci:quality` — secret scan, OpenAPI 137 paths/148 operations,
  lint(기존 info 5건), typecheck, 80 files/2050 tests, build.
- 초기 typecheck의 unknown error 접근 오류는 object guard로 수정한 뒤 전체 검사를 재실행했다.
- 미완료: app/runtime 등록, 영속 전용 인계 키 연결, Edge/OpenAPI parity,
  최신 dev 통합 및 실제 DB 경유 전체 검증. 이번 검증에서 DB reset/migration은 실행하지 않았다.
- 작업 트리 전체 `git diff --check`에는 기존 DBML 끝의 추가 빈 줄 경고가 남아 있다.
  무관한 EOL 변경은 보존했고 이 checkpoint를 커밋·push하지 않았다.

### 12차 보완: 관리자 인계 OpenAPI 후보 계약

2026-10-06 `postApprovalRoomIssueHandoverOpenApiFragment`를 별도 추가했다.
기존 evidence 3개 경로와 전역 공개 OpenAPI는 변경하지 않았다. 관리자 전용 bearer 인증,
UUID 경로, 단일 멱등 키, query 금지, strict lease CAS 0–7, JSON 1024-byte 상한,
no-store 및 내부 정보 없는 operation 응답을 명세화했다. 원 처리자 이력 보존과 기존
provider identity inspect-only 복구를 명시하며 source-only-unregistered 상태를 유지한다.

- 실제 HTTP 응답의 필드·캐시 헤더와 명세를 대조하는 회귀를 추가했다.
- PASS: `npm run ci:quality` — 80 files/2051 tests, typecheck/build, secret scan,
  기존 공개 OpenAPI 137 paths/148 operations, lint 기존 info 5건(신규 경고 없음).
- PASS: 독립 QA의 handover HTTP 테스트 19건 및 route/service/명세 대조, P0/P1/P2 0건.
- 아직 로컬 미커밋 후보다. 전역 등록·Edge parity·전용 키·최신 dev/DB 통합 검증은 미완료다.
  이번 단계에서는 DB 또는 운영 API를 변경하지 않았다.

### 13차 보완: HTTP와 실제 인계 서비스 연결 회귀

2026-10-06 실제 Fastify handover plugin과 실제 handover service를 연결한 회귀 5건을
추가했다. 인증 hook, RPC 응답, provider 복구 경계만 합성 대역이다. 세션 교체 시 최신
session 전달과 안정적인 receipt/fence, 재시도 시 DB 권한 재확인, revoked session의 401,
복구 의존성 미설정 시 ownership RPC 전 503, 응답 유실 재시도, 잘못된 session binding의
RPC 전 401을 검증한다. 내부 provider/fence canary는 공개 응답에 나타나지 않는다.

- PASS: `npm run ci:quality` — 81 files/2056 tests, typecheck/build, secret scan 886 files,
  공개 OpenAPI 137 paths/148 operations, lint 기존 info 5건.
- 실제 Auth 토큰 검증·PostgreSQL·Drive E2E가 아니다. app/Edge/runtime 등록과 최신 dev
  통합 및 실제 DB 검증은 여전히 남아 있다. 테스트와 문서만 추가했으며 DB 변경은 없다.
- 독립 QA: 신규 5건 재실행 PASS, P0/P1/P2 0건. 응답 유실 검사는 mock RPC reject 후
  동일 인자 재전송만 증명하며 실제 DB commit 후 exactly-once 또는 provider 복구 증명이 아니다.
- Supabase [session 문서](https://supabase.com/docs/guides/auth/sessions)의 session_id와
  실제 세션 재확인 기준 및 changelog를 대조했다. SDK/DB 버전이나 Auth 설정은 변경하지 않았다.

### 14차 보완: 신고·증빙·인계 HTTP 모듈 결합

2026-10-06 세 경로 plugin을 sibling scope로 등록하는
`createPostApprovalRoomIssueModule`을 추가했다. 상위 앱의 검증된 인증 hook과 명시적인
서비스 주입을 요구하며, import만으로 app/Edge 경로·worker·키·provider를 활성화하지 않는다.
증빙 raw-stream parser와 오류 handler를 별도 scope에 두어 신고/인계 JSON parser 및
상위 앱의 기존 경로에 영향을 주지 않도록 구성한다.

- 합성 서비스로 binary 업로드 → JSON 인계 → JSON 신고 종결 → 상위 JSON 경로를
  같은 앱에서 실행해 parser 격리, 인증 호출, 요청 인자, body 상한을 검증했다.
- PASS: `npm run ci:quality`, 82 files/2058 tests, typecheck/build, secret scan 888 files,
  공개 OpenAPI 137 paths/148 operations, 기존 lint info 5건.
- 전역 app/Edge 등록·runtime 키·실제 DB/Drive 검증은 미완료다. 새 조립 모듈과
  테스트만 추가했으며 운영 및 DB 변경은 없다.
- 독립 QA PASS: 신규 2건 및 handover 관련 3파일 26건 재실행, P0/P1/P2 0건.
  인증 호출은 합성 hook 검증이며 실제 인증을 검증한 것으로 해석하지 않는다.

### 15차 보완: 명시적 런타임 서비스 구성

2026-10-06 `createPostApprovalRoomIssueRuntime`은 clients/provider/decoder와 전용 영속
32-byte 인계 키를 명시적으로 주입받아 실제 신고·증빙·인계 서비스를 구성한다.
인계 복구는 같은 evidence 인스턴스에 연결하여 receiver를 유지한다. 환경변수 자동 읽기,
키 자동 생성·PIN/Auth 키 대체, worker 시작 또는 app/Edge 등록은 하지 않는다.
구성 단계에서 DB/Drive 호출이나 decoder 초기화를 실행하지 않는다.

- PASS: `npm run ci:quality` — 83 files/2063 tests, typecheck/build, secret scan 890 files,
  공개 OpenAPI 137 paths/148 operations, 기존 lint info 5건.
- 신규 5개 검사는 구성 부작용 없음, 잘못된 키 길이 차단, 실제 Supabase client의 RPC를
  합성 fetch 응답으로 연결했을 때 handover→동일 evidence receiver 전달을 확인한다.
  DB·Auth·Drive·실제 provider 복구를 검증한 것은 아니다.
- app/Edge 활성화·배포 키 준비·최신 dev/최종 정책/실제 DB 통합은 남아 있다.
  이번 변경은 로컬 미커밋 후보이며 운영 설정이나 데이터를 변경하지 않았다.
- 독립 QA PASS: 신규 5건, 관련 3파일 12건 재실행 PASS, P0/P1/P2 0건.

### 16차 보완: 신고 HTTP 오류 응답 비노출

2026-10-06 연결 전 점검에서 신고 plugin이 AppError의 원문 message와 임의 requestId를
응답하는 경계를 발견했다. 신고 경로 전용 code/status allowlist와 고정 한국어 메시지,
UUID requestId 또는 unavailable을 적용했다. 미등록 code는 generic 500으로 닫고
오류 code getter의 예외도 원문 없이 처리한다. 기존 인증·CAS 오류 code와 no-store는 유지한다.

- 신규 4건으로 알려진 오류의 status 정규화, 임의 AppError code·원문 예외·throwing getter,
  비-UUID requestId의 canary 비노출을 검사했다.
- PASS: `npm run ci:quality` — 83 files/2067 tests, typecheck/build, secret scan 890 files,
  공개 OpenAPI 137 paths/148 operations, 기존 lint info 5건.
- 이 경로는 여전히 운영 미등록 후보이며 운영 취약점 재현이나 운영 수정 완료를 뜻하지 않는다.
  app/Edge·정책·실제 DB 통합은 미완료다. DB/운영 설정 변경 없이 로컬 후보만 보완했다.
- 독립 QA PASS: API/module 2파일 48건 재실행, 실제 service/contract/auth 오류 코드 대조,
  P0/P1/P2 0건. 미등록 오류를 500으로 바꾼 합성 fixture는 실제 서비스 호출 검증을 유지한다.

### 17차 보완: 실제 buildApp의 로컬 명시 주입 연결

2026-10-06 `buildApp`에 선택적 `postApprovalRoomIssueServices`를 추가했다.
명시 주입한 경우에만 #336 모듈을 등록하며 `APP_ENV=local`이 아니면 앱 구성 전에 거부한다.
기본 실행에서는 경로가 404이고 환경변수·키·provider 자동 구성을 추가하지 않는다.
이는 기본/운영 미등록을 유지한 로컬 앱 통합 지점이지 운영 활성화가 아니다.

- 실제 앱의 bearer 추출·인증 hook·임시 비밀번호 guard 아래 인계 경로를 실행했다.
  Auth 서비스 자체와 업무 서비스는 합성 대역이며 실제 Auth/DB 검증이 아니다.
- 신규 4건: 기본 404, development/production 주입 거부, 로컬 정상 응답·토큰 누락401·
  임시 비밀번호403·세션 철회401·원문 오류 비노출·no-store를 확인했다.
- 초기 테스트 fixture의 문자열 타입 확장으로 typecheck가 실패했고 literal 타입을 지정해
  전체 재실행했다. PASS: `npm run ci:quality`, 83 files/2071 tests, typecheck/build,
  secret scan 890 files, 공개 OpenAPI 137 paths/148 operations, 기존 lint info 5건.
- `git diff --check -- src/app.ts tests/app.test.ts` PASS. 전체 기존 DBML EOF 경고는 별도다.
- Edge·배포 키·메이드 실제 통보 이력 정책·최신 dev 및 실제 DB 통합은 아직 남아 있다.
  운영 API/DB/Auth/PIN은 변경하지 않았고 로컬 변경은 아직 커밋하지 않았다.
- 독립 QA: `tests/app.test.ts` 61건 PASS, P0/P1/P2 0건. server/Edge/env 자동 활성화 없음 확인.

### 18차 보완: 서버 통보 배정 이력 근거의 응답 계약

2026-10-06 응답 변환의 원 수행자 전용 제한을 보완하기 위한 private RPC 계약을 추가했다.
`notifiedAssignmentAccess`는 actor/session/sourceSubmission 및 실제 assignment ID/revision/
notifiedAt을 가진 서버 전용 근거다. actor/session/source 일치와 형식을 검사하며, 일치하면
비원수행 메이드의 공개 ownership을 `notified_assignee`로 표시한다. 원 수행자 provenance는
보존하고 private 근거는 공개 응답에서 제거한다. draft/finalize 요청에 같은 필드를 넣으면 거부한다.

이는 DB 권한 증명 자체가 아니다. 기존 SQL은 아직 원 수행자만 허용하며 이 근거를 발급하지
않으므로 메이드 통보 이력 접근 기능은 **미완료**다. 다음 DB 구현은 동일 historical target의
실제 통보 assignment를 조회·검증하고 actor/session/source에 묶어야 한다. 현재 객실·다른 target·
미통보 draft를 근거로 삼거나 caller 입력을 복사하면 안 된다. snapshot 권한과 신규 신고 상태
검사를 계속 분리하고 알림 provenance 검사도 함께 보완해야 한다.

- 신규 11건: 4개 역사 상태, actor/session/source 바꿔치기, 잘못된 assignment/revision/통보시각,
  클라이언트 권한 입력 거부와 private 근거 비노출.
- PASS: `npm run ci:quality` — 83 files/2082 tests, typecheck/build, 기존 lint info 5건.
- OpenAPI 독립 후보 enum만 확장했고 공개 OpenAPI 137 paths/148 operations는 불변이다.
  DB/migration/운영 변경 및 commit은 하지 않았다.
- 독립 QA: contract/API 2파일 110건 PASS, P0/P1/P2 0건. P3 명세 설명 보완 의견에 따라
  통보 이력의 서버 근거 필요 및 DB 발급 미구현을 후보 OpenAPI 설명에도 명시했다.

### 19차 보완: 실제 통보 이력 DB 접근 및 알림 주체 검사

2026-10-06 원격 미게시 #336 후보에 private STABLE 통보 배정 조회 helper를 추가했다.
동일 cleaning target·actor의 notified_at이 있는 assignment만 사용하며 current/ended 또는
날짜 경과로 제한하지 않는다. source 접근 및 신고 알림의 실제 행위자 검사를 이 helper에
연결하고 active role/status/password/session, 원 source tuple, 새 신고 상태 검사는 유지했다.
원 수행자와 배정 원장을 변경하지 않으며 helper의 모든 runtime EXECUTE는 차단한다.

- Docker Desktop running/server29.7.2 확인 후 기존 local111 DB/profile0에서만 검사했다.
- 세 함수 delta와 pgTAP 설치를 하나의 transaction 안에서 임시 적용한 뒤 전용 fixture를
  실행하고 전부 ROLLBACK했다. 191 assertions/plan1..191 PASS, not-ok0, exit0.
- 신규6건: 미통보 거부, 종료 통보 비원수행 허용, 다른 target 거부, 원 수행자 불변,
  exact assignment 조회 및 private helper runtime ACL 차단.
- readback profile0, 새 helper 부재 확인. 업무/운영 데이터 및 migration history 변경 없음.
- 초기 harness는 PowerShell replacement의 dollar quoting과 pgTAP 미설치로 실패했다.
  문자열 연결 및 transaction 내 extension/search_path 구성으로 보완했다. 신규 savepoint
  rollback이 pgTAP counter도 되돌리는 문제는 최종 전체 rollback만 사용하도록 고쳐 plan191 확인.
- 새 migration 전체 fresh reset은 **NOT RUN**이다. 이 결과는 설치된 local111 위의 함수 delta
  회귀이며 후보 migration 전체 검증이 아니다. 미적용 후보 manifest의 canonical LF hash만 갱신했다.
- API private grant 발급은 아직 미구현이다. 특히 receipt에 session-bound 근거를 저장하면
  세션 갱신 재시도가 깨지므로 receipt 자체는 보존하고 반환 직전 fresh 근거를 재구성해야 한다.
  실제 API 권한 확대·Edge·최신 dev 통합·전체 검증은 여전히 미완료다.
- 초기 Node 정적 검사 1건은 폐기된 원 수행자 비교문 기대값 때문에 FAIL했다. 확정 정책의
  exact helper/target/maid/notified 조건과 시간·current 비제한 assertion으로 교체한 뒤
  `npm run ci:quality` 83 files/2082 tests·typecheck/build PASS. 기준을 완화하거나 검사를 삭제하지 않았다.
- 독립 정적 QA P0/P1/P2 0건: 기존 notified_maid_history_idx 경로, ACL 및 fixture rollback 확인.
  QA는 DB를 별도 실행하지 않았다. helper 자체는 접근 근거만 제공하며 신규 증빙 생성에는
  상위 source 상태·actor/session·CAS/receipt 검사도 필요하다(주석 P3 해석 보강).

### 20차 보완: 응답 전용 통보 배정 근거와 세션 갱신 재시도

2026-10-06 원격 미게시 후보의 source/draft/finalize/list/report RPC 반환 경로에
private `post_approval_issue_authorized_response`를 연결했다. DB에서 같은 target의 실제
통보 이력을 다시 확인하고 비원수행 메이드에게만 actor/session/source/assignment 근거를
반환한다. API projection은 내부 근거를 제거하고 `notified_assignee`만 공개한다.
원 수행자·관리자의 기존 응답 형태는 유지한다.

- command receipt에는 기존 논리 결과만 저장하고 저장 후/재시도 반환 직전에 근거를 만든다.
  새 live session의 재시도가 과거 session proof에 묶이지 않으며 원장·감사에 proof를 쓰지 않는다.
- source read의 STABLE session guard 및 명령의 잠금/fresh session/CAS/멱등 검사는 유지한다.
  private helper는 public/anon/authenticated/service_role 직접 실행을 금지한다.
- `npm run ci:quality`: 83 files/2083 tests, typecheck/build/lint/기존 OpenAPI 검사 PASS.
  lint 정보성 안내 5건은 기존 범위다. secret scan은 출력의 tracked 표기와 달리
  `git ls-files --cached --others --exclude-standard`로 비무시 미추적 파일도 검사한다.
- 로컬 DB transactional 함수 delta 검사: **210 assertions / plan1..210 PASS**, not-ok0.
  통보 이력 source/draft/list/단건 report, 다른 live session의 draft/finalize 재시도,
  receipt proof 미보존, 실제 새 증빙 RPC·신고·관리자 outbox 1회, 만료 session 거부 포함.
  provider 객체/응답은 합성 fixture이며 실제 Google Drive I/O를 검증한 것은 아니다.
  전부 ROLLBACK 후 profiles0/새 helper 부재를 확인했다.
- canonical LF SHA256: `15583a695686aef81ac4d8f5c823213c6132d8a629269a62b2f358ecf74a3ad4`.
  dev manifest104 검사 PASS. 최신 dev의 전체 migration 집합과는 아직 통합 전이다.
- 독립 QA 초기 범위 P0/P1/P2 0, 관련 source/contract/API 130건 독립 PASS.
  추가 finalize 전체 흐름도 최종 독립 정적 QA PASS, P0/P1/P2 0건이다.
  DB210 실행은 주 작업자의 결과이며 독립 QA는 DB를 재실행하지 않았다.
- **NOT RUN:** 최신 dev 통합 후 fresh `db:reset`/전체 SQL·동시성/Edge/CI.
  이번 함수 delta 검사를 새 migration 전체 설치 검증으로 표시하지 않는다.
  운영 배포·프런트 제공·커밋/push는 수행하지 않았다.

### 21차 보완: Swagger 통합 후보와 실제 경로 누락 검사

2026-10-06 사용자 인계 방침: 운영 배포 후 새 API 전체를 통합 Swagger에서 확인하고
프런트에 반영한다. 백엔드는 배포 전에 명세/구현 parity를 검증하고, 배포 후 실제 hosted
OpenAPI·Swagger Pages·프런트 인계 문서를 같은 버전으로 확인한다. 프런트 소스는 수정하지 않는다.

- 신규 module OpenAPI fragment가 report/evidence/handover의 10 paths/11 operations를
  하나로 모은다. 독립 Fastify 모듈의 실제 onRoute 결과와 method/path를 정확히 대조하고
  path parameter 누락, operationId 중복·기존 전역 명세 충돌, 인증 및 후보 상태를 검사한다.
- 증빙 명세의 오래된 원 수행자 전용 설명을 실제 통보 이력 접근과 별도 초안/실행자 권한으로
  정정했다. 과거 배정 이력이 다른 메이드의 업로드 실행 권한을 주는 것은 아니다.
- 초기 새 검사 typecheck는 unknown/implicit-any로 FAIL했으며 명시적 검사 타입과 narrowing으로
  보완했다. 이후 `npm run ci:quality` 83 files/2084 tests·typecheck/build PASS.
- 공개 전역 OpenAPI 137 paths/148 operations와 운영 Edge는 변경하지 않았다.
  현재 후보는 최신 dev의 140 paths/151 operations와 통합 전이므로 두 숫자를 혼동하지 않는다.
- 이 검사는 경로 inventory 검증이며 실제 hosted 응답·Edge parity 검증을 대신하지 않는다.
  전체 배포 후보의 모든 신규 API Swagger 통합은 아직 미완료다.
- 독립 QA 전용2파일22건 PASS, P0/P1/P2 0건. 전역 문서로 자동 공개되지 않음을 확인했다.
- 첫 `npm run edge:check`는 Docker 엔진 pipe 부재로 생성 단계 FAIL했다. 승인된
  DockerSafeStart 스크립트 1회 실행 후 running/server29.7.2를 확인하고 재실행했다.
  기존 Edge 검사 **476 passed/0 failed**, bundle **17,530,911 bytes** PASS.
  #336은 아직 Edge 미등록이므로 이 결과를 신규 #336 Edge 종단 PASS로 간주하지 않는다.
- 릴리스 #387에 배포 후 Swagger·hosted OpenAPI·프런트 인계 버전 일치 gate를 기록했다.
  운영 배포 직전 정지 및 기존 v0.8.0 보존 경계는 그대로다.

### 22차 보완: 보고 서비스의 Deno 생성 브리지

2026-10-06 보고 서비스·입력/응답 계약·canonical hash·actor/error의 원본5개를
`generate-post-approval-report-edge.mjs`로 Edge용으로 생성한다. business 검증은 직접
재작성하지 않고 엄격한 단일 import 치환/명시 Buffer import/최소 RPC 타입만 적용한다.
고정 Deno2.1.4 포맷 후 `--check`가 원본과 생성본 차이를 거부한다. 생성 파일은 직접 수정하지 않는다.

- zod4.4.3은 Node와 동일 exact 버전이다. 후보 전용 Deno config/lock에 integrity와
  Deno가 요구한 Node 타입 의존성을 고정했다. 상위 인증이 완료한 actor/token만 전달하며
  JWT payload decode가 인증이라는 뜻은 아니다. 실제 DB session 재검사는 기존 RPC가 소유한다.
- Deno 후보 테스트는 합성 RPC로 source/draft/list/recovery/finalize/report/admin close,
  통보 근거 actor/session/source mismatch, 내부 proof 제거, 위조 actor 입력, developer/
  invalid-token 거부와 DB safe error를 검증한다. HTTP 라우터·실제 Auth/DB 검증은 아니다.
- 초기 공용 deno.lock 추가안은 기존 Edge bundle의 20,000,000 byte gate를 초과해 FAIL했고
  별도 bundle 실행에서도 재현됐다. 제한을 올리거나 검사를 제거하지 않았다. 후보 config/lock을
  분리하고 공용 lock의 원래 내용을 보존한 뒤 기존 bundle17,530,911 bytes PASS를 확인했다.
  **후보 자체를 실제 API entrypoint에 포함한 bundle 크기 검증은 아직 미완료**다.
- `edge:check`는 후보 생성본 일치와 별도 frozen Deno 검사 후 기존 전체 Edge 검사·번들
  제한을 계속 실행한다. 후보 의존성이 운영 entrypoint에 연결됐다고 표시하지 않는다.
- source-only 후보이며 운영 라우터·Swagger 공개·migration·배포·프런트는 변경하지 않았다.
  이 단계의 검증은 최신 dev 통합·fresh 전체 DB·HTTP/업로드/인계 Edge 연결을 대체하지 않는다.
- 최종 `ci:quality` 83 files/2084 tests·typecheck/build PASS. `edge:check`의 후보 frozen
  10건 및 기존476건 PASS, 기존 bundle17,530,911 bytes PASS. 독립 QA는 읽기 전용 mount로
  후보10건을 별도 실행해 PASS, P0/P1/P2 0건이며 공용 lock 무변경과 기존 gate 보존을 확인했다.
  후보 포함 production bundle 통과 또는 HTTP 배포 완료로 해석하지 않는다.

### 23차 보완: Edge HTTP·인증 조합 및 후보 번들 차단 확인

2026-10-06 미등록 보고 HTTP factory에 조회/초안 저장·복구/최종 신고/단건/종결의
7개 동작을 연결했다. 실제 기존 `authenticate` 함수를 조합해 토큰 검증 → 활성 프로필 →
유효 세션 → 업무 RPC 순서를 검사한다. Auth/DB 경계는 합성 client이며 원격 요청은 없다.
인증 전에 본문을 읽지 않고 JSON 8192 byte 제한, idempotency key, 경로 ID binding,
no-store·정적 안전 오류를 적용했다. Fastify 오류 상태표는 6번째 생성 파일로 재사용한다.

- 독립 QA가 같은 prefix의 증빙 업로드를 보고 handler가 400으로 가로채는 P2를 발견했다.
  report 경로 이외에는 null을 반환하도록 수정하고 인증/RPC/본문 접근이 없음을 검증했다.
  report-first/sibling-first 두 순서의 회귀를 추가했다. 독립 HTTP18+runtime5=23 PASS,
  기존 P2 해결 및 추가 P0/P1/P2 0건이다. 실제 증빙 Edge handler 구현 완료를 뜻하지 않는다.
- `ci:quality`: 83 files/2084 tests, typecheck/build 및 기존 OpenAPI137 paths/148 operations PASS.
  후보 frozen Deno33(서비스10+HTTP18+인증5), 기존 Edge476 및 기존 번들17,530,911 bytes PASS.
- 기존 API graph와 보고 runtime factory를 함께 export하는 임시 후보 번들은
  **22,262,219 bytes로 20,000,000 byte 제한 FAIL**이다. 최초 `--import-map` 옵션은
  고정 Edge runtime에서 지원되지 않아 graph 생성에 실패했다. 이후 임시 deno.json과
  절대 asset 매핑으로 graph 생성에 성공했고 위 크기 실패를 직접 측정했다.
- 임시 파일만 생성·정리하며 실제 API entrypoint/config/공용 lock은 바꾸지 않는다.
  `node scripts/check-edge-functions.mjs --report-bundle-only`로 재현할 수 있다.
  후보 검사도 전체 `edge:check` 마지막 필수 단계에 추가해 기존 검사 PASS만으로
  신규 기능의 배포 가능 상태를 오인하지 않게 했다. 따라서 전체 Edge gate는 FAIL이다.
- 후속: 신규 의존성 포함 번들 경량화와 동일 계약 검증 → 증빙/인계 Edge 연결 →
  최신 dev 통합·fresh 전체 DB/경합·정식 API/Swagger 등록·CI/최종 QA 순서다.
  미등록 Swagger 후보10 paths/11 operations는 공개하지 않았다. 배포 이후 프런트 전달용
  Swagger 통합 요구는 유지하되 미배포 기능을 현재 운영 API로 표시하지 않는다.
- 이번 단계는 SQL/운영/Auth/PIN/프런트 무변경이며 fresh DB 검사는 NOT RUN이다.
  전체 필수 gate 실패 및 #336 잔여 구현 때문에 정상 완료 commit/push/PR/병합은 하지 않았다.

### 24차 진단: 실행 코드 사전 번들로 크기 제한 해소 가능성 검증

2026-10-07 KST `--report-prebundle-diagnostic`를 추가했다. 설치된 lock 기반
esbuild0.28.2와 zod4.4.3 exact 버전을 확인하고 원본 생성 브리지의 실행 코드를
임시 ESM으로 묶는다. 입력 validator·canonical hash·권한 로직을 수작업으로 축소하지
않으며 기존 shared runtime과 Node builtin만 외부 import로 보존한다.

- 최초 runtime-only 진단: 기존 API 포함18,100,943 bytes 및 생성본 인증5 PASS.
  후속 서비스/HTTP 공개 심볼까지 포함한 진단: **18,101,049 bytes**, 기존 동일
  서비스10/HTTP18/인증5 총33개를 생성된 JavaScript 대상으로 실행해 PASS.
  원본22,262,219 bytes 대비4,161,170 bytes 감소이며 동일20,000,000 기준을 유지한다.
- 원본 TypeScript 검사나 기본 `edge:check` 실패를 생성본 진단 PASS로 대체하지 않는다.
  `--report-bundle-only`와 기본 gate는 기존 raw 후보를 계속 검사한다. 운영 entrypoint,
  config/공용 lock, 원본 API/SQL은 이번 진단에서 변경하지 않았다.
- 임시 테스트는 원 테스트의 assertion을 바꾸지 않고 TS 타입 제거와 알려진 import 연결만
  수행한다. 이는 합성 RPC/Auth 경계이며 실제 hosted 요청·배포 ESZIP 실행/전체 통합은 아니다.
  임시 파일은 검증된 mkdtemp 경로에서만 생성·정리한다.
- Docker가 꺼져 있어 승인된 Safe Start만 실행했고 Desktop running/server29.7.2 확인 후
  검증했다. `ci:quality` Node83 files/2084 tests·typecheck/build PASS. 이번 fresh DB NOT RUN.
- 정식 채택 전 남은 일: bundler 직접 의존성/lock·재현성/라이선스·생성본 drift gate,
  실제 배포 entrypoint 연결과 동일 생성본 runtime 검증, 최종 의존성 graph/크기 재확인.
  지금은 별도 진단 경로이며 정식 빌드·배포 차단 해소 완료나 #336 완료로 표시하지 않는다.
- 독립 QA: syntax/생성본33건/18,101,049 bytes 재실행 PASS, 진단 범위 P0/P1/P2 0건.
  기본 gate 우회 없음, 공용 config/lock·운영 entrypoint·package/lock 내용 무변경과
  임시 디렉터리 정리를 확인했다. 정식 채택 승인이나 최종 배포 QA를 뜻하지 않는다.
  scoped diff check/lint도 PASS이며 기존14 lint info는 그대로다. commit/push/배포 없음.

### 25차 보완: 정식 생성 번들·증빙 인계 Edge 조합 및 cold 자산 준비

2026-10-07 KST 24차 임시 진단을 검토 가능한 manifest와 정식 생성 gate로 보완했다.
이 단계는 **후보 빌드 gate 해소**이며 #336 전체 완료·운영 배포 준비 완료는 아니다.

- esbuild0.28.2를 exact 직접 개발 의존성으로 고정했다. 생성기는 원본/브리지/설치 패키지
  입력의 canonical LF SHA, 버전·lock integrity metadata, 외부 import 4개와 생성 JS hash를
  manifest에 기록한다. Zod4.4.3 MIT 전문을 생성본에 포함한다. npm 패키지 무결성 검증은
  `npm ci`의 lock integrity와 tracked input SHA gate를 구별하며, tarball SRI를 별도 재검증했다고
  표현하지 않는다. JS는 ignored asset이고 검토 manifest만 source 대상으로 보존한다.
- `generate-post-approval-report-bundle.mjs --assets-only`는 검토 manifest가 재계산 결과와
  일치해야만 ignored JS를 작성한다. `--check`는 저장 JS와 manifest를 모두 비교한다.
  원본·manifest·JS·라이선스 변조 거부4 및 drift 시 assets-only 작성 전 거부1을 독립 QA했다.
- 원본 생성 브리지를 11파일로 확장하고, 증빙 업로드/operation 조회/content/관리자 인계
  4개 Edge 동작을 추가했다. 보고7개와 동일 인증·actor·CAS·멱등성·safe 오류·no-store
  계약을 사용한다. body/provider 전 DB admission, upload 한도, admin-only 인계와 실제
  Edge 인증 오류의 안전한 상태를 검사했다. 영속32-byte 인계 키는 명시 factory 인자로만
  받으며 import 시 환경변수/provider를 읽지 않는다.
- 기존 API에 명시적 선택 handler hook을 추가해 기존 부모 인증 경계와 CORS 조합을 검사했다.
  브라우저 CAS 헤더3개를 allow-list에 추가했다. **default 운영 handler는 활성화하지 않았다.**
  full module factory는 인증 client/service/provider/decoder/key를 명시 전달받는다.
- 정식 기본 `edge:check`: 원본 후보 Deno59, 기존 Edge476, 저장 생성 JS59 및 기존 번들 PASS.
  신규 전체 module과 기존 API를 포함한 후보 eszip은 **18,147,616 bytes**로 동일20,000,000
  byte 제한 PASS다. JS는619,237 bytes다. 생성본 테스트는 원 assertion을 유지하고 알려진
  import만 연결하며 원본 타입 검사를 대체하지 않는다. raw22,262,219-byte 실패는 이력이다.
  이전23/24차 재현 명령의 raw 검사는 이제 `--report-raw-bundle-diagnostic`로 분리됐으며,
  `--report-bundle-only`와 기본 gate는 검토된 생성본을 사용한다. 기준을 완화하지 않았다.
- cold 검토에서 ignored `magick.ts`를 준비하기 전 원본 module을 로딩해 실패하는 P2를
  실제 재현했다. pinned photo assets 생성·검사를 첫 후보 Deno 검사 앞으로 옮겼다.
  빈 임시 자산 환경의 checksum 생성 후 readonly overlay에서 원본59 PASS, 순서 회귀1
  PASS다. 기존 설치 패키지를 사용했으므로 새 Linux `npm ci` 전체 실행으로 확대하지 않는다.
- `ci:quality`: Node84 files/2085 tests·typecheck/build·secrets·기존 OpenAPI137 paths/148
  operations PASS. lint 오류0/info17이며 info를 실패나 완전한 무경고로 오인하지 않는다.
  독립 빌드/runtime/cold QA의 미해결 P0/P1/P2는0이다. 임시 fixture만 검증된 경계에서 정리했다.
- 최신 원격 확인: origin/dev ac8c775에는 #323/#329/#318/#330/#332/#397 선행 변경이 있다.
  이 author branch HEAD cfef022와는 아직 미통합이다. 기존 source-map-js1.2.1의 npm audit
  high1 FAIL은 이 이전 source의 경고이며, dev의 #397 수정 버전1.2.2를 통합해야 한다.
  bundler 추가로 새 취약점이 생겼거나 audit PASS라고 기록하지 않는다.
- 남은 gate: 최신 dev 통합 및 실제 통보 배정 권한 전체 회귀 → 정식 API/Swagger/runtime
  키 구성 → fresh 전체 DB/경합/upgrade → 필수 CI·최종 독립 QA·허용 dev 병합이다.
  이 단계의 fresh DB·실제 Drive/provider·운영 적용은 NOT RUN이다. source 후보 전체가
  미완성이라 commit/push/PR·운영 migration/배포·Auth/PIN·프런트 변경은 하지 않았다.

### 26차 보완: 관리자 상태 공유 조회와 Swagger 순수 데이터 계약 준비

2026-10-07 KST 실제 통합 감사를 통해 다른 관리자의 upload operation을 읽을 수 없어
인계 `expectedLeaseVersion`을 확인하지 못하는 경계를 발견했다. 공통 upload command의
`get`만 관리자 executor 비독점 관찰과 historical source access로 분리했다. 메이드의
본인 creator/executor 조건, 실제 admit/begin/claim/renew/provider/accept/delete의 authority,
new-source guard·lease/fence·처리 전후 fresh session 재검증은 유지한다. 상태 읽기는
lease/executor/업로드 상태를 바꾸지 않는다. 반려·대체 이후 역사 상태 읽기만 허용한다.

- 미적용 #336 append와 전용 pgTAP에 공유 상태/CAS/no-write/잘못된 claim/타 메이드/
  세션 만료/강등/displaced admin 및 rejected/superseded 회귀13을 추가했다.
  독립 정적 권한 QA P0/P1/P2 0, 관련 Node source/concurrency30 PASS다.
- Git origin/dev ac8c775의110 migrations는 manifest의 canonical LF SHA와 모두 대조했다.
  원본 SQL을 바꾸지 않은 LF 격리 사본에 새 후보를 합쳐 **fresh111 `npm run db:reset
  -- --local --no-seed` PASS**, 전용 SQL223 PASS, 실제 lock overlap18 및 fresh cleanup PASS다.
  합성 provider metadata만 사용하며 Drive/실제 PIN/Auth·운영 DB는 변경하지 않았다.
  readback migration111/profile0/report0/private-helper service execute=false, 원 source5개
  raw hash drift0이다. 원 author tree의104 manifest도 생성기로 갱신했다. 111 통합 manifest와
  source branch merge가 완료됐다는 뜻은 아니다.
- exact DB lint baseline PASS(기존 호환 unused parameter9·설치 지문3), 원 strict lint는
  **FAIL/exit1** 그대로다. 새 SQL 경고를 기존 baseline에 추가하거나 기준을 완화하지 않았다.
  이 전용 회귀를 최신 dev 전체 SQL/upgrade suite PASS로 확대하지 않는다.
- Swagger 선행 준비로 generation-time에만 Node fragment를 읽어 data-only Edge module을
  생성한다. 후보10 paths/11 operations·safe HTTP error40개와 common ErrorEnvelope 참조를
  고정하고 원본과 생성 데이터/해시를 대조한다. import/실행 initializer/getter/spread/중복키/
  민감 필드를 평가 없이 거부한다. Node/Fastify/WASM/provider 의존성을 공개 문서 graph에
  끌어오지 않는다. **global OpenAPI와 default router에는 아직 등록하지 않았다.**
- source와 생성 문서의 상태 조회 설명을 메이드 creator AND current executor/관리자 공유/
  반려·대체 이후 조회/실제 인계·provider write 분리로 맞췄다. generator generate/--check와
  신규35+준비 순서2=37 tests PASS, 독립6종 변조/4종 문자열/8종 literal 공격 거부 PASS다.
  최신 source/file SHA를 독립 대조했고 문구 보완 후 잔여 P0/P1/P2 0이다. 초기 TypeScript7
  compiler AST API 시도는 실패했으며 추가 의존성 없이 비평가 literal reader로 보완했다.
- 최신 `ci:quality`: Node85 files/2122 tests·typecheck/build·secrets·기존 global OpenAPI137/148
  PASS. `edge:check`에 data-only 생성 검사/format/type gate를 추가했고 원본59·기존476·생성본59,
  후보18,147,616 bytes PASS다. Swagger 신규11개를 운영 등록 완료로 합산하지 않는다.
- 최신 dev 통합 선행: 원 #329 installer는 수정하지 않고 catalog fixture의 승인 extension에
  정확한 #336 snapshot getter와 private fresh wrapper signature/ACL을 추가해야 한다.
  목표 exact census는 snapshot8/fresh20/core2이며 unknown caller 허용이나 count-only 완화는
  금지다. 현재14개 dirty tracked 파일이 upstream과 겹친다. feature-only 계약3파일은
  upstream 삭제가 아니라 아직 미포함된 추가이므로 3-way merge에서 원 feature 이력을 보존한다.
- 남은 것은 최신 dev 통합·정식 env/runtime/API/Swagger 등록·전체 DB/upgrade/경합·CI·최종
  QA·허용 dev 병합이다. 운영/ref/PIN/프런트/v0.8.0 변경·commit/push/PR은 하지 않았다.

## 2026-10-05 업로드 재시도 리뷰 보완

### 최신: 전용 DB·동시성 검사 통과

사용자 순차 진행 요청 후 새 purge job의 next_attempt_at을 claim 기준 at_time과 맞췄다.
기존 job은 ON CONFLICT DO NOTHING으로 backoff/lease를 보존한다. 최초 claim과 같은 claim
재시도를 실제 SQL로 확인했다. fresh111 적용 및 전용 pgTAP95개가 PASS다.

동시성 fixture의 quota watermark 준비와 예외 처리 중 잠금 유지도 보완했다. 실제 두 세션의
잠금 중첩13개, 기존 원 자료 digest 불변, 최종 fresh cleanup이 모두 PASS다. provider metadata는
합성 자료이며 실제 Drive 호출은 수행하지 않았다. 실패한 r8/r9 기록은 보존했다.
관련 Node26 및 runner syntax도 PASS다. 현재 남은 것은 최신 dev 기능 통합, 정식 manifest/API
등록, 전체 회귀·CI·최종 독립 검토이며 아래 실패 checkpoint를 최종 상태로 해석하지 않는다.

### 후속 재개 검증

사용자 재개 요청 후 두 배정 fixture에 필수 service_date를 추가하고,
기존 사진 fixture의 purge_after를 동일 statement 시각 기준 uploaded_at+168시간으로 맞췄다.
실제 실행에서 발견한 봉인 trigger의 NEW record 필드 오류는 테이블별 IF 분기로 수정했다.
관련 7파일/310 tests, typecheck, build는 PASS다. 전체 ci:quality는 등록 전 manifest103과
실제 SQL 파일104의 불일치로 1FAIL/1,933PASS이며 통합 단계에서 정식 manifest 갱신이 필요하다.

이후 fresh111 적용은 PASS했고 실제 pgTAP은 78개 assertion을 통과한 뒤 purge context에서
PHOTO_UPLOAD_FENCE_CONFLICT로 중단됐다. 정리 작업 생성의 next_attempt_at 기본값은
clock_timestamp()인데 claim의 비교 기준 at_time은 그 전에 캡처되므로, 이번 호출에서 생성한
작업이 첫 claim 결과에 포함되지 않는 시간 경계를 확인했다. 재실행으로 실패를 숨기지 않는다.
이 재개 회차의 자동 QA3회에 도달해 추가 수정·재시도는 중단했다. SQL 기능 전체/경합/CI/병합은
미완료이며 정상 완료 커밋은 생성하지 않았다. 실패 로그는 qa336-union-r4/r5/r6-ledger.log로 보존한다.

독립 리뷰에서 기존 admission의 재시도가 아직 업로드를 시작하지 않았거나 reserved인 경우에도
이전 revision으로 본문 해독을 시작할 수 있는 지점을 발견했다. admission 단계에서 세 revision을
다시 검사해 본문 읽기 전에 거부하도록 보완했다. 이미 provider 쓰기를 시작한 uncertain 상태는
기존 identity 확인을 통한 복구 경로를 유지한다. 관련 애플리케이션 검사112개와 typecheck는 PASS다.
실제 SQL에는 미시작/reserved 거부와 uncertain 복구 재시도 및 cold quota permit 검사를 추가했다.
선행 기능과 합친 임시111-migration DB에서 첫 두 적용은 PL/pgSQL IF 안의 CASE 괄호 누락으로
FAIL했고, 세 번째 fresh 적용은 PASS했다. 이어진 기능 pgTAP은 fixture의 cleaning_assignments
INSERT에 필수 service_date가 없어 0개 assertion 실행 상태에서 FAIL했다.
자동 QA 수정 루프3회 한도에 따라 여기서 검증을 중단했다. 기능 DB/경합/전체 회귀/CI/병합/배포는
완료되지 않았다. 다음 검증 전에 fixture를 현재 배정 스키마의 필수 조건과 대조해야 한다.
소스·미게시 SQL 및 실패 로그를 보존하며 실패 상태의 정상 완료 커밋은 만들지 않았다.

## 상태와 근거

2026-10-05 설계 기록이다. 사용자 원문 “제출 승인 이후 특이사항 신고가능하도록 추가”에 따라
제출 또는 승인 완료만으로 새 특이사항 보고를 막지 않는 기능은 확정됐다. 이 문서는 그 기능의
독립 원장·새 증빙·권한·검증 계획을 구체화한다. **신고 API 구현 완료, 실제 DB 통합 QA PASS, dev 통합,
운영 배포 또는 프런트 UAT 완료를 뜻하지 않는다.** 현재 승인된 최소안은 historical original performer/admin의
별도 immutable 신고·새 증빙이며 current-room state를 변경하지 않는다. 추가 ownership/현재 객실 연결 질문을
확정으로 승격하지 않고 제외한다. 실제 구현 통합·검증이 남아 있으므로 이 문서 작성만으로 #336을 종료하지 않는다.

- 최초 source 설계 기준은 `dev@1209756`이다. 기존 PR #390에 연결된 작업공간을 재사용하며
  별도 작업공간을 생성하지 않는다. 문서의 기준을 운영 DB/API 상태로 해석하지 않는다.
- 저장소 계약은 [제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md) 전체와 관련
  [ERD](./ERD.md), [DBML](./room-management-system.dbml), [아키텍처](./ARCHITECTURE.md)를 읽었다.
  뒤 세 문서는 review draft이며 현재 구현만으로 제품 결정을 대신하지 않는다.
- scoped 프런트 근거는 `makee-ham/room-management-system`
  `dev@09ed28446a4fd43919cddb29ebe442b848548ab8`의
  [DOCS/30 B01](https://github.com/makee-ham/room-management-system/blob/09ed28446a4fd43919cddb29ebe442b848548ab8/DOCS/30_DEPLOYED_WIREFRAME_API_PARITY.md#b01--제출-후-메이드의-객실-상태-변경)이다.
  B01 원문 전체를 읽었으며 본인 최근 이력, 다른 메이드 403, 과거 제출·주급 불변과
  담당 종료·재배정·새 입실 이후 서버 권한 명시 요구를 확인했다. 제품 전체 프런트 기준 commit을
  이 scoped 대조로 갱신하지 않는다.
- [Issue #336](https://github.com/wrongstory/room-management-system-backend/issues/336)의
  사용자 결정·설계 감사 기록을 함께 따른다. 현재 사용자가 승인한 일반 source 개발 범위 안에서
  권한 기반·schema·새 업로드 foundation은 진행할 수 있지만 미답변 정책을 확정으로 승격하지 않는다.

## 독립 transport/domain foundation checkpoint

2026-10-05 첫 checkpoint에서 [계약 모듈](../src/modules/post-approval-room-issues/post-approval-room-issue-contract.ts)과
[순수 unit 회귀](../tests/post-approval-room-issue-contract.test.ts)만 추가했다. endpoint 등록,
기존 app/module/Edge/OpenAPI/SQL/manifest 변경은 없다. Supabase 스킬의 Auth/session 보안
경계를 확인했으며, 이를 이유로 DB나 원격 기능을 실행·검증한 것으로 표현하지 않는다.

- 서버 전용 actor/session context와 client draft/finalization 입력을 분리한다. client의
  actor/room/maid/role/session/시각/status/provider/PIN/검수/지급 등 추가 필드는 거부한다.
- draft는 첫 `expectedDraftRevision=0`을 허용한다. finalization은 양수 draft·증빙 collection
  revision과 exact evidence ID/revision/order 1~10개를 요구한다. ID는 canonical lowercase로
  비교해 case-variant 중복도 거부하고 순서는 `0..n-1` 그대로 봉인 후보로 취급한다.
  JS-safe 정수 상한과 메모 1~500자 nonblank를 검사하지만 실제 DB CAS를 수행하지 않는다.
- 기존 `src/lib/command.ts`의 `requestHash`를 재사용한다. key digest는 오직
  `(actorProfileId, command, raw key)` 범위이며 source/report ID는 canonical payload hash에만
  포함한다. 같은 actor/command/key로 source/report를 바꾸면 같은 digest·다른 request hash로
  검출해 향후 receipt RPC에서 `IDEMPOTENCY_KEY_REUSED`/409로 거부해야 한다.
  actor/command/key 변경은 별도 digest이며 session 갱신은 논리 retry hash를 바꾸지 않는다.
  prepared command는 session/hash를 가진 내부 객체로 HTTP 응답·로그에 쓰지 않는다.
- source projection은 서버가 제공한 canonical 수행 단계 `submitted|approved`를 허용하고
  원 수행자 identity 또는 admin 경계만 순수 비교한다. 실제 submission table의 status column과
  같다고 가정하지 않는다. 그 밖의 상태는 이번 typed 최소안에 포함하지 않았을 뿐 최종 영구
  거부 정책을 결정한 것이 아니다. DTO allowlist는 원 제출 DTO·raw provider/PIN을 전달하지 않는다.

| 실제 실행한 검증 | 결과 |
|---|---|
| `npm test -- tests/post-approval-room-issue-contract.test.ts` | PASS: 1 file / 52 tests (QA P2 수정 후) |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS: exit 0, 신규 warning 없음; 기존 범위 밖 useTemplate info 5건은 보존 |
| `npm run build` | PASS |
| `npm run ci:quality` | PASS: 71 files / 1,676 tests; secrets/frontend contract/lint/typecheck/build 포함 |

첫 lint 실행에서 새 unit의 non-null assertion warning 1건을 발견해 제거하고 다시 실행했다.
초기 50건 unit은 통과했지만 독립 source QA에서 key digest에 client source/report ID를 포함해
기존 `(actor, command, key)` 충돌 계약을 우회하는 P2를 발견했다. 이 기대값 오류를 고쳐
key digest를 actor/command/raw key로 제한하고 draft/finalization 각각의 source/report 변경은
같은 digest·다른 request hash로 검출하는 회귀를 추가했다. QA 지적 이력을 숨기지 않는다.
검사를 완화하거나 skip을 추가하지 않았다. 승인된 local `.tmp/post-approval-room-issue-p2-foundation-verification.log`에
실행 로그를 보관하며 커밋 대상은 아니다. 보완 후 별도 non-author의 실제 targeted52/typecheck/새 파일 lint/diff check는 PASS, 신규 P0/P1/P2=0으로 이 source foundation을 재승인했다. reviewer는 작성자의 전체 quality/build 로그를 대조했으며 직접 전체 quality/build를 재실행한 것으로 표시하지 않는다. 원 로그 SHA256은 `fbd9041e255cca460bec0f38fc6a04f5d9a4c2f7bbc1c282eade1e82e9be6692`다. 원격 required CI와 실제 DB의
source tuple·최신 role/status/capability·fresh session·CAS·멱등성 receipt·업로드·outbox·보존 기능은
**NOT RUN / 미구현**이다. 이 순수 계약의 PASS를 실제 신고 API·DB 권한 검증 PASS로 승격하지 않는다.

## 과거 source/draft·격리 API slice checkpoint

아래는 typed pipeline 작성 **이전** checkpoint의 실행 기록이다. 이 절의503 stub·evidence0·미구현 목록은
그 당시 상태이며, 현재 source 후보는 다음 "typed pipeline source checkpoint" 절로 대체된다.
이 후속 slice는 위 foundation commit `cfef022` 이후의 **소스 구현**이다. 별도
[Fastify plugin](../src/modules/post-approval-room-issues/post-approval-room-issue.routes.ts),
[Supabase RPC adapter](../src/modules/post-approval-room-issues/post-approval-room-issue.service.ts),
[미게시 OpenAPI fragment](../src/modules/post-approval-room-issues/post-approval-room-issue.openapi.ts),
[HTTP 합성 회귀](../tests/post-approval-room-issue-api.test.ts)를 추가했다. 기존 app/Edge/global
OpenAPI에는 등록하지 않았다. HTTP 테스트의 인증과 RPC 결과는 합성이며 실제 DB 권한의 PASS가 아니다.

root가 CLI로 생성한
[`20261005023103_post_approval_room_issue_ledger.sql`](../supabase/migrations/20261005023103_post_approval_room_issue_ledger.sql)
한 append만 채웠다. 새 SQL 파일을 별도 생성하거나 기존 migration/manifest를 수정하지 않았다.
신규 private draft·append-only revision·reserved immutable report 테이블은 강제 RLS와 runtime role
직접 DML 금지를 가진 후보다. 원장의 FK/trigger는 submission→attempt→target→historical assignment
revision→원 수행자→room snapshot의 정확한 tuple을 검사한다. current assignment·담당 종료 시각·현재
투숙·새 투숙을 selector/차단 조건으로 삼지 않으며 현재 객실을 수정하지 않는다. 반려/superseded는
이번 최소 typed source에 포함하지 않고 최종 정책은 여전히 미확정으로 남긴다.

| 격리 HTTP 경로 | 실제 source RPC 후보 | 현재 동작 |
|---|---|---|
| `GET /v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues/source` | `get_post_approval_room_issue_source(uuid,uuid,uuid)` | STABLE snapshot session·active/password-complete original performer/admin source projection. 조회 결과는 이후 mutation의 authority가 아니다. |
| 위 base의 `POST /drafts` | `save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text)` | fresh session, immutable source, actor/client identity UNIQUE, draft CAS, revision append 및 성공 receipt 후보. 새 accepted evidence는 아직 없으므로 evidence revision/count는 모두0이다. |
| 위 base의 `POST` | `finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text)` | 권한 재검사 후 항상 `POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PIPELINE_REQUIRED`/503. 보고서 INSERT trigger도 차단한다. report/evidence/outbox/성공 receipt를 만들지 않는다. |

모든 JSON 경로는8192 bytes로 제한하고 query·중복 key header·authority extra field를 거부하며
no-store로 응답한다. source UUID는 path가 유일한 selector이며 body의 `sourceSubmissionId`도 거부한다.
RPC 오류의 raw SQL/details/hint/provider 정보를 전달하지 않는다. 201 report 응답은 후속 typed pipeline의
계약만 나타낸다. 합성 adapter의 201 테스트를 현재 SQL의 성공 finalization으로 해석하지 않는다.
현재 source 조회만 있으며 최신 draft/evidence 복구 조회와 실제 binary upload/content 경로는 후속이다.

순수 계약의 최대 revision 출력 경계도 보완했다. 저장·봉인 후보 revision은 `MAX_SAFE_INTEGER`까지
표현할 수 있고 draft mutation은 `MAX_SAFE_INTEGER-1`까지만 증가한다. 엄격 shape 검사 후 소진된
최대값의 draft mutation은409로 닫는다. finalization은 draft axis를 증가시키지 않는 후보이므로
최대 저장값을 exact CAS selector로 받을 수 있다. SQL도 마지막 안전 증가와 소진409를 구별한다.
NaN/float/string coercion을 허용하지 않는다. 메모는 기존 JS UTF-16 code unit 기준1~500을 유지하며
SQL helper도 astral 문자와 JS whitespace-only 검사를 맞춘다.

명령용 `private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)`는 #329의 fresh helper를
정확히1회 직접 호출한 뒤 **active·maid/admin·password-complete**를 별도 요구한다. limited session의
eligibility를 새 신고 권한으로 오인하지 않는다. draft 명령은 profile/global command lock 뒤,
receipt replay 직전, complete_command 직전과 직후의4개 source 호출 위치에서 이 wrapper를 사용한다
(일반 신규 성공 실행은3회, replay 실행은2회). finalization stub에는 post-lock1회만 있고 성공 경로가 없다.
source GET만 snapshot helper를 직접1회 사용한다. #318/#332의 실제7/19 통합 이후에 이 append를
설치하면 **8 STABLE snapshot / 20 VOLATILE fresh 직접 caller**가 되는 후보이며, 기존 원21 installer나
기존 private core2개의 검사는 수정하지 않는다. 신규 caller의 exact signature·PL/pgSQL·postgres owner·
SECURITY DEFINER·empty search_path·ACL·volatility 및 해당 새로운 wrapper 관계를 catalog에 별도로 추가해야 한다.
이 숫자는 텍스트 소스 검사이지 설치된 pg_proc census PASS가 아니다.

[SQL source 회귀](../tests/post-approval-room-issue-ledger-source.test.ts)는 dependency fail-closed,
직접 caller source 개수, active-only, post-lock/replay/completion 순서, FK/index/RLS, old-table 비변경과
finalization 차단을 검사한다. SQL parser나 PostgreSQL 실행 검증이 아니다.
[pgTAP 후보](../supabase/tests/post_approval_room_issue_ledger.sql)는 합성 historical fixture를 만들고
trigger를 복원한 뒤 신규 RPC를 호출하도록 작성했다. source submitted/approved·타인403·admin reporter와
원 수행자 분리·session revoke·same-key 다른 source/report409·CAS·최대 정수·append-only·완료 직후
세션 만료 rollback·원 DTO 및 photo/seal/inspection/earning/payroll/168시간 retention digest를 검사하는
실제 SQL 후보다. old fixture의 replica-mode seed는 기존 업로드/제출 workflow 검증을 대신하지 않으며,
이 파일은 아직 **NOT RUN**이다. 실제 병렬 lock wait/expiry race는 별도 gate다.

| 이번 slice에서 실제 실행한 검증 | 결과 |
|---|---|
| 관련12개 Vitest 파일: 신규 contract/API/SQL-source + 기존 submission/history/photo/notification/migration 회귀 | PASS: 12 files / 352 tests |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS: exit0, 신규 warning 없음, 기존 범위 밖 info5건 보존 |
| `npm run build` | PASS |
| full `npm test` / `ci:quality` / manifest·전체 Edge·원격 CI | NOT RUN: 새 append와 미통합 dependency 때문에 현재 manifest mismatch를 root가 의도적으로 보존했다. 검사를 완화하거나 skip하지 않는다. |
| `db:reset` / `db:verify` / pgTAP / isolated upgrade / concurrency / 실제 catalogue | NOT RUN: 이 작업은 DB/Docker/CLI 실행 권한을 가지지 않는다. SQL 적용·DB 검증 완료가 아니다. |

이 slice는 #336 기능 완료나 등록·배포 가능한 중간 완료가 아니다. root가 실제 dependency union을
확정하고 manifest를 generator로 재생성한 뒤 전체 quality·독립 QA·fresh DB 검증을 수행해야 한다.

### 이 과거 checkpoint 당시의 다음 구현 경계

다음은 구체적인 continuation **후보**이며 아직 함수·테이블·경로가 구현된 것으로 표현하지 않는다.

1. 새 typed draft evidence item/current-pointer·immutable operation/provider identity/acceptance·seal을
   추가한다. `draft_id + source_submission_id + reporter + original_performer`의 provenance와 stable
   `evidence_id`, item/collection CAS를 FK·guard로 보존한다. memo-only draft0에서 새 증빙1~10만 인정하며
   client가 verified/status/provider time/object ID를 직접 주입하지 못한다. final seal은 exact ID/revision/order
   membership과 immutable count를 봉인하고 source/draft/finalization RPC의 read·replay DTO도 최신 authority로 검증한다.
2. admission 후보는 `admit_post_approval_room_issue_evidence_upload(actor uuid,session uuid,source uuid,
   client_report uuid,evidence uuid,expected_draft bigint,expected_collection bigint,expected_item bigint,
   raw_sha256 text,raw_mime text,raw_size integer,key_digest text,request_hash text) returns jsonb`다.
   begin/claim/renew/provider-result/finalize/reconcile/compensate는 이 admission과 예약한 immutable identity를
   selector로 삼으며 전부 typed owner/session/CAS/fence를 재검증해야 한다. 실제 signature는 정해진
   dependency 설치 후 기존 provider RPC/worker 계약과 함께 리뷰하고 root CLI append로 추가한다.
3. 기존 PhotoService 전체 `upload()`는 maid/limited/current-attempt 권한에 묶여 있어 재사용하지 않는다.
   순수 `readPhotoBody(..., PHOTO_INPUT_MAX_BYTES=5MiB)`·decoder·binary verification/normalization과
   PhotoProvider/Drive object interface만 조합한다. JSON8192/default307200 limit를 binary 입력에 적용하지
   않으며 normalized 출력의 기존 크기/MIME/hash 상한을 보존한다. 새 binary route는 별도 제한과 실제 byte 회귀가 필요하다.
4. 전역 reservation-command lock과 기존 actor admission CPU/rate row를 공유한다. 30/min 및 두 단계의
   실제 rate 제한을 분리 증액하지 않는다. 기존 두 admission RPC의 inflight8 집계까지 old+new live/unbound/
   reserved/provider_succeeded/reconciliation_pending/compensation_pending operation을 합산해야 한다.
   새 typed quota pending을 만들면 `photo_quota_context`·refresh watermark도 양쪽 pending을 포함해야 하며
   신규 경로만 합산하는 것은 기존 경로에서의 우회를 남긴다.
5. 파일 이름은 기존 `private.photo_storage_file_name(date,'issue-proof',historical_notified_room,
   nextval(existing photo_storage_name_number),mime)` formatter/sequence를 재사용하고 별도 typed immutable
   binding을 둔다. old photo_storage_names/acceptance/provider-object/retention-link FK·v9 current-target
   guard를 우회하거나 원 객체를 rename하지 않는다. shared folder registry를 쓴다면 old folder retire/purge
   context와 physical-ID tombstone도 새 binding을 읽어야 한다. global name number만 공유해 locator uniqueness나
   DELETE 안전성이 해결됐다고 간주하지 않는다.
6. 새 retention ledger/typed domain을 shared purge/accounting에 연결한다. 살아 있는 draft/domain binding을
   seal 전이라는 이유로 orphan30일로 분류하지 않는다. true orphan은 실제 business binding이 없는 경우만
   검증된 provider 최초 createdTime+30일이며 retry clock으로 늘리지 않는다. 미해결 보고 증빙은 보존하고
   실제 별도 해결/종결 event 이후180일을 적용한다. 현재 객실 이슈의 해결을 과거 보고의 종결로 추측하지 않는다.
   object/retention attach↔delete-prepare lock/CAS/fence, uncertain DELETE, old+new physical uniqueness,
   폴더 retire·quota refresh 회귀를 함께 구현해야 한다.
7. 새 report provenance와 safe audit를 검사하는 typed notification family/source validator/deep link/outbox
   분기를 추가한다. 기존 `room_issue.reported_admin`은 current-assignment·pre-submission·old issue 원장을
   요구하므로 그대로 재사용·완화하지 않는다. finalize는 report/evidence seal/retention links/receipt/알림 outbox를
   한 transaction으로 commit하고 실제 provider/push는 transaction 밖에서 처리한다. 이후에만 현재503
   stub/INSERT blocker를 대체하고 Fastify/Edge/global OpenAPI를 실제 등록한다.

최종 현재 객실 linkage·새 occupancy 귀속·소유권 확대의 미답변 질문은 이 continuation으로 확정하지
않는다. 최소 별도 immutable 신고를 완성해도 자동 차단·현재 room state·검수·earning/payroll 변경은 없다.

## typed pipeline source checkpoint

2026-10-05 후속 source에서는 standalone JSON/binary API와 실제 SQL ledger 후보를 연결했다.
**현재 소스 기능 작성과 합성 검증은 실제 DB 설치/pgTAP/경합 PASS 또는 #336 완료가 아니다.**
기존 app/Edge/global OpenAPI, package/manifest, 운영 provider/Cron은 변경·활성화하지 않았다.
root가 만든 미게시·미적용 append `20261005023103_post_approval_room_issue_ledger.sql`만 확장했다.
아직 적용되지 않은 한 기능의 schema/RPC를 같은 append로 완성해 설치 중간 상태를 만들지 않는 전략이며,
기존 적용 migration 원문·#329 installer를 수정하지 않았다. PR에 이 이유와 root의 실제 적용 여부를 기록한다.

### 실제 작성된 경계

| 경계 | 현재 source 구현 후보 |
|---|---|
| source/초안 | 원 historical tuple FK/guard·fresh active-only·독립 memo revision·collection/item CAS. creator-only `GET .../drafts/{clientReportId}`는 현재 ID/revision/order·봉인 reportId만 복구한다. 원 수행자/admin라는 이유로 다른 보고자의 초안 권한을 추가하지 않는다. |
| binary 업로드 | 별도 admission/operation/state/events/provider object/identity tombstone/immutable acceptance. 입력≤5MiB, 정규화≤307200bytes. predecode admission 후 기존 순수 decoder/PhotoProvider interface만 사용하며 기존 PhotoService 전체 upload는 호출하지 않는다. |
| 공동 한도 | 기존 CPU admission30/min·second-stage upload30/min row와 global reservation-command lock을 공유한다. 기존 single/collection admission과 legacy begin까지 old+new inflight8을 합산하며 shared quota context/refresh watermark는 양쪽 pending과 cold permit을 포함한다. legacy single transition은 현재 unbound actor/attempt/assignment/revision/slot/photo revision/key admission 하나만 exact-match로 제외해8번째를 허용한다. 다른 reservation 제외나 상한9 확대는 없다. 기존 광범위 guard를 정확1회 needle 확인 후 같은 append의 replacement로 보존한다. |
| cold quota | stale quota 실패 transaction은 CPU를 차감하지 않는다. 서버 내부 per-HTTP nonce의 durable permit이 quota I/O 전 한 번 차감하고 logical(actor,key)별 capacity307200/inflight를 한 번만 예약한다. I/O 전 old/new pending+distinct unconsumed permit의 알려진 용량 하한도 검사하며 stale usage를 추측하지 않는다. provider.quota는 DB 밖10초 deadline·기존 단위/최신성 계약을 사용한다. fresh/source/CAS/prepared-delete를 후검사한 refresh 뒤 admission이 permit을 소비해 두 번째 CPU 차감하지 않는다. 다른 source/report/CAS의 같은 key는409이며 quota 오류/유실은503·no create/DELETE다. |
| 파일/폴더 | 기존 global number sequence·KST frozen upload date·historical notified 3자리 room·`issue-proof` formatter를 사용한다. 새 typed binding만 만들고 원 파일을 rename/rebind하지 않는다. old/new tombstone collision·shared folder retirement/deletion barrier를 양쪽으로 검사한다. |
| provider await 복구 | reserved provider allocation/write 전3-CAS를 재검사한다. exact identity·lease/fence로 durable `reconciliation_pending` I/O intent를 먼저 commit한 뒤 외부 upload를 한다. I/O 중 draft CAS가 바뀌면 exact physical first-createdTime 기록은 별도 RPC로 보존하지만 acceptance는409다. session expiry401은 더 이상의 provider I/O를 막고, 새 유효 session의 inspect-only recovery로 남은 uncertainty를 확인한다. accepted/sealed/barrier 증거를 덮어쓰거나 uncertain DELETE를 추론하지 않는다. |
| acceptance/봉인 | actual persisted typed provider identity/hash/date·operation fence·3-CAS를 검사한 acceptance만 인정한다. finalization은 current exact1..10 distinct evidence ID/revision/order·memo를 immutable report/seal로 봉인하고 receipt·safe audit·typed notification/outbox를 같은 transaction으로 commit한다. 기존503 blocker는 현재 source에서 제거했다. 클라이언트의 accepted receipt 주장은 권한이 아니다. |
| 열람/종결 | content는 fresh actor/source를 provider read 전·후 검사하고 bytes/hash/MIME를 대조한다. 원 수행자/admin의 separate source 최신50개 보고 discovery·exact report 조회와 admin-only closure CAS0→immutable1이 있다. discovery는 원 submission DTO/초안을 노출하지 않으며 query/cursor/version을 받지 않는다. 종결은 현재 room issue·원 검수·수익/payroll을 변경하지 않는다. |
| 보존/삭제 | accepted 버전은 replacement 뒤에도 business-bound이며 종결+180일 전에는 삭제하지 않는다. 미수락이어도 live draft3-CAS면 orphan이 아니다. true orphan만 provider 최초 createdTime+30일이다. 확정 never-accepted date-mismatch 보상만 exact provenance/fence/no acceptance/no seal을 재증명해 즉시 허용한다. UNKNOWN/유실은 inspect/reconcile하며 즉시 DELETE하지 않는다. permanent prepared barrier/tombstone은 유실 뒤에도 acceptance/content/rebind를 막고404 settlement가 멱등이다. |
| 무인 worker | 별도 service-only typed worker RPC와 bounded10 batch/8 lease/retry/cyclic100 scan이 source에 있다. admin 로그인 session을 새로 요구하지 않고 service-role EXECUTE/worker digest·lease·fence·due anchor/reference/provenance로 제한한다. authenticated/anon EXECUTE와 private DML은 거부한다. 사용자 upload/finalize 경계로 worker를 재사용하지 않는다. Cron·실제 Drive DELETE는 활성화하지 않았다. |
| 알림 | 새 `post_approval_room_issue.reported_admin` source validator는 immutable report/seal와 정확한 안전 audit를 증명한다. 기존 미제출/current-assignment family를 완화하지 않으며 기존 business admin inbox·active/nonself push 조건·durable delivery outbox를 재사용한다. payload에 memo/evidence IDs/provider/PIN을 넣지 않는다. |

### 미등록 HTTP와 exact RPC

JSON base는 `/v1/cleaning-history/submissions/{sourceSubmissionId}/supplemental-room-issues`다.
`GET /source`, `POST /drafts`, `GET /drafts/{clientReportId}`, `POST`(봉인), `GET`(same-source 최신50), `GET /{reportId}`,
`POST /{reportId}/close`를 standalone plugin/fragment에서 구현한다. JSON8192·strict extra-key/query·
one Idempotency-Key·safe no-store 계약은 동일하다.

binary plugin의 POST는 위 base의 `/drafts/{clientReportId}/evidence/{evidenceId}/upload`이며
`If-Draft-Revision`, `If-Evidence-Revision`, `If-Item-Revision`의 single integer header와 key만 받는다.
status는 `GET /v1/post-approval-room-issue-evidence-uploads/{operationId}`, content는
`GET /v1/post-approval-room-issue-evidence/{evidenceId}/versions/{revision}/content`다.
raw provider object/context는 서버 내부 RPC→Drive adapter 사이에만 사용한다.

public RPC는 모두 postgres owner·SECURITY DEFINER·empty search_path·jsonb 반환 후보이며
EXECUTE는 service_role만 허용한다. `get_post_approval_room_issue_source(uuid,uuid,uuid)`만
PL/pgSQL STABLE snapshot이고 나머지26개는 VOLATILE다(총27). 아래 `A`는 actor uuid/session uuid,
`F`는 operation uuid/lease integer/fence text의 **정확한 공통 prefix**다.

| 함수(앞의 `public.` 생략) | A 이후 argument types | language |
|---|---|---|
| save_post_approval_room_issue_draft | uuid,uuid,bigint,text,text,text | plpgsql |
| finalize_post_approval_room_issue_report | uuid,uuid,bigint,bigint,text,jsonb,text,text | plpgsql |
| admit_post_approval_room_issue_evidence_upload | uuid,uuid,uuid,bigint,bigint,bigint,text,uuid(default null permit) | sql |
| begin_post_approval_room_issue_evidence_upload | uuid,text,text,integer,text,text | sql |
| claim_post_approval_room_issue_evidence_upload | uuid,text | sql |
| get_post_approval_room_issue_evidence_upload | uuid | sql |
| renew_post_approval_room_issue_evidence_upload / get_post_approval_room_issue_evidence_provider_context / finalize_post_approval_room_issue_evidence_upload / mark_post_approval_room_issue_evidence_unknown | F | sql |
| prepare_post_approval_room_issue_evidence_provider_write | F | sql |
| reserve_post_approval_room_issue_evidence_folder | F,text,text,text | sql |
| reserve_post_approval_room_issue_evidence_identity | F,text,text | sql |
| record_post_approval_room_issue_evidence_provider_success | F,timestamptz | sql |
| prepare_post_approval_room_issue_evidence_delete | F | plpgsql |
| settle_post_approval_room_issue_evidence_delete | F,uuid,text | plpgsql |
| get_post_approval_room_issue_evidence_content | uuid,bigint | plpgsql |
| get_post_approval_room_issue_draft / get_post_approval_room_issue_report | uuid,uuid | plpgsql |
| list_post_approval_room_issue_reports | uuid | plpgsql |
| close_post_approval_room_issue_report | uuid,uuid,bigint,text,text | plpgsql |
| admit_post_approval_room_issue_quota_refresh | uuid,uuid,uuid,bigint,bigint,bigint,text,text | plpgsql |
| refresh_post_approval_room_issue_quota | uuid,timestamptz,bigint | plpgsql |
| claim_post_approval_room_issue_purges (worker; A 없음) | text,integer(default10) | plpgsql |
| get_post_approval_room_issue_purge_context (worker; A 없음) | uuid,integer,text | plpgsql |
| settle_post_approval_room_issue_purge (worker; A 없음) | uuid,integer,text,text | plpgsql |

새 direct #329 caller는 여전히 snapshot1/fresh1뿐이다. snapshot은 위 source GET이고 fresh는
`private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)` PL/pgSQL VOLATILE/SECURITY DEFINER/
postgres/empty search_path/모든 runtime EXECUTE 거부다. 모든 human pipeline RPC는 이 active-only wrapper를
post-lock/replay/output/provider/content/completion 경계에서 재사용한다. helper의 limited eligibility를
새 권한으로 승격하지 않는다. 최종 #318/#3327/19 뒤 source 예상은8/20이며 실제 pg_proc 검사는 **NOT RUN**이다.
원 strict21/6/18/2와 installer SHA/순서를 바꾸지 않는다.

### 현재 검증 수준과 후속 gate

현재 작성한 [pgTAP](../supabase/tests/post_approval_room_issue_ledger.sql)는 actual SQL RPC를 실행하는 후보이나
author가 실행하지 않았다. 합성 historical seed의 old workflow 우회는 old upload 권한 검증 PASS가 아니다.
별도 [실제 두-session runner](../scripts/test-post-approval-room-issue-concurrency.mjs)는 local Docker/DB 범위,
source manifest의 canonical LF hash와 **정확한 전체 migration version/name 배열**, rooms121/types4,
public RLS 및25개 fixture 관련 empty relation을 확인한 뒤에만 fixture/cleanup 권한을 획득한다.
cleanup 전 unrelated actor/target 부재와 exact history를 재검사하며 reset 뒤 같은 fresh/history readback을 한다.
import 때 실행하지 않는다. 실제 lock wait를 관측하는13개 경합 후보에는 same-key·old/new30→31·
mixed single/core/collection 8번째 transition·9번째 거부·duplicate receipt·quota·seal/delete 양방향·response loss·
provider await CAS/expiry·lock-wait expiry·limited/foreign denial·whole old-state digest가 있다. **NOT RUN**이다.
legacy transition의 의도적 old workflow 쓰기는 해당 경합 transaction에서 rollback해 immutable-old digest와
구별한다. runtime future 결과를 source-test PASS로 대체하지 않는다.

| 실제 author 실행 | 결과 |
|---|---|
| 신규7개 Vitest 파일 및 기존 history/submission/photo/notification 회귀11개 | PASS:18 files /560 tests (2026-10-05 최종 보완 source rerun) |
| npm run typecheck | PASS |
| npm run lint | PASS:377 files, exit0/신규 warning 없음, 범위 밖 기존 info5건 보존 |
| npm run build | PASS |
| existing pinned PostgreSQL17 WASM parser | PASS: migration140/pgTAP161 statements의 outer SQL grammar만 검사. PL/pgSQL compile·actual history·DB execution 아님. |
| node --check 실제 race runner | PASS: JS syntax only |
| full ci:quality/npm test/manifest/Edge/DB reset/pgTAP/races/catalogue/independent QA/CI/dev/prod/UAT | 현재 NOT RUN 또는 root integration gate 대기. author 권한 밖 DB/CLI/Git/remote/provider 작업은 수행하지 않았다. |

위 테스트는 합성 actor/RPC/provider와 SQL-text/runner safety 회귀다. 로그는 승인된 local
`.tmp/336-typed-pipeline-{expanded-tests,typecheck,lint,build}.log`에 저장하며 커밋 대상이 아니다.
비작성자1차 source QA에서 P0/P1은 발견하지 않았으나 valid8th admission 이중 집계,
provider write 전3-CAS 누락, pgTAP key 충돌, provider await409의 durable uncertainty 누락,
runner cleanup의 부족한 fresh/history proof를 지적했다. 각 소스·합성/SQL/race 회귀를 보완했다.
quota pre-I/O pending floor 및 admin same-source report discovery도 보완했으며,
**이 보완 후 최종 independent freeze QA는 아직 NOT RUN**이다. 최초 audit을 QA0/DB PASS로 승격하지 않는다.
ERD/DBML의 새22개 typed table/관계도는 이 소스 후보이며 운영 schema로 표시하지 않는다.

최소 original-performer/admin immutable 신고 pipeline source는 미답변 current occupancy 질문 없이 진행한다.
하지만 현재 객실 incident 연결·자동 입실 차단·타 메이드 권한·반려/superseded source까지 허용하는 정책은
확정하지 않는다. actual root dependency union/manifest·fresh DB/전체 quality·비작성자 QA 후에만
app/Edge/global OpenAPI를 등록하고 source 기능 완료를 판단한다. 전체 #336 또는 운영 완료로 표시하지 않는다.

## 확정 요구와 미확정 결정

| 구분 | 내용 | 구현 의미 |
|---|---|---|
| 확정 | 제출·승인 이후 새 특이사항 보고 허용 | 제출/승인이라는 이유만으로 기능을 영구 차단하지 않는다. |
| 확정 | 원 제출본·사진 binding·검수·수익·지급 불변 | 새 보고를 과거 제출에 끼워 넣거나 검수를 재개하지 않는다. |
| 기존 계약과 pinned B01의 최소안 | 원 수행 메이드의 본인 이력, 다른 메이드 접근 거부 | source authority는 원 수행자의 불변 identity로 설계한다. 모든 메이드 확대는 별도 명시 결정이 필요하다. |
| 기존 관리자 계약 | 관리자는 현재 객실 이슈를 제출·승인과 독립적으로 생성 가능 | 기존 관리자 명령을 중복 개발하거나 일반 메이드에게 그대로 열지 않는다. |
| 유지할 증빙 계약 | 메모 1~500자, 별도 증빙 1~10개 | 기존 입력 상한을 유지하고 일반 청소 사진을 새 사건 증빙으로 재연결하지 않는다. |
| 유지할 보존 계약 | 사건 증빙은 해결/종결 후 180일, metadata는 영구 보존 | 새 사건과 새 객체의 기산 사건을 별도로 관리한다. |
| 미확정 | 원 수행자+관리자인지, 모든 활성 메이드+관리자인지의 최종 신고 주체 | 촛불 공동관리 결정을 신고 권한으로 확대하지 않는다. |
| 미확정 | 담당 종료·재배정·새 투숙 뒤의 신고 권한 및 사건 귀속 | 현재 객실 사건인지, 과거 업무에 대한 후속 설명/참고 연결인지 최종 결정이 필요하다. |
| 미확정 | 반려·superseded 제출 및 7일 목록 밖의 발견 경로 | 제출/승인 허용을 이 상태들의 명시 허용 또는 영구 거부로 확대하지 않는다. |

최근 7일은 청소 이력 **목록 조회 창**이다. 신고 마감, 보안 TTL 또는 원 수행자 권한의
자동 종료 시각으로 확정된 값이 아니다. 새로운 7일 deadline이나 “아무나 모든 객실 신고”를
schema·RPC·RLS·purge 조건에 넣지 않는다. 실제 session·capability·upload lease의 기술적
만료와 사건 증빙의 180일 보존은 이 목록 창과 별개다.

미확정 정책이 남아 있어도 원 제출 불변성, 불변 source tuple 검사, 새 증빙 업로드와
멱등성·경합 회귀 같은 공통 기반 및 아래 최소 ownership API는 선행 구현할 수 있다.
현재 객실에 open 이슈를 자동 생성하는 최종 명령이나 운영 정책을 먼저 고정하지 않는다.
별도 관리자 triage/승인 workflow 역시 사용자가 결정한 것으로 가정하지 않는다.

### 최소 ownership API의 선행 가능 판단

제품 가이드의 메이드 본인 업무·이력/관리자 업무 관리 경계와 pinned B01의 본인 최근 이력을
그대로 유지하면, active/password-complete 원 수행자 또는 관리자가 제출·승인 후 별도 불변
신고와 새 증빙을 기록·조회하는 최소 API는 선행 구현 가능하다는 source 설계 판단이다.
이는 모든 메이드로의 확대나 미답변 정책의 확정이 아니며 실제 endpoint 구현 지시·완료도 아니다.

근거는 `src/modules/cleaning-history/cleaning-history.routes.ts`의 인증·비밀번호 변경 검사와
`20260928095656_flat_cleaning_evidence_history_payroll.sql`의 `get_cleaning_history_submission`이다.
후자는 최신 active admin/maid와 정확한 session을 검사하고 maid는 불변
`attempt.maid_profile_id` 본인으로 제한한다. 이력 조회에 current assignment를 요구하지 않는다.
`src/modules/rooms/room.routes.ts`의 관리자 전용 `POST /:roomId/issues`와 기존
`report_issue` command는 관리자 현재 객실 신고가 제출·승인과 별개인 근거다.
다만 이력 조회가 이미 가능하다는 사실만으로 새 mutation이 제공되거나 안전하다고 간주하지
않는다. 새 mutation은 별도 source authority·fresh session·CAS·멱등성 검사를 구현해야 한다.

최소 경로는 과거 submission/source tuple에만 연결된 별도 신고·증빙을 확정하고 알림을 보낸다.
`public.room_issues`, `rooms.state_version`, 현재 객실 이슈 projection, 현재/다음 occupancy나
배정·입실 차단 상태를 쓰지 않는다. 원 수행자와 실제 보고 actor는 별도 provenance로 저장해
관리자 기록을 원 수행자의 행위로 위장하지 않는다. 종료·재배정·새 입실 뒤 현재 객실 사건으로
연결할지의 질문은 계속 미답변이며, 최소 경로의 구현만으로 그 연결 권한을 확정하거나 #336을
종료하지 않는다.

## 현재 구현을 넓힐 때 발생하는 문제

| 현재 source | 확인된 경계 | 단순 확장의 영향 |
|---|---|---|
| `20260928095656_flat_cleaning_evidence_history_payroll.sql`의 `report_attempt_room_issue` | current notified assignment, 진행/현장 완료/업로드 단계, 제출 pointer 없음 | 상태 조건만 풀면 과거 assignment를 현재 수행 권한으로 오인하고 기존 보고·증빙 모델에 사후 자료가 섞인다. |
| 같은 migration의 `attempt_room_issue_projection` / `submission_projection` | attempt에 있는 모든 특이사항 보고를 제출 상세에 동적으로 합산 | 같은 `attempt_room_issue_reports`에 새 row를 추가하면 과거 제출 DTO의 `roomIssues`가 바뀐다. |
| `20261001113931_cleaning_report_decision_notifications.sql` | notification source validator도 current 담당·미제출 조건을 재검사 | 보고 RPC만 수정하면 알림 provenance가 거부돼 transaction이 실패할 수 있다. |
| `20260917090000_photo_retention_v2.sql` | active claim 중 pending이면 무기한, 그 외 최장 expiry를 객체에 반영 | 원 사진에 새 room-issue claim을 붙이면 원 제출 DTO의 `expiresAt`과 원 객체 보존기한이 바뀐다. |
| 기존 사진 admission/begin/finalize | attempt/target/assignment/slot 및 current 또는 collection CAS에 결합 | 승인 attempt의 슬롯을 재개하면 봉인·구 담당자·기존 collection revision과 새 사건 권한이 섞인다. |

따라서 사후 보고는 기존 `private.attempt_room_issue_reports`, 원 attempt photo current/items,
원 submission bindings/seal에 쓰지 않는 별도 ledger로 만든다. 과거 원문·binary를 새 증빙으로
재연결하거나, 같은 물리 provider 객체를 deduplication으로 공유해 보존기한을 합치지 않는다.
기존 DTO를 사후 보고 목록으로 재수화하지 않고 별도 조회로 제공한다.

## 독립 source·증빙 모델 후보

아래 이름과 HTTP 경로는 구현 전 검토용 후보이며 현재 제공되는 API가 아니다. 최종 schema와
OpenAPI는 정책 결정 및 실제 source 의존관계 확인 후 같은 구현 PR에서 확정한다.

| 경계 | 필요한 저장·검사 |
|---|---|
| 불변 보고 | 새 private 보고 ledger에 report ID, 원 submission/attempt/target/assignment ID·revision, 원 수행자와 실제 보고 actor, 객실 identity, 메모, 서버 보고 시각을 저장한다. 원 검사 결정은 참고 provenance이며 수정하지 않는다. |
| source authority | submission→attempt→통보된 assignment revision→수행자·객실 tuple을 실제 FK/기존 guard로 증명한다. 복합 FK가 없으면 constraint trigger로 동일성을 강제한다. client가 보낸 room/maid/role을 권한 근거로 사용하지 않는다. |
| 증빙 작업 상태 | actor·source submission·stable client report UUID에 묶인 별도 mutable collection revision을 둔다. 원 attempt execution version 또는 submission current revision과 독립이다. |
| 새 업로드 | 새 typed admission/operation/state/provider identity/acceptance 경계를 사용한다. 원 target slot을 다시 열거나 기존 attempt finalizer를 호출하지 않는다. |
| 불변 증빙 | 새 evidence version metadata와 정규화된 report-evidence binding을 둔다. 같은 보고의 verified·미만료·미삭제 사진 1~10개만 선택하고 finalization에서 exact ID/order를 봉인한다. |
| 현재 객실 연결 | 최소 경로는 현재 room issue를 생성·갱신하지 않는다. 보고의 과거 source와 현재 room issue 연결은 별개 관계다. 직접 연결 여부와 담당 변경/점유 경합 guard는 미확정 결정 뒤 구현한다. 불변 보고를 나중에 덮어쓰지 않는다. |

모든 새 base table은 RLS를 켜고 `PUBLIC/anon/authenticated/service_role`의 직접 DML을
회수한다. private raw table/function을 runtime에 일반 공개하지 않는다. 고정 `search_path`,
최소 EXECUTE와 actor/session/ownership 재검증이 있는 서버 전용 RPC만 사용한다.
FK 자식, actor/source 조회, evidence binding, due worker 경로의 index를 검토한다.

원 수행자 provenance는 현재 담당자와 다르다. 종료된 통보 revision을 참조하는 것은 그
이력의 수행 사실을 증명할 뿐 현재 객실 접근·PIN·새 청소·다른 메이드 사진 권한을 만들지 않는다.
복원 근거 없는 legacy room snapshot은 현재 객실 정보로 임의 backfill하지 않는다.

## API·RPC·멱등성 후보

예시 경로는 `GET /v1/cleaning-history/submissions/{submissionId}/supplemental-room-issues`,
그 source에 대한 별도 evidence upload/status/content, 새 report finalization이다.
기존 `get_cleaning_history_submission` 응답은 변경하지 않고, 별도 응답에서 새 보고·증빙
revision과 허용 행동을 반환한다. admin/본인 maid의 bounded projection과 응답 상한·no-store를
Fastify/Edge/OpenAPI·생성 client에서 맞춘다.

새 mutation의 원칙은 다음과 같다.

1. HTTP에서 검증한 token actor/session을 RPC에 전달한다. raw client role/session 입력을 신뢰하지 않는다.
2. scoped receipt → 기존 domain advisory lock → profile/session → 원 source tuple → 새 증빙
   작업 상태 → 정렬한 operation/evidence/retention row 순서를 기존 실행 경로와 맞춘다.
   현재 객실을 변경하는 최종안이면 그 room CAS/점유·배정 검사를 같은 잠금 순서에 포함한다.
3. 잠금 대기 후 새 서버 시각으로 최신 profile role/status/password와 정확한 Auth session을
   검사한다. `not_after` hard expiry를 확인하고, provider 호출 전후 및 content 반환 직전에도
   새 권한을 재검사한다. 이미 인증했다는 사실이나 service role로 이를 생략하지 않는다.
4. report/evidence revision을 CAS하고 같은 source·report의 exact verified evidence set을 봉인한다.
   원 attempt 상태/version, 제출 pointer, inspection decision을 갱신하지 않는다.
5. 보고·증빙 binding·보존 연결·safe audit·typed inbox/outbox·성공 receipt를 짧은 transaction으로
   함께 commit한다. Drive/push HTTP를 transaction 안에서 기다리지 않는다.
6. 같은 `(actor, command, key)`와 같은 canonical payload는 저장한 결과를 replay한다.
   source/report ID를 포함한 다른 payload 재사용은 같은 receipt scope에서 409 conflict이며
   다른 key의 중복 finalization은 report/client identity
   UNIQUE와 CAS로 막는다. replay도 최신 session과 원 수행자 ownership을 확인한다.

새 사진 경로는 기존 binary normalization, Drive HTTP, 안전한 저장 이름 utility를 재사용할 수
있지만 업무 권한·acceptance·보존 authority는 새 typed context로 분리한다. durable admission,
공유되는 실제 rate/quota 상한, stable item ID, collection/item CAS, provider identity/time,
claim/fence, 응답 유실 reconciliation과 never-accepted compensation을 보존한다.
provider folder/identity/name은 사전 예약하고 retry에서 재사용한다. 원 객체 이름을 변경하지 않는다.
독립 upload라는 이유로 전체 actor quota/in-flight 한도를 우회하거나 둘로 늘리지 않는다.

## 보존·열람·알림 경계

새 객체는 원 일반/폭탄방/제출 사진과 다른 acceptance와 보존 원장을 가진다. 새 사건에 연결된
증빙은 해결 전 보존하고, 결정된 해결/종결 event의 시각부터 정확히 180일을 적용한다.
원 제출 사진의 검사 결정+168시간 및 기존 mixed claim은 그대로 둔다. 이미 삭제된 원 사진을
복원됐다고 표시하거나 새 신고로 원 expiry를 연장하지 않는다.

업로드 operation의 작업 식별자만 있고 실제 business 사건에 연결되지 않은 객체는 true orphan
분류를 명시적으로 검사한다. 해당 객체는 provider 최초 생성 시각+30일이며 retry/새 수신 시각으로
연장하지 않는다. 단순 draft라는 이유로 business에 이미 연결된 증빙을 orphan으로 바꾸지 않는다.
연결·삭제 준비는 retention lock/CAS/fence로 직렬화하고 delete permit이 준비된 뒤에는 새 연결을
거부한다. uncertain DELETE는 재연결 가능한 실패로 추측하지 않는다. provider 삭제와 cache 정리
후에도 source·binding·해결 시각·purged metadata를 보존한다.

content는 최신 active/password-complete admin 또는 허용된 본인 보고자에게만 no-store로 중계한다.
소유권을 확인한 뒤 media availability를 반환해 다른 메이드에게 존재·만료 상태를 노출하지 않는다.
새 기능은 inactive/departed/upload-only의 일반 권한 또는 원 사진 열람을 추가하지 않는다.

기존 미제출 `room_issue.reported_admin` validator를 무조건 완화하지 않고 새 불변 report와
정확한 safe audit를 검사하는 typed source/family를 만든다. 새 family는 과거 신고 backfill이나
receipt replay 때 알림을 다시 만들지 않는다. 기존 business admin inbox 보존과
active/password-complete/nonself push 조건을 유지한다. historical source submission deep link는
새 보고 조회와 연결하며 검수 대기 queue 권한을 사후 보고 권한으로 오인하지 않는다.
메모·사진 ID·provider locator·PIN·guest PII·raw request를 audit/notification에 복제하지 않는다.

메이드 신고만으로 입실 차단, 새 청소/reclean, 검수 재개, 폭탄방 bonus, earning 또는 payroll
adjustment를 생성하지 않는다. 관리자 차단 판단은 기존 별도 권한으로 유지한다.

## 구현 순서와 선행 source 보존

1. 기존 원 수행자/admin 경계를 보존하고 현재 객실 상태를 쓰지 않는 최소 계약으로 불변
   source authority·새 schema/upload·신고 finalization과 회귀 fixture를 선행 구현할 수 있다.
   미확정 matrix는 별도 사용자 결정으로 닫고 최종 현재 객실 연결 계약을 기록한다.
   답변 전에는 현재 객실 효과가 있는 연결 command와 소유권 확대를 보류한다.
2. 실제 통합 source의 migration manifest·선행 함수 signature/ACL·guard를 확인한다.
   이미 적용된 migration은 수정하지 않고 CLI로 새 migration을 생성해 append한다.
   신규 원장·constraint/RLS/RPC부터 시작하고 각 단계의 구현/검증 상태를 따로 기록한다.
3. 새 upload/provider/retention 경계와 실패 복구를 구현하고, 원 자료의 불변성을 먼저 검증한다.
4. 최소 경로의 독립 report finalization과 typed 알림을 연결한다. 현재 객실 연결은 별도 정책
   결정 후에만 해당 CAS/점유 guard와 함께 추가하며 최소 신고 command에 몰래 섞지 않는다.
5. Fastify/Edge/OpenAPI·생성 client·문서를 정합화한 뒤 전체 필수 검증·독립 QA·exact-head CI를
   수행한다. source/dev 통합과 운영 배포/프런트 UAT를 각각 별도 gate로 기록한다.

[#329](https://github.com/wrongstory/room-management-system-backend/issues/329)의 기존 유효 session
재진입·capability session binding과 [#330](https://github.com/wrongstory/room-management-system-backend/issues/330)의
촛불 공동관리 source를 #336 승인이나 현재 dev에 이미 적용된 것으로 자동 승격하지 않는다.
여기서 future dependency는 실제 symbol명이 아니라 앞으로 통합할 source validator/guard의
의존관계를 뜻한다. #329 installer의 `private.assert_attempt_actor_session_fresh`는 새 command의
authoritative fresh-session helper 후보이고, #330의 post-lock 및 completion-guard 재검사는
잠금 대기·명령 완료 직전 권한을 검증하는 선행 source 근거다. 최초 설계 snapshot에는 두 후보가 없었으며,
최신 dev/root 통합의 완료 상태와 이 author 작업공간의 미통합 상태를 혼동하지 않는다.
#336에 이미 설치된 함수나 PASS 근거로 표시하지 않는다. 새 RPC가 그 helper를 사용하려면
선행 installer를 먼저 실제 적용하고 exact signature/ACL을 확인해야 한다.

그 후보의 실제 dependency closure, 검증된 installer 적용 순서와 현재 manifest를 함께 대조한다.
미래 SQL을 명목 timestamp로만 재정렬하거나 100→101 같은 과거 후보 수치를 현재 source에
그대로 강제하지 않는다. 원 SQL byte/SHA를 보존하고 새 append의 실제 실행 순서를 isolated
upgrade에서 검증한다. 미통합 guard를 단순 복사해 이미 적용된 계약이라고 표현하지 않으며,
선행 원 strict 실패·집계도 새 기능의 PASS로 덮지 않는다. #329의 제한 session 재진입과
#330의 촛불 공동관리 권한은 이 helper를 사용하더라도 사후 신고 권한으로 확대하지 않는다.

보존할 #329 선행 source validator의 exact 기준은 다음과 같다. 이는 pending source의 설치·검사
계약이며 이 문서 작성 중 해당 installer를 DB에 적용하거나 검사를 실행했다는 뜻이 아니다.

| 검사 경계 | 선행 source의 exact 계약 |
|---|---|
| 원 installer | 최초 exact 21 caller set을 검사한다. #336 caller를 허용하려고 이 원 검사 집합을 완화하지 않는다. |
| 설치 후 snapshot helper | 정확히 6개 STABLE caller를 검사한다. |
| 설치 후 fresh helper | 정확히 18개 VOLATILE caller를 검사한다. |
| private core | session-checked wrapper를 호출하는 private core function 2개의 경계를 검사한다. |
| 실제 caller append | 원21 installer를 그대로 둔 뒤 #318의 STABLE board caller append로 7/18, #332의 VOLATILE fresh report caller append로 7/19가 되는 실제 순서를 구별한다. 실제 통합·적용 여부는 해당 source 근거를 확인한다. |
| #389 catalog 검사 fixture | installer나 caller 확장 migration이 아니다. 실제 #318/#332 append가 추가한 caller를 포함해 정확한 설치 caller catalog를 검사하는 회귀 fixture다. 원 설치 6/18과 후속 7/18 → 7/19를 같은 installer의 기준으로 혼동하지 않는다. |

원 `20261003140716_limited_existing_session_discovery.sql`의 canonical LF SHA는
`dadd5abddedb74e9e66f20f1b970e53d3398ddabf0764b926a713aeee6e8b603`이며 기존 installer를
고쳐 새 caller를 끼워 넣지 않는다. #336 새 caller는 완전히 별도 append에서 추가하고,
그 시점 실제 설치된 source에 맞는 정확한 signature·language·owner·ACL·volatility 및
index/catalog census 회귀를 확장한다. 아직 없는 선행 caller를 있다고 가정하거나 기존
외부 caller 수를 임의 변경해 통과시키지 않는다. 선행 installer → 실제 #318/#332 caller append →
새 #336 append의 실제 적용 순서를 isolated upgrade로 검사한다. #389는 이 순서를 검증하는
fixture이지 그 사이에 적용하는 migration이 아니다.

[개발 오케스트레이션](./DEVELOPMENT_ORCHESTRATION.md)의 기존
`#382/#323 → #329 → #318 → #330 → #332 → #336` 후속 순서와 실제 완료 근거를 유지한다.
foundation 선행 작업은 이 순서의 최종 통합·검증 gate를 생략하는 승인이 아니다.
#331 송금 표시·실제 지급, #334 의존성 패치, 제한 계정의 새 로그인, 촛불 공동관리,
폭탄방/bonus, production DB/API·provider/Cron·실제 백업/복원·release/tag·프런트 변경을
이 문서 또는 #336 사후 신고 구현에 혼합하지 않는다.

## 의미 있는 검증 계획과 완료 조건

아래는 endpoint/DB 구현 후 실행할 통합 회귀 계획이며 각 항목은 **NOT RUN**이다.
위 독립 계약 unit의 PASS는 실제 endpoint/DB/CI/운영 회귀 실행을 뜻하지 않는다.
선행 PR의 PASS나 기반 의존성 설치 성공을 #336 구현·DB 검증으로 재사용하지 않는다.

| 검증 | 실제로 확인할 실패·경합·불변식 |
|---|---|
| 역할/session | pending/approved 원 수행자의 정상 요청, 다른 메이드 403, developer·비활성·퇴사·upload-only·임시 비밀번호 거부, session revoke/hard expiry, lock 대기 중 만료, provider 왕복 중 role/status 변경을 검사한다. |
| source tuple | 타인/다른 attempt·target·assignment revision·room의 ID 대입을 거부한다. legacy snapshot은 추측하지 않는다. 반려/superseded·담당 종료·재배정·새 투숙은 최종 결정 matrix대로 테스트한다. |
| 증빙 | 첫 업로드 CAS0, 정상 다중 append, 최대10/초과11, 잘못된 bytes/MIME/hash, foreign evidence/원 사진 재사용, 미완료·만료·purged evidence, 동시 replace/delete/finalize를 검사한다. |
| receipt/경합 | same-key same-payload 응답 유실 replay, 같은 actor/command/key로 source 또는 report ID를 바꾼 payload 재사용 409, actor/command/key 변경 시 별도 receipt scope, different-key 동일 report finalization 단일 승자, stale409 뒤 최신 revision 재조회, 알림 실패 전체 rollback/재시도를 검사한다. |
| provider 복구 | identity 예약/외부 성공/DB finalize 사이의 유실, unknown 결과 reconciliation, claim 만료·fence 교체, 전역 quota/in-flight 경쟁, accepted 객체의 보상 삭제 금지와 folder cleanup race를 검사한다. |
| 현재 객실 경계·경합 | 최소 경로 전후 현재 room issue/projection·room version·배정·현재/다음 occupancy·입실 차단 상태 digest가 불변인지 검사한다. 현재 객실 연결은 최종 정책 결정 후 배정 교체·새 체크인·해결 command와 양쪽 lock 획득 순서를 실제 병렬 transaction으로 검증한다. |
| 원 자료 digest | 원 제출 DTO와 원 submission/attempt snapshot, photo bindings/seal, bomb report/decision, inspection, preparation proof, earning/payroll, 원 retention records/links/expiry, 과거 성공 receipt를 전후 비교한다. 원 photo current/items에도 새 row가 없어야 한다. |
| 신규 보존 | 새 증빙만 해결+180일, true orphan만 최초 provider upload+30일, retry clock 불변, attach↔purge prepare 단일 승자, uncertain DELETE 뒤 재연결 거부, 원 승인 사진의 기존168시간 만료 보존을 검사한다. |
| API/ACL/노출 | Fastify/Edge/OpenAPI·생성 client 요청/응답 parity, bounded 조회·no-store, RLS/direct DML/EXECUTE matrix, memo/PIN/PII/provider/raw payload 비노출과 알림 source provenance를 검사한다. |

digest는 변경 전후 같은 고정 평가 시각에서 비교해 정상 시간 경과에 따른
`mediaAvailability` 변화를 신고 mutation으로 오인하지 않는다. pending 보고 검사와 그 뒤의
정상 승인 검사는 나누고, 정상 승인 자체가 만드는 결정·earning 변화는 신고의 보존 검사와
구별한다. immutable 원장과 원 binding membership은 byte/집합 모두 보존하며, 처음 구현 시
과거 자료를 새 원장으로 backfill하지 않는다.

구현 후 저장소의 실제 `npm run typecheck`, `npm test`, `npm run build`,
`npm run ci:quality`, `npm run edge:check`, migration manifest 검사를 실행한다.
schema/RLS 변경은 fresh `npm run db:reset`, `npm run db:verify`, 전용 isolated upgrade,
`npm run db:test`, `npm run db:test:long-stay-clock`, `npm run db:test:concurrency`와
역할별 실제 SQL 검사를 추가한다. 새로운 전용 command가 필요하면 실제 구현한 이름과 결과를
기록하고 계획용 명령을 실행한 것으로 쓰지 않는다. `db:reset`을 못 하면 DB 검증 PASS로 표시하지 않는다.

Docker가 꺼져 있으면 workspace AGENTS의 DockerSafeStart 스크립트만 사용하고,
`docker desktop status`·`docker version` server 연결 확인 뒤 DB 검증을 시작한다.
문서 설계 단계에서는 Docker/DB를 시작하지 않는다. 운영 배포 전 실제 백업/복원은 모든
개발 후속의 별도 필수 gate이며 합성 local 회귀로 운영 복구 완료를 대체하지 않는다.

현재 완료한 범위는 정본·source·pinned 프런트의 설계 대조와 이 문서 작성, 독립 순수 계약
foundation, 미등록 source/draft·typed upload/seal/retention/outbox API·SQL 후보와 각 checkpoint에 기록한 실제 source 검증이다. 최종 정책 답변,
endpoint 등록, fresh DB/실제 경합·업그레이드, 독립 QA·required CI·dev 통합,
운영 배포 및 프런트 UAT는 별도 미완료 범위로 보존한다.
