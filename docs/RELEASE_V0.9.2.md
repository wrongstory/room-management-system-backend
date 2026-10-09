# v0.9.2 사진 응답 최적화·객실 이력 조회

## 승인 및 범위

2026-10-09 사용자가 운영 배포를 승인했다. Issue #425로 추적한다.
사진 #409/PR412, nullable 명세 #410/PR423, CI 오탐 #422/PR424를 필수 CI·독립 QA 후
dev에 통합하고, 이미 dev에 병합된 #416/PR421 인덱스와 함께 release → main으로 승격한다.
v0.8.0 후보 및 백업/복원/초기화 후속, PR417~420의 별도 성능 개발은 보존·제외한다.
기존 사용자 결정대로 최종 통합 CI를 사용하고 중간 로컬 DB 전체 재적용을 반복하지 않는다.

- 사진 업로드 선택 query `includePhotoSlots=true`: accepted 뒤 현재 snapshot을 응답해 별도 GET을 생략할 수 있다. null이면 상태 GET만 재조회하고 새 키로 성공 파일을 재전송하지 않는다.
- 사진 성공 응답의 고정 숫자 `Server-Timing`과 허용 Origin 헤더 노출. 이미지 검증·권한·CAS·멱등성·no-store·보존 정책은 불변이다.
- 미완료 operation의 retentionPolicy/mediaAvailability null 쌍을 명세에 반영한다. 완료 상태는 기존 enum 필수, 공통 사진 item은 non-null 유지.
- 비밀번호 원문 검사의 무작위 숫자 충돌을 실제 SHA256과 exact RPC 계약으로 재현·검사한다. Auth runtime은 바꾸지 않는다.
- 두 객실 이력 테이블의 effective-time lookup 인덱스. 기존 행/권한/함수/recorded-order 인덱스 유지.

## 사전 운영 확인

운영 프로젝트는 `aodikrxcczbogjpsjwjt`(Seoul), recovery는 별도 프로젝트다.
2026-10-09 사전 확인: API ACTIVE42, scheduler18, main `3578fa6`, migration111/head
`20261005023103`. 촛불 이력8행/PIN 상태 이력5행이며 각각 전체 크기65536bytes였다.
이는 적용 전 관찰이며 배포 직전에 history·기존 인덱스를 다시 확인한다.
Security Advisor는 기존 leaked-password-protection WARN1 및 RLS/no-policy INFO127이다.
Auth 설정이나 deny-by-default 정책을 이 배포에서 변경하지 않는다.

## 통합 및 검증 기록

release/v0.9.2는 dev `05d163d`에서 만들었다. main과 정상 merge 시 충돌13개를
파일별 대조했다. 기존 main 문서7개를 보존하고 나머지 코드·SQL·테스트는 최신 dev를 유지했다.
이 사전 통합의 `ci:quality`는 106files/2668tests·typecheck/build/secret/OpenAPI PASS다.
이는 사진 기능까지 합친 최종 release 검증을 대신하지 않는다.

PR412의 과거 application FAIL은 Auth 테스트 오탐으로 기록하며 #424를 통합한 새 head로
다시 검증한다. PR423/424 로컬 및 독립 QA는 PASS이며 원격 CI는 각 exact head로 확인한다.
최종 source·필수 CI·독립 QA·운영 결과는 #425와 release PR에 기록한다.

## 운영 적용 순서

1. 기능 PR 및 release PR의 필수 application/migration PASS, 독립 QA, 미해결 리뷰0,
   충돌 없음, main 문서 보존을 확인한다. 관리자 우회 없이 squash한다.
2. exact main의 pending `room_event_effective_lookup_indexes` 1건만 적용한다.
   기존111 SQL/hash/history를 보존한다. `db push/reset/history repair`는 하지 않는다.
   일반 CREATE INDEX의 짧은 쓰기 잠금과 lock timeout5초, 별도 유한 전체 실행 상한을 적용한다.
   timeout/응답 유실 시 history·인덱스를 조회하고 결과 불확실 상태에서 재실행하지 않는다.
3. migration112와 두 신규 인덱스 정의·valid/ready 및 기존 인덱스 보존을 확인한다.
4. exact main에서 기존 runtime lock/static assets/verify_jwt=false를 유지해 api만 배포한다.
   실제 인증은 함수 내부에서 유지한다. scheduler/다른 worker/Secrets/Cron은 변경하지 않는다.
5. ACTIVE version, health200, exact Origin OPTIONS/PUT204·비허용403, 인증 없는 보호 조회401,
   no-store, OpenAPI150paths/162operations와 새 사진 query/nullability/header 계약을 검사한다.
6. 운영 OpenAPI로 main Swagger Pages를 갱신하고 게시 명세를 확인한다.
   프런트 #206/#207에 실제 배포 SHA·명세 및 남은 feature flag/UAT 조건을 인계한다.

## 복구와 제한

API 실패 시 직전 main `3578fa6`/API42 소스로 api만 복구한다. additive 인덱스는 기존 API와
호환되므로 급히 제거하거나 history를 삭제하지 않는다. 제거가 필요하면 별도 승인 후속 migration이다.
백업/복원은 사용자 결정대로 후속이며 이번 배포의 검증된 복구 사본은 새로 만들지 않는다.
실제 사용자 사진 업로드·PIN·계정·송금 mutation UAT는 수행한 것으로 표시하지 않는다.
운영 체감 개선율은 아직 측정하지 않았다. 프런트 source/flag를 자동 변경하지 않는다.

현재 문서는 준비 기록이다. main 병합·운영 migration/API·Pages·tag/Release 완료가 아니다.
