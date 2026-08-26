# Google Drive 사진 저장 운영안

> 상태: **7일 보존 대안의 기술 초안 — 제품 정책 미확정**
> Google Drive 전용·300KiB 이하·비공개 저장 방향은 유지한다. 그러나 `업로드 후 7일`은 제품 정본의 `종결 후 180일 + hold, orphan 30일`과 충돌한다. 비용·증빙·개인정보 파기 기준이 확정되기 전에는 이 문서의 7일 purge를 배포하지 않는다. 자세한 우선순위는 [백엔드 AI 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 따른다.

아래 용량 계산과 삭제 흐름은 7일 대안을 비교하기 위한 자료이지 승인된 최종 보존 계약이 아니다.

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
7. DB 기록이 실패하면 방금 만든 Drive 파일을 보상 삭제하고, 실패 시 고아 파일 정리 큐에 기록한다.

브라우저에는 Google OAuth access token, refresh token, Drive 루트 폴더 ID를 주지 않는다. 서버는 앱이 생성·관리한 파일에 한정되는 `drive.file` 범위를 우선 사용한다.

## Supabase에 남기는 값

`submission_photos`에는 파일 자체가 아닌 다음 값만 저장한다.

- 제출 ID, 사진 슬롯 키, 증빙 종류
- `drive_file_id`, `drive_folder_id`, 서버 생성 파일명
- SHA-256, MIME, 실제 바이트 수, 가로·세로
- 촬영·업로드 시각, 삭제예정일, 영구삭제 완료시각
- 삭제 시도 횟수, 마지막 오류 코드, 업로드/삭제 상태

브라우저 역할에는 이 테이블의 직접 권한을 주지 않는다. API가 사용자 JWT와 RLS 대상 업무 데이터를 확인한 뒤 필요한 결과만 반환하며, 생성·상태변경·삭제 기록은 백엔드 서버 역할만 쓴다.

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
