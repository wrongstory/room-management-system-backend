# Supabase Free Plan 백업·복구 운영안

> 결정일: 2026-08-26
> 상태: 대상 계정 연결과 Free 프로젝트 2개 확인 완료, 운영·복구검증 migration 적용·재현 완료. 정기 dump 정책은 매일 01:00~06:00 KST, 15일 보관으로 확정했다. 로컬 합성 DB의 dump·격리 복원 dry-run은 source/dev 자동화가 준비됐으며 정확한 운영 실행 시각, 미래 PC 저장 경로, 원격 자동화는 남아 있다.
> 사진은 Google Drive에만 비공개 저장한다. 청소 제출은 최종 검사 결정+168시간, 사건 증빙은 해결·종결+180일, 진짜 orphan은 업로드+30일 뒤 삭제하는 retention v2가 정본이다. DB 백업은 사진 객체를 포함하지 않으며 파일 ID·해시·삭제 결과 메타데이터만 보존한다.

## 목적

Supabase Free Plan의 활성 프로젝트 2개를 다음처럼 사용한다.

| 프로젝트 | 역할 | 앱 연결 |
|---|---|---|
| `room-management-system-prod` (`aodikrxcczbogjpsjwjt`, 서울) | 실제 운영 DB·Auth·사진 메타데이터 | 운영 API만 연결 |
| `yeosucastletheart@gmail.com's Project` (`matalcofimnhuzslfhdd`, 뭄바이) | 최신 논리 백업 복원과 복구 검증 | 일반 사용자 트래픽 연결 금지 |

두 프로젝트는 `yeosucastletheart@gmail.com` 계정의 같은 Free 조직에 있고 현재 모두 `ACTIVE_HEALTHY`다. Free 활성 프로젝트 한도 2개를 모두 사용하므로 세 번째 프로젝트를 만들지 않는다. 복구검증 프로젝트의 리전이 운영과 다르다는 점은 복구 시간 측정과 연결 설정에 반영한다.

## 무엇을 어디에 보관하는가

- 마이그레이션 SQL의 정본은 이 GitHub 저장소의 `supabase/migrations/`이다.
- 운영 데이터의 최신 복구 가능 사본은 recovery 프로젝트에 복원한다. dump 파일 자체를 recovery DB에 넣지는 않는다.
- `roles.sql`, `schema.sql`, `data.sql`은 생성 시각·원본 프로젝트 ref·CLI 버전·SHA-256과 함께 관리한다.
- DB 논리 백업에는 Google Drive의 실제 사진 파일이 들어가지 않는다. 사진 파일은 백업 대상이 아니라 도메인별 retention v2에 따른 단기 증빙이며, 파일 ID·해시·정책·삭제 결과만 DB에 남긴다.
- 데이터가 포함된 dump는 개인정보를 포함할 수 있으므로 Git에 커밋하지 않고 로그에도 출력하지 않는다.

recovery 프로젝트는 최신 상태를 실제로 복원해 보는 **warm recovery copy**다. 같은 계정·같은 공급자 안에 있으므로 이것만으로 계정 탈취, 공급자 장애, 잘못된 백업의 전파까지 막는 독립 백업은 아니다. 최근 성공 dump는 15일 동안 암호화해 별도 안전 저장소에 보관한다. 최종 보관 위치는 추후 지정할 PC의 로컬 저장소이며 실제 절대 경로는 지정 전까지 문서나 스크립트에서 추측하지 않는다.

2026-08-26에 recovery 프로젝트에 Git의 기존 P0/P1 migration과 도메인 무결성 migration을 순서대로 적용했다. 구조 검사 16건과 rollback DML 검사 10건이 통과했으며 검증 fixture는 0건으로 복귀했다. 이는 schema 복구 경로 검증이며, 운영 데이터의 주기적 roles/schema/data dump 자동화와 실제 data restore 검증은 별도 후속 작업이다.

## 백업 주기

