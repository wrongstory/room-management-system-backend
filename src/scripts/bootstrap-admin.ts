import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { createSupabaseClients } from '../lib/supabase.js';
import { SupabaseAccountService } from '../modules/accounts/account.service.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const displayName = argument('name');
const phone = argument('phone');
if (!displayName || !phone) {
  throw new Error('사용법: npm run bootstrap:admin -- --name "관리자 이름" --phone "010-0000-0000"');
}

const env = loadEnv();
if (env.APP_ENV === 'local' && !['127.0.0.1', 'localhost'].includes(new URL(env.SUPABASE_URL).hostname)) {
  throw new Error('APP_ENV와 Supabase 대상이 일치하지 않습니다.');
}

const service = new SupabaseAccountService(createSupabaseClients(env), env.ACCOUNT_PHONE_PEPPER);
const result = await service.bootstrapFirstAdmin({
  displayName,
  phone,
  idempotencyKey: argument('idempotency-key') ?? `bootstrap-admin:${randomUUID()}`
});

process.stdout.write([
  `최초 관리자 생성 완료: ${result.account.displayName}`,
  `로그인 아이디: ${result.account.loginId}`,
  `임시 비밀번호: ${result.temporaryPassword}`,
  '첫 로그인 직후 숫자 6자리 이상의 개인 비밀번호로 변경하세요.'
].join('\n'));
