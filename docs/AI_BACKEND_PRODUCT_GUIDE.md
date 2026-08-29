# 백엔드 GPT/Codex 제품·구현 가이드

이 문서는 프런트엔드 저장소, 과거 대화, 현장 설명을 볼 수 없는 백엔드 담당 AI가 제품 의도를 추측하지 않고 구현하도록 만든 **저장소 내부 제품 계약**이다.

검토 기준:

- 백엔드 `main`: `7e229c2c1fabd4efd9c77e6032a8ffea09b16cd4`
- 프런트엔드 `main`: `b517fb79922f97426b41bf33e2f15cbbc003b136`
- 기준일: 2026-08-26 KST

프런트엔드는 실제 API 소비자가 아니라 단일 HTML로 만든 고충실도 업무 시뮬레이터다. 화면 객체, fixture, dead code를 그대로 API나 테이블로 옮기지 않는다.

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

이 가이드는 아래 프런트엔드 commit을 요약한 저장소 내부 정본이다. 같은 snapshot의 인용 문서와 `[확정]` 문장이 충돌하면 위 순위를 기계적으로 적용해 가이드 문장을 정당화하지 않는다. 가이드 오류 또는 아직 해소되지 않은 기획 충돌로 기록하고, 되돌리기 어려운 구현은 수정·질문 전까지 멈춘다. ERD/DBML은 `review draft`이므로 이 가이드와 reconciliation되기 전에는 목표 계약이나 완성 체크리스트로 사용하지 않는다.

### 고정한 프런트엔드 근거

