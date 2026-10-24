# 내부 합성 프로세스 감독 경계 — #273

> 2026-10-04 최신 B안은 기존 Supabase recovery 사용·로컬 백업 보관 제외다.
> 아래 Windows 저장소 검증 이력은 보존하지만 외부 PowerShell 실행을 다시 요구하지 않는다.
> [현재 원격 백업 계획](./SUPABASE_ONLY_BACKUP.md)을 따른다.

## 현재 범위

`scripts/lib/backup-process-boundary.mjs`는 백업 실행기 개발의 일부인 **합성 전용** 경계다.
고정된 Node 프로브 7종으로 입력 pipe 정체, 출력 폭주, 비정상 종료, timeout과 종료 확인을
검증한다. 임의 실행 파일·명령행·환경변수·작업 경로·입력 payload·callback을 받지 않는다.
운영 credential, DB 연결, dump, 암호화 데이터 저장, 복원, 성공 게시, prune, Task 기능은 없다.
`backup:plan`은 계속 `LEXICAL_ONLY`, `executionAllowed=false`, 실행 gate21개 `NOT_VERIFIED`다.

호출은 라이브러리 내부 합성 검사이며 새 운영 CLI나 환경 변수 설정을 추가하지 않는다.
고정 프로브는 descendants·파일·네트워크·credential 접근을 하지 않는다. 외부 output은 내용이
아니라 제한된 byte count만 보고하고, native exception의 message/cause/stack은 반환하지 않는다.

## 시간·출력·종료 계약

- data-only 옵션 검증 후 monotonic 전체 예산으로 runtime preflight와 child 실행을 제한한다.
- metadata 검사 기한 초과는 `PRECHECK_DEADLINE`, spawn 전 실패로 반환한다. 진행 중인 OS
  metadata IO 자체를 취소했다는 뜻은 아니며 늦은 결과로 다음 IO나 child를 실행하지 않는다.
- stdin 완료 기한, 전체 예산, 종료 확인 기한은 별도다. 출력은 기본 각각8KiB이며 상한을
  넘기면 즉시 해당 소유 child를 종료 요청한다. 무제한 출력 내용을 누적하지 않는다.
- 고정 Node 실행 파일만 `shell:false`, `windowsHide:true`로 실행한다.
- kill 요청 또는 exit만으로 성공하지 않는다. process와 stdio의 실제 `close`를 확인해야 한다.
  확인 불가는 `PROCESS_STOP_UNCONFIRMED`이며 성공으로 승격하지 않는다.
- 반환은 mode·고정 code·spawn/close/termination/stdin boolean·bounded byte count뿐이다.
  실제 backup/restore를 수행했다는 표시는 없다.

지원되는 Windows 합성 runtime은 현재 검증한 `C:\Windows` 설치뿐이다. Windows/System32/
kernel32.dll의 regular/no-symlink·realpath metadata를 확인하고 SYSTEMROOT/WINDIR를 명시한다.
부모의 환경변수 값은 읽거나 상속하지 않는다. Windows libuv essential variables와 Node의
coverage/options 자동 전달도 명시 값/빈 값으로 차단한다. 다른 설치를 추정해서 허용하지 않는다.
이 고정 합성 정책을 일반 운영 dump 실행기의 environment/TLS/프로그램 신뢰 검증으로 재사용하지 않는다.

## Windows 저장소의 별도 실행 gate

2026-10-04 Codex 내부 합성 native 검사에서는 요청한 LocalAppData 디렉터리와 실제 열린
핸들 경로가 달라 `BACKUP_STORAGE_HANDLE_PATH_MISMATCH`로 중단했다. 실제 경로가 MSIX
앱의 LocalCache 아래에 있음을 확인했으며 alias 허용·검사 완화로 통과시키지 않았다.
storage/분리 DPAPI 백업키/동시 실행 잠금의 native 완료 검증은 아직 별도다.

사용자는 과거 **기존 승인 경로를 유지하고 Codex 밖의 Windows PowerShell에서 준비**하기로 결정했으나,
이후 B안으로 로컬 백업 보관을 제외했다. 아래 native gate는 이력이며 현재 실행 지시가 아니다.
앱 전용 캐시는 앱 제거/초기화에 따른 데이터 수명 위험이 있으므로 성공 백업 정본으로 채택하지 않는다.
기존 credential도 metadata만 확인한 결과 앱 캐시에 있으며 ciphertext는 읽거나 이동하지 않았다.
이전 TLS 읽기 전용 접속 PASS는 연결 성공의 증거이고 파일 보관 위치·독립 복구 보장의 증거는 아니다.

합성 fixture와 실패 증거는 운영 백업이 아니다. 운영 approved root·기존 암호화 credential·DB·
Auth 설정·PIN/PII 키·지급 원장·provider·기존 recovery는 이번 source 작업에서 변경하지 않았다.
새 실행 경로 준비가 끝나도 실제 Auth/업무/hosted history의 일관된 백업과 전체 격리 복원은 별도다.

## 검증 및 실패 이력

전체 제품 기준 테스트1547건은 통과했다. 최초 명령은 ignored `.tmp`의 Node VM 진단 파일을
Vitest가 잘못 수집해 FAIL했으며 해당 임시 파일의 이름만 분리한 재실행은1547/70 PASS였다.
제품 test/config/검사 기준은 변경하지 않았다.

프로세스 회귀의 최초 환경 격리 FAIL은 libuv/Node의 자동 전달 때문이었다. essential 변수를
모두 빈 값으로 주었을 때 Windows Node 초기화도 FAIL했다. 현재 고정 Windows metadata/
SYSTEMROOT/WINDIR·명시 shadow 정책으로 보완했으며 부모 secret 값은 읽지 않았다.
이후 전체 `npm test`의 **1584 PASS / 3 FAIL**은 stdout/stderr/whole 검사보다100ms stdin
deadline이 먼저 만료된 Windows 시작 시간 경합이었다. 실제 OS4검사는 기존 기본 기한
(whole2000ms/stdin1000ms/종료500ms)을 사용하고, fake child·가상 시계4검사로 출력32/33byte,
stdin100ms/whole150ms 경계를 정확히 검증했다. 소스 상한·기준을 낮추거나 skip하지 않았다.

최신 검증(2026-10-04): targeted44/44, 전체1591/71, `npm run ci:quality`, migration manifest5종,
`git diff --check` PASS다. 독립 QA는 P0/P1/P2 발견0건, 별도 VM39 assertions와 실제 고정 child의
가짜 비밀 환경변수 격리 검사 PASS다. VM 첫 검사는 realm이 다른 옵션 prototype으로 fixture가
거부된 harness 오류였고 fixture만 보완한 재실행이 PASS이며 소스 변경은 없다.
기존 PR exact HEAD의 CI PASS를 미커밋 변경의 CI로 대신하지 않는다. 신규 exact-head 원격 CI는
commit/push 후 확인할 gate다. 이 검증은 실제 backup/restore/Auth 교체 PASS가 아니다.

공식 근거:

- [Microsoft MSIX flexible virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)
- [Windows native handle과 share 계약](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Node child process](https://nodejs.org/api/child_process.html)

[1회 백업 준비](./ONE_TIME_BACKUP_PREPARATION.md), [백업·복구 정책](./BACKUP_AND_RECOVERY.md)를 함께 따른다.
