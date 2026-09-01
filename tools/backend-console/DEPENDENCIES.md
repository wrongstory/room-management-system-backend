# 직접 의존성·라이선스 기준

Phase A의 직접 의존성은 `pyproject.toml`에 exact version으로 고정하고 전체 전이 의존성은
`uv.lock`의 package/version/source/hash를 정본으로 사용한다.

| 패키지 | 고정 버전 | 용도 | 라이선스 기준 |
|---|---:|---|---|
| PySide6 | 6.10.3 | Windows GUI | LGPLv3 / Qt commercial 이중 라이선스 |
| httpx | 0.28.1 | HTTPS Edge/Auth client | BSD-3-Clause |
| attrs | 26.1.0 | OpenAPI 생성 모델 runtime | MIT |
| openapi-python-client | 0.29.0 | OpenAPI client 생성 | MIT |
| PyInstaller | 6.22.2 | Windows x64 artifact | GPLv2-or-later + 배포 예외 |
| pytest / pytest-qt | 9.1.1 / 4.5.0 | 테스트 | MIT |
| Ruff | 0.16.5 | lint/format | MIT |
| mypy | 2.3.1 | 정적 타입 검사 | MIT |

PySide6 배포 시 LGPL 고지와 재링크 가능성 등 실제 배포 의무는 release 검토에서 다시
확인한다. 초기 artifact는 자동 업데이트나 서명을 제공하지 않는 수동 배포 PoC다.
