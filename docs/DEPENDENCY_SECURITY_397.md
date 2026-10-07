# #397 source-map-js 보안 패치

2026-10-06 `npm audit --json`에서 high 1건을 재현했다.
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)는
1.2.2를 수정 버전으로 명시한다. root override를 정확히 1.2.2로 고정하고 npm이
lockfile을 재생성했다. lock 변경은 source-map-js의 version/resolved/integrity 3개뿐이다.

의존 경로는 devDependency vitest → vite → postcss → source-map-js이다.
이 경로를 운영 API의 직접 취약점으로 단정하지 않는다. 운영 배포 artifact는 변경하지 않았다.
기존 Fastify/fast-uri/ip-address 보안 pin은 그대로 유지한다.

검증:
- npm ci --ignore-scripts: PASS
- npm audit --json: PASS, 취약점 0건
- npm run ci:quality: PASS, 로컬 #396 미커밋 fixture 포함 87 files / 1970 tests
- typecheck/build 및 OpenAPI 140 paths / 151 operations PASS
- 처음 실행에서는 기존 override 정확 목록 테스트 1건 FAIL. 목록에 새 pin을 추가하고
  모든 lockfile 복사본 및 실제 postcss consumer 해석 검증을 확장한 뒤 전체 재실행 PASS.

DB/API/환경변수/스키마 변경 없음. 모델·데이터 학습/평가 해당 없음.
배포 전 exact commit CI 및 독립 QA를 별도 확인한다. #396 미커밋 파일은 이 변경에 포함하지 않는다.
