# #586 잔여 service_role 33권한 한정 보완

2026-11-05 사용자는 D04-H1-P1 추천 A를 선택했다. 업무 권한을 보존하며
기존 public 객체 8개의 불필요한 직접 권한 33개만 회수한다. 실제 DB 검증과
운영 migration은 각각 별도 승인 대상이다. 구현·소스 검사를 운영 적용으로 표시하지 않는다.

| 대상 | 유지 | 회수 | 수 |
|---|---|---|---:|
| room_occupancy_events, room_pin_sync_events, room_candle_events, cleaning_target_schedule_revisions, reservation_schedule_revisions | 각각 SELECT, INSERT | 각각 UPDATE, REFERENCES, TRIGGER, MAINTAIN | 20 |
| assignment_change_requests | SELECT, INSERT, UPDATE | REFERENCES, TRIGGER, MAINTAIN | 3 |
| availability_candidates view | SELECT | INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN | 7 |
| complaint_case_events_id_seq | postgres 소유권·기존 definer 업무 함수의 자동 번호 생성 | service_role 직접 SELECT, USAGE, UPDATE | 3 |

기존 149개 migration 원문을 보존하고 `20261104211056_finite_service_role_authority.sql`
한 파일을 추가한다. 정확 hash는 `supabase/migration-manifest.dev.json`의 150번째 항목이다.
149의 요청 이력 DELETE/TRUNCATE 차단은 그대로 유지한다. 업무 허용 조합은 14개다.
authenticated/anon·함수 EXECUTE·owner·RLS·default ACL·role membership은 바꾸지 않는다.
행·시퀀스 값·수당·API 계약·프런트는 변경하지 않는다.

적용 전 postgres 실행자, service_role 비-superuser, 객체의 정확 이름/종류/소유자와
complaint_case_events.id의 GENERATED ALWAYS identity 의존관계를 확인한다.
4개의 명시 REVOKE는 RESTRICT로 제한한다. 적용 후 effective table/column/sequence
권한을 검사하여 PUBLIC·상속·컬럼 권한이 남거나 업무 권한이 없으면 거래를 실패시킨다.
예상 밖 권한을 추가로 회수하거나 다른 역할의 권한을 고치지 않는다.
실제 적용은 파일과 migration 이력이 함께 처리되는 승인된 원자적 실행 경로를 요구한다.

DB 없는 검사는 PG17 SQL 문법·정확 REVOKE 범위·기존149 지문·새150 exact source pin과
머리 버전 표시를 확인한다. 문법 파싱은 PL/pgSQL 실행이나 실제 권한 검증을 대신하지 않는다.
최종 승인된 전체 DB 실행에서 다음을 검증한다.

- `finite_service_role_authority.sql`: 객체·identity·33 effective deny·14 allow·컬럼 우회 차단·조회 view 보호.
- `assignment_prestart_change.sql`: 기존 요청→반려 RPC와 배정 보존, service 이력 추가,
  비어 있지 않은 5개 이력표 UPDATE의 권한 오류42501, 전체 행/필드 보존.
- `complaint_lifecycle.sql`: 실제 service 역할의 정상 complaint RPC 자동 id 생성과
  기존 모든 event 보존, 직접 sequence 읽기 거부. nextval/setval 음성 호출은 사용하지 않는다.
  sequence 변경은 transaction rollback만으로 되돌아가지 않기 때문이다.

기존 전체 SQL/upgrade/경합/소스·권한 검사와 독립 QA는 유지한다. 개발 PR의
application/migration PASS는 source/manifest 검사이며 Full DB는 NOT RUN이다.
새 입력에는 이전148/149 입력의 성공 근거를 재사용하지 않는다. 최종 실행안은
인계의 USER_DECISIONS.md에서 실제 통합 commit·입력 지문으로 고정한다.

운영에서는 최신 이력·정확 pending 전체 목록과 H1 기준 수용을 먼저 확정하고
실행 직전에 별도 승인받는다. 문제 발생 시 다음 적용을 중단하고 실패/UNKNOWN을
보존한다. 원장을 삭제하거나 sequence를 되돌리거나 broad GRANT로 우회하지 않는다.
완료된 거래의 보완도 원인을 확인한 별도 append와 승인이 필요하다.
