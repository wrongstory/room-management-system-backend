# 예약 scheduler 운영 진입 제어 — #396

source133은 기존 예약 전이→배정 lifecycle→heartbeat 흐름에 선택형 admission을 연결한다.
두 업무 RPC는 기존처럼 별도 transaction이다. 첫 단계 성공 뒤 두 번째 실패가 발생하면 첫 효과가
보존되며, 전체 성공/rollback이라고 말하지 않는다. 실제 DB/worker 실행·Cron/키/운영 설정은 변경하지 않았다.

`SCHEDULER_OPERATION_ADMISSION_MODE` 기본은 absent/disabled이다. required를 선택하려면
기존 `DEVELOPER_OPERATION_TARGET`과 trusted `SUPABASE_URL`이 일치하고
`SCHEDULER_OPERATION_BUDGET_MS`를 1..120000 정수로 명시해야 한다. 이 유한 관측 예산은
재인증·보존 정책 TTL이나 원격 작업 취소 증명이 아니다. 기본값을 임의 선택하지 않는다.

DB acquire는 기존 room-admin 권한과 control row 잠금을 확인하고 프로젝트·actor·invocation bucket·
request ID·고정 command hash·nonce를 결합한다. control이 없으면 기존 동작을 유지하므로,
최초 설치에는 별도로 기존 ingress 중단과 작업 종료 증거가 필요하다. 초기화 readiness를 주장하지 않는다.

런타임은 두 업무 RPC와 성공 heartbeat만 정확한 순서/인수로 허용하며 하나의 명시 예산으로 관측한다.
lazy RPC를 다시 await해도 재실행하지 않고, 완료/오류/timeout 뒤 보관된 callback의 추가 쓰기도 차단한다.
required 모드에서 실패·무응답 RPC 뒤에는 fallback 실패 heartbeat를 새로 쓰지 않는다.
이 경우 admission은 미완료이고 응답은503이다. disabled 모드의 기존 실패 heartbeat/응답은 유지한다.

완료 RPC는 두 정확한 immutable command receipt(actor/type/key/hash) 및 이 request의 성공 heartbeat를
다시 읽는다. 기존 멱등 replay의 과거 command receipt는 허용하지만 다른 request의 heartbeat는 거절한다.
최초 heartbeat 시작 시각은 과거 재시도의 값일 수 있어 current proof로 사용하지 않는다.
acquire 당시 DB의 attempt_count를 저장하고 완료에는 그 값의 증가와 동일 request를 요구한다.
기존 동일 request·미래 client 완료시각이 있어도 새 heartbeat를 쓰기 전에는 완료할 수 없다.
client 시각이나 HTTP200만으로 완료를 인정하지 않는다.
한 단계 성공, 실패 heartbeat, lease 만료, 현재 업무 상태, 다음 실행의 성공은 옛 미완료를 해제하지 않는다.

이 내부 authority는 검토된 runtime을 신뢰한다. 직접 owner/service SQL, 임의 외부 작업, 기존 미계측
프로세스를 대신 증명하지 않으며 전체 coverage는 여전히 미완료다. timeout/응답 유실 후 자동 재실행·
admission 삭제·control 해제는 없다. 운영 전 전체 DB/경합 검증과 정확한 배포·전환 승인, 별도
미완료 판정/복구 절차가 필요하다. 승인받은 정책·실제 backup proof 없이 초기화를 활성화하지 않는다.

합성 tests는 exact sequence·변조/누락·partial success·DB refusal·callback hang·응답 유실·one-shot을 검사한다.
준비된 SQL은 syntax parser만 실행했고 pgTAP/역할/경합/실제 RPC 검증은 NOT RUN이다.
