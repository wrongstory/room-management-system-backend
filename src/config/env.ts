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
  PAYROLL_CURSOR_HMAC_SECRET: z.string().trim().refine(
    (value) => Buffer.byteLength(value, 'utf8') >= 32,
    '주급 cursor HMAC 비밀값은 UTF-8 기준 32바이트 이상이어야 합니다.'
  ),
  NOTIFICATION_CURSOR_HMAC_SECRET: z.string().trim().refine(
    (value) => Buffer.byteLength(value, 'utf8') >= 32,
    '알림 cursor HMAC 비밀값은 UTF-8 기준 32바이트 이상이어야 합니다.'
  ),
  WEB_PUSH_SUBSCRIPTION_KEY_BASE64: z.string().min(1),
  WEB_PUSH_SUBSCRIPTION_KEY_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  WEB_PUSH_SUBSCRIPTION_KEYRING_JSON: z.string().default('{}').transform((value) => value.trim() || '{}'),
  WEB_PUSH_BINDING_DIGEST_SECRET: z.string().trim().refine(
    (value) => Buffer.byteLength(value, 'utf8') >= 32,
    'Web Push binding HMAC 비밀값은 UTF-8 기준 32바이트 이상이어야 합니다.'
  ),
  VAPID_CURRENT_KEY_VERSION: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  GOOGLE_DRIVE_CLIENT_ID: z.string().max(4096).optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().max(4096).optional(),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().max(4096).optional(),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().max(200).optional(),
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

  let reservationPiiKeyringSecrets: string[] = [];
  let webPushKeyringSecrets: string[] = [];
  try {
    const keyring = JSON.parse(env.RESERVATION_PII_KEYRING_JSON) as unknown;
    if (keyring && !Array.isArray(keyring) && typeof keyring === 'object') {
      reservationPiiKeyringSecrets = Object.values(keyring).filter(
        (value): value is string => typeof value === 'string'
      );
    }
  } catch {
    // The dedicated keyring validator below reports malformed JSON.
  }
  try {
    const keyring = JSON.parse(env.WEB_PUSH_SUBSCRIPTION_KEYRING_JSON) as unknown;
    if (keyring && !Array.isArray(keyring) && typeof keyring === 'object') {
      webPushKeyringSecrets = Object.values(keyring).filter((value): value is string => typeof value === 'string');
    }
  } catch {
    // The dedicated keyring validator below reports malformed JSON.
  }

  if ([
    env.SUPABASE_PUBLISHABLE_KEY,
    env.SUPABASE_SECRET_KEY,
    env.ACCOUNT_PHONE_PEPPER,
    env.RESERVATION_PII_KEY_BASE64,
    env.RESERVATION_GUEST_NAME_PEPPER,
    env.GOOGLE_DRIVE_CLIENT_ID,
    env.GOOGLE_DRIVE_CLIENT_SECRET,
    env.GOOGLE_DRIVE_REFRESH_TOKEN,
    env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    ...reservationPiiKeyringSecrets
  ].includes(env.PAYROLL_CURSOR_HMAC_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['PAYROLL_CURSOR_HMAC_SECRET'],
      message: '주급 cursor HMAC 비밀값은 다른 key/pepper와 분리해야 합니다.'
    });
  }

  if ([
    env.SUPABASE_PUBLISHABLE_KEY,
    env.SUPABASE_SECRET_KEY,
    env.ACCOUNT_PHONE_PEPPER,
    env.RESERVATION_PII_KEY_BASE64,
    env.RESERVATION_GUEST_NAME_PEPPER,
    env.PAYROLL_CURSOR_HMAC_SECRET,
    env.GOOGLE_DRIVE_CLIENT_ID,
    env.GOOGLE_DRIVE_CLIENT_SECRET,
    env.GOOGLE_DRIVE_REFRESH_TOKEN,
    env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    ...reservationPiiKeyringSecrets
  ].includes(env.NOTIFICATION_CURSOR_HMAC_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['NOTIFICATION_CURSOR_HMAC_SECRET'],
      message: '알림 cursor HMAC 비밀값은 다른 key/pepper와 분리해야 합니다.'
    });
  }

  const webPushSecrets = [env.WEB_PUSH_SUBSCRIPTION_KEY_BASE64, env.WEB_PUSH_BINDING_DIGEST_SECRET, ...webPushKeyringSecrets];
  const existingSecrets = [env.SUPABASE_PUBLISHABLE_KEY,env.SUPABASE_SECRET_KEY,env.ACCOUNT_PHONE_PEPPER,
    env.RESERVATION_PII_KEY_BASE64,env.RESERVATION_GUEST_NAME_PEPPER,env.PAYROLL_CURSOR_HMAC_SECRET,
    env.NOTIFICATION_CURSOR_HMAC_SECRET,env.GOOGLE_DRIVE_CLIENT_ID,env.GOOGLE_DRIVE_CLIENT_SECRET,
    env.GOOGLE_DRIVE_REFRESH_TOKEN,env.GOOGLE_DRIVE_ROOT_FOLDER_ID,...reservationPiiKeyringSecrets];
  if (webPushSecrets.some((value,index) => existingSecrets.includes(value) || webPushSecrets.indexOf(value)!==index)) {
    context.addIssue({code:'custom',path:['WEB_PUSH_BINDING_DIGEST_SECRET'],message:'Web Push key/digest는 모든 기존 비밀값 및 서로 간에 분리해야 합니다.'});
  }

  try {
    const publicKey=Buffer.from(env.VAPID_PUBLIC_KEY,'base64url');
    if(publicKey.length!==65||publicKey[0]!==4||publicKey.toString('base64url')!==env.VAPID_PUBLIC_KEY) throw new Error();
  } catch {
    context.addIssue({code:'custom',path:['VAPID_PUBLIC_KEY'],message:'VAPID 공개키는 canonical base64url P-256 uncompressed point여야 합니다.'});
  }

  try {
    const key=Buffer.from(env.WEB_PUSH_SUBSCRIPTION_KEY_BASE64,'base64');
    if(key.length!==32||key.toString('base64')!==env.WEB_PUSH_SUBSCRIPTION_KEY_BASE64) throw new Error();
  } catch {
    context.addIssue({code:'custom',path:['WEB_PUSH_SUBSCRIPTION_KEY_BASE64'],message:'Web Push 구독 암호키는 Base64로 인코딩한 32바이트여야 합니다.'});
  }
  try {
    const keyring=JSON.parse(env.WEB_PUSH_SUBSCRIPTION_KEYRING_JSON) as unknown;
    if(!keyring||Array.isArray(keyring)||typeof keyring!=='object') throw new Error();
    if (Object.hasOwn(keyring, env.WEB_PUSH_SUBSCRIPTION_KEY_VERSION)) throw new Error();
    for(const [version,encoded] of Object.entries(keyring)){
      const key=typeof encoded==='string'?Buffer.from(encoded,'base64'):null;
      if(!/^[A-Za-z0-9._-]{1,32}$/.test(version)||!key||key.length!==32||key.toString('base64')!==encoded) throw new Error();
    }
  } catch {
    context.addIssue({code:'custom',path:['WEB_PUSH_SUBSCRIPTION_KEYRING_JSON'],message:'Web Push 이전 키 모음은 version별 Base64 32바이트 키 JSON 객체여야 합니다.'});
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
