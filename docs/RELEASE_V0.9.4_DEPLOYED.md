# v0.9.4 운영 배포 기록 — 2026-10-10

이 기록은 기존 개발 후보/미배포 문구보다 우선한다. 실제 업로드 속도 개선율은 아직 측정하지 않았다.

## 배포 결과

- [PR439](https://github.com/wrongstory/room-management-system-backend/pull/439) 보호 squash 완료: 2026-10-10 11:21:06 UTC.
- 운영 main: `a0cef206c7672541494696bec47ae0ca62723322`.
- [v0.9.4 Release](https://github.com/wrongstory/room-management-system-backend/releases/tag/v0.9.4) 게시 완료. 태그는 위 main을 가리킨다.
- Supabase production `aodikrxcczbogjpsjwjt`: API ACTIVE45. 기존 내부 인증과 verify_jwt=false 유지.
- API artifact SHA256: `49e472e383dd018e5dc390796a0203c9d3a730d61cf717e3a2d3461bb8cabe40`.
- scheduler18/photo-purge7/notification-delivery9/room-pin-sheet-sync7 변경 없음.
- 신규 SQL0, 이번 병합·배포의 로컬/CI/운영 migration·reset·재구축 실행0. 운영 history112 유지.
- Secrets·Auth·PIN·업무 데이터·프런트 소스와 배포 옵션은 변경하지 않았다.

## 운영에 반영된 사항

- #434/PR435: Drive의 완전한 파일·신규 폴더 생성 ACK를 검증에 재사용해 정상 경로의 중복 metadata 조회를 줄인다.
  필수 metadata가 없거나 응답이 유실되면 예약된 동일 ID 조회로 복구한다. SHA/권한/부모 검증을 생략하지 않는다.
- #436/PR437: DB RPC별 클라이언트 경과 시간과 Drive token 획득 대기를 숫자 Server-Timing으로 제공한다.
  DB 함수·권한·CAS·JSON·사진 품질은 그대로다. 계측 자체가 DB 처리 속도 개선을 뜻하지 않는다.
- 계약과 주의사항은 [업로드 개선](./PHOTO_UPLOAD_PERFORMANCE_411.md), [세부 계측](./PHOTO_STAGE_TIMING_436.md)을 따른다.

## 검증 근거

- 사용자 승인한 release source `e021f0a74e50cd47f0790f7c553dfdd335a3fe97`의
  [CI38044427623](https://github.com/wrongstory/room-management-system-backend/actions/runs/38044427623): application/전체 migration PASS.
- full proof: `10ac431a47dcc1868784f33b0e8b7bd27650f0d80c6f6c7e63b802e09389ba24`.
- [main CI38048098442](https://github.com/wrongstory/room-management-system-backend/actions/runs/38048098442): application/migration PASS.
  동일 fingerprint의 위 증거를 재사용했다. DB 시작·재구축·전체 검사·종료·신규 proof 단계는 모두 SKIPPED다.
- 기능 후보 ci:quality PASS(111 files/2865 tests, typecheck/build 포함), Edge bundle19,284,587bytes PASS.
- 독립 기능 QA197 tests PASS. 독립 공개 운영 QA(11:24:05 UTC) health200, OpenAPI200,
  비인증 보호 GET401/no-store/Server-Timing 비노출, 허용 Origin OPTIONS204·비허용403 PASS.
- [Swagger 게시 CI38048251830](https://github.com/wrongstory/room-management-system-backend/actions/runs/38048251830) PASS.
  [Swagger](https://wrongstory.github.io/room-management-system-backend/)와 운영 paths/components 동일: 151 paths/163 operations.
  게시 명세 SHA256 `ad92908f7356abfc308042518b91600cf2de94c03890d5e27bf4eb985085b684`.
  OpenAPI3.1.1/info.version0.6.0은 앱 릴리스 v0.9.4와 별개다.
- 기존 Advisor leaked-password-protection WARN1/deny-by-default RLS-no-policy INFO127 유지. 경고0이라고 보고하지 않는다.
- 실제 인증 계정 업로드·삭제·제출·승인, 실기기 성능 p50/p95 및 rollback 실행은 NOT RUN이다.

## 프런트 인계 및 재측정

[프런트 #206](https://github.com/makee-ham/room-management-system/issues/206)과
[DOCS/32 기준](https://github.com/makee-ham/room-management-system/blob/82bc34009abd27dea57e3e37913c5f7aa6e62529/DOCS/32_PHOTO_PERFORMANCE_INTEGRATION.md)을 대조했다.
프런트 보고상 `RMS_PHOTO_UPLOAD_SNAPSHOT=true`는 Production/Preview에 이미 적용됐다.
이전 인계의 옵션 활성화 대기는 당시 기록이다. v0.9.4에 대한 실사용 성능 검증 완료를 뜻하지 않는다.

1. 현재 운영 프런트에서 사진1장/5장, 필요 시20장을 재측정한다. 첫 요청과 후속 요청을 분리한다.
2. 사진 준비·POST·목록 표시 시간과 Server-Timing의 DB/Drive/변환 구간을 구분한다.
   DB 단계는 네트워크·풀 대기를 포함하며 SQL 실행 시간만이 아니다. 하위/병렬 누적 시간을 total에 더하지 않는다.
3. 전역 순차 업로드 큐와 동일 key/Blob 재시도, accepted+photoSlots=null의 목록 재조회 복구를 유지한다.
   새 timing 헤더는 선택 정보이며 JSON 성공 조건으로 사용하지 않는다.
4. 앱 내 다른 업무로 이동하는 것과 새로고침/로그아웃/앱 종료는 다르다. 현재 메모리 큐는 후자의 복구를 보장하지 않는다.
5. 단말·파일 수/용량·각 구간 시간·성공/실패만 공유한다. 실제 사진·객실/사용자 식별자·토큰·Drive URL은 계측 로그에 넣지 않는다.

기존 5장 약35초와 추가1장 DB/Drive 표본은 배포 전 기준선이다. 배포 후 개선율을 추정하지 않는다.
실기기 HEIC/20장/저속망/null·409·응답 유실은 미검증이며, 안전한 병렬 업로드·썸네일은 #411 후속이다.
삭제 개발은 보류한다. 백업·복원·DB초기화는 이번 사진 최적화 배포에 포함하지 않았다.

## Rollback 및 승인 경계

직전 main `72771b5f7d87cc749ed57a845b9ecf8bf18aa290`/API44 소스로 api만 재배포하고
Swagger를 해당 명세로 다시 게시한다. 이전 API 소스와 static asset을 로컬 ignored 영역에 확보했다.
추가 Git source archive SHA256: `33a18a9554209a16f486ddb740ca0543b82df8be65fed2d2409aad195f128906`.
이는 코드 복구 자료이지 DB 백업이나 실제 복원 PASS가 아니다. 신규 SQL이 없어 DB rollback/history repair는 하지 않는다.
향후 어떤 migration/reset/재구축도 실행 전에 사용자에게 별도 승인받는다.

Refs #438, #411, #434, #436
