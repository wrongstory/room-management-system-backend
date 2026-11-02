# READY 경합 사진 fixture와 안전 진단 (#573)

R7 후보 ac58df9 / quality41410904550 attempt1은 28 upgrade·SQL118/6482·역사 static/KST와 첫 두 직접 경합 프로그램을 통과했지만 세 번째 READY callback의 localSql에서 실패했다. 원래 SQL 오류가 generic catch에서 제거되어 최초 실패 SQL/SQLSTATE, 여섯 READY race의 도달 위치는 미관측이다. Full DB는 FAIL이며 다음 9개 프로그램과 oracle/proof는 NOT RUN이다.

## 확인한 소스 결함과 보완

READY fixture의 기존 9551~9557은 4자리인데 `20260908180643_photo_drive_upload_read.sql`의 `photo_drive_identities.room_number`, `photo_drive_folder_identities.scope_room_number`는 3자리다. 배정 snapshot → get_photo_provider_context → room folder reserve → file identity까지 같은 번호를 사용한다. 합성 번호만 951~957로 바꾼다. 기존 catalog와 충돌하지 않으며 기존 UNIQUE는 유지한다. UUID·일곱 사례·템플릿·actor/session·청소/사진 본문 및 여섯 lock race의 결과와 보호 원장 snapshot 기준은 유지한다. 이 정적 입력 결함을 R7 최초 오류의 유일 원인으로 확정하지 않는다.

공유 manual runner의 동기 localSql에만 psql `VERBOSITY=sqlstate`를 사용한다. 고정 allowlist의 SQLSTATE와 숫자 caller line만 요약하고 오류 메시지·SQL·row·경로·stderr 원문은 출력하지 않는다. SQLSTATE가 없거나 예상 밖이면 null이다. 경합 contender의 argv/업무 오류명 oracle, timeout·lock 관측·reset·연결 수는 바꾸지 않는다. psql 오류 출력 설정은 [PostgreSQL 17 공식 문서](https://www.postgresql.org/docs/17/app-psql.html#APP-PSQL-VARIABLES)를 참고했다.

## 검증과 실행 경계

소스 회귀는 실제 사진 CHECK와 일곱 번호, baseline catalog·공유 manual의 충돌 가능성을 대조하고 PostgreSQL 15/17 grammar로 생성 fixture를 파싱한다. 진단 회귀는 SQLSTATE 전용 줄/알 수 없는 코드/원문 누출 차단/호출 위치/Assertion 분류를 확인한다. 파서는 PL/pgSQL 실행 증거가 아니다.

제품 API·migration147개·RLS·수당·사진 보존과 실제142호는 변경하지 않는다. 새 입력의 실제 DB·SQL·경합은 별도 승인 전 NOT RUN이며 운영 적용도 별도 승인이다. R7 stop PASS·volume 보존·finally reset 완료는 잔여 자원0 census를 뜻하지 않는다. 40분 상한은 임의 확대하지 않으며 R7 약36분/뒤9개 미실행 관측에 따라 다음 실행의 시간 예산을 별도 검토한다.
