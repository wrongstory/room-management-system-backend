# #436 업로드 DB·Drive 세부 계측

2026-10-10 [v0.9.4/API45 운영 배포 완료](./RELEASE_V0.9.4_DEPLOYED.md).
#435 Drive ACK 재사용과 #437 세부 계측이 반영됐다. 실사용 성능 개선율은 아직 미측정이다.
삭제 개발은 보류하고 사진 업로드를 우선한다.
프런트 dev91ec7ddc의 DOCS/32·33과 #206 정상 UAT를 대조했다.
추가 1장 DB4128.2ms/Drive4491.5ms는 별도 표본이며 첫 5장 전체와 합산하지 않는다.

## 변경 범위

기존 photo_db 합계 아래에 고정 이름별 DB RPC 클라이언트 경과 시간을 추가한다.
photo_drive_token은 Google OAuth 토큰 획득을 기다린 요청별 누적 시간이다.
토큰은 기존 provider 내부 재사용/single-flight를 유지하고 timing은 인자로만 전달한다.
권한 cache·DB 함수·SQL·스키마·호출 순서·CAS·SHA·사진 품질·JSON 계약을 바꾸지 않는다.
이 변경 자체는 왕복 감소나 실사용 속도 향상이 아니라 다음 최적화를 위한 관측이다.

| Server-Timing 고정 이름 | 측정 구간 |
|---|---|
| photo_db_admit | 업로드 허용/용량 admission, 재시도 포함 |
| photo_db_begin | 일반/collection operation 시작 |
| photo_db_claim | durable 처리 claim |
| photo_db_context | provider context 조회 |
| photo_db_folder | 날짜/객실 폴더 예약 합계 |
| photo_db_identity | 이름·provider identity 예약 |
| photo_db_record | provider 저장 성공 기록 |
| photo_db_finalize | 최종 등록/권한 검증 |
| photo_db_receipt | 복구 후 현재 세션 영수증 조회(정상 경로에는 없음) |
| photo_db_snapshot | 선택 photoSlots 조회 |
| photo_db_quota | 용량 snapshot 갱신 |
| photo_db_other | 위 목록 밖 DB RPC 합계 |
| photo_drive_token | 캐시 확인/새 OAuth 발급/공유 발급 대기 누적 |

## 해석 주의

- DB 단계 시간은 API↔DB 통신·풀/서버 대기·실행을 합친 클라이언트 관찰값이다.
  SQL 실행/잠금 대기 시간만을 의미하지 않는다. SQL 진단은 별도 증거가 필요하다.
- token은 drive_ids/folders/upload/verify 및 photo_drive에 이미 포함된다. 서로 더하지 않는다.
  한 요청의 병렬 폴더 검사 두 건이 같은 토큰 발급을 50ms씩 기다리면 token100ms,
  folders50ms가 될 수 있다. 호출별 누적 대기이지 배타적인 벽시계 구간/비중이 아니다.
- token 발급 1회와 token 획득 호출 횟수는 다르다. warm cache도 0에 가까운 timing이 생긴다.
  토큰 횟수/캐시 적중률을 시간만으로 추정하지 않는다. Google 서버 내부 지연으로 단정하지 않는다.
- 기존 quotaRefresh.pending을 다른 요청이 수행 중이면 후속 요청의 대기는 total에는 포함되지만
  실제 quota/DB 하위 시간은 작업을 수행한 요청에만 기록된다. total과 단계 합은 같지 않을 수 있다.
- normal 신규 업로드+snapshot 합성 회귀는 DB10회(폴더 예약2회 포함)다. quota/recovery/replay
  분기별 횟수는 다르며 사용자 실측이 아니다. 누락된 항목은 실행되지 않은 것일 수 있다.
- 오류 응답에는 기존처럼 Server-Timing을 노출하지 않는다. accepted+photoSlots=null은
  저장 성공이므로 실패한 snapshot 대기는 숫자로 포함될 수 있다. 오류 원문은 포함하지 않는다.
- 고정 이름/숫자만 반환한다. RPC 원문 이름/인자, 사용자·객실·파일 ID, URL, 토큰/사진을 기록하지 않는다.

## 검증과 실행 경계

Node/Edge 공통 source를 생성기로 동기화한다. 정상/복구/snapshot 실패/공유 provider/동시 토큰
발급·warm cache/실패 계측/병렬 누적 의미와 기존 권한·응답 검사를 유지한다.
실제 검증 결과는 PR에 기록한다. 운영 Drive 재업로드/실기기 개선율은 NOT RUN이다.

2026-10-10 로컬: ci:quality PASS(111files/2865tests, typecheck/build 포함),
edge:check PASS(후보 bundle19,284,587bytes), manifest112 PASS, 독립 QA197tests·typecheck·
생성 bridge 일치·diff PASS, P0/P1/P2 발견0. 기존 lint warning1/info37은 유지한다.
초기 fake clock/정상 receipt 기대값·mock 타입은 보완 후 전체 재검증했다.

기능 개발 PR 당시 전체 DB는 NOT RUN이었다. 이후 사용자 승인한 release CI38044427623에서
전체 DB PASS, main CI38048098442는 같은 증거를 재사용했고 DB를 다시 실행하지 않았다.
신규 SQL/운영 migration은 없다. 로컬·CI·운영 migration/reset·재구축은
최신 사용자 결정대로 **실행 전 매번 명시 승인**을 받는다. 현재 일반 dev PR은 DB를 실행하지 않는다.
자동 전체 DB를 유발하는 release/hotfix PR 생성·push·재실행도 승인 전에 하지 않는다.

## 프런트 인계

현재 운영의 기존 성공 응답에서 선택적으로 읽는다. 필수 JSON 필드/성공 판정 조건으로 사용하지 않는다.
실측은 사진 준비/POST/화면 표시와 위 단계를 분리하고 첫 요청/후속 요청, 1/5/20장을 비교한다.
ACK 최적화/계측의 운영 배포와 실제 속도 개선 검증은 구분한다. 프런트 전역 순차 큐와 동일 key/Blob
복구를 유지하며 안전한 병렬 계약은 #411 후속이다. 추가 압축만으로 해결된다고 결론 내리지 않는다.
