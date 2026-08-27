import { describe, expect, it } from 'vitest';
import { toSupabaseAuthPassword } from '../src/modules/auth/password.js';

describe('Supabase Auth password adapter', () => {
  it('namespaces a four-digit temporary password before sending it to Supabase', () => {
    expect(toSupabaseAuthPassword('0123')).toBe('tmp:0123');
  });

  it('keeps a personal password unchanged', () => {
    expect(toSupabaseAuthPassword('012345')).toBe('012345');
  });
});
