# v1.0.3 근거리 배정 요금 균형 긴급 수정

- 운영 main의 배정 수정 후 과도한 요금 불균형을 개선한다. 사용자 선택: 최고·최저 기본 청소요금 차이를 유효 배정 대상 중 가장 비싼 객실 1건 요금 이내로 목표 설정한다.
- 최대 배정 수 → 목표 초과분 → 호수 → 엘리베이터 → 층 → 요금 격차/편차를 비교한다. 연속 호수 묶음 시작안을 추가한다. 기존 담당·재청소 귀속·중복 차단·층수 고정 제한 없음은 유지한다.
- 근무 가능 0건 후보도 0원으로 계산한다. 차단된 고가 대상과 fixed-excluded 메이드의 요금은 목표를 부풀리지 않는다. 제한된 탐색이므로 목표 달성이나 전역 최적성을 보장하지 않는다. 기존 요약에서 실제 격차와 목표를 표시한다.
- main 기준 pure core 수정과 bundled releaseVersion 1.0.3만 반영한다. 진행 중인 다른 release/v1.0.2의 알림/기기 푸시 변경은 포함하지 않는다. 다른 작업이 먼저 운영 반영되면 latest main을 보존한 최종 입력을 다시 확인한다.
- 새 migration, 운영 DB 적용, 기존 배정/이력 쓰기, schema/RPC/CAS/멱등성 변경 없음. 원격 DB 재구축은 하지 않는다.
- 소스 검증: Node 22.23.2 application 233파일/6,342테스트, typecheck/build, core 81테스트, Deno 2.1.4 core 7테스트, Edge 전체 bundle, manifest PASS. 프런트 4개 너비·수동 변경 합계·0원·누락·저장 재시도·중복 차단 회귀 PASS.
- 2026-11-06 사용자가 이번 수정의 CI 격리 임시 DB 전체 검증 1회와 통과 후 서버·화면 배포를 명시 승인했다. 이 hotfix 최종 입력에 1회 실행하며 이전 수정의 승인을 재사용하지 않는다. 이 문서 작성 시 Full DB NOT RUN이며 실행 결과는 해당 PR/CI 증거로 확인한다.
- 승인 뒤 exact hotfix 최종 입력에서 application/full DB required checks를 통과하고 main 보호 병합한다. main은 동일 입력 성공 proof를 재사용하며 DB를 다시 구축하지 않는다. 해당 main의 api만 배포하고 상태/health/OpenAPI/릴리스 소스/다른 Functions/운영 migration history 보존 및 프런트 산출물을 확인한 뒤 v1.0.3 태그를 만든다.
- 운영 계정의 실제 배정 저장·통보와 실기기 PWA 갱신은 이번 검증 범위가 아니다. 대기/실패를 PASS로 기록하지 않는다.

## 운영 확인 — 2026-11-06

- [PR #603](https://github.com/wrongstory/room-management-system-backend/pull/603)을 보호 병합한 main `07aa21f6091d112922a8eeffec2a96b1a193868b`의 `api`만 배포했다. API 59 ACTIVE, bundled release 1.0.3, 태그 `v1.0.3`이다.
- 승인된 실제 격리 DB 실행은 [CI 42153728323](https://github.com/wrongstory/room-management-system-backend/actions/runs/42153728323) attempt 1회다. fresh/SQL/upgrade/호환 경고/날짜 경계/경합/cleanup/proof 저장과 application이 모두 성공했다. 지문은 `cc4a9aab11fecec989971fd46fbe208d006bf48b7f4af0fa3760ba7350e37063`이다.
- 먼저 생성한 #602/run 42153575457은 점(.)이 있는 hotfix 이름을 gate가 거부해 DB start/reset/SQL 전부 skipped였다. 그 실패를 성공으로 재사용하지 않았다. 실제 DB는 이름을 바로잡은 #603에서만 1회 실행했다.
- [main CI 42158155087](https://github.com/wrongstory/room-management-system-backend/actions/runs/42158155087)은 같은 지문과 원 실행 attempt 1을 재사용했다. main의 application/migration 모두 성공했고 추가 DB 재구축은 0회다.
- 운영 health 200, 공개 OpenAPI 161경로 exact main 일치, 익명 배정/가격표 조회 401, 배포 릴리스 모듈의 동일 TS→JS 변환 후 소스 일치 PASS. 다른 4개 Function version/번들 해시 유지. migration history는 전후 150건/마지막 `20261104211056`으로 동일하며 운영 migration은 0건이다.
- Security Advisor는 배포 전후 기존 Auth 경고 1건이 동일하고 새 항목은 없다. 후속 조회의 임시 CLI 로그인 실패는 순차 재조회로 해소했으며 실패를 PASS로 간주하지 않았다.
- 프런트 [PR #319](https://github.com/makee-ham/room-management-system/pull/319) main `1bb66fc1045712d3f8f52bd405b77819f4afaaab`, Vercel deployment `dpl_DoxXprmADVS5fmJKuP3NEGcjqfna`, SW `2026-11-06-8`. 운영 HTML SHA256 `e7f3db577e36cb4e7def9d951379eb2d443aa0e8f6e5547067991705a82aa1c0`과 정적 파일 4개가 산출물과 일치한다. runtime config/모든 feature flag 유지, 비공개 개발 파일 비게시, 관리자 6개·메이드 4개 메뉴의 360/390/768/1440px/콘솔/실제 익명 로그인/새 SW 캐시 PASS.
- 화면 검증은 운영 호스팅에서 runtime만 데모로 가로챘다. 실제 운영 배정 저장·통보/실데이터 동시 명령/실기기 기존 PWA 갱신은 수행하지 않았다. 기존 담당과 과거 청소 의무는 자동으로 바꾸지 않는다.
- #601에서 계산기·정책은 이미 dev에 병합됐으므로 후속 동기화 PR은 릴리스 버전/기록만 추가한다. dev의 후속 알림·푸시·SQL fixture 변경을 보존한다. 이 동기화 PR은 개발 manifest 검사만 하며 전체 DB를 실행하지 않는다.
