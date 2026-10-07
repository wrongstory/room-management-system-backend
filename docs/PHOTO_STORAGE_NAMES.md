# 사진 실제 저장 이름 — #383

## 사용자 결정과 범위

2026-10-05 사용자 요청은 화면 표시뿐 아니라 실제 Google Drive 저장 이름 변경이다.
새 v9 사진은 `YYYY-MM-DD_유형_호실_번호.확장자`로 저장한다.

| 동결 슬롯 | 유형 | 예시 |
|---|---|---|
| cleaning-proof | 일반방 | `2026-10-05_일반방_350_01.jpg` |
| bomb-proof | 폭탄방 | `2026-10-05_폭탄방_350_02.jpg` |
| issue-proof | 특이사항 | `2026-10-05_특이사항_350_100.webp` |

날짜는 기존 KST 업로드 폴더 날짜다. 유형과 호실은 서버의 동결 슬롯 및
통보/Drive identity snapshot에서 취하며 client filename·촬영 시각·자유입력은 사용하지 않는다.
번호는 서버 전역 양수 bigint 순번(최소 2자리, 99 다음 100)이고 고유성만 보장한다.
객실별 매일 01부터 시작하거나 번호가 연속이라고 보장하지 않는다.
객실 PIN·고객/직원 정보·provider ID·secret은 이름에 넣지 않는다.

## 불변 identity와 호환

- 새 service-only `reserve_named_photo_provider_identity`가 기존 actor/session,
  capability/assignment revision, admission/lease fence, folder winner 검사를 재사용한다.
- provider create 전에 기존 identity 예약과 같은 transaction에서 private 이름 binding을 확정한다.
- 최초 예약 이름은 retry·409·응답 유실·reconciliation에도 그대로다.
- 기존 `reserve_photo_provider_identity`는 유지하며 이전 API가 생성하는 UUID 이름은 바꾸지 않는다.
- 이미 예약된 identity에 이름을 사후 생성하지 않는다. 과거 이름/파일/DB 원장은 일괄 변경하지 않는다.
- pre-v9 등 확정된 세 유형이 아닌 슬롯은 분류를 추측하지 않고 기존 UUID 이름을 유지한다.
- Drive file ID/object ID/appProperties, parent, MIME, size, 실제 SHA 및 immutable createdTime 검사는 유지한다.
- 이름은 내부 photo ID·slot·room 관계, CAS, ownership, 검수·보존 명세를 대신하지 않는다.

## 조회와 API

공개 업로드 endpoint/query/body는 변경하지 않는다. 업로드 DTO/알림/감사에 provider identity를 노출하지 않는다.
기존 인증 content proxy가 provider 대기 전후 권한·보존·이름 일치를 확인한 뒤에만 응답한다.
새 사진은 `inline; filename="photo.jpg"; filename*=UTF-8''...` 형태로 서버 이름을 제공한다.
legacy는 기존 `photo.jpg|webp`를 유지한다. Unicode 이름을 raw HTTP header에 넣거나
Drive 응답의 `Content-Disposition`을 전달하지 않는다. 인증 content 응답은
`Access-Control-Expose-Headers: Content-Disposition`으로 허용된 프런트의 fetch에서도 이 서버 이름을 읽을 수 있게 한다.
프런트의 실제 다운로드 UI 연결은 별도다. 모든 content는 `no-store`다.

## 배포 순서와 rollback

append migration을 먼저 적용한 뒤 새 API를 배포한다. 기존 API는 기존 RPC/UUID 이름으로 계속 작동한다.
새 API는 명명 RPC가 없는 이전 DB에서 동작한다고 주장하지 않는다.
이름이 있는 사진 생성 후에는 이름 인식 API/provider를 유지해야 한다. 무조건 이전 API로 되돌리면
이전 provider 검증이 UUID 이름만 기대하므로 신규 사진의 업로드 재시도/reconcile 작업이 실패할 수 있다.
복구는 이름 인식 구현을 보존한 forward fix 또는 해당 릴리스의 별도 검증된 rollback 절차를 따른다.
이름만 바꾸기 위해 사진을 rename/move/delete하지 않는다. purge는 기존 불변 ID와 fence를 사용한다.

## 검증 상태

