# #411 같은 사진 묶음의 두 전송 후보

## 계약과 적용 상태

이 후보는 일반 사진 1~20장, 선택 폭탄방·특이사항 각각 0~10장 계약을 유지한다.
새 기능은 **같은 collection의 서로 다른 두 파일을 원자 예약**하는 백엔드 계약이다.
한 번에 보낼 수 있는 파일 수가 제품의 사진 수량 상한을 늘리지 않는다.
기존 단건 업로드는 그대로 사용할 수 있다. 프런트 코드·실제 Drive·운영 DB는 변경하지 않았다.

`POST /v1/attempts/{attemptId}/photo-slots/{slotId}/upload-batches`는 8KiB 이하 JSON을 받는다.
본인 attempt 업로드 capability가 있는 maid의 현재 세션·역할·상태를 확인한다.
active/deactivation_pending/upload_only의 기존 세부 허용 조건은 기존 DB 가드가 결정한다.
메타데이터 예약 중 이미지 decoder나 provider upload를 호출하지 않는다.

```json
{
  "assignmentId": "41100000-0000-4000-8000-000000000003",
  "assignmentRevision": 2,
  "expectedCollectionRevision": 4,
  "items": [
    { "photoItemId": "41100000-0000-4000-8000-000000000005", "expectedItemRevision": 0, "idempotencyKey": "photo-key-5" },
    { "photoItemId": "41100000-0000-4000-8000-000000000006", "expectedItemRevision": 0, "idempotencyKey": "photo-key-6" }
  ]
}
```

헤더 `Idempotency-Key`는 묶음 예약 key다. 각 item key와 서로 다른 scope로 해시한다.
예약 응답은 batchId, maximumConcurrentTransfers=2와 item별 expiresAt/quotaWarning만 제공한다.
내부 admission UUID, provider locator, hash, 원문 key는 응답하지 않는다.
두 key·순서·item·attempt·assignment·원래 collection/item revision은 재시도에서도 고정한다.
items 배열 순서는 멱등 요청의 일부이며 displayOrder 지정은 아니다. 새 item은 기존 DB 규칙대로
수락 시 남은 표시 위치를 사용하므로 역순 완료하면 표시 순서도 달라질 수 있다. 기존 item 교체는
그 item의 표시 위치를 유지한다. 프런트가 선택 순서 고정을 요구하면 별도 위치 예약 계약이 필요하다.

예약 후 각 파일은 기존 `.../photos/{photoItemId}/upload` binary 경로로 보낸다.
각각 원래 item key와 **예약 당시 collection revision**을 사용한다. 먼저 완료된 응답의
증가한 revision으로 두 번째 요청을 고쳐 보내면 다른 논리 요청으로 거부된다.
원문 body, MIME 검증, 5MiB 입력/300KiB 저장 상한, EXIF 정규화는 기존 규칙을 따른다.
프런트 연결 전에는 실제 동시 전송이 활성화됐거나 현장 지연이 개선됐다고 볼 수 없다.

## DB 불변식

- 두 admission을 한 transaction에서 생성한다. 둘째의 수량·quota·rate·권한 검증이 실패하면
  첫째 예약과 batch/member도 rollback된다. 기존 307200 byte 예약을 파일별로 계산한다.
  최초 metadata-only 예약은 이미지 CPU 횟수를 중복 차감하지 않는다. 실제 binary 요청과
  기존 admission 재시도는 매번 기존 30/min 제한을 소비하며 rate/quota 상한을 늘리지 않는다.
- batch/member는 private RLS, 직접 접근 revoke, 불변 trigger, actor/key UNIQUE와 deferred FK로
  묶인다. 다른 단건 예약을 새 묶음으로 사후 편입하거나 세 번째 member를 추가할 수 없다.
- 기존 collection 단일 active operation UNIQUE는 같은 domain lock을 잡는 guard와 동일 조회
  index로 교체한다. 서로 다른 item의 같은 batch에만 최대 두 active operation을 허용한다.
  파일별 operation/provider object/claim digest/lease는 분리하고 중복 claim은 계속 차단한다.
