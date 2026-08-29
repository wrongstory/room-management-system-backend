import { describe, expect, it } from 'vitest';
import {
  isLoginPassword,
  isPersonalPassword,
  toSupabaseAuthPassword
} from '../src/modules/auth/password.js';

describe('Supabase Auth password adapter', () => {
  it('namespaces a four-digit temporary password before sending it to Supabase', () => {
    expect(toSupabaseAuthPassword('0123')).toBe('tmp:0123');
  });

  it('keeps a personal password unchanged', () => {
    expect(toSupabaseAuthPassword('012345')).toBe('012345');
  });

  it('accepts numeric or strong mixed personal passwords', () => {
    expect(isPersonalPassword('012345')).toBe(true);
    expect(isPersonalPassword('Valid!Pass123')).toBe(true);
    expect(isLoginPassword('0123')).toBe(true);
    expect(isLoginPassword('Valid!Pass123')).toBe(true);
  });

  it('rejects weak or oversized personal passwords', () => {
    expect(isPersonalPassword('admin')).toBe(false);
    expect(isPersonalPassword('onlylowercase123')).toBe(false);
    expect(isPersonalPassword('A!1short')).toBe(false);
    expect(isPersonalPassword(`A!1${'a'.repeat(70)}`)).toBe(false);
  });
});
