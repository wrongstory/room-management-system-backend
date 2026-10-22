# #464 사진 업로드 실패·재시도 인계

상태: 2026-10-22 운영 반영 완료. api51, migration120. 아래 개발 단계의 NOT RUN은 과거 기록이다.

## 운영 적용 결과 (2026-10-22)

- PR468 사진 릴리스 및 PR470 Qt/CI 보완 병합 main ad1b1a0.
- PR470 CI39705842954 및 main CI39706149605 application/migration PASS.
  전체 DB는 재실행하지 않고 승인된 PR468 run39678174846 attempt1 성공 증거를 재사용했다.
- 운영에는 photo_upload_pre_provider_retry 한 건만 적용했다(원격20261022013407).
  history119→120, service_role 실행 허용/anon·authenticated 거부 확인.
- api51 ACTIVE, artifact e63bdb3561007c797ebf0dd0d5db1b7ffbdccf33cdb7827becd2d3416c671023.
  다른 함수 4개 불변. health/OpenAPI200, 154 paths/166 operations,
  무인증 auth-me/rooms401 및 운영 Origin CORS204 확인.
- Security Advisor는 적용 전후 동일(기존 INFO127/WARN1); 보안 정책 변경 없음.
- 실제 사진 업로드·PIN/Auth 변경·데이터 backfill·삭제·태그 발행은 수행하지 않았다.
  첫503 상세 원인은 여전히 미확정이며 실제 사용자 사진 재시도 UAT는 별도다.
- 프런트는 아래 오류 분류 및 동일 key/item/파일 보존 계약을 유지한다.

## 확인된 운영 사건 (2026-10-21 KST)

- 9/27 142호 업무: 23:12:23·29 업로드 503, 이후 23:12:54·23:13:01 재시도 409.
- 배정 revision 4와 collection revision 0은 당시 요청과 일치한다.
- 409의 DB 사유는 PHOTO_UPLOAD_IN_FLIGHT. 작업은 reserved, 5분 lease가 남았다.
- 파일 identity 예약·provider 성공·acceptance는 기록되지 않았다.
- 23:12:28 용량 snapshot 갱신 성공, 318,606,665 bytes. 12GB 차단 아님.
- PHOTO_STORAGE_QUOTA_UNAVAILABLE는 오래된 snapshot 갱신 유발 신호일 수 있다.
  이를 사용자 첫 503의 최종 원인으로 확정하지 않는다.
- 당시 함수 로그에 provider 상세 원인이 없다. 첫 503의 정확한 OAuth/HTTP/응답 원인은
  미확정이며 인증키 변경·Drive 장애라고 단정하지 않는다. 이후 요청의 단계 구분을 보강한다.

## 백엔드 후보

- 기존 공개 PHOTO_PROVIDER_UNAVAILABLE(503)는 유지한다.
- 내부 진단은 OAuth/HTTP/응답 처리 단계와 인증 거부·요청 제한·상위 서버 오류·통신 실패를
  고정 enum으로 기록한다. URL, token, Drive ID, provider 본문은 기록하지 않는다.
- 503 이후 새 service-only RPC가 live actor/session, exact operation/claim/lease를 검사한다.
  reserved이고 파일 identity·성공·acceptance가 모두 없는 경우만 lease를 반납한다.
  같은 key/item/파일로 다음 요청이 다시 claim할 수 있다. 8회 상한은 유지한다.
- 파일 identity가 이미 있거나 업로드 결과가 불확실하면 즉시 반납하지 않는다.
  기존 동일 identity/fence 복구를 유지하고 중복 생성·임의 삭제는 하지 않는다.
- 기존 실패 row backfill/강제 삭제는 없다. 이미 만료된 lease는 기존 동일 요청 재시도를 따른다.

## 프런트 인계 (프런트 소스 변경 없음)

| 코드 | 안내 및 동작 |
|---|---|
| PHOTO_UPLOAD_IN_FLIGHT | “같은 사진의 업로드 처리 중입니다. 잠시 후 다시 확인해 주세요.” 선택한 파일·item ID·Idempotency-Key를 보존하고 중복 클릭/병렬 재시도를 막는다. 일반 최신 상태 충돌로 표시하지 않는다. |
| PHOTO_PROVIDER_UNAVAILABLE / PHOTO_STORAGE_QUOTA_UNAVAILABLE | “사진 저장소 연결이 원활하지 않습니다. 사진을 유지한 채 다시 시도해 주세요.” 같은 요청을 재사용하며 무한 자동 재시도하지 않는다. |
| PHOTO_STORAGE_QUOTA_EXCEEDED | 저장공간 확인이 필요함을 안내. 반복 업로드하지 않는다. |
| PHOTO_VERSION_CONFLICT / PHOTO_COLLECTION_VERSION_CONFLICT / PHOTO_ITEM_VERSION_CONFLICT / ASSIGNMENT_VERSION_CONFLICT | 실제 상태 충돌. 최신 슬롯·배정을 조회해 사용자 의도를 다시 확인한다. CAS 값을 임의 증가시키지 않는다. |
| PHOTO_UPLOAD_LEASE_LIMIT / PHOTO_OPERATION_TERMINAL | 무한 재시도하지 않고 문의 번호와 함께 관리자 확인을 안내한다. 새 key로 자동 우회하지 않는다. |

HTTP 503은 성공 여부 미확정을 포함한다. 화면에서 사진 삭제/완료로 단정하지 않고,
accepted receipt와 최신 슬롯 조회로 확인한다. key/item을 새로 만드는 재시도는 금지한다.
서버 내부 진단 enum은 공개 API 필드가 아니므로 프런트가 의존하지 않는다.

## 적용·검증 gate

- DB 함수는 CLI 생성 신규 append migration 한 건. 기존 SQL·업무 데이터·Auth/PIN 변경 없음.
- migration 실행은 사용자 승인 후에만 진행. DB 함수 적용 전 코드만 먼저 배포하면
  반납 실패 시 기존 잠금이 유지되므로 즉시 재시도 개선이 활성화됐다고 주장할 수 없다.
- 최종 릴리스: 실제 역할/세션/만료/같은 key/다른 key/늦은 claim/identity 예약 경합,
  immutable event·quota 보존, 기존 accepted 보존과 rollback을 검증해야 한다.
- rollback은 API 이전 버전 복귀; 새 함수는 호출하지 않는 상태로 남길 수 있다.

## 개발 검증 (2026-10-21)

- typecheck / build PASS, Node 123 files / 3,080 tests PASS.
- edge:check PASS, 후보 번들 19,410,302 bytes (20,000,000 bytes 제한 이내).
- manifest 120건 PASS (DB 실행 아님), secret scan / frontend OpenAPI PASS.
- lint exit 0, 기존 24 warnings / 58 infos 유지.
- 독립 QA: 소스·합성 범위 PASS, 관련 4 files / 186 tests 직접 실행.
  반납 응답 유실과 기존 purge 오류 분류 회귀 지적을 수정하고 재검증했다.
- 초기 검사에서 migration head 등록 및 생성물 해시 불일치가 실패했으며
  등록·공식 생성기를 통해 보완했다. 검증 기준 완화 없음.
- 실제 SQL·경합 / 전체 DB / 운영 반영 NOT RUN. 실행 전 별도 승인 필요.
