# 백엔드 콘솔 읽기 전용 DB 진단 PoC (#172)

## 상태와 범위

이 문서는 `dev@2ce8953...`에서 시작한 #172 후보의 로컬 계약이다. 82번째 append-only
`backend_console_readonly_diagnostics` migration과 Python `readonly_db` 모듈을 검증한다.
production/recovery DB, Shared Pooler, secret, migration 적용, GUI 배포는 범위 밖이다.

## 이중 제한

### PostgreSQL 역할

`rms_diagnostic`은 password 없는 LOGIN 역할이다. 최초 배포만으로는 접속할 수 없다.

- `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`
- 기본 transaction READ ONLY
- statement 3초, lock 500ms, idle transaction 5초
- public schema USAGE와 아래 세 뷰 SELECT만 허용
- private/auth/storage/vault/cron/net 및 public 원본 table/function 권한 없음

허용 뷰:

1. `public.diagnostic_system_summary`
2. `public.diagnostic_room_state_summary`
3. `public.diagnostic_workflow_summary`

세 뷰는 집계값과 정해진 상태 문자열만 반환한다. room/profile/reservation/assignment UUID,
객실 번호, 고객명, 전화번호, PIN, token, secret, raw audit/request는 반환하지 않는다.

### Python query 정책

`validate_readonly_query()`는 PostgreSQL dialect AST를 만든 뒤 다음만 허용한다.

- 정확히 한 개의 `SELECT`
- 위 allowlist 뷰에서 파생된 `WITH ... SELECT`
- 옵션·`ANALYZE`가 없는 `EXPLAIN SELECT|WITH`
- `COUNT/SUM/MIN/MAX/AVG/COALESCE/NULLIF/GREATEST/LEAST`

다중 statement, DML/DDL/COPY/SELECT INTO/row lock, base table, protected schema, 미승인·volatile
함수는 DB 연결 전에 거부한다. 실행 adapter는 `SET TRANSACTION READ ONLY`를 다시 적용하고
200행, 256KiB를 넘으면 부분 결과를 반환하지 않는다. 취소는 현재 connection의 cancel protocol만
사용하고 SQL·결과·password·DSN을 로그에 남기지 않는다.

## 환경 표시와 자격증명

- `local`: 모듈 검증 가능. password는 연결 함수 인자로만 전달하고 객체 repr/config/file에 저장하지 않는다.
- `production`, `recovery`: `HOSTED_DIRECT_DB_NOT_APPROVED`로 비활성.
- source-controlled 파일에는 hosted DB host, pooler port/user, password를 추가하지 않는다.
- 향후 hosted 연결은 정확한 프로젝트/pooler allowlist, TLS, password 직접 입력, role provision/revoke와
  별도 승인·smoke가 필요하다.

## 로컬 검증

```powershell
npm run db:verify
npx supabase test db supabase/tests/backend_console_readonly_diagnostics.sql --local
cd tools/backend-console
uv sync --python 3.12 --frozen
uv run ruff check .
uv run ruff format --check .
uv run mypy src tests
uv run pytest
```

pgTAP은 121개 합성 객실의 집계 조회와 원본 rooms/reservations/profiles/auth 차단, DML/DDL 차단을
검증한다. Python 테스트는 허용·거부 AST, timeout 설정 순서, 행/byte 제한, 취소, 오류 redaction과
mock connection을 검증한다.

## 비활성화와 폐기

hosted 활성화 전 현재 상태에서는 password가 없으므로 별도 credential 폐기가 필요 없다.
향후 승인된 환경에서 password를 임시 provision했다면 사고·PC 분실·작업 종료 시 먼저 접속을
차단하고 active session을 종료한 뒤 password를 NULL로 되돌린다. 뷰나 역할을 즉시 DROP해 migration
history를 바꾸지 않는다. 후속 append-only migration으로 grants를 회수하고 연결 기능을 비활성화한다.

Phase C의 maintenance action은 이 SELECT 경계를 재사용해 임의 SQL로 구현하지 않는다. 각 action은
source-controlled command catalog, 별도 권한·확인·감사 계약을 가져야 한다.
