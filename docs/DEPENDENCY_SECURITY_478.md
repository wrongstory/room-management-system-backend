# #478 Fastify·IP 주소 처리 보안 패치

## 범위

2026-10-23, #465/PR479의 dev `4672ee3` 다음 독립 변경이다.
제품 가이드의 인증·PIN 비노출·CAS·멱등성·원장 정책은 그대로 유지한다.

- Fastify 5.12.5 → 5.12.7 exact pin.
- rate-limit이 소비하는 ip-address override 10.7.1 → 10.7.4.
- lockfile과 report bundle 입력 해시만 동기화한다. 생성 runtime 코드/hash는 불변이다.
- DB/API/권한/환경 설정/Swagger 변경 없음. 운영 배포 완료가 아니다.

근거:
[Fastify header propertyNames 대소문자](https://github.com/advisories/GHSA-389g-gv7q-r4x8),
[IPv6 zone 처리의 과도한 실행 시간](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).
최소 수정 Fastify 5.12.6을 처음 설치했으나 해당 배포본의 fastify.js VERSION이
5.12.5로 남아 기존 실제 버전 회귀가 실패했다. 기대값을 낮추지 않고 npm이 제안하는
5.12.7로 올려 package version과 app.version이 모두 일치함을 확인했다.

## 영향 경계

Fastify는 Node 앱/검증 경로에 사용되며 현재 Supabase Edge import/lock에는 없다.
앱에는 현재 header propertyNames 규칙이 없지만 이후 사용 시에도 안전하도록 패치한다.
rate-limit은 node:net의 isIPv6를 먼저 검사하므로 모든 외부 문자열이 Address6까지
도달한다고 단정하지 않는다. 입력 검증/길이 제한을 제거하거나 임의 권한을 추가하지 않는다.
기존 동등 IPv6 /64·IPv4-mapped 주소의 로그인 rate-limit 회귀도 유지한다.

## 검증과 제한

- 설치: npm 10.9.3 lock 생성 및 `npm ci --ignore-scripts` PASS.
- 대상 회귀 9개 PASS: 실제 설치 경로, header enum/const 대소문자 거부,
  정상 header 통과, 기존 인증·안전한 오류·rate-limit 계약.
- IPv6 테스트는 별도 Node 프로세스에서 256KiB 합성 `%`와 네 종류 줄바꿈을 검사한다.
  6초 상한을 넘으면 그 자식만 종료한다. 실제 서버/사용자 요청은 보내지 않는다.
- `npm run ci:quality`: PASS, 전체 Node 125 files / 3,122 tests, typecheck/build 및
  secret/OpenAPI/lint 통과(기존 lint 24 warnings·60 infos는 유지).
- 정적 migration manifest: PASS122. 독립 QA: PASS98/100, 별도9개 PASS.
- `npm run edge:check`: PASS, 최종 후보 19,421,581 bytes로 제한 이내.
  `npm run openapi:template-client:check`: PASS. 원격 CI 결과는 연결 PR에서 확인한다.
- 변경 후 전체 npm audit: 0 vulnerabilities. registry 조회 시점의 알려진 권고 기준이며
  모든 취약점 부재의 증명은 아니다.
- 전체 DB/마이그레이션/운영 배포 NOT RUN. 필요 시 실행 전에 사용자 승인을 받는다.
- #465 문서의 잔여3건은 해당 패치 당시 관찰이며 이번 후보에서 해소됐다.
