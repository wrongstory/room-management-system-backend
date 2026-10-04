# Supabase 2개 프로젝트 백업 — B안, #273 / #12

## 최신 사용자 결정

2026-10-04 사용자는 로컬 백업 보관을 제외하고, 이미 만든 두 Free 프로젝트를 활용하는
**B안**을 확정했다. 운영은 `aodikrxcczbogjpsjwjt`, 복구 전용은 `matalcofimnhuzslfhdd`다.
로컬 백업 폴더·분리 DPAPI 백업키·외부 PowerShell 저장소 검사를 이번 백업의 선행 gate에서
제외한다. Pro/PITR 결제, 새 프로젝트, Windows Task 설치, 운영 DB/Auth/PIN 변경은 없다.
이 결정은 백업 보관 대상의 변경이며 기존 credential의 보안 검증을 면제하지 않는다.

같은 날 사용자는 **기존 recovery Auth·테스트 로그인 정보를 운영 Auth snapshot으로 교체**하도록
승인했다. UUID와 업무 FK 연결을 유지하며 운영 Auth·비밀번호·객실 PIN은 변경하지 않는다.
과거 recovery 테스트 계정 보존 결정은 이 승인으로 대체됐다. managed schema 삭제·재생성이나
새 프로젝트·보관 구조 생성 승인은 아니다.

이후 사용자는 **복구 DB 비밀번호의 보안 입력**과 **실제 복원·검증 후 복구 프로젝트만
15일 Pause하여 보존**하는 방식을 승인했다. 비밀번호·연결 문자열을 채팅·명령행·로그에
받지 않으며, 입력 동의는 credential 준비나 연결 검증 PASS가 아니다. 운영 프로젝트는
계속 가동하고 Pause하지 않는다. 이번 승인으로 상시 활성 사본의 별도 세션 보존 구조를
채택하지 않으며, 복원 전 Data API/Auth/worker 격리 검증은 그대로 유지한다.

기존 `backup:plan`은 과거 로컬 계획 형식의 비활성 도구다. B안 실행 명령이 아니며
`executionAllowed=false`를 유지한다. 기존 Windows 기반 source/WIP·검증 실패 이력은 보존한다.
로컬 합성 DB 테스트도 운영 백업의 보관 위치와 별개이며 실제 원격 백업을 대신하지 않는다.

## 실제 읽기 전용 사전 확인 — 2026-10-04 21:36 KST

Supabase connector의 `BEGIN ... READ ONLY` / 집계 SELECT / ROLLBACK으로 확인했다.
Auth 원문·hash/token, 객실 PIN·업무 행 데이터는 조회하거나 출력하지 않았다.

| 항목 | 운영 | 복구 |
|---|---|---|
| 상태 | ACTIVE_HEALTHY | ACTIVE_HEALTHY |
| 조직 요금제 | Free | 같은 Free 조직 |
| hosted migration 수 | 85 | 73 |
| history head name | `flat_cleaning_evidence_history_payroll` | `generated_room_pin_confirmation` |
| 객실 수 | 121 | 121 |
| public base table RLS 누락 | 0 | 0 |

복구 프로젝트에는 기존 Auth/업무 계정이 존재한다. 추가 읽기 전용 identity fingerprint 대조에서
양쪽 Auth UUID 집합과 profile UUID 집합은 같고 profile→Auth orphan은 0이다. 원문 UUID나
비밀번호 hash·세션/token은 출력하지 않았다. 동일 UUID는 전체 Auth 데이터 동일성의 증거가 아니다.
복구의 authenticated role에는 업무 table SELECT/SECURITY DEFINER 실행 grant가 있으므로
Auth를 복제하기 전에 Data API/Auth/worker 격리를 실제로 검증해야 한다.
개수 일치나 schema 적용 이력만으로
운영 데이터·Auth·receipt·PIN ciphertext의 동일성이나 실제 복원 성공을 선언하지 않는다.
hosted history 전체 version/name/`statements::text` SHA-256을 별도로 대조했다. 공통73건의
name/content SHA-256은 모두 같고 recovery-only name은 없다. 단, `cleaning_template_duration_optional`의
version은 운영 `20260915222552`, recovery `20260915222453`으로 다르다. 운영에만 있는12건과
이 version 차이를 명시적으로 처리해야 하며, 최신 dev101건을 배포 전 운영85건의 사본에 섞지 않는다.
이 history 대조는 실제 DB schema/함수/ACL/data 전체 동일성의 증거가 아니다.