1. 매일 01:00~06:00 KST 사이에 운영 DB에서 roles·schema·data를 각각 dump한다. 정확한 실행 시각은 자동화 전에 확정하며 현재 권장값은 03:00 KST다.
2. 각 파일의 SHA-256과 생성 시각을 검증하고 암호화한 최근 15일분을 지정된 PC 로컬 저장소에 유지한다. 경로가 확정되기 전에는 임시 경로나 클라우드 동기화 폴더를 운영 정본으로 사용하지 않는다.
3. 두 프로젝트에 같은 Git 마이그레이션이 적용됐는지 확인한다.
4. recovery 프로젝트의 **앱 소유 스키마와 업무 데이터만** 초기화한 뒤 최신 dump를 복원한다. Supabase가 관리하는 `auth`, `storage`, `realtime` 스키마를 삭제하거나 재생성하지 않는다.
5. 복원 오류가 하나라도 나면 성공으로 기록하지 않고 직전 성공 recovery 사본을 유지한다.
6. 핵심 테이블 행 수, 활성 관리자 존재, 121개 객실, RLS 활성 상태를 검사한다.
7. 매주 일요일에는 recovery 전용 테스트 Auth 계정으로 로그인·RLS·주요 조회까지 점검한다.

백업 실패가 운영 DB를 변경해서는 안 되며, recovery 복원 실패도 직전 성공 여부와 실패 원인을 감사 로그에 남긴다.

## 공식 CLI 기준

Supabase 공식 가이드의 논리 백업 형식을 사용한다.

```bash
supabase db dump --db-url "$PROD_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$PROD_DB_URL" -f schema.sql
supabase db dump --db-url "$PROD_DB_URL" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
```

아래 전체 복원 명령은 새 프로젝트 또는 명시적으로 초기화한 복구 대상에 사용하는 공식 기준이다. 매일 운영하는 기존 recovery 프로젝트에는 이를 그대로 중복 실행하지 않고, 먼저 앱 소유 객체를 안전하게 초기화하는 recovery 전용 절차를 거친다.

```bash
psql \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$RECOVERY_DB_URL"
```

연결 문자열과 DB 비밀번호는 GitHub Actions secret 또는 배포 환경 secret으로만 주입한다. 파일명·로그·커밋에는 넣지 않는다.

## 로컬 합성 dry-run

Issue #171의 로컬 dry-run은 운영·recovery ref나 연결 문자열을 입력받지 않는다. `public`, `private`만 dump하고 같은 로컬 Supabase Postgres 컨테이너 안에 임의 이름의 일회용 DB를 만든 뒤 schema/data를 복원해 검사하고 삭제한다. `roles.sql`은 허용된 로컬 role timeout 설정만 검증하며 일회용 DB에 실행하지 않는다.

실행 전 로컬 DB는 반드시 fresh migration 상태여야 한다. 단일 명령으로 reset부터 수행하려면 다음을 사용한다.

```bash
npm run backup:dry-run:fresh
```

이미 `npm run db:verify`를 통과한 로컬 DB라면 다음만 실행할 수 있다.

```bash
npm run backup:dry-run
```

dry-run은 다음을 fail-closed한다.

- 객실 121개가 아니거나 profile, 예약, Auth 사용자, PIN revision, Web Push revision이 존재하는 비합성 source
- Git migration manifest의 count, stable head name, version과 로컬 DB history 불일치
- `auth`, `storage`, `realtime`, `vault`, `cron`, `net`, `supabase_migrations` 자체를 생성·변경하거나 data COPY 대상으로 삼는 dump
- hash·file size 불일치, 누락 artifact, public base table RLS 누락, critical RPC signature/grant 불일치, 복원 전후 table·row count 불일치
- manifest/log에 연결 문자열, key, token, private key, PIN·전화번호·고객명 필드가 들어가는 경우

산출물은 `.tmp/backup-recovery/` 아래에서만 만들 수 있다. 각 실행은 새로운 staging 디렉터리를 사용하고 전체 복원 검사가 끝난 뒤에만 immutable success 디렉터리와 `latest-success.json` 포인터를 원자적으로 게시한다. 실패 실행은 직전 성공 포인터를 덮지 않는다. 성공본은 15일 기준으로만 정리하며 failed evidence는 자동 삭제하지 않는다.

