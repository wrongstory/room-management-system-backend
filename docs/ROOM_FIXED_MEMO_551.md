# #551 객실 고정 메모 — 개발 후보 / 운영 미반영

2026-11-01 사용자 요청: 객실마다 고정 메모를 남기고 관리자가 수정하며 배정받은 메이드가 읽는다. 자동 배정·정기 청소 생성은 제외한다. 프런트 구현은 별도 담당이며 [프런트 #291](https://github.com/makee-ham/room-management-system/issues/291)에 인계한다.

## 계약

- `GET /v1/rooms/{roomId}/fixed-memo`: 활성 관리자 또는 해당 객실의 실제 통보된 현재 배정을 가진 활성 메이드. 최초 비밀번호 변경 완료·현재 유효 세션 필수.
- `PUT /v1/rooms/{roomId}/fixed-memo`: 활성 관리자만. `Idempotency-Key`와 `{ "memo": "화요일마다 청소", "expectedVersion": 0 }`.
- 응답 `{ "fixedMemo": { "roomId": "UUID", "memo": "화요일마다 청소", "version": 1, "updatedAt": "ISO timestamp" } }`.
- 미작성은 memo/updatedAt=null, version=0. 명시적 null/공백으로 비운다. 최대500 UTF-16 단위, 줄바꿈/한글/수량 허용. 이메일·전화·URL·PIN 표현은 거부한다. 일반 텍스트로 표시하고 HTML 렌더링 금지.
- expectedVersion은 **메모 자체 버전**이다. roomStateVersion/assignmentVersion을 대신 사용하지 않는다. 동시 수정409 STALE_VERSION이면 최신 조회 후 사용자가 다시 저장한다. 불확실한 통신 실패 재시도에는 동일 입력/키 유지. 다른 내용에는 새 키.
- 관리자끼리 공유하며 변경/비우기는 새 revision을 만든다. 작성자와 시각·과거본문 보존. 일반 조회에는 작성자ID/이력/내부정보를 노출하지 않는다.
- 메이드는 is_current·ended_at 없음·notified_at·현재 assignment_version·통보 객실 snapshot·typed outbox 근거를 모두 확인한다. 승인/반려 뒤에도 이 유효 배정 조건이 남으면 조회 가능. 미통보 초안·담당 해제·다른 메이드·취소된 업무는403. 실제 PIN 조회 여부는 무관하다.
- 현재 객실 메모를 보여주며 과거 배정의 메모 snapshot은 아니다. 예약/배정이 바뀌어도 객실 메모가 자동 초기화되지 않는다. #534의 배정별 지시 메모와 별도이다.
- GET/PUT 응답 no-store. 캐시를 쓰는 프런트는 역할/배정 변경 시 이전 객실 메모를 폐기한다. 완료된 저장 뒤 최신 조회를 갱신한다.

## 화면 인계

관리자 객실 상세에 읽기/편집/비우기, 배정받은 메이드 업무 상세에 읽기 전용 표시. `화요일마다 청소`는 참고 안내이며 화요일 일정 생성이나 자동 배정을 유발하지 않는다. 메모 수정 자체의 추가 push 알림은 이번 범위에 없다. 기존 배정 변경 알림은 그대로다. 개발 Swagger 경로160/operation173. 운영 Swagger/API 반영 전 운영에 호출하거나 이미 배포된 기능으로 안내하지 않는다.

## 저장·권한·경합

`private.room_fixed_memo_revisions` PK(room_id,revision), room/profile FK RESTRICT, actor FK index. RLS와 모든 runtime role 직접 접근 차단, service-role 전용 scoped RPC만 허용. 메모 revision UPDATE/DELETE 금지. 관리자 receipt replay 전후와 객실 잠금 대기 후 최신 세션을 재검사한다. 객실 잠금 + 메모 CAS + command receipt로 경쟁/재시도 중복을 막는다. 감사 payload에는 버전/비움 여부만 기록하고 메모 원문은 복사하지 않는다. 쓰기 API는 유지보수 admission에 등록한다.

새 private table은 #396 초기화 manifest의 미분류 차단 대상이다. 실제 초기화가 후속·비활성인 현재 정책을 유지하며 임의 삭제/보존 분류나 기존 이력 삭제는 하지 않는다. 초기화 완성 시 새 원장 보존·참조 계획을 검토해야 한다.

## 검증·배포 경계

- 신규 migration `20261101131722_room_fixed_memo.sql`: **작성만 완료 / 실행 NOT RUN**. source144.
- 합성 SQL `supabase/tests/room_fixed_memo.sql` 및 세션 호출자 inventory 갱신: **실제 SQL NOT RUN**. 최종 승인된 통합 DB1회에서 권한·replay·CAS·통보 배정·clearing·세션 만료를 확인한다. `scripts/test-room-fixed-memo-concurrency.mjs`는 기존 reservation 경합 runner의 동일 임시 DB 안에서 실제 세 연결과 `pg_blocking_pids` 장벽으로 여덟 경합(두 관리자 다른 키 동일 버전, 동일 키/본문, 동일 키/다른 본문, 비우기↔수정 두 승자 순서와 과거 이력 보존, receipt 대기 중 세션 폐기, 객실 잠금 대기 중 세션 만료/폐기)을 준비했다. revision·감사·receipt의 정확한 효과 수와 무효 세션의 쓰기0을 검사한다. 전체 direct entry12·reset79는 유지하며 추가 start/reset은0이다. 모듈 작업60초·연결 종료10초, 연결3초·query7초·statement5초·lock4초·idle15초·장벽3초 상한을 사용한다. 자기 연결만 종료하고 합성 원장은 기존 임시 DB 정리 범위에서 제거한다. DB 없는 장벽/오류·종료 검사와 실제 SQL/경합 성공은 구분하며 **실제 동시 DB 경합 NOT RUN**이다.
- 초기 독립 QA의 Edge 경로 추출 누락과 DB 비밀번호 필수 오류 안내를 보완했고 실제 HTTP dispatch 회귀를 추가했다. 최종 검사 결과는 PR/이슈 기록을 따른다.
- source/manifest 통과는 실제 DB 통과가 아니다. 로컬/CI/운영 migration·DB재구축 실행 전 각각 사용자 승인 필요.
- 배포 순서: 최종 릴리스 입력 확정 → 승인된 격리 DB1회 → 필수 CI/독립 QA → 승인된 운영 migration → API/Swagger → 프런트 연동·사용자 확인.
- 롤백은 이전 API로 복귀하고 새 비공개 이력은 보존한다. DB rollback 삭제나 공개 역할 grant 확대 금지. 운영 적용/배포/태그는 아직 하지 않았다.


## 2026-11-01 소스 검증 checkpoint

Node 전체216파일/5,738건 PASS. Deno65+586+68 PASS, 실제 후보 포함 번들19,999,765bytes로 20,000,000 제한 PASS(여유235bytes). 다음 기능 추가 전 번들 경량화가 필요하며 제한은 완화하지 않았다. 타입·빌드·전체 manifest144·Swagger160/173·secret scan PASS. lint는 exit0이며 기존 경고가 남아 있다. 독립 QA Node35 PASS, 초기P1/P2 수정 확인; QA 환경의 단독 Deno 실행은 실행파일 부재 BLOCKED이고 주 작업의 Docker Edge 실행 PASS와 구분한다. 실제 SQL/DB/운영은 NOT RUN. 새 SQL fixture 날짜를 transaction clock으로 고정하고 승인/반려 조회 및 취소/배정종료 차단 사례를 추가했다.

CI41311955977에서 application의 Python OpenAPI 개수 검사만 기존159/171로 남아 실패했다. Node·Edge·Python Qt139와 migration manifest는 통과했고 DB 실행은 전부 SKIPPED였다. Python 기대값/오류문구4곳을160/173으로 맞췄으며 독립 QA가 실제1경로/2operation 증가와 일치함을 확인했다. 보완 후 Python ephemeral codegen 전체, ruff lint/format PASS. 검증을 생략하거나 완화하지 않았다. Windows uv 초기 hardlink 설치 오류는 해당 실행의 copy 모드로 해소했다.
