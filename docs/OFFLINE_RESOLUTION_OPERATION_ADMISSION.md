# #396 오프라인 격리 해결의 완료 관측

`POST /v1/offline-quarantines/{quarantineId}/resolve`의 `record_only`, `reject_effect`, `correction_link`만 기존 해결 원장과 연결한다. 업무 RPC, 해결 정책, 알림 발송, 메타데이터 90일 보관 정책은 변경하지 않는다.

서비스의 기존 정본 요청 해시는 actor, `resolve_offline`, quarantine ID, resolution, expected execution version, reason을 포함한다. HTTP 입장 어댑터는 실제 RPC의 8개 인자를 검증·고정한 뒤, 기존 admission의 command name에 resolution별 유한 식별자, key digest와 request hash를 기록한다. 추가 테이블·컬럼·원문 이벤트 복제는 없다. 과거 migration과 source130의 OPAQUE 정의는 그대로 두고 source141에서 원자적으로 binding한다.

전용 완료 RPC는 admission의 nonce·actor·Auth user·session·password version, 현재 관리자 권한을 다시 확인한다. `private.offline_event_resolutions`에서 정확한 actor·quarantine ID·resolution·key digest·request hash가 모두 일치하는 이미 확정된 행만 관측한다. 원장 행은 업무와 알림 outbox가 함께 commit한 증거이며, 잠금을 잡은 동안 admission만 종료한다. 외부 push 전송 성공은 이 증거에 포함되지 않는다.

HTTP 성공·오류·응답 유실·deadline만으로 완료하지 않는다. 응답 유실 뒤에도 같은 원장만 조회하고 업무 RPC를 재실행하지 않는다. 일치하는 행이 없거나 보관 만료로 삭제됐으면 UNKNOWN을 유지한다. 기존에 확정된 재전송 원장은 허용하되 한 admission의 종료는 1회뿐이다. REQUESTED 이후 새 입장은 막고, 앞서 들어온 정확한 작업의 종료 관측은 허용한다.

이번 연결은 HTTP 1개 경로에 한정된다. lifecycle 연결과 함께 나머지 OPAQUE 경로는 25개이며 전체 drain·보호복구·reset·운영 활성화 완료를 의미하지 않는다. `startAttemptWithLease`, `syncOfflineCompletion`, Auth/PIN/사진/외부 효과 경로의 미확인 상태를 해제하지 않는다.

합성 Node 검사는 lazy SDK 1회 실행, 3개 resolution, 인자 변조, 잘못된 완료 응답, 응답 유실, 유지보수, deadline을 다룬다. 준비된 `supabase/tests/operation_offline_resolution_admission.sql`은 롤백할 합성 부모와 기존 원장 형태를 사용하여 정확한 일치·불일치, 최신 권한, 원장 보존을 검사한다. SQL 외부 파서는 PL/pgSQL 실행이나 fixture의 실제 성공을 증명하지 않는다. 실제 migration·pgTAP·전체 DB 검증은 별도 승인 전까지 **NOT RUN**이다.
