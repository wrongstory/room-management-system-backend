# Google Drive 사진 저장 운영안

> 상태: **확정 제품 정책 / #83 DB 작업 원장 구현 중, 실제 Drive 미연결**
> 사용자가 확정한 계약은 Google Drive 전용·300KiB 이하·비공개 저장과 `uploaded_at + 7 days` 영구삭제다. 7일 보존에는 검수 상태, 분쟁, retention hold 또는 180일 보존 예외를 두지 않는다. 구현 우선순위와 충돌 해결은 [백엔드 AI 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 따른다.

아래 압축·업로드·삭제 흐름과 용량 보호 기준은 구현 시 따라야 하는 운영 계약이다. Google Drive worker와 배포 자격증명은 아직 구현·설정 전이다.

## 저장 위치와 폴더

사진 원본·압축본은 Supabase Storage에 저장하지 않는다. 전용 Google 운영 계정이 소유한 비공개 루트 폴더 아래에 백엔드가 다음 구조를 만든다.

```text
room-management-system-photos/
└── YYYY-MM-DD/                 # KST 업로드 날짜
    └── {room_number}/          # 예: 701
        └── {attempt_id}_{slot_key}_{photo_id}.jpg
```

- 폴더명에는 메이드명·투숙객명 등 개인정보를 넣지 않는다.
- Google Drive API의 `files.create`와 `parents`를 사용해 각 파일의 부모 폴더를 하나만 지정한다.
- 폴더 ID는 서버가 캐시하되 이름만 신뢰하지 않고 루트 폴더 아래의 부모 관계를 검증한다.
- 파일은 공개 공유하지 않는다. 관리자·메이드의 열람은 API 인증과 권한 확인 후 서버 스트리밍으로 제공한다.

## 업로드 흐름

1. 프론트 앱이 카메라 사진의 방향을 보정하고 EXIF를 제거한다.
2. JPEG 또는 WebP 품질·해상도를 단계적으로 낮춰 **307,200바이트 이하**로 만든다.
3. 압축 결과가 제한을 넘으면 전송하지 않고 재촬영/재압축 안내를 표시한다.
4. API가 사용자 JWT, 청소 수행 회차, 사진 슬롯, 객실 접근 권한을 검증한다.
5. API는 본문 크기를 다시 검사하고 SHA-256을 계산한 뒤 Google Drive에 업로드한다.
6. 업로드 성공 후 Supabase에 파일 메타데이터와 `purge_after = uploaded_at + 7 days`를 기록한다.
7. DB 응답이 없으면 원자 확정의 성공 여부부터 작업 원장으로 재조회한다. 수락 이력이 있는 파일은 current 사진에서 빠졌거나 계정/session이 폐기돼도 보상 삭제하지 않는다. 미수락 candidate만 reconciliation fence로 finalize를 영구 차단한 뒤 보상 대상으로 삼는다. provider 결과가 불명확하면 삭제하지 않고 동일 object identity를 재조정한다.

브라우저에는 Google OAuth access token, refresh token, Drive 루트 폴더 ID를 주지 않는다. 서버는 앱이 생성·관리한 파일에 한정되는 `drive.file` 범위를 우선 사용한다.

## Supabase에 남기는 값

#30의 `private.attempt_photo_versions`와 `(attempt,target slot)` current pointer가 증빙 정본이다.
과거 `public.submission_photos`는 새 upload 경로로 사용하지 않고, 업로드를 위해 가짜 submission을 생성하지 않는다.
실제 제출은 #31의 canonical submission과 immutable photo-version binding을 사용한다.

#83의 개발 원장은 다음처럼 분리한다.

- `photo_upload_operations`: actor/attempt/assignment revision/slot/expected photo revision, 검증 metadata와 scoped key digest/request hash를 고정한다. 원문 key·session·body를 저장하지 않는다.
- `photo_provider_objects`: operation마다 서버 UUID 하나. provider locator는 private에만 두고 provider 내 전역 unique로 다른 작업에 재사용하지 못하게 한다. 최초 성공의 uploaded_at/purge_after는 불변이다.
- `photo_upload_states`: current state, worker claim digest, fencing version/expiry. claim identity는 safe projection에 반환하지 않는다.
- `photo_upload_acceptances`: object와 verified photo version의 영구 1:1 연결. replace/clear/인계/계정 폐기로 지우거나 고아로 재분류하지 않는다.
- `photo_upload_events`: state/fence 변경의 append-only 운영 이력. payload·provider locator를 복제하지 않는다.
- `photo_upload_rate_limits`: 기존 actor당 한 row의 포화 minute counter. 거부마다 새 row를 만들지 않는다.

모두 private/RLS이며 service role에도 직접 table 권한이 없다. 고정 search_path의 좁은 service-only RPC만 허용한다.
begin/claim/finalize/user 조회는 최신 role/status·Auth session·attempt ownership·capability를 검사한다.
내부 reconciliation은 이전 사용자 session이 사라져도 immutable accepted 사실을 확인할 수 있다.
제한 capability는 `upload_evidence`만 사용하며 사진 원본 read 권한을 추가하지 않는다.

### #83 내부 RPC와 후속 adapter 경계

`begin_photo_upload → claim_photo_upload → record_photo_provider_success → finalize_photo_upload`는
별도 짧은 transaction이다. 외부 HTTP는 그 사이에서 #84 서버 adapter가 수행한다.
`get_photo_upload`는 사용자 권한 기반 상태이며 `reconcile_photo_upload`는 worker의 내구성 확인·후보 retire command다.
`settle_photo_compensation`은 검증된 worker의 deleted/not_found 결과만 기록한다. 이번 source에 실제 DELETE 호출은 없다.

worker는 비밀 인증키가 아닌 서버 claim identity의 digest와 fence를 함께 전달한다. 유효 lease를 다른 claimant에게
공유하지 않고, 같은 claim retry만 동일 expiry를 반환한다. 만료 뒤 새 fence는 이전 지연 callback을 거부한다.
기술 상한은 slot당 provider 호출 가능한 in-flight 1건, actor당 같은 in-flight 8건, actor당 신규 operation 30/min,
lease 5분·최대 8회 claim이다. 이는 제품의 실행 2시간/증빙 24시간 capability를 연장하거나 대체하지 않는다.
상한 소진 뒤 자동 무한 재시도하지 않고 후속 worker의 관측·운영 개입 대상으로 남긴다.

`reserved`의 provider 결과가 unknown이면 `reconciliation_pending`이며 삭제 허가가 아니다.
known object와 accepted 부재를 확인하고 finalize를 차단하는 전이를 commit한 `compensation_pending`만
미수락 candidate 정리 대상이다. `accepted`는 영구 terminal이며 정당한 사진의 7일 purge는 #85가 별도로 수행한다.
소유권·사진 CAS 변경으로 finalize가 실패해도 provider 성공 기록과 identity를 보존하므로 다시 조회할 수 있다.

실제 magic bytes·EXIF·MIME·SHA·provider 성공 검증은 #84의 책임이다. #83 service-only RPC 입력을
client가 검증했다고 주장한 값으로 채우면 안 되며, 합성 metadata DB 테스트를 실파일 검증 PASS로 표현하지 않는다.
서버가 관측·검증한 최초 업로드 성공 시각을 retry/DB finalize 시각으로 교체하지 않고 정확히 168시간 뒤 만료시킨다.

## 7일 자동삭제

- 삭제 기준은 날짜 폴더명이 아니라 각 파일의 `uploaded_at + 7일`이다.
- 정리 작업은 최소 1시간마다 `purge_after <= now()`이며 `purged_at is null`인 행을 제한 수량으로 가져온다.
- Google Drive `files.delete`로 휴지통을 거치지 않고 영구삭제한다. 휴지통은 저장용량을 계속 차지할 수 있으므로 사용하지 않는다.
- 성공과 404(이미 없음)는 멱등 성공으로 처리하고 `upload_status = purged`, `purged_at`을 기록한다.
- 429·5xx·네트워크 오류는 지수 백오프와 jitter로 재시도하고, 반복 실패는 관리자에게 알린다.
- 파일이 모두 사라진 빈 객실 폴더와 날짜 폴더는 안전한 부모 ID 검증 후 정리한다.

## 용량 기준

300KiB와 7일 보관을 기준으로 한다.

| 시나리오 | 하루 사진 수 | 7일 최대 보관량 |
|---|---:|---:|
| 121개 객실 × 타입별 슬롯(합계) | 1,475장 | 약 3.17GB |
| 121개 객실 × 15장 | 1,815장 | 약 3.90GB |
| 15GB 이론상 상한 | 약 6,975장/일 | 15GB |
| 20% 여유를 둔 12GB 운영선 | 약 5,580장/일 | 12GB |

Google 계정의 기본 15GB는 Drive·Gmail·Google Photos가 공유한다. 사진 전용 운영 계정을 권장하며 전체 사용량 10GB에 경고, 12GB에 신규 업로드 차단과 관리자 알림을 적용한다. 삭제 작업이 지연되거나 다른 Google 서비스가 용량을 사용해도 남은 공간을 확보하기 위한 운영선이다.

## 필요한 배포 비밀값

```text
GOOGLE_DRIVE_CLIENT_ID
GOOGLE_DRIVE_CLIENT_SECRET
GOOGLE_DRIVE_REFRESH_TOKEN
GOOGLE_DRIVE_ROOT_FOLDER_ID
```

GitHub, 프론트 번들, 일반 로그에 값을 넣지 않는다. Codex의 Google Drive 연결은 개발 중 파일을 다루는 연결이며, 배포된 백엔드는 Google Cloud Console에서 발급한 별도 Drive API OAuth 자격증명을 사용해야 한다.

## 공식 근거

- [Google 계정 저장용량 정책](https://support.google.com/drive/answer/6374270?hl=ko)
- [Drive API 폴더 생성과 파일의 parents 지정](https://developers.google.com/workspace/drive/api/guides/folder)
- [Drive API 파일 업로드](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [Drive API 파일 영구삭제](https://developers.google.com/workspace/drive/api/guides/delete)
