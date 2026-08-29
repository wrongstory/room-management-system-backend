import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { createSupabaseClients } from '../lib/supabase.js';
import { SupabaseAccountService } from '../modules/accounts/account.service.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readHiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('개발자 비밀번호는 공유되지 않는 대화형 터미널에서 입력해야 합니다.');
  }

  process.stdout.write('개발자 개인 비밀번호: ');
  return new Promise((resolve, reject) => {
    let password = '';
    const input = process.stdin;
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      const value = chunk.toString();
      for (const character of value) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('개발자 bootstrap이 취소되었습니다.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(password);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        password += character;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

const displayName = argument('name');
const phone = argument('phone');
if (!displayName || !phone) {
  throw new Error('사용법: npm run bootstrap:developer -- --name admin --phone "010-0000-0000"');
}

const env = loadEnv();
if (env.APP_ENV === 'local' && !['127.0.0.1', 'localhost'].includes(new URL(env.SUPABASE_URL).hostname)) {
  throw new Error('APP_ENV와 Supabase 대상이 일치하지 않습니다.');
}

const service = new SupabaseAccountService(createSupabaseClients(env), env.ACCOUNT_PHONE_PEPPER);
const result = await service.bootstrapFirstDeveloper({
  displayName,
  phone,
  password: await readHiddenPassword(),
  idempotencyKey: argument('idempotency-key') ?? `bootstrap-developer:${randomUUID()}`
});

process.stdout.write([
  `최상위 개발자 생성 완료: ${result.displayName}`,
  `로그인 아이디: ${result.loginId}`,
  '비밀번호는 출력하거나 저장하지 않았습니다.'
].join('\n'));
