import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const configUrl = new URL('../supabase/config.toml', import.meta.url);

describe('Supabase Auth provider contract', () => {
  it('allows server-created email accounts to sign in while public signup stays disabled', async () => {
    const config = await readFile(configUrl, 'utf8');
    const authSection = config.match(/\[auth\]\r?\n([\s\S]*?)(?=\r?\n\[)/)?.[1];
    const emailSection = config.match(/\[auth\.email\]\r?\n([\s\S]*?)(?=\r?\n\[)/)?.[1];

    expect(authSection).toMatch(/^enable_signup = false$/m);
    expect(emailSection).toMatch(/^enable_signup = true$/m);
  });
});
