# Python 백엔드 운영 콘솔 Phase A 운영 가이드

## 목적과 보안 경계

`tools/backend-console`은 승인된 Windows PC에서 실행하는 API-only GUI다. developer가
운영 Supabase Edge API에 로그인해 business admin/maid 계정과 안전한 운영 projection을
관리한다.

Phase A에는 다음이 **없다**.

- DB connection string, Shared Pooler, `psycopg`
- service-role/secret key
- SQL editor 또는 migration 실행
- Vault/Cron/secret 변경
- 별도 서버나 유료 상시 process

DB 직접 진단과 maintenance action catalog는 #44 Phase B/C의 별도 보안 검토 전까지
비활성이다.

## 설치

### 개발 실행

1. Python 3.12와 `uv`를 준비한다.
2. `tools/backend-console`에서 `uv sync --python 3.12 --frozen`을 실행한다.
3. `config.example.json`을 `config.json`으로 복사한다.
4. 아래 승인 mapping의 환경·공개 project ref·Supabase URL과 publishable key를 입력한다.
5. `uv run --python 3.12 room-management-console --config config.json`을 실행한다.

| 환경 | 승인 project ref | 승인 URL |
|---|---|---|
| production | `aodikrxcczbogjpsjwjt` | `https://aodikrxcczbogjpsjwjt.supabase.co` |
| recovery | `matalcofimnhuzslfhdd` | `https://matalcofimnhuzslfhdd.supabase.co` |
| local | `local` | `http://127.0.0.1:<port>` 또는 `http://localhost:<port>` |

hosted 대상은 `approved_targets.py`의 environment/project ref/URL과 정확히 일치해야 한다.
서로 일치하는 임의 project ref와 URL도 허용하지 않는다. 로그인 성공 뒤에는 developer
runtime-status의 environment/project ref를 다시 비교하며 불일치 또는 확인 실패 시 세션을
폐기하고 mutation UI에 진입하지 않는다.

### Windows x64 artifact

```powershell
uv sync --python 3.12 --frozen
uv run --python 3.12 python scripts/build.py
```

`dist/RoomManagementBackendConsole-windows-x64.zip`과 SHA-256 파일이 생성된다. artifact에는
`config.json`, developer 비밀번호, token, service secret이 포함되지 않는다. 압축을 승인된
폴더에 풀고 `config.example.json`을 `config.json`으로 복사한 뒤 실행한다.

초기 버전은 자동 업데이트와 Authenticode 서명을 제공하지 않는다. release 담당자가 GitHub
승인 source에서 직접 생성한 checksum과 전달 파일을 대조한다.

## 운영 절차

1. 상단의 `환경: PRODUCTION|RECOVERY|LOCAL`과 `PROJECT`를 색이 아닌 텍스트로 확인한다.
2. 고정 developer ID `admin`과 사용자가 직접 입력한 비밀번호로 로그인한다.
3. 운영 대시보드에서 migration drift, RLS, scheduler, secret configured 여부를 확인한다.
4. 계정 목록에서 business admin/maid만 생성·변경한다.
5. 계정 생성 입력의 휴대전화는 요청 시작과 동시에 화면에서 지워진다.
6. 임시 비밀번호는 완료 대화상자에서 한 번 읽어 안전한 별도 채널로 전달한다. 앱은 복사
   버튼이나 영속 저장을 제공하지 않는다.
7. 상태 변경에는 자유문 대신 합의된 영문 대문자 reason code를 사용한다.
8. network/5xx로 결과가 불확실하면 같은 입력으로 재시도한다. 프로세스 메모리의 동일
   idempotency key가 재사용된다. 다른 입력은 fail-closed된다.
9. 작업 후 `잠금 및 로그아웃`을 누르거나 앱을 종료한다. 일정 시간 미사용 시 자동 잠금된다.

developer 계정, 마지막 active business admin, developer로의 승격은 서버 DB 계약과 GUI
양쪽에서 차단된다. GUI 버튼이 보이지 않거나 비활성인 것을 서버 권한의 대체로 보지 않는다.

## 로그·자격증명

- access/refresh token과 비밀번호는 프로세스 메모리에만 존재한다.
- Windows Registry, Credential Manager, 일반 설정 파일에 인증정보를 저장하지 않는다.
- 일반 application log 파일을 만들지 않는다.
- 오류 화면에는 HTTP status, 안정적인 `error.code`, `requestId`만 표시한다.
- 전체 전화번호, 임시 비밀번호, token, 전체 오류 응답은 캡처·Issue·메신저에 남기지 않는다.
- publishable key는 공개 client key지만 프로젝트 혼동을 막기 위해 승인된 config만 배포한다.

## PC 분실·자격증명 노출 대응

1. 분실 PC의 network/VPN 접근을 차단한다.
2. Supabase Auth에서 해당 developer의 active session을 폐기하고 비밀번호를 변경한다.
3. publishable key 자체보다 developer 세션/비밀번호 유출 여부를 우선 조사한다.
4. 운영 project ref와 감사 event에서 분실 시각 이후의 계정 변경을 확인한다.
5. 의심되는 business 계정은 일반 계정 API로 잠금 해제하지 말고 상태·세션 영향부터 검토한다.
6. secret/service-role 노출이 발견되면 이 도구의 정상 동작으로 간주하지 말고 별도 incident로
   즉시 회전한다. Phase A artifact에는 해당 값이 없어야 한다.

## 업데이트·삭제

- 업데이트는 승인된 새 zip과 SHA-256을 검증한 뒤 기존 실행 폴더와 분리해 설치한다.
- `config.json`은 project ref를 다시 확인해 수동으로 옮기며 인증정보를 복사하지 않는다.
- 삭제 전 앱을 잠금/종료하고 실행 폴더와 사용자가 만든 `config.json`을 삭제한다.
- 앱은 token cache, DB, Registry 값을 만들지 않으므로 별도 자격증명 저장소 삭제가 없다.
- PC 분실이나 비정상 종료가 있었다면 로컬 삭제만으로 끝내지 않고 서버 세션을 폐기한다.

## 연결 정본

- HTTP 기계 계약: 배포 `/functions/v1/api/openapi.json`
- 운영 API 의미: `docs/DEVELOPER_OPERATIONS_API.md`
- API 상태: `docs/API_STATUS_MATRIX.md`
- DB 복구: `docs/BACKUP_AND_RECOVERY.md`
- Phase B/C 보안 범위: GitHub Issue #44
