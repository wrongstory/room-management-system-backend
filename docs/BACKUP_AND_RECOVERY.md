# Supabase Free Plan 백업·복구 운영안

> 결정일: 2026-08-26
> 상태: 대상 계정 연결과 Free 프로젝트 2개 확인 완료, 운영·복구검증 migration 적용·재현 완료, 정기 dump 자동화는 구현 전
> 사진은 Google Drive에만 비공개 저장하고 `uploaded_at + 7 days`에 예외 없이 영구삭제하는 확정 정책이다. DB 백업은 사진 객체를 포함하지 않으며 파일 ID·해시·삭제 결과 메타데이터만 보존한다.

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
- DB 논리 백업에는 Google Drive의 실제 사진 파일이 들어가지 않는다. 사진 파일은 백업 대상이 아니라 단기 증빙으로 보고 업로드 후 7일에 영구삭제하며, 파일 ID·해시·삭제 결과만 DB에 남긴다.
- 데이터가 포함된 dump는 개인정보를 포함할 수 있으므로 Git에 커밋하지 않고 로그에도 출력하지 않는다.

recovery 프로젝트는 최신 상태를 실제로 복원해 보는 **warm recovery copy**다. 같은 계정·같은 공급자 안에 있으므로 이것만으로 계정 탈취, 공급자 장애, 잘못된 백업의 전파까지 막는 독립 백업은 아니다. 최소한 최근 성공 dump 7세트는 암호화해 별도 안전 저장소에 보관한다.

2026-08-26에 recovery 프로젝트에 Git의 기존 P0/P1 migration과 도메인 무결성 migration을 순서대로 적용했다. 구조 검사 16건과 rollback DML 검사 10건이 통과했으며 검증 fixture는 0건으로 복귀했다. 이는 schema 복구 경로 검증이며, 운영 데이터의 주기적 roles/schema/data dump 자동화와 실제 data restore 검증은 별도 후속 작업이다.

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
