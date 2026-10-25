# #12 예약 자동 백업 실행 감시

## 범위

PR #484의 예약 전용 백업에 실패·미실행 감시를 추가하는 개발 후보다.
운영 DB/API/프런트 계약은 변경하지 않는다. 기존 recovery 프로젝트
`matalcofimnhuzslfhdd`에 별도 Edge 감시 함수를 배치하고, recovery Cron이 호출한다.
운영 암호화 백업 본문이나 DB 비밀번호·백업 복호화 키는 감시에 사용하지 않는다.

GitHub 예약 백업은 03:00 KST, 당일 성공본 확인 기한은 04:00 KST다.
recovery 감시는 매시 17분에 실행한다. 조회 실패·제한 초과·비활성·실패·취소·30분 초과
대기를 정상으로 표시하지 않는다. GitHub 자체의 60일 무활동 schedule 중지나 실행 누락도
감지한다. 별도 GitHub 실패 job은 recovery 장애로 원본 backup job이 실패한 경우 알린다.
두 서비스가 동시에 중단된 상황의 알림은 보장하지 않는다. Free 프로젝트 Pause 가능성은
존재하며 사용량/활성 상태를 운영 중 확인해야 한다.

## 정상 판정과 보안

- 고정 공개 저장소의 `reservation-backup.yml`, `main`, schedule/workflow_dispatch만 인정한다.
- 최신 run attempt의 `backup` job 및 실제 백업 검증 step의 성공을 함께 확인한다.
  이전 attempt 성공, skipped job, 변경 도중 attempt, 모호한 자정 경계는 성공 근거가 아니다.
- 비공개 bucket의 `.rms` 날짜·크기·생성/수정 시각을 대조한다. 성공 단계 이후 수정된
  객체는 검증된 사본으로 간주하지 않는다. 본문을 다운로드하거나 복호화하지 않는다.
- GitHub 조회는 공개 API로 인증 없이 수행한다. Storage 인증은 고정 recovery origin에만 보낸다.
  외부 redirect 금지, 응답 크기·개수 제한, 요청 7초/전체 45초 제한을 둔다.
- Edge 호출은 기본 legacy에서 전용 32-byte 난수의 SHA-256을 검사하며 프로젝트 주소도 recovery로 고정한다.
  호출 본문으로 시간·대상·키·수신자를 바꿀 수 없다. 비활성 상태가 기본값이다.
- 새 Cron 설치 source는 `signed-v1`을 사용해 Vault 키 자체를 pg_net 헤더에 보내지 않는다.
  Function Secret의 비공개 SHA-256 binary digest를 HMAC 키로 사용하므로 digest도 인증정보다.
  짧은 시간창 안에서 같은 고정 감시 요청 재생은 가능하며 단일 사용 토큰으로 취급하지 않는다.
  [호출 계약·전환 검증](SCHEDULED_INVOCATION_492.md)을 따른다. broad service-role이나 DB 비밀번호를 HTTP 호출 키로 쓰지 않는다.

## 알림

`<!-- rms-reservation-backup-monitor:v1 -->`로 식별되는 전용 열린 이슈 하나에 상태를 기록한다.
공개 내용은 오류 분류·날짜·검증된 GitHub 실행 링크뿐이다. 예약 수·고객 정보·원본 응답·
비밀번호·토큰·암호화 키는 넣지 않는다. 본문 사용자 메모는 보존하고 이슈를 자동 종료하지 않는다.
실패는 실행 ID·attempt, 미실행은 필요한 사본 날짜 기준으로 중복을 억제한다. 댓글 전송 뒤
응답 유실이나 본문 갱신 실패는 최근 댓글의 식별자로 복구한다. 복구 시 1회 기록한다.
분산 동시 실행에는 중복 알림이 가능하므로 정확히 한 번 전송을 보장한다고 주장하지 않는다.
댓글 전송 실패를 성공으로 기록하지 않는다. API 성공은 실제 사용자 알림 수신과 구분한다.

