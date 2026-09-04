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

`config.json`에는 source-controlled allowlist와 일치하는 공개 project ref/Supabase URL 및
publishable key만 둔다. 승인 mapping은 `approved_targets.py`가 정본이며 일치하지 않는 hosted
대상은 비밀번호 전송 전에 거부한다. developer 비밀번호와 access/refresh token은
파일·레지스트리·로그에 저장하지 않는다.

운영 화면은 성공한 업무 변경을 보여주는 `감사 이벤트`와 로그인·권한거부·실제
민감접근을 보여주는 `활동/보안 로그`를 분리한다. 두 목록 모두 developer 전용 Edge
projection만 사용하며 private 원본 table이나 DB credential에 직접 연결하지 않는다.

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

#27 source는 시작 전 변경/해제/취소 요청/결정 감사 event 4종과 safe summary를 생성 모델에
추가한다. 상세 사유·request hash·원본 state는 포함하지 않으며, 콘솔에 admin 업무 변경
기능이나 developer의 업무 권한을 추가하지 않는다. 운영 미배포 source enum이 존재한다는
이유로 production API가 해당 기능을 제공한다고 판단하지 않는다.
