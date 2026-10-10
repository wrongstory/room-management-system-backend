# v0.9.4 사진 업로드 후보 — #438

2026-10-10: 운영 미배포. 사용자는 CI 격리 DB 최종 통합검증 1회를 승인했다.
main 병합/운영 DB·API 변경/태그·Release 발행은 이번 실행에 포함하지 않는다.
실패 후 자동 재실행하지 않으며 추가 migration/reset 실행은 다시 승인을 받는다.

## 범위

- 기준 최신 dev634bfc85f5a1ebf8b0e6939d848ebef645af9c4d.
- #434 / PR435: 완전한 Drive create ACK의 동일 검증 재사용으로 중복 GET 감소.
  partial/lost/409는 같은 ID로 재조회, checksum/권한/폴더/createdTime 검증 유지.
- #436 / PR437: DB RPC 단계·Drive token 대기 숫자 계측. 누적/포함 관계와 shared quota
  대기 한계는 [계측 인계](./PHOTO_STAGE_TIMING_436.md)를 따른다. 자체 성능 향상 주장이 아니다.
- 권한/CAS/멱등성/사진 품질/JSON/API 경로/OpenAPI151paths·163operations 유지.
- SQL·migration·manifest·의존성 변경0. source112개는 기존 운영 v0.9.3과 동일하다.
- 삭제, 썸네일, 병렬 업로드, 백업/복원/초기화는 이번 범위가 아니다.

## 통합과 보존

최신 dev에서 release/v0.9.4를 만들고 main72771b5를 정상 merge한다. squash 이력 때문에
13파일 충돌이 생겼으며 정책/사진 source·test는 검증된 최신 dev를 유지했다. main-only
이전 릴리스 문서5개와 과거 checkpoint를 보존하고 프런트 인계는 최신 상태 뒤에 과거 표기를 남긴다.
generated Edge는 원본에서 재생성한다. 비서술 입력은 최신 dev와 동일해야 한다.
기존 v0.8.0 및 다른 Draft PR/작업공간/프런트 source는 변경하지 않는다.

## 검증 계획 및 승인 경계

로컬: application/typecheck/build, Edge, manifest, 비서술 입력 동일성 및 독립 QA.
로컬 DB는 실행하지 않는다. CI release PR에서 승인받은 최종1회만 수행한다:
fresh112 → template → exact lint baseline → 합성 backup dry-run → SQL/upgrade →
static-warning/KST → concurrency → cleanup → 정확한 입력 full proof.
이 묶음은 내부 upgrade fixture 재구축을 포함하지만 workflow 실행은1회다.
운영 백업/복원이나 데이터 초기화를 수행하는 것이 아니다.

CI application/migration·독립 QA·미해결 리뷰0·보호 규칙을 확인한다. 통과한 정확한 입력의
증거만 이후 같은 PR/main 검증에서 재사용한다. 성공 증거 부재/입력 변경/실패는 PASS로
표현하지 않으며 승인 없이 새 전체 DB 실행을 유발하는 push·재실행을 하지 않는다.
실행 결과/입력 지문은 PR/이슈에 기록한다. 여기의 계획을 PASS로 해석하지 않는다.

## 이후 운영 적용과 확인 (이번에는 미실행)

로컬 사전 결과: ci:quality 111파일/2,865 tests·typecheck/build·secret/OpenAPI PASS,
edge:check PASS(후보 번들19,284,587 bytes), 정적 manifest112 PASS.
독립 QA 관련197 tests·생성 코드 일치 PASS, 문서 오해 표기 보완 후 미해결 P0/P1/P2=0.
Git 비서술 입력 지문은 dev와 동일한
`10ac431a47dcc1868784f33b0e8b7bd27650f0d80c6f6c7e63b802e09389ba24`다.
CI DB 검증은 아직 미실행이며 위 결과를 DB PASS로 해석하지 않는다.

별도 승인 후 보호 main 병합 → 동일 입력 증거 확인 → 기존 API artifact 보존 → API만 배포 →
health/OpenAPI/CORS/no-store 및 지정 사진 실측 → Swagger/프런트 인계/Release 기록 순서다.
SQL차이0이 유지되면 운영 migration은0회이며 drift가 있으면 중단하고 확인한다.
운영 history·Advisor·실제 API 상태를 이 문서만으로 새로 확인했다고 주장하지 않는다.
실제 모바일 업로드/hosted ACK 완전성/단계별 지연/개선율은 NOT RUN이다.
사진 원문/토큰/URL을 계측 로그에 기록하지 않으며 프런트 전역 순차 큐를 유지한다.

Rollback은 기존 v0.9.3/main72771b5 API artifact로 복귀한다. 신규 DB 변경이 없어 undo/repair가
필요하지 않으며 이미 저장된 사진·원장을 바꾸지 않는다. 실제 rollback은 미실행이다.

Refs #438 #411 #434 #436
