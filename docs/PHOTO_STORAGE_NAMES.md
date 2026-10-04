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
