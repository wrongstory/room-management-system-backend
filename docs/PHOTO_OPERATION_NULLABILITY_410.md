# #410 사진 업로드 operation nullable 명세 정합화

상태: 개발 후보, 운영 미반영. #409/PR412의 snapshot 최적화와 독립 수정이다.

## 계약

`PhotoUploadOperation`과 이를 사용하는 `PhotoUploadResponse`의 실제 기존 projection에 Swagger를 맞춘다. 런타임, DB, 보존 기간, 권한, CAS, 재시도 키 또는 저장 동작을 변경하지 않는다.

| operation 상태 | retentionPolicy / mediaAvailability |
|---|---|
| reserved, reconciliation_pending | 둘 다 null 또는 둘 다 기존 enum 값 |
| provider_succeeded, accepted, compensation_pending, compensated | 둘 다 기존 enum 값, null 금지 |

두 필드는 생략하지 않는 필수 필드다. null/문자열 혼합, 알 수 없는 enum은 거부한다. 일반 사진 항목(`AttemptPhotoItem` 등)의 공통 보존 schema는 non-null 제약을 유지한다. 이미 nullable인 보존 시각 필드는 변경하지 않는다. 이 수정이 모든 runtime 불변식을 JSON Schema에 복제한다는 의미는 아니다.

프런트는 미완료 operation의 null을 저장 완료·삭제 성공·만료로 해석하거나 기본 정책으로 채우지 않는다. 기존 operation 재조회/재조정 절차를 유지한다. 옵션 snapshot 유무나 null fallback은 #409 계약을 따르고, 백엔드 운영 반영 확인 전 옵션을 활성화하지 않는다.

## 검증

- 실제 Node projector가 만든 8가지 상태/보존 조합을 Edge projector와 비교하고, 직렬화된 OpenAPI의 operation/upload schema를 Ajv2020으로 검증한다.
- 신규 14tests: 양성8, 저장 이후 null금지4, enum/누락/쌍null/비공개 필드 거부1, 공통 사진 제약 보존1.
- 실제 일회 생성한 Python 두 모델에서 8조합 roundtrip PASS. `None`이 enum/default로 변환되거나 누락되지 않는다. 생성 모델은 조건 검증기가 아니며 상태 조건의 부정 검증은 Ajv/runtime가 담당한다.
- `npm run ci:quality`: PASS, 107files/2682tests 및 typecheck/build. 기존 lint info19.
- Python ruff/check-format/mypy 및 pytest102: PASS. codegen 기존 binary media/handover 경고는 남으며 전체 API 자동 생성 완료를 주장하지 않는다.
- 독립 QA25tests PASS, P0/P1/P2 없음.
- Edge 전체 검증: PASS, 최종 번들19,202,254bytes. 최초 형식 검사 실패는 단일 수정 파일 Deno formatter로 보완 후 재검증했다.
- migration/SQL/운영 적용: NOT RUN, 변경 없음.

JSON Schema의 `then`은 함수가 아닌 조건 키워드이므로 해당 두 줄에만 Biome thenable 오탐 사유를 명시했다. 검사 전역 해제나 런타임 검증 완화는 하지 않았다.

## 배포/복구

endpoint, 필드 이름 및 실제 응답 불변. Swagger와 생성 클라이언트 타입에만 nullable가 정확히 표현된다. 운영 배포 후 프런트가 명세/클라이언트를 재생성해 미완료 응답을 확인한다. 문서/API 빌드 rollback에는 DB 작업이 필요 없으나 이전 명세의 잘못된 non-null 타입이 다시 나타난다는 제한이 있다. 실기기 UAT는 미실행이다.