### 2026-10-05 #384 dev 통합 후 보강 후보

#384 PR386은 dev `bb4fa40`에 보호 squash됐으며 #383은 해당 dev를 정상 merge한
103 migration 후보에서 아래 누락 회귀를 보강했다. 기존 102 후보의 PASS로 대체하지 않는다.

- `npm run ci:quality`: PASS, Node1,591/69파일, 기존 lint INFO5; typecheck/build/비밀 검사 포함.
- `npm run edge:check`: PASS, 476/0, bundle17,527,955 bytes. 5개 manifest 검증 PASS.
- Python ruff/format/mypy/pytest95/codegen/build-check PASS. 기존 binary/중복 schema codegen 경고는 유지한다.
- 원본302개 raw SHA를 보존한 승인된 LF 임시본에서 fresh103/head 일치 PASS.
- 저장 이름 SQL177: PASS. named/UUID accepted 보존 삭제와 never-accepted 보상/orphan의
  실제 claim/context/retry/새 fence/404/replay, locator 제거와 이름·photo·acceptance·identity 이력 보존을 검사했다.
- 새 실제 두 세션 예약 경합7개 및 fresh local cleanup PASS: 동일 재시도/상이 후보 충돌,
  다른 operation 고유 번호·이름, old→named/named→old, password/session 변경. actor/lease/digest 음성 검사는 별도다.
- fake-provider worker44 추가: Node 전체에 포함. 불확실 조회·accepted/compensated 무삭제,
  immutable 이름/정확한 ID, 최신 보상 권한/fence, 응답 유실 재시도를 검사한다. 실제 Drive 검증이 아니다.
- raw strict FAIL9/exit1, 승인된 exact9/catalog3 baseline gate PASS; local-synthetic 복원 PASS.
- 전체 `npm run db:test`는 26 upgrades와 81파일/4,979 SQL assertions PASS다.
  static upgrade100→101 및 KST5×29 검사도 PASS다. staged quality 재실행은 Node1,591/69파일,
  secret859·OpenAPI137/148·typecheck/build PASS이며 기존 INFO5는 유지한다.
- 전체8개 경합 첫 실행은 첫 reservation suite 안의 기존 offline fixture가 요청 전에 만료돼
  `clock fixture has not expired before request`로 FAIL/exit1이었다. 나머지7개 aggregate 명령은
  그 실행에서 NOT RUN이다. source·lease TTL·guard·assertion을 바꾸지 않고 fresh103 cleanup 후
  같은 전체 명령을 1회 제한 재실행하여 **전체8개 명령과 최종 cleanup PASS/exit0**를 확인했다.
  재실행 로그 SHA256은 `f69aef280d10879ff228bc6a6adb347c37a0163a1b92ad2f3431a050ce6aab68`이며
  최초 FAIL(`22684856edadb0d20bb7f579a8f79e6025bb01bdbd2c7601ea9775a9ff73d568`)과 원 보고서를 보존한다.
  Windows의 실제 Docker child 호출·직렬103 migration 재설정 관찰은 유한20분 안에 끝났다.
  SQL/fixture/TTL/assertion/CI timeout 변경이나 세 번째 재시도는 없었다.
