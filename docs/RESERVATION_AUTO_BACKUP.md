# 예약 자료 자동 백업 (#12 / #273)

## 현재 상태

2026-10-24 사용자 결정에 따른 예약 자료 전용 백업이며 PR #484의 source 후보다.
2026-10-25에 실제 예약 **28건**과 연결 이력을 읽기 전용으로 추출하고 암호화해
기존 recovery Supabase에 저장했다. `2026-10-25.rms`는 **65,927 bytes**다.
원격 재조회 byte 대조·복호화·예약 조회 모델의 참조/구간 검증이 통과했고,
같은 날 재실행도 `verified-existing`으로 기존 사본을 덮어쓰지 않고 검증했다.
전체 DB/복구 DB 테이블 복원이나 정기 자동 실행 완료를 뜻하지 않는다.

recovery 프로젝트는 ACTIVE_HEALTHY이며 `reservation-backups`는 비공개다.
GitHub `reservation-backup` environment에 필요한 세 Secrets를 등록하고
main branch만 허용·관리자 우회 금지를 설정했다. TLS CA도 등록했으나
repository variable `RESERVATION_BACKUP_ENABLED=false`로 정기 실행은 꺼져 있다.
source 병합·main 반영·알림 수신·첫 정기 실행은 별도 gate다.

사용자가 앞서 입력한 비밀번호는 recovery 프로젝트의 값으로 확인됐다.
별도 명시 승인 후 **운영 DB 비밀번호만 1회 재설정**하고 현재 Windows 계정으로
암호화 보관했다. 새 값으로 IPv6 direct 및 session pooler의 TLS/읽기 전용 인증을
검증하고 백업 전용 GitHub Secret을 등록했다. recovery DB 비밀번호는 이 실행기에
사용하지 않는다. API 배포·운영 업무 데이터 쓰기·migration·Auth/PIN 키 변경은 없다.
예약 원문·비밀번호·키를 로그/Git/평문 파일에 기록하지 않았다.

## 백업 내용

| 자료 | 저장 범위 |
|---|---|
| 객실 | UUID↔호실 매핑 |
| 예약 | 일정·유형·인원·상태·입퇴실/취소 시각·version·행위자 UUID·고객명 암호문 |
| 일정 변경 | 불변 revision과 변경 이유/시각/행위자 |
| 투숙/객실 구간 | 현재·과거 구간, 종료 미정 장기투숙, retired 이력 |
| 객실 이동/점유 | 이동, 점유 event의 typed 정보, 관리자 정정 |

Auth·PIN·사진·청소·주급·임의 before/after JSON·command receipt는 포함하지 않는다.
작성자 UUID는 provenance이며 계정/휴대폰/로그인 정보를 복제하지 않는다.
예약의 청소 의무 FK와 재시도 command key는 운영 재삽입용으로 보존하지 않는다.
이 archive는 예약 자료 조회/검증 모델이지 public.reservations에 바로 넣는 SQL dump가 아니다.

`REPEATABLE READ READ ONLY` transaction에서 고정 SQL·명시된 컬럼만 읽는다.
버전 bigint는 문자열로 보존한다. strict 필드/형식/중복/참조/예약 lineage/구간 중첩을
검증하며 PostgreSQL의 마이크로초·반개구간·길이 0 구간을 유지한다.
active 예약은 stay, 모든 예약은 schedule, 존재하는 stay는 segment 이력을 요구한다.
과거 stay 원장 도입 전 취소·완료 예약은 stay가 없을 수 있다.

고객명은 기존 PII envelope 그대로 별도 AES-256-GCM 백업 안에 들어간다.
백업키와 원래 PII keyVersion의 키는 별도로 보관해야 한다. 백업키만으로 고객명을
복호화할 수 없다. 조회 복구와 새 백업에서는 checkout/cancel+180일 지난 고객명 암호문을
제거한다. 과거 암호화 archive는 백업 보관기간 동안 남지만 운영 개인정보로 되살리지 않는다.

## 실행과 보관

- `npm run backup:reservations`: 활성화 변수 없으면 외부 호출 전에 실패한다.
- `.github/workflows/reservation-backup.yml`: main 전용, 매일 03:00 KST와 수동 실행,
  별도 environment와 `RESERVATION_BACKUP_ENABLED=true`가 있어야 실행한다.
  GitHub schedule은 지연될 수 있으므로 정확한 정각 실행 SLA는 없다.