- 원장 expected revision과 request hash는 수정하지 않는다. collection의 한 단계 증가는
  같은 batch의 다른 item이 만든 **accepted photo + immutable collection change**가 설명할 때만
  begin/provider context/finalize에서 허용한다. 단순히 최신 버전을 읽어 덮어쓰지 않는다.
- 두 finalize는 기존 domain lock 아래 직렬 실행된다. acceptance/retention/제출 binding도
  같은 이전 revision 증거를 검사한다. receipt/audit는 실제 수락된 photo version을 기록한다.
- 예약·전송·reconciliation이 남은 batch는 제출 completeness를 통과하지 못한다.
  기존 삭제는 inflight admission 차단을 유지한다. 실패·응답 유실·폐기 후보는 기존
  reconciliation/fence 규칙을 따르며 새 삭제 기능이나 purge worker 활성화가 아니다.
- 이름 번호는 기존 sequence, provider identity는 기존 persist-before-create 경로를 재사용한다.
  외부 호출은 DB transaction 밖에서만 실행한다. 현재 role/session과 assignment/item CAS를
  완화하거나 캐시하지 않는다.

## 검증과 릴리스 순서

### #526 격리 설치에서 발견한 함수 치환 오류

2026-10-25 D03-P 승인 1회 검증에서 source `a17f97a`의 migration126은
statement9(SQLSTATE42601, syntax error at end of input)로 실패했다. 두 개의 helper 호출이
각각 `IF` 시작과 `END IF`를 넣었지만, helper는 매번 함수를 즉시 재컴파일하므로 첫 호출의
미완성 본문이 거부됐다. 다음 metadata/13개 SQL 회귀는 NOT RUN이며 자동 재실행하지 않았다.
CLI의 실패 정리 뒤 신규 자원 부재와 기존10개 container·5개 volume·5개 network 보존을 대조했다.

같은 날 production history122 및 recovery73의 읽기 확인에서 이 migration은 적용0이었다.
뒤에 새 migration을 추가해도 fresh 설치가126에서 먼저 멈추므로 **미적용126만 수정**하고
dev manifest의126 지문을 갱신한다. 이미 적용된 history·baseline 파일은 변경하지 않는다.
counter `INSERT ... ON CONFLICT ... CASE ... END` 전체를 완결된 `IF ... END IF`로 한 번에
치환하며, 30/min 차단과 실제 binary/replay 과금·최초 metadata 중복 과금 방지 의미는 유지한다.
함수 본문 검사 비활성화나 예외 무시는 사용하지 않는다.

PG15/17 소스 회귀4개는 기존 두 호출에서 FAIL한 뒤 수정본에서 PASS했다. 기존29개 batch
검사와 합계33개 PASS이며, 실제 원본 함수의 counter를 원자 치환한 결과가 이전 두 치환의
의도한 최종 결과와 바이트 단위로 일치함을 확인한다. 외부 SQL AST는 PL/pgSQL 본문을
컴파일하지 않으므로 이것을 DB 성공으로 표시하지 않는다. 수정본의 실제 설치와 기존 batch
pgTAP 과금/원자성 검사 등은 **새 고정 입력의 별도 승인 전 NOT RUN**이다.

첫 전체 검사에서는 기존 upgrade 소스 검증기의126 해시가 이전값이라 두 suite가 실패했다.
검토한 새 해시 하나로 정확한 고정을 갱신했고, 임의 tail/변조 거부 검사는 유지했다.
최종 `npm run ci:quality`는200파일/5,383 tests·typecheck/build PASS,
`npm run db:manifest:verify`도 과거 릴리스 및 dev137 모두 PASS다.

아래 수치는 최초 구현의 검증 이력이다.

새 단위 검증: 29 PASS. 메타데이터 key/CAS binding·입력 제한·응답 allowlist·Node 등록을 검증했다.
처음 전체 application 실행은 신규 OpenAPI inventory와 migration manifest/head가 아직 맞지 않아
FAIL이었다. 이 사실은 실제 SQL 실패나 성공을 뜻하지 않는다. 최신 dev125 통합 후에는
Deno migration-head fixture 한 곳이125를 가리켜 typecheck FAIL이었으며126으로 고친 뒤 재검사했다.
Python formatter는 삽입된 줄의 혼합 EOL 때문에 한 번 FAIL했고 파일 포맷 정리 후 PASS였다.

