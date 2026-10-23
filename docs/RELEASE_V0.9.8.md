# v0.9.8 사진 최종 등록 왕복 최적화

## 2026-10-23 메모 전용 신고 통합

- 사용자 승인으로 PR #475(dev 35db7b2)를 이 릴리스 후보에 포함한다.
- 사진 최종 등록 최적화와 기존 main 회귀 보완은 유지한다.
- 후속 migration122 post_approval_memo_only를 포함하며 기존121개 SQL은 변경하지 않는다.
- catalog 검사 범위는 감사된122까지이며123 이상은 거부한다. 기존 digest/source pin 검사도 보존한다.
- 메모 필수·사진0~10장 API/Edge/Swagger 계약은 MEMO_ONLY_SUPPLEMENTAL_REPORT.md를 따른다.
- 이전 CI39723508013의 전체 DB PASS는 사진 최적화 후보만의 결과다.
  이번 통합 입력의 성공 증거로 재사용하지 않는다.
- 이번 승인 범위는 통합본의 격리 CI 전체 DB 검증1회다. 실패/취소 후 재실행은 재승인한다.
  운영 migration·API 배포·태그는 수행하지 않는다.
- 메모 전용 기록 생성 후 사진 최소1장 제약 또는 비호환 API로 rollback하지 않는다.
  신규 등록을 중단하는 호환 API로 대응하고 기존 기록을 보존한다.
- 아래121개/사진 최적화만의 범위 및 검증 수치는 이전 후보의 이력이다.
- 통합 로컬 검증: ci:quality PASS(125파일3150건·타입·빌드·비밀/OpenAPI),
  edge:check PASS(후보19,425,469bytes), manifest122/diff PASS.
  실제 통합 DB 결과는 새 CI run에서 별도로 확인한다.

## 범위와 통합

- dev5e0b7c1(PR472)에서 시작, main ad1b1a0의 릴리스 문서·SQL/경합 회귀 보완을 보존한다.
- squash 이력의 add/add 충돌은 dev c1707ee의 공통 내용과 양쪽 변경을 대조했다.
  사진 최적화와 최신 API51 운영 기록은 dev, 기존 릴리스 검증 보완은 main을 유지했다.
- 신규 SQL은 photo_finalize_snapshot 1개다. 기존120개 migration은 수정하지 않는다.
- main의 catalog upgrade 엄격 검사를121까지 확장하고122 거부를 유지한다.
  개발자 진단 SQL의 기대 head7곳을 photo_finalize_snapshot으로 동기화한다.
- 공개 API/JSON/권한 정책 변경 없음. 정상 opt-in 업로드 최종 단계3→2왕복,
  quota refresh 없는 기본 경로10→9왕복. 실제 시간 개선율은 배포 후 측정한다.
- 상세 계약: [사진 최종 등록](./PHOTO_FINALIZE_ROUNDTRIPS_411.md).

## 2026-10-22 실행 승인

- 사용자 승인: 이 사진 최적화 릴리스의 격리 CI 전체 DB 검증1회.
- 실행 전 소스·합성·독립 QA를 확인하고 release PR 최초 run/입력을 기록한다.
- 실패·취소·입력 변경 시 임의 재실행하지 않고 재승인을 받는다.
- 운영 migration은 실행 직전 다시 승인받는다. main 병합·운영 API 배포·태그/Release 발행은 미실행이다.
- 전체 DB는 현재 NOT RUN이다. 개발 manifest PASS를 전체 DB PASS로 표시하지 않는다.
- 검증 범위는 fresh/upgrade/역할별 SQL/경합/기존 엄격 baseline/cleanup을 유지한다.
  운영 데이터·Auth·PIN·사진 쓰기·실제 백업/복원은 이 격리 검증에 포함하지 않는다.

## 배포와 복구 경계

승인된 신규 SQL 적용 후 API 배포가 필요하다. SQL 미적용 상태에서 API만 승격하지 않는다.
이전 API로 rollback할 수 있으며 추가 RPC는 미사용 상태로 남긴다. provider 성공 별도 commit,
기존 권한/CAS/receipt 복구를 유지한다. snapshot 동안 lock 보유가 늘어나는 영향은 최종 DB
검증 대상이며 cancellation/connection loss를 일반 snapshot 오류와 동일 취급하지 않는다.

프런트는 기존 includePhotoSlots=true·순차 큐·동일 key/Blob을 유지한다.
accepted+photoSlots:null이면 목록 GET만 재조회한다. 새 photo_db_finalize_snapshot은 합친
왕복이며 photo_db에 중복 합산하지 않는다. 운영 API51에는 아직 이 최적화가 없다.

Refs: #411, PR #472

## 최종 입력 소스 검증

- npm run ci:quality PASS: typecheck/build/lint/비밀검사/OpenAPI 및 Node125파일3137건.
- npm run edge:check PASS, 후보 번들19,423,109bytes.
- migration manifest121/hash 및 diff 검사 PASS. 기존120개 SQL 변경0.
- 독립 QA: 전체 Node3137 및 manifest PASS, 차단 P0/P1/P2 없음.
- 실제 SQL/DB/경합은 이 결과와 별개이며 승인된 최종 CI에서만 실행한다.
