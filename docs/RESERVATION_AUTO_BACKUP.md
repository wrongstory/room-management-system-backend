# 예약 자료 자동 백업 (#12 / #273)

## 현재 상태

2026-10-24 사용자 결정에 따른 **source 후보**다. 전체 DB 복제 대신 예약 자료를
추출하고 암호화해 기존 recovery Supabase에 보관한다. 운영 DB에 쓰지 않는다.
현재 Secrets·bucket 생성·정책 변경·스케줄 활성화·실제 백업은 하지 않았다.
새 migration은 없으며 실제 예약 자료 추출/Storage 검증은 NOT RUN이다.
운영의 information_schema 컬럼 조회와 후보 SELECT의 EXPLAIN(ANALYZE 없음)은
READ ONLY/ROLLBACK으로 통과했다. 업무 행·고객명·PIN을 조회하거나 출력하지 않았다.

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

## 별도 활성화 gate (현재 미완료)

1. PR/CI/독립 QA 통과 후 사용자 승인으로 저장소/설정 준비.
2. recovery bucket과 policy를 확인하고 anon 및 실제 authenticated 역할의 목록/조회/생성/덮어쓰기/삭제
   거부를 검증. 앱에 recovery key/backup key를 노출하지 않는다. 실제 권한 검증 전 변수는 false 유지.
3. GitHub `reservation-backup` environment에 DB URL, 독립 32-byte base64 backup key,
   recovery Storage token을 안전하게 등록. production PII키는 runner에 주입하지 않는다.
   검증된 Supabase CA PEM은 환경 variable로 등록. 비밀번호/키를 채팅에 보내지 않는다.
4. 실제 source 고정 SELECT의 호환성·TLS·timeout, 암호화 사본의 원격 재조회/구조/예약 수 검증.
   실패·중복·용량 거부 시 이전 성공본 보호를 확인. 전체 DB reset은 불필요하다.
5. GitHub 실패 알림 수신자를 설정하고 실패 run의 실제 수신 확인.
   job 실패/summary는 구현됐지만 이메일 등 외부 알림 도착은 아직 검증하지 않았다.
6. 승인 후 활성화 변수를 켜고 첫 예약 실행 확인. 성공/실패 이력과 용량을 운영 점검한다.

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
  실제 예약 자료 추출/원격 저장은 실행하지 않았다.
- 첫 전체 application 검사에서 workflow action 개수 기대값 1건 실패.
  신규 workflow를 포함하도록 기대 개수와 활성화 경계 회귀를 보완했다.
- 전체 검증/CI 최종 결과는 연결 PR의 exact-head 증거를 따른다.
- 2026-10-24 로컬 `ci:quality` PASS: 비밀 검사, OpenAPI 계약, lint,
  typecheck, 128개 파일의 3,154개 테스트, build 완료. lint 경고 37건/정보 60건은 남아 있다.
  migration manifest 122개 PASS이며 Full DB NOT RUN이다.
