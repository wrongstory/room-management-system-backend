# PIN 증분 worker 입장·완료 관측 — #396 source134

이 문서는 미적용 source 계약이다. 실제 DB/SQL/TLS, Google 호출, credential 조회,
운영 worker 활성화와 reset은 실행하지 않았다. 기존 photo deletion HOLD와 PIN
전체 재동기화 #137 보류를 유지한다. PIN 전송 대상의 hosted mapping도 확정하지 않는다.

## 적용 조건과 보장 범위

`PIN_OPERATION_ADMISSION_MODE`는 기본 `disabled`다. 명시 `required`는 공통
`DEVELOPER_OPERATION_TARGET`과 신뢰하는 `SUPABASE_URL`의 정확한 프로젝트 일치를
요구한다. 현재 승인된 Sheet mapping은 `local/local`뿐이고 이 모드의 hosted target과
일치하지 않으므로 현재 운영 설정으로 활성화할 수 없다. 승인된 mapping/credential/ACL,
배포 source, 실행 주기와 최초 control 설치 전 ingress 정지·기존 작업 종료 관측은
별도 운영 입력이다. 합성 테스트의 mapping 포트 대체는 그 승인을 대신하지 않는다.

기본 비활성 동작은 기존 worker를 유지한다. 명시 모드에서 control이 없으면 기존
증분 claim/settle을 수행하되 admission 완료 증거를 만들지 않는다. 이것은 reset 허용이나
전역 coverage 완성을 뜻하지 않는다. control 설치 이전의 작업, legacy RPC 직접 호출,
owner SQL, Sheet 직접 편집은 이 wrapper의 보장 밖이다. 전체 write 경로와 배포 상태를
확인하기 전에는 drain 완료로 판정할 수 없다.

## 같은 실행의 관측

`claim_operation_pin_incremental`은 control 잠금, admission과 실제 증분 claim을
한 transaction에서 수행한다. 기존 full-resync claim 호출은 하지 않는다. 대기·처리·실패·
operator-blocked full-resync가 있으면 `OPERATION_PIN_FULL_RESYNC_HOLD`로 차단한다.
이는 전체 보드 작업의 lease나 불확실한 외부 전송을 복구·해제하지 않는다.

기존 admissions에 `ROOM_PIN_SHEET_INCREMENTAL` context만 추가한다. 전용 claim UUID는
고유하며, target/environment/target digest/nonce와 실제 fence, outbox ID/PIN version에
묶는다. context에는 PIN 원문·암호문·객실 번호·Sheet ID·credential·provider response를
넣지 않는다. 새 table이나 reset 분류 변경은 없다.

고정 `dispatch_operation_pin_incremental`은 `RENEW`, `AUTHORIZE`, `SETTLE`, `HEARTBEAT`
네 동작과 정확한 인수만 받는다. 기존 typed RPC를 호출하고 그 결과를 같은 transaction의
해당 admission에 기록한다. 직접 SQL/function 이름을 받지 않고 외부 호출을 transaction
안에서 기다리지 않는다. provider 호출은 기존 Node/Edge worker에 남는다.

기존 outbox는 mutable하고 settle에는 terminal 재생 shortcut이 있다. 따라서 wrapper는
그 호출 전에 같은 processing job/claim/fence/version을 잠가 확인한다. 뒤늦은 legacy settle,
다음 시도의 성공, 최신 PIN의 superseded 상태만으로 오래된 admission을 완료할 수 없다.
특히 원 settle이 새 PIN 존재 때문에 불확실한 결과를 `superseded`로 바꿔도 wrapper는
원래 관측을 `UNKNOWN`으로 남긴다. 고유 context는 이미 관측한 terminal을 다시 바꾸지 않는다.

`complete_operation_pin_incremental`은 해당 admission의 모든 item이 알려진 성공,
이미 현재 값, 또는 provider 호출 전 superseded로 관측됐고, 마지막 heartbeat도 같은
dispatch 안에서 성공으로 기록됐을 때만 완료한다. 단순 HTTP 성공, caller Boolean,
전역 최신 heartbeat, pending 0, lease 만료나 elapsed time은 완료 근거가 아니다.
Service-role와 검토된 runtime/typed provider 결과를 신뢰하는 계약이며, Google의 독립
암호학적 증명이나 실제 사람의 승인 증명이라고 주장하지 않는다.

## 시간 초과와 실패

기존 45초 실행 예산으로 전체 wrapper 관측과 RPC를 제한한다. 이 값은 새 제품 TTL이
아니다. 멈춘 provider가 나중에 돌아와도 adapter는 추가 settle/heartbeat/claim을 거부한다.
이는 외부 요청이 취소됐다는 보장이 아니므로 admission은 미완료로 남는다. claim 응답 유실,
알 수 없는 provider 결과, DB settle 유실, heartbeat 실패도 자동 해제하지 않는다.
completion 응답만 유실됐다면 DB의 실제 completed_at이 정본이며 재전송 성공을 추측하지 않는다.
알 수 없는 효과를 정리하는 operator 절차와 완료 원장 보존 기간은 이 source에서 확정하지 않는다.

## 검증 경계

Node fake ports는 enabled/disabled, 원자 claim 전달, 고정 dispatch, target/nonce/fence,
반복 claim, malformed response, failure fallback, 유한 deadline과 late settle 차단을 검사한다.
실제 Node worker에는 합성 mapping 포트만 주입해 연결을 검사하고, 실제 Node/Edge mapping
HOLD가 DB/provider 호출 전에 거부되는 회귀를 별도로 유지한다. Edge는 canonical helper를
생성해 사용한다.

`supabase/tests/operation_pin_worker_admission.sql`은 rollback-only 합성 fixture로
정확한 terminal·heartbeat, 유지보수 요청, nonce/claim 재사용 거부, 최신 PIN superseded와
후속 성공의 이전 UNKNOWN 해제 금지, legacy terminal 차용 거부, full-resync HOLD를 준비한다.
PG15/17 AST parsing은 구문 검사이며 PL/pgSQL·실제 격리·잠금·경합 검증은 아니다.
이 SQL은 별도 승인된 최종 DB 검증 전까지 **NOT RUN**이다.

초기 Node 통합 fixture는 hosted mapping의 두 번째 digest 검증 때문에 1건 실패했다.
운영 mapping을 완화하지 않고 mapping/digest 포트를 모두 합성으로 고정해 보완했으며
기존 실제 hosted 거부 회귀를 유지했다. 검사 결과는 최종 통합 입력 기준으로 PR에 기록한다.

2026-10-25 source133 통합 입력: `ci:quality` PASS(175 files / 4,794 tests,
typecheck/build 포함), 전체 Edge PASS(65 / 558 / 68, report 19,899,781 bytes,
backup 99,006 bytes), manifest134/PG15·17 AST/생성물 검사 PASS. 독립 QA 49건 통과 뒤
권고된 실제 Node one-item write/current 회귀 2건을 추가했고 관련 3파일 51건 및 typecheck가
다시 통과했다. 전체 4,796건을 실행했다고 주장하지 않는다. 초기 optional config fixture의
타입 오류도 명시적으로 `undefined`를 허용하는 기존 disabled 계약으로 보완했다.
DB/TLS/Google 호출·hosted 활성화는 계속 NOT RUN이다.