recovery의 Edge Function0, `pg_cron`/`pg_net`/HTTP 확장 없음, 앱 Realtime publication table0을
확인했다. Data API·Auth 로그인/refresh 접근 차단은 아직 검증하지 않았다. 브라우저 연결은
초기 접근과 reset 후 재시도 모두 경로 오류로 중단했으며 UI 우회 접근을 하지 않았다.
설치된 CLI v2.115.0의 기존 인증으로 linked Management API 읽기 전용 집계 조회는 PASS다.
복구 DB 비밀번호 재입력 없이 확인한 연결 경로일 뿐 민감 데이터 전송·원자 복원 PASS가 아니다.

추가 READ ONLY catalog 대조에서 양쪽 Auth base table27개의 column/type/default/identity 및
constraint 정의 SHA-256은 모두 같았다. 이는 해당 구조의 호환성 점검이며 Auth 데이터/세션/
index/trigger/권한/서비스 설정 전체 동일성을 뜻하지 않는다.

Management API의 SQL 실행에 민감 데이터를 literal로 포함한 restore는 사용하지 않는다.
공식 postgres-meta 소스에는 SQL span과 오류의 SQL line/DETAIL 기록 경로가 있으며 hosted
배포본의 차단 여부를 증명하지 못했다. CLI 자체 로그를 숨기는 것만으로 서버 로그를 막을 수 없다.
기존 인증의 metadata query PASS를 민감 dump 전송 승인으로 확대하지 않는다.

## 이번 배포 전 1회 실행 계획과 경계

1. 운영은 읽기 전용 source로 고정하고 복구 대상 ref/일반 트래픽·worker 격리를 확인한다.
2. 실제 Auth와 연결된 업무 UUID/FK, 불변 원장·receipt·PIN 암호문/nonce/AAD/key version,
   roles/ACL/RLS/함수/앱 소유 Auth trigger, hosted history를 같은 일관된 snapshot으로 확보한다.
   CLI 기본 dump에 managed-schema customization/history가 자동 포함된다고 가정하지 않는다.
3. 승인된 범위에서 recovery의 기존 Auth·테스트 로그인 정보를 운영 사본으로 교체한다.
   먼저 실제 Auth column/type/constraint 호환성과 로그인·refresh·worker 격리를 검증한다.
   managed schema는 삭제·재생성하지 않으며 운영 계정/비밀번호/PIN은 변경하지 않는다.
4. 유한 timeout/lock, 비밀을 출력하지 않는 전송, 실패 시 직전 복구본 보존, 복원 전후
   동일성/FK 검사와 성공 게시를 검증한 후 복구 프로젝트에 사본을 만든다.
   `session_replication_role=replica`와 row count만으로 무결성을 판정하지 않는다.
5. 실제 복원·동일성/FK 검증이 모두 통과한 뒤 승인된 recovery 프로젝트만 Pause하고,
   대상 ref와 실제 정지 상태를 확인한 시각부터 최소 15일 보존한다. 운영 프로젝트는 계속 가동한다.
   검증 실패나 Pause 실패를 성공으로 게시하지 않으며 원격 보존과 이전 성공본 보호의
   구현·검증 전에는 완료로 표시하지 않는다. 보존 기간에는 자동 Resume·재복원·덮어쓰기를
   실행하지 않는다. 복구에 필요한 Resume은 별도 복구 절차로 처리한다.
   이 1회 고정 사본은 장기 매일 15일 이력이 아니다.

운영 배포에는 **최신 릴리스 CI/독립 QA + 실제 원격 백업/복원 PASS + #378 유한 원자
SQL/history 실행기**가 계속 필요하다. B안 확정만으로 병합·운영 migration·API 배포를 실행하지 않는다.

## 승인된 보존 방식과 남은 실행 경계

