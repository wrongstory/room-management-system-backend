# #465 개발 검증 도구 보안 패치

## 범위와 원칙

2026-10-23, dev `00753e7` 기준. 사용자가 #465부터 순차 개발·독립 QA를 승인했다.
제품 가이드의 권한·PIN 비노출·업무 원장 계약은 변경하지 않는다.
DB/API/Swagger/운영 설정 변경이 없는 개발 도구 패치이며 운영 배포 완료를 뜻하지 않는다.

- Vite 8.2.2 → 8.2.4를 override로 고정한다.
- Vitest와 설치된 @vitest 패키지를 4.1.11 → 4.1.12로 함께 갱신한다.
- npm이 해석한 개발 전용 하위 패키지와 integrity를 lockfile에 기록한다.
- 모든 운영 의존성 lock entry는 동일하게 보존한다.
- Vite 서버를 외부에 노출하지 않는다. 앱 개발 실행은 기존 `tsx watch`, CI 검사는
  `vitest run`이며 browser UI/manual mock 서버를 새로 활성화하지 않는다.
- Windows editor/파일 경계 보안은 공식 수정 배포본을 사용한다. 버전 검사와 일반
  회귀 검사는 모든 upstream 공격 시나리오를 직접 재현했다는 뜻이 아니다.

근거: [Vite/launch-editor 권고](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[Vitest Windows redirect 경계](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp),
[Vitest 4.1.12](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12).
Vite의 나머지 해당 권고 및 mocker GHSA-qxg6-89mg-rqv8도 audit 재확인 대상이다.

## 검증 기록

- 변경 전 전체 Node: 125 files / 3,118 PASS.
- 변경 후 `npm ci --ignore-scripts`: PASS. npm 10.9.3 lock 생성은
  `edgesOut` 내부 오류로 실패해 npm 11.6.2로 생성했고, 기존 npm 10.9.3 설치로 재검증했다.
  시스템 npm 설정/버전은 교체하지 않았다.
- `npm run ci:quality`: PASS. secret/OpenAPI154 paths·166 operations/lint/typecheck/
  125 files·3,119 tests/build. 기존 lint 24 warnings·60 infos는 남아 있다.
- `npm run db:manifest:verify`: PASS, 122개. DB 실행 없는 정적 목록 검사다.
- `npm run edge:check`: PASS, 기본 Deno 537개·생성 JS 68개, 최종 후보 번들
  19,421,581 bytes (<20,000,000). 최초 package/lock manifest drift FAIL 뒤 공식
  `node scripts/generate-post-approval-report-bundle.mjs`로 해시 2개만 동기화했다.
  생성 코드와 bundle digest는 불변이다.
- 독립 QA: PASS(98/100), 별도 보안 회귀 6개 PASS, 차단 결함 없음.
  Windows mocker 정규화·허용 경계와 runtime lock 불변도 확인했다.
- 원격 CI·dev 통합 결과는 연결 PR에서 확인한다.
- 전체 DB/마이그레이션: NOT RUN. 실행 전 별도 사용자 승인이 필요하다.

## 남은 경고와 다음 순서

#465 대상 Vite/Vitest/mocker 경고는 패치 후 audit에서 0건이다.
전체 audit는 아직 FAIL(3개 package entries: low 1, moderate 2)이며 이를 숨기지 않는다.
Fastify GHSA-389g-gv7q-r4x8과 ip-address GHSA-rxp7-6hxx-x8q5 및
@fastify/rate-limit 간접 경고는 [#478](https://github.com/wrongstory/room-management-system-backend/issues/478)에서
별도 패치·회귀·독립 QA한다. 과거 #465의 `--omit=dev 0건`은 당시 관찰일 뿐 현재 상태가 아니다.
이 npm production 분류만으로 실제 Supabase Edge의 악용 가능성을 단정하지 않는다.
그 후 #317의 PIN 오류 안전 진단 등 후속 개발을 진행한다.
