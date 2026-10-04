# 배포 전 1회 백업의 비활성 안전 기반 — #273

## 현재 범위

이번 source는 **계획 검사와 암호화 기반**이다. 운영 연결, credential 복호화,
DPAPI 키 저장, dump, 복원, 보관 폴더 생성, prune 또는 Scheduled Task를 실행하지 않는다.
`PLANNED_NOT_EXECUTABLE`은 실행 허가·실제 안전 검사 통과·복구 성공을 뜻하지 않는다.
기존 `backup:dry-run`의 local-synthetic 제한도 변경하지 않는다.

사용자 결정(2026-10-04): 이번 배포 전 성공 백업을 명시 지정한 로컬 전용 경로에
15일 암호화 보관하고, 백업 파일과 분리한 키를 현재 Windows 계정으로 보호한다.
실제 Auth 데이터까지 로컬 격리 DB에서 전체 복원 검증하며 기존 Supabase recovery
프로젝트의 Auth·테스트 계정은 보존한다. 개인 PC 경로는 코드의 기본값/제품값으로 고정하지
않는다. 이 1회 선택은 정기 스케줄 설치나 recovery 원격 초기화 승인이 아니다.

source 작업 단위는 #273의 일부이고 운영 migration 실행 계층은 별도 #378이다.
이번 기반 구현만으로 #273, 자동화 #12, 배포 #364를 종료하지 않는다.

## 계획 검사

```sh
npm run backup:plan -- --help
npm run backup:plan -- --config <명시적으로_지정한_비밀없는_config.json>
```

명령은 16 KiB 이하의 명시 JSON 한 파일만 읽고 안전한 계획 또는 고정 오류 코드만 출력한다.
실행 옵션·unknown field·연결 문자열·평문 credential·잘못된 프로젝트·경로·보관 정책을 거부한다.
경로와 secret reference는 출력하지 않는다. config 자체도 로컬 전용이며 Git에 넣지 않는다.
아래 값은 합성 예시이고 사용자 PC의 기본 설정이 아니다. credential과 key의 `.dpapi` 경로는
참조일 뿐 파일 존재·ACL·정상 DPAPI 복호화의 증거가 아니다.

```json
{
  "version": 1,
  "mode": "plan",
  "sourceProjectRef": "aodikrxcczbogjpsjwjt",
  "retentionDays": 15,
  "localAppDataDirectory": "C:\\Users\\operator\\AppData\\Local",
  "repositoryDirectories": ["C:\\Repositories\\backend"],
  "backupDirectory": "C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\ReleaseBackups",
  "credentialReference": {
    "kind": "windows-dpapi-current-user",
    "path": "C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\Secrets\\connection.dpapi"
  },
  "backupKeyReference": {
    "kind": "windows-dpapi-current-user",
    "path": "C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\Secrets\\backup-key.dpapi"
  },
  "restoreTarget": {
    "kind": "local-isolated-database",
    "isolationId": "17f3376c-9a9e-4e29-a3aa-6822e918899d"
  }
}
```

계획의 경로 검사는 lexical 검사다. 실제 Windows known-folder 대조, 모든 상위 경로의
reparse point 검사, 현재 SID/SYSTEM만의 보호 ACL과 파일·키 분리 검사는 실행 계층에서
별도로 수행해야 한다. 경로 문자열이 통과했다는 이유로 파일을 쓰거나 운영에 접속하지 않는다.

## 암호화 기반

`scripts/lib/backup-artifact-crypto.mjs`는 Node 내장 암호 구현으로 bounded Buffer artifact를
암호화·검증한다. AES-256-GCM의 AAD에 허용된 비밀 없는 metadata를 결합하고 변조·잘림·잘못된
키를 거부한다. 인증 확인 전 복호화 결과를 반환하지 않으며 외부 IO·로그 기능은 없다.
백업 암호화 키와 기존 객실 PIN/PII 암호키는 서로 다른 키다. 백업 복호화는 내부 PIN 암호문을
복호화하거나 recovery에 운영 키를 자동 주입하는 기능이 아니다.

현재 Buffer 상한은 64 MiB다. 전체 운영 dump의 크기가 이 범위에 들어온다고 가정하지 않는다.
대형 dump의 제한된 streaming·인증 완료 전 격리·키 수명/지속적 nonce 유일성·DPAPI 보관은
후속 실행기에서 구현·검증해야 한다. source 안의 nonce 충돌 방지는 프로세스 내 방어이며
재시작 이후의 지속 상태나 실제 운영 credential 준비를 보장하지 않는다.

## 실제 실행 전에 남은 gate

- 안전한 기존 direct/session credential 준비, TLS verify-full 및 CA/연결 대상 확인.
  비밀번호 재설정이나 URI/비밀번호의 명령행·chat·로그 전달은 하지 않는다.
