import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const original = read('supabase/migrations/20260912101143_password_change_replay_receipt.sql');
const current = read('supabase/migrations/20261030141647_password_change_prepare_effect_marker.sql');

describe('password preparation SQL contract', () => {
  it('only repairs the two missing return values, preserving claims and permissions', () => {
    const oldFunction = original.slice(original.indexOf('create function public.prepare_password_change('), original.indexOf('create function public.finish_password_change_failure(')).trim();
    const newFunction = current.slice(current.indexOf('create or replace function')).trim();
    expect(newFunction.replace('create or replace function', 'create function').replaceAll(", 'effectMarker', v_command.effect_marker", '')).toBe(oldFunction);
    expect(newFunction.match(/'effectMarker', v_command.effect_marker/g)).toHaveLength(2);
  });
  it('the approved repair helper cannot delete receipts, change passwords, or clear the account gate', () => {
    const repair = read('supabase/tests/password_change_incident_repair_helper.psql');
    expect(repair).toContain('security invoker');
    expect(repair).toContain('for update nowait');
    expect(repair).toContain("v_version.rotated_at > v_command.created_at");
    expect(repair).not.toMatch(/\b(delete from|update auth\.users|update public\.profiles|disable trigger)\b/i);
    expect(repair.match(/\bupdate private\.password_change_commands\b/g)).toHaveLength(1);
  });
});
