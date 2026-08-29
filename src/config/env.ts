import { z } from 'zod';

const optionalProjectRef = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().regex(/^[a-z]{20}$/).optional()
);

const envSchema = z.object({
  APP_ENV: z.enum(['local', 'development', 'production']).default('local'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://127.0.0.1:4173,http://localhost:4173'),
  SUPABASE_URL: z.url(),
  SUPABASE_PROJECT_REF: optionalProjectRef,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ACCOUNT_PHONE_PEPPER: z.string().min(32),
  RESERVATION_PII_KEY_BASE64: z.string().min(1),
  RESERVATION_PII_KEY_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).default('v1'),
  RESERVATION_PII_KEYRING_JSON: z.string().default('{}'),
  RESERVATION_GUEST_NAME_PEPPER: z.string().min(32),
  RESERVATION_SCHEDULER_ACTOR_PROFILE_ID: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.uuid().optional()
  ),
  RESERVATION_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(60)
}).superRefine((env, context) => {
  const supabaseUrl = new URL(env.SUPABASE_URL);
  const isLocalSupabase = ['127.0.0.1', 'localhost'].includes(supabaseUrl.hostname);

  if (env.SUPABASE_PUBLISHABLE_KEY === env.SUPABASE_SECRET_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['SUPABASE_SECRET_KEY'],
      message: 'publishable key와 server secret은 서로 달라야 합니다.'
    });
  }

  if (env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_')) {
    context.addIssue({
      code: 'custom',
      path: ['SUPABASE_SECRET_KEY'],
      message: 'SUPABASE_SECRET_KEY에 publishable key를 사용할 수 없습니다.'
    });
  }

  try {
    const reservationPiiKey = Buffer.from(env.RESERVATION_PII_KEY_BASE64, 'base64');
    if (
      reservationPiiKey.length !== 32 ||
      reservationPiiKey.toString('base64') !== env.RESERVATION_PII_KEY_BASE64
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RESERVATION_PII_KEY_BASE64'],
        message: '예약 개인정보 암호키는 Base64로 인코딩한 32바이트여야 합니다.'
      });
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['RESERVATION_PII_KEY_BASE64'],
      message: '예약 개인정보 암호키가 올바른 Base64가 아닙니다.'
    });
  }

  try {
    const keyring = JSON.parse(env.RESERVATION_PII_KEYRING_JSON) as unknown;
    if (!keyring || Array.isArray(keyring) || typeof keyring !== 'object') {
      throw new Error('keyring must be an object');
    }
    for (const [version, encodedKey] of Object.entries(keyring)) {
      const key = typeof encodedKey === 'string' ? Buffer.from(encodedKey, 'base64') : null;
      if (
        !/^[A-Za-z0-9._-]{1,32}$/.test(version) ||
        !key ||
        key.length !== 32 ||
        key.toString('base64') !== encodedKey
      ) {
        throw new Error('invalid keyring entry');
      }
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['RESERVATION_PII_KEYRING_JSON'],
      message: '예약 개인정보 이전 키 모음은 version별 Base64 32바이트 키 JSON 객체여야 합니다.'
    });
  }

  if (env.APP_ENV === 'local' && !isLocalSupabase) {
    context.addIssue({
      code: 'custom',
      path: ['SUPABASE_URL'],
      message: 'local 환경은 로컬 Supabase URL만 사용할 수 있습니다.'
    });
  }

  if (env.APP_ENV === 'production') {
    if (isLocalSupabase || supabaseUrl.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: 'production 환경은 HTTPS 원격 Supabase URL을 사용해야 합니다.'
      });
    }

    if (!env.SUPABASE_PROJECT_REF) {
      context.addIssue({
        code: 'custom',
        path: ['SUPABASE_PROJECT_REF'],
        message: 'production 환경에는 프로젝트 Ref가 필요합니다.'
      });
    }

    if (!env.RESERVATION_SCHEDULER_ACTOR_PROFILE_ID) {
      context.addIssue({
        code: 'custom',
        path: ['RESERVATION_SCHEDULER_ACTOR_PROFILE_ID'],
        message: 'production 환경에는 예약 전이 scheduler 관리자 profile ID가 필요합니다.'
      });
    }

    const origins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
    if (origins.some((origin) => !origin.startsWith('https://'))) {
      context.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'production CORS origin은 모두 HTTPS여야 합니다.'
      });
    }
  }

  if (!isLocalSupabase && env.SUPABASE_PROJECT_REF) {
    const expectedHost = `${env.SUPABASE_PROJECT_REF}.supabase.co`;
    if (supabaseUrl.hostname !== expectedHost) {
      context.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: `SUPABASE_URL은 프로젝트 Ref와 일치하는 ${expectedHost}여야 합니다.`
      });
    }
  }
});

export type AppEnv = z.infer<typeof envSchema> & { corsOrigins: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(source);

  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
}
