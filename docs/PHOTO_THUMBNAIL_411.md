# #411 같은 사진 권한의 Drive 미리보기

2026-10-25 개발 후보. 운영 배포·실제 사진 조회·프런트 변경은 하지 않았다.

`GET /v1/photos/{photoId}/thumbnail`은 기존 content와 같은 active admin/본인 현재
회차 maid 및 live session을 사용한다. limited/developer 읽기는 거부한다. DB의
`authorize_photo_read`를 provider 호출 전후에 실행하고 동일 identity/hash/name/
retention을 확인한다. 권한 철회·만료 시 받은 bytes를 버린다. Range/query는 거부한다.

Drive의 output-only `thumbnailLink`를 인증된 `files.get`에서 새로 받는다. 원본
파일의 id/MIME/크기/실제 sha256Checksum/private/non-trashed 및 version과
thumbnailVersion을 확인하고, 읽기 뒤 metadata를 다시 확인한다. checksum이 없거나
미리보기가 없으면 원본을 대신 내려받지 않는다. 반환은 JPEG 최대64KiB/가로세로512px,
APP1(EXIF/XMP)·APP13(IPTC)·COM 및 tail을 거부하는 envelope다. APP2 등 모든
metadata 영역을 금지하는 검사는 아니다. 원본 decode/재인코딩과 별도 파생 객체/보존 clock은 없다.

공식 근거: [Drive File thumbnailLink](https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File).
비공개 파일은 credentialed request가 필요하며 웹 직접 사용 대신 proxy를 사용할 수 있다.
썸네일이 항상 존재하거나 특정 규격으로 생성된다고 보장하지는 않는다.

보안 경계는 `https://lh3.googleusercontent.com`의 정확한 origin만 허용한다. 이는 현재
구현의 보수적인 provider 호환 범위이며 다른 호스트 지원은 검토 후 추가한다.
userinfo/비표준 port/fragment/redirect는 거부하고 링크를 변형하거나 외부 URL 입력을 받지 않는다.
URL/token/Drive ID/원문 오류·header는 응답/로그/영구 저장에 전달하지 않는다.
OAuth token cache는 기존 provider 계약이며 사진 권한·URL·bytes cache는 만들지 않는다.

기존 원본 객체의 미리보기이므로 새 파일·복사·공유·보존 연장·삭제 worker 변경이 없다.
원본 정책에 따른 만료/삭제는 공통 DB 권한 경계에서 즉시 차단한다. 사진 purge 활성화
보류는 유지한다. provider 내부 캐시의 물리 제거를 이 API가 증명한다고 주장하지 않는다.

## 호출과 검증

- 성공: image/jpeg, Cache-Control:no-store, nosniff, 고정 thumbnail.jpg, 숫자 timing.
- provider 미지원/미생성·변조·장애: 503 PHOTO_THUMBNAIL_UNAVAILABLE.
- 프런트는 이 오류일 때 기존 content를 별도 요청할 수 있다. 자동 원본 전송/업로드
  재시도는 하지 않는다. 확대는 기존 content다. 프런트 연결은 이 백엔드 PR에 포함하지 않는다.
- Node/Edge 공통 원본 및 OpenAPI155 paths/167 operations의 추가 계약이다.
- 전체 ci:quality133파일3314 tests/typecheck/build PASS. 독립 QA 관련4파일222 tests
  및 권한·provider·동일객체/보존 경계 검토 PASS. 최초 combined route union 타입 오류는
  두 discriminant로 분리하여 해소했다.
- Edge 전체 PASS, 실제 후보 bundle19,829,290bytes. 최초 manifest·생성 OpenAPI drift는
  원본 generator 재실행 뒤 해결했다. 생성물을 수작업 수정하지 않았다.
- Python 전체 source 임시 codegen/compile PASS(기존 AttemptLifecycleRequest 모델 중복
  경고 유지). 최초 의존성 설치의 Windows hardlink 실패는 copy mode로 해결했다.
- 실제 Drive thumbnail/private access/최대 크기·cold/warm1/5/20장 성능/UAT NOT RUN.
  metadata 왕복이 추가되므로 byte 감소를 지연 개선으로 환산하지 않는다.

안전한 동일 collection 다중 업로드는 별도 #411 작업이다. 이 읽기 API가 collection-wide
CAS/inflight 계약이나 업로드/삭제/제출 경합을 변경하지 않는다.
