# 객실 PIN Excel 내보내기 / 지정 Drive 가져오기 (#452)

2026-10-13 사용자 결정. 프런트 연계: makee-ham/room-management-system#220.
기존 숫자 4~8자리 서버 제한을 폐기한다. 일반/장기숙박 구분 없이 비어 있지 않은 문자열을 보존하고,
서비스 보호를 위해 UTF-8 128바이트, 제어문자/잘못된 Unicode 금지만 적용한다. 자동 생성은 숫자 4자리다.

## API

모든 경로는 최신 active/password-complete admin 및 live session이 필요하다.
developer/maid는 사용할 수 없다. 응답은 no-store다.

| 동작 | 경로 | 요청/응답 |
|---|---|---|
| 내보내기 | GET /v1/rooms/pins/export | .xlsx attachment, 시트 1, B2 객실/C2 비번, 3행부터 문자열 |
| 쓰기 검증 | POST /v1/rooms/pins/import/preview | 빈 JSON 객체 → preview(valid,total,changed,unchanged,ignored,issues,expiresAt,previewToken) |
| 쓰기 적용 | POST /v1/rooms/pins/import/apply | previewToken + Idempotency-Key → imported(updated,unchanged) |

비밀번호는 preview/error/receipt에 포함하지 않는다. issues는 원본 행 번호와 고정 오류 코드만 포함한다.
오류가 있으면 token이 null이다. token은 5분 유효하며 actor/session, 원본 identity와 파싱 결과,
active 객실 전체 room/state/PIN version snapshot에 HMAC으로 묶인다.
apply는 Google을 다시 읽고 비교한다. 409 또는 만료는 새 preview가 필요하다.
응답 유실은 같은 token/Idempotency-Key로 재시도한다. 이미 완료된 receipt는 만료/Google 장애 후에도
현재 관리자 세션 재검증을 거쳐 반환한다. 다른 token으로 같은 key를 재사용하면 409다.

## 양식과 경계

- 정확한 제목 ‘시트 1’과 숫자 sheetId 모두 검증한다. 공백 없는 ‘시트1’은 다른 탭이다.
- B열 객실 표시의 번호를 active room master에 매칭하고 C열의 객실번호-비밀번호 접두부를 교차 검증한다.
- 헤더는 C2 ‘비번’이며 앞뒤 공백을 허용한다. 3행부터 처리한다. 빈 행은 무시하지만 객실이 있는 빈 PIN은 오류다.
- 접미 객실 메모를 허용한다. 다이닝카페/피트니스/짐보관실은 이름으로 제외하고 나머지 미등록 행은 거절한다.
- 최대 active 300실, 시트 총 1001행(2행 헤더 포함). 더 큰 그리드는 임의 절단하지 않고 연결 오류로 거절한다.
- PIN 셀은 문자열만 허용한다. 수식/숫자 셀은 선행 0과 원문을 보장할 수 없어 거절한다.
- 요일·특이사항과 다른 탭은 읽지 않는다. 수식은 실행하지 않으며 내보내기도 inline string이다.
- 미설정 PIN은 내보내기에서 빈 셀이다. 이 파일을 다시 가져올 때는 비밀번호를 채워야 한다.

## 비공개 운영 설정

| 설정 | 의미 |
|---|---|
| ROOM_PIN_IMPORT_SPREADSHEET_ID | 운영자가 승인한 읽기 원본 문서 |
| ROOM_PIN_IMPORT_SHEET_ID | 시트 1의 숫자 tab identity |
| ROOM_PIN_TRANSFER_HMAC_SECRET | 32~1024 UTF-8 바이트 별도 무작위 secret. 암호키/다른 용도 secret 재사용 금지 |
| GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN | 기존 사진 저장 OAuth 재사용, 세 값 모두 필요 |
| GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL / GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY | 사진 OAuth가 전혀 없는 기존 환경의 서비스계정 읽기 호환 |
| 기존 ROOM_PIN_KEY_* | 현행 PIN 암호화 및 이전 키 복호화 |