- 모든 업무/원장/receipt·PIN ciphertext/current/nonce/key-version/AAD와 실제 Auth 데이터,
  hosted migration history, roles/ACL/RLS/함수/앱 소유 Auth trigger를 보존하는 일관된 snapshot.
  CLI 기본 dump에 history가 자동 포함된다고 가정하지 않는다.
- 새 격리 대상은 일반 앱/Auth/worker 접속·provider egress가 없어야 하며 이전 성공 사본과
  기존 local Supabase DB를 덮지 않는다. 운영/원격 recovery의 managed schema를 초기화하지 않는다.
- schema/data 관계와 FK를 실제로 검사한다. `session_replication_role=replica`는 FK trigger도
  비활성화하므로 restore 명령 성공·row count만으로 무결성을 선언하지 않는다.
- 원장/receipt/PIN 암호문과 이력의 동일성, 활성 관리자·121실·RLS·critical signature/grant 확인.
  복원 검사에서 원문 개인정보·PIN·Auth hash/token·dump를 출력하지 않는다.
- 제한된 실행 시간·동시 실행 잠금·실패 artifact 격리·인증된 파일/hash/manifest 확인 후에만
  immutable success와 latest-success 포인터를 원자 게시한다. 실패 시 이전 성공본을 보존한다.
- 성공본 15일 보관, 직전 성공 보호, 검증된 정확한 삭제 대상만 정리.
  Windows 계정/PC 손실 시 DPAPI 키 복구 가능성은 현재 계정 보호와 별개다.

Google Drive 사진 객체는 DB 백업 대상이 아니다. 운영 keys/Auth 설정/PIN 변경·송금·PAID·provider
mutation·정기 Task 활성화는 이번 기반 구현과 자동 smoke에 포함하지 않는다.

## 검증 경계

최종 로컬 검증(2026-10-04):

| 항목 | 실제 실행 결과 |
|---|---|
| `npm run ci:quality` | PASS: secret853, OpenAPI137/148, lint의 기존 INFO5, typecheck, Node1547/70, build |
| 기반 회귀 | 계획57·암호화40·CLI18, 합계115건 PASS |
| `npm run db:manifest:verify` | PASS: 기존5개 manifest, SQL/manifest 변경 없음 |
| `npm run backup:plan -- --help`·`git diff --check` | PASS |
| 독립 QA | PASS: 미해결 P0/P1/P2 없음; shadow-accessor48·revoked Proxy4경로, GCM 인증/zeroize probe, nonce 상한 상태 simulation |
| actual 운영 연결/dump/격리 복원/DPAPI 저장·폴더 생성/정기 Task | NOT RUN |

초기 typecheck의 테스트 byte-index 오류·CLI control-character regex lint FAIL은 기준을 유지해
보완했다. 초기 secret gate FAIL은 비밀번호가 들어간 합성 URL fixture 오탐이었으며 scanner
규칙을 바꾸지 않고 명백한 합성 URL을 runtime으로 구성해 같은 거부 회귀를 유지했다.
독립 검토에서 Proxy 및 ordinary Buffer의 shadow getter 경계를 보완했고 호출0회·고정 오류·
입력 불변을 다시 검사했다. 마지막 revoked Proxy metadata/options 보완 후 encrypt/decrypt
4경로도 고정 오류로 거부됨을 검증했다. crypto 초기 tag-format 및 최종 test readback의 species/getter
기대 오류도 보완 전 FAIL과 보완 후 PASS를 구분한다. 검사를 삭제하거나 기준을 완화하지 않았다.
독립 QA의 첫 zeroize probe는 VM realm metadata의 harness 오류였으며 null-prototype metadata로
재실행해 통과했다. nonce 상한 probe는 상태 simulation이고 실제 운영 암호화 65,536회나
프로세스 사이의 nonce 유일성 검증을 의미하지 않는다.

source의 단위/CLI·typecheck·lint·build·독립 QA와 actual 운영 연결/백업/격리 복원 결과를 구분한다.
actual 운영 연결·dump·복원은 아직 **NOT RUN**이다. 기존 synthetic PASS나 계획 출력으로 대체하지 않는다.
실제 source/검증/CI는 연결 PR에 기록하며, migration/API/권한/DB schema는 변경하지 않는다.

공식 확인 근거:

- [Supabase Backup and Restore: migration history와 Auth schema 변경 별도 보존](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [PostgreSQL 17 session_replication_role과 FK 검사](https://www.postgresql.org/docs/17/runtime-config-client.html)
- [Node.js GCM 인증 실패와 decipher.final](https://nodejs.org/api/crypto.html#decipherfinaloutputencoding)

[기존 백업 정책](./BACKUP_AND_RECOVERY.md), [제품 가이드](./AI_BACKEND_PRODUCT_GUIDE.md)를 함께 따른다.
