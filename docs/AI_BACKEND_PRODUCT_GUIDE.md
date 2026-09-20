# 백엔드 GPT/Codex 제품·구현 가이드

이 문서는 프런트엔드 저장소, 과거 대화, 현장 설명을 볼 수 없는 백엔드 담당 AI가 제품 의도를 추측하지 않고 구현하도록 만든 **저장소 내부 제품 계약**이다.

검토 기준:

- 이 문서 갱신의 release source 기준: `dev@9c197ad12ed5cb45db0b451f69f9f91053b139d7` — 73 migrations / OpenAPI 120 paths / 130 operations.
- Issue #169의 초기 4자리 PIN 자동 생성·관리자 제한 열람·물리 확인 계약은 PR #219로 `dev`에 통합되고 PR #221로 `main`에 승격됐다. production DB/API source에도 포함됐지만 실제 PIN bootstrap·물리 확인 mutation은 별도 운영 승인 전까지 미실행이다.
- 백엔드 저장소와 직접 검증한 production 배포 source는 `main@80f935016d5581d500136fba29c206f6ee797bc0`이다. production은 73 migrations, `api` ACTIVE v17, OpenAPI `0.4.0` 120 paths / 130 operations이며 공개 Health/OpenAPI smoke를 통과했다.
- 프런트엔드 정본 저장소: `wrongstory/room-management-system`
- 프런트엔드 제품·운영 연결 snapshot: `dev@165fed2d62a763d64ac62539e1475c1b3e42868f` (`기능: 운영 API 연결을 완성하라`).
- 프런트엔드 현재 원격 `main`: `afeb0898879bf8d381ee2e218938dc3160fd6ac0`. 별도 영향 대조 전에는 위 snapshot의 후속 정본으로 자동 승격하지 않는다.
- 기준일: 2026-09-20 KST

프런트엔드는 단일 HTML 중심의 고충실도 업무 시뮬레이터이며 기준 snapshot은 운영 API를 실제 소비한다. 화면 객체, fixture, dead code를 그대로 실제 API나 테이블로 옮기지 않는다.

---

## 1. 읽는 법과 정책 우선순위

요구사항이 충돌할 때 다음 순서로 판단한다.

1. 현재 작업에서 사용자가 명시한 결정
2. 이 문서의 `[확정]` 항목
3. 이 문서가 인용한 최신 프런트엔드 정본 정책
4. `docs/ERD.md`, `docs/room-management-system.dbml`, `docs/ARCHITECTURE.md`의 설계 초안
5. `docs/PROJECT_ANALYSIS.md`의 분석 snapshot
6. 현재 migration과 구현 코드

현재 SQL이나 API가 이 문서와 다르면 **코드가 곧 정책이라는 뜻이 아니다.** 차이를 기술 부채로 기록하고, 기존 운영 데이터에 미칠 영향을 확인한 migration으로 고친다.

이 가이드는 아래 프런트엔드의 고정 정책 snapshot과 최신 상호작용 snapshot을 함께 참조하는 저장소 내부 정본이다. 같은 snapshot의 인용 문서와 `[확정]` 문장이 충돌하면 위 순위를 기계적으로 적용해 가이드 문장을 정당화하지 않는다. 가이드 오류 또는 아직 해소되지 않은 기획 충돌로 기록하고, 되돌리기 어려운 구현은 수정·질문 전까지 멈춘다. ERD/DBML은 `review draft`이므로 이 가이드와 reconciliation되기 전에는 목표 계약이나 완성 체크리스트로 사용하지 않는다.

### 고정한 프런트엔드 근거

