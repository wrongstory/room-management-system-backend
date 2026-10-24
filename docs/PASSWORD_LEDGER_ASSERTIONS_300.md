# #300 비밀번호 원장 검사 오탐 보완

## 범위

2026-10-24 source 후보. #404/PR #405에서 완료한 audit 검사는 유지하고,
`password_change_replay.sql`의 private receipt/version/reset marker 3곳에 남은
whole-row 짧은 숫자 정규식 검사를 교체한다. 실제 유출 사고나 과거 실패 행의
정확한 원인을 확인했다는 뜻은 아니다.

제품 가이드 §10의 비밀번호·파생 verifier·token·raw session 비저장 원칙과
ARCHITECTURE의 private password provenance 계약을 따른다.
운영 코드/API/권한/동시성/멱등성/스키마는 변경하지 않는다. 신규 migration은 없다.

## 검사 계약

- receipt 3행, password version 4행, reset marker 2행을 정확히 비교한다.
- request/effect/claim/session digest, actor, command, 상태, reset 실행 FK를
  fixture의 독립 기대값으로 비교한다. session digest는 알려진 session fixture에서
  domain-separated SHA-256 입력을 별도로 구성한다.
- 초기 version과 직접 변경 뒤 version은 검사 직전 row를 복사하지 않고 먼저 관찰한
  값을 사용한다. 기존 version 회전·메타데이터 갱신·rollback 검사는 유지한다.
- 동적 ID와 시각만 타입 검사로 분리한다. nullable 시각과 상태의 관계는 실제 table
  CHECK가 강제한다. 새 필드·누락 필드·비밀 sentinel·nested secret은 거부한다.
- UUID·시각·정확한 nonsecret digest/version에 `1234` 또는 `654321`가 포함돼도
  정상값으로 허용한다. 알려진 Auth hash와 그 SHA-256를 version으로 복사한 경우는 거부한다.
- 기존 raw session UUID 비저장 검사와 public audit effect marker 비노출 검사를 유지한다.

## 검증 및 남은 gate

- 기준/수정 후 application: 126 files / 3,133 tests PASS.
- `npm run ci:quality` PASS (기존 lint warning/info 있음).
- `npm run db:manifest:verify` PASS, dev manifest 122건 그대로.
- 별도 에이전트 독립 정적 QA: 차단 결함 없음. SQL runtime PASS는 아님.
- **Full DB / 변경 pgTAP SQL NOT RUN.** Docker 엔진도 현재 중지 상태이며
  reset/start/migration을 수행하지 않았다. 사용자 승인 후 최종 격리 DB 검증에 포함한다.
- source PR에서 이슈를 자동 종료하지 않는다. 실제 SQL 검증 증거가 필요하다.

다음 순서는 #345 delivery clock 보완, #273 안전한 실제 복사·복원 실행기,
#12 Supabase Free 정기 자동 백업이다. 자동 백업은 필수이며 foundation PR이나
수동 복사 1회만으로 완료 처리하지 않는다.
