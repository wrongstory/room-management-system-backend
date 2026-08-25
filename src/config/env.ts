import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://127.0.0.1:4173,http://localhost:4173'),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1)
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

