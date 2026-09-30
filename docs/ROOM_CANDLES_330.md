# #330 촛불 공동 관리: 프런트 연동과 검증

상태: 백엔드 source 후보. 운영 DB/API 및 프런트 변경은 이번 작업에 포함하지 않는다.
제품 근거: 사용자의 “다른 메이드랑 관리자도 가능”, “촛불 수량 조정은 아무나” 결정. 여기서 누구나는 비밀번호 변경을 마친 활성 관리자·메이드이며 익명·개발자·비활성·퇴사·제한 계정은 제외한다.

## HTTP 계약

두 endpoint 모두 Bearer 인증을 사용하고 성공 응답은 `Cache-Control: no-store`다. actor/session은 서버가 검증한 token에서 추출하며 클라이언트가 지정하지 않는다.

- `GET /v1/rooms/candles`: `{items:[{roomId,roomNumber,count,roomStateVersion}],nextCursor}`. 기본/최대 `limit=50`, 1~50의 canonical decimal 문자열만 허용한다. `cursor`는 응답의 UUID를 그대로 넘긴다. UUID 오름차순이며 마지막 page는 `nextCursor:null`이다.
- `?roomId=<uuid>`는 정확한 객실 한 곳만 조회하며 없는 ID는 빈 items다. `roomId`와 `cursor`를 함께 보내지 않는다. PIN·예약자·작업·사진·전체 객실 상태·event actor를 포함하지 않는다.
- `POST /v1/rooms/{roomId}/candles`: 기존 경로와 요청을 유지한다. `Idempotency-Key` 필수. JSON은 `{expectedRoomVersion:7,reasonCode:"CANDLE_ADJUSTED",count:0,physicallyVerified:true}` 형태다. 예시 version은 실제 조회값으로 교체한다. count는 0~2147483647 정수, version은 1 이상의 안전한 정수다.
- 감소/0 초기화 시 실제 회수한 처리자가 `physicallyVerified:true`를 보낸다. 이는 현장 회수 확인이며 별도 관리자 승인이나 PIN 물리 확인이 아니다. false/생략 상태에서 감소하면 400 `VALIDATION_ERROR`다. 증가에는 확인이 필요 없다.
- 성공은 기존 `{operation:{entityId,roomId,roomStateVersion,recordedAt}}` 응답이다. 최신 수량은 최소 조회로 갱신한다. 일반 객실 상세는 여전히 관리자 전용이며 메이드가 이 응답 대신 조회하면 안 된다.
- 409 `STALE_VERSION`: 최신 수량·version 재조회 후 사용자가 의도한 수량을 다시 확인하고 새 key로 요청한다. 동일 요청의 네트워크 재시도는 같은 key/body를 사용한다. 같은 key를 다른 수량에 재사용하면 409 `IDEMPOTENCY_KEY_REUSED`다.
- 인증/세션 및 권한 오류는 401/403, 잘못된 입력은 400, 변경 대상 부재는 404다. message 문자열이 아닌 안정적인 error code로 분기한다.

## 보존·보안 경계

배정자·원 수행자·제출/승인 상태·최근 7일 제한을 검사하지 않는다. 승인 후 다른 메이드도 처리할 수 있다. DB는 매 요청 최신 profile role/status/password 상태와 해당 사용자의 유효한 session을 확인하며, 완료 receipt 재시도도 폐기/만료 세션으로 허용하지 않는다.

현재 수량 0은 `CANDLE_PRESENT`만 없앤다. 별도 운영 차단·이슈·점유·청소 의무가 남으면 여전히 배정 불가일 수 있다. 제출/사진/검수 결정/수익/지급 snapshot을 변경하거나 청소 승인을 취소하지 않는다. 승인 이후 새 특이사항 신고는 범위 밖이며 #336에서 정책 결정을 추적한다. 범용 객실 변경 RPC와 일반 상세/PIN 권한은 확대하지 않는다.

## DB와 배포

`20260930135538_shared_room_candle_adjustment.sql`만 추가한다. 기존 85개 migration, 기존 데이터·RLS·원장 UPDATE/DELETE 금지·FK index는 유지한다. 전용 service-role RPC 2개와 비공개 guard/trigger를 추가하며 anon/authenticated 직접 실행은 금지한다. 기록 시각은 room lock 후 기존 최댓값보다 뒤로 정하여 동시/동일 transaction의 최신 수량을 보장한다. 과거 시각을 덮어쓰거나 backfill하지 않는다.

릴리스 승인 후 순서는 DB migration → API → 프런트 연동이다. 환경 변수·비밀키·PIN 변경은 없다. rollback은 직전 API bundle을 복원하고 새 DB 함수/이력은 보존한다. 이때 새 메이드 촛불 UI를 비활성화해야 하며 관리자 기존 경로는 호환된다. 기능 branch에서 운영 migration 또는 배포를 실행하지 않는다.

## 재현 가능한 로컬 검증

Docker 엔진은 AGENTS의 Safe Start 규칙을 따른다. 명령은 저장소 루트에서 실행한다.

1. `npm run db:reset` → 전체 migration과 seed 재적용.
2. `npm run db:manifest:verify`, `npm run db:test` → upgrade 및 전체 rollback-only pgTAP.
3. `npm run db:test:concurrency` → 기존 전체 경쟁 검증과 촛불 CAS/멱등/계정·세션 경합 포함. synthetic 행을 남기므로 SQL 회귀보다 뒤에 실행한다.
4. `npm run db:test:candles`는 developer bootstrap이 이미 존재하는 위 concurrency 실행 이후의 부분 재검증용이다. 단독 빈 DB에서는 bootstrap 전제로 실행하지 않는다. fixture는 다음 로컬 reset에서 제거된다.
5. `npm run ci:quality`, `npm run edge:check`, backend-console의 `uv run python scripts/check_business_openapi_codegen.py`.

새 pgTAP은 다른 메이드 감소·초기화, 감소 확인, 다른 차단 보존, 과거 관리자 receipt 호환, live session/role, 실제 DB 역할별 RPC·DML 거부를 검증한다. 기존 승인 제출 fixture에서도 제3 메이드 조정 후 제출/사진 연결/검수/수익 보존을 확인한다. 운영 실사용 성공으로 확대 해석하지 않는다.
