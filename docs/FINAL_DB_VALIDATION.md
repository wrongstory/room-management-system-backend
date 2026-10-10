# #431 최종 1회 DB 검증 정책

2026-10-10 사용자가 승인한 검증 실행 시점 변경이다. 전체 검사 내용/통과 기준은 유지한다.
운영 migration 적용과 CI의 격리 DB 재구축은 다른 작업이다. 신규 SQL이 없으면 운영 적용0회다.

## 실행 위치

| 이벤트 | application | required migration |
|---|---|---|
| 일반 작업 → dev | 기존 전체 application | manifest + 실행 정책, 전체 DB NOT RUN |
| release/vX.Y.Z → main | 기존 전체 application | 최종 DB 전체 검사 또는 같은 PR/입력의 성공 증거 재사용 |
| 승인 hotfix → main | 기존 전체 application | 동일 최종 검증 규칙 |
| main push | 기존 전체 application | 해당 merged PR의 동일 입력 성공 증거 확인만; 누락/불일치 FAIL |

required check 이름은 유지하므로 원격 브랜치 보호를 끄거나 required 항목을 제거하지 않는다.
Draft release는 최종 검증 대상이다. 최종 기능을 모은 뒤 릴리스 PR을 만들며, 이후 검증
입력이 바뀌면 새 최종본의 검사가 필요하다. CI 실패 해결을 위한 재시도는 가능하지만
실패/취소를 성공으로 재사용하지 않는다. 일반 PR의 빠른 migration PASS는 전체 DB PASS가 아니다.

## 검증 입력과 성공 증거

`scripts/db-validation-gate.mjs`는 PR의 실제 테스트 merge commit(GITHUB_SHA) Git tree에서
mode/blob/path를 SHA256으로 묶는다. checkout CRLF와 squash commit ID 차이는 무관하다.
runtime/전체 SQL/config/seed/DB 및 application 테스트/scripts/lockfile/CI/비문서 파일을
모두 포함한다. 제외는 docs/*.md, 루트 README.md와 AGENTS.md의 서술 문서뿐이다.
docs의 JSON manifest/DBML 등 비Markdown은 포함한다. 앞으로 Markdown을 실행 입력으로
사용한다면 제외 정책과 지문 버전을 함께 변경해야 한다. 환경변수나 저장 DB 캐시는 재사용하지 않는다.

전체 DB 단계와 cleanup까지 성공한 migration job만 `Full DB proof <fingerprint>` 성공
step을 남긴다. 재사용은 동일 저장소·quality workflow·동일 release PR·성공한 run과
최신 run attempt의 migration 성공/해당 proof 성공을 API로 대조한다.
병합 뒤 GitHub run의 PR 배열이 비면 exact head commit의 연결 PR API로 동일 PR·저장소·
브랜치 관계를 복원하며 브랜치 이름만 같다고 재사용하지 않는다. 원 run의 workflow와
gate script blob도 현재와 같아야 하며 이름만 같은 다른 job/실패/skip은 증거가 아니다.
재사용 실행은 새 full proof를 만들지 않아 원래 실제 실행까지 직접 추적한다.
같은 브랜치의 최근 최대300 runs를 확인한다. 과거 증거가 없으면 release에서는 전체 실행,
main에서는 FAIL이다. API 조회 오류는 cache miss나 성공으로 숨기지 않고 FAIL이다.

main 검사는 exact main SHA를 merge_commit_sha로 가진 단 하나의 merged release/hotfix PR을
확인한 뒤 그 PR의 동일 지문 증거만 사용한다. 다른 PR의 우연히 같은 입력을 사용하지 않는다.
이 확인이 끝나기 전 배포하지 않는다. 수동으로 성공 status를 게시하거나 관리자 우회하지 않는다.

## 기존 전체 검사 유지

fresh db:verify → template contract → exact lint baseline → 합성 backup dry-run →
전체 db:test/upgrade → static warning upgrade → KST clock → concurrency → cleanup.
모든 명령과 timeout40분을 유지하며 테스트 삭제/skip/continue-on-error를 추가하지 않는다.
운영 백업/복원은 사용자 결정대로 후속이며 CI 합성 검사를 실제 운영 복원으로 표현하지 않는다.

## 전환과 현재 제한

#431 이전 workflow에는 입력 지문 proof가 없다. 기존 성공 이력을 새 증거로 조작하지 않는다.
정책 변경을 dev에 보호 병합 후 release에 통합하고, 새 검증 입력으로 최종1회를 수행한다.
이후 동일 릴리스의 문서-only 갱신/main squash 때문에 DB 전체를 반복하지 않는다.
실제 hosted release/main 재사용 경로 확인 전 로컬 합성 테스트만으로 원격 동작 PASS를 주장하지 않는다.

참고: [GitHub PR merge SHA](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[workflow jobs와 steps](https://docs.github.com/en/rest/actions/workflow-jobs).
