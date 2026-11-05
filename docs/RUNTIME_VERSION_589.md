# #589 런타임 릴리스·API 명세 버전 계약

## 목적과 제공 상태

사용자는 백엔드 릴리스 버전과 API 명세 버전을 구분해 제공하도록 요청했다.
기존 운영 화면은 `source.apiVersion`만 표시해 API 명세 `0.6.0`을 제품 릴리스로
오해할 수 있었다. 이번 변경은 **개발 후보**이며 운영 API/Swagger 재배포와
프런트 화면 수정은 아직 수행하지 않았다. 기존 운영 응답에는 새 필드가 없을 수 있다.

## 조회와 권한

- `GET /v1/developer/runtime-status` 응답의 `runtime.source`
- `GET /v1/developer/overview` 응답의 `overview.runtime.source`
- 현재 활성 `developer` 역할과 기존 인증·비밀번호 변경 조건을 유지한다.
  로그인 ID `admin`인 bootstrap 개발자와 business `admin` 역할은 다르다.
  업무 관리자/메이드에 개발자 상태 조회 권한을 새로 부여하지 않는다.
- 기존 `Cache-Control: no-store` 및 오류/HTTP envelope를 유지한다.
  새 요청 인자, DB 조회, migration, 운영 설정값은 추가하지 않는다.

다음은 런타임 객체의 일부 예시다.

```json
{
  "runtime": { "name": "deno", "version": "<실제 엔진 버전>" },
  "source": {
    "releaseVersion": "1.0.0",
    "apiSchemaVersion": "0.6.0",
    "apiVersion": "0.6.0",
    "expectedMigration": "finite_service_role_authority",
    "fastifyRollbackBaseline": "available"
  }
}
```

| 응답 필드 | 프런트 표시 | 의미 |
|---|---|---|
| `source.releaseVersion` | 백엔드 릴리스 `v1.0.0` | 현재 API 번들에 포함된 소스 릴리스 식별자 |
| `source.apiSchemaVersion` | API 명세 `0.6.0` | 같은 번들의 OpenAPI `info.version` |
| `source.apiVersion` | 이전 서버의 API 명세 표시용 fallback | `apiSchemaVersion`과 같은 기존 호환 별칭. 제거하지 않음 |
| `runtime.name` + `runtime.version` | 실행 엔진 `deno …` | 실제 Deno 엔진. 릴리스/명세 버전과 별개 |

`releaseVersion`은 소스 상수 `backendReleaseVersion`으로 번들에 고정한다.
다음 릴리스 준비 시 이 상수와 회귀 기대값을 같은 검토에서 갱신한다.
환경변수, npm package의 개발용 버전, DB migration 이름/개수, GitHub 최신 태그를
런타임 릴리스로 추정하지 않는다. Preview/로컬에서도 같은 소스는 같은 식별자를
가질 수 있으므로 기존 `environment`·`projectRef`를 함께 표시한다.

## 프런트 표시와 구버전 대응

1. 새 `releaseVersion`이 있으면 “백엔드 릴리스”에 표시한다. `v`는 화면 접두어이며
   응답 문자열에는 없다. 없거나 빈 값이면 “확인 불가(이전 응답)”로 표시한다.
   `apiVersion`, API 주소, 현재 프런트 버전에서 `1.0.0`을 추측하지 않는다.
2. “API 명세”는 유효한 `apiSchemaVersion`을 우선하고, 없으면 기존 `apiVersion`을
   사용한다. 둘 다 없으면 “확인 불가”다. 두 필드가 다르면 불일치 안내를 남긴다.
3. 릴리스와 명세 버전이 다르다는 이유로 오류/미배포를 표시하거나 저장 기능을 막지 않는다.
   기능 지원 여부는 명세 계약과 기능별 준비 상태로 판단한다.
4. 화면 제목 “Edge runtime”은 유지할 수 있으나 하위 항목을 위 표대로 구분한다.
   문자열은 text rendering/escape 처리하며 HTML로 삽입하지 않는다.
5. 응답을 영속 저장하거나 이전 환경/세션 값을 현재 확인 결과로 재사용하지 않는다.
   인증/조회 실패는 기존 오류 상태로 표시하고 예시 버전으로 성공을 가장하지 않는다.

새 필드는 응답에 추가된다. 기존 필드 이름/값은 보존하지만 `additionalProperties:false`인
구형 프런트 응답 검증기는 새 키를 거절할 수 있으므로, 프런트 명세 snapshot과 생성 타입을
갱신하고 구형/신형 응답을 모두 검증한다. 생성 타입을 수동 편집하지 않는다.

## 버전 표시가 증명하지 않는 것

`1.0.0` 표시는 해당 API 소스의 식별자다. 전체 worker 동일 버전, 운영 DB 이력,
Git 태그/Release 발행, 전체 DB 성공 proof, 프런트 활성화, 사람 UAT 완료는 별도 증거다.
API 명세 버전이 같아도 내용이 달라질 수 있어 계약 동등성은 정확한 명세 해시로 확인한다.
기존 `fastifyRollbackBaseline=available`은 정확한 과거 운영 Edge 번들 확보를 의미하지 않는다.

## 검증·배포 순서

- DB 없는 Node typecheck/test/build·manifest, Deno 실제 runtime 응답과 OpenAPI key/type/alias
  일치·환경값 비노출·실제 엔진 버전 보존 회귀를 수행한다.
- 프런트 합성 확인: 신형 응답, 구형 응답, 필드 누락, 명세 별칭 불일치, 조회 오류,
  environment 전환을 포함한다. 프런트 소스 수정·UI 실행·실사용 UAT는 이 PR에서 NOT RUN.
- 일반 개발 PR → dev 후 정확한 새 릴리스 입력을 고정한다. API 소스가 바뀌므로 과거
  v1 전체 DB 성공 proof를 자동 재사용하지 않는다. release/hotfix PR·push가 전체 DB 검사를
  유발하면 실행 전에 별도 승인을 받는다. 검사 정책을 우회하지 않는다.
- 신규 SQL이 없으므로 이번 변경의 운영 migration 적용 건수는 0이다.
  승인된 배포 절차 후 runtime/overview와 Swagger의 새 계약을 확인하고 프런트가 연결한다.

## 개발 검증 결과 (2026-11-05)

- `npm run ci:quality`: PASS (Node 6,333건, lint/typecheck/build 포함).
- `npm run db:manifest:verify`: PASS, 기존 150개 원문 유지. Full DB NOT RUN.
- `npm run edge:check`: CI와 같은 LF 임시 소스 복사본에서 PASS
  (Deno 590건 + 생성 모듈 68건). 후보 번들 19,963,910 bytes,
  기존 20,000,000 bytes 제한까지 36,090 bytes 여유.
- Windows 원본 checkout 검사는 번들 20,008,000 bytes로 FAIL했다.
  변경 전 원본도 20,005,962 bytes였으며 LF 원본은 19,961,872 bytes다.
  줄바꿈 영향을 분리했으며 제품 코드의 포맷·용량 기준·검사기를 변경하지 않았다.
- Python 146건, Ruff·mypy·패키징 소스 검사, 현재 명세의 임시 클라이언트 생성 검사:
  PASS. 기존 콘솔은 구형/신형 응답의 원본 필드를 보존하고 대상 불일치를 계속 차단한다.
  기존 생성 모델은 알 수 없는 추가 필드를 허용하므로 수동 편집하지 않았다.
- `npm run openapi:template-client:check`: PASS. 161경로/174동작 유지.
- 독립 리뷰·프런트 UI·운영 반영·실사용 검증: NOT RUN. 배포 완료로 해석하지 않는다.
