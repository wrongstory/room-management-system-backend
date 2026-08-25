# Supabase Free Plan 백업·복구 운영안

> 결정일: 2026-08-26  
> 상태: 대상 Supabase 계정 재연결 전 설계 확정, 원격 프로젝트 미생성

## 목적

Supabase Free Plan의 활성 프로젝트 2개를 다음처럼 사용한다.

| 프로젝트 | 역할 | 앱 연결 |
|---|---|---|
| `room-management-system-prod` | 실제 운영 DB·Auth·사진 메타데이터 | 운영 API만 연결 |
| `room-management-system-recovery` | 최신 논리 백업 복원과 복구 검증 | 일반 사용자 트래픽 연결 금지 |

두 프로젝트는 `yeosucastletheart@gmail.com` 계정의 Free 조직에 만들고 가능하면 같은 서울 리전(`ap-northeast-2`)을 사용한다. 실제 조직의 프로젝트 수와 생성 비용이 `$0`인지 다시 확인한 뒤 생성한다.

## 무엇을 어디에 보관하는가

- 마이그레이션 SQL의 정본은 이 GitHub 저장소의 `supabase/migrations/`이다.
- 운영 데이터의 최신 복구 가능 사본은 recovery 프로젝트에 복원한다. dump 파일 자체를 recovery DB에 넣지는 않는다.
- `roles.sql`, `schema.sql`, `data.sql`은 생성 시각·원본 프로젝트 ref·CLI 버전·SHA-256과 함께 관리한다.
- DB 논리 백업에는 Google Drive의 실제 사진 파일이 들어가지 않는다. 사진 파일은 백업 대상이 아니라 단기 증빙으로 보고 업로드 후 7일에 영구삭제하며, 파일 ID·해시·삭제 결과만 DB에 남긴다.
- 데이터가 포함된 dump는 개인정보를 포함할 수 있으므로 Git에 커밋하지 않고 로그에도 출력하지 않는다.

recovery 프로젝트는 최신 상태를 실제로 복원해 보는 **warm recovery copy**다. 같은 계정·같은 공급자 안에 있으므로 이것만으로 계정 탈취, 공급자 장애, 잘못된 백업의 전파까지 막는 독립 백업은 아니다. 최소한 최근 성공 dump 7세트는 암호화해 별도 안전 저장소에 보관한다.

## 백업 주기

1. 매일 03:30 KST에 운영 DB에서 roles·schema·data를 각각 dump한다.
2. 각 파일의 SHA-256과 생성 시각을 검증하고 암호화한 최근 7세트를 별도 안전 저장소에 유지한다.
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

## Free Plan 주의사항

- Free 프로젝트 한도는 소유자·관리자로 속한 모든 조직을 합쳐 활성 2개다.
- Database 한도는 프로젝트당 500MB다. 이 시스템은 사진 파일에 Supabase Storage를 사용하지 않는다.
- Free 프로젝트는 활동이 부족하면 7일 후 일시 정지될 수 있다. 주기적 복원·검증이 실제 DB 활동을 만들도록 한다.
- Free에는 공식 일일 백업 보장, PITR, DB branching, SLA가 없다.
- 프로젝트를 삭제하면 그 프로젝트에 종속된 데이터와 백업은 영구 삭제된다.

## 생성 전 차단 조건

현재 Codex의 Supabase 연결은 `wrongstory` 조직이며 이미 활성 프로젝트 2개를 보유한다. 이 조직의 프로젝트는 건드리지 않는다. `yeosucastletheart@gmail.com` 계정으로 플러그인을 재인증한 뒤 다음을 순서대로 확인한다.

1. 연결 조직 이름과 Free 구독 상태
2. 현재 활성 프로젝트 수
3. 운영 프로젝트 존재 여부와 ref
4. 두 번째 프로젝트 생성 비용 `$0`
5. recovery 프로젝트 이름·리전

공식 근거:

- [Supabase Free Plan과 프로젝트 한도](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [CLI Backup and Restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Free Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
