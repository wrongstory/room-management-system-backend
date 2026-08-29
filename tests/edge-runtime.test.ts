import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const configUrl = new URL('../supabase/config.toml', import.meta.url);
const apiUrl = new URL('../supabase/functions/api/index.ts', import.meta.url);
const runtimeUrl = new URL('../supabase/functions/_shared/runtime.ts', import.meta.url);
const schedulerUrl = new URL('../supabase/functions/reservation-scheduler/index.ts', import.meta.url);

describe('Supabase Edge runtime PoC contract', () => {
  it('allows existing email accounts to sign in while public signup remains disabled', async () => {
    const config = await readFile(configUrl, 'utf8');

    expect(config).toMatch(/\[auth\]\r?\n/);
    expect(config).toMatch(/\[auth\][\s\S]*?enable_signup = false/);
    expect(config).toMatch(/\[auth\.email\][\s\S]*?enable_signup = true/);
  });

  it('revalidates Auth user, active profile, and active session before service-role RPCs', async () => {
    const [api, runtime] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(runtimeUrl, 'utf8')
    ]);

    expect(runtime).toMatch(/publicClient\.auth\s*\.getUser\(accessToken\)/);
    expect(runtime).toMatch(/\.from\(["']profiles["']\)/);
    expect(runtime).toMatch(/profile\.status !== ["']active["']/);
    expect(runtime).toMatch(/["']is_active_auth_session["']/);
    expect(runtime).toMatch(/role:\s*["']developer["']\s*\|\s*["']admin["']\s*\|\s*["']maid["']/);
    expect(runtime).toMatch(/actor\.role !== ["']admin["']/);
    expect(api).toMatch(/requireBusinessAdmin\(actor\)/);
    expect(api).toMatch(/["']get_room_operational_projection["']/);
  });

  it('keeps the cron invocation secret and scheduler actor checks ahead of the command RPC', async () => {
    const scheduler = await readFile(schedulerUrl, 'utf8');
    const secretCheck = scheduler.indexOf('matchesSecret(providedSecret, expectedSecret)');
    const actorCheck = scheduler.search(
      /requiredEnv\(\s*["']RESERVATION_SCHEDULER_ACTOR_PROFILE_ID["']/
    );
    const command = scheduler.search(/["']process_due_reservation_transitions["']/);

    expect(secretCheck).toBeGreaterThan(0);
    expect(actorCheck).toBeGreaterThan(secretCheck);
    expect(command).toBeGreaterThan(actorCheck);
    expect(scheduler).toContain('crypto.subtle.verify');
    expect(scheduler).toContain('reservation-scheduler-$' + '{bucket}');
    expect(scheduler).toMatch(/p_as_of:\s*new Date\(\)\.toISOString\(\)/);
  });
});