- 같은 workflow의 겹친 실행은 취소하지 않고 직렬화한다. 날짜별 immutable create를 사용하며
  이미 있는 같은 날짜의 사본은 인증·구조 검증 후 재사용한다. 업로드 응답 유실은 다음 재실행에서
  원격 사본을 검증한다. 같은 날짜에 새 snapshot으로 덮지 않는다.
- 기존 `matalcofimnhuzslfhdd`의 전용 `reservation-backups` **비공개 bucket**만 사용한다.
  public=false 검사는 RLS 접근 격리 증명이 아니다. 활성화 전에 별도 정책/실제 접근 검사가 필요하다.
- 평문 backup 파일, Git 커밋, Actions artifact, 원문 SQL/provider 오류 출력을 만들지 않는다.
  stdout은 날짜·성공 유형·예약 수·정리 수만 표시한다. JS 문자열의 즉시 메모리 소거는 보장하지 않는다.
- 인증 암호화 후 업로드→다운로드 byte 대조→복호화·연결 무결성·읽기 복구 검증이 성공해야
  이전 만료 사본을 정리한다. 실패/용량 부족이면 이전 성공본을 지우지 않는다.
- 최소 15일 보관을 위해 날짜 경계 여유를 두어 KST 파일 날짜+16일 이후 정리한다.
  과거 사본도 인증 및 파일 날짜 일치를 확인한 뒤 삭제한다. 마지막 새 성공본은 삭제하지 않는다.
- 최대 32MiB JSON, 각 자료 100,000행, bucket 예산 800MiB, 목록 1,000개 미만.
  초과는 실패한다. 전체 조직의 다른 Storage 사용량까지 이 예산이 보장하지 않는다.
  실패 사본/키 교체로 확인할 수 없는 사본은 자동 삭제하지 않는다.
- source는 고정 project의 direct/session endpoint·5432·verify-full TLS만 허용한다.
  DB 비밀번호는 child 환경변수에만 전달하고 argv에는 넣지 않는다. 현 구현의 postgres credential은
  쓰기 권한도 갖지만 고정 실행 SQL은 READ ONLY다. statement60s/lock5s/connect10s/child90s,
  HTTP60s와 전체 job15분 상한을 둔다. 오류는 민감 내용 없이 실패 처리한다.

