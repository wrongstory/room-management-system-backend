# v0.6.4 사진 업로드 1차 지연 최적화

상태: release candidate. 사용자의 1차 최적화 운영 배포 승인 범위로 개발 PR #302를 승격한다.

## 변경 범위

- #301: Drive 날짜/객실/파일 후보 ID를 3회 대신 한 번에 발급하고 부모/대상 폴더 GET을 병렬화한다.
- DB가 선택한 폴더 identity, 부모 비공개 검사 후 생성, 저장 파일의 MIME/크기/SHA 확인을 유지한다.
- 권한/admission/CAS/lease/idempotency 및 재시도 복구, 정규화 bytes, 입력 5MiB/저장 300KiB 계약 불변.
- 기존 main의 릴리스 기록과 migration manifest/검증 설정을 보존한다.
- DB migration/Secrets/Cron/다른 Functions/프런트/섹션당 3장/미리보기 변경은 제외한다. tag/GitHub Release 발행 없음.

## 검증 및 성능 해석

- 개발 exact head c348a55b1a6274d4d5a089d728eb6cbc94cfb32e, dev squash e854692da92b59d5a2fad6d78725d10d0c77f1f7.
- 개발 ci:quality 578 tests, edge:check 286 tests, 독립 QA 96/100 P0/P1 0건, required application/migration CI run36159027962 PASS.
- 기존 폴더/cold OAuth 모델에서 HTTP 10→8, 직렬 대기 10→6. 가상 RTT 테스트는 전체 운영 단축률의 증거가 아니다.
- release exact-head quality/Edge/manifest/독립 QA/required CI를 확인한 뒤 main으로 squash 병합한다.
- 사전 운영 api v34 ACTIVE, migration 83개/latest 20260923172455. 이번 릴리스는 migration 내용을 변경하지 않는다.

## 배포와 복구

1. main 정본에서 npm ci, npm run ci:quality, npm run edge:check를 통과한다.
2. Node 22로 node scripts/generate-photo-edge.mjs --assets-only를 실행한다.
3. api만 Docker 로컬 번들로 배포한다. 서버 번들링 API 및 운영 DB migration은 실행하지 않는다.
4. Function 버전/ACTIVE, health 200, OpenAPI 입력/정규화 계약, 다른 Function 및 migration 미변경을 확인한다.
5. 이 변경은 정규화 bytes를 바꾸지 않으므로 필요 시 직전 main a03c772f0550f18603ba155baa7ae5f9f1f1cd00의 검증된 api 번들로 복구한다. DB 원장이나 idempotency key를 변경하지 않는다.

## 잔여 검증

- 승인된 운영 QA 계정/attempt/slot이 제공되지 않아 임의 업로드·운영 fixture를 만들지 않는다. 실제 휴대폰 전후 성능 비교는 NOT RUN.
- 프런트의 업로드 후 전체 배정 재조회 축소는 makee-ham/room-management-system#189 후속이며 이번 배포에 포함하지 않는다.
- 기존 password audit CI 검사 오탐 가능성은 #300으로 별도 추적한다. 검사 기준을 완화하지 않는다.
