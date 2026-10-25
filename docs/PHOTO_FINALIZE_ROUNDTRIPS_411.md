# #411 사진 최종 등록 왕복 감소 — 개발 후보

운영 API51은 변경하지 않았다. 새 migration 파일만 준비했으며 로컬/CI/운영 DB 실행은
사용자 승인 전 NOT RUN이다. 배포·실제 개선율·SQL 경합 검증 완료를 뜻하지 않는다.

## 범위와 근거

2026-10-22 최근 3장 운영 읽기 전용 측정: HTTP200/accepted 3건,
서버 처리 6.155/5.330/4.520초(평균5.335초). provider createdTime부터 accepted까지
1.740~2.148초다. 이 차이는 순수 SQL 시간이 아니며 provider 응답 전달/검증도 포함한다.
현재 로그에는 세부 Server-Timing이 보관되지 않아 DB만의 개선 목표 시간으로 사용하지 않는다.

정상 opt-in 업로드의 provider 성공 이후 호출을
`record → finalize → slots`에서 `record → finalize+slots`로 줄인다(3→2왕복).
전체 기본 경로는 quota refresh 없는 신규 업로드 기준10→9 RPC다.
SQL 문장/권한 검사 수 감소가 아니라 네트워크 왕복1회 제거다. 실제 단축 시간은 배포 후 측정한다.

## 안전 경계

- provider 성공 기록은 별도 commit으로 유지한다. Drive HTTP를 DB transaction에 넣지 않는다.
- 새 service_role 전용 SECURITY INVOKER RPC는 기존 finalize와 slots 함수를 호출한다.
  actor/live session/ownership/limited capability/CAS/fence/retention 검사를 생략하지 않는다.
- snapshot attempt는 finalize 결과에서 유도한다. 기존 HTTP allowlist projector와
  attempt/assignment/revision 일치 검사, 제한 계정 photoId 마스킹을 재사용한다.
- 일반 snapshot 오류는 중첩 예외 블록만 rollback하고 accepted + photoSlots:null을 반환한다.
  statement timeout/query cancellation/connection termination은 이 보장을 하지 않는다.
  전체 transaction 취소/응답 유실은 기존 provider 기록과 동일 key/bytes receipt 복구를 따른다.
- snapshot 동안 finalize lock 보유가 늘어나는 tradeoff가 있다. 승인 후 실제 SQL/경합 검증 필수.
- 옵션 없는 경로와 이미 accepted인 재시도·복구 경로는 기존 API/별도 snapshot 조회를 유지한다.
- 데이터 backfill, 기존 migration 수정, 삭제/병렬 업로드/썸네일/새 공개 endpoint는 없다.

## 프런트 인계

프런트 코드 변경 불필요. `includePhotoSlots=true`, 순차 큐, 동일 key/Blob 재시도 유지.
`accepted + photoSlots:null`은 저장 성공이므로 목록 GET만 재조회하고 사진을 새 키로 다시 올리지 않는다.
새 숫자 timing `photo_db_finalize_snapshot`은 최종 등록+목록 조회의 합친 왕복이다.
정상 통합 경로에 기존 `photo_db_finalize`/`photo_db_snapshot`이 없는 것은 누락 오류가 아니다.
별도 replay/GET 경로는 기존 timing 이름을 유지한다. 부모 `photo_db`에 다시 더하지 않는다.
배포 순서는 승인된 새 SQL 적용 후 API 배포다. SQL 미적용 상태에서 새 API만 배포하지 않는다.
rollback은 기존 API로 되돌리며 추가 RPC는 미사용 상태로 남길 수 있다.

## 검증 checkpoint

- 변경 전 baseline: Node123files/3102tests PASS.
- typecheck/build/lint/비밀검사/OpenAPI154paths166ops PASS. 기존 lint 경고24/info60은 남아 있다.
- 전체 Node124files/3105tests PASS, 독립 QA5files/253tests 및 diff PASS(P0/P1/P2 발견0).
- Edge 검사 PASS(최종 진단 head 동기화 후 재확인 완료), 후보 번들19,420,929bytes.
- 최초 전체 검사의 새 migration head/검사 allowlist 불일치는 exact121 SHA pin·history·진단 기준 등록으로 보완했다.
- SQL 준비 테스트에 snapshot-only 오류에도 신규 acceptance1건/null 보존, 정상 snapshot replay,
  cross-day finalize 거부·ACL을 추가했다. 이 SQL 테스트는 실행하지 않았다.
- migration 실행/전체 DB/실제 SQL 역할·경합: NOT RUN, 실행 전 별도 승인 필요.
- 실제 운영 배포/추가 사진 쓰기: NOT RUN.
