# 사진 성능 개선 1차 — #409

상태: 개발 후보. 이 문서만으로 운영 적용을 의미하지 않는다.

## 확인한 병목과 범위

프런트 `makee-ham/room-management-system` dev `314f0d74288b8017ec3a902cc30cf149e77e550a`는 사진을 1920px/JPEG quality 0.82로 준비하고, 전역 업로드 큐에서 사진마다 업로드 후 photo-slots GET을 기다린다. 조회는 이미 최대 4개 병렬이다. 백엔드는 별도로 입력 검증·재인코딩·DB 권한/CAS·Drive 저장 확인을 수행한다.

이번 변경은 추가 브라우저 왕복을 줄일 선택 옵션과 병목 계측이다. 실제 업로드/조회 속도 개선율은 아직 측정하지 않았다. 썸네일, 저장소 변경, 같은 collection 병렬 쓰기, DB migration은 포함하지 않는다.

## 프런트 연동

다음 두 POST 경로에 선택 query `includePhotoSlots=true`를 추가한다. 생략한 기존 요청/응답은 그대로 유지된다. false, 빈 값, 중복 옵션은 거부한다.

- `/v1/attempts/{attemptId}/photo-slots/{slotId}/upload`
- `/v1/attempts/{attemptId}/photo-slots/{slotId}/photos/{photoItemId}/upload`

옵션 사용 시 기존 응답에 `photoSlots`가 추가된다.

- `status=accepted`, 유효한 snapshot: 기존 GET과 동일한 공개 projection을 사용한다. 성공 직후의 별도 GET을 생략할 수 있다.
- `photoSlots=null`: 기존 accepted 영수증을 유지하고 필요하면 GET으로 상태만 재조회한다. 이미 성공한 파일을 새 키로 재업로드하지 않는다.
- 미완료 operation: snapshot을 조회하지 않고 null을 반환한다. 기존 operation 상태 확인 절차를 유지한다.

Snapshot은 성공 후 **별도 권한 검증을 거친 현재 상태 조회**다. 업로드와 원자적인 snapshot이나 다음 쓰기의 CAS 성공을 보장하지 않는다. 응답을 받기 전 다른 작업자가 수정할 수 있고 accepted 재시도도 새 snapshot을 받을 수 있다. 요청의 attempt/assignment/revision과 일치하지 않으면 null이다. 제한 계정에는 기존 GET과 동일한 필드 제한을 적용한다.

기존 서버는 알 수 없는 query를 거부하므로 백엔드 배포 확인 후 옵션을 켠다. 재시도 시 idempotency key, 이미지 bytes와 revision 계약을 유지한다. Snapshot 때문에 DB 조회 자체가 사라지는 것은 아니며 브라우저의 후속 HTTP 왕복만 제거한다.

## Server-Timing

인증을 통과한 사진 API의 성공 응답에 숫자 ms 값만 포함한다. 실행한 단계만 표시한다.

| 이름 | 측정 구간 |
| --- | --- |
| photo_db | 서비스 RPC 대기 시간의 합 |
| photo_body | 서비스에서 요청 body를 읽는 시간 |
| photo_decoder_init | 이미지 디코더 초기화 대기 |
| photo_decode | 이미지 검사·재인코딩 |
| photo_drive | 계측된 quota/ID/folder/upload/read/inspect 호출 대기 |
| photo_total | 인증 이후 요청별 서비스 scope의 전체 시간 |

Fastify body parser 이전 수신, 인증, 응답 전송, 브라우저 준비/렌더링 시간은 total에 포함되지 않는다. Drive provider 내부 네트워크·토큰 준비 대기는 해당 호출에 포함된다. 공유 quota refresh를 기다리는 다른 요청은 total에 대기 시간이 포함되지만 실제 호출의 단계 시간은 실행한 요청에만 잡힌다. 오류 응답에는 이 헤더를 추가하지 않는다. 단계 합이 전체 지연의 완전한 분해라고 해석하지 않는다.

`Access-Control-Expose-Headers`에 `Server-Timing`을 추가하므로 허용된 프런트가 응답 헤더로 읽을 수 있다. 별도 Timing-Allow-Origin 허용은 추가하지 않는다. 고정 이름/숫자만 출력하고 식별자·URL·이미지·토큰·PIN·DB 오류는 포함하지 않는다. 기존 no-store, 읽기 전후 권한 확인, quota singleflight, 보존 정책을 유지한다.

## 후속 및 검증

- 프런트 인계: [#206](https://github.com/makee-ham/room-management-system/issues/206) — 이미지 준비 단계 겹치기, 로컬 미리보기, snapshot 적용 및 null fallback, 화면에 보이는 사진 우선 조회. 같은 collection 업로드를 단순 Promise.all로 바꾸지 않는다.
- 백엔드 후속: [#411](https://github.com/wrongstory/room-management-system-backend/issues/411) — 실제 단계별 지연을 확인한 뒤 권한·삭제 정책에 연계된 private thumbnail 및 안전한 병렬 쓰기 검토.
- 별도 기존 결함: [#410](https://github.com/wrongstory/room-management-system-backend/issues/410) — 미완료 operation의 nullable 보존 필드와 OpenAPI 불일치. 이번 accepted snapshot 변경과 분리한다.

회귀 검증 범위: 옵션 생략 호환성, snapshot allowlist/제한 계정, 실패 시 accepted 보존, assignment 경합 fallback, 재시도 해시 불변, 동시 요청 timing 격리 및 quota refresh 공유, Fastify 실제 raw HTTP 경로, OpenAPI 응답 검증, Edge 인증/헤더 회귀. 실제 모바일 다중 업로드 시간과 운영 Drive 성능은 프런트 연동 후 측정해야 한다.

2026-10-09 로컬 결과: `npm run ci:quality` PASS(2691 tests, typecheck/build 포함),
`npm run edge:check` PASS(492 + 번들 runtime 65 tests, 최종 번들 19,206,149 bytes),
Python business OpenAPI codegen PASS 및 pytest 102 PASS. 독립 QA 관련 105 tests PASS,
미해결 P0/P1/P2 없음. 실제 DB 검증/운영 성능/UAT는 NOT RUN이며 migration/SQL 변경은 없다.

### 최신 dev 통합 검증 (2026-10-09)

`dev@05d163d`(#421)를 원 PR 브랜치에 병합해 재검증했다. 사진 기능 코드는
원 PR과 같으며, 최신 dev 대비 migration/SQL/manifest 변경은 없다.

- `npm run ci:quality`: PASS, 107files/2693tests 및 typecheck/build. 기존 lint info20.
- `npm run edge:check`: PASS, 최종 번들 19,242,386bytes.
- Python `check_business_openapi_codegen.py`: PASS. 기존 binary media/handover 생성기 경고는 남으며 모든 경로 자동 생성 성공을 의미하지 않는다.
- Python `pytest`: 102 PASS.
- 독립 QA: 사진105 + 인덱스 통합145, 총250tests PASS; P0/P1/P2 없음.
- 로컬 DB reset/전체 SQL 재실행: NOT RUN. #421에서 검증·병합된 SQL과 동일하며 이번 통합의 원격 필수 migration CI는 별도로 확인한다.
- 운영 미반영. 최신 통합 commit의 필수 CI 확인 전 병합하지 않고, 운영 배포 확인 전 프런트 snapshot 옵션을 켜지 않는다.

#410의 미완료 operation nullable 스키마 불일치는 기존 독립 결함으로 남는다.
#411 thumbnail/안전한 병렬 업로드는 이번 옵션과 분리한다.
