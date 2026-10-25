# #378 기존 whole-file migration history 비교 계약

기존 운영 history의 확인된 110행은 SQL 파일 전체 또는 제한된 줄바꿈 변환 결과를
`statements` 배열의 원소 하나에 저장했다.
새 apply의 고정 Supabase CLI 2.115.0 모델은 파일을 여러 logical token으로 나눈다.
version 대응표만으로 두 표현을 같게 만들 수 없으므로, baseline 비교에만 별도 모델을 둔다.
새 apply serializer, DB history, 이미 적용한 migration 파일은 변경하지 않는다.

## 입력과 정확성

`createHistoricalMigrationHistoryModel`은 실제 owned immutable Git source bundle의
경로/version/name/원시 source bytes가 일치해야 생성된다. 단순 caller SQL과 source hash만으로
만들 수 없다. 입력은 기존 네 필드(`version,name,sqlBytes,sourceBinding`)와
`representation,statementSha256`만 받는다. getter, 임의 transform/SQL callback,
추가 필드, 다른 bundle/경로/원문, 잘못된 UTF-8/NUL/고립 CR은 거부한다.

| representation | 정확한 변환 |
| --- | --- |
| `SOURCE_EXACT` | Git 원시 UTF-8 bytes 그대로 |
| `SOURCE_APPEND_CRLF` | LF-only source 끝에 CRLF 하나 추가 |
| `LF_TO_CRLF_APPEND_CRLF` | LF-only source의 모든 LF를 CRLF로 바꾼 후 CRLF 하나 추가 |

변환을 추측하지 않는다. 변환 후 단일 원소의 원시 UTF-8 SHA256이 명시한
`statementSha256`과 달라지면 차단한다. source와 변환 결과는 각각 2 MiB 이하,
전체 snapshot은 기존 32 MiB/512행 상한을 따른다. 줄바꿈 변환은 dollar/string body에도
적용되는 정확한 byte 변환이지 SQL 의미 동등성 판정이 아니다.

`requestInput.historySourceMappings`의 whole-file 항목은 다음 필드를 모두 가진다.

- `sourceVersion`, `historyVersion`, `name`: 정확한 source와 실제 history 대응. version이 같아도 필요하다.
- `sqlSha256`: 변환 전 Git source 원시 bytes의 SHA256. manifest의 LF hash와 혼동하지 않는다.
- `representation`, `statementSha256`: 위 유한 변환과 변환 결과 원소의 원시 SHA256.
- `statementsSha256`: 기존 `cli-history-logical-statements-v1` 도메인의 JSON 배열 digest.
  도메인 이름은 호환성을 위해 유지하며, historical에서는 배열 길이가 정확히 1이다.

최종 예상 row는 version/name 및 `[1:1]`인 단일 원소 배열을 갖는다. 저장 문자열,
NULL/빈 원소, 차원/lower bound, row 순서 모두 기존 exact 비교를 따른다.
sourceVersion 중복/미사용 항목, hash 불일치, 다른 표현 모델에 적용한 mapping을 거부한다.
baseline 이후 pending source에 대한 mapping은 거부한다. mapping 전체는 기존 요청 digest와
구체적인 1회 실행 승인에 포함되며, 변경된 mapping은 이전 요청과 다른 입력이다.

historical 모델은 `parserEvidenceBound=false`, `executionAllowed=false`,
`DBHistoryVerified=false`, `fullStateVerified=false`, `cliParityVerified=false`를 유지한다.
parser 계획이 있는 source를 주어도 write accessor가 mode를 확인하고 거부한다.
원시 SQL/변환 문자열은 private model 내부에만 있으며 공개 metadata에 내보내지 않는다.

## 2026-10-25 읽기전용 조사 범위

운영 `aodikrxcczbogjpsjwjt`의 기존 122행에서 version/name/statement 수/배열 차원,
byte 수/줄바꿈 수/서버측 SHA256만 bounded SELECT로 확인했다. 원문 SQL, 키,
업무 데이터는 읽지 않았고 DB 변경은 없었다. 운영 122행은 모두 `[1:1]` 단일 원소였으며,
그중 110행의 whole-file 대응만 증명했다. 나머지 12행을 같은 표현으로 추정하지 않는다.
현재 Git 원문과 서버 **원시** SHA 비교 결과는 다음과 같다.

| 결과 | 행 수 |
| --- | ---: |
| `SOURCE_EXACT`와 일치 | 48 |
| `SOURCE_APPEND_CRLF`와 일치 | 7 |
| `LF_TO_CRLF_APPEND_CRLF`와 일치 | 55 |
| 위 세 표현으로 설명되지 않음 | 12 |

처음의 LF 정규화 비교에서 나온 48+62 일치를 원시 일치로 승격하지 않았다.
추가 원시 SHA/줄바꿈 metadata로 위 48+7+55를 다시 확인했다. 주석/공백 제거 또는
transaction wrapper 제거 hash는 원인 조사에만 사용했으며 허용 변환에 포함하지 않는다.
7개 wrapper 후보, 주석 차이 후보 1개, 추가 내용 차이 후보 4개는 계속 차단한다.
추가 정확한 원문 대응/검토 없이 122행 전체 baseline을 만든 것으로 보고하지 않는다.

이 결과는 특정 source와 서버 metadata의 표현 대응이다. actual driver의 strict decoded
history readback, 적용된 DB 객체/데이터 동등성, 복구 검증, 실제 실행 승인을 증명하지 않는다.
새 source 변경 시 해당 source/hash를 다시 고정해야 한다. whole-file 모델과 runtime 연결은
합성 Git/메모리 fixture로 검증하며, 이번 수정에서 실제 SQL apply/reset/TLS 시험은 NOT RUN이다.
