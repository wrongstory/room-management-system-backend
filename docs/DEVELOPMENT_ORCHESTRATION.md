# 개발 오케스트레이션·source 승인 기준

2026-09-08 사용자의 최신 명시적 위임을 기록한다. 이전 PR #74의 별도 병합 허가 대기는
아래 source/dev 평가·승인 규칙으로 대체됐다. 제품 정책의 미확정 사항을 결정할 권한이나
production/recovery/main/release 승격 권한까지 위임된 것은 아니다.

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

## 지속 진행

현재 task의 30분 주기 heartbeat가 중단 후 작업 상태를 다시 확인한다. 새 사용자 지시를 먼저
확인하고 실행 중인 서브에이전트·작업 트리·원격 head를 대조해 중복 작업을 시작하지 않는다.
상태가 그대로면 불필요한 알림을 보내지 않으며, 의미 있는 완료·실패·승인 요청만 전달한다.
승인된 개발 범위가 끝나면 후속 실행을 멈추고 별도 운영 gate를 보고한다.

진행 순서는 #7A → #7B → #7C → #30 → #9 → #31이며 정산/알림/복구/전체 E2E와
#34/#44/#46/#69/#73 후속도 ROADMAP에서 추적한다. 정책 미확정이나 외부 자격증명은 추측하지 않는다.
