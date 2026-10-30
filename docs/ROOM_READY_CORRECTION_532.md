# #532 예약 가능 상태 정정과 청소 취소 확인

상태: **소스 구현·DB 없는 검증 완료 / 운영 미배포 / 전체 DB·경합 검증 NOT RUN**.
백엔드 [#532](https://github.com/wrongstory/room-management-system-backend/issues/532),
프런트 [#268](https://github.com/makee-ham/room-management-system/issues/268).
v1.0.0에 합칠 기능 수정이며 별도 채팅의 릴리스 실행기와 운영 데이터를 직접 변경하지 않는다.

## 사용자 확정 — 2026-10-30

카드에서 예약 가능으로 변경할 때 표시만 강제하지 않고 실제 현재 상태를 정합화한다.
청소 배정·진행·현장 완료·미승인 제출을 취소할 수 있지만, 서버가 영향 범위를 먼저 보여주고
관리자가 명시 확인해야 한다. 사진·수행/배정 이력·이미 확정된 수당은 보존한다.
취소하는 미승인 작업에서 새 수당을 생성하지 않는다.

팝업에 다음 안내를 생략하거나 자동 체크하지 않는다.

> 이 청소를 취소하면 해당 작업의 새 수당이 발생하지 않습니다.
> 지급해야 할 청소라면 취소하기 전에 검수·승인을 완료해 주세요.

`requiresEarningAcknowledgement=true`이면 수당 영향을 별도 확인하지 않고 취소를 확정하지 않는다.
청소 시작·현장 완료·제출 이력이 있는 경우 이 확인이 필수다. 검수 대상이면 검수 화면으로
이동할 수 있어야 한다. 기존 예약·실제 투숙을 이 팝업에서 일괄 취소/퇴실하지 않는다.
차단 이유를 보여주고 기존 예약 취소·퇴실 절차로 이동한다.

## 신고와 확인된 원인

142호에 READY 표시 override가 저장됐으나 현재 자동 퇴실 청소는 target `in_progress`,
attempt `field_completed`, 제출 0건으로 남아 있었다. checkout obligation은 `materialized`,
마감은 null이었다. 조회 당시 실제 예약 차단 사유는 없고 현재 준비 사유는 `CLEANING_REQUIRED`였다.
운영 읽기 전용 확인이며 위 값을 seed나 테스트 fixture로 복사하지 않는다.

2026-10-30 04:25/04:26 UTC DB 로그에서 `CLEANING_DUE_REPLAN_REQUIRED`를 확인했다.
문의 번호와 직접 연결된 로그는 없어 동일 요청의 오류라고 단정하지 않는다.
기존 `create_reservation_v2`는 새 예약을 넣은 뒤 이전 checkout 청소의 마감을 재계산한다.
이미 통보/진행된 청소의 마감이 바뀌면 `refresh_checkout_due_at`가 원자 rollback한다.
따라서 `intervalBookable=true`도 저장 성공을 보장하지 않는다.

프런트 main `36153cc6742c2559f76cb44a2981fb93228f5bed`,
dev `4c696841bca128356b506455042f30c179154d27`의 해당 흐름만 대조했다.
기존 `display-status-overrides`는 명세대로 표시값만 변경하며 전체 제품 snapshot은 갱신하지 않는다.
캡처의 일반 409 문구는 프런트 오류 코드별 안내가 없는 경우의 fallback이다.

## 후보 HTTP 계약

관리자 전용이며 최신 활성 계정·비밀번호 변경 완료·live session을 다시 검사한다.
응답은 `Cache-Control: no-store`다. 클라이언트가 권한이나 현재 업무 원장을 지정하지 않는다.

| 동작 | 경로 | 의미 |
|---|---|---|
| 영향 조회 | `POST /v1/rooms/{roomId}/ready-correction/preview` | 현재 해제 대상·차단 이유·수당 경고와 5분 확인 근거 |
| 확인 후 정정 | `POST /v1/rooms/{roomId}/ready-correction` | 같은 영향 범위가 유지될 때만 원자 취소·해제 |

공통 입력은 `targetStatus: READY`, `reasonCode: ADMIN_ROOM_READY_CORRECTION`이다.
200 응답의 `preview`는 `roomStateVersion`, `effects`, `blockingReasons`, `warnings`,
`requiresEarningAcknowledgement`, `impactFingerprint`, `evaluatedAt`, `expiresAt`를 반환한다.
예약/투숙, 미퇴실 사건, 미확인 기준정보 등 처리할 수 없는 사유가 있으면 `canApply=false`다.
진행 중 사진 전송은 완료 또는 안전한 종료 후 다시 조회한다. 사진 provider를 transaction 안에서 호출하지 않는다.
`ASSIGNMENT_CHANGE_PENDING`이면 먼저 기존 배정 변경 요청을 처리한다.
`UNSUPPORTED_CLEANING_CHAIN`은 재청소·검수/보상 연결 등 별도 업무 처리가 필요한 상태다.

commit은 `expectedRoomVersion`, 동일 fingerprint와 시각, `confirmed=true`를 요구한다.
`requiresEarningAcknowledgement=true`이면 `acknowledgeNoNewEarnings=true`, 촛불을 0으로 바꾸면
`confirmPhysicalCandleRemoval=true`도 필요하다. `Idempotency-Key`는 같은 요청 재시도에만 재사용한다.
서버가 미리보기와 실제 변경 사이의 시작·제출·검수·담당·객실 상태 변경을 다시 검사한다.
실패하면 일부만 변경하지 않는다. 응답 유실은 동일 key/payload로 처리한다.
200 응답의 `correction`에 새 객실 버전과 취소/해제한 ID 목록이 담긴다.

## 데이터와 후속 업무

- 현재 readiness에 영향을 주는 청소만 취소한다. 미래 예약의 예정 퇴실 청소를 함께 지우지 않는다.
- 자동 퇴실 target과 원천 obligation, 현재 assignment·수행/접근 권한을 같은 transaction에서 정리한다.
- 시작 전 수행은 superseded, 진행 중은 interrupted 이력을 남긴다. 현장 완료·제출의 원시각/내용은 유지한다.
- 종료 근거는 immutable `room.ready_corrected` 감사와 command receipt로 증명한다.
  단순 cancelled 표기만으로 모든 이전 수행을 무시하지 않는다.
- 승인/earning을 만들거나 기존 inspection·earning·payment·사진을 삭제하지 않는다.
- 취소된 완료 후 수행이 다음 예약의 청소 활성화를 계속 막지 않도록 정확한 정정 근거를 검사한다.
- 현재 운영 차단·입실 차단 이슈·촛불은 표시된 영향에 한해 확인 후 처리한다.
- 실제 상태에서 대표 카드 값을 다시 계산하도록 표시 override를 해제한다.
  미래 예약이 있으면 카드가 예약 상태로 보일 수 있다. READY 목표는 특정 미래 기간의 예약 성공 보장이 아니다.
- 기존 표시 전용 경로를 새로운 파괴적 취소 명령으로 바꾸지 않는다. 구버전 프런트의 READY 변경으로
  확인 없는 업무 취소가 발생하면 안 된다.

## 프런트 구현 인계

1. 실제 상태 변경에서는 서버 preview를 먼저 표시한다. 기존 고정 문구 확인창만 사용하지 않는다.
2. 각 청소의 단계·취소 내용·수당 미발생을 표시하고 검수·승인으로 이동할 경로를 제공한다.
3. 차단된 예약·투숙은 별도 절차로 안내한다. 확인 취소/닫기는 mutation을 보내지 않는다.
4. 변경 성공 후 객실 현재/선택 날짜 카드, 상세/이력, 배정·진행 목록, 예약 달력,
   예약 가능성 캐시를 다시 읽는다. 실패·stale에서는 카드만 성공한 것처럼 바꾸지 않는다.
5. `CLEANING_DUE_REPLAN_REQUIRED`와 `ROOM_READY_*`의 구체적 안내를 표시한다.
   만료/상태 변경은 새 preview 후 다시 확인하며 사용자의 확인을 자동 재사용하지 않는다.

## 검증 경계

DB 없는 Node/Edge 기능 검사, SQL 파싱·소스 계약, migration manifest, 독립 QA를 개발 단계에 수행한다.
SQL fixture는 합성 자료만 사용하며 준비와 실제 실행을 구분한다. 전체 DB/RLS/경합 검증과
운영 migration은 별도 승인 전 실행하지 않는다. 실제 결과는 아래 checkpoint에 기록한다.

### 현재 checkpoint

- 최신 dev `6ea4535e64051d1fb73fe6af0f5740e8f98e4658`에서 격리 작업 브랜치 생성.
- 운영 원인 조회와 프런트/백엔드 독립 조사 완료. 운영 mutation 없음.
- Fastify/Edge·공유 입력/응답 계약·Swagger 159 paths / 171 operations 구현 완료.
- `npm run typecheck`, `npm test -- --maxWorkers=2`(203 files / 5,479 tests), `npm run build`: PASS.
- `npm run edge:check`: PASS. 실제 API 번들 19,271,413 bytes, 후보 포함 진단 번들 19,937,114 bytes / 한도 20,000,000 bytes.
- `npm run db:manifest:verify`: PASS(138개, 새 source `room_ready_correction`). 이는 실제 DB 적용 검증이 아니다.
- PG15/17 외부 SQL 문법 파싱 및 소스 경계 검사 PASS. PL/pgSQL 실행·실제 SQL·경합은 NOT RUN.
- 독립 QA: 기능/권한/수당 보존 및 마지막 source·admission·catalog 보강 검토 PASS.
- Python ruff/format/mypy·pytest128·전체 source 임시 SDK 생성/roundtrip·package source check: PASS.
- 프런트 계약 검사·템플릿 생성·비밀 스캔·lint: PASS. lint는 error 0이며 warning/info가 남아 있다.
- CI/PR/dev 병합은 이 소스의 GitHub 기록을 따른다. 운영 반영·프런트 팝업 연결·사용자 UAT는 미완료.

## 릴리스 순서와 복구 경계

dev PR의 migration 검사는 manifest/source에 한정한다. v1.0.0 최종 통합 입력에서 사용자 승인 후
격리 전체 DB·SQL·경합 검증을 수행하고, 운영 적용 전 다시 승인을 받는다. 승인된 migration을 적용한
후 API/Swagger를 배포하고 프런트 #268의 확인 팝업을 연결한다. 기능 활성화 전 미배포 API를 호출하지 않는다.
문제가 생기면 새 정정 UI/호출을 중지하고 원인을 보완한다. 이미 확정된 취소를 되돌리기 위해 과거 감사·사진·
수당을 삭제하거나 완료 회차를 재활성화하지 않는다. 데이터 복구가 필요하면 별도 correction 절차를 검토한다.