공식 근거: [Free 파일 한도](https://supabase.com/docs/guides/storage/uploads/file-limits),
[Storage RLS](https://supabase.com/docs/guides/storage/security/access-control),
[Actions 백업](https://supabase.com/docs/guides/deployment/ci/backups).
실제 프로젝트 용량과 egress 잔량은 활성화 시 확인해야 한다.

## 활성화 gate

1. source CI/독립 QA와 사용자 승인에 따른 저장소/설정 준비는 완료했다.
   PR #484는 실제 결과·최신 CI·리뷰를 확인한 뒤 dev/main 승격한다.
2. recovery bucket과 policy를 확인하고 anon 및 실제 로그인한 authenticated 사용자 각각의
   목록/조회/생성/덮어쓰기/삭제 거부 10종을 검증했다. 임시 합성 계정과 probe 파일은 정리하고
   부재를 확인했다. 기존 계정·실제 백업은 변경하지 않았으며 앱에 recovery key/backup key를 노출하지 않는다.
3. GitHub `reservation-backup` environment에 DB URL, 독립 32-byte base64 backup key,
   recovery Storage token을 등록했다. 키는 저장소와 분리해 Windows 계정으로 보호해 보관한다.
   production PII키는 runner에 주입하지 않는다. 검증된 Supabase CA PEM은 repository
   variable에 등록했다. 비밀번호/키를 채팅에 보내지 않는다. main-only 환경 보호를 유지한다.
4. 실제 source 고정 SELECT·TLS·암호화 사본 재조회/구조/예약 수 및 같은 날 재실행 PASS.
   실패·중복·용량 거부 시 이전 성공본 보호를 확인. 전체 DB reset은 불필요하다.
5. GitHub 실패 알림 수신자를 설정하고 실패 run의 실제 수신 확인.
   job 실패/summary는 구현됐지만 이메일 등 외부 알림 도착은 아직 검증하지 않았다.
6. main 반영과 위 검증 후 활성화 변수를 켜고 첫 예약 실행을 확인한다.
   성공/실패 이력과 용량을 점검하고, 최근 성공 사본 날짜로 미실행도 감지해야 한다.
   GitHub PUBLIC repository는 60일 활동이 없으면 schedule이 비활성화될 수 있고
   부하로 예약 run이 지연/누락될 수 있다([공식 schedule 제약](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
   현재 `failure()` 요약만으로 미실행은 탐지하지 못한다.
   이 감시·실제 알림 수신 확인이 끝나기 전 #12/#273의 자동 백업 완료를 선언하지 않는다.

## 복구 범위와 한계

`decryptBackup` → `restoreReadModel`은 메모리 안에서 검증된 예약 조회 모델을 재구성한다.
원래 예약 UUID·객실 구간·변경 이력을 보존하며 만료 PII를 제거한다.
**실제 recovery DB 테이블 복원이나 운영 DB 자동 반입은 구현하지 않았다.**
운영 반입은 기존 예약 충돌·객실 매핑·새 행위자·청소 side effect 처리 정책과 별도 검증/승인이 필요하다.
전체 업무 DB 복구, Auth 복구, 사진 복구가 된 것으로 해석하지 않는다.

## 검증 기록

- 독립 QA가 달력 오류, microsecond 손실, 연결 자료 누락, 이차 반복 조회,
  무작위 암호문 substring 테스트 오탐을 지적했고 보완했다.
- 예약/프로세스/Workflow 관련 23건 PASS, 독립 에이전트 예약 회귀 16건 PASS.
  child timeout·SQL 오류/과다 stderr 비노출·argv 비밀번호 제외를 추가 검사했다.
  이 source 검토 당시에는 실제 예약 자료 추출/원격 저장을 실행하지 않았다.
- 첫 전체 application 검사에서 workflow action 개수 기대값 1건 실패.
  신규 workflow를 포함하도록 기대 개수와 활성화 경계 회귀를 보완했다.
- 전체 검증/CI 최종 결과는 연결 PR의 exact-head 증거를 따른다.
- 2026-10-24 로컬 `ci:quality` PASS: 비밀 검사, OpenAPI 계약, lint,
  typecheck, 128개 파일의 3,154개 테스트, build 완료. lint 경고 37건/정보 60건은 남아 있다.
  migration manifest 122개 PASS이며 Full DB NOT RUN이다.
- 2026-10-25 사용자 승인 운영 비밀번호 재설정·암호화 보관 후 IPv6 direct와 session pooler
  인증 PASS. session의 클라이언트 TLS는 psql 연결 정보로 확인했다. pooler→DB 내부 연결의
  `pg_stat_ssl`을 클라이언트 TLS 판정으로 혼동하지 않는다. 임시 IPv6 진단 함수는 삭제했다.
- 실제 운영 예약 28건의 신규 암호화 저장/재조회/읽기 모델 검증 PASS,
  같은 날짜 재실행 `verified-existing` PASS. 삭제한 만료 사본은 0건이며 실제 만료 사본
  cleanup/용량 초과 시나리오는 합성 테스트 근거와 구분한다. 업무 DB 쓰기·migration 없음.
- 보안 설정과 일회용 실행 helper 독립 QA 완료. 결과 판정의 PowerShell 논리 연산 우선순위
  문제를 보완했고 정상/실패 합성 10건 PASS, 실제 백업도 PASS다.
- 실제 anon·로그인 사용자 Storage 접근 거부 10종 PASS. service 접근과 무해 probe 내용
  보존을 대조했으며, 임시 파일/합성 Auth 사용자 삭제·부재 확인 PASS다.
- 최신 dev `b13d3d8`의 #485 운영 검증 복원을 정상 통합했다. 통합 `ci:quality` PASS:
  typecheck·129개 파일 3,187개 테스트·build 및 비밀/OpenAPI/lint 검사 완료.
  전체 DB 재구축·migration 적용은 하지 않았다. 최신 source CI는 PR에서 별도로 확인한다.
- 이후 dev `bc0e11e`의 #487 보안 패치를 추가 통합했다. 백업 실행 명령과 새 의존성을
  함께 보존하고 충돌한 bundle manifest를 generator로 재생성·대조했다(834,853 bytes).
  통합 `ci:quality` 129개 파일 3,191개 테스트 및 manifest 검사 PASS.
  기존 작업공간의 미커밋 mirror 19개는 별도 작업공간에 그대로 보존했다.