이 명령은 local synthetic 검증 전용이다. 운영 dump, recovery 초기화·복원, 지정 PC 보관, 스케줄 활성화 권한을 부여하지 않는다.

## Windows 운영 자동화 source 기반

Issue #273은 실제 운영 자격증명이나 원격 프로젝트를 건드리지 않고 Windows Task Scheduler에 전달할 안전한 plan을 먼저 고정한다. 운영 설정 파일에는 다음 비밀 없는 값만 둔다.

- production/recovery project ref
- 운영자가 지정한 로컬 고정 드라이브의 절대 백업 경로
- 01:00~06:00 KST 범위의 정확한 실행 시각
- 15일 retention
- Windows 보안 저장소의 credential **이름** 세 개

DB URL·비밀번호·암호화 키 자체는 설정 JSON, 명령행, Scheduled Task argument, Git, 로그에 넣지 않는다. plan은 다음 명령으로 사전 검증한다.

```powershell
npm run backup:operator:plan -- --config C:\RmsConfig\backup.json
```

`scripts/windows/Install-RmsBackupRecoveryTask.ps1`은 `-Enable`을 명시한 경우에만 작업을 등록하며, 등록 직후에도 기본 상태는 **Disabled**다. credential bridge와 원격 recovery executor가 별도 운영 gate에서 설치·검증되기 전에는 runner가 `BACKUP_OPERATOR_CREDENTIAL_BRIDGE_NOT_ACTIVATED`로 실패한다. 따라서 이 source 기반만으로 운영 백업이 실행 중이라고 표시해서는 안 된다.

정확한 PC 경로와 실행 시각이 정해진 뒤의 순서는 다음과 같다.

1. 비밀 없는 설정 plan 검증
2. Windows 보안 저장소 credential 이름/ACL 확인
3. 운영자가 승인한 credential bridge와 원격 dump/recovery executor 설치
4. Disabled task 등록 및 수동 1회 dry-run
5. artifact 암호화·SHA-256·recovery 복원·121실/RLS/RPC 검사
6. 직전 성공본 보존과 실패 복구 확인
7. 마지막으로 task 활성화

현재 PR 범위는 1과 Disabled task source까지만이며, 2~7은 실행하지 않는다.

## Free Plan 주의사항

- Free 프로젝트 한도는 소유자·관리자로 속한 모든 조직을 합쳐 활성 2개다.
- Database 한도는 프로젝트당 500MB다. 이 시스템은 사진 파일에 Supabase Storage를 사용하지 않는다.
- Free 프로젝트는 활동이 부족하면 7일 후 일시 정지될 수 있다. 주기적 복원·검증이 실제 DB 활동을 만들도록 한다.
- Free에는 공식 일일 백업 보장, PITR, DB branching, SLA가 없다.
- 프로젝트를 삭제하면 그 프로젝트에 종속된 데이터와 백업은 영구 삭제된다.

## 자동화 전 확인 조건

계정 연결과 프로젝트 생성은 완료됐다. 백업 자동화를 실행하기 전에는 다음을 매번 확인한다.

1. 프로젝트 ref가 운영 `aodikrxcczbogjpsjwjt`, 복구검증 `matalcofimnhuzslfhdd`와 정확히 일치하는지
2. 두 프로젝트가 모두 `ACTIVE_HEALTHY`이고 같은 Git migration 집합을 갖는지
3. 복구검증 프로젝트에 일반 사용자 트래픽과 운영 API가 연결되지 않았는지
4. dump·복원 연결 문자열과 DB 비밀번호가 전용 secret으로만 주입되는지
5. 복원 실패 시 직전 성공 recovery 사본을 보존하는 절차가 준비됐는지

공식 근거:

- [Supabase Free Plan과 프로젝트 한도](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [CLI Backup and Restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Free Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
