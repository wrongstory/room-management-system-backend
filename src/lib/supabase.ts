import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppEnv } from '../config/env.js';

export interface SupabaseClients {
  admin: SupabaseClient;
  publicClient: SupabaseClient;
  forAccessToken(accessToken: string): SupabaseClient;
}

const authOptions = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false
} as const;

export function createSupabaseClients(env: AppEnv): SupabaseClients {
  const commonOptions = { auth: authOptions };

  return {
    admin: createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, commonOptions),
    publicClient: createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, commonOptions),
    forAccessToken(accessToken: string) {
      return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        ...commonOptions,
        global: {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      });
    }
  };
}

