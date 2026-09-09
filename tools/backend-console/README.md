# 백엔드 운영 콘솔 — Phase A

승인된 Windows 운영 PC에서 Supabase Edge API만 사용해 계정과 운영 상태를 관리하는
Python 3.12+ 데스크톱 도구다. Phase A에는 DB 연결, SQL 실행기, service-role key가 없다.

#84 사진 업로드/슬롯/원본4 operations는 business maid/admin 권한이며 developer 콘솔에 추가하지 않는다.
filtered OpenAPI와 생성 client는 auth/accounts/developer16 operations만 유지한다. 사진 업로드 감사는 기존 `photo.upload_accepted` safe summary로 확인하며 Drive ID/OAuth/원본 내용을 노출하지 않는다.
runtime-status는 Drive CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/ROOT_FOLDER_ID와 PHOTO_PURGE_INVOKE_SECRET의 configured boolean만 표시한다. database-status의 photoPurge는 최대 1,000건으로 제한한 backlog와 마지막 heartbeat의 안전한 집계만 제공한다. false나 누락 heartbeat가 있으면 운영 provider 준비 미완료이며, 모두 정상이어도 실제 Google 인증/hosted purge smoke 통과를 의미하지 않는다. 자격증명·Drive locator·claim digest를 입력하거나 출력하는 콘솔 기능은 없다.

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

#28 source는 수행 회차 활성화와 이월 감사 event 2종 및 승인된 요약 필드만 생성 모델에
추가한다. attempt/assignment 식별자와 날짜·회차 정보 외의 raw state, request hash, 비밀정보는
노출하지 않는다. 이 역시 다음 release 전에는 production 기능으로 간주하지 않는다.

#29 source는 `assignment.duration_policy_confirmed`와 정책 version/status/네 타입 minute의
safe audit summary를 생성 모델에 추가한다. Developer 콘솔의 filtered OpenAPI는 기존
auth/accounts/developer 경계만 유지하며 admin용 preview/정책 확정 기능을 추가하지 않는다.
Preview 계산 자체는 감사 event를 만들지 않는다. source 모델 생성과 production API 배포는 별도다.

#7A source는 `cleaning.attempt_started`/`cleaning.field_completed`와 실행 version·서버 시각의
safe audit summary를 생성 모델에 추가한다. field_completed는 물리 완료이며 검수 승인/수익과
별개다. filtered OpenAPI는 Auth/Accounts/Developer 기존 16 operations만 유지하고 maid의
start/complete API를 콘솔에 추가하지 않는다. PIN/PII/raw state/request hash는 포함하지 않는다.

#7B feature의 생성 계약은 한 건 마무리 허용/증빙 유예/인계/미착수 만료 해소의 네 감사 event와
허용된 version·시각·capability metadata를 추가한다. 운영 콘솔의 업무 상태 변경 화면에
`deactivation_pending`/`upload_only`를 임의 target으로 추가하지 않는다. 이 상태는 전용 admin
lifecycle command의 결과이며 developer가 업무 인계·limited 실행을 대신하는 기능은 없다.
필터는 기존 Auth/Accounts/Developer 16 operations를 유지한다. 실제 사진·제출 API 및 별도
capability 로그인 secret은 포함하지 않는다. 생성 모델 검증과 운영 배포는 별도 gate다.
기존 문서의 15개 표기는 이미 생성되어 있던 `change_password` 1개를 누락한 설명 오류였다.
이번 feature에서 그 endpoint를 새로 추가한 것이 아니며 exact module allowlist 회귀로 검증한다.

#7C source는 `cleaning.offline_event_resolved`와 서버 발급 `offlineQuarantineId`, 고정
`resolution` 요약만 생성 모델에 추가한다. client event UUID·lease ID·발생 시각·clock offset·
request hash는 90일 metadata 저장소 계약이므로 영구 감사 projection에 복제하지 않는다.
developer 콘솔은 기존 16 operations만 유지하며 admin 격리 판정 및 maid lease/동기화 API를
대신 실행하지 않는다. `correction_link`는 현재 유효 회차의 검증 가능한 완료 정정이지 과거
인계/종료 회차를 복구하거나 검수·입실 준비·수익을 만드는 기능이 아니다.

#31 source는 submission/inspection audit event 5종을 filtered OpenAPI와 generated client에
추가한다. 콘솔은 `submission.bomb_reported`, `submission.created`, `inspection.bomb_decided`,
`inspection.approved`, `inspection.rejected`의 safe summary만 조회하며 폭탄방 memo·증빙 photo ID,
일반 sealed photo ID, Drive locator/hash/file name, request hash/raw state를 받지 않는다. 관리자 검수
업무 API 8개는 developer 콘솔 allowlist에 포함하지 않으며 운영 배포 전 source enum을 현재 사용
가능 기능으로 표시하지 않는다.