GitHub 실패 job은 짧게 유효한 GITHUB_TOKEN을 사용하고 백업 Secrets는 전달받지 않는다.
독립 감시는 전용 GitHub App의 설치 토큰을 사용하도록 준비한다. App 권한은 단일 저장소
Issues 쓰기와 기본 metadata 읽기로 제한한다. 기존 개인 CLI의 광범위 토큰은 복제하지 않는다.
App slug는 `rms-reservation-backup-wrongstory`로 고정한다. 댓글 복구는 이 App 봇과
`github-actions[bot]`의 기록만 인정한다. 다른 이름을 설치하면 이 허용 목록도 검토해야 한다.
자가 PAT로 작성한 댓글은 본인 알림 수신을 보장하지 않으므로 봇 계정의 실제 알림 수신까지
검증한다. App private key는 source/로그/채팅에 기록하지 않는다.

## 설치 및 활성화 순서 — 아직 실행하지 않음

1. source/합성·Edge 검사, 독립 QA, dev PR CI와 병합을 완료한다.
2. 전용 알림 이슈와 저장소 1개에 설치된 GitHub App을 준비하고 키를 안전하게 등록한다.
3. 최종 release 입력과 recovery 설치 SQL을 검토하고 DB 실행 승인을 별도로 받는다.
   자동 진행 승인은 DB 승인으로 대체하지 않는다. `ops/reservation-backup-monitor/install.sql`은
   recovery에만 적용하며 production migration 목록에 넣거나 운영 프로젝트에 실행하지 않는다.
   설치는 확장·비공개 `backup_ops` 함수·Vault 호출 키·비활성 Cron을 한 transaction에 만든다.
   기존 이름이 있으면 덮어쓰지 않고 중단한다. application 업무 table/RLS는 변경하지 않는다.
4. 별도 승인된 최종 release의 전체 DB 검증을 통과한 뒤 main에 반영한다.
   업무 API 재배포와 backup 활성화는 구분한다. 이 후보에는 운영 pending migration이 없다.
5. recovery에만 감시 함수를 배포하고 `RESERVATION_BACKUP_MONITOR_INVOKE_MODE=signed-v1`,
   Vault 호출 키의 비공개 hash, App ID/installation ID/private key,
   전용 issue 번호를 등록한다. 실제 비인가 거부·고정 recovery guard·알림 수신을 확인한다.
6. main backup workflow를 활성화하고 1회 실행의 저장·재조회 성공과 감시 HEALTHY를 확인한다.
   Cron은 마지막에 활성화한다. 첫 정기 백업·독립 감시 기록을 확인한 뒤 #12 완료를 판단한다.

장애 시 `RESERVATION_BACKUP_ENABLED=false`, `RESERVATION_BACKUP_MONITOR_ENABLED=false`와
해당 Cron만 비활성화한다. 이전 검증 사본·기존 job·업무 데이터·Auth는 삭제하지 않는다.

## 현재 검증 경계

2026-10-25 source 검증: `npm run ci:quality` PASS(132파일/3,266테스트, OpenAPI 154경로/
166작업), `npm run edge:check` PASS, migration manifest 122건 PASS. 마지막 알림 작성자 제한
보완 후 관련 78테스트·Deno check·감시 번들 89,594 bytes를 재검증했다.
독립 QA는 감시·알림·App 인증·workflow 관련 4파일/78테스트 PASS이며 차단 결함이 없다.
합성 검사는 실제 DB 검증이나 알림 수신을 대신하지 않는다. recovery SQL/실제 Cron/새 Edge 배포,
GitHub App 생성·실제 알림 수신, release 전체 DB 검증과 main 승격·정기 활성화는 NOT RUN이다.
PR #484의 실제 28건 백업·재조회 성공과 이 후보의 감시 활성화 성공을 혼동하지 않는다.

공식 근거: [GitHub schedule 제약](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[Supabase 예약 함수와 Vault](https://supabase.com/docs/guides/functions/schedule-functions),
[Free 프로젝트 Pause](https://supabase.com/docs/guides/platform/free-project-pausing).
