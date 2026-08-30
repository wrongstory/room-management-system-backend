# 백엔드 운영 콘솔 — Phase A

승인된 Windows 운영 PC에서 Supabase Edge API만 사용해 계정과 운영 상태를 관리하는
Python 3.12+ 데스크톱 도구다. Phase A에는 DB 연결, SQL 실행기, service-role key가 없다.

자세한 설치·운영·분실 대응 절차는 저장소의
`docs/BACKEND_CONSOLE_OPERATIONS.md`를 따른다.

## 개발 실행

```powershell
uv sync --python 3.12 --frozen
Copy-Item config.example.json config.json
uv run --python 3.12 room-management-console --config config.json
```

`config.json`에는 공개 가능한 project ref, Supabase URL, publishable key만 둔다. developer
비밀번호와 access/refresh token은 파일·레지스트리·로그에 저장하지 않는다.

## 검증

```powershell
uv run --python 3.12 ruff check .
uv run --python 3.12 ruff format --check .
uv run --python 3.12 mypy src tests
uv run --python 3.12 pytest
uv run --python 3.12 python scripts/build.py --check-only
```

## OpenAPI 생성 코드

저장소 루트의 OpenAPI 정본에서 Phase A 경로만 추출한 뒤 생성한다.

```powershell
uv run --python 3.12 python scripts/generate_client.py
```

생성 코드는 직접 수정하지 않는다. 인증 갱신·멱등성·redaction은 생성 코드 바깥의
`api_client.py`가 담당한다.
