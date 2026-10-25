# #422 비밀번호 원문 유출 검사 오탐 수정

## 원인과 범위

PR #412 head `3fca56c`의 application CI run `37917904395`에서 `tests/auth.test.ts`의 JSON 부분문자열 검사가 실패했다. 무작위 nonce로 만든 정상적인 64자리 SHA-256 claim digest 내부에 합성 임시 비밀번호 `1234`와 같은 숫자가 우연히 포함됐다. 이 실패만으로 원문 전송을 입증할 수 없다. 실패한 CI를 통과로 취급하거나 반복 실행으로 숨기지 않는다.

Auth 서비스·비밀번호 정책·API·DB·migration은 변경하지 않는다. 사용자 결정이나 보안 기준을 완화하는 변경이 아니라 기존 비저장 계약의 결정적 검사다.

## 검사 변경

- `randomUUID`만 일회성 고정하고 실제 SHA-256/HMAC은 유지한다. 각 테스트 후 mock을 초기화한다.
- claim nonce `42200000-0000-4000-8000-0000000000e7`의 실제 SHA-256에 `1234`가 들어감을 명시적으로 확인해 이전 오탐을 재현한다.
- prepare RPC의 키 전체와 값을 정확히 검사한다. 세 digest는 비밀번호 없이 actor/command 또는 domain-separated nonce로 계산한 기대값과 같아야 한다.
- 추가 원문 필드, digest 자리에 들어간 임시/변환/새 비밀번호 및 비밀번호 SHA-256을 거부한다. 이는 검사 helper에 변조 payload를 넣은 회귀이며 운영 코드 전체에 mutation 도구를 실행한 결과는 아니다.

## 검증 (2026-10-09)

- `npx vitest run tests/auth.test.ts`: PASS, 20 tests.
- `npm run ci:quality`: PASS, 106 files / 2674 tests, typecheck/build/secret/OpenAPI 검사 포함. 기존 lint info 19건이며 오류 없음.
- 별도 검토 에이전트: 관련 20 tests 직접 실행 및 코드 검토 PASS, P0/P1/P2 없음.
- `git diff --check`: PASS.
- Edge/DB/Python 재실행: NOT RUN, 해당 소스·계약 변경 없음. 원격 필수 application/migration은 PR에서 별도 확인한다.
- 운영 배포, 실제 Auth 호출, 비밀번호 변경, DB 적용: 수행하지 않음.

## 후속

필수 CI와 보호 규칙 확인 후 dev에 통합하고 사진 성능 PR #412에 반영해 새 head를 검증한다. 그 전까지 #412의 기존 application 결과는 FAIL로 유지한다. rollback은 테스트 변경만 되돌리며 운영 데이터 영향은 없다.
