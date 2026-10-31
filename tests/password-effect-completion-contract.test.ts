import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql=readFileSync('supabase/migrations/20261030183754_password_effect_completion.sql','utf8');
describe('effect completion boundary',()=>{
 it('changes only the completion entry point and never exposes it to more roles',()=>{
  expect(sql.match(/create or replace function/g)).toHaveLength(1);
  expect(sql).toContain('public.complete_password_change(');
  expect(sql).not.toMatch(/grant |create or replace function private\.assert_password_change_actor|update auth\.users/i);
 });
 it('locks current Auth effect before changing gate or audit and uses the original exact claim',()=>{
  expect(sql.indexOf('from auth.users')).toBeLessThan(sql.indexOf('update public.profiles'));
  expect(sql).toContain('v_effect_version is distinct from v_command.effect_marker');
  expect(sql).toContain('v_command.claim_digest is distinct from p_claim_digest');
  expect(sql).toContain('p_session_id is null');
  expect(sql).toContain('v_command.lease_expires_at <= clock_timestamp()');
  expect(sql).toContain("state='prepared'");
 });
});