2026-10-14 사용자 승인으로 사진 OAuth가 하나라도 설정되면 해당 인증을 선택한다.
일부 누락·인증 실패·권한 거부에서 서비스계정으로 조용히 전환하지 않는다.
refresh 요청은 기존 grant를 재사용하며 scope를 추가하지 않는다. 읽기는 GET만 수행하지만
기존 photo grant 자체가 읽기 전용으로 축소됐다고 주장하지 않는다. 사진 인증/업로드 코드는 변경하지 않는다.
서비스계정 호환 경로의 scope는 spreadsheets.readonly다. 읽기 원본은 기존
GOOGLE_SHEETS_SPREADSHEET_ID projection 문서와 달라야 한다. 기존 hosted projection allowlist를
확장하지 않는다. 서버 설정이 없으면 가져오기는 503이며 내보내기는 Google 설정 없이 동작한다.
실제 ID, URL, PIN, 자격증명을 Git/이슈/로그에 넣지 않는다.

같은 Google 계정 소유만으로 서버 접근을 보장하지 않는다. 기존 grant가 drive.file이면
브라우저에서 만든 새 문서에 별도 app 접근 허용이 필요할 수 있다. Sheets API 활성화와
기존 grant의 정확한 문서 접근을 읽기 진단으로 확인하며 권한 확대는 별도 승인한다.
OAuth 연결 변경은 DB 구조/API 계약 변경이 아니며 migration을 추가하거나 실행하지 않는다.

## 저장과 물리 확인

append migration 20261013072848_room_pin_transfer.sql은 service-role 전용 RPC와
revision source sheet_import를 추가한다. global lifecycle lock → sorted active room lock →
actor/session 재검증 → snapshot CAS → 짧은 원자 저장 순서다.
Google 호출은 DB transaction 밖에서 실행한다. private nonce reservation, immutable revision,
current pointer, entitlement rotation/reveal 폐기, 상태 version, 안전한 감사와 멱등 receipt를 재사용한다.

변경한 객실은 SHEET_PIN_AWAITING_PHYSICAL_CONFIRMATION mismatch다. 실제 도어락을 변경하거나
확인했다고 주장하지 않는다. 기존 ACTUAL_PIN_REENTRY prepare/confirm 절차로 현장 확인을 완료한다.
기존 담당 메이드의 current PIN entitlement 정책은 유지한다. 관리자 일반 reveal은 기존대로 mismatch에서
차단되지만, 명시적 Excel 반출은 저장값을 내보내는 별도 경로이며 객실별 sensitive.read 감사를 기록한다.
동일 값은 revision을 만들지 않고 기존 상태를 보존한다. import 자체는 Sheet outbox를 만들지 않는다.

## 검증 및 배포

합성 Node/Edge 검증은 원본 매칭·오류·선행0·자유 문자열·HMAC 변조·session binding·만료·원본/DB 변경·
재시도·권한·provider identity·readonly scope·암호화·Excel 문자열을 검사한다.
supabase/tests/room_pin_transfer.sql은 승인된 최종 DB 검증에서 권한/CAS/rollback/receipt/감사를 검사한다.
전체 DB 검증은 AGENTS.md/#431에 따라 **Full DB NOT RUN**이며 manifest 검증과 구분한다.
위 검증 계획 자체는 운영 DB migration, 원본 Drive 변경, hosted 설정 또는 production 배포 승인이 아니다.

### 2026-10-14 OAuth 연결 후속 checkpoint

- 사용자 승인으로 전용 비공개 빈 시트와 원본/tab/HMAC 설정 3개를 준비했다.
- 이번 source는 기존 사진 OAuth 재사용을 Fastify/Edge에 연결한다. 사진 provider와
  기존 projection worker/권한/DB/API 요청 응답 계약은 그대로이며 신규 migration은 없다.
- 승인된 임시 진단 2회에서 운영 OAuth 갱신 성공, Sheets 읽기 거부, 원인
  `SHEETS_API_DISABLED`를 확인했다. 두 함수 모두 삭제 및 기존 함수 inventory 불변을 확인했다.
- 사용자는 Sheets API 활성화 및 이후 읽기 재검증 1회를 승인했으나 Google Cloud가
  계정 2단계 인증 설정을 요구하여 차단 중이다. 사용자 직접 설정 전 API 활성화와
  세 번째 진단은 실행하지 않았다. 문서 읽기 성공/실제 PIN 가져오기 성공을 주장하지 않는다.
- source Node/Edge/명세 검증과 hosted 접근 검증은 구분한다. 운영 API 재배포·실제 PIN
  preview/apply·DB migration·reset·전체 DB CI는 이번 작업에서 실행하지 않았다.
- 고정 v0.9.5 릴리스에 이 후속 코드가 자동 포함된 것은 아니다. 일반 dev PR 이후 별도
  릴리스 통합 gate를 따른다. 실행 전 migration 승인 원칙은 그대로다.
