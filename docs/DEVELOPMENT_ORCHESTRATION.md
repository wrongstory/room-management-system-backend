# 개발 오케스트레이션·source 승인 기준

2026-09-23 기준 개발 진행 원칙을 기록한다. 사용자는 기능 구현·배포와 직접 화면 확인을 우선하고,
보안·대규모 검증 보강은 기능 흐름 확인 뒤 묶어서 진행하기로 했다. 다만 migration 불변성, 비밀값·PII·PIN
비노출, required CI, 승인 없는 production 변경 금지처럼 되돌리기 어렵거나 운영 데이터를 위험하게 만드는
gate는 기능 우선순위와 무관하게 유지한다.

## 역할과 진행 단위

- Codex: 정본·Issue·원격 head 확인, 작업 분할, 통합 검증, 점수 평가, 진행 현황 정리.
- 구현 서브에이전트: 하나의 bounded context 안에서 파일 소유권을 나누어 구현·회귀 작성.
- 독립 QA 서브에이전트: 본인이 구현하지 않은 최종 diff의 정책·권한·동시성·노출 경계 검토.
- 외부 GPT 리뷰가 있으면 exact-head 근거를 보존한다. COMMENTED를 APPROVED로 표현하지 않는다.

작업 순서: 정본 확인 → feature 분기 → 구현/테스트 → Codex 통합 검증 → 독립 QA →
exact-head CI → 평가·승인 기록 → 허용된 경우 dev squash 병합 → tree/head/Issue 상태 확인.
GitHub 보호 규칙을 우회하지 않으며, 구현·검증·승인·병합·운영 배포는 각각 별도 상태다.

## 평가와 중단 조건

| 평가 영역 | 배점 | 확인 근거 |
|---|---:|---|
| 승인 요구사항·범위 | 25 | 정본/Issue와 구현 및 제외 범위 대응 |
| 보안·무결성 | 30 | 역할·session·ownership·CAS·멱등성·RLS·비밀값 격리 |
| 실제 검증 | 25 | fresh DB/동시성/Edge/application/Python/CI 결과 |
| 운영·문서 인계 | 20 | API/OpenAPI/생성 client/상태표/제한/배포 경계 |

**90점 이상**일 때만 Codex가 source/dev 승인을 내릴 수 있다. 다음은 점수와 무관한 필수 gate다.

- in-scope P0/P1 0건, 승인된 요구사항 범위, 독립 QA 완료.
- exact-head `application`/`migration` 및 해당 변경의 필수 검증 PASS.
- 미해결 blocking review thread 없음, 충돌 없음, 기존 migration/history 보존.
- head가 바뀌면 변경 범위 재검토, 검증/CI 및 독립 QA 갱신 후 다시 평가.
- 저장소 보호 규칙 충족. 관리자 bypass/force push/auto-merge로 대기 gate 우회 금지.

90점 미만 또는 필수 gate가 막히면 안전한 상태로 작업을 정리하고 리뷰·남은 blocker를 남긴 뒤
사용자에게 승인을 요청한다. FAIL/BLOCKED/NOT RUN을 PASS로 적거나 점수로 상쇄하지 않는다.
범위 밖 기존 결함은 별도 Issue와 영향/배포 제한을 공개하며 현재 PR의 P0/P1와 구분한다.

## 변경 금지 영역

별도 명시적 허가 전에는 production/recovery DB·migration·secret·Edge·Cron/Vault·Pages,
main/release 승격, tag/GitHub Release를 변경하지 않는다. feature/dev source를 직접 배포하지 않는다.
기존 원격 migration 수정·history rewrite, 보호 규칙 완화, secret/PII/PIN 기록은 금지다.

## 현재 진행 기준

- 운영 Git 정본은 `main@10a1f814649e92260e9e7353ab242400311b429e`이고 최신 기능 통합 지점은 `dev@2ce8953c76fbf5cb33aff9f8a57b303acbf05cdb`다. 개발 정본은 #171까지 81 migrations / OpenAPI 0.5.1 129 paths / 139 operations이고 #172는 82번째 feature 후보다. production runtime은 78 migrations / OpenAPI 0.5.1 128 paths / 138 operations이다. Pages parity와 기존 관리자 `guestCount` UAT는 완료됐지만 #256 사진 정규화와 #250/#264 배정 후속의 운영 승격은 남아 있다.
- Web Push는 사용자 실제 기기 수신을 확인했다. 내부 health와 secret 상태는 별도 안전 projection으로 확인한다.
- Google human owner는 `yeosucastletheart@gmail.com`으로 정했고, 서버는 별도 최소 권한 service account를 사용한다. 실제 target/credential/Cron 활성화는 별도 운영 gate다.
- 원 maid가 퇴사·부상 등으로 수행 불가한 일반 청소는 현재 배정을 취소하고 같은 target을 미배정으로 돌린다. 검수 반려 재청소는 기존 0원 target을 이력으로 종료하고 원 유상 snapshot의 별도 ordinary replacement target을 만든다. 관리자 알림과 backend API는 #264로 source/dev 완료됐고 프런트 연결·운영 승격은 후속이다. 별도 보상 원장은 만들지 않는다.
- DB 논리 백업은 매일 01:00~06:00 KST, 15일 보관으로 확정했다. 정확한 시각과 추후 지정할 PC 로컬 경로는 아직 입력값이다.
- `v0.3.0`은 소급 tag/Release를 만들지 않으며, `v0.5.1` tag/GitHub Release도 별도 승인 전까지 발행하지 않는다.

새 작업은 사용자가 확인할 실제 기능과 API 연결을 먼저 작은 PR로 닫고, 검증·보안 후속을 숨기지 않고 Issue로 남긴다. 정책 미확정이나 외부 자격증명·저장 경로는 추측하지 않는다.
