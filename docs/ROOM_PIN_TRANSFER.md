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
| GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL / GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY | 원본 문서에 읽기 권한을 가진 서비스 계정 |
| 기존 ROOM_PIN_KEY_* | 현행 PIN 암호화 및 이전 키 복호화 |

읽기 adapter의 OAuth scope는 spreadsheets.readonly다. 읽기 원본은 기존
GOOGLE_SHEETS_SPREADSHEET_ID projection 문서와 달라야 한다. 기존 hosted projection allowlist를
확장하지 않는다. 서버 설정이 없으면 가져오기는 503이며 내보내기는 Google 설정 없이 동작한다.
실제 ID, URL, PIN, 자격증명을 Git/이슈/로그에 넣지 않는다.

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
운영 DB migration, 원본 Drive 변경, hosted 설정, production 배포는 수행하지 않는다.