- 실제 복원·검증 후 recovery만 최소15일 Pause하는 방식은 사용자 승인 완료, 실제 실행은
  NOT RUN이다. 활성 Auth worker의 세션 정리/갱신을 로그인 provider 비활성만으로 막았다고
  가정하지 않으며, 승인된 Pause도 복원 전 격리 검증을 대체하지 않는다.
- 이번 1회 사본 보존과 장기 매일 15일 이력은 다르다. 장기 이력 저장 구조·자동 갱신은 #12에서
  별도 구현/승인한다. private Storage bucket/새 worker/secret 저장소를 임의 생성하지 않는다.
- cloud-only는 백업 사본을 로컬 파일로 보관하지 않는다는 뜻이다. 실제 전송 runtime과
  credential 주입 방식은 별도 안전 실행 gate이며 MCP SQL 결과를 민감 dump의 운반 경로로 쓰지 않는다.

## 실제 상태

| 검증 | 결과 |
|---|---|
| 프로젝트/요금제·DB 읽기 전용 집계·identity 집합 대조 | PASS |
| hosted history 공통73건 name/content SHA-256 대조 | PASS: version 차이1건·운영에만12건 |
| recovery 외부 실행 경로 metadata 점검 | PASS: Edge/Cron/net/앱 Realtime 없음; Data API/Auth 격리는 NOT RUN |
| CLI 기존 인증의 linked 읽기 전용 집계 조회 | PASS |
| Auth27개 base table column/constraint 정의 hash 대조 | PASS: 데이터/trigger/권한/서비스 설정 검증과 별개 |
| recovery DB credential 보안 입력 | 사용자 동의 완료; 실제 준비·연결 검증은 별도 gate |
| 운영과 recovery 전체 schema/함수/ACL/data parity | NOT RUN |
| 실제 운영 snapshot 전송·Auth 포함 원격 복원·동일성/FK 검사 | NOT RUN |
| 원격 성공본 게시·recovery Pause·최소15일 보존 | 사용자 승인 완료; 실제 실행 NOT RUN |
| 운영 migration/API 배포 | NOT RUN |

최신 source 검증(2026-10-04): `npm run ci:quality` PASS(secret scan860, OpenAPI137paths/148operations,
lint의 기존 INFO5, typecheck, 전체1591/71, build), migration manifest5종 PASS, `git diff --check` PASS.
합성 process-boundary targeted44/44, 독립 QA의 별도 VM39 assertions·고정 child 환경 격리 검사 PASS,
P0/P1/P2 발견0건이다. 실제 OS 검사는 기존 기본 유한 기한을 사용하고 짧은100/150ms 경계는
가상 시계로 정확히 검사한다. 초기 전체1584 PASS/3 FAIL의 Windows 시작 시간 경합은 실패 이력으로
보존하며 skip·검사 기준 완화로 해결하지 않았다. 이 결과는 실제 원격 백업·Auth 교체 PASS가 아니다.

이 문서 변경 전 source `ee5fa8f`의 required CI `37204012020`은 application/migration 모두
PASS로 확인됐다. 해당 source CI는 이번 문서 변경의 exact-head CI나 실제 원격 복원/Pause
검증을 대신하지 않는다.

같은 계정·같은 공급자 안의 사본은 독립 재해 백업이 아니다. Free에는 공식 자동 백업/PITR가 없다.
Google Drive 사진 bytes·운영 암호키·provider credential은 DB 사본에 자동 포함하지 않는다.
PIN/PII 키는 ciphertext와 분리하며 recovery에 운영 키·provider/Cron을 자동 주입하지 않는다.

공식 근거:

- [Supabase 백업 및 Free 제한](https://supabase.com/docs/guides/platform/backups)
- [CLI 복원, migration history와 Auth customization 별도 보존](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Data API 비활성화와 권한/RLS 보존](https://supabase.com/docs/guides/api/securing-your-api)
- [Free 프로젝트 Pause/Resume](https://supabase.com/docs/guides/platform/free-project-pausing)
- [postgres-meta SQL span·오류 처리 경계(검토 commit)](https://github.com/supabase/postgres-meta/blob/f380cc5/src/lib/db.ts)

[전체 운영안](./BACKUP_AND_RECOVERY.md), [과거 비활성 로컬 기반](./ONE_TIME_BACKUP_PREPARATION.md)을 함께 확인한다.