최종 source 검증은 다음과 같다.

- `npm run ci:quality`: 142파일·3495tests, typecheck, build, secret/OpenAPI157/169 검사 PASS.
- `npm run db:manifest:verify`: dev126과 과거 릴리스 manifest PASS. SQL 실행 증거가 아니다.
- `npm run edge:check`: 전체 Deno 검사와 generated bundle/runtime 검사 PASS.
  보고서 포함 후보 bundle 19,919,131 bytes로 기존20,000,000-byte gate 유지(여유80,869 bytes).
- Python3.12 frozen/copy-mode 임시 codegen/compile: 새 batch API와 응답 모델 생성 PASS.
  기존 binary media/lifecycle duplicate-model 경고는 유지하며 모든 API의 무경고 생성을 주장하지 않는다.
  변경 checker의 Ruff check/format PASS.
- 독립 QA: latest SQLpatch/CPU30min/deferred FK/CAS/expiry/retention와 경합 source 검토에 차단사항 없음.
  QA가 직접 실행한 관련4파일194tests PASS. 실제 SQL 또는 Drive 검증을 대신하지 않는다.

최신 dev493(예약 호출 서명 보안 변경)을 충돌 없이 통합한 뒤 application143파일·3512tests와
manifest126이 다시 PASS했다. 본 기능의 API157/169와 migration126은 변경하지 않았다.
동시 실행 중이던 세 worktree 검증에서는 기존 WASM decode가1500ms budget을 넘겨
Edge542 PASS/1 FAIL이었다. 다른 두 실행을 마친 뒤 코드·테스트·budget을 변경하지 않고
단독 재검사하여65+543+68 tests와 전체 gate가 PASS했다. report 후보19,930,953 bytes
(여유69,047 bytes), backup99,006 bytes다. 이 관측은 실제 운영 부하 검증을 대체하지 않는다.

dev392(9a29044)의 승인 기반 migration 실행기·pg/parser 의존성과 report manifest 변경도
정상 통합했다. npm ci144 packages/audit0, report bundle source check, manifest126 및
application158파일·4362tests가 PASS했다. 동일 입력의 최종 Edge65+543+68도 PASS하며
report19,930,953 bytes/backup99,006 bytes로 유지됐다. 실제 DB 실행기는 호출하지 않았다.

초기화 영향 조회의 source 목록에도 두 새 metadata 테이블을 사진 HOLD의 review 종속성으로
반영했다. 전체185관계·mixed/review137이며 삭제 승인이나 초기화 실행 구현은 추가하지 않았다.

`supabase/tests/photo_collection_upload_batch.sql`에는 기존 합성 DB fixture로 두 claim, 역순 완료,
멱등 replay, 원장 보존, 두 quota 예약, 둘째 실패의 원자 rollback, 선택 max10, 제출·삭제 차단,
retention binding과 세션 철회를 작성했다. **실제 SQL/DB reset/upgrade/동시 경합/Drive는 NOT RUN**이다.
기존 `test-photo-collection-provider-context-concurrency.mjs`에는 두 DB 세션의 잠금 대기를
관측한 뒤 역순 sibling finalize가 각각 한 번 수락되는 8번째 경합을 추가했다.
기존 append/수량/replace-delete/비밀번호·세션 경합을 보존했으며 새 script의 구문 검사만 실행했다.
독립 QA와 최종 승인된 릴리스 DB 검증을 통과하기 전 운영 적용하지 않는다.

배포는 승인된 migration126 → API → 프런트 연결 순서다. API rollback 시 기존 단건 경로를
사용하고, 이미 예약된 batch member는 원래 key/입력으로 회복하거나 기존 만료·reconciliation
규칙으로 정리한다. migration을 역적용하거나 원장·예약·provider identity를 지우지 않는다.
실제 DB에서 역순/동시 finalize·quota·session 철회·제출 경합을 확인하고, 실제 사진의 성공률과
지연·전송 중단을 따로 확인해야 한다. 합성 검증으로 현장 UAT를 대신하지 않는다.