| 범위 | 고정 문서 |
|---|---|
| 가능일·배정·이월·폭탄방·주급 | [`DOCS/16`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/16_WEEKLY_AVAILABILITY_ASSIGNMENT_POLICY.md) |
| 객실 마스터·점유·수동 체크아웃 | [`DOCS/17`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/17_ROOM_CATALOG_LONG_STAY_DECISIONS.md) |
| 타입·사진 템플릿 | [`DOCS/18`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/18_TYPE_PHOTO_TEMPLATE_POLICY.md) |
| 사건·알림 | [`DOCS/19`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/19_EVENT_NOTIFICATION_POLICY.md) |
| 객실 청소 요청·취소 | [`DOCS/20`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/20_ROOM_CLEANING_REQUEST_FLOW.md) |
| 전체 도메인 안전 규칙 | [`FINAL_UX_AUDIT`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/DOCS/FINAL_UX_AUDIT.md) |
| 현재 상호작용 구현 | [`WIREFRAME/index.html`](https://github.com/makee-ham/room-management-system/blob/b517fb79922f97426b41bf33e2f15cbbc003b136/WIREFRAME/index.html) |

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

- **관리자**: 객실 기준정보·예약·운영 차단·청소 대상·메이드 가능일·배정/순서·통보·검수·계정·주급·감사 이력을 관리한다.
- **메이드**: 본인에게 통보된 작업, 본인 가능일, 본인 수행 회차·사진·제출·검수 결과·수익/주급만 본다.

현재 제품 역할은 관리자와 메이드 두 종류다. 단일 `role`로 갈지 역할 이력/복수 역할 테이블로 갈지는 데이터 모델 결정 사항이지만, 어떤 구조든 역할 변경 이력과 마지막 활성 관리자 보호가 필요하다.

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
| `standard` | 스탠다드 더블 로프트 | 22 | 16,000원 | 10개: 필수 9 + 선택 1 |
| `premium` | 프리미어 더블 로프트 | 51 | 20,000원 | 11개: 필수 10 + 선택 1 |
| `oceanPremium` | 파셜 오션뷰 프리미어 더블 로프트 | 13 | 20,000원 | 13개: 필수 12 + 선택 1 |
| `oceanFamily` | 파셜 오션뷰 패밀리 투룸 로프트 | 35 | 30,000원 | 15개: 필수 14 + 선택 1 |

객실별 타입·구역의 전체 매핑은 migration seed가 현재 정본과 일치한다. 사람이 읽는 표시명은 바뀔 수 있으므로 code와 이력을 기준으로 연결한다.

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
- 타입별 예상 청소시간 55 / 65 / 70 / 80분
- 기본/최대 숙박 인원 2/2, 2/3, 2/4, 4/6

121실 마스터와 확정된 타입·구역·단가는 검증된 초기 기준정보로 반입할 수 있다. 반면 인명·PIN·사진·예약·청소·폭탄방·수익·지급 fixture는 production 반입을 금지한다. 최초 투숙 11실과 762호 상태도 배포 시점의 운영자 확인 없이 production seed로 넣지 않는다. 인원 상한은 확정 전 예약 거부 조건으로, 예상시간은 확정 전 배정 용량 계산의 입력으로 사용하지 않는다.

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

### `[확정]` 백엔드 projection / `[미확정]` 카드 대표 표현

백엔드는 `occupied`, `cleaning_required`, `allocation_blocked`, `allocation_ready` 같은 독립 predicate와 사유를 제공한다. 필터와 집계도 서로 겹칠 수 있다. 프런트 `DOCS/17`은 대표 카드 우선순위를 `배정 불가 → 청소 필요 → 투숙 중 → 배정 가능`으로 적었지만, 더 구체적인 `DOCS/20`과 현재 wireframe은 투숙 중 연박 청소를 `투숙 중` 주 상태 + `청소 필요` 하위 상태로 표시한다. 이 UI 충돌은 아직 해소되지 않았다. 백엔드 schema/API는 한쪽 대표 문자열을 영구 상태로 고정하지 말고 독립 축을 제공하며, 표시 우선순위 변경은 프런트 계약으로 격리한다.

`allocation_ready`는 공실, 현재 preparation obligation 승인, 촛불 0, 운영 정상, 미해결 입실 차단 이슈 없음, PIN 일치, 기준정보·점유 확인 완료를 모두 만족할 때만 true다. false이면 `OCCUPIED`, `CLEANING_REQUIRED`, `CANDLE_PRESENT`, `OPERATION_BLOCKED`, `ROOM_ISSUE_BLOCKED`, `PIN_MISMATCH`, `DATA_UNCONFIRMED` 같은 안정적인 reason code 목록을 함께 반환한다.

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
- 한 객실의 여러 미래 예약은 각각 자기 퇴실 청소 의무를 가질 수 있다. 따라서 “객실당 모든 비종결 target 1건” 제약을 두면 안 된다.
- 체크인 예정 시각에 입실 준비 조건이 모두 충족되면 예약상 점유 시작 event를 멱등적으로 한 번 만든다. 조건이 남아 있으면 `입실 시각 도달·객실 미준비`로 두고, 유효 예약 중 조건이 모두 해소된 시점에 같은 전이를 원자적으로 한 번 실행한다.
- 실제 checkout event가 없으면 예정 체크아웃 시각에 scheduler가 점유 종료, 퇴실 청소 활성화, 유효 담당의 PIN 조회·시작 가능 시각 개방을 멱등적으로 실행한다. 예정 전 수동 checkout이 이미 있으면 다시 종료하거나 청소를 복제하지 않는다.
- 자동 종료 뒤 예정 체크아웃을 미래로 늦추면 기존 종료 event를 삭제하지 않고 점유 재개 보정 event를 추가한다. PIN을 아무도 조회하지 않았고 청소도 시작 전이면 미시작 작업·PIN 권한·offline lease를 같은 transaction에서 폐기·재잠금한다. PIN 공개 또는 수행 시작 뒤라면 출입 충돌로 격리해 현장 조율·PIN 교체·작업 중단/재계획 command 전에는 정상화하지 않는다.
- 예약 추가·수정·취소는 객실 일정 row를 잠그고 앞뒤 예약의 직전 점유와 `preparation_obligation` 연결을 다시 계산한다. 기존 승인·반려 이력은 보존하고, 새 점유·오염으로 기존 청결 근거가 무효가 되면 새 준비 작업 필요 상태를 만든다.

권장 유일키와 실행 잠금:

- 퇴실 청소: `(reservation_id, cleaning_kind)`
- 수동/연박 요청: 안정적인 source request ID
- 실행 중 충돌 방지: 객실 실행 lock/원자 command를 사용한다. 현재 `cleaning_attempts`에 없는 `room_id`를 단순 중복 추가해 부분 index를 만들면 target과 객실이 어긋날 수 있다. denormalize한다면 `(target_id, room_id)` 복합 FK/제약으로 동일성을 강제하고, 아니면 constraint trigger/advisory lock 등 실제 schema에 맞는 수단을 쓴다.

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
- 현재 요청의 service date·점유·접근 구간과 충돌하는 활성 수동 요청, 자동 퇴실 의무, 예정 작업, 수행 회차, 미승인 제출이 있으면 새 요청을 만들지 않는다. 충돌하지 않는 미래 예약의 퇴실 의무와 과거 승인 완료 제출만으로 오늘의 연박/추가 요청을 막지 않는다.
- 수동 요청은 아직 미배정·미공개·미착수일 때만 soft cancel하며 사유·행위자·시각을 보존한다.

---

## 6. 주간 가능일과 관리자 배정

### `[확정]` 현재 정책

- 과거의 공개 일감과 메이드 선점/claim 모델은 폐기됐다.
- 메이드는 일요일 12:00–23:59 KST에 다음 월요일–일요일의 가능일을 version으로 제출한다.
- 마감 뒤 수정은 원본을 덮지 않고 변경 요청과 승인/반려 이력으로 남긴다.
- 관리자는 가능 메이드만 후보로 오늘/내일 청소를 배정한다.
- 관리자가 메이드별 작업 순서 1–N을 정하고 저장·통보한다.
- 랜덤 배정은 먼저 마감 안에 완료 가능한 객실 수를 최대화하고, 그 후보 중 메이드별 기본 청소요금 총액의 최대·최소 격차와 전체 편차를 최소화한다. 금액 점수가 같을 때만 같은 엘리베이터 구역·가까운 호수를 보조 기준으로 쓰고, 그래도 같으면 랜덤으로 고른다. 최종 동률 결과가 반복 실행마다 같을 필요는 없다.
- 완료 가능 객실 수 계산에는 타입별 예상시간이 필요하다. 예상시간이 운영값으로 확정되기 전에는 이 알고리즘을 production 자동결정으로 사용하지 않는다.
- 랜덤 결과는 저장 전 초안이다. 실행만으로 담당·attempt·알림·감사 이력을 만들거나 기존 통보/관리자 수동 배정을 덮지 않는다.
- 일부 객실만 배정된 상태의 부분 통보를 허용하되 미배정 대상을 숨기지 않는다.
- 통보 뒤라도 **시작 전**에는 관리자가 담당·순서·접근 시각을 바꾸거나 정해진 사유로 soft cancel할 수 있다. 이전 assignment/schedule snapshot과 notification revision을 보존하고 영향받은 당사자에게 변경 통보한다.
- 메이드는 직접 취소·이관하지 못하지만 현장 완료 전 `담당 취소 요청`과 사유를 보낼 수 있다. 관리자 결정 전에는 기존 담당이 유지된다.
- 시작 뒤에는 일반 배정 화면에서 담당·순서를 바꾸거나 취소하지 않는다. 즉시 중단·인계가 필요하면 기존 attempt를 `interrupted`로 종결하고 새 책임 구간을 만드는 별도 관리자 command를 사용한다. 현장 완료·업로드·검수 대기는 배정 취소 대상이 아니다.
- 한 메이드는 하루에 여러 업무를 가질 수 있지만 동시에 `청소 중`인 attempt는 최대 한 건이다.
- 전날 미배정 업무는 같은 target ID와 최초 계획일을 유지해 다음 날 재배정한다. 통보됐지만 미착수인 업무는 이전 담당 이력을 남긴 뒤 현재 담당을 풀고 다음 날 가능 여부로 다시 배정한다.
- 이미 시작한 미완료 업무는 새 attempt나 새 담당을 만들지 않고 같은 attempt·담당·사진 진행을 유지한다. 현장 완료 뒤 업로드/제출 대기와 검수 대기는 배정 이월에서 제외한다.
- 오늘 저장·통보는 실행 가능한 미시작 attempt를 정확히 한 번 만든다. 내일 저장·통보는 계획 상태로 남겼다가 대상일에 같은 target·담당·순서·snapshot으로 정확히 한 번 활성화한다.
- 같은 객실의 이전 attempt가 진행·업로드·검수 중이면 새 당일 attempt 활성화를 보류하고 `관리자 확인 대기·시작 불가`로 둔다. 이전 workflow가 종결된 뒤 원 통보 revision을 기준으로 한 번만 활성화한다.

배정 가능 여부는 API나 RLS가 최종 저장 시점에 다시 검증한다. 브라우저에서 후보 목록을 봤다는 사실은 권한이나 최신 상태의 증거가 아니다.

---

## 7. 청소 수행, 사진, 제출

### `[확정]` 엔티티 경계

1. **청소 의무/target**: 왜, 어느 객실을, 어느 운영일에 청소해야 하는가
2. **assignment revision**: 누가 몇 번째 순서로 책임지는가
3. **attempt**: 실제 수행 회차. 시작 전 담당 변경·순서 변경은 같은 미시작 업무 연결을 갱신하고, 시작한 업무의 이월은 같은 회차를 유지한다. 검수 반려 재청소 또는 명시적 중단·인계만 새 회차를 만든다.
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
- 한 slot의 current 사진은 한 장이다. 재촬영은 current pointer를 CAS로 교체하며, 이전 업로드/교체 이력은 보존 정책에 따라 추적한다.
- 퇴실 청소 template v7 이상에는 필수 `tv-on` slot이 정확히 하나 있어야 한다. v6 이하 과거 snapshot에는 소급 추가하지 않는다.
- 앱은 JPEG/WebP를 EXIF 제거 후 사진당 최대 300KiB(307,200 bytes)로 압축한다. 서버도 본문 크기와 허용 형식을 독립적으로 강제한다.
- 서버는 파일 확장자나 client MIME만 믿지 않고 magic bytes, 허용 MIME, 크기, hash, 현재 담당/attempt/version을 검증한다.
- 현장 완료, 미전송 업로드, 전체 제출, 검수 요청은 별도 상태다.
- 모든 필수 slot이 서버에서 유효하게 처리되기 전에는 현장 완료와 전체 제출을 허용하지 않는다.
- 메이드 화면 행동명은 `검수 요청`, 제출 상태명은 `검수 요청됨`, 관리자 목록명은 `검수 대상 목록`이다. API enum/code는 안정적인 영문값을 사용하고 표시 문구와 분리한다.
- 재제출은 기존 row를 덮지 않는다. 새 immutable submission version을 만들고 이전 version을 `SUPERSEDED`로 표시하며 current pointer를 CAS로 전환한다.
- 관리자와 메이드는 현재 version을 기준으로 작업하되 과거 version은 감사용으로 조회할 수 있다.

### `[확정]` 오프라인 동기화

- 오프라인 수행은 현재 assignment/work version에 묶인 만료 가능한 work lease가 있을 때만 허용한다.
- lease와 offline queue에 객실 PIN 평문, 고객 개인정보, 다른 메이드 정보는 넣지 않는다.
- 현장 완료 event는 client 시각, 마지막 server 시각 offset, stable event UUID를 함께 보존한다.
- 서버는 event를 순서대로 재생하며 같은 submission/client UUID를 한 번만 반영한다.
- offline 현장 완료만으로 객실을 배정 가능으로 만들거나 검수·earning을 생성하지 않는다. 서버가 현재 담당/version·필수 사진·권한을 검증해 수용한 뒤에만 효력이 생긴다.
- 담당 또는 version이 달라진 event는 정상 완료로 강제 연결하지 않고 충돌로 격리한다. 관리자는 `과거 수행 기록으로만 수용`, `운영 효력 기각`, `정정으로 유효 작업에 연결` 중 명시적 command로 종결한다.

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

### `[확정]` 승인 후 컴플레인과 재작업

- 컴플레인은 `접수 → 확인 중 → 판정 → 메이드 확인/이의 → 종결` 사건으로 관리한다.
- 관리자가 관련 객실·원 청소·증빙을 연결하고 `확인됨 / 확인 불가 / 사실 아님`, 벌점, 재작업 필요를 결정한다.
- 메이드는 본인 건을 확인하거나 이의 메모를 남길 수 있지만 판정·벌점·재작업을 직접 바꾸지 못한다.
- 청소 반려가 자동 벌점이 되지 않으며, 컴플레인·벌점을 주급에서 자동 차감하지 않는다.
- 정정은 기존 판정을 삭제하지 않고 새 decision version/event로 남긴다.
- 이미 승인된 원 청소의 earning은 컴플레인 때문에 취소하거나 귀속일을 바꾸지 않는다.
- 같은 메이드가 재작업하면 추가 earning은 없다. 다른 메이드가 맡으면 관리자가 명시한 보상 결정 ID에 연결된 금액을 새 재작업 현장 완료일에 정확히 한 번 적립할 수 있다.
- 이 보상은 `reclean_compensation_decision_id` 같은 실제 FK/unique source를 가져야 하며, 최초 검수 반려 재청소에 재사용하면 안 된다.

---

## 9. 수익과 주급

### `[확정]` 수익

- earning은 승인된 유상 청소 entitlement에서 정확히 한 번 생성되는 불변 원장이다.
- 금액은 작업 당시 base fee snapshot과 승인된 bonus에서 서버/DB가 계산한다.
- `earned_on`은 최종 승인까지 이어진 성공 수행 회차의 **현장 완료 KST 날짜**다. 원 계획일, 이월 대상일, 업로드일, 검수일로 바꾸지 않는다.
- 자정 또는 일요일/월요일 경계에서 offline client 시각과 server 기준이 충돌하면 자동 귀속하지 않고 관리자 확인 상태로 둔다.
- 지급 전후를 막론하고 earning 원본 금액을 덮어쓰지 않는다.
- 정정은 별도 adjustment event로 추가한다.

### `[확정]` 지급

- 메이드·주차별 payroll cycle은 한 건이다.
- `locked_earning_ids uuid[]` 같은 배열이 아니라 `payroll_items`로 earning을 정규화한다.
- `payroll_items.earning_id`는 전 cycle에 걸쳐 UNIQUE여야 같은 수익을 두 번 지급하지 않는다.
- 지급 snapshot 금액은 포함 item의 DB 합계와 같아야 한다.
- 지난주 cycle이 아직 `OPEN`이면 늦게 승인된 해당 주 earning을 지난주 cycle에 포함한다. 이미 `PAID`라면 원 지급을 바꾸지 않고 다음 주 adjustment로 넘긴다.
- 현재 진행 중인 주차와 확정액 0원 cycle에는 지급 command를 허용하지 않는다.
- 기본 전이는 `OPEN → PAYING → PAID`다.
- 송금 결과가 불확실하면 `PAYING → CHECK`로 둔다. 외부 송금이 없었음을 확인하고 필수 사유를 기록한 경우에만 `PAYING → OPEN` 또는 `CHECK → OPEN`으로 되돌린다.
- UI에서 “미지급으로 되돌리기”를 제공하더라도 이미 실제 송금된 기록을 삭제하거나 조용히 OPEN으로 바꾸지 않는다. 정정/상계 event가 필요하다.
- 외부 송금 연동 전에는 실제 지급이 실행된 것처럼 응답하지 않는다.

현재 제품은 은행/provider에 송금을 요청하지 않는다. 관리자가 외부에서 전액 송금한 결과만 기록한다. 향후 실제 provider 연동이 별도로 확정되면 lock/pay command는 대상 earning을 일정한 순서로 잠그고, 외부 호출을 DB transaction 안에서 기다리지 않으며 idempotency key와 provider reference로 결과를 조정한다.

---

## 10. 인증, 계정 수명주기, PIN

### `[확정]` 계정

- 인증의 불변 기준은 Auth user ID와 profile UUID다. 표시 이름이나 로그인 alias가 PK가 아니다.
- 휴대폰 전체 번호를 정규화해 중복을 검사한다. 같은 번호의 활성 계정이 있으면 생성을 막고, 비활성/퇴사 계정이면 새 계정 대신 기존 계정 복구 흐름으로 보낸다.
- 동명이인은 안정적인 suffix를 가진 login ID/alias로 구분하며 한번 부여한 suffix를 비활성·퇴사 후에도 재사용하거나 당겨 붙이지 않는다.
- 내부 Auth 이메일은 서버 전용이며 API에 노출하지 않는다.
- 최초 발급과 관리자 초기화 로그인 비밀번호는 등록 휴대폰 번호 뒤 4자리이며, 다음 로그인에서 선행 0을 허용하는 숫자 6자리 이상 개인 비밀번호로 바꾸게 한다. 객실 PIN과는 완전히 별개다.
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
- 청소 진행 중 비활성화는 관리자가 `현재 한 건 마무리` 또는 `즉시 중단·인계`를 선택한다. 전자는 지정한 한 회차만 완료하게 한다.
- 즉시 중단·인계된 이전 메이드에게는 증빙 업로드만 허용한다. current submission 생성, 검수, earning 연결은 금지한다.
- 어떤 제한 capability도 일반 maid 권한이나 관리자 권한을 주지 않는다.
- API와 RLS가 같은 capability matrix를 사용해야 한다.

### `[확정]` 객실 PIN

- 로그인 비밀번호와 별도 암호키/수명주기로 관리한다.
- 객실 PIN은 선행 0을 허용하는 4자리 숫자 문자열이다.
- DB에는 authenticated encryption(AES-GCM 또는 XChaCha20-Poly1305)의 암호문, nonce, authentication tag, key version과 변경 이력을 저장한다. 키는 DB와 분리된 secret manager에 두고 평문을 저장하지 않는다.
- 권한 있는 사용자가 특정 객실·현재 assignment/attempt에 대해 명시적으로 조회할 때만 서버가 복호화한다. 메이드는 담당뿐 아니라 해당 청소 유형의 출입 허용 시각 도달도 검증한다.
- 응답은 `Cache-Control: no-store`를 사용하고 클라이언트는 최대 30초 뒤, 화면 이동, background/pagehide, 기기 잠금, 담당 해제, 출입 재잠금 때 평문을 메모리에서 지운다. clipboard, service worker cache, offline queue, 영속 브라우저 저장소에 넣지 않는다.
- PIN 조회·변경은 객실, PIN version, actor, assignment/attempt에 묶인 lease/CAS와 감사 event를 남긴다.
- 관리자 변경은 PIN 변경 lease 선점 → 실제 도어락 변경 → 앱 저장 순서로 조정한다. 저장 실패로 물리 도어락과 앱 값이 어긋나면 입실과 PIN 조회를 차단하고, 실제 PIN 재입력 또는 물리적 원복 확인 + 사유로만 종결한다.
- PIN 평문을 URL, 로그, error, audit payload, notification, analytics, Git, 브라우저 저장소에 넣지 않는다.

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

### `[확정]` 보존 기간

사용자가 2026-08-26 대화에서 다음 정책을 명시적으로 확정했다. 이 결정은 프런트 문서의 180일/hold 초안보다 우선한다.

- Google Drive에만 저장한다. Supabase Storage에는 사진 객체를 저장하지 않는다.
- 프런트에서 JPEG/WebP를 300KiB 이하로 압축하고 서버도 크기·magic bytes·MIME·EXIF 제거를 검증한다.
- 비공개 KST 업로드 일자/객실 폴더에 정리한다.
- `purge_after`는 검수 상태와 무관하게 정확히 `uploaded_at + 7 days`다.
- 7일 보존에는 retention hold나 180일 예외를 두지 않는다.
- worker는 Drive `files.delete`로 영구삭제하고 404를 멱등 성공으로 처리한다.

Google Drive 운영 계정과 OAuth 자격증명은 아직 외부 배포 전제다. 자격증명 없이 provider가 연결됐다고 가정하거나 worker를 배포하지 않는다. 용량 보호 기준은 현재 #9의 10GB 경고/12GB 업로드 차단 계약을 따른다.

---

## 12. 알림과 감사 이력

### `[확정]` 알림

- 앱 알림함은 영속 데이터다. 푸시는 그중 즉시 행동이 필요한 사건의 전달 수단이다.
- 관리자와 메이드의 수신 대상을 분리한다.
- 사용자가 자기 행동으로 만든 변화는 자신에게 푸시하지 않는다.
- 같은 객실·같은 사건 종류의 10분 이내 업데이트는 group key로 묶을 수 있다.
- deep link payload에는 안정적인 entity ID만 넣고 PIN·고객 개인정보·민감 메모를 넣지 않는다.
- notification의 recipient, title, body, category, deep link는 생성 뒤 수신자가 수정하지 못한다. 수신자는 본인 `read_at`만 좁은 command로 바꿀 수 있고 `resolved_at`은 관련 domain command만 갱신한다. 해결된 알림도 삭제하지 않는다.
- notification 원장과 delivery outbox/device subscription을 분리한다.
- outbox는 재시도, provider response, 최종 실패를 기록한다.
- push 거부·지연·최종 실패는 담당, 수행, 검수 같은 domain 상태를 되돌리거나 바꾸지 않는다.

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
- 조회는 필요한 범위의 SELECT, 쓰기는 좁은 Fastify command 또는 고정 `search_path`의 검증된 RPC로 제한한다.
- `SECURITY DEFINER` 함수는 명시적 schema, 최소 EXECUTE 권한, actor 재검증, 안전한 `search_path`를 사용한다.
- view는 `security_invoker = true`를 사용한다.
- service-role/secret은 서버에만 두고 로그·브라우저에 노출하지 않는다. service role은 RLS를 우회하므로 Fastify command가 access token의 actor를 식별한 뒤 최신 DB role/status, ownership, capability, expected version, transition을 매번 다시 검증한다.

### 관계·제약·index

- FK가 존재하는 것만으로 업무상 동일성이 보장된다고 가정하지 않는다. 필요하면 복합 UNIQUE/FK 또는 constraint trigger를 사용한다.
- PostgreSQL은 FK index를 자동 생성하지 않으므로 join, RLS, delete/cancel 경로의 자식 FK를 index한다.
- soft-active, current revision, pending queue처럼 항상 같은 predicate로 조회하는 경로에는 실제 query와 맞는 partial index를 고려한다.
- 필수 관계·유일성·상태/시각 일관성을 JSONB application validation에만 맡기지 않는다.
- 돈은 정수 원 단위로 저장하고 float를 사용하지 않는다.

---

## 14. 현재 구현 상태와 알려진 차이

이 절은 “다음 작업이 어디서 시작하는가”를 설명한다.

### `main` 70e479e 기준 구현됨

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
- 운영·복구검증 Supabase의 동일 migration history

### `main` 기준 남은 차이

- DBML/ERD도 review draft다. 현재 migration의 table 수와 DBML의 32개 table 수를 완성도 지표로 사용하지 않는다.
- 객실·예약의 `version` 컬럼은 있으나 CAS command/RPC가 없다.
- 주간 가능일, preparation obligation, 객실 operation block/issue/candle, 퇴실점검, 정규화 photo slot, bomb report, complaint/penalty/appeal, payroll item/event/adjustment, notification outbox, PIN sync/access lease, 개인정보 저장소, offline work lease, reservation schedule/occupancy revision이 없다.
- initial migration과 테스트에는 확정된 `purge_after NOT NULL` 및 업로드 후 7일 계약이 들어 있지만, 실제 Google Drive 업로드·조회·purge worker는 아직 구현되지 않았다.
- wireframe에는 퇴실점검을 관리자가 직접 완료하거나 퇴실 청소 현장 완료로 대체하는 동작이 있지만, 고정한 제품 정책 문서에는 이 lifecycle의 정본이 없다. 이를 현재 구현만 보고 schema/API로 확정하지 않는다.

원격 운영·복구검증 프로젝트에는 `main`과 같은 적용 migration history가 있으며, 2026-08-28 기준 구조·DML·RLS 검사와 Security Advisor 0건을 확인했다. 새 기능 PR의 migration은 병합·배포 전까지 이 현황에 포함하지 않는다.

### Issue #1 `dev` 통합 구현 — `main` release·원격 적용 전

다음 항목은 `dev`에 통합됐지만 release PR과 운영 migration 적용 전에는 `main` 또는 운영 구현으로 간주하지 않는다.

- 객실 목록·상세는 점유, 청소 필요, 배정 차단/가능과 안정적인 reason code를 독립 축으로 반환한다.
- 객실 기준정보, 운영 차단, 촛불, 이슈, PIN 동기화는 최신 active admin과 객실 `state_version`을 재검증하는 원자 명령이다.
- 예약 생성·일정 변경·취소·수동 체크아웃·시각 기반 전이는 예약/객실 lock, CAS, actor별 idempotency key와 request hash를 사용한다.
- 예약 일정 revision, 입실 준비 의무, 예약별 비공개 퇴실 청소 의무, 점유 event를 추가하고 원장을 UPDATE/DELETE하지 않는다.
- 고객명은 API 서버가 AES-256-GCM으로 암호화하며 명령 응답·감사 payload에 원문이나 암호문을 포함하지 않는다.
- 고객명 idempotency fingerprint는 암호화 키와 분리된 안정적 server HMAC pepper를 사용해 key rotation 전후 request hash를 보존한다.
- 예약 목록은 고객명을 반환하지 않고 관리자 단건 상세에서만 복호화한다. 체크아웃/취소 후 180일 보존 만료는 예약 전이 worker가 처리하며 멱등성 hash에는 암호화 키와 분리된 HMAC pepper fingerprint만 사용한다.
- PIN 원문은 저장하지 않고 동기화 상태와 version만 기록한다. `verified`가 아닌 객실은 고객 배정을 차단한다.
- 객실 전체 운영 projection은 관리자 전용이다. 메이드는 자신의 현재 배정·수행 범위 projection만 후속 업무 API에서 제공받는다.
- 연박/추가 수동 청소 요청은 안정적인 target ID로 생성하고 시작·PIN 공개 전까지만 CAS soft cancel한다.
- 예정 전이 worker는 production에서 활성 관리자 actor를 필수로 하며 시작 시 검증 실패를 숨기지 않는다. catch-up은 퇴실을 입실보다 먼저 처리해 같은 instant의 인접 예약을 한 batch에서 전이하고, 완전히 지난 미입실 예약은 가짜 check-in 없이 종결한다.
- checkout obligation↔target은 deferred commit-time 검증까지 포함해 종료 상태가 반쪽만 저장되지 않게 하고, preparation obligation↔승인 submission/attempt는 직전 점유 종료 이후·해당 체크인 이전 시간창 안에서 target 접근 가능 시각 이후 `attempt 시작 → 현장 완료 → 종료 → 제출 → 승인` 순서를 검증하며 append-only 1회 소비 원장까지 강제한다. PIN lease↔현재 assignment/attempt는 최신 verified PIN version까지 업무 동일성을 복합키와 DB 검증으로 강제한다.
- 다음 예약 변경은 종결된 과거 의무를 덮지 않는다. 미배정 target은 schedule revision과 함께 마감을 갱신하고 배정·통보된 target은 명시적 재계획 전까지 충돌로 거부한다.
- 타입별 인원 상한, 프런트 대표 상태, 퇴실점검 lifecycle은 이번 변경에서 확정하지 않는다.
- Docker Desktop 복구 후 fresh local DB reset, 역할별 SQL 회귀 검사, DB advisor를 실행할 수 있다. 각 변경은 실제 실행 결과를 PR에 기록하며 실행하지 않은 검증은 완료로 표현하지 않는다.

### Issue #6 `dev` 통합 구현 — `main` release·원격 적용 전

- 가능일 제출은 일요일 12:00–23:59 KST와 다음 월요일 `week_start`를 DB command에서 검증한다.
- 메이드·주차별 current version은 `expectedVersion` CAS와 advisory lock으로 직렬화하며 과거 version과 7개 날짜 row를 삭제하지 않는다.
- 마감 뒤에는 pending 변경 요청을 만들고 활성 관리자의 승인 시에만 새 current version을 추가한다. 반려도 결정·사유·행위자·시각을 보존한다.
- 같은 idempotency key와 canonical payload는 기존 결과를 반환하고 다른 payload 재사용은 거절한다.
- 조회 RLS는 활성 관리자의 전체 범위와 활성 메이드 본인 범위만 허용하며, 직접 DML과 비활성·제한 capability 제출은 차단한다.
- 관리자 후보 projection은 current version에서 해당 날짜가 available인 활성 maid만 반환한다.

---

## 15. 아직 사용자가 결정해야 할 사항

AI는 아래 항목을 암묵적으로 확정하지 않는다.

1. 투숙 중이면서 청소가 필요한 객실의 **프런트 대표 표현**: `DOCS/17` 우선순위와 `DOCS/20`/현재 wireframe의 주 상태+하위 상태 중 어느 쪽인지. 백엔드 독립 축은 이 결정과 무관하게 유지한다.
2. 타입별 예상시간과 기본/최대 숙박 인원을 운영 정본으로 확정할지
3. current role 단일값과 역할 이력/복수 역할 구조 중 어느 모델을 채택할지. 단, `upload_only`는 별도 역할이 아니라 제한 capability다.
4. 최초 검수 반려 뒤 원 메이드가 퇴사·부상 등으로 재청소할 수 없는 예외 처리
5. 승인 후 컴플레인 재작업을 다른 메이드가 맡을 때 관리자 보상금의 선택 기준
6. 재제출 version을 사용자 화면에서 어떻게 노출하고 비교할지
7. Google Drive의 실제 운영 계정·OAuth 자격증명·용량/비용 감시와 도어락·향후 송금·OTA/PMS·push의 실제 공급자·자격증명/비용. 사진 저장 provider 자체는 Google Drive로 확정이다.
8. 운영 시작 시 608호 차단이 여전히 유효한지
9. wireframe의 퇴실점검을 제품 범위로 유지할지와 수동 완료/청소 완료 대체 규칙

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

1. Issue #1 객실·예약·점유·수동 체크아웃 command를 fresh DB CI와 독립 리뷰 후 반영한다.
2. 가능일 제출과 assignment revision을 구현한다. 객실 readiness와 예약별 preparation/checkout obligation은 Issue #1 구현을 확장해 사용한다.
3. offline work lease와 수행 상태를 구현한다.
4. 7일 Drive 저장 worker, 사진 slot, submission version, 검수·재청소·폭탄방을 원자 command로 구현한다.
5. earning, payroll item/event/adjustment와 이중 지급 방지를 구현한다.
6. notification outbox와 외부 worker를 연결한다.
7. OpenAPI/생성 client로 프런트와 계약을 고정한다.
8. 실제 Postgres RLS·동시성·복구 테스트를 계속 CI 필수 gate로 둔다.

기능 수를 빨리 늘리는 것보다 **삭제 불가 이력, 돈, 권한, 중복 방지**를 먼저 맞추는 것이 우선이다.
