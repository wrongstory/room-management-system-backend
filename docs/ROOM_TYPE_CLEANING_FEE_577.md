# 관리자 타입별 기본 청소 단가 변경 (#577)

사용자가 v1.0.0 긴급 추가와 **객실 타입별 기본 단가**를 선택했다. DB/API 개발 후보이며 운영 저장 가능 상태가 아니다. 이전 FINAL-147-R8 입력은 이 기능을 포함하지 않아 사용 중지·보존했다.

## 관리자 화면 / API 계약

1. 기존 `GET /v1/room-types`에서 타입 ID·표시명·현재 `baseCleaningFee`·`version`을 읽는다. 숫자를 프런트 상수로 고정하지 않는다.
2. 타입별 금액 입력과 확인 팝업에 이전/새 금액 및 **이미 생성된 미래 청소를 포함한 기존 청소·확정 수당은 변경하지 않음**을 표시한다. 기존 룸타입·인원·템플릿 수정 권한으로 확대하지 않는다.
3. `PUT /v1/room-types/{roomTypeId}/cleaning-fee`, `Authorization: Bearer …`, 새 `Idempotency-Key`를 사용한다. 본문은 정확히 `{"baseCleaningFee":18000,"expectedVersion":1,"confirmFutureTargetsOnly":true}`다. 입력하지 않은 값·음수·소수·문자열·확인 누락/false·추가필드를 거부한다. 숫자0원은 명시 유효값이며 생략/null과 다르다.
4. 성공 응답은 `{"roomType":{"roomTypeId":"…","baseCleaningFee":18000,"version":2,"effectiveFor":"NEW_TARGETS_ONLY"}}`다. 같은 값의 새 명령은 가격 변경/audit/version 증가 없이 성공 receipt만 보존한다. 같은 key·같은 요청은 최초 응답을 재전송하며 같은 key·다른 내용은409다. 성공·재전송 뒤 현재 목록을 다시 조회한다. 다른 관리자의 후속 변경 때문에 receipt가 최신 가격일 필요는 없다.
5.409 STALE_VERSION이면 새 GET 가격/version으로 확인 팝업을 다시 열고 새 key로 제출한다. 불명확한 응답에서는 같은 key/같은 본문으로 결과를 확인한다. 역할 변경·세션 만료·최초 비밀번호 변경을 새로 확인한다.401/403은 로그인/권한 안내,400은 입력 안내,404는 타입 새 조회,503은 사용 중지로 안내한다.

관리자끼리 공유하며 메이드·developer는 가격을 바꾸지 못한다. Fastify와 Edge가 같은 정규화/검증·논리 요청 hash·응답 필터를 사용한다. query parameter는 받지 않고 응답은 no-store다.

## 적용 범위와 보존

현재 catalog를 조회해 새로 생성하는 일반 청소에만 새 단가를 snapshot한다. 예약 저장 때 이미 생성된 비공개 미래 퇴실 target도 예전 금액을 유지한다. 담당 변경·통보·검수·승인 때 최신 단가를 다시 계산하지 않는다. inspection reclean0원, 원 유상 target의 snapshot을 승계하는 replacement, 기존 폭탄방 bonus/compensation 상한 규칙을 유지한다. 금액 변경 때문에 새 earning·adjustment·지급·자동 알림을 생성하지 않는다.

새 RPC는 기존 reservation-command 공통 잠금 뒤 type row를 잠그므로 일반 target 생성과 가격 변경의 선후가 일관된다. type의 기존 version trigger를 그대로 사용해 developer 정원 변경과도 CAS 충돌을 검출한다. receipt 전/후·잠금 대기 뒤에 최신 admin/session/password를 재검증한다. 감사에는 이전/새 금액·version·처리자·서버 시각과 고정 적용범위만 보존하고 기존 이력을 덮어쓰지 않는다. 기본료와 동액 bonus 합계의 integer 표현 한계 때문에 가격은0..1,073,741,823원의 정수다. 배정 preview의 feeSnapshot 필드만 이 같은 범위에 맞췄으며 다른 정수 필드의 범위를 확대하지 않았다.

## DB/회귀/배포 경계

추가 migration은 `20261102111756_room_type_cleaning_fee.sql` 1개(현재 목록148)다. 기존147 migration 원문·초기 가격 seed는 보존한다. 새 table/column 없이 기존 room_types/audit/receipt와 append-only HTTP admission route를 연결한다.

준비 회귀는 `room_type_cleaning_fee.sql`의 증감·0·no-op·역할·세션·CAS·멱등성·새 target snapshot과 기생성 보존, 기존 `payroll_work_details.sql`의 실제 PAID earning/cycle/item 전행 보존을 포함한다. session caller discovery는 새 exact signature/3fresh/owner·ACL·search_path만 추가하며 과거 baseline을 완화하지 않는다.

새 직접 경합 프로그램은 기존12개 뒤의13번째다. 별도 synthetic fixture에서6개 실제 잠금 관측(동일키 replay·다른관리자 CAS·같은키 다른내용·가격변경 선행/청소생성 선행·대기중 세션취소)을 준비한다. 기존로컬타깃/3연결/잠금관측·연결정리 도구를 재사용한다. 추가 fresh reset은 준비와 finally 각1회로 정상 전체81회가 되며 90초 work/10초 socket정리·각 reset180초를 고정한다. import만으로 CLI/DB를 실행하지 않는다. 실제 SQL/경합/전체DB는 별도 승인 전 NOT RUN이며 소스 파싱은 설치·PL/pgSQL/경합 성공 증거가 아니다.

프런트 소스는 이 백엔드 작업에서 수정하지 않는다. 실제 관리자 화면 연결·활성화와 실사용은 별도 담당의 연동이 필요하다. 최종 통합 입력으로 새 격리 전체 DB1회 승인을 받은 뒤, 필수 CI/독립 QA·보호조건·main통합 및 실제 운영history/pending의 별도 승인을 따른다. DB→API/Swagger→프런트 순서이며 실제 운영 가격을 바꾸는 행위는 관리자 확인 화면에서 수행한다. 되돌릴 때도 새 가격 변경 명령으로 기록하며 과거 청소·수당·이력을 삭제하지 않는다.