| 범위 | 고정 문서 |
|---|---|
| 객실 PIN·사진 이력 | [`DOCS/19`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/19_ROOM_PIN_SHEET_CLEANING_HISTORY_DECISIONS.md) |
| 가능일·배정·이월·폭탄방·주급 | [`DOCS/16`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/16_WEEKLY_AVAILABILITY_ASSIGNMENT_POLICY.md) |
| 객실 마스터·점유·장기 투숙 | [`DOCS/17`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/17_ROOM_CATALOG_LONG_STAY_DECISIONS.md) |
| 전체 도메인 안전 규칙 | [`FINAL_UX_AUDIT`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/FINAL_UX_AUDIT.md) |
| 클릭형 와이어프레임 인계 | [`DOCS/14`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/14_CLICKABLE_WIREFRAME_HANDOFF.md) |
| 예약·객실 이동 | [`DOCS/24`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/24_RESERVATION_ARRIVAL_ROOM_MOVE_BACKEND_HANDOFF.md) |
| 청소 API 연동 | [`DOCS/23`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/23_CLEANING_API_INTEGRATION.md) |
| 운영 API·PWA 연동 | [`DOCS/21`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/21_PRODUCTION_API_PWA_INTEGRATION.md) |
| 상호작용 설명 | [`WIREFRAME/README`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/WIREFRAME/README.md) |
| 상호작용 QA | [`WIREFRAME/QA`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/WIREFRAME/QA.md) |
| 상호작용 source | [`WIREFRAME/index.html`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/WIREFRAME/index.html) |
| 와이어프레임 작업 인계 | [`WIREFRAME_TASK_PROMPT`](https://github.com/wrongstory/room-management-system/blob/165fed2d62a763d64ac62539e1475c1b3e42868f/DOCS/WIREFRAME_TASK_PROMPT.md) |

이 snapshot 안의 충돌 우선순위는 `현재 사용자의 명시적 결정 → DOCS/19 객실 PIN·청소 사진 → DOCS/16 배정 → DOCS/17 객실·점유 → FINAL_UX_AUDIT → DOCS/24 예약·객실 이동 → 나머지 최신 인계 문서 → 과거 백엔드 가정`이다. 따라서 `DOCS/14` 등에 남은 `availableFrom` 이후 PIN 접근 문구는 DOCS/19와 2026-09-17 사용자 결정으로 대체한다.

2026-09-17 재대조 결과, `dev@165fed2`가 이번 백엔드 정합화의 exact 프런트 snapshot이다. 객실 대표 상태와 체크인 전·투숙 중 객실 이동은 백엔드 `dev`에 이미 구현돼 중복 개발하지 않는다. 사진 보존은 Issue #9 Stage 1의 63번째 append-only migration/API 후보에서 아래 확정 계약을 구현하며, source/dev 통합과 production Google/Cron 활성화는 별도 gate다. maid PIN 접근 수명주기는 별도 후속이다. 자세한 해결/미해결 표는 [프런트엔드 계약 snapshot](./FRONTEND_CONTRACT_SNAPSHOT.md)을 따른다.

현재 사용자는 과거의 “모든 사진을 업로드 후 7일에 삭제” 결정을 대체했다. 청소 제출 사진은 최종 검사 결정 전 보존하고 결정 시각부터 정확히 168시간 뒤 삭제한다. 이슈·컴플레인·중단/동기화 충돌 증빙은 해결·종결 후 180일, 진짜 orphan은 업로드 후 30일이다. 이미 삭제된 원본을 복구됐다고 표시하지 않으며 metadata는 영구 보존한다.

프런트엔드 기준 commit을 바꾸면 관련 범위의 가이드, 알려진 충돌, 테스트 계약을 같은 PR에서 다시 대조한다.

표시의 의미:

- `[확정]`: 구현해도 되는 제품 규칙
- `[미확정]`: 사용자의 결정 없이 한쪽으로 고정하면 안 되는 규칙
- `[데모]`: 화면 검증용 값이며 운영 seed나 불변식으로 사용하면 안 됨
- `[운영 입력값]`: 특정 시점의 현장 상태다. 제품 로직에 하드코딩하지 않고 운영자 확인 뒤 데이터로 넣음
- `[구현 원칙]`: 사용자 화면 정책이 아니라 보안·정합성을 위한 서버 설계 기준
- `[현재 채택안]`: 구현 방향은 잡혀 있지만 운영 계정·비용·공급자 같은 배포 전제가 아직 남아 있음
- `[현재 구현]`: 이미 존재한다는 뜻일 뿐, 올바른 최종 설계라는 뜻은 아님

### AI가 추측하면 안 되는 경우

- `[미확정]` 항목을 DB 제약, 영구삭제 정책, 외부 API 계약으로 고정하려는 경우
- 프런트 문서와 이 문서가 충돌하는데 현재 사용자의 새 결정이 없는 경우
- 실제 금액, 계정, PIN, 예약, 점유, 사진, 송금 결과가 필요한 경우
- 외부 OTA/PMS, 도어락, Google Drive, 푸시, 송금이 연결됐다고 가정해야 하는 경우

이때는 구현을 멈출 범위를 최소화하고, 필요한 선택지만 구체적으로 질문한다. 되돌릴 수 없는 삭제나 정산은 추측으로 진행하지 않는다.

---

## 2. 제품 한눈에 보기

CASTLE THE ART 객실관리 시스템은 숙소 내부 직원용 앱이다.

### 사용자 역할

- **개발자**: 단일 bootstrap 계정으로 관리자·메이드 계정을 관리한다. 일반 객실·예약·배정 업무 권한은 갖지 않으며 역할·상태를 변경할 수 없다.
- **관리자**: 객실 기준정보·예약·운영 차단·청소 대상·메이드 가능일·배정/순서·통보·검수·계정·주급·감사 이력을 관리한다.
- **메이드**: 본인에게 통보된 작업, 본인 가능일, 본인 수행 회차·사진·제출·검수 결과·수익/주급만 본다.

현재 제품 역할은 단일 최상위 `developer`, 복수 `admin`, 복수 `maid`다. developer는 로그인 ID `admin`으로 빈 시스템에서 한 번만 bootstrap하며 일반 계정 명령으로 생성·강등·비활성화할 수 없다. admin과 maid의 역할 변경 이력과 마지막 활성 관리자 보호가 필요하다.

### 제품이 해결하는 흐름

1. 예약과 실제 점유를 파악한다.
2. 예약 퇴실, 투숙 중 요청, 관리자 직접 요청으로 청소 의무를 만든다.
3. 메이드가 제출한 주간 가능일을 바탕으로 관리자가 오늘/내일 담당과 1–N 순서를 정해 통보한다.
4. 메이드는 본인 작업을 시작하고 필수 사진과 현장 정보를 제출한다.
5. 관리자는 `검수 대상 목록`에서 제출을 승인 또는 반려한다.
6. 승인 결과로 불변 수익을 만들고 주차별 지급을 처리한다.
7. 모든 중요한 변경은 알림과 삭제 불가 감사 이력으로 남긴다.

### 이 제품이 아닌 것

- 고객용 예약 사이트가 아니다.
- OTA/PMS, 실제 도어락, 은행 송금이 현재 연결된 시스템이 아니다.
- 프런트 fixture의 사람·예약·PIN·사진·급여를 실제 운영 데이터로 보는 시스템이 아니다.
- 객실 상태를 하나의 enum으로 덮어쓰는 단순 칸반 앱이 아니다.

---

## 3. 기준정보와 운영값 경계

### `[확정]` 객실 마스터

- 객실은 총 121실이다.
- 타입별 객실 수는 22 / 51 / 13 / 35실이다.
- 엘리베이터 구역은 A 33실 / B 29실 / C 59실이다.
- 객실 번호는 사람이 보는 안정적인 업무키다. 내부 PK는 별도 불변 UUID를 사용한다.
- 타입이나 엘리베이터가 바뀌어도 과거 작업 snapshot은 바뀌지 않는다.

| code | 표시명 | 객실 수 | 기본 청소요금 | 퇴실 청소 사진 슬롯 |
|---|---|---:|---:|---:|
| `standard` | 스탠다드 더블 로프트 | 22 | 16,000원 | v8+: 9개(필수 8 + 선택 1) |
| `premium` | 프리미어 더블 로프트 | 51 | 20,000원 | v8+: 10개(필수 9 + 선택 1) |
| `oceanPremium` | 파셜 오션뷰 프리미어 더블 로프트 | 13 | 20,000원 | v8+: 12개(필수 11 + 선택 1) |
| `oceanFamily` | 파셜 오션뷰 패밀리 투룸 로프트 | 35 | 30,000원 | v8+: 14개(필수 13 + 선택 1) |

객실별 타입·구역의 전체 매핑은 migration seed가 현재 정본과 일치한다. 사람이 읽는 표시명은 바뀔 수 있으므로 code와 이력을 기준으로 연결한다.
사진 슬롯 표는 2026-09-16 Decision #179의 A안을 반영한다. 기존 publisher가 만든 `maxPhotos` 없는 pre-A template/snapshot은 version이 v7보다 높아도 10/11/13/15개 계약으로 계속 유효하며 backfill하지 않는다.

### `[확정]` 기본 운영 시각

- 기본 체크인: 16:00 KST
- 기본 체크아웃: 11:00 KST
- 얼리 체크인과 레이트 체크아웃은 별도 boolean 상태가 아니라 예약에 저장된 실제 예정 시각과 기본 시각의 차이로 계산한다.
- DB instant는 `timestamptz`로 저장하고 API는 RFC 3339 offset을 사용한다.
- `service_date`, `week_start`처럼 업무상 날짜인 값은 `Asia/Seoul`에서 계산한다. 주차 시작은 월요일이다.

### `[확정]` 객실 차단·촛불 규칙

- 촛불이 1개라도 남아 있으면 고객 배정과 체크인을 막는다.
- 촛불 전량 회수 뒤 관리자가 0개를 확정해야 차단이 풀린다.
- 메이드는 이번 작업에서 새로 둔 촛불 수량을 보고할 수 있지만 기존 객실 수량을 임의로 줄이지 못한다. 청소 검수 승인이 촛불 수량을 자동으로 0으로 만들지 않는다.
- 특정 객실의 청소·고객 배정 제외는 `room_number` 조건문이 아니라 유효기간·사유·행위자·해제 이력이 있는 객실 운영 차단 데이터로 표현한다.

### `[운영 입력값]` 608호

과거 운영 설명에는 608호를 청소·고객 배정에서 제외한다는 내용이 있었지만 프런트 최종 감사는 608호 전용 제품 규칙을 제거했다. 따라서 608호를 영구 invariant나 migration seed로 넣지 않는다. 실제 운영 개시 시점에 차단이 여전히 유효한지 관리자가 확인한 뒤 일반 객실 운영 차단 record로만 입력한다.

### `[데모/변동 가능]` 운영 상태

다음 값은 schema 불변식이 아니다.

- 최초 투숙 11실
- 762호 `정보 확인 필요`
- 메이드 9명과 이름
- 샘플 예약, 점유, 청소 단계, PIN, 사진, 폭탄방 판정, 수익, 지급 이력
- 폐기 전 화면에 있던 타입별 예상 청소시간 55 / 65 / 70 / 80분
- 기본/최대 숙박 인원 2/2, 2/3, 2/4, 4/6

121실 마스터와 확정된 타입·구역·단가는 검증된 초기 기준정보로 반입할 수 있다. 반면 인명·PIN·사진·예약·청소·폭탄방·수익·지급 fixture는 production 반입을 금지한다. 최초 투숙 11실과 762호 상태도 배포 시점의 운영자 확인 없이 production seed로 넣지 않는다. 인원 상한은 확정 전 예약 거부 조건으로 사용하지 않으며 예상시간 정책은 폐기됐다.

---

## 4. 상태 모델: 한 개의 `status`로 합치지 않는다

화면의 주 상태는 여러 원장의 projection이다. 다음 축을 독립적으로 보존한다.

| 축 | 예시 | 정본 원장 |
|---|---|---|
| 예약 일정 | 입실 전, 유효, 취소, 종료 | reservation + schedule revision |
| 점유 | 투숙 중, 공실 | 예약 + 실제 체크아웃/점유 보정 event |
| 청소 의무 | 없음, 퇴실, 연박, 추가, 재청소 | cleaning target/obligation |
| 배정 | 미배정, 저장 전, 통보, 변경 통보, 취소 | assignment revision |
| 수행 | 예정, 진행 중, 현장 완료, 중단, 종결 | attempt |
| 미디어 | 미촬영, 업로드 중, 실패, 완료 | photo slot/upload |
| 제출 | 초안, 검수 요청됨, 대체됨 | immutable submission version + current pointer |
| 검수 | 미결, 승인, 반려 | inspection decision |
| 고객 배정 준비 | 가능, 불가 | 점유·청소·촛불·이슈·운영 차단의 projection |
| 지급 | OPEN, PAYING, CHECK, PAID | payroll cycle + event |

DB에는 카드 색이나 최종 표시 문자열을 원본 상태로 저장하지 않는다. 조회 view 또는 projection service가 축을 조합한다. 정책 우선순위가 바뀌어도 원본 이력은 그대로 남아야 한다.

### `[확정]` 백엔드 projection / `[확정 — 2026-09-16]` 현재 객실 대표 표현

백엔드는 기존 `reservation_phase`, `occupied`, `cleaning_required`, `allocation_blocked`, `allocation_ready`와 사유를 호환 유지하고, #187 Phase A에서 `occupancy_status`, `reservation_lifecycle`, `readiness_status`, `primary_display_status`를 독립 projection 축으로 추가한다. 한 호출은 서버 시각을 한 번만 캡처하며 `server_time`은 기존 `evaluated_at`과 정확히 같은 값이다. 현재 일정은 `[check_in_at, check_out_at)` 반개구간이고 실제 active occupancy도 `OCCUPIED`다. current가 없으면 가장 이른 미래 active 예약의 KST 체크인 날짜가 오늘이면 `ARRIVAL_PENDING`, 내일이면 `RESERVATION_PRESENT`, 모레 이후이면 `FUTURE`, 예약이 없으면 `NONE`이다. 현재가 있어도 별도의 `next_reservation_id`, `next_check_in_at`, `next_check_out_at`에는 가장 이른 미래 active 예약을 반환할 수 있다.

`primary_display_status` 우선순위는 `BLOCKED → OCCUPIED → ARRIVAL_PENDING → RESERVATION_PRESENT → CLEANING_REQUIRED → READY`다. `BLOCKED`는 청소 외 실제 운영·입실·데이터 차단이 있을 때만 사용하고, 청소만으로 만들지 않는다. `FUTURE`는 현재 readiness 대표 상태를 유지한다. `blocking_reason_codes`와 `readiness_reason_codes`는 분리하며, `PIN_MISMATCH`와 `PIN_UNCONFIGURED`는 current check-in의 readiness 사유로만 노출하고 예약 bookability 차단으로 사용하지 않는다. 이 값들은 저장된 단일 상태가 아니라 동일 snapshot에서 계산한 표시 projection이며, 기존 reason/PIN 경고도 보존한다.

객실 예약·준비 판단은 세 축을 합치지 않는다. `intervalBookable`은 요청한 미래 반개구간 또는 종료 미정 시작점 이후의 예약 가능성, `readinessStatus`/`checkInReady`는 현재 체크인·배정 준비, `pinSyncStatus`는 현재 PIN 동기화 상태다. 통합된 `dev`는 #196 일반 예약 bookability preview와 bounded from/to/cursor 범위 조회까지 제공한다. Issue #200 작업 브랜치는 같은 경로에 `long_stay`와 nullable checkout 의미를 더하는 source 후보다. `allocation_ready`를 그 대체값으로 사용하지 않는다. 미래 기간은 예약 가능하면서 현재 체크인 준비는 불가할 수 있으며, preview 결과는 commit 성공 보장이 아니다.

`allocation_ready`는 현재 시각의 예약 배정 가능 여부다. 공실, 현재 preparation obligation 승인, 촛불 0, 운영 정상, 미해결 입실 차단 이슈 없음, 기준정보·점유 확인 완료를 모두 만족할 때만 true다. 현재 예약 구간이면 실제 체크인 event가 아직 없어도 `RESERVATION_CURRENT`로 차단한다. false이면 `OCCUPIED`, `RESERVATION_CURRENT`, `CLEANING_REQUIRED`, `CANDLE_PRESENT`, `OPERATION_BLOCKED`, `ROOM_ISSUE_BLOCKED`, `DATA_UNCONFIRMED` 같은 안정적인 reason code 목록을 함께 반환한다. `pin_sync_status`는 별도 경고 축이며 `unconfigured` 또는 `mismatch`만으로 예약 생성·변경·배정을 막지 않는다. 다만 실제 체크인 전이와 PIN 조회·변경은 current PIN이 `verified`가 될 때까지 fail-closed한다. 미래 예약의 pending preparation obligation과 private planned checkout target은 현재 `cleaning_required`를 활성화하지 않으며, 실제 checkout으로 current target이 materialize됐거나 현재 실행 가능한 비-checkout 청소가 있을 때만 현재 청소 축에 반영한다.

---

## 5. 예약과 점유

### `[확정]` 예약

- 한 객실은 안정적인 ID를 가진 여러 예약을 가질 수 있다.
- 활성 예약 구간은 `[check_in_at, check_out_at)` 반개구간이며 서로 겹치지 않는다.
- 앞 예약의 체크아웃과 다음 예약의 체크인은 같은 instant여도 겹침이 아니다.
- 예약 생성·변경은 최소 1박과 허용 시간 단위를 서버가 검증한다. 객실 타입별 인원 제한은 운영값이 확정된 뒤에만 production 거부 조건으로 사용한다.
- 체크인 전 예약 취소만 허용하고 soft cancel과 사유 code를 남긴다. 과거 예약과 연결 이력을 삭제하지 않는다.
- 예약 변경은 연결된 청소 일정, 이미 통보한 담당 snapshot, PIN 접근, 진행 중 attempt의 영향을 같은 command에서 재검증한다.
- 각 예약은 해당 체크아웃의 비공개 퇴실 청소 의무를 정확히 하나 가진다. 재시도해도 중복 생성하지 않는다.
- **#1/#4/#26/#28 확정 보강:** 예약 저장 transaction에서 배정용 checkout target도 정확히 하나 생성하고 `planned_cleaning_target_id`로 연결한다. 비공개 의무의 lifecycle과 배정 계획은 별개 축이다. `private` 의무의 `current_cleaning_target_id`는 계속 null이며, 계획 target 때문에 점유·입실 준비·cleaning_required를 활성화하지 않는다.
- 미래 계획은 예약 active·actual checkout 없음·예정 checkout/접근 시각/서비스 날짜/snapshot 일치 조건에서 오늘/내일 draft 저장과 통보가 가능하다. 실제 checkout 전 attempt 생성, PIN 발급·공개, 현장 시작은 금지한다.
- 예정/수동 checkout은 기존 planned identity를 current로 승격하고 의무를 materialized로 만든다. target·최초 서비스 날짜·요금/템플릿/객실 생성 snapshot은 보존한다. 조기 수동 checkout은 schedule 및 현재 담당 revision과 변경 통보를 추가하며 attempt를 미리 만들지 않는다.
- 예약 일정 변경 시 미배정 계획은 schedule CAS/revision으로 갱신한다. 미통보 draft의 기존 snapshot은 보존하여 stale로 만들고 재저장해야 통보할 수 있다. 통보된 계획은 암묵 변경하지 않고 explicit replan을 요구한다. 예약 취소는 target soft cancel, current assignment 종료, 통보 이력이 있으면 회수 알림/outbox를 원자적으로 추가한다.
- **#73 확정 보강:** 예약·비공개 checkout 의무·planned target의 객실 복합 FK는 command transaction 안의 일시적인 update 순서만 허용하도록 `DEFERRABLE INITIALLY DEFERRED`로 맞추고 commit에서 정확히 같은 `(reservation_id, room_id)`를 다시 강제한다. 제약을 끄거나 target을 복제하지 않는다. 미배정 또는 미통보 draft만 같은 planned identity로 객실 이동할 수 있고 draft는 stale이 된다. 현재 notified 계획은 explicit replan 전 변경을 거부하며, 실제 check-in 뒤 객실 변경도 거부한다. 과거 notified assignment의 객실 snapshot은 새 객실로 덮지 않는다.
- **#187 Phase B 확정:** 체크인 전 객실 변경은 `POST /v1/reservations/{reservationId}/room-change/preview`와 `POST /v1/reservations/{reservationId}/room-change`만 사용한다. preview 요청은 source-controlled `reasonCode`를 필수로 받고 `effectiveAt`은 생략하거나 예약 `checkInAt`과 정확히 같은 strict RFC 3339 값만 허용한다. 응답은 authoritative `effectiveAt=checkInAt`, 예약/출발 객실/도착 객실 version, strict RFC 3339 `evaluatedAt`, 정확히 5분 뒤 `expiresAt`, reason/effectiveAt까지 묶은 영향 fingerprint와 안전한 rejection code를 반환하며 inactive·투숙 중 상태도 예외 대신 200 ineligible projection으로 닫는다. commit은 같은 preview payload와 proof를 모두 echo해 CAS/fingerprint/TTL을 재검증하고, UUID 순서로 두 객실을 잠근 뒤 기존 reservation·preparation obligation·private checkout obligation·같은 unpublished planned target만 원자 이동한다. 고객·체크인/체크아웃·인원·planned target identity는 보존한다. 동일 key/payload의 완료 receipt는 TTL 검사보다 먼저 replay하고 다른 hash는 충돌하며, 다른 key로 이미 같은 target에 이동한 상태는 원 preview version이 stale이어도 reservation row lock 뒤 CAS보다 먼저 `MOVE_ALREADY_APPLIED` 409로 반환한다.
- **#187 Phase B 충돌 복구 계약:** 전용 객실 변경의 409(동일 `Idempotency-Key`를 다른 payload에 재사용한 `IDEMPOTENCY_KEY_REUSED` 포함)는 `error.conflict.reloadResources`의 `reservation | sourceRoom | targetRoom | roomMovePreview` 허용 목록과 `latestVersions.{reservationVersion,sourceRoomVersion,targetRoomVersion}`만 반환한다. 잠긴 최신 version을 확정할 수 없으면 해당 값은 `null`이며, UUID·고객정보·PIN·원문 DB 오류·request hash는 conflict metadata에 포함하지 않는다.
- **#187 Phase B 당시 fail-closed:** generic `PATCH /v1/reservations/{reservationId}`와 Data API/direct SQL의 실제 `room_id` 변경은 `RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED`로 막는다. Phase B에서는 투숙 중 이동을 `DURING_STAY_NOT_SUPPORTED`로 닫았고 stay/segment row를 만들지 않았다. 공개·배정·통보·attempt가 있는 청소 workflow는 `CLEANING_ASSIGNMENT_LOCKED`, active PIN lease는 `PIN_LEASE_ACTIVE`, target block은 `TARGET_ROOM_BLOCKED`, 겹침은 `TARGET_ROOM_OVERLAP`이었다. 체크인 전 성공은 PII/PIN/fingerprint 없는 `reservation.room_moved` 감사만 남기고 승인된 비자기 수신자가 없으므로 notification/outbox를 만들지 않는다. 이 중 DURING_STAY 미지원 문구는 아래 Phase C source 계약으로 대체된다.
- **#187 Phase C 확정 계약 / production source 배포:** PR #190이 `dev@1571565b9e361e890cba6502aa3acbf9a08816c3`에 병합됐고 v0.4.0으로 production DB/API에 반영됐다. `reservations.room_id`는 최초 입실 계약 객실 이력으로 유지하고 private stay와 `[startsAt,endsAt)` room segment가 현재·미래 점유를 권위 있게 표현한다. `DURING_STAY`는 `serverNow <= effectiveAt < checkOutAt`, 실제 current source와 `VACANT + READY` target, segment/객실 version·fingerprint·TTL·idempotency를 모두 재검증한다. source segment 종료와 target segment 시작은 정확히 같은 시각이고 객실별·stay별 exclusion이 겹침을 막는다. 원 객실 checkout cleaning은 별도 obligation/target으로 exactly-once 만들며 마지막 예정 segment 객실이 최종 checkout obligation/target을 소유한다. 미래 이동의 source PIN lease는 즉시 폐기하지 않고 immutable cutoff를 기록해 effectiveAt 전 접근을 유지하고 이후 reveal/change/rotation과 Data API RLS에서 차단한다. safe `reservation.room_moved` audit과 비자기 admin notification/outbox는 같은 transaction이며 고객명·PIN·사진 URL·raw request/private ledger ID를 노출하지 않는다. 미래 이동 직후 `stay.currentRoomId`는 command 시각의 source이고 `sourceOutcome/targetOutcome`은 effectiveAt 결과다. generic room mutation은 계속 차단된다. 안전 fixture 기반 hosted mutation smoke는 아직 별도다.
- **#196 source/dev 통합:** `POST /v1/reservations/bookability/preview`와 bounded `GET /v1/reservations?from&to&roomId&cursor`는 65번째 migration으로 `dev`에 통합됐다. preview는 read-only 힌트이고 최종 create/change transaction의 overlap·CAS 판정을 대체하지 않는다. production 배포 상태는 별도다.
- **#200 확정 계약 / production source 배포:** 예약은 `reservationType=standard|long_stay`를 명시한다. `standard`는 checkout이 필수이고 `long_stay`는 고정 checkout 또는 `null`을 허용한다. 종료 미정 long-stay는 check-in 이후를 무한 상한처럼 점유하여 다른 예약·precheckin move target을 막지만, 종료를 확정하거나 수동 checkout하기 전에는 checkout obligation/cleaning target을 만들지 않는다. 동일 예약의 type은 불변이고, 고정 checkout을 다시 `null`로 되돌리지 않는다. null→고정은 CAS·멱등 command 한 transaction에서 checkout obligation/target을 정확히 하나 만든다. 체크인 전 객실 이동 preview/commit은 종료 미정 점유를 보존하며 대상 객실의 무한 구간 충돌을 재검증한다. 투숙 중 종료 미정 이동은 `OPEN_ENDED_STAY_REQUIRES_END`로 fail-closed한다. 실제 입실한 종료 미정 장기 투숙도 명시적 bounded stayover 창은 생성·배정·시작할 수 있으며, nullable segment end를 임의 시각으로 추정하지 않는다. scheduler는 종료 미정 예약을 자동 checkout하지 않으며 수동 checkout만 actual checkout과 정확히 하나의 checkout graph를 만든다. 66번째 append-only migration과 API는 v0.4.0 production source에 포함됐으며 실제 hosted mutation 검증은 별도다.
- 한 객실의 여러 미래 예약은 각각 자기 퇴실 청소 의무를 가질 수 있다. 따라서 “객실당 모든 비종결 target 1건” 제약을 두면 안 된다.
- 체크인 예정 시각에 입실 준비 조건이 모두 충족되면 예약상 점유 시작 event를 멱등적으로 한 번 만든다. 조건이 남아 있으면 `입실 시각 도달·객실 미준비`로 두고, 유효 예약 중 조건이 모두 해소된 시점에 같은 전이를 원자적으로 한 번 실행한다.
- 실제 checkout event가 없으면 예정 체크아웃 시각에 scheduler가 점유 종료, 퇴실 청소 활성화, 유효 담당의 PIN 조회·시작 가능 시각 개방을 멱등적으로 실행한다. 예정 전 수동 checkout이 이미 있으면 다시 종료하거나 청소를 복제하지 않는다.
- 자동 종료 뒤 예정 체크아웃을 미래로 늦추면 기존 종료 event를 삭제하지 않고 점유 재개 보정 event를 추가한다. PIN을 아무도 조회하지 않았고 청소도 시작 전이면 미시작 작업·PIN 권한·offline lease를 같은 transaction에서 폐기·재잠금한다. PIN 공개 또는 수행 시작 뒤라면 출입 충돌로 격리해 현장 조율·PIN 교체·작업 중단/재계획 command 전에는 정상화하지 않는다.
- **#133 확정:** 자동 checkout 뒤 현재 notified 담당 메이드가 현장 완료 전에 손님 잔류를 확인하면 PIN 조회·청소 시작 여부와 무관하게 `GUEST_STILL_PRESENT` 사건을 한 번 신고할 수 있다. 신고는 예약·객실·checkout obligation·기존 target·현재 assignment·attempt·신고자를 immutable identity로 묶고, 미해결 동안 새 시작·완료·제출·검수·PIN 조회/lease·offline replay·일반 재배정·실제 다음 체크인을 각 실행 경로에서 fail-closed한다. 이미 공개된 PIN을 회수했다고 표현하지 않고 이후 서버 권한만 폐기한다.
- 관리자는 사건마다 `EXTEND_CHECKOUT | CONFIRM_DEPARTED | FALSE_REPORT` 중 하나를 version CAS, 조회 시 서버가 계산한 영향 범위 fingerprint, 멱등 command로 확정한다. fingerprint는 사건·예약·checkout obligation·target·원 assignment/attempt의 현재 version과 실행 상태를 묶으며, 하나라도 바뀌면 결정을 fail-closed한다. 연장은 과거 checkout을 삭제하지 않고 `occupancy_resumed` 보정 이력을 추가하며, 나머지 결정도 현재 예약·접근 조건을 재검증한다. 모든 결정은 기존 checkout target을 재사용하고 이전 assignment/attempt를 보존한 채 새 책임 revision을 만들며, 손님 잔류로 중단된 구간에는 earning·벌점을 만들지 않는다.
- 사건 결정의 새 책임 구간은 기존 공통 일정 계약을 재사용해 `availableFrom`의 KST 날짜와 `serviceDate` 일치, 서비스일 다음 날 00:00 KST 상한, 다음 유효 예약 체크인 30분 전 상한을 잠금·현재 상태 재검증 뒤 강제한다. 모든 incident timestamp API 값은 초와 UTC offset이 있는 strict RFC 3339이며, 실제 달력에 존재하지 않는 날짜를 허용하지 않는다.
- 신고와 동결·감사·전체 active/password-complete business admin 행동 알림/outbox는 한 transaction이다. 결정은 행동 알림을 resolve하고 기존/새 담당에게 필요한 회수·배정 통지만 원자적으로 남긴다. PIN·고객 PII·민감 자유문은 사건 projection, audit, notification, outbox에 저장하지 않는다.
- 청소 가능 여부를 예상시간이나 1분 주기 추측으로 자동 해제하지 않는다. 메이드 신고, 관리자 결정, 배정 변경, 작업 시작·완료처럼 상태가 바뀌는 command에서 최신 사건·점유·담당·실행 상태를 다시 확인한다.
- 예약 추가·수정·취소는 객실 일정 row를 잠그고 앞뒤 예약의 직전 점유와 `preparation_obligation` 연결을 다시 계산한다. 기존 승인·반려 이력은 보존하고, 새 점유·오염으로 기존 청결 근거가 무효가 되면 새 준비 작업 필요 상태를 만든다.

권장 유일키와 실행 잠금:

- 퇴실 청소: `(reservation_id, cleaning_kind)`
- 수동/연박 요청: 안정적인 source request ID
- 실행 중 충돌 방지: 객실 실행 lock/원자 command를 사용한다. 현재 `cleaning_attempts`에 없는 `room_id`를 단순 중복 추가해 부분 index를 만들면 target과 객실이 어긋날 수 있다. denormalize한다면 `(target_id, room_id)` 복합 FK/제약으로 동일성을 강제하고, 아니면 constraint trigger/advisory lock 등 실제 schema에 맞는 수단을 쓴다.
- 예상시간이 없거나 `dueAt`이 열린 checkout target을 1분짜리 구간으로 바꾸지 않는다. 수동 요청은 명시된 두 일정 구간이 있을 때만 계획 충돌을 비교하고, 열린 계획은 생성할 수 있다. 실제 시작은 공통 객실 lock 아래 동일 객실의 현재 `in_progress`와 미해결 #133 사건을 다시 검사해 차단한다. 계획 대기와 실행 충돌은 별개 축이다.

### `[확정]` 예정 전 수동 체크아웃

관리자는 투숙 중 객실을 예정 시각 전에 `지금 체크아웃`할 수 있다. 예약 취소와 다른 command다.

- `scheduled_check_out_at`은 덮지 않고 실제 시각·관리자·기록 시각의 checkout event를 추가한다.
- 점유를 공실로 전환하고 카드 projection은 청소 승인 전까지 배정 가능이 되지 않게 한다.
- 같은 예약의 예정/수동 퇴실은 같은 퇴실 청소 의무를 재사용한다. 수동 command 재시도와 나중의 예정 시각 도달이 중복 target을 만들면 안 된다.
- 이미 통보된 미시작 작업은 target/담당/순서를 유지하고 schedule revision과 변경 통보를 남긴다. 기존 PIN 조회 lease는 폐기하고 실제 퇴실 시각부터 다시 발급한다.
- 이미 진행 중인 수행 또는 PIN 공개와 충돌하면 checkout event와 점유 변경을 쓰기 전에 `CONFLICT`로 거부한다. 별도 관리자 현장 영향 해결 command가 선행된 뒤 최신 version으로 다시 실행한다.
- 공실 또는 점유 확인 보류 객실에는 허용하지 않는다.

### `[확정]` 입실 준비 의무와 수동 청소 요청

- 예약마다 직전 점유 뒤 청결을 증명하는 불변 `preparation_obligation_id`를 둔다. 최초 승인 전 원 청소와 모든 반려·재청소 chain을 연결하고 current attempt를 별도 pointer로 가리킨다.
- 투숙 객실의 수동 요청은 연박 청소, 공실 객실의 요청은 추가 청소다.
- 연박 청소는 예약 점유 구간 안에서 `access_start < requested_complete_at <= access_end`를 검증한다.
- 다음 체크인이 있는 퇴실·재청소의 준비 마감은 체크인 30분 전이다.
- 현재 요청의 service date·점유·명시된 접근 구간과 겹치는 활성 수동 요청·자동 퇴실 의무·예정 작업은 새 요청을 만들지 않는다. 다만 종료시각과 예상시간이 모두 없는 열린 checkout 계획을 임의 구간으로 환산해 계획 생성을 막지 않는다. 실제 수행 회차·미승인 제출·미해결 #133 사건은 계획과 분리해 실행 시작 시 최신 상태로 차단한다. 충돌하지 않는 미래 예약의 퇴실 의무와 과거 승인 완료 제출만으로 오늘의 연박/추가 요청을 막지 않는다.
- 수동 요청은 아직 미배정·미공개·미착수일 때만 soft cancel하며 사유·행위자·시각을 보존한다.

---

## 6. 주간 가능일과 관리자 배정

### `[확정]` 현재 정책

- 과거의 공개 일감과 메이드 선점/claim 모델은 폐기됐다.
- 일요일은 다음 주 계획의 주 제출일이지만, 메이드는 어느 요일이든 KST 기준 현재 주 또는 다음 주의 가능일을 직접 version으로 제출·변경할 수 있다.
- 현재 주의 지난 날짜는 기존 current version에서 이미 가능했던 값을 보존할 수 있지만, 불가능·미제출 날짜를 `available=true`로 소급 변경할 수 없다. 모든 재제출은 원본을 덮지 않고 새 immutable version을 만든다.
- 관리자 승인형 변경 요청과 승인/반려 이력은 별도 호환 흐름으로 유지한다.
- 관리자는 가능 메이드만 후보로 오늘/내일 청소를 배정한다.
- 관리자가 메이드별 작업 순서 1–N을 정하고 저장·통보한다.
- **[확정 — 2026-09-08 #4 A안]** 메이드는 본인에게 실제 통보된 assignment revision만 조회한다. 과거 superseded/종료 revision도 본인에게 실제 통보됐으면 history에 포함한다. 미통보 draft, 다른 maid의 배정, 자신에게 한 번도 통보되지 않은 revision은 금지한다. 과거 조회 권한은 현재 target 일정·새 담당·새 revision 조회나 수행 권한을 뜻하지 않는다.
- 배정 preview는 먼저 명시된 사실상 배정 가능한 객실 수를 최대화하고, 그 후보 중 메이드별 기본 청소요금 총액의 최대·최소 격차와 전체 편차를 최소화한다. 기존 배정과 reclean 원 메이드 제약을 지키고, 금액 점수가 같을 때만 같은 엘리베이터 구역·가까운 호수를 보조 기준으로 쓰며 마지막은 안정적인 키로 결정한다.
- 예상시간 정책은 폐기됐다. 타입별 시간, template `durationMinutes`, 객실 타입 기본값, 임의 1분을 신규 preview의 용량·순서·충돌 판단에 사용하지 않는다.
- 랜덤 결과는 저장 전 초안이다. 실행만으로 담당·attempt·알림·감사 이력을 만들거나 기존 통보/관리자 수동 배정을 덮지 않는다.
- 일부 객실만 배정된 상태의 부분 통보를 허용하되 미배정 대상을 숨기지 않는다.
- 통보 뒤라도 **시작 전**에는 관리자가 담당·순서·접근 시각을 바꾸거나 정해진 사유로 soft cancel할 수 있다. 이전 assignment/schedule snapshot과 notification revision을 보존하고 영향받은 당사자에게 변경 통보한다.
- 메이드는 직접 취소·이관하지 못하지만 현장 완료 전 `담당 취소 요청`과 사유를 보낼 수 있다. 관리자 결정 전에는 기존 담당이 유지된다.
- 시작 뒤에는 일반 배정 화면에서 담당·순서를 바꾸거나 취소하지 않는다. 즉시 중단·인계가 필요하면 기존 attempt를 `interrupted`로 종결하고 새 책임 구간을 만드는 별도 관리자 command를 사용한다. 현장 완료·업로드·검수 대기는 배정 취소 대상이 아니다.
- 한 메이드는 하루에 여러 업무를 가질 수 있지만 동시에 `청소 중`인 attempt는 최대 한 건이다.
- 전날 미배정 업무는 같은 target ID와 최초 계획일을 유지해 다음 날 재배정한다. 통보됐지만 미착수인 업무는 이전 담당 이력을 남긴 뒤 현재 담당을 풀고 다음 날 가능 여부로 다시 배정한다.
- 이미 시작한 미완료 업무는 새 attempt나 새 담당을 만들지 않고 같은 attempt·담당·사진 진행을 유지한다. 현장 완료 뒤 업로드/제출 대기와 검수 대기는 배정 이월에서 제외한다.
- 실행 가능한 오늘 작업의 attempt exactly-once 활성화는 #28 소유다. #25/#26 저장·통보 자체는 attempt를 만들지 않는다. 내일 작업이나 아직 실제 checkout 전인 오늘 퇴실 계획은 대기하며, #28이 대상일·실제 checkout·current materialization·접근 가능 시각을 모두 확인한 뒤 같은 target·담당·순서·snapshot으로 활성화한다.
- 같은 객실의 이전 attempt가 진행·업로드·검수 중이면 새 당일 attempt 활성화를 보류하고 `관리자 확인 대기·시작 불가`로 둔다. 이전 workflow가 종결된 뒤 원 통보 revision을 기준으로 한 번만 활성화한다.

배정 가능 여부는 API나 RLS가 최종 저장 시점에 다시 검증한다. 브라우저에서 후보 목록을 봤다는 사실은 권한이나 최신 상태의 증거가 아니다.

### [확정] #29/#231 Preview 경계 — 2026-09-20 예상시간 정책 폐기

- Preview는 active business admin의 오늘/내일 계획 조회·계산이며, 기존 target/assignment/attempt/알림/outbox/audit/command receipt를 쓰지 않는다. 자동 저장·통보·attempt 활성화 API가 아니다. 확인·편집한 제안은 #25 draft 저장 → #26 commit/notify에서 최신 CAS/가능일/source를 다시 검증한다.
- Preview는 confirmed duration policy가 없어도 `decisionReady=true`로 계산한다. 과거 `assignment_duration_policy_versions`와 template duration snapshot은 삭제하지 않지만 신규 판단 입력이나 fingerprint에 포함하지 않는다. 기존 GET은 deprecated read-only 이력 조회로 유지하고 confirmation mutation은 `ASSIGNMENT_DURATION_POLICY_RETIRED`로 거부한다.
- 유효한 미배정 target만 새로 제안한다. 기존 draft/notified 업무는 담당·순서를 변경하지 않고 fee/route의 고정 부하로 반영한다. 실제 진행 중 attempt는 남은 시간을 추측하지 않으며 그 메이드의 추가 제안을 보류한다. reclean은 원 메이드만 가능하고 부재 시 미배정으로 남긴다. planned checkout은 배정 계획에만 포함하며 materialization/현장 실행 경계는 #28이 계속 소유한다.
- `availableFrom`과 `dueAt`은 원문 그대로 보존한다. 두 시각이 명시된 target만 그 실제 구간을 예약 점유와 비교하며 열린 `dueAt`에 가상 종료시각을 만들지 않는다. 실제 청소 수행시간은 `cleaning_attempts.started_at → field_completed_at`, 객실 turnaround는 실제 checkout 시각 → `field_completed_at`으로 사후 계산한다.
- 비교는 배정 가능한 수 → 기본 청소요금 spread → 전체 편차와 기존/reclean 제약 → 동선 → 안정적인 target/maid 키 순서다. `previewSeed`는 응답 상관관계 호환 필드일 뿐 결정 결과나 fingerprint를 바꾸지 않는다. 제한된 탐색은 전역 최적해 증명이 아닌 휴리스틱이다.
- 임의 근무시간·휴게시간·하루 최대 객실 수를 만들지 않는다. target/maid 자원 상한 초과는 부분 자동결정이 아니라 `ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED`로 거부한다.
- 입력 fingerprint는 후보/고정 부하/가능일/source schedule snapshot을 포함하되 폐기된 정책과 seed는 제외한다. 이는 읽은 상태의 식별자이지 저장 권한이나 예약 lock이 아니다.

### [확정] #27 시작 전 변경 경계 — 2026-09-05 구현 착수 계약

- 일반 pre-start command는 target에 `status <> superseded` attempt가 하나라도 있으면 `ASSIGNMENT_ALREADY_STARTED`로 거부한다. `started_at` 유무로 우회하지 않는다. 이후 수행·인계는 #28/#7 소유다.
- active business admin만 draft/notified의 담당·순서를 새 assignment revision으로 바꾸거나 현재 담당을 해제할 수 있다. target version과 current assignment ID를 함께 CAS 검증한다. active maid/current availability와 reclean 원 maid 불변식도 재검증한다.
- unassign은 target을 `unassigned`로 돌리는 명령이지 청소 의무 자체의 취소가 아니다. target 취소는 예약/수동 청소 원 domain이 소유한다.
- 메이드는 본인 notified assignment에만 취소를 요청한다. pending 요청은 assignment당 최대 한 건이며 결정 전 담당은 유지된다. 관리자 승인/반려도 현재 source revision과 attempt 경계를 다시 검사한다. source가 종료되면 pending은 superseded, 결정된 요청은 수정·삭제 금지다.
- draft 변경은 통보하지 않는다. notified 변경은 기존 알림을 보존/resolve하고 이전·새 담당에게 필요한 변경/회수 알림과 outbox를 같은 transaction으로 한 번만 기록한다. 외부 push worker는 #10이다.
- 미래 checkout의 재배정은 기존 planned target ID 안에서만 이루어진다. obligation materialization, 실제 checkout, attempt/PIN 활성화는 하지 않는다.

### [현재 구현] #27 일정 변경의 제한

- 생성 command가 만든 `manual_room_request + additional` 또는 `stayover_request + stayover` 조합만 같은 service date에서 기존 non-null 접근/마감 창을 좁힐 수 있다. 연박은 actual check-in 이후이고 아직 checkout하지 않은 active reservation의 같은 객실·점유 구간도 벗어나지 않아야 한다. source-kind 불일치, 날짜 이동·접근 창 확장·checkout 원장 시간 변경은 #27 API로 허용하지 않는다.
- 요청 사유는 고정 reason code를 사용한다. 선택 detail은 1–200자이며 숫자·주소/URL형 구분자는 차단한다. 이는 모든 민감정보를 판별하는 필터가 아니므로 고객명·전화번호·PIN·token을 입력하지 않는다. detail은 관리자/요청 당사자에게만 보이며 감사 projection·알림에는 복제하지 않는다.
- source 구현/검증과 운영 배포는 별도 gate다. #27의 production API는 아직 사용할 수 없다.

### [현재 구현] #28 수행 회차 활성화·이월 경계

- 기존 scheduler의 exact active business admin·secret·분 단위 invocation을 재사용하되, 예약 전이와 배정 lifecycle은 서로 다른 command scope/request hash로 멱등 처리한다. public activation API와 메이드 activation API는 만들지 않는다.
- 오늘 KST의 notified current assignment만 active maid, current target/version, schedule snapshot, 접근/마감 창, source별 예약·checkout·reclean 계약을 transaction 안에서 다시 확인한 후 `scheduled` attempt를 exactly-once 생성한다. 내일 작업과 private planned checkout은 attempt 0이다.
- checkout은 planned target이 obligation의 current pointer로 materialize되고 reservation actual checkout이 기록된 뒤에만 같은 target/current assignment revision으로 활성화한다. snapshot은 target의 template/room snapshot을 우선 사용하며 생성 뒤 바꾸지 않는다.
- 같은 객실의 이전 non-terminal attempt가 있으면 `PREVIOUS_ROOM_WORKFLOW_ACTIVE`로 보류하고 target·assignment를 유지한다. blocked event는 scheduler 매 실행마다 쌓지 않는다.
- 실행 창이 끝난 unassigned와 notified attempt-0 target만 같은 identity로 다음 KST 날짜에 이월한다. original date는 불변이고 effective date, carryover count, assignment version, schedule revision만 증가한다. notified assignment는 종료하고 기존 알림을 resolve하며 새 maid를 자동 배정하지 않는다.
- active attempt는 자정을 넘어도 같은 attempt/assignment를 유지한다. 실제 시작·중단·인계는 #7, 자동 배정은 #29다. source 구현은 production/recovery에 아직 배포되지 않았다.
- 이월은 다음 schedule을 먼저 계산하고 source window가 유효할 때만 저장한다. `stayover_request + stayover`는 같은 객실의 active·실제 입실·미퇴실 예약 안에 다음 접근/마감 창이 모두 포함되고 KST 날짜가 일치해야 한다. 실패하면 `STAYOVER_ROLLOVER_NOT_ALLOWED`로 blocked이며 배정 종료·알림 resolve·일정/version/이력 변경은 모두 0이다. 자동 취소나 cleaning kind 변환은 하지 않는다. 추가 청소도 다음 창이 기존 활성화 규칙의 active 예약 점유와 겹치면 `ADDITIONAL_ROLLOVER_NOT_ALLOWED`로 변경 없이 차단한다.

### [확정] #7B 만료 회차 해소·인계 — 2026-09-08 사용자 승인

이 절은 기존 #27/#28의 구현 제한과 아래 새 회차 생성 제한에 대한 좁은 예외다.

- 실제 시작하지 않은 채 만료된 `scheduled` 회차는 `superseded`로 보존하고 다음날 재배정·재통보 후 새 회차를 생성할 수 있다. 기존 target ID·최초 계획일·assignment/attempt snapshot·통보 이력은 보존한다. 기존 회차를 삭제하거나 시작/중단된 것처럼 위장하지 않는다.
- 인계 뒤 새 scheduled가 만료된 경우에도 같은 해소 계약을 따른다. 불변 인계 관계로 새 책임 구간이 증명된 과거 interrupted는 live 회차로 오인하지 않되, 대체 증명 없는 interrupted나 현재 미종결 회차는 계속 재배정 차단 근거다. 과거 회차의 status를 변경하거나 전체 interrupted 이력을 무시하지 않는다.
- 관리자 전용 해소 command가 현재 identity/version과 다음 source 일정을 검증한 뒤 기존 담당 종료·통보 회수·회차 supersede·schedule revision을 원자적으로 처리한다. 다음날 담당을 자동 선택하거나 통보 전에 새 회차를 만들지 않는다. 새 통보 후 #28의 실제 실행 가능 조건에서 exactly-once 활성화한다.
- 만료된 `in_progress`의 인계는 관리자가 새 접근/마감 일정을 명시 확정하고, 현재 점유·예약·source·접근 조건을 재검증한 경우에만 새 담당이 시작할 수 있다. 인계 자체가 시간창·실제 checkout·점유 검사를 우회하는 권한이 아니다. 재계획 불가능한 source는 fail-closed로 관리자 확인 대상에 남긴다.
- 이미 시작한 기존 회차는 `interrupted`로 보존하며 새 assignment/attempt가 새 책임 구간을 가진다. 이전 완료/현재 제출/수익 연결을 되살리지 않는다. 재청소의 원 maid 불변 및 다른 maid 이관 금지는 그대로 유지한다.
- 해소/인계와 동시 시작·완료·계정 변경은 CAS·scoped receipt·공통 잠금·원자 audit/outbox로 직렬화한다. TTL을 새 idempotency key나 재시도로 연장하지 않는다.
- 이 승인은 #7B source 개발 범위이며 #7C/offline, 사진/제출 구현 또는 production 승격 승인이 아니다.

---

## 7. 청소 수행, 사진, 제출

### `[확정]` 엔티티 경계

1. **청소 의무/target**: 왜, 어느 객실을, 어느 운영일에 청소해야 하는가
2. **assignment revision**: 누가 몇 번째 순서로 책임지는가
3. **attempt**: 실제 수행 회차. 시작 전 담당 변경·순서 변경은 같은 미시작 업무 연결을 갱신하고, 시작한 업무의 이월은 같은 회차를 유지한다. 검수 반려 재청소 또는 명시적 중단·인계가 새 회차를 만든다. 추가로 위 #7B 승인에 한해 실제 미착수 만료 scheduled를 superseded로 보존하고 다음날 재통보 후 새 회차를 활성화할 수 있다.
4. **submission version**: 메이드가 검수 요청한 불변 제출본
5. **photo slot snapshot**: target 생성 시 고정되어 해당 attempt가 사용하는 템플릿 version의 필수/선택 증빙
6. **inspection decision**: 관리자의 승인/반려

target, assignment, attempt, submission의 `room_id`, `maid_id`, revision이 서로 같은 업무를 가리킨다는 사실을 복합 FK, constraint trigger 또는 원자 command로 강제한다.

### `[확정]` snapshot

**청소 target을 생성할 때** 다음 작업 snapshot을 고정한다. 예약 저장과 함께 만드는 미래 비공개 퇴실 청소도 생성 시점 값을 가진다.

- 객실 번호·타입·엘리베이터
- 기본 청소요금
- 청소 종류와 template ID/version
- 필수/선택 사진 slot
- 예약 ID, 숙박 인원, 체크아웃·다음 체크인·준비 마감
- 생성 시점의 접근 가능 시간과 일정 근거

이후 객실 타입, 요금, 템플릿이 바뀌어도 과거 작업 snapshot은 덮어쓰거나 최신 단가로 재계산하지 않는다. 예약 시각 변경은 별도 schedule revision, PIN lease 재검증, 재통보 필요 여부로 반영한다. 담당·순서·실행일은 assignment revision에서 고정한다.

### `[확정]` 사진과 제출

- 현재 범위의 청소 완료 증빙은 **체크리스트 없이 사진 slot만** 사용한다. 과거 checklist JSON을 필수 계약으로 되살리지 않는다.
- 템플릿 slot은 JSON 문구만 저장하지 말고 stable slot key와 version을 가진 row로 관리한다.
- template evidence 사진은 유효한 slot snapshot을 반드시 참조한다. NULL slot key로 유일 제약을 우회할 수 없어야 한다.
- 일반 slot의 current 사진은 한 장이다. 재촬영은 current pointer를 CAS로 교체하며, 이전 업로드/교체 이력은 보존 정책에 따라 추적한다.
- `maxPhotos` 없는 pre-A 퇴실 청소 snapshot은 v7 및 그보다 높은 historical version도 타입별 10/11/13/15개와 필수 `tv-on`을 유지한다. Decision A snapshot은 v8 이상이면서 모든 slot에 `maxPhotos`가 있고, 9/10/12/14개·필수 8/9/11/13개·required `tv-on`·`entry-storage`를 강제하며 `entry-number`를 제외한다. 마지막 `extra-proof`는 선택 slot, `maxPhotos=10`이다.
- **[현재 source 후보]** v8 `extra-proof`는 안정적인 client item UUID, collection/item CAS revision, 최대 10장, append·동일 item replace·개별 tombstone delete를 제공한다. 제출은 당시 active item을 표시 순서대로 불변 binding하며 이후 교체·삭제가 과거 제출을 바꾸지 않는다. active collection 사진은 폭탄방 신고의 현재 verified 증빙으로 선택할 수 있고, append/replace의 item identity와 삭제 event는 제한된 developer audit projection에 남는다. 최초 append·10장 상한·replace/delete·submit·멱등 key 경쟁은 실제 병렬 DB transaction으로 검증하며 신규 private table/helper의 direct runtime 접근은 금지한다. 기존 pre-A와 일반 slot의 단일 current pointer는 그대로 유지한다. 운영 사용은 #180 독립 QA·CI·사람 리뷰와 release 검증 뒤에만 허용한다.
- 앱은 JPEG/WebP를 EXIF 제거 후 사진당 최대 300KiB(307,200 bytes)로 압축한다. 서버도 본문 크기와 허용 형식을 독립적으로 강제한다.
- 서버는 파일 확장자나 client MIME만 믿지 않고 magic bytes, 허용 MIME, 크기, hash, 현재 담당/attempt/version을 검증한다.
- 현장 완료, 미전송 업로드, 전체 제출, 검수 요청은 별도 상태다.
- **[확정 — 2026-09-08 정책 변경]** `field_completed`는 물리적인 현장 청소 완료 선언이다. 필수 photo slot 충족은 현장 완료의 선행조건이 아니며 #30/#9/#31의 전체 submission gate에서 검증한다. 현장 완료만으로 room ready, cleaning/review approval, earning, payroll entitlement를 생성하지 않는다.
- 메이드 화면 행동명은 `검수 요청`, 제출 상태명은 `검수 요청됨`, 관리자 목록명은 `검수 대상 목록`이다. API enum/code는 안정적인 영문값을 사용하고 표시 문구와 분리한다.
- 재제출은 기존 row를 덮지 않는다. 새 immutable submission version을 만들고 이전 version을 `SUPERSEDED`로 표시하며 current pointer를 CAS로 전환한다.
- 관리자와 메이드는 현재 version을 기준으로 작업하되 과거 version은 감사용으로 조회할 수 있다.

### `[확정]` 오프라인 동기화

- Offline v1은 온라인 `startCleaning` → 서버 attempt/lease 발급 → 오프라인 completion 기록 → 재연결 재검증으로 제한한다. offline 신규 start/claim/assignment 선택·변경은 금지한다.
- work lease TTL은 2시간, clock skew는 ±5분이다. profile, attempt, assignment revision, issued/expires timestamp, allowed actions, lease identity/version에 bind한다.
- lease와 offline queue에 객실 PIN 평문, 고객 개인정보, 다른 메이드 정보는 넣지 않는다.
- 현장 완료 event는 client 시각, 마지막 server 시각 offset, stable event UUID를 함께 보존한다.
- 서버는 event를 순서대로 재생하며 같은 submission/client UUID를 한 번만 반영한다.
- offline 현장 완료만으로 객실 ready·검수·earning을 생성하지 않는다. 서버가 현재 담당/version·lease·권한을 검증해야 현장 완료 효력이 생긴다. 사진 완전성은 이후 submission 단계에서 별도 검증한다.
- 이미 성공한 event UUID는 기존 성공 receipt를 replay한다. 발급 당시 유효했지만 만료 후 도착하거나 revoke/reassign된 lease의 event는 quarantine한다. unknown/위조/발급 사실 없는 lease는 reject하고 domain quarantine을 만들지 않는다. 필요 시 bounded security activity만 기록한다. quarantine 재전송은 자동 승격하지 않는다.
- quarantine에는 event UUID, actor/attempt/assignment revision/lease 식별자, occurred/received timestamps, stable reason, safe canonical hash, resolution state만 저장한다. PIN·guest PII·phone·token·Authorization·photo bytes·raw body·자유형 payload·secret은 금지한다.
- 관리자 resolution은 `record_only`, `reject_effect`, `correction_link`다. correction_link는 새 검증된 correction command에서 원 quarantine ID를 provenance로 연결하며 원 event를 정상 event로 바꾸지 않는다. event metadata는 최대 90일, resolution은 별도 append-only audit에 기록하고 audit retention에 따른다.
- 이 절과 아래 limited capability는 승인된 #7A/B/C 후속 계약이다. #4 조회정책 PR에서 실행·lease·quarantine 기능을 구현한 것으로 표시하지 않는다.

### `[확정 — 2026-09-08 #7C 추가 승인]` 재시도 보존·관리자 정정

- offline event metadata뿐 아니라 성공 응답 replay 보장도 최대 90일로 제한한다. 이후 오래된 이벤트는 재실행 없이 만료 거부한다. 원 event UUID, client 시각/offset, hash, 응답을 영구 command receipt나 audit에 복제하거나 영구 tombstone 예외를 만들어 보존 제한을 우회하지 않는다.
- 구현상 최종 ingest/replay/metadata 보존선은 서버 `lease.issued_at + 90 days`로 고정한다. 늦은 최초 수신·새 UUID·재시도로 연장하지 않으므로 실제 개별 event 보존은 90일보다 짧을 수 있다. 이는 최대 90일 규칙의 구현이며 수신 후 정확히 90일 보장을 추가하지 않는다.
- 관리자 완료 정정은 현재 유효한 원 담당자의 `in_progress` 회차만 대상으로 한다. 현재 actor·owner·assignment/revision·execution version·source를 재검증한 별도 correction command로 물리적 완료 효력과 불변 결정/provenance를 원자적으로 기록한다.
- 인계·종료·superseded·재배정된 과거 회차 복구, 기존 완료 시각 덮어쓰기, ready·검수·수익 생성은 금지한다. 원 quarantine event는 성공 event로 변경하지 않고 `correction_link`로 새 결정과 연결한다.
- 두 정책은 #7C source/dev 개발 승인이다. production/recovery/main/release/배포 승인이 아니다.

### `[확정]` 객실 특이사항

- 메이드는 수행 중 객실 특이사항과 사진을 보고할 수 있다.
- 고객 이름·전화·이메일·얼굴 등 불필요한 개인정보를 메모, 파일명, 알림에 넣지 않는다.
- 입실 차단 여부는 별도 필드/결정으로 관리하고 해결 전 고객 배정을 막는다.
- 이슈 원본을 삭제하지 않고 해결·정정 event를 추가한다.

---

## 8. 검수, 폭탄방, 재청소

### `[확정]` 검수

- 관리자는 current submission version만 승인 또는 반려할 수 있다.
- stale assignment/submission/version의 검수는 `STALE_VERSION`으로 거부한다.
- 같은 제출 version에 최종 inspection decision은 한 건이다.
- 폭탄방 신고가 pending이면 먼저 폭탄방 여부를 판단한 뒤 전체 검수를 완료한다.
- 승인/반려, audit event, notification, earning 또는 reclean 생성은 한 transaction이다.

### `[확정]` 폭탄방

- 본인 담당 attempt의 시작 전부터 사진 업로드 단계까지, current submission 전체 제출 전에만 신고할 수 있다. 이미지 증빙은 최소 1장이고 복수 첨부를 허용한다.
- 신고 증빙과 메모는 해당 immutable submission version snapshot에 잠근다. 사후에 다른 version으로 옮기거나 사진 없는 신고로 판정하지 않는다.
- 폭탄방 bonus는 해당 한 객실의 기본요금 snapshot과 정확히 같은 금액이다.
- 폭탄방 인정 **그리고 current submission 전체 승인**이면 `base + bonus = 정확히 2배`다.
- 폭탄방 미인정이고 전체 청소가 승인되면 `base`만 적립한다.
- 전체 청소가 반려되면 폭탄방 판정과 관계없이 그 제출의 base와 bonus는 모두 0원이다.
- client가 bonus 금액을 정하지 않는다.
- 폭탄방 decision 자체로 earning을 만들지 않는다. 전체 검수 transaction에서 승인된 bomb report와 earning source를 1:1로 연결해 재시도·중복 승인이 추가 수익을 만들지 않게 한다.

### `[확정]` 검수 반려 재청소

- 최초 수행 메이드에게 자동 귀속한다.
- 다른 메이드에게 이관하지 않는다.
- 0원이며 새 earning을 만들지 않는다.
- 원 attempt/submission/decision을 불변 FK로 연결한다.
- 원 반려 제출의 bomb report/decision은 감사 이력으로만 남기고 재청소 회차에 승계하지 않는다. 재청소에서는 새 bomb report나 bonus를 만들지 않는다.

검수 반려 재청소와 승인 이후 고객 컴플레인으로 생기는 보상/재작업은 같은 종류가 아니다. 후자는 별도 정책·엔티티로 분리하고 아래 규칙을 적용한다.

### `[확정 — 2026-09-10 #94]` 승인 후 컴플레인과 재작업

- 컴플레인은 `접수 → 확인 중 → 판정 → 메이드 확인/이의 → 종결` 사건으로 관리한다.
- 접수는 원 청소 승인 시각부터 30일 안에만 허용한다. 관련 객실·원 청소·승인 결정·증빙을 실제 FK로 연결하며, 접수·판정·이의 사유는 source-controlled reason code를 사용한다. 자유형 고객 정보와 고객·직원 PII를 입력하거나 감사·알림 payload에 복제하지 않는다.
- 관리자는 immutable decision version과 current pointer를 분리하고 `expectedVersion` CAS로 `확인됨 / 확인 불가 / 사실 아님`, 벌점, 재작업 필요를 결정한다. 과거 decision을 수정·삭제하지 않는다.
- 벌점은 0~10의 정수이고 평가 전용 데이터다. 청소 반려가 자동 벌점이 되지 않으며, 컴플레인·벌점이 음수 adjustment나 주급 차감을 자동 생성해서는 안 된다.
- 메이드는 본인 건의 최초 판정 뒤 7일 안에 한 번만 이의를 제기할 수 있다. 판정·벌점·재작업을 직접 바꾸지 못한다.
- 종결 뒤 reopen은 금지한다. 판정 오류는 active business admin이 기존 판정을 보존한 새 correction decision version으로만 바로잡는다.
- 판정·이의 처리·종결·정정 command는 한 명의 active business admin이 처리하며 actor, `expectedVersion`, actor/command 범위 idempotency key와 canonical request hash, audit을 필수로 한다.
- 이미 승인된 원 청소의 earning은 컴플레인 때문에 취소하거나 귀속일을 바꾸지 않는다.
- 같은 메이드가 재작업하면 추가 earning은 0원이다. 다른 메이드가 맡으면 active business admin이 0원 이상, 원 target base fee snapshot 이하의 정수 원화 보상을 immutable compensation decision으로 확정한다.
- 타 메이드 보상 earning은 해당 compensation decision과 타 메이드 재작업의 현장 완료·승인 근거를 실제 FK로 연결한 뒤 정확히 한 번만 생성한다. 최초 검수 반려 재청소나 현장 완료·승인 전에는 만들지 않는다.

---

## 9. 수익과 주급

### `[확정 — 2026-09-10 #94 보강]` 수익

- earning은 승인된 유상 청소 entitlement에서 정확히 한 번 생성되는 불변 원장이다.
- 원청소 entitlement와 타 메이드 재작업 compensation entitlement는 서로 다른 실제 typed table/FK로 표현한다. `earnings`에는 임의 UUID polymorphic source를 두지 않고 source별 nullable FK와 exactly-one CHECK로 출처를 강제한다.
- 이미 구현된 #31 원청소 earning identity와 이력은 미래 append-only migration에서 보존한다. 적용된 migration이나 기존 earning을 고쳐 써서 provenance를 바꾸지 않는다.
- 금액은 작업 당시 base fee snapshot과 승인된 bonus에서 서버/DB가 계산한다.
- `earned_on`은 최종 승인까지 이어진 성공 수행 회차의 **현장 완료 KST 날짜**다. 원 계획일, 이월 대상일, 업로드일, 검수일로 바꾸지 않는다.
- 자정 또는 일요일/월요일 경계에서 offline client 시각과 server 기준이 충돌하면 자동 귀속하지 않고 관리자 확인 상태로 둔다.
- 지급 전후를 막론하고 earning 원본 금액을 덮어쓰지 않는다.
- 정정은 signed append-only adjustment event로 추가한다. 음수 adjustment는 실제 선행 entitlement/adjustment의 오류 정정 또는 reversal에만 허용한다.
- `reversal_of`는 실제 선행 원장을 FK로 참조하고 같은 provenance·maid·통화와 금액 관계를 검증한다. 존재하지 않거나 다른 메이드·통화·출처의 원장을 임의로 상계하지 않는다.
- 컴플레인 벌점은 음수 adjustment를 자동 생성하지 않는다.

### `[확정 — 2026-09-10 #94 보강]` 지급

- 메이드·주차별 payroll cycle은 한 건이다.
- `locked_earning_ids uuid[]` 같은 배열이 아니라 `payroll_items`로 earning을 정규화한다.
- `payroll_items.earning_id`는 전 cycle에 걸쳐 UNIQUE여야 같은 수익을 두 번 지급하지 않는다.
- 지급 snapshot 금액은 포함 item의 DB 합계와 같아야 한다.
- 지난주 cycle이 아직 `OPEN`이면 늦게 승인된 해당 주 earning을 지난주 cycle에 포함한다. 이미 `PAID`라면 원 지급을 바꾸지 않고 다음 주 adjustment로 넘긴다.
- 현재 진행 중인 KST 주차에는 지급 command를 허용하지 않는다.
- earning과 adjustment를 합산한 payable amount가 0 이하이면 `OPEN → PAYING`을 허용하지 않고, 0원 `PAID` event도 만들지 않는다. 남은 음수·0원 residual adjustment는 다음 positive cycle로 이월한다.
- 기본 전이는 `OPEN → PAYING → PAID`다.
- 송금 결과가 불확실하면 `PAYING → CHECK`로 둔다. 외부 송금이 없었음을 재확인한 actor와 시각, `NO_TRANSFER_CONFIRMED` reason을 기록한 경우에만 `PAYING → OPEN` 또는 `CHECK → OPEN`으로 되돌린다.
- OPEN 복귀 뒤 재시도는 기존 지급 event를 재사용하지 않고 새 payment attempt/event로 시작한다. `PAID → OPEN`은 금지한다.
- UI에서 “미지급으로 되돌리기”를 제공하더라도 이미 실제 송금된 기록을 삭제하거나 조용히 OPEN으로 바꾸지 않는다. `PAID` cycle은 불변이며 이후 cycle의 정정/상계 adjustment로만 바로잡는다.
- 외부 송금 연동 전에는 실제 지급이 실행된 것처럼 응답하지 않는다.

현재 제품은 은행/provider에 송금을 요청하지 않는다. active business admin이 외부에서 잠긴 payable 전액을 송금했음을 확인한 결과만 기록하며 일부 지급을 `PAID`로 확정하지 않는다. payment method는 source-controlled code를 사용하고 provider/reference ID는 형식·길이를 제한하며 PII·secret을 금지한다. `paidAt`은 server 시각이고 actor, cycle `expectedVersion`, idempotency key/request hash, audit을 필수로 한다. 영수증 파일·계좌번호·수취인 개인정보는 저장하지 않으며 실제 송금을 확인하기 전 `PAID` 응답을 반환하지 않는다. 향후 실제 provider 연동이 별도로 확정되면 lock/pay command는 대상 earning을 일정한 순서로 잠그고, 외부 호출을 DB transaction 안에서 기다리지 않으며 idempotency key와 provider reference로 결과를 조정한다.

---

## 10. 인증, 계정 수명주기, PIN

### `[확정]` 계정

- 인증의 불변 기준은 Auth user ID와 profile UUID다. 표시 이름이나 로그인 alias가 PK가 아니다.
- 휴대폰 전체 번호를 정규화해 중복을 검사한다. 같은 번호의 활성 계정이 있으면 생성을 막고, 비활성/퇴사 계정이면 새 계정 대신 기존 계정 복구 흐름으로 보낸다.
- 동명이인은 안정적인 suffix를 가진 login ID/alias로 구분하며 한번 부여한 suffix를 비활성·퇴사 후에도 재사용하거나 당겨 붙이지 않는다.
- 내부 Auth 이메일은 서버 전용이며 API에 노출하지 않는다.
- 관리자·메이드 최초 발급과 관리자 초기화 로그인 비밀번호는 등록 휴대폰 번호 뒤 4자리이며, 다음 로그인에서 개인 비밀번호로 바꾸게 한다. 개인 비밀번호는 선행 0을 허용하는 숫자 6~72자리 또는 10~72자의 영문 대·소문자·숫자·특수문자 조합이다. 단일 developer는 bootstrap 시 강한 개인 비밀번호를 대화형 입력으로 직접 설정하며 CLI 인자·출력·Git·로그에 남기지 않는다. 객실 PIN과는 완전히 별개다.
- Supabase Auth에는 4자리 임시값을 서버 내부 namespace로 변환해 전달한다. 사용자가 입력하는 값은 계속 휴대폰 뒤 4자리이며 변환값은 클라이언트·로그·알림에 노출하지 않는다.
- 초기/초기화 비밀번호 상태에서는 `must_change_password`를 강제하고 비밀번호 변경·로그아웃 외 일반 운영 API를 열지 않는다.
- 로그인 5회 실패 시 **5번째 실패 시각부터 고정 15분** 잠근다. 추가 실패가 잠금 종료를 계속 미루지 않게 한다.
- 비밀번호 초기화는 실패 횟수·잠금을 초기화하고 기존 refresh/session을 폐기한다.
- 성공 로그인도 실패 횟수와 이미 만료된 잠금을 초기화한다.
- 역할·상태는 매 요청 최신 DB profile로 확인한다. 사용자 수정 가능한 JWT metadata만 신뢰하지 않는다.
- 마지막 활성 관리자의 비활성화·퇴사·삭제·관리자→메이드 역할 변경은 경쟁 상황에서도 거부한다.
- 새 login ID 최초 성공 로그인, 이전 alias 폐기, 현재 기기를 제외한 기존 세션 폐기를 한 원자 command로 처리한다. alias retirement와 계정 재활성화 이력을 보존한다.

### `[확정]` 비활성화

- 새 업무 배정은 즉시 막는다.
- 정상 현장 완료 후 미제출인 업무에는 capability 발급 시각부터 최대 24시간, 동결된 assignment revision 범위에서 사진 업로드·검증·유효한 전체 제출을 허용할 수 있다.
- 청소 진행 중 비활성화는 관리자가 `현재 한 건 마무리` 또는 `즉시 중단·인계`를 선택한다. 전자는 현재 in_progress 한 건만 허용하며 새 시작·다른 assignment는 금지한다. execution capability는 발급 후 2시간 hard expiry이고 field_completed 시 즉시 종료한다. 만료 후 수행 권한은 종료하며 관리자 handover가 필요하다.
- 즉시 중단·인계는 기존 attempt를 interrupted로 종결하고 execution capability를 회수하며 새 maid의 새 scheduled attempt를 만든다. 이전 maid의 complete·current attempt 재활성화는 금지한다.
- 즉시 중단·인계된 이전 메이드에게는 증빙 업로드만 허용한다. current submission 생성, 검수, earning 연결은 금지한다.
- 어떤 제한 capability도 일반 maid 권한이나 관리자 권한을 주지 않는다.
- 별도 opaque login secret/bearer capability token/복구 인증키를 만들지 않는다. 기존 Supabase Auth user와 유효·미폐기 session, 허용 limited profile state, 미만료 DB capability, 정확한 attempt/revision, allowed action을 전용 endpoint에서 모두 검증한다. upload/submit capability도 profile/attempt/revision/발급·만료/actions에 bind한다.
- 일반 API의 active-profile guard는 유지한다. session이 revoke됐거나 refresh 불가능하면 우회 credential을 발급하지 않고 관리자 handover/reassignment로 처리한다. 현재 일반 비활성화의 session 폐기/Auth ban 계약 변경은 #7B에서 별도 검증하며 #4에서 변경하지 않는다.
- API와 RLS가 같은 capability matrix를 사용해야 한다.

### `[확정 — 2026-09-04 #69]` 객실 PIN

- 로그인 비밀번호와 별도 암호키/수명주기로 관리한다.
- 프런트 입력은 PIN 숫자 부분만 받으며 `^[0-9]{4,8}$`를 만족하는 문자열이어야 한다. 숫자형으로 변환하지 않고 `0256`, `00000001` 같은 선행 0을 보존한다.
- 서버는 요청의 `room_id`로 현재 `rooms.room_number`를 다시 조회하고 저장·표시용 canonical credential을 `<room_number>-<pin_digits>`로 조합한다. 클라이언트가 보낸 객실번호 prefix를 신뢰하거나 다른 객실 credential 생성에 사용하지 않는다.
- DB에는 canonical credential 전체를 AES-256-GCM으로 암호화한 ciphertext, 12-byte random nonce, authentication tag, key version과 bounded nonsecret AAD context(`format/environment/projectRef/roomId/pinVersion`)를 private immutable revision으로 저장하고 current pointer만 CAS 갱신한다. 복구 프로젝트에서는 runtime context가 아니라 revision에 저장된 exact context로 복호화한다. 키는 DB와 분리된 secret manager에 두며 public table, 감사, outbox, 로그에는 평문이나 암호문을 저장하지 않는다.
- PIN 접근 자격(entitlement)과 최대 30초 원문 reveal lease를 분리한다. entitlement는 assignment 저장·알림 outbox가 같은 transaction에서 확정되는 시점부터 정확한 assignment/room/maid/PIN revision에 귀속되며 `availableFrom` 전이라도 이미 알림된 본인 담당이면 유효하다.
- entitlement는 현장 완료, 업로드 대기, 제출 완료, 검수 대기 동안 유지한다. 최종 승인·반려, 취소 승인, 재배정으로 담당 교체, 계정 비활성화 workflow의 권한 정리 중 하나가 확정되면 원자적으로 종료한다. 알림되지 않은 다른 메이드와 과거 담당자는 접근할 수 없다.
- 권한 있는 사용자가 특정 객실에 명시적으로 조회할 때만 서버가 복호화한다. reveal은 매번 live session, 현재 entitlement 소유권, room/assignment/PIN revision과 종료 여부를 재검증한다. `availableFrom`과 attempt `scheduled|in_progress`만으로 장기 자격을 제한하지 않는다.
- 응답은 `Cache-Control: no-store`를 사용하고 클라이언트는 응답의 남은 TTL(최대 30초)과 `expiresAt` 중 더 이른 시점, 화면 이동, background/pagehide, 기기 잠금, 담당 해제, 출입 재잠금 때 평문을 메모리에서 지운다. 만료된 reveal은 평문을 반환하지 않는다. clipboard, service worker cache, offline queue, 영속 브라우저 저장소에 넣지 않는다.
- reveal lease는 entitlement에서 파생되는 최대 30초의 별도 단기 원장이다. PIN 변경은 열려 있는 reveal lease와 과거 revision을 즉시 무효화하고, 현재 담당자 및 이미 알림된 다음 근무일 담당자의 entitlement를 새 revision으로 원자 갱신한다. PIN 조회·변경은 CAS와 감사 event를 남기며 메이드 변경은 기존 정책대로 exact `in_progress`에서만 허용한다.
- 관리자 변경은 PIN 변경 lease 선점 → 실제 도어락 변경 → confirm/save 순서로 조정한다. prepare 즉시 mismatch가 되어 실제 체크인 전이와 PIN 조회를 차단하지만 예약 생성·변경·배정은 차단하지 않으며, confirm 전에는 current pointer를 바꾸지 않는다. 만료·불확실 상태는 실제 PIN 재입력 후 새 revision confirm 또는 기존 current의 confirmed physical rollback으로만 종결한다. current가 없는 최초 변경이 만료된 경우에도 실제 PIN 재입력으로 version 1을 수립할 수 있다.
- PIN 평문을 URL, 로그, error, audit payload, notification, analytics, Git, 브라우저 저장소에 넣지 않는다.
- `[확정 — 2026-09-13 #136]` Google Sheets는 DB PIN current revision의 단방향 운영 projection이다. `room_number`를 business identity로 bounded board에서 정확히 한 행만 갱신하고, equal-version 변조는 DB 정본으로 복구하며 Sheet-ahead/중복 identity/불확실 write는 operator-blocked한다. 전용 service account는 spreadsheets-only scope를 쓰며 source-controlled approved target 검증을 PIN 복호화·OAuth보다 먼저 수행한다. hosted target mapping과 full resync/운영 활성화는 #137/release 승인 전에는 없다.
- `[확정 — 2026-09-16 #169]` 빈 DB의 PIN 미설정 상태는 예약 업무를 중단시키지 않는다. active admin 전용 bounded bootstrap command는 서버 CSPRNG로 batch 안에서 중복되지 않는 정확히 4자리 숫자를 생성하고 선행 0을 보존해 객실번호와 조합·암호화한 version 1 revision/current를 수립한다. 고정 초기 PIN deployment secret은 사용하지 않는다. bootstrap은 current PIN 또는 unresolved mismatch가 있는 객실을 덮어쓰지 않고 건너뛰며 batch 최대 25건과 멱등 receipt를 유지한다.
- `[확정 — 2026-09-16 #169]` generated PIN은 생성 직후 `mismatch`이며 Sheet outbox를 만들지 않는다. admin만 30초 reveal lease와 `Cache-Control: no-store` 응답에서 credential을 확인할 수 있고, 평문/envelope는 command receipt·로그·감사·알림에 저장하지 않는다. 메이드와 일반 reveal은 이 상태를 열람할 수 없다. 관리자가 실제 도어락 적용을 version CAS와 새 idempotency key로 확인한 뒤에만 `verified` sync event와 Sheet outbox를 원자적으로 기록한다.
- `[확정 — 2026-09-13 #140 보강]` 일반 PIN prepare와 bootstrap은 private `(key_version, nonce)` reservation을 공유한다. 같은 실제 PIN 암호키는 keyring 구성에서 여러 version 이름으로 중복 등록할 수 없고, 같은 key version과 12-byte nonce는 객실·AAD가 달라도 서로 다른 암호화에 재사용할 수 없다. prepare가 만든 envelope를 confirm이 그대로 revision으로 승격하는 것은 같은 논리 암호화이므로 reservation을 재사용한다. 52→53 upgrade에서 matching confirmed lease/revision은 한 reservation으로 backfill하며, 서로 다른 과거 암호화의 충돌이 발견되면 원 이력을 삭제·변환하지 않고 migration 전체를 fail-closed한다.
- bootstrap 성공의 `initialized`는 그 batch transaction에서 신규 revision/current/mismatch sync/audit가 확정된 객실이고, `skipped`는 기존 current PIN 또는 미해결 물리 변경을 보존하기 위해 의도적으로 건너뛴 객실이다. 검증 오류를 `skipped`로 숨기지 않으며 DB validation 오류는 batch transaction 전체를 rollback해 업무 원장 변경 0건으로 끝난다. timeout·응답 유실은 rollback 증거가 아니므로 같은 `Idempotency-Key`로 receipt를 재생하고, 아직 현장 확인 전이면 새 30초 admin reveal lease로 같은 암호화 revision을 다시 확인한다.
- `[확정 — 2026-09-13 #137 source]` developer/admin은 `pending`, `failed`, `operatorBlocked`, `oldestPendingAt`, `lastSuccessAt`, `lastErrorCode`와 CAS version만 조회한다. full resync는 서버가 요청 시점의 정확한 121실 room/PIN current snapshot을 만들고 global singleton fence의 유일한 provider permit으로 `A1:H122`를 DB 정본에서 재작성한다. 요청·claim은 environment/project/spreadsheet/tab 전체의 source-controlled SHA-256 target identity에 묶이며 mapping 변경·stale snapshot·경쟁은 fail-closed한다. 성공 marker 이전에 생성된 snapshot-room incremental/uncertain 작업만 supersede하고 이후 PIN 변경은 보존한다. Sheet→DB 입력, PIN/envelope/credential/token/raw Google response 공개, production mapping·활성화는 금지한다.
- `[현재 구현 — Issue #194 production source 배포, hosted 활성화 별도]` 64번째 append-only migration은 exact typed delivery outbox를 source evidence로 고정한 private immutable entitlement ledger와 30초 reveal lease를 연결한다. 최초 grant는 active/password-complete actor만 허용하고, PIN rotation successor는 current workflow와 객실별 최소 미래 service date의 이미 통보된 assignment만 허용한다. deactivation 진행 상태에는 신규 successor를 만들지 않고 inactive/departed 최종 정리에서 남은 entitlement/reveal을 닫는다. DB/API 배포 완료는 hosted provider·Google Sheets/Cron 활성화나 실제 PIN mutation smoke 완료를 뜻하지 않는다.

### `[확정]` 개인정보 보존

- 고객 이름은 운영 event에 복제하지 않고 암호화된 예약 개인정보 필드에만 두며 관리자 예약 상세에서만 표시한다.
- 고객 이름은 체크아웃 후 180일, 투숙 전 취소는 취소 후 180일에 원문을 삭제한다. 예약·객실·시각·상태 이력은 예약 ID와 `익명 고객` 표시로 유지한다.
- 직원 휴대폰 원문은 운영·감사 event에 넣지 않는다. 퇴사 완료 180일 후 개인정보 저장소·검색 index·cache에서 삭제하고, 중복 가입/재입사 비교용 비가역 server-key hash만 남긴다.
- 자유입력에는 고객 이름·휴대폰·이메일 입력 금지를 안내하고, server에서도 탐지·마스킹하되 원문을 audit에 복제하지 않는다.

---

## 11. 사진 저장과 보존

### `[확정]` 저장 보안·Google Drive / `[배포 전]` 운영 계정·OAuth

- 확정된 계약은 비공개 저장, 서버 중계, opaque locator다. 브라우저가 storage token/file ID를 받거나 공개 링크를 만들지 않는다.
- 사진 저장 provider는 Google Drive로 확정됐다. API에는 보안과 결합도 완화를 위해 Drive file ID, OAuth token, provider 세부를 노출하지 않는다.
- 아직 배포 전인 항목은 전용 Google 운영 계정, OAuth 자격증명 주입, 실제 용량 감시와 비용 운영이다. 이를 provider 미확정으로 해석하지 않는다.
- DB에는 opaque storage locator, hash, MIME, 크기, 소유 관계, 보존 상태를 둔다.
- 사진 record 작성과 purge는 서버 command/worker만 수행한다.
- 삭제 worker는 DB 상태, 만료 시각, 참조 관계를 다시 확인하고 멱등적으로 원본·파생본·캐시를 정리한다.

### `[확정 — 2026-09-17]` 도메인별 보존 기간

- Google Drive에만 저장한다. Supabase Storage에는 사진 객체를 저장하지 않는다.
- 프런트에서 JPEG/WebP를 300KiB 이하로 압축하고 서버도 크기·magic bytes·MIME·EXIF 제거를 검증한다.
- 비공개 KST 업로드 일자/객실 폴더에 정리한다.
- 청소 제출 사진은 최종 검사 결정 전 원본·미리보기·캐시를 보존하고 승인 또는 반려의 `decided_at + 168 hours`에 삭제한다. 검수 대기 시간이 길어져도 먼저 삭제하지 않는다.
- 객실 이슈·컴플레인 증빙은 해결 또는 종결 시각부터 180일, 중단 업무·동기화 충돌 증빙은 관리자 해결 시각부터 180일 보존한다.
- 어떤 도메인에도 연결되지 않은 진짜 orphan만 provider 업로드 시각부터 30일 뒤 삭제한다. 늦게 연결되는 업로드와 worker claim의 race를 CAS/fence로 막는다.
- 사진 record는 정책 종류, 기산 사건, `retentionStartsAt`, `expiresAt`, `purgedAt`, `mediaAvailability`를 설명하며 원본 삭제 뒤에도 제출·slot·검사·수행자·시각 metadata를 영구 보존한다.
- 실제 수행 메이드와 권한 있는 admin은 만료 전까지 content를 읽을 수 있다. 다른 maid와 권한 없는 actor는 거부하고 모든 content 응답은 `Cache-Control: no-store`다.
- worker는 Drive `files.delete`로 영구삭제하고 404를 멱등 성공으로 처리한다.

Google Drive 운영 계정과 OAuth 자격증명은 아직 외부 배포 전제다. 자격증명 없이 provider가 연결됐다고 가정하거나 worker를 배포하지 않는다. 용량 보호 기준은 현재 #9의 10GB 경고/12GB 업로드 차단 계약을 따른다.

### `[확정: #84 착수 승인]` 서버 중계·응답 유실 복구 경계

- 파일명은 서버 사전발급 opaque app `object_id`이며 canonical photo version은 finalize에서 연결한다. Drive ID를 브라우저에 노출하지 않는다.
- raw body는307200 bytes까지이며 MIME/magic·전체 decode·metadata 제거·최종 출력 검증을 서버가 수행한다. decoder pixel/frame/CPU/memory 상한은 기술상한으로 검증하고 제품 사진 개수 정책으로 승격하지 않는다.
- 서버가 preallocated identity/부모/MIME/size/실제SHA를 검증한 Google immutable `createdTime`을 최초 업로드 성공시각으로 사용한다. create에서 시간값을 지정하지 않고 응답 유실/409에서도 같은 clock을 복구한다. 원문 client 촬영시각·retry 수신시각으로 보존기한을 연장하지 않는다.
- 사전예약 KST 폴더 날짜와 실제 provider 생성 날짜가 다르면 acceptance를 거부한다. 이미 생성된 identity는 move/rebind하지 않고 미수락 여부와 fence를 확인한 보상 경로만 사용한다.
- limited upload_evidence는 슬롯/업로드/상태 접근만 허용하며 사진 원본 read 권한이 아니다. 원본은 active admin 또는 본인 현재 회차의 active maid를 응답 직전까지 재검증한다.
- 업로드 accepted는 물리적 완료/전체 제출/검수/ready/수익 상태를 암묵 생성하지 않는다. 63번째 retention v2 candidate는 #31 최종 검사 결정과 사건 종결을 anchor로 사용하지만, Google provider/Cron 운영 활성화는 별도 gate다.

---

## 12. 알림과 감사 이력

### `[확정]` 알림

- 앱 알림함은 영속 데이터다. 푸시는 그중 즉시 행동이 필요한 사건의 전달 수단이다.
- 관리자와 메이드의 수신 대상을 분리한다.
- 사용자가 자기 행동으로 만든 변화는 자신에게 푸시하지 않는다.
- `requiresAction`과 즉시 push 전달 가치는 독립 축이다. `requiresAction=false`인 취소·회수·결정·현장 완료 같은 정보성 알림도 source-controlled catalog의 `push_eligible=true`이면 push할 수 있으며, 이를 위해 inbox의 행동 필요 상태를 거짓으로 올리지 않는다.
- push outbox는 catalog의 `push_eligible`, actor와 recipient가 다름, 수신자의 active·비밀번호 변경 완료 상태를 모두 만족할 때만 만든다. inbox 원장은 계정 상태와 무관하게 domain transaction에서 보존하고, inactive 또는 임시 비밀번호 상태에는 push를 전달하지 않는다.
- 같은 객실·같은 사건 종류의 10분 이내 업데이트는 group key로 묶을 수 있다.
- deep link payload에는 안정적인 entity ID만 넣고 PIN·고객 개인정보·민감 메모를 넣지 않는다.
- notification의 recipient, title, body, category, deep link는 생성 뒤 수신자가 수정하지 못한다. 수신자는 본인 `read_at`만 좁은 command로 바꿀 수 있고 `resolved_at`은 관련 domain command만 갱신한다. 해결된 알림도 삭제하지 않는다.
- notification 원장과 delivery outbox/device subscription을 분리한다.
- outbox는 재시도, provider response, 최종 실패를 기록한다.
- push 거부·지연·최종 실패는 담당, 수행, 검수 같은 domain 상태를 되돌리거나 바꾸지 않는다.

### `[확정: #110]` Web Push 구독 원장

- 구독은 exact active/password-complete admin·maid 본인과 live Auth session에만 결합한다.
- 원문 endpoint와 `p256dh`/`auth`, exact Auth session binding은 private AES-256-GCM current envelope에만 두고 API·알림·감사·로그에는 노출하지 않는다. session UUID 평문 metadata column은 만들지 않는다.
- session당 active 1, profile당 최대 5이며 자동 LRU나 교차 profile endpoint 이전은 하지 않는다.
- 같은 material replay는 같은 logical result를 반환하고, 변경은 현재 logical ID/version CAS의 새 immutable revision이다.
- retire는 같은 transaction에서 current secret을 crypto-shred하며 retired logical subscription은 재활성화하지 않는다.
- 구독 원장/API는 provider 전송과 분리한다. delivery worker는 #111, VAPID/provider/외부 HTTP/Cron/production secret은 #112만 소유한다.

### `[확정]` 감사 이력

- 예약·점유·운영 차단·PIN·청소·담당·제출·검수·수익·지급·계정의 중요 변경을 기록한다.
- 감사 event, 결정, earning, payroll snapshot 같은 원장은 UPDATE/DELETE하지 않는다. 잘못된 값은 correction/reversal event로 고친다. current pointer, projection, `read_at`, CAS version처럼 명시적으로 mutable한 파생 상태는 과거 이력을 파괴하지 않는 조건에서 갱신할 수 있다.
- 최소 `actor`, `entity`, `action`, `effective_at`, `recorded_at`, reason code, command/idempotency ID를 남긴다.
- 고객명, 전화번호, PIN, 사진 원문은 audit payload에 복제하지 않는다.
- 확인 모달과 undo UX는 서버 정합성의 대체물이 아니다. 서버는 stale version과 중복 command를 독립적으로 막는다.

---

## 13. API와 DB 구현 계약

### 명령 API

중요 mutation은 임의 table DML이 아니라 의도를 드러내는 command로 만든다.

예:

- `createReservation`, `changeReservation`, `cancelReservation`
- `manualCheckout`
- `submitAvailability`, `requestAvailabilityChange`
- `previewAssignments`, `commitAndNotifyAssignments`, `changeAssignment`, `requestAssignmentCancellation`, `interruptAndHandover`
- `startCleaning`, `completeFieldWork`, `createSubmissionVersion`
- `decideBombRoom`, `approveSubmission`, `rejectSubmission`
- `lockPayroll`, `recordPaymentResult`, `reopenUnsentPayroll`

모든 재시도 가능한 mutation은 다음을 갖는다.

- request: `idempotencyKey`, 필요한 `expectedVersion`, 안정적인 entity ID
- success: entity `id`, 새 `version`, `effectiveAt`, `recordedAt`
- error code: `STALE_VERSION`, `CONFLICT`, `FORBIDDEN`, `DUPLICATE`, `OUTSIDE_WINDOW`, `INVALID_TRANSITION`, `NOT_FOUND`

한국어 toast 문구를 API error 계약으로 사용하지 않는다.

취소·담당 변경·검수·지급·계정 비활성처럼 영향이 큰 command는 현재 영향 대상과 version을 먼저 조회하고, 확정 요청에 `expectedVersion`/impact fingerprint와 정해진 reason code를 보낸다. 확인 modal은 오조작 방지 UX일 뿐 권한 증명이 아니며, 일반적인 DELETE/undo endpoint 대신 명시적 cancel, reopen, correction command를 제공한다.

### transaction

- 상태 전이, audit, notification/outbox, earning/reclean side effect를 같은 짧은 transaction으로 commit한다.
- transaction 안에서 Drive, push, 향후 송금 provider 같은 외부 HTTP 호출을 기다리지 않는다.
- 여러 row를 잠글 때 항상 같은 순서로 잠가 deadlock을 줄인다.
- 조회 후 INSERT를 분리하지 말고 UNIQUE + `ON CONFLICT` 또는 조건부 UPDATE를 사용한다.
- idempotency record는 최소 `(actor_id, command_type, idempotency_key)` UNIQUE와 canonical request hash를 가진다. 같은 key와 같은 payload는 기존 결과를 반환하고, 같은 key에 다른 payload가 오면 `CONFLICT`로 거부한다.
- command 성공 결과를 idempotency record에 보존해 응답 유실 뒤 같은 요청에 같은 결과를 반환한다.

### RLS와 권한

- public base table은 모두 RLS를 활성화한다.
- `anon`에는 업무 table 권한을 주지 않는다.
- RLS는 활성 계정 상태와 실제 ownership을 함께 검사한다.
- 관리자라는 이유만으로 업무 원장에 `FOR ALL` + DELETE를 주지 않는다.
- 메이드에게 attempt 전체 컬럼 UPDATE, 임의 상태 submission INSERT, notification 전체 UPDATE를 주지 않는다.
- 조회는 필요한 범위의 SELECT, 쓰기는 좁은 서버 command adapter 또는 고정 `search_path`의 검증된 RPC로 제한한다.
- `SECURITY DEFINER` 함수는 명시적 schema, 최소 EXECUTE 권한, actor 재검증, 안전한 `search_path`를 사용한다.
- view는 `security_invoker = true`를 사용한다.
- service-role/secret은 서버 runtime에만 두고 로그·브라우저에 노출하지 않는다. service role은 RLS를 우회하므로 Fastify 또는 Edge command adapter가 access token의 actor를 식별한 뒤 최신 DB role/status, ownership, capability, expected version, transition을 매번 다시 검증한다.

### 관계·제약·index

- FK가 존재하는 것만으로 업무상 동일성이 보장된다고 가정하지 않는다. 필요하면 복합 UNIQUE/FK 또는 constraint trigger를 사용한다.
- PostgreSQL은 FK index를 자동 생성하지 않으므로 join, RLS, delete/cancel 경로의 자식 FK를 index한다.
- soft-active, current revision, pending queue처럼 항상 같은 predicate로 조회하는 경로에는 실제 query와 맞는 partial index를 고려한다.
- 필수 관계·유일성·상태/시각 일관성을 JSONB application validation에만 맡기지 않는다.
- 돈은 정수 원 단위로 저장하고 float를 사용하지 않는다.

---

## 14. 현재 구현 상태와 알려진 차이

이 절은 “다음 작업이 어디서 시작하는가”를 설명한다.

### `v0.1.0` 기준선 (`main@70e479e`)에 구현됨

- `GET /health`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `GET /v1/rooms`
- 계정 생성·alias·강제 비밀번호 변경·잠금·세션 폐기·마지막 활성 관리자 보호
- 121실/4타입 seed
- 활성 예약의 `tstzrange` exclusion
- cleaning/payroll 관계 무결성과 partial unique index
- public table RLS 활성화, active 계정 기반 helper, notification 수신자의 `read_at` 한정 UPDATE
- application/migration GitHub Actions의 fresh DB reset과 SQL test
- 운영·복구검증 Supabase에 같은 기준 스키마가 적용돼 있으나, 초기 수동 적용 과정에서 Git과 서로 다른 migration version으로 기록됨

### `v0.2.0` 이후 source 통합 이력과 현재 `v0.4.0` 상태

아래 개별 Issue의 `production 미승격` 문구는 각 source/dev 병합 시점의 이력이다. 현재 production 정본은 문서 상단의 Issue #220/PR #221 snapshot을 우선하며, source/bundle 반영과 hosted provider·Google·Cron 활성화를 별도 상태로 해석한다.

- DBML/ERD도 review draft다. 현재 migration의 table 수와 DBML의 32개 table 수를 완성도 지표로 사용하지 않는다.
- #25~#29 배정 revision/current pointer·순서·commit·pre-start·activation·preview와 #4 notified-only 조회는 source/dev 완료 후 현재 `main`/production source에 반영됐다. 다만 #28 lifecycle effect를 포함한 hosted 역할별 positive smoke는 별도 미완료 gate다.
- #7A 실행 → #7B 인계/limited capability → #7C offline, #30 photo slot → #83/#84 Drive 원장·HTTP → #85 purge worker와 #31 제출·검수까지 source/dev 완료했다. #7C는 PR #79로 `dev@e2648de4e40a84e60d19cbb1e4d01974a2f3d369`에 통합됐고 production purge 주기·hosted/client offline E2E는 별도 운영 gate다.
- #30~#31의 당시 개발 통합 기준은 `dev@f22005d8af6087a3bbab215c76cf7cc7e45b49fb`, 34 migrations / 74 paths / 80 operations이었다. #31의 전체 제출·폭탄방 신고/선판정·검수 승인/반려·원 maid 재청소 source는 현재 `main`/production `api` bundle에 반영됐지만 hosted 역할별 positive smoke는 미확인이고 inspection queue pagination은 비차단 P2 후속이다.
- #93/#95/#96의 원청소 earning 기반 주차 조회·`OPEN → PAYING`·bounded pagination은 `dev@e55f0e9be2f26a1a3700b8d31ba1958dcbe65b3d`, 36 migrations / 77 paths / 83 operations에 source 통합됐다. #94는 typed compensation provenance, complaint/appeal/correction, signed adjustment/carry-forward, 외부 지급 결과·`CHECK/PAID` command 정책을 확정했고, source 구현 상태는 아래 #100과 후속 #101~#103 항목에서 각각 추적한다. main/recovery/production을 변경하거나 향후 병합 SHA를 선기록하지 않는다.
- #100 complaint/appeal/correction source는 PR #104로 통합됐고 현재 `main`/production source에도 반영됐다. 원 승인 수익의 typed FK chain, 30일 접수, immutable decision/response/event와 current pointer CAS, live-session RLS 및 `no-store` 계약을 유지한다. hosted 역할별 read/positive mutation smoke는 미확인이므로 source 배포만으로 현재 사용 ✅로 판정하지 않는다.
- #101 complaint 재작업/typed compensation earning은 PR #105로 `dev@a5c48673ff339e5a338356c77ce83e8cf40ee21a`에 통합됐으며 38 migrations / 86 paths / 93 operations다. confirmed current decision을 typed `post_approval_complaint_reclean` target과 연결하고 server가 안전한 당일 접근 창을 증명한 경우에만 published template·notified assignment·assignee·amount를 admin CAS로 고정한다. 같은 maid는 amount 0 decision만 보존하고 earning 0건, 다른 maid는 현장 완료와 승인 뒤 amount가 0이어도 typed entitlement/earning 각 1건을 생성한다. 원청소/compensation earning은 nullable typed FK exactly-one CHECK이고 기존 #31 identity를 보존한다. pre-start semantic correction과 generic reassignment는 ghost/assignee drift를 막으며, 시작 뒤 correction은 operational source/current divergence를 노출한다. raw compensation decision은 live-session admin만 읽고 maid projection은 cross-maid UUID/타 보상액을 숨긴다. developer 감사에는 두 #101 event의 safe summary만 노출하고 raw state/request hash/maid cross-sensitive 필드는 제외한다. main/recovery/production은 변경하지 않았고 현재 사용 가능을 뜻하지 않는다.
- #102 signed adjustment/carry-forward는 PR #106으로 `dev@cb26650221b3e47804edafd51cad5bfc8872c349`에 통합됐으며 39 migrations / 90 paths / 97 operations다. correction은 earning 또는 adjustment 한 건의 typed FK와 signed delta를 보존하고, reversal은 source의 미반전 전액을 정확히 반대 부호로 한 번만 기록하며 root cumulative entitlement가 0 아래로 내려가지 않는다. payment-start와 adjustment command는 receipt → global advisory → actor → adjustment book → cycle → sorted source 순으로 잠근다. net이 0 이하면 payment event 없이 immutable offset settlement로 OPEN cycle을 경제적으로 동결하고, 음수 크기만 바로 다음 KST 주차로 한 칸씩 이월한다. PAID/offset-settled cycle의 late earning은 명시적 admin command가 원본을 수정하지 않고 다음 주차의 positive `late_earning_carry` adjustment로 한 번만 옮긴다. 공개 조회는 signed adjustment/carry/payable과 `offsetSettled`를 bounded projection으로 제공하며 live-session RLS, audit/outbox, Fastify/Edge/OpenAPI parity를 유지한다. main/recovery/production에는 승격하지 않았다.
- #103 외부 전액 지급 결과는 PR #107로 `dev@3297679ca2e903e68cfa2dd9e7bc137341c5b27d`에 source/dev 통합됐으며 40 migrations / 93 paths / 100 operations다. 기존 `payment_started` event를 immutable attempt identity로 연결하고, `TRANSFER_RESULT_UNCERTAIN` CHECK, `NO_TRANSFER_CONFIRMED` OPEN 복귀, 양수 locked snapshot 전액 PAID result를 typed append-only evidence로 보존한다. 40번째 migration 이후의 payment projection transition과 event/attempt/result 양쪽은 deferred commit invariant로 서로를 exact하게 요구하며 과거 CHECK/PAID evidence는 추측 backfill하지 않는다. client amount/`paidAt`은 받지 않고 server time과 cycle CAS를 사용하며 OPEN 복귀 뒤 재시작은 새 attempt다. 최초 method는 `bank_transfer`, reference는 8~64 ASCII allowlist·영문/숫자 필수·7자리 연속 숫자/URL-like 거부 뒤 uppercase canonical global unique다. 이 형식은 실제 provider 계약 미확정 동안의 fail-closed source 계약이며 canonical reference는 admin result에만 보이고 maid/developer/audit/notification에는 숨긴다. provider HTTP, 영수증·계좌·수취인 PII·secret/raw payload 저장은 없고 main/recovery/production은 변경하지 않았다.
- #108 알림함, #109 typed catalog/grouping/writer, #110 encrypted Web Push subscription, #111 delivery ledger/worker와 #112 VAPID/provider HTTP source까지 순차적으로 dev에 통합됐다. #112 승인 exact head `eb243c54ebf24cd932d70cb1c6423fa4f319c050`와 PR #119 병합 commit `dfc98b1474f9f890851d49bd904869181d0d7880`의 tree는 동일하고 독립 QA 98/100, P0/P1/P2 0, required `application`/`migration` PASS다. PR #122 문서 동기화와 #124 pgTAP fixture 안정화를 반영한 integration base는 `dev@569bbb62e07a484fe2f6aa67520d6f10797e44f5`이며 기능 snapshot은 45 migrations / 98 paths / 105 operations다.
- #73은 기존 45 migrations를 수정하지 않고 `cleaning_targets_reservation_room_fk`의 검사 시점만 기존 planned graph의 다른 복합 FK처럼 commit으로 맞추는 46번째 append-only migration이다. FK와 `CHECKOUT_PLANNED_CONTRACT_NOT_ATOMIC` commit trigger는 모두 유지된다. unassigned·draft room move, notified/checked-in 거부, command replay/rollback, 과거 notified room snapshot, room-change↔notify/checkout 경합을 source 회귀로 고정하며 public HTTP/OpenAPI 계약은 바꾸지 않는다.
- #46은 기존 46 migrations를 수정하지 않은 47번째 append-only private password-change receipt와 password-specific shadow version으로 source/dev에 통합됐다. `(actor, command, key)`와 시작 session digest, actor 단위 미완료 1건, lease/claim으로 Auth mutation을 직렬화하며 비밀번호 원문·변환값·hash/HMAC/verifier·token·raw session ID는 저장하지 않는다. `auth.users.encrypted_password`가 실제로 바뀔 때만 private trigger가 hash를 복사하지 않고 무작위 nonsecret version을 회전하며, response loss는 receipt version·현재 private version·재전송된 새 비밀번호를 모두 확인한 뒤 profile gate·다른 session revoke·audit exactly-once·receipt 완료를 한 transaction으로 수렴한다. release/main·production 승격은 별도 gate다.
- Issue #220/PR #221 후속으로 `main@80f935016d5581d500136fba29c206f6ee797bc0`, production 73 migrations, `api` ACTIVE v17, OpenAPI `0.4.0` 120 paths / 130 operations와 기존 5개 Edge bundle 구성이 반영됐다. 이번 release에서는 `api`만 재배포했고 다른 네 Worker 버전은 유지했다. GitHub Pages도 workflow run `35481531782`에서 같은 production OpenAPI를 다시 고정해 120/130 parity와 artifact hash 일치를 확인했다. 다만 tag/GitHub Release, 예약·PIN success mutation, Issue #112의 provider invoke secret·positive Web Push/heartbeat, Issue #137의 hosted Google target·서비스 계정·ACL·full resync/Cron smoke는 아직 완료 증거가 없다. source·bundle 배포와 운영 데이터/provider 활성화를 같은 완료 상태로 표시하지 않는다.
- #46, #128, #131, #136, #137, #140, #133의 source는 `dev`와 v0.3.0 production source에 반영됐다. #137의 API와 `room-pin-sheet-sync` bundle도 배포됐지만 hosted target/서비스 계정/ACL/Secrets/Cron/positive smoke는 미완료다. #156/#165 checkout template API와 선택형 duration 계약은 56번째 migration 및 `api` v16으로 production에 반영됐다. `standard`, `premium`, `oceanPremium`, `oceanFamily`의 checkout template은 각각 v7 exactly-one으로 게시됐고 슬롯 수는 10/11/13/15, `durationMinutes`는 모두 `null`이다. 이 게시 완료는 예약 success smoke의 대체가 아니며 안전한 fixture 부재로 해당 mutation은 명시적으로 SKIPPED 상태다.
- wireframe에는 퇴실점검을 관리자가 직접 완료하거나 퇴실 청소 현장 완료로 대체하는 동작이 있지만, 고정한 제품 정책 문서에는 이 lifecycle의 정본이 없다. 이를 현재 구현만 보고 schema/API로 확정하지 않는다.
- Issue #36과 v0.2.0 운영 smoke를 거쳐 Supabase-only production runtime을 채택했다. Fastify는 삭제하지 않고 개발·회귀 검증과 rollback 기준선으로 유지한다. 이후 dev source가 존재한다는 사실만으로 production 배포 또는 hosted 사용 가능을 선언하지 않는다.

원격 운영·복구검증 프로젝트는 Git과 SQL 내용은 대응하지만 migration version은 서로 다르다. `supabase db push`로 자동 추론하지 않고 `docs/RELEASE_V0.2.0.md`의 검증된 mapping과 MCP 순차 적용 절차를 사용한다. 2026-08-29 기준 운영 Security Advisor는 0건이며, 실제 source 병합·원격 적용·tag 상태는 Release Issue #24가 추적한다.

### Issue #1 `v0.2.0` 당시 source release 범위

다음 항목은 release candidate `4da80cb` 당시 계약이다. source가 `main`에 병합됐는지, 운영 migration까지 적용됐는지는 서로 다른 상태이며 Release Issue #24에서 확인한다. 특히 당시의 PIN 배정 차단 문구는 #140 이후 계약으로 대체됐고, 이 문서 갱신만으로 production 동작이 바뀌었다는 뜻은 아니다.

- 객실 목록·상세는 점유, 청소 필요, 배정 차단/가능과 안정적인 reason code를 독립 축으로 반환한다.
- 객실 기준정보, 운영 차단, 촛불, 이슈, PIN 동기화는 최신 active admin과 객실 `state_version`을 재검증하는 원자 명령이다.
- 예약 생성·일정 변경·취소·수동 체크아웃·시각 기반 전이는 예약/객실 lock, CAS, actor별 idempotency key와 request hash를 사용한다.
- 예약 일정 revision, 입실 준비 의무, 예약별 비공개 퇴실 청소 의무, 점유 event를 추가하고 원장을 UPDATE/DELETE하지 않는다.
- 고객명은 API 서버가 AES-256-GCM으로 암호화하며 명령 응답·감사 payload에 원문이나 암호문을 포함하지 않는다.
- 고객명 idempotency fingerprint는 암호화 키와 분리된 안정적 server HMAC pepper를 사용해 key rotation 전후 request hash를 보존한다.
- 예약 목록은 고객명을 반환하지 않고 관리자 단건 상세에서만 복호화한다. 체크아웃/취소 후 180일 보존 만료는 예약 전이 worker가 처리하며 멱등성 hash에는 암호화 키와 분리된 HMAC pepper fingerprint만 사용한다.
- 당시에는 PIN 원문을 저장하지 않고 동기화 상태와 version만 기록하며 `verified`가 아닌 객실의 고객 배정을 차단했다. **#140 이후 source 계약은 이를 대체해** `unconfigured`/`mismatch`를 예약 생성·변경·배정의 비차단 경고로 유지하고, 실제 체크인과 maid PIN lease/reveal/change만 `verified` 및 권한·lease 검증까지 fail-closed한다. production 적용은 별도 release/운영 승인 전까지 완료로 간주하지 않는다.
- 객실 전체 운영 projection은 관리자 전용이다. 메이드는 자신의 현재 배정·수행 범위 projection만 후속 업무 API에서 제공받는다.
- 연박/추가 수동 청소 요청은 안정적인 target ID로 생성하고 시작·PIN 공개 전까지만 CAS soft cancel한다.
- 예정 전이 worker는 production에서 활성 관리자 actor를 필수로 하며 시작 시 검증 실패를 숨기지 않는다. catch-up은 퇴실을 입실보다 먼저 처리해 같은 instant의 인접 예약을 한 batch에서 전이하고, 완전히 지난 미입실 예약은 가짜 check-in 없이 종결한다.
- checkout obligation↔target은 deferred commit-time 검증까지 포함해 종료 상태가 반쪽만 저장되지 않게 하고, preparation obligation↔승인 submission/attempt는 직전 점유 종료 이후·해당 체크인 이전 시간창 안에서 target 접근 가능 시각 이후 `attempt 시작 → 현장 완료 → 종료 → 제출 → 승인` 순서를 검증하며 append-only 1회 소비 원장까지 강제한다. PIN lease↔현재 assignment/attempt는 최신 verified PIN version까지 업무 동일성을 복합키와 DB 검증으로 강제한다.
- 다음 예약 변경은 종결된 과거 의무를 덮지 않는다. 미배정 target은 schedule revision으로 마감을 갱신하며 private 미통보 draft는 stale로 처리한다. 통보된 target은 명시적 재계획 전까지 충돌로 거부한다.
- 타입별 인원 상한, 프런트 대표 상태, 퇴실점검 lifecycle은 이번 변경에서 확정하지 않는다.
- Docker Desktop 복구 후 fresh local DB reset, 역할별 SQL 회귀 검사, DB advisor를 실행할 수 있다. 각 변경은 실제 실행 결과를 PR에 기록하며 실행하지 않은 검증은 완료로 표현하지 않는다.

### Issue #6 `v0.2.0` source release 범위

- 당시 가능일 제출은 일요일 12:00–23:59 KST와 다음 월요일 `week_start`만 허용했다. 이 시간창은 Issue #229의 현재·다음 주 상시 직접 제출 계약으로 대체됐다.
- 메이드·주차별 current version은 `expectedVersion` CAS와 advisory lock으로 직렬화하며 과거 version과 7개 날짜 row를 삭제하지 않는다.
- 마감 뒤에는 pending 변경 요청을 만들고 활성 관리자의 승인 시에만 새 current version을 추가한다. 반려도 결정·사유·행위자·시각을 보존한다.
- idempotency receipt는 `(actor_id, command_type, idempotency_key)` 범위다. 같은 범위의 같은 payload는 기존 결과를 반환하고 다른 payload 재사용은 거절하며, 다른 actor 또는 command의 같은 raw key는 독립 요청이다.
- 조회 RLS는 활성 관리자의 전체 범위와 활성 메이드 본인 범위만 허용하며, 직접 DML과 비활성·제한 capability 제출은 차단한다.
- 관리자 후보 projection은 current version에서 해당 날짜가 available인 활성 maid만 반환한다.

---

## 15. 아직 사용자가 결정해야 할 사항

AI는 아래 항목을 암묵적으로 확정하지 않는다.

1. 투숙 중이면서 청소가 필요한 객실의 **프런트 대표 표현**: `DOCS/17` 우선순위와 `DOCS/20`/현재 wireframe의 주 상태+하위 상태 중 어느 쪽인지. 백엔드 독립 축은 이 결정과 무관하게 유지한다.
2. 기본/최대 숙박 인원을 운영 정본으로 확정할지. 타입별 예상시간 정책은 폐기되어 결정 대상이 아니다.
3. current role 단일값과 역할 이력/복수 역할 구조 중 어느 모델을 채택할지. 단, `upload_only`는 별도 역할이 아니라 제한 capability다.
4. 최초 검수 반려 뒤 원 메이드가 퇴사·부상 등으로 재청소할 수 없는 예외 처리
5. 재제출 version을 사용자 화면에서 어떻게 노출하고 비교할지
6. Google Drive의 실제 운영 계정·OAuth 자격증명·용량/비용 감시와 도어락·향후 송금·OTA/PMS·push의 실제 공급자·자격증명/비용. 사진 저장 provider 자체는 Google Drive로 확정이다.
7. 운영 시작 시 608호 차단이 여전히 유효한지
8. wireframe의 퇴실점검을 제품 범위로 유지할지와 수동 완료/청소 완료 대체 규칙

미확정 항목도 확장 가능한 schema는 설계할 수 있다. 다만 한쪽 정책을 강제하는 irreversible migration, purge, 지급 로직은 결정 전 배포하지 않는다.

---

## 16. AI 작업 절차

백엔드 작업을 시작할 때 다음 순서를 따른다.

1. `AGENTS.md`와 이 문서를 끝까지 읽는다.
2. 요청이 `[확정]`, `[미확정]`, `[데모]` 중 어디에 속하는지 적는다.
3. 현재 migration/API와 제품 계약의 차이를 먼저 확인한다. ERD/DBML의 table 수나 구조를 목표라고 가정하지 않는다.
4. 한 bounded context만 선택해 schema → constraint/RLS/RPC → service/route → test → docs 순으로 구현한다.
5. 기존 migration이 원격에 적용됐는지 확인한다. 이미 적용된 migration은 수정하지 않고 새 migration을 추가한다. 아직 적용되지 않은 baseline은 확인 결과와 호환성 영향에 따라 amend/squash 또는 append 전략을 명시적으로 선택한다.
6. table write 권한, cross-row 정합성, stale version, retry, concurrent request, audit/notification side effect를 함께 검토한다.
7. 실제로 실행한 검증과 실행하지 못한 검증을 구분해 기록한다.

### 변경 완료 전 최소 검사

```bash
npm run typecheck
npm test
npm run build
npm run db:reset
```

`db:reset`은 Docker가 필요하다. 실행하지 못했다면 migration이 검증됐다고 말하지 않는다.

업무 mutation을 추가했다면 최소 다음 테스트를 포함한다.

- admin / 담당 maid / 다른 maid / 비활성 / upload-only 권한 matrix
- 정상 전이와 `INVALID_TRANSITION`
- stale `expectedVersion`
- 같은 idempotency key + 같은 payload 재시도와 같은 key + 다른 payload 충돌
- 실제 Postgres에서 예약 overlap, 동일 예약 수동/예정 checkout의 청소 중복, 담당 변경 vs 시작, 제출 재시도, 승인 vs 반려, earning entitlement 중복, 동일 earning의 두 payroll cycle 포함, payroll 선점, PIN lease, 마지막 관리자 비활성·퇴사·삭제·role 변경 경쟁 조건
- audit event와 notification/outbox의 원자성
- PII/PIN이 response, log, notification에 나타나지 않음

### PR에 반드시 적을 내용

- 어떤 제품 규칙을 구현했는지
- 변경한 schema/API와 migration 전략
- 새로 강제되는 불변식
- RLS/권한 변화
- 멱등성·동시성 처리
- 실행한 검사와 실행하지 못한 검사
- 남은 `[미확정]` 사항과 이번 변경이 고정하지 않은 범위

---

## 17. 권장 구현 순서

P2 배정부터 #112 Web Push provider, #73/#46/#128/#131/#136/#137/#140/#133/#156/#165 및 v0.4.0의 #169까지 production source와 runtime에 반영됐다. production은 73 migrations / `api` ACTIVE v17 / OpenAPI 0.4.0 120 paths / 130 operations이며 기존 네 checkout template 데이터도 보존됐다. 따라서 `CLEANING_TEMPLATE_NOT_CONFIGURED` 운영 차단의 구성 원인은 해소됐지만, 안전한 fixture가 없어 이번 release에서도 실제 예약·PIN success mutation은 검증하지 않았다.

1. production 56번째 migration, `api` v16, 네 checkout template v7 및 Pages 109/117 parity는 완료 상태로 유지한다.
2. 안전하게 되돌릴 수 있는 운영 fixture가 승인되면 예약 생성 성공, planned checkout target exactly-one, template/slot snapshot과 동일 요청 replay를 hosted smoke로 확인한다. fixture가 없으면 SKIPPED 상태를 PASS로 바꾸지 않는다.
3. Issue #148에 남은 annotated `v0.3.0` tag/GitHub Release는 예약 smoke의 실제 결과와 provider/Google 활성화 제외 범위를 명시한 뒤 별도 완료 상태로 기록한다.
4. Issue #34의 GitHub Actions runtime 경고는 별도 CI 유지보수 PR로 관리한다.
5. Issue #137 hosted Google Sheets 활성화는 실제 대상/서비스 계정/ACL/Secrets/Edge/Cron/smoke 승인 뒤에만 진행한다.
6. Issue #12 backup/recovery source는 병행할 수 있으나 production/recovery restore·secret 활성화는 별도 승인 단위로 관리한다.
7. Issue #13 generated client와 전체 browser E2E는 운영·프런트 정본 대조 뒤 진행한다.

source/dev 완료, release/main 승격, production migration/secret/Edge/Cron 활성화는 서로 다른 gate다. 실제 Postgres RLS·동시성·복구 테스트를 계속 CI 필수 gate로 둔다.

기능 수를 빨리 늘리는 것보다 **삭제 불가 이력, 돈, 권한, 중복 방지**를 먼저 맞추는 것이 우선이다.
