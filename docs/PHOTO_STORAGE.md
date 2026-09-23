# Google Drive 사진 저장 운영안

> 상태: **기존 #83·#84·#85·#31 production 기록 / Issue #9 Stage 1 도메인별 retention v2 63번째 migration·API source 후보 구현 / 실제 Drive 자격증명·provider/Cron smoke 미완료**
> 최신 확정 계약은 Google Drive 전용·300KiB 이하·비공개 저장을 유지하되, 청소 제출은 최종 검사 결정+168시간, 이슈·컴플레인·중단/충돌 증빙은 해결·종결+180일, 진짜 orphan은 업로드+30일에 삭제한다. 아래 `uploaded_at + 7 days` 절은 현재 배포된 legacy 구현을 설명하는 기록이며 목표 정책이 아니다. 구현 우선순위와 충돌 해결은 [백엔드 AI 제품·도메인 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 따른다.

아래 압축·업로드 흐름과 용량 보호 기준은 유지한다. #84의 Drive HTTP adapter와 업로드·열람 API, #85의 legacy 7일 purge worker source 및 Edge bundle은 production에 반영됐다. Issue #9 Stage 1 candidate는 별도 private retention record/link, 권한 projection, late-binding fence와 기존 purge worker의 authoritative expiry 전환을 추가한다. 아직 source/dev 통합·운영 OAuth·Google provider hosted smoke·주기 실행 활성화는 미완료이므로 production 사용 가능으로 표시하지 않는다.

#83은 [PR #86](https://github.com/wrongstory/room-management-system-backend/pull/86)의 독립 QA·required CI·
Codex 96/100 승인 후 `dev@cf91753de8b80ce5abef3c8dc0aa8bf5e85b479b`에 병합됐다.
#83 당시에는 31 migrations / 63 paths / 68 operations이며 공개 업로드·열람 route를 추가하지 않았다.
후속 [PR #88](https://github.com/wrongstory/room-management-system-backend/pull/88)의 #84 source도 독립 QA·required CI·source 승인 후
`dev@520abe7b80501ed9a4573e2251b9b640476d87b5`에 병합됐다. 이어 #85는 PR #90으로
`dev@92c0f97b412e9a4ccf41934b6924bc59ca2f9dd2`에 병합됐다. 이 개발 통합은 **33 migrations / 67 paths / 72 operations**이며,
사진 슬롯·업로드·작업 상태·원본 열람과 accepted 168시간 purge, never-accepted orphan 보상, 빈 room/date 폴더 retirement source가 완료됐다.
PR #91로 #31 전체 제출·검수·반려 재청소까지 `dev@f22005d8af6087a3bbab215c76cf7cc7e45b49fb`에 병합됐다. 당시 개발 정본은 **34 migrations / 74 paths / 80 operations**였다. 2026-09-16 production 정본은 56 migrations / OpenAPI 109 paths / 117 operations이고 관련 API 및 `photo-purge` bundle source가 반영됐다. 다만 실제 Google 환경은 아직 활성화하지 않았다.
상세 exact head·동일 tree·CI 재실행 및 source/dev 승인 증거는 [API 상태 정본의 #83/#84/#85/#31 gate](./API_STATUS_MATRIX.md)를 따른다.

## 저장 위치와 폴더

사진 원본·압축본은 Supabase Storage에 저장하지 않는다. 전용 Google 운영 계정이 소유한 비공개 루트 폴더 아래에 백엔드가 다음 구조를 만든다.

```text
room-management-system-photos/
└── YYYY-MM-DD/                 # KST 업로드 날짜
    └── {room_number}/          # 예: 701
        └── {object_id}.jpg      # 서버가 예약한 opaque app object UUID; WebP는 .webp
```

- 폴더명에는 메이드명·투숙객명 등 개인정보를 넣지 않는다.
- Google Drive API의 `files.create`와 `parents`를 사용해 각 파일의 부모 폴더를 하나만 지정한다.
- 날짜/객실 폴더는 private DB registry의 unique scope가 사전발급 ID 중 winner 하나를 고정한다. cold worker도 그 ID만 create/409 검증하며 이름 검색이나 instance cache로 중복 방지를 대체하지 않는다. loser candidate ID는 create하지 않는다.
- 파일은 공개 공유하지 않는다. 관리자·메이드의 열람은 API 인증과 권한 확인 후 서버 스트리밍으로 제공한다.

## 업로드 흐름

1. 프론트 앱은 스마트폰 원본 JPEG/WebP/HEIC/HEIF를 raw body로 전송한다. 사전 축소는 선택 사항이고 기존 300KiB 상한으로 원본을 거부하지 않는다.
2. 서버는 입력 5MiB, 12MP/5000px 기술상한을 검사하고 decode·방향 보정·metadata 제거·축소/재인코딩으로 JPEG/WebP **307,200바이트 이하**를 만든다.
   - Android Motion Photo JPEG는 공식 Camera/Container XMP와 끝까지 유효한 MP4/MOV tail이 함께 확인될 때만 정지 JPEG 구간을 decode한다. 영상 tail과 XMP는 저장하지 않으며, 표식 없는 trailing bytes/polyglot은 계속 거절한다.
3. 원본이 입력 기술상한을 넘거나 300KiB 출력을 만들 수 없으면 명확한 크기/처리 오류로 거부한다. 이 경우 앱에서 원본 축소 또는 재촬영을 안내한다.
4. API가 사용자 JWT, 청소 수행 회차, 사진 슬롯, 객실 접근 권한을 검증한다.
5. API는 정규화된 출력의 SHA-256을 계산한 뒤 Google Drive에 업로드한다. 원본 bytes는 Drive에 저장하지 않는다.
6. 업로드 성공 후 Supabase에 파일 메타데이터와 retention policy를 기록한다. 청소 제출은 최종 검사 전 `expiresAt`을 확정하지 않고 결정 시각을 anchor로 삼으며, 사건 증빙과 진짜 orphan은 각각 해결/종결 또는 업로드 시각을 anchor로 사용한다. 현재 배포 source가 쓰는 `purge_after = uploaded_at + 7 days`는 아래 legacy 절에 별도 기록한다.
7. DB 응답이 없으면 원자 확정의 성공 여부부터 작업 원장으로 재조회한다. 수락 이력이 있는 파일은 current 사진에서 빠졌거나 계정/session이 폐기돼도 보상 삭제하지 않는다. 미수락 candidate만 reconciliation fence로 finalize를 영구 차단한 뒤 보상 대상으로 삼는다. provider 결과가 불명확하면 삭제하지 않고 동일 object identity를 재조정한다.

v8 checkout의 선택 `extra-proof`만 별도 collection 경로를 사용한다. client가 만든 안정적 item UUID에 collection/item expected revision을 함께 보내며, append는 새 UUID와 item revision 0, replace는 기존 UUID와 현재 item revision을 사용한다. 활성 item은 최대 10개이고 개별 삭제는 tombstone 이력만 추가한다. 삭제·교체는 accepted 파일의 immutable retention 원장을 지우거나 즉시 provider 삭제하지 않으며, 일반 slot과 pre-A snapshot은 기존 단일 사진 경로를 계속 사용한다.

브라우저에는 Google OAuth access token, refresh token, Drive 루트 폴더 ID를 주지 않는다. 서버는 앱이 생성·관리한 파일에 한정되는 `drive.file` 범위를 우선 사용한다.

### #84 실제 adapter와 운영 전 gate

공통 `src/modules/photos` validator/provider/service를 Fastify가 사용하고, `scripts/generate-photo-edge.mjs`가 좁은 Deno bridge를 생성한다.
Edge의 업로드/슬롯/상태는 valid Auth+현재 profile+session 후 DB의 exact own attempt/upload_evidence를 재검증한다.
목표 원본 proxy는 active·권한 있는 admin과 해당 사진의 실제 수행 maid가 만료 전 접근하도록 하며, 다른 maid에게는 허용하지 않는다. limited upload capability 자체는 원본 read 권한을 추가하지 않는다. 현재 source의 current-assignment-only maid 검사는 후속 retention PR의 권한 변경 대상이다.

1. `admit_photo_upload`는 decode 전 현재 권한·slot in-flight·actor 30/min/8 in-flight·총quota를 검증하고 최종 저장물 최대307200 bytes를5분 예약한다.
2. 원문 stream의5MiB 초과 byte를 취소한다. MIME/magic만으로 성공하지 않고 JPEG/WebP/HEIC/HEIF decode → 방향 보정/EXIF 등 제거 → JPEG/WebP 출력 decode/size/finalSHA를 검증한다.
3. provider quota는 `about.storageQuota.usage`의60초 이내 snapshot과 앱 미정산 예약량으로 판단한다. decimal10GB 경고/12GB 차단이며 외부 Gmail/Photos 증가와 완전 원자적인 절대 용량 보장은 아니다.
4. Drive `generateIds`의 파일 ID와 검증된 부모 폴더를 DB에 먼저 고정한다. timeout/409는 **같은 ID**의 부모/MIME/size/실제 SHA만 확인한다. `appProperties` 자체 hash는 증거가 아니며 provider checksum이 없으면 bounded download+서버SHA로 대조한다.
5. `uploadedAt`은 검증된 Google immutable `createdTime`이다. create 요청에서 이를 지정하지 않으며 DB operation 생성시각≤createdTime≤관측now를 검증한다. 응답 유실은 같은 metadata의 clock을 재사용하고 기존 DB clock을 변경하지 않는다. KST 폴더 날짜와 생성 날짜가 자정 경합으로 다르면 finalize를 거부하고 known candidate만 fenced compensation으로 처리한다. move/rebind하지 않는다.
6. finalize 응답 유실 시 accepted 원장을 재조회한다. unknown은 삭제하지 않고 같은 사전발급 identity를 read-only 검증한 후 retire fence를 얻는다. accepted는 계정/session 폐기나 current clear와 무관하게 보상 삭제하지 않는다.
7. read는 bounded download/해시 확인 후 응답 첫 byte 직전에 session, **사진을 실제 생성한 performer maid** 또는 관리자 권한, 정책별 `expiresAt`, `mediaAvailability`를 다시 확인한다. current assignment 변경은 과거 performer의 만료 전 접근을 제거하지 않는다. redirect·Range·공개URL·Drive header 전달은 없고 no-store/nosniff/고정 filename만 반환한다.

source/dev 검증을 마친 decoder는 pinned `@imagemagick/magick-wasm@0.0.43`이며 Node는 npm, Edge는 검증된 JS glue+gzip WASM 단일 자산을 사용한다.
`node scripts/generate-photo-edge.mjs`로 생성하고 `--check`로 원본/생성물 drift를 검사한다. compressed/uncompressed SHA-256과 크기는 스크립트에 고정하며 NOTICE를 함께 복사한다.
gzip은 `scripts/photo-gzip.mjs`에서 optional header를 금지하고 mtime=0/OS=255로 정규화한다. Windows Node22.20과 Linux Node22.23.2는 같은 DEFLATE payload에도 OS header가10/3으로 달라졌으므로 이 비결정 metadata만 제거한다. 원본 WASM hash와 전체 canonical gzip hash(5,269,861 bytes)는 계속 고정하며 압축 알고리즘·payload·CRC 변경은 checksum 실패로 차단한다. runtime도 같은 canonical hash를 요구하고 CDN/다른 hash fallback은 없다.
자산은 Git ignored 생성물이므로 **배포 전 `npm ci` → `npm run edge:check` 성공이 필수**다. 이 과정에서 pinned asset 재생성/양쪽 SHA·크기/정본 drift 검증이 실패하거나 자산이 없으면 배포하지 않는다. runtime CDN fallback은 없다.
최신 source/NOTICE/checksum 포함 재현값은 **15,149,558 bytes(약14.45MiB)**다. `npm run edge:check`는 pinned `edge-runtime:v1.74.3@sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c`의 cwd `/workspace/supabase/functions`에서 `bundle --entrypoint api/index.ts --static api/assets/magick.wasm.gz --static api/assets/magick.NOTICE --output <검증된 .tmp 절대경로>/api.eszip --checksum sha256 --timeout 60`을 실행하고 보수적으로20,000,000 bytes 미만을 강제한다. config는 source `deno.json`을 사용하며 npm package 전체 WASM이나 runtime CDN을 묶지 않는다. `assets/*`는 금지하며 static은 gzip+NOTICE 두 파일만 허용한다. 임시 output은 성공/실패 모두 정확한 생성 디렉터리만 검증 후 정리한다. fmt 검사만 LF 임시사본을 사용하며 실제 source check/test/bundle은 원본을 사용한다.
실제 local Edge runtime v1.74.3 oneshot worker(memory256MB/CPU2000ms)의 합성 cold-start는1280×960 JPEG207ms/51.9MB, WebP391ms/49.0MB, 2048×2048 JPEG345ms/66.4MB, WebP1016ms/79.8MB로 모두HTTP200/accepted, EarlyDrop, exceeded=false였다. 이는 실제 worker의 합성 검증이며 운영 Google/hosted smoke는 release 후 별도 gate다.
입력 5MiB·12MP/5000px, 출력 300KiB, decoder 자원 상한은 source 기술상한이다. 기존 합성 4MP Edge 검증은 이 변경의 12MP/HEIC hosted 검증을 대신하지 않는다. 실제 스마트폰 촬영 fixture와 hosted Edge/Google 검증을 release gate에서 수행한다.
업로드 응답은 initial/retry 모두 `quotaWarning:boolean`만 노출한다. #85 feature는 장기 admission SUM 대신 bounded pending projection을 사용하지만, 외부 Gmail/Photos 사용량과의 원자적 보장을 주장하지 않는다.

실제 운영 OAuth/Google 호출·배포·#85 purge schedule 활성화·#31 전체 제출/검수 hosted smoke는 이번 source/dev 작업에서 하지 않았다.

운영자는 developer `runtime-status.configuration`의 `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` / `GOOGLE_DRIVE_REFRESH_TOKEN` / `GOOGLE_DRIVE_ROOT_FOLDER_ID` 각각의 `configured:boolean`만 확인한다. 하나라도 false면 provider 준비 완료로 판단하지 않는다. true는 값 존재 여부일 뿐 Google 인증·권한·실제 업로드 검증을 대체하지 않는다. 값·길이·hash·전체 환경변수는 응답하지 않는다.

## Supabase에 남기는 값

#30의 `private.attempt_photo_versions`와 일반 slot의 `(attempt,target slot)` current pointer, #180 `extra-proof`의 collection state/item/change 원장이 증빙 정본이다.
과거 `public.submission_photos`는 새 upload 경로로 사용하지 않고, 업로드를 위해 가짜 submission을 생성하지 않는다.
실제 제출은 #31의 canonical submission과 immutable photo-version binding을 사용한다.

#83에서 source/dev 완료한 원장은 다음처럼 분리한다. 운영 반영은 별도 release/main gate다.

- `photo_upload_operations`: actor/attempt/assignment revision/slot/expected photo revision, 검증 metadata와 scoped key digest/request hash를 고정한다. 원문 key·session·body를 저장하지 않는다.
- collection upload operation은 같은 원장에 stable item UUID와 expected collection/item revision을 추가하며 `photo.collection.upload`로 ordinary upload와 명확히 분리한다. 개별 삭제는 별도 immutable command receipt가 같은-key replay와 다른-payload 충돌을 구분한다.
- `photo_provider_objects`: operation마다 서버 UUID 하나. provider locator는 private에만 두고 provider 내 전역 unique로 다른 작업에 재사용하지 못하게 한다. 최초 성공의 `uploaded_at`은 불변이다. `purge_after`는 legacy 이력 호환 컬럼이며 Stage 1 이후 runtime 판단은 `photo_retention_records.expires_at/media_availability`만 사용한다.
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
`settle_photo_compensation`은 검증된 worker의 deleted/not_found 결과만 기록한다. #83 자체에는 실제 DELETE 호출이 없었고,
#84는 admission-bound wrapper와 Drive adapter를 통해 미수락 candidate의 fenced compensation만 구현했다.
#85 legacy accepted 7일 purge worker는 candidate 보상과 별도 원장·권한으로 구현되어 production source/bundle에 반영됐다. Issue #9 Stage 1 candidate는 같은 worker를 도메인별 authoritative expiry와 late-binding CAS/fence에 연결한다. Google hosted purge smoke와 Cron 활성화는 미완료이며, candidate 보상 삭제를 accepted 보존 만료로 간주하지 않는다.

worker는 비밀 인증키가 아닌 서버 claim identity의 digest와 fence를 함께 전달한다. 유효 lease를 다른 claimant에게
공유하지 않고, 같은 claim retry만 동일 expiry를 반환한다. 만료 뒤 새 fence는 이전 지연 callback을 거부한다.
기술 상한은 slot당 provider 호출 가능한 in-flight 1건, actor당 같은 in-flight 8건, actor당 신규 operation 30/min,
lease 5분·최대 8회 claim이다. 이는 제품의 실행 2시간/증빙 24시간 capability를 연장하거나 대체하지 않는다.
상한 소진 뒤 자동 무한 재시도하지 않고 후속 worker의 관측·운영 개입 대상으로 남긴다.

`reserved`의 provider 결과가 unknown이면 `reconciliation_pending`이며 삭제 허가가 아니다.
known object와 accepted 부재를 확인하고 finalize를 차단하는 전이를 commit한 `compensation_pending`만
미수락 candidate 정리 대상이다. `accepted`는 upload acceptance 관점의 영구 terminal이며, 정당한 사진의 삭제 시각은 후속 도메인별 retention authority가 결정한다. 현재 #85 accepted 원장은 legacy 업로드+7일을 사용한다.
소유권·사진 CAS 변경으로 finalize가 실패해도 provider 성공 기록과 identity를 보존하므로 다시 조회할 수 있다.

실제 magic bytes·EXIF·MIME·SHA·provider 성공 검증은 #84의 책임이다. #83 service-only RPC 입력을
client가 검증했다고 주장한 값으로 채우면 안 되며, 합성 metadata DB 테스트를 실파일 검증 PASS로 표현하지 않는다.
서버가 관측·검증한 최초 업로드 성공 시각을 retry/DB finalize 시각으로 교체하지 않는다. 이 시각은 true orphan의 30일 anchor가 될 수 있지만, 청소 제출은 최종 검사 결정, 사건 증빙은 해결·종결 시각을 별도 authoritative anchor로 사용한다.

## Legacy production source: 업로드 기준 7일 자동삭제

이 절은 새 append-only retention migration 전 production worker 동작의 이력이다. 63번째 source candidate는 이미 accepted된 업무 이력을 삭제·변환하지 않고 도메인별 기산점과 `mediaAvailability`를 별도 원장에 추가한다.

## Stage 1 source candidate: 도메인별 retention v2

- `private.photo_retention_records`는 object별 effective policy, performer, 기산·만료·삭제 시각과 media availability를 보존한다. `photo_retention_links`는 실제 존재하는 cleaning submission/complaint/interruption/offline resolution만 typed wrapper로 연결한다.
- final inspection 전 cleaning evidence는 `expiresAt=NULL`이고 승인·반려의 immutable `decided_at + 168 hours`에 만료된다. complaint는 immutable closed event, interruption은 admin handover event, sync conflict는 server-owned resolution timestamp를 사용한다.
- 대응 domain source가 아직 없는 `room_issue`는 schema-ready enum일 뿐 API/hosted 완료가 아니다. unsupported kind/entity와 generic caller는 fail-closed하며 helper EXECUTE는 service role까지 revoke한다.
- accepted지만 아직 domain link가 없는 true orphan만 provider `uploadedAt + 30 days`다. claim 직전 authoritative retention을 다시 계산하고 provider DELETE 직전 exact object/fence/claim/expiry permit을 DB에 영구 기록한다. link가 먼저 공통 barrier를 획득하면 claim을 무효화하며, permit이 먼저 확정되면 이후 link는 fail-closed한다. uncertain DELETE 뒤에도 permit barrier를 보존한다. unchanged clock은 claim/retry/operator-blocked 상태를 보존하고 blocked를 자동 resume하지 않는다.
- submission evidence 수명은 mutable current pointer와 분리한다. 과거 approved/rejected submission도 자신의 `decidedAt + 168 hours`까지 active link이며, superseded됐지만 final decision이 없는 submission은 임의 orphan clock으로 축소하지 않고 `expiresAt=NULL`로 보존한다.
- metadata는 purge 뒤에도 남고 `mediaAvailability=purged`가 된다. 이미 purged evidence를 available로 되살리지 않는다.

- 삭제 기준은 날짜 폴더명이 아니라 각 파일의 `uploaded_at + 7일`이다.
- 정리 작업은 최소 1시간마다 `purge_after <= now()`이며 `purged_at is null`인 행을 제한 수량으로 가져온다.
- Google Drive `files.delete`로 휴지통을 거치지 않고 영구삭제한다. 휴지통은 저장용량을 계속 차지할 수 있으므로 사용하지 않는다.
- 성공과 404(이미 없음)는 멱등 성공으로 처리하고 `upload_status = purged`, `purged_at`을 기록한다.
- 429·5xx·네트워크 오류는 지수 백오프와 jitter로 재시도하고, 반복 실패는 관리자에게 알린다.
- 파일이 모두 사라진 빈 객실 폴더와 날짜 폴더는 안전한 부모 ID 검증 후 정리한다.

## Legacy 7일 용량 참고와 현재 운영선

아래 표는 300KiB와 legacy 업로드+7일을 가정한 과거 참고값이다. 검수 대기와 180일 증빙을 포함하는 최신 정책의 최대 사용량으로 재사용하지 않는다. 새 retention 구현은 실제 종류별 유입량·검수 지연·증빙 종결량을 관측하고 기존 10GB 경고/12GB 업로드 차단 운영선을 별도로 유지한다.

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
