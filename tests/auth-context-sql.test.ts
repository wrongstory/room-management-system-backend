import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../supabase/migrations/20261010143530_common_auth_context_read.sql', import.meta.url), 'utf8');
describe('#442 SQL source contract (not executed database verification)', () => {
  it('keeps separate fresh profile and session commands in explicit order', () => {
    expect(source).toMatch(/language plpgsql\s+volatile\s+security definer\s+set search_path = pg_catalog/);
    expect(source).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(source.indexOf('from public.profiles')).toBeLessThan(source.indexOf("v_profile.status <> 'active'"));
    expect(source.indexOf("v_profile.status <> 'active'")).toBeLessThan(source.indexOf('v_session_id := p_session_id::uuid'));
    expect(source.indexOf('v_session_id := p_session_id::uuid')).toBeLessThan(source.indexOf('from auth.sessions'));
    expect(source).toContain('s.not_after > clock_timestamp()');
    expect(source).toContain('exception when invalid_text_representation');
    expect(source.replace(/--[^\n]*/g, '')).not.toMatch(/exception when others|\bstrict\b|\bjoin\b/i);
  });
  it('has narrowly granted execution and no table writes', () => {
    expect(source).toContain('from public, anon, authenticated;');
    expect(source).toContain('to service_role;');
    expect(source).not.toMatch(/^\s*(insert|update|delete|truncate|alter table|create table)\b/im);
  });
});
