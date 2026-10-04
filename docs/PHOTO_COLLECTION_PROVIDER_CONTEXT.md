# #384 사진 컬렉션 provider context의 CAS 축 정합성

## 변경 목적과 범위

제품 가이드의 확정 v9 계약은 일반 사진 최소1/최대20장, 선택 폭탄방·특이사항 각각 최대10장이다.
기존 getter는 첫 컬렉션 저장 후에도 단일 사진 pointer의 revision0과 collection revision1을
비교해 두 번째 사진을 거부했다. provider context도 admission/finalize와 같은 상태 축을 검사해야 한다.
사진 수량·템플릿 배열 정책·프런트 요청 형식·기존 원장과 snapshot을 변경하는 작업이 아니다.

기준 dev: `859f7cdcc8b7977ff0b6bf3801452336d9db62fe` / 101 migrations.
새 append: `20261004204823_photo_collection_provider_context_axis.sql` / 후보102.
#383 저장 이름은 별도 PR #385이며 이 브랜치에는 포함하지 않는다.

## 구현 계약

| operation | provider context가 검사하는 현재 값 |
|---|---|
| ordinary (`collection_item_id IS NULL`) | 기존 `attempt_photo_current.revision`, 없는 경우0 |
| collection append (item revision0) | `attempt_photo_collection_states.revision`, 없는 경우0 + item UUID의 전역 미존재 |
| collection replacement | 같은 collection revision + exact attempt/target/slot의 active item과 현재 item revision |

tombstone UUID 재사용과 NULL/범위를 벗어난 item revision은 거부한다.
getter의 기존 SQLSTATE40001 / `PHOTO_VERSION_CONFLICT`는 유지한다.
admission/finalize의 기존 collection/item 전용 오류도 바꾸지 않는다.
최신 actor/session/password/capability/담당·assignment revision, attempt lock,
lease fence/status/quota/rate limit 및 service-only ACL은 그대로다.
`get_photo_reconciliation_context`는 worker의 accepted/fenced 관측 경계이며 current CAS를
비교하지 않는다. 여기에 business CAS를 새로 넣어 정당한 정리/재조정을 막지 않는다.

원본 SQL을 수정하지 않고 적용 시점의 최신 `prosrc`/`pg_get_functiondef`에서 정확히 한
CAS fragment만 교체한다. 비어 있거나 중복/변형된 source는 migration을 중단한다.
signature/OID/owner/ACL/return/security/search_path를 보존하며 #383의 nullable `fileName`
return 확장과 비중첩이다. 테이블/권한/보존 clock/backfill/원장 DELETE는 없다.

## 실제 검증 checkpoint

- 적용 전 fresh101: 실제 admit→begin→claim→getter→folder/identity 예약→합성 provider
  acknowledgement→finalize에서 첫 사진 accepted, 다음 사진 getter 오류를 9/9로 재현했다.
  이 PASS는 기존 결함 관찰이지 다중 사진 기능 PASS가 아니다. 전체 rollback했다.
- 최초 fresh102 적용: 새 IF 내부 CASE 괄호 누락으로 syntax FAIL. 새 미적용 append만
  보완한 뒤 fresh102 `npm run db:verify` PASS. 최초 실패를 숨기지 않는다.
- `npm run ci:quality`: PASS (Node1,437/68, typecheck/build, OpenAPI137 paths/148 operations).
- `npm run edge:check`: PASS (474/0), migration manifests 5종: PASS.
- Python console: ruff/format/mypy, pytest95, ephemeral OpenAPI codegen/build source check PASS.
- `npm run db:lint:baseline`: PASS (승인된 정확한 compatibility 경고9개·catalog3개).
  원본 strict lint는 FAIL9/exit1이다. 기준을 낮추거나 신규 경고를 허용하지 않았다.
- 신규 SQL: 84/84 PASS. 최초 두 권한 오류명 기대값이 기존 `CAPABILITY_ACCESS_REQUIRED`와
  달라 82 PASS / 2 FAIL(전체 FAIL, 루트가 같은 초안을 두 번 실행)이었으며 기존 함수의 정확한 taxonomy에 맞춰
  기대값만 보완했다. SQLSTATE42501·거부 조건·권한은 바꾸지 않았다. developer head33 PASS.
- 신규 동시성: 실제2-session 잠금 중첩7건 PASS/cleanup PASS. 첫 저장 후 append,
  같은 요청 accepted replay, 교체/삭제 양방향, 19→20 상한, password/session 최신 상태를 검증했다.
  기존6 동시성 명령을 제거하지 않고 이 검사를 7번째로 연결했다.
