# #305 업무 기한 비차단·상호 알림 source/dev 종료 감사

## 상태와 종료 경계

2026-10-02 기능 통합 기준은 `dev@4fe6c981ff8252a55ce707525d2e659ed9f2d0a0`이다.
#305의 필수 기능은 source/dev 완료했으며 추가 필수 기능 누락은 정적 종료 감사에서 발견하지 못했다.
마지막 문서 정합화는 이 문서가 포함된 docs-only PR의 exact-head required CI·독립 QA·dev 병합을
확인한 뒤에만 종료한다. 이 문서는 미래 병합 SHA나 검증 PASS를 선기록하지 않는다.

이번 정합화는 코드·SQL·manifest·API·권한·CAS·멱등성·알림 불변식을 변경하지 않는다.
92 migrations / OpenAPI 131 paths·141 operations / typed catalog 59 event family·42 public category가
dev source 기준이며 운영 배포 집계가 아니다. 프런트 전체 제품 기준 commit은 갱신하지 않는다.

## 요구사항별 완료 근거

| #305 요구사항 | source 근거 | 종료 판정 범위 |
|---|---|---|
| 컴플레인 접수·최초 응답 기한 비차단 | #306, PR #307/#310, [v0.6.5 기록](./RELEASE_V0.6.5.md) | source 및 당시 #309 운영 적용; hosted positive는 SKIPPED 유지 |
| 지연 배정·수행 업무와 원 날짜/담당/회차 보존 | #308, PR #340, [지연 업무 계약](./CLEANING_OVERDUE.md) | source/dev 완료; 운영 승격 별도 |
| 과거 미배정의 오늘 preview/list/commit 및 현재 가능일 보호 | #308 PR #340, [preview 계약](./ASSIGNMENT_PREVIEW.md) | source/dev 완료; #320 실제 사례/UAT 미확정 |
| 메이드 시작·신고 및 관리자 판정 등 상대 역할 알림 | #308 PR #340, [coverage](./CLEANING_REPORT_NOTIFICATIONS.md), [catalog](./NOTIFICATION_CATALOG.md) | source/dev 완료; 개별 사진 업로드·조회는 업무 상태 변경이 아님 |
| 최초 판정 미응답 관리자 주의 | #343 PR #346, [컴플레인 주의 계약](./COMPLAINT_RESPONSE_ATTENTION.md) | source/dev 완료; 응답 만료·자동 종결·수익 변경 없음 |
| 문서·오류 계약 및 역할/RLS·원자성·동시성 회귀 | 아래 exact-source 근거와 이번 docs-only 정합화 | 문서 PR의 새 승인 gate 완료 후 #305 source/dev 종료 |

`ASSIGNMENT_WINDOW_EXPIRED`가 남은 과거 snapshot 호환 설명은 현재 dueAt 차단 정책을 뜻하지 않는다.
보안 session/PIN/offline/capability TTL, 실제 점유·퇴실, 현재 담당·terminal·CAS 검사는 계속 유지한다.

## 승인 source와 dev tree 동일성

| 구현 | 승인 source | dev squash | 같은 tree | CI / QA |
|---|---|---|---|---|
| #308 / [PR #340](https://github.com/wrongstory/room-management-system-backend/pull/340) | bdf3cda2347041134a73708f4209c4a36907f140 | 4d85458c5d0a900cf87f7318fcd9b2474c03a889 | 6013c056dd32208ce375138d17918de4bbfa3743 | [36864792279](https://github.com/wrongstory/room-management-system-backend/actions/runs/36864792279) application/migration SUCCESS; QA98/100 |
| #343 / [PR #346](https://github.com/wrongstory/room-management-system-backend/pull/346) | cc7eb199fae8f6b56408c932a8d4ea6b76d881b7 | 4fe6c981ff8252a55ce707525d2e659ed9f2d0a0 | 2c8e06ef48846a28670f472f6bdc3b1be8c5221f | [36952950791 attempt2](https://github.com/wrongstory/room-management-system-backend/actions/runs/36952950791/attempts/2) application/migration SUCCESS; QA98/100 |