- 최종 읽기 전용 metadata 확인은 migration103/head 일치·public RLS 누락0·객실121,
  Auth/session/profile/target/photo operation/name binding0이다. 원본302 raw SHA와 실제 준비 규칙
  (SQL/psql만 LF, 실행 스크립트·config 등은 raw copy) 대응 불일치0이며 이전8개 완료 로그 SHA도 일치한다.
  [#388 준비시간/clock 보완](https://github.com/wrongstory/room-management-system-backend/issues/388)은 별도다.
  최종 staged 독립 QA·새 exact-head CI·Ready·dev 병합은 아직 완료하지 않았다.

보강 SQL 첫 실행은 fresh 업로드에 과거 domain 만료만 붙여 immutable `purge_after`와 충돌해
`PHOTO_PURGE_TIME_INVALID`로 FAIL했다. guard를 유지하고 별도 INSERT-only historical named/UUID
모델 fixture로 바꿨다. 재실행에서 누락된 historical admission/binding 및 PL/pgSQL local 변수
qualification을 보완한 뒤 대상177이 통과했다. 세 실패 로그는 보존하며 실제 reservation RPC 회귀와
historical owner-only cleanup fixture를 구별한다. immutable UPDATE·trigger 해제·기존 SQL 수정은 없다.
orphan의 실제30일 enqueue/not-due를 먼저 검사하고 worker retry의 mutable queue clock만 합성 fast-forward한다.

운영/복구 DB·Auth·API·실제 사진/PIN·Drive·백업/복원·태그는 변경하지 않았다.
기존 v0.8.0 후보를 유지하며 최신 기능 운영 승격은 별도 [#387 v0.9.0](https://github.com/wrongstory/room-management-system-backend/issues/387)에서 추적한다.
실제 백업/복원은 모든 backend 개발 후속이되 운영 배포 전 필수다. #382 배열 순서 정책은 별도 구현이다.

### 과거 102 migration source 후보 checkpoint

source 구현 후보의 검증 결과는 다음과 같다. 운영 완료나 Ready/병합 판정은 아니다.

| 검증 | 실제 결과 |
|---|---|
| Node quality/typecheck/test/build | PASS: `npm run ci:quality`, 1547 tests/69 files, 기존 lint INFO5 |
| generated Edge | PASS: generator check 및 `npm run edge:check`, 476/0, bundle 17,496,715 bytes |
| manifest/fresh local DB | PASS: 5 manifests, dev102, canonical LF 임시본에서 `db:verify`와 최종 `db:reset -- --local --no-seed`로 102 migration 재적용 |
| 신규 SQL/실제 역할 | PASS: 대상 71 assertions, actor/session/fence/folder·불변 이름·legacy·read/reconcile·grant/RLS 검사 |
| historical upgrades | PASS: `npm run db:test` 내부 26개 upgrade 단계. 아래 최종 SQL 실패와 구분 |
| 전체 SQL | PASS: fixture 보완 후 `supabase test db supabase/tests --local`, 80 files/4789 assertions |
| KST 시각 | PASS: 5 경계 시각 ×29 assertions |
| 기존 동시 처리 회귀 | PASS: `npm run db:test:concurrency`의 6개 명령 및 local cleanup. 사진 저장·폴더·보존/PIN·배정·정산 경합 포함 |
| 최종 로컬 정리 | PASS: migrations102/head 일치·RLS 활성, 합성 profile/Auth/session/photo operation/name binding 0; 기본 객실121 유지 |
| raw strict / 승인 baseline | FAIL9/exit1 / PASS: Decision #373 exact9 및 catalog3 fingerprint, 신규 경고 없음 |
| Python 운영도구 | PASS: pytest95, ruff/format/mypy/codegen/build-check; 기존 binary codegen 경고 유지 |
| 독립 범위 QA | PASS98/100, 신규 P0/P1/P2=0. 최종 staged 문서/tree 확인은 PR에서 추적하며 새 exact-head CI와 별도 |

최초 Node 검사는 manifest/head 미갱신과 추가 HTTP fixture의 불완전 mock 타입을 보완한 뒤 통과했다.
신규 SQL은 legacy catalog 및 clock/revision fixture 보완 후 대상71이 통과했다.
전체 `npm run db:test` 최초 실행은 26개 upgrade 이후 SQL의 기존 developer 진단 head 기대값3건으로 FAIL했다.
현재102/이전101 기대값만 갱신하여 대상33과 전체80 SQL을 다시 실행해 PASS했으며, assertion/음성 검사/운영 guard를 삭제하거나 낮추지 않았다.
통합 `npm run db:test` 명령 전체를 수정 뒤 재실행한 것으로 기록하지 않는다.
신규 이름만 격리한 purge/동시 예약 검사는 NOT RUN이며 기존 ID-only purge/공통 lock 경계의 정적 검토와 구분한다.
기존 다중 사진 업로드 P1 [#384](https://github.com/wrongstory/room-management-system-backend/issues/384)는
이번 변경과 별도이며 운영 승격 전에 수정·검증해야 한다.
운영 API·실제 Drive upload/rename·프런트 UI/UAT·운영/복구 DB 변경·백업/복원은 NOT RUN이다.
기존 #323/#382의 사진 템플릿 입력 순열 정책은 이 이름 변경으로 해결됐다고 간주하지 않는다.
