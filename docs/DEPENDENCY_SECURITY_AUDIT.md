# #334 Node 의존성 보안 패치

## 범위와 기준

2026-10-05, `dev@e93869aadc082372e01253e729e6ddbabe2c83d3`의 npm lock을 조사한
별도 개발 후보다. 원본 `npm audit --json`은 High 2 / Moderate 1 / Critical 0,
취약 패키지 3개를 보고했다. 중복 major 항목을 제외한 공식 GHSA는 13개다.
이는 실제 공격·정보 유출·기존 운영 장애 원인이 확인됐다는 뜻이 아니다.

- [Issue #334](https://github.com/wrongstory/room-management-system-backend/issues/334)의 의존성 패치·회귀만 포함한다.
- `AI_BACKEND_PRODUCT_GUIDE.md`의 서버 비밀정보 보호와 source/dev·운영 gate 분리를 따른다.
- 공개 API, 업무 정책, 프런트, migration, RLS, DB/Auth 설정, 비밀값과 실제 객실 PIN은 변경하지 않는다.
- `npm audit fix --force`, 안전 검사 우회, 취약 패키지 삭제로 검사에서 숨기는 조치는 사용하지 않는다.

## 선택한 최소 패치와 의존 관계

| 패키지 | 기준 버전 | 고정 패치 | 소비자 계약 |
|---|---|---|---|
| Fastify | 5.12.1 | 5.12.5 | 직접 exact dependency, 동일 5.x |
| fast-uri | 4.1.3 | 4.1.5 | `@fastify/ajv-compiler`·`fast-json-stringify`의 4.x |
| fast-uri | 3.1.6 | 3.1.8 | Ajv 8.20.0의 `^3.0.1` |
| ip-address | 10.5.0 | 10.7.1 | `@fastify/rate-limit` 11.2.0의 `^10.2.0` |

공식 릴리스: [Fastify 5.12.5](https://github.com/fastify/fastify/releases/tag/v5.12.5),
[fast-uri 4.1.5](https://github.com/fastify/fast-uri/releases/tag/v4.1.5),
[fast-uri 3.1.8](https://github.com/fastify/fast-uri/releases/tag/v3.1.8),
[ip-address 10.7.1](https://github.com/beaugunderson/ip-address/releases/tag/v10.7.1).

root `overrides`는 `fast-uri@^3.0.0 → 3.1.8`, `fast-uri@^4.0.0 → 4.1.5`,
`ip-address → 10.7.1`로 나눈다. 전체 fast-uri를 4.x로 강제하지 않는다.
이는 조사한 최소 보안 패치를 재현하기 위한 고정이며 모든 미래 취약점의 해결 보장이 아니다.
소비자 자체 업데이트 시 major 계약·모든 lock/실제 설치 사본·audit을 재확인한 뒤 override 제거를 검토한다.
override 적용으로 npm hoisting 위치가 달라질 수 있으므로 root 경로 한 개만 검사하지 않는다.

## 공식 advisory와 이번 소스의 노출 범위

아래 영향 판단은 upstream 조건과 현재 소스의 대조 결과이며 실제 운영 공격 재현 결과가 아니다.

| 공식 advisory | 최소 수정 버전 | 조건·이번 판단 |
|---|---|---|
| [Fastify GHSA-p68q-wchp-6fh7](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7) | 5.12.2 | malformed URL이 sibling custom not-found hook을 우회. 앱에서 custom not-found handler는 확인되지 않음 |
| [Fastify GHSA-667r-xxjv-c9mm](https://github.com/fastify/fastify/security/advisories/GHSA-667r-xxjv-c9mm) | 5.12.2 | async validator 결과의 value/error 해석 충돌. 앱에서 해당 `$async` request-schema 설정은 확인되지 않음 |
| [Fastify GHSA-hwr6-493r-vm6h](https://github.com/fastify/fastify/security/advisories/GHSA-hwr6-493r-vm6h) | 5.12.2 | boolean false route schema 검사 생략. 앱은 Zod로 입력을 직접 검사 |
| [Fastify GHSA-9q9j-q6p8-xq58](https://github.com/fastify/fastify/security/advisories/GHSA-9q9j-q6p8-xq58) | 5.12.2 | mixed-case header schema dependency 정규화. 해당 요청 schema 구성은 확인되지 않음 |
| [Fastify GHSA-4mh8-r7rc-xpvc](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc) | 5.12.5 | HTTP/2 reply trailer에서 금지된 Transfer-Encoding. 현재 `buildApp`은 HTTP/2를 켜지 않음 |
| [fast-uri GHSA-qw65-cvwx-89v3](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3) | 3.1.7 / 4.1.4 | 검증되지 않은 port 직렬화의 authority 주입. 직접 앱 URL allowlist 호출은 확인되지 않음 |
| [fast-uri GHSA-58mr-gqgx-xq4g](https://github.com/fastify/fast-uri/security/advisories/GHSA-58mr-gqgx-xq4g) | 3.1.7 / 4.1.4 | 닫히지 않은 bracket authority의 host 해석 혼동. 간접 schema resolver 사본도 패치 |
| [fast-uri GHSA-hrr3-gc8f-f4qj](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj) | 3.1.8 / 4.1.5 | percent-encoded host case 정규화 문제. 따라서 이전 3.1.7 / 4.1.4만으로 종료하지 않음 |
| [fast-uri GHSA-jvvf-x445-j334](https://github.com/fastify/fast-uri/security/advisories/GHSA-jvvf-x445-j334) | 4.1.5 | mailto header 주입. 앱의 mailto 직렬화 사용은 확인되지 않음 |
| [ip-address GHSA-rpw4-54j3-4h4q](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rpw4-54j3-4h4q) | 10.5.1 | IPv6 link-local 범위 오분류. rate-limit은 `isLinkLocal`을 호출하지 않음 |
| [ip-address GHSA-2vr4-cq9g-pvrc](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-2vr4-cq9g-pvrc) | 10.5.1 | local-use NAT64 분류 누락. rate-limit은 해당 분류 함수를 호출하지 않음 |
| [ip-address GHSA-j6r3-76f7-8jcv](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-j6r3-76f7-8jcv) | 10.7.1 | cross-family subnet 검사 우회. rate-limit은 `isInSubnet`/`isHostInSubnet`을 호출하지 않음 |
| [ip-address GHSA-h3mg-xc3c-68pw](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-h3mg-xc3c-68pw) | 10.7.1 | 비정상적으로 긴 Address6 입력의 CPU·메모리 소모. rate-limit은 Node `isIPv6` 확인 후 Address6로 정규화 |

### Node와 운영 Edge는 별도 판단

`src/app.ts`는 Fastify, 전역 rate-limit(120회/분), 로그인 제한(10회/분), `trustProxy: true`를 쓴다.
rate-limit의 IPv6 `/64` 묶음과 IPv4-mapped IPv6 정규화는 실제 요청 경로이므로 회귀 검사한다.
기존 proxy 신뢰 설정을 바꾸거나 임의 forwarded header가 인증 권한을 증명한다고 해석하지 않는다.
Node API를 별도로 노출할 때는 기존의 신뢰 가능한 proxy/ingress 전제를 배포 담당자가 다시 확인한다.

제품 가이드와 `ARCHITECTURE.md`의 현재 운영 runtime은 Supabase Edge Functions(Deno)다.
`supabase/functions/api/index.ts`는 `Deno.serve`를 사용하고 Edge 소스에는 이번 Fastify·fast-uri·ip-address
runtime import가 확인되지 않았다. npm 취약 목록만으로 운영 Edge가 동일하게 취약하다고 단정하지 않는다.
반대로 audit 0만으로 Edge 또는 전체 공급망 안전을 증명하지도 않는다.
Fastify는 개발·회귀·rollback 기준선이므로 운영 직접 경로 미확인 여부와 무관하게 패치한다.

## 회귀와 완료 gate

`tests/dependency-security.test.ts`는 모든 lock 사본과 각 소비자가 실제 설치에서 해석하는 버전을 검사한다.
실제 `buildApp` injection으로 health·Helmet·CORS, IPv6 같은 `/64` 및 IPv4-mapped 표기의 로그인 제한 공유,
다른 IP의 독립 제한, 제한 뒤 서비스 미호출, 기존 인증·안전한 generic 오류 응답을 확인한다.
합성 credential만 쓰며 실제 DB나 원격 서버를 호출하지 않는다.
응답 비노출 검사이며 raw exception 로그 전체의 안전을 증명하는 검사는 아니다. PIN 진단 기록은 #317의 별도 범위다.

| 검증 | 현재 상태 |
|---|---|
| 기준 `npm audit --json` | FAIL: 기존 High 2 / Moderate 1 |
| 패치 `npm ci --ignore-scripts` / `npm audit --json` | PASS: 주 작업자 실행, 패치 audit 0 |
| `npm test -- tests/dependency-security.test.ts` | PASS: 5 tests / 1 file |
| `npx --no-install biome lint tests/dependency-security.test.ts` | PASS: 1 file, 수정 없음 |
| `npm run ci:quality` | PASS: secret scan 847 files, OpenAPI 137 paths / 148 operations, lint(기존 INFO 5개)·typecheck·1437 tests / 68 files·build |
| `npm run db:manifest:verify` | PASS: release/dev manifest 5개, dev 101개 migration·기존 head 유지 |
| `npm run edge:check` | PASS: Edge 470 tests / 0 failed, bundle 17,520,061 bytes·20 MB gate 통과 |
| required application/migration CI | NOT RUN: push 후 정확한 PR HEAD에서 별도 판정 |
| 독립 QA | PASS: 전체 source 98/100, P0/P1/P2 0; 별도 검토자가 신설 5개 회귀를 재실행해 통과 |
| dev 병합 | NOT RUN |
| 실제 운영 exploit 재현·운영 배포·운영 DB 검사 | NOT RUN: 이번 로컬 소스 범위에서 실행하지 않음 |

모든 필수 로컬 검증·required CI·독립 QA 완료 전 source/dev 완료로 표시하지 않는다.
병합·운영 배포는 별도 gate이며, 이 패치는 migration 파일이나 운영 DB를 적용하지 않는다.
