# 사진 업로드 우선 개선 — #411

## 범위와 상태

2026-10-10 사용자 결정: 삭제 기능은 후속으로 보류하고 업로드 성능을 최우선으로 개선한다.
이 문서는 **개발 후보**이며 운영 v0.9.3/API44의 변경 또는 실사용 속도 개선 완료가 아니다.
이번 1차 구현 추적은 [#434](https://github.com/wrongstory/room-management-system-backend/issues/434)이며
상위 #411의 병렬 업로드·썸네일 전체 범위를 종료하지 않는다.
DB/schema/migration, 보존·삭제 worker, 사진 품질/용량, 인증·권한·CAS는 변경하지 않는다.
프런트 구현은 프런트 팀이 담당한다. 썸네일과 안전한 동일 collection 병렬 업로드는 #411 후속이다.

## 실사용 기준선과 한계

2026-10-10 KST 17:44:40~17:45:16의 142호 일반 사진 5장을 읽기 전용으로 확인했다.
POST는 모두 200/accepted, 장별 서버 실행 시간은 10,175 / 6,120 / 5,912 / 5,650 / 5,397ms다.
첫 요청 시작~마지막 응답은 약35.4초, POST 실행 시간 합은33.254초다.
요청 Content-Length 합은2,012,385bytes(약1.92MiB), 저장 JPEG 합은686,752bytes(약670.7KiB)다.
이때 이미 `includePhotoSlots=true`를 사용했고 매 장 성공 뒤 별도 photo-slots GET은 없었다.
초기 한 번의 슬롯 조회와 파일별 OPTIONS는 별개다. 이후 추가 업로드는 이 5장에 포함하지 않는다.

기존 보관 로그에는 Server-Timing 상세가 없어 decoder/Drive/DB별 실제 지연을 분리할 수 없다.
첫 장 지연을 cold start로 확정하거나 전체 시간을 파일 전송 시간으로 해석하지 않는다.
실제 사진 원문·credential을 내려받거나 업무 상태를 변경하지 않았다.

PR 준비 중 확인한 [프런트 추가 1장 실측](https://github.com/makee-ham/room-management-system/issues/206#issuecomment-6095868309):
브라우저 요청10.581초, photo_db=4,128.2ms, photo_drive=4,491.5ms,
photo_decode=489.3ms, api_total=9,851.5ms다. 첫 5장과 다른 추가 표본이며
DB/Drive 지연의 세부 원인이나 평균을 확정하지 않는다. 프런트 첫 5장 POST 간 공백 합계는
약18ms로, 큐 사이의 인위적 대기가 주 병목이라는 근거는 없다.
정상 snapshot UAT는 통과했지만 전역 옵션/배포 설정은 변경하지 않았다는 프런트 보고다.
다음 upload 우선 작업은 DB 조회/RPC/최종 확정/snapshot별 숫자 계측과 중복 왕복 조사다.

## 1차: Drive 중복 조회 제거와 세부 계측

- Google `files.create` 성공 응답의 완전한 File metadata를 기존 검증기에 전달한다.
  같은 파일의 직후 metadata GET을 정상 경로에서 생략한다. 새 폴더 생성도 완전한 ACK를 재사용한다.
- 파일 identity/동결된 이름/MIME/size/정확한 부모/objectId/private/trashed/Google createdTime을
  계속 검증한다. Drive sha256Checksum이 없으면 실제 파일을 bounded download해 SHA-256을 확인한다.
  appProperties의 자체 hash 주장은 증거가 아니다.
- 응답 유실/실패/409/빈 응답/parse 실패/필수 metadata 누락은 같은 사전예약 ID만 재조회한다.
  완전하지만 충돌하는 ACK는 실패한다. 다른 ID 생성, 재업로드, 즉시 삭제로 복구하지 않는다.
- `inspect`는 항상 새 metadata GET을 수행한다. 부모·기존 폴더의 privacy는 매 업로드 다시 확인하며
  전역/요청 간 권한 cache를 추가하지 않는다. DB admission/claim/finalize·최종 권한 검사는 그대로다.
- 기존 `photo_drive`와 별도로 아래 request-local 숫자 timing을 추가한다.

| 이름 | 구간 |
| --- | --- |
| photo_drive_ids | 사전 후보 ID 발급 |
| photo_drive_folders | 두 폴더의 검증/필요 시 생성 합계 |
| photo_drive_upload | multipart create 및 응답 읽기, 필요 시 OAuth 대기 포함 |
| photo_drive_verify | ACK 검증 또는 fallback GET/실제 파일 해시 확인 |

위 값은 photo_drive의 **하위 구간**이므로 기존 total/drive에 더하면 중복 집계된다.
quota/inspect/content는 기존 photo_drive에만 포함될 수 있다. ID/URL/token/원문 오류/사진은 기록하지 않는다.
요청마다 timing 객체를 명시 전달하고 공유 provider에 요청 상태를 저장하지 않는다.
오류 응답 timing 비노출과 기존 Cache-Control/no-store·CORS·JSON 계약은 유지한다.

공식 근거: [Drive files.create 응답](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create).
Supabase changelog의 관련 breaking change와 [Edge 제한](https://supabase.com/docs/guides/functions/limits)을 확인했다.
한 요청에 여러 사진을 묶어 CPU/메모리 제한을 우회하지 않는다.

## 검증과 측정 해석

가상 RTT100ms, 기존 폴더, 완전한 SHA/metadata 응답, provider 한 인스턴스를 가정한 결정적 테스트:

| 순차 파일 수 | 이전 경로 HTTP/대기 | 후보 HTTP/대기 |
| --- | --- | --- |
| 1 | 8회 / 600ms | 7회 / 500ms |
| 5 | 36회 / 2,600ms | 31회 / 2,100ms |
| 20 | 141회 / 10,100ms | 121회 / 8,100ms |

이는 **합성 provider-only 비교**다. OAuth1회 포함, DB/decoder/실제 전송/브라우저 시간 제외이며
서로 다른 실제 파일 등록·5장 전체 운영 개선율을 입증하지 않는다. 실제 응답이 불완전하면 기존 GET 비용이 남는다.
새 폴더가 생성되면 완전한 ACK당 추가 GET1회씩 줄지만 기존 폴더 읽기 횟수는 그대로다.

검사 범위: 완전/부분/잘못된 ACK, checksum 누락·실제 bytes 변조, response loss/409/5xx,
폴더 부모·privacy, 기존 immutable 이름, 재조회 reconciliation, 공유 provider의 timing 격리,
1/5/20장 합성 요청 수, Fastify/Edge 공용 코드 및 번들.
전체 DB 검증은 사용자 #431 결정대로 최종 릴리스1회이며 이번 개발 단계에서는 NOT RUN이다.

2026-10-10 로컬 결과:

- 변경 전 baseline: Node110files/2815tests PASS.
- `npm run ci:quality`: PASS, Node111files/2856tests, typecheck/build·비밀 검사·OpenAPI151/163 포함.
  기존 lint warning1/info37은 그대로이며 이번 추가 unused 인자는 제거했다.
- `npm run db:manifest:verify`: PASS, dev112개. SQL/manifest 변경0, Full DB NOT RUN.
- `npm run edge:check`: PASS, Deno527건·report65건·bundled runtime65건,
  최종 후보 bundle19,279,889bytes. 추가 Deno 테스트의 타입 충돌은 보완 후 전체 재검증했다.
- 독립 QA: 관련3files/188tests·typecheck·generated bridge parity·diff PASS, P0/P1/P2 발견0.
  추가 Deno ACK2건과 타입 보완도 독립 읽기 검토 PASS, 실행은 최종 Edge gate PASS에 포함된다.
- 최초 관련 테스트의 실패5건은 새 내부 timing 인자 기대값을 반영한 뒤 해소했다. 실패를 PASS로 숨기지 않는다.
- 운영 Drive 실파일 재업로드, hosted ACK 완전성, 실제 모바일 개선폭: NOT RUN.

## 프런트 인계 및 다음 단계

현재 API 요청/응답 JSON 변경은 없다. 배포 전에는 운영에 이 최적화가 적용됐다고 표시하지 않는다.
사진 준비·서버 요청·화면 반영을 구분하고 1/5/20장 및 첫 요청/후속 요청의 소요 시간과
Server-Timing의 고정 숫자 항목만 수집한다. 실제 파일/토큰/URL을 분석 로그에 저장하지 않는다.
이미 적용된 snapshot과 null fallback, 동일 key/Blob 재시도를 유지한다.

다음은 실측에 따른 DB 왕복/폴더 경로 추가 최적화와 안전한 2장 동시 업로드 계약이다.
현재 collection CAS/inflight 구조에서 단순 Promise.all은 금지한다. 사전예약/파일별 완료/
실패 재시도/제출 경합을 설계·검증한 뒤 프런트에 새 계약을 전달한다. 삭제 개발은 이 순서에 넣지 않는다.