- source 조합: fresh101에서 #384 단독, #383→#384, #384→#383 모두 PASS.
  같은 함수 OID/owner/ACL/security/search_path/return/arguments, 첫 저장 row의 byte-exact 보존,
  #384에서 worker source 불변, duplicate/source-drift 거부, 두 번째 전체 provider chain을
  실제 검증했다. 조합에서는 새 한국어 이름과 .jpg 확장자도 확인했다. 첫 조합 진단은
  테스트 정규식의 확장자 누락으로 FAIL(같은 진단 두 번)이었고 기대값 보완 후 통과했다.
  transaction rollback과 fresh102 정리를 수행했다. 이는 두 PR의 통합 CI나 운영 PASS가 아니다.
- 전체 `npm run db:test`: PASS/exit0. 26 historical upgrades와 SQL4,802/80 files를
  같은 신규102 후보에서 전체 명령으로 다시 실행했다. 신규84를 포함하며 최초 실패 이력은 보존한다.
- `npm run db:test:static-warning`: PASS. source-drift atomic rollback, 기존 row/catalog/ACL/RLS/
  receipt/replay와 raw17→9/exact baseline 비교를 보존하고 fresh102로 정리했다.
- `npm run db:test:long-stay-clock`: PASS145 (KST 5경계 ×29).
- 전체 `npm run db:test:concurrency`: PASS/exit0. 기존6개 명령과 신규 실제 사진 경합7건을
  7번째 명령으로 함께 재실행했다. 알림 fixture drain93회/현재 처리 가능 잔여0,
  PIN·세션·주급·사진 기존 경합과 새 경합 및 마지막 fresh cleanup이 모두 통과했다.
- `npm run backup:dry-run`: PASS, local-synthetic102/rooms121만 격리 복원했다.
  precommit working candidate의 소프트웨어 검사이며 실제 운영 백업/복원 완료 증거가 아니다.
- pinned CLI2.115.0의 local security/performance advisors: warn 이상0/exit0.
  `migration list --local`102 일치, 마지막 profiles/Auth users/targets/attempts/operations/
  identities/collection items 모두0, 새 guard 설치를 확인했다. 원본299 raw SHA mismatch0이다.
- 동결 runtime·최종 문서의 독립 소프트웨어 QA: PASS, 신규 P0/P1/P2=0.
  QA는 루트 실행 증거와 source/diff를 읽기 전용으로 검토했으며 별도 DB 실행은 하지 않았다.
  final source/dev 점수·승인·병합과 운영 승인은 exact-head CI·후속 gate 전까지 보류한다.
- exact-head application/migration CI: 커밋/PR 이후 후속 gate.

Windows CRLF 문제로 승인된 LF 임시 검증본을 사용하며 원본 migration과 canonical manifest
hash는 보존한다. SQL provider acknowledgement는 DB metadata fixture일 뿐 실제 Drive HTTP,
이미지 byte 검증이나 사용자 UAT가 아니다.

프런트 read-only 재확인: dev `09ed28446a4fd43919cddb29ebe442b848548ab8`의
`WIREFRAME/index.html` 9586–9636은 순차 큐에서 각 job 전에 현재 collection revision을
조회하며 item UUID와 binary/idempotency key를 재시도에 유지한다. 공개 upload 계약 변경은
불필요하다. main `d509b44b1371f25d73891e04d355b0cb0e923f5f`과 운영 artifact/UI 실행은
별도로 확인해야 하며 전역 기준 snapshot을 이 제한된 조사로 갱신하지 않는다.

## 배포와 후속 경계

feature→dev 검증/PR과 운영 반영은 별개다. #382 배열 순서 정책, #383 이름 통합,
#329 기존 PR #372의 최신 dev 통합·재검증 → #318 → #330 → #332,
release/main 검증·보호된 병합·운영 smoke는 별도 gate다. #329는 확정 A안의 기존 세션만
허용하며 새로운 로그인/TTL을 발급하지 않는다. 기존 CI를 새 통합 head의 PASS로 대체하지 않는다.
실제 Supabase 백업/복원은 사용자 결정대로 모든 개발 이후 후속으로 남기되
운영 배포 전 필수 조건으로 유지한다. production/recovery DB·Drive·프런트·Auth 설정·
키·실제 객실 PIN/송금·배포·태그를 이번 작업에서 변경하지 않는다.