PR #340은 2026-10-02 05:57:43 KST, PR #346은 11:45:35 KST dev에 squash 병합됐다.
#308은 Node628/Edge301/Python95, 91 migrations/17 upgrades/69 SQL·3,711 assertions,
KST145/전체 실제 RPC 경합/121실 local-synthetic 복구 PASS였다.
#343은 Node694(helper53 포함)/Edge304/Python95, 92 migrations/18 upgrades/70 SQL·3,784 assertions,
KST145/기존 전체 RPC 경합·신규 fresh standalone·cleanup/121실 local-synthetic 복구 PASS였다.
#343 exact-source backup은 154 tables/RLS 누락0/rowCountsMatched=true였다.
최종 [독립 QA 기록](https://github.com/wrongstory/room-management-system-backend/pull/346#issuecomment-5944642643)은
현재 변경 범위 P0/P1/P2=0이다. 이 구현 검증을 이번 문서 PR의 새 exact-head CI로 대신 표시하지 않는다.

## 보존할 실패·재검증 이력

- `36933939890@3401021`은 새 push로 CANCELLED됐으며 timeout/FAIL로 확정하지 않는다.
- `36935605522@5267f35`는 application SUCCESS / migration FAIL이었다.
  upgrade/SQL/KST/기존 전체 동시성/cleanup은 PASS였으나 신규 standalone의 8-way same-key
  all-success assertion에서 실패했다. 개별 RPC status/code가 없어 원인은 미확정이다.
  read-only 준비 검사 추가와 이후 로컬 PASS는 과거 원인 확정이나 최초 실패 상쇄가 아니다.
- `36952950791@cc7eb199` attempt1은 기존 `password_change_replay.sql` test85의
  whole-row secret-pattern 검사에서 FAIL했고 KST/concurrency는 SKIPPED였다. cleanup은 PASS다.
  유효한 nonsecret UUID만으로도 해당 regex에 일치할 수 있음을 합성 반례로 확인했지만
  원격 실패의 실제 매칭 필드는 기록되지 않아 미확정이다. 실제 유출/확정 오탐으로 단정하지 않는다.
- 독립 QA 검토 후 같은 immutable head·같은 기준으로 failed migration job을 한 번 제한 재실행했다.
  attempt2는 SUCCESS(2026-10-02 11:37:57 KST, migration20m25s)였지만
  [#300](https://github.com/wrongstory/room-management-system-backend/issues/300)은 해결되지 않았다.
  검사 삭제·skip·완화나 실제 mutation RPC 재시도는 없었다. 검사 기준 변경에는 별도 결정·보안 검토가 필요하다.

## #305와 분리해 OPEN 유지하는 항목

| 후속 | 남은 범위 |
|---|---|
| [#13](https://github.com/wrongstory/room-management-system-backend/issues/13) | 실제 hosted/browser 역할별 E2E 및 안전 fixture 기반 complaint positive mutation |
| [#300](https://github.com/wrongstory/room-management-system-backend/issues/300) | password whole-row 검사 비민감 값 매칭 경계와 결정·보안 검토 |
| [#320](https://github.com/wrongstory/room-management-system-backend/issues/320) / PR #339 | 0-target 실제 신고의 원인·당시 응답·프런트 한국어 매핑/UAT; 진단 source 통합과 별개 |
| [#341](https://github.com/wrongstory/room-management-system-backend/issues/341) | pinned Edge 이미지 다운로드 제한의 CI 재발 방지 |
| [#342](https://github.com/wrongstory/room-management-system-backend/issues/342) | 대형 실패 배정 요청의 잠금 비용 P2; 부분 저장/무결성 결함은 확인하지 못함 |
| [#344](https://github.com/wrongstory/room-management-system-backend/issues/344) | 프런트 운영 알림·submission 라우팅 배포 artifact와 실제 UAT |
| [#345](https://github.com/wrongstory/room-management-system-backend/issues/345) | 기존 cleaning.overdue_admin late-admin push의 original-event clock / 24h TTL 경계 |

#343의 신규 complaint delivery만 enrollment clock으로 기존 24h TTL을 적용한다.
기존 청소 지연 family의 durable inbox/업무 비차단 완료를 모든 늦은 관리자 push 전달 완료로 확대하지 않는다.
main/release, production/recovery DB·API/Edge·Cron/provider, 프런트 수정, tag/Release/UAT는 이번 범위 밖이다.
`main@1780728a02144c0816565ba091e43a8b3e126c4f`는 이번 source 작업에서 변경하지 않는다.

## 다음 기능 작업

#305 문서 PR 승인·dev 통합·종료 확인 → #326 → #328 → #327 순으로 진행한다.
#326의 snapshot 조회 보강은 과거 타입/요금·0/null·실제 이월 provenance를 보존해야 한다.
수동 청소 target 취소의 가이드/현행 명령 차이는 선행 확인하고 새 취소 정책을 추측하지 않는다.
