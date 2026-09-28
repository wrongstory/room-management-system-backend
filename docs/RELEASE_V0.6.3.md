# v0.6.3 스마트폰 JPEG 업로드 복구

상태: release candidate. 개발 PR #298의 검증된 사진 수정본과 기존 main의 릴리스 manifest·검증 설정을 함께 보존한다.

## 변경 범위

- #297: 일반 JPEG에 포함된 유효 Samsung SEF metadata를 기존 strict directory/field 검증으로 수용한다. 임의 trailer와 손상 입력은 계속 거부한다.
- 원본 SOF 치수 제한을 먼저 검사하고 두 축이 모두 1280px보다 큰 JPEG만 축소 디코드하여 대형 사진의 변환 비용을 줄인다. 작은 JPEG 확대 방지, 원본 해상도 기준 품질, EXIF 방향 보정과 metadata 제거를 유지한다.
- normalized bytes/SHA 변경에 대비해 기존 동일 key의 begin 충돌에서만 legacy 정규화 복구를 1회 제공한다. 동일 admission/key/binding 및 DB exact hash/CAS 검사, 합산 decode 예산을 유지한다.
- 입력 JPEG/WebP/HEIC/HEIF 5MiB, 저장 JPEG/WebP 307200bytes, OpenAPI0.5.1과 기존 자원 상한을 유지한다.
- DB migration, Secrets, Cron, 다른 Function, 프런트, 운영 fixture/배정/사진 슬롯 변경 없음. tag/GitHub Release 발행 없음.

## 검증

- 개발 exact head bf89bb10a817516c57320584e972f2000d3c408f, dev squash f12feb4f0b0506df7b66e7817bb027470409a2c2.
- 개발 ci:quality 567 tests, Edge286 tests 및 bundle17132810bytes PASS.
- 실제 JPEG 3개 pinned Deno2.1.4에서 각5회(총15/15) PASS, JPEG110406~119583bytes. Node 출력 크기 동일. 원본/metadata/개인정보는 커밋하지 않음.
- 개발 application/migration CI run36149145044 PASS. fresh DB 재적용/SQL/동시성 회귀는 CI runner에서 수행.
- 독립 exact-head QA 96/100, P0/P1 0건. release exact-head quality/Edge/manifest/필수 CI/독립 QA는 별도 확인 후 병합한다.
- 사전 운영 api v33 ACTIVE, health200, migration83/head20260923172455. Drive 네 설정 존재, OAuth 성공 검증과는 구분.
- Security Advisor 기존 INFO89/WARN1. 인증/권한 설정 변경 없음.

## 배포 및 제한

1. release required CI와 독립 QA를 통과하고 main으로 squash 병합한다.
2. exact main에서 npm ci, npm run ci:quality, npm run edge:check 통과 후 Node22로 node scripts/generate-photo-edge.mjs --assets-only를 실행한다.
3. api만 로컬 Edge 번들 방식으로 배포한다. 서버 bundling API/DB migration/다른 Functions 배포 금지.
4. 버전/ACTIVE, health200, OpenAPI 입력/저장 계약과 다른 Functions·migration 미변경을 확인한다.
5. 승인된 QA 계정/attempt/slot이 없어 hosted 업로드, Drive/DB MIME·크기·SHA 일치, verified 조회, 실제 중복방지/응답유실 복구는 NOT RUN. 실제 스마트폰 HEIC 원본도 미제공이며 합성 HEIF 회귀만 통과했다.
6. 합산1500ms 검사는 동기 WASM 호출 후 검사이며 hosted CPU 강제 종료를 선제 방지하지 않는다. 배포 후 기존 승인된 작업의 사용자 재시도와 안전한 문의 번호로 결과를 확인한다.
7. 신규 normalized 결과가 저장된 뒤 이전 api 단순 rollback은 기존 key/hash 복구를 깨뜨릴 수 있다. 호환 경로를 유지한 forward-fix를 우선하며 DB 원장 수정/새 key 발급으로 우회하지 않는다. 구버전 복구가 필요하면 진행 중 작업과 응답 유실 복구 영향을 먼저 확인한다.

프런트 사전 용량/형식 오류 안내는 makee-ham/room-management-system#188 후속이며 이 백엔드 릴리스로 해결됐다고 주장하지 않는다.
