# #487 Zod·URI 의존성 보안 보완

## 범위와 근거

2026-10-25 dev b13d3d8 기반 후보. Zod 4.4.3 → 4.6.6,
fast-uri 3.1.8 → 3.1.9 / 4.1.5 → 4.2.3으로 같은 major 안에서 갱신한다.
Ajv의 3.x, Fastify compiler·serializer의 4.x 경계를 유지한다.
#479/#480의 Vite/Vitest/Fastify/ip-address 패치는 그대로 보존한다.

- [Zod oversized collection](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- [fast-uri encoded scheme](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)
- [relative normalization](https://github.com/advisories/GHSA-xhq7-xmqj-769h)
- [host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr)
- [suffix colon](https://github.com/advisories/GHSA-333x-w4r6-6crp)

Zod는 Node 입력 검사와 제출 후 신고 Edge의 실제 생성 번들에 포함된다.
Node package/lock, Edge 생성 원본·7개 import, bundle manifest, 검증용 Deno lock을 함께 갱신한다.
배포용 deno.lock은 Zod를 외부 package로 로드하지 않고 검토된 생성 JS를 사용하므로 그대로다.
fast-uri는 Ajv/JSON schema/serializer 경로에서 소비된다. 업무 URL 보안 검사에서
취약한 함수를 사용한 공격 성공이나 실제 운영 사고를 입증한 것은 아니다.

## 재현과 검증

- npm audit: 변경 전 high 1 / moderate 4 → 변경 후 0.
- ci:quality: 127 files / 3,170 tests, lint/typecheck/build/OpenAPI/secret 검사 PASS.
- manifest: 기존 릴리스 manifest와 dev 122개 PASS. DB 실행이 아니다.
- 회귀: max10 배열에 10,000개 입력 시 요소 검증 0회/오류 1개; 정상 입력 유지.
- 실제 3개 consumer의 encoded scheme/상대 경로/colon/잘못된 host 경계 확인.
- Edge 전체 검사 PASS: 후보 번들 19,857,666 bytes (20,000,000 제한 이내).
- 독립 QA: 7 files / 343 tests, 생성 원본·번들·lock·문서 검토 PASS, 차단 결함 0.
- 원격 CI 결과와 병합 상태는 PR의 최종 증거를 따른다.

생성 명령은 generate-post-approval-report-edge.mjs와 generate-post-approval-report-bundle.mjs다.
Deno 2.1.4 고정 이미지로 기존 graph에서 사용하지 않는 구 Zod 항목만 제외한 임시 seed를
install --entrypoint로 재생성했다. Supabase·Node type의 기존 버전/무결성은 보존한다.
Docker는 Safe Start 후 server 연결을 확인했다. DB 컨테이너나 migration은 실행하지 않았다.

## 프런트·릴리스 경계

정상 HTTP/JSON·사진 수량·메모·권한·CAS·멱등성 계약은 유지한다. 프런트 수정 불필요.
과도한 입력은 기존 실패 계약으로 거부하며 요청 제한을 완화하지 않는다.
운영 미배포이며 마지막 확인된 운영 기록은 v0.9.9/API53/DB122다.
새 migration은 없다. Full DB/실제 SQL/경합/운영 migration/배포 NOT RUN.
DB 검증 입력이 의존성·Edge 변경으로 달라졌으므로 과거 전체 DB 증거를 자동 재사용하지 않는다.
최종 릴리스 입력 확정 뒤 DB 실행 전에 사용자 승인을 받아야 한다.
롤백은 이전 릴리스로 되돌릴 수 있으나 해당 의존성 경고도 돌아오므로 별도 판단한다.
