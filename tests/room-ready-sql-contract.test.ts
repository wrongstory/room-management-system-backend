import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const source = read('supabase/migrations/20261030123748_room_ready_correction.sql');
const fixture = read('supabase/tests/room_ready_correction.sql');
const require = createRequire(import.meta.url);
const between = (start: string, end: string) => source.split(start)[1]?.split(end)[0] ?? '';

describe('#532 room ready correction SQL source boundaries (Full DB NOT RUN)', () => {
  it.each([15, 17])('parses the migration statements with PostgreSQL %i grammar', async (version) => {
    const parser = require(`@pgsql/parser/v${version}`) as { parse(s: string): Promise<{ stmts: unknown[] }> };
    expect((await parser.parse(source)).stmts.length).toBeGreaterThan(15);
    // PL/pgSQL bodies are strings to this parser; this is not SQL execution proof.
  });

  it('requires live authorization before replay and authenticates the original preview time', () => {
    const apply = between('create function public.apply_room_ready_correction', '\nend $$;');
    expect(apply.indexOf('assert_attempt_actor_session_fresh')).toBeLessThan(apply.indexOf('private.replay_command'));
    expect(apply.indexOf('from public.profiles where id=p_actor_profile_id for share')).toBeLessThan(apply.indexOf('assert_attempt_actor_session_fresh'));
    expect(apply.indexOf('from auth.sessions where id=p_session_id')).toBeLessThan(apply.indexOf('assert_attempt_actor_session_fresh'));
    expect(apply.indexOf('private.replay_command')).toBeLessThan(apply.indexOf('p_expires_at<=at_time'));
    expect(apply).toContain("p_expires_at<>p_evaluated_at+interval '5 minutes'");
    expect(apply).toContain('private.room_ready_snapshot(p_room_id,at_time)');
    expect(apply).toContain('p_reason_code,p_evaluated_at,p_expires_at)<>p_impact_fingerprint');
    const proof = between('create function private.room_ready_fingerprint', '\n$$;');
    for (const key of ["'actor'", "'session'", "'reason'", "'evaluatedEpoch'", "'expiresEpoch'"]) expect(proof).toContain(key);
    expect(apply).toContain('canonical_hash:=p_request_hash');
  });

  it('never fabricates finished work, inspection approval, earnings, or physical departure', () => {
    const apply = between('create function public.apply_room_ready_correction', '\nend $$;');
    expect(apply).toContain("if attempt.status in ('scheduled','in_progress') then");
    expect(apply).toContain("else 'interrupted'::public.attempt_status end");
    expect(apply).not.toMatch(/(?:update|insert into|delete from)\s+(?:public\.)?(?:reservations|cleaning_submissions|inspection_decisions|earnings|payroll_\w+)/i);
    expect(apply).not.toMatch(/set[^;]*(?:field_completed_at|started_at)\s*=/i);
    expect(apply).toContain("update public.checkout_cleaning_obligations set status='cancelled'");
    expect(apply).toContain("update private.stay_segment_checkout_obligations set status='cancelled'");
    expect(apply).toContain('ROOM_READY_EARNING_ACKNOWLEDGEMENT_REQUIRED');
    expect(apply).toContain('ROOM_READY_CANDLE_CONFIRMATION_REQUIRED');
    expect(apply).toContain('private.attempt_capability_revocations');
    expect(apply).toContain('private.offline_work_lease_revocations');
  });

  it('preserves historical photos and resolves action notifications using exact terminal evidence', () => {
    expect(source.replaceAll(/--[^\n]*/g, '')).not.toMatch(/delete\s+from|truncate\s|disable\s+trigger|check_function_bodies/i);
    expect(source).toContain("st.status not in ('accepted','compensated')");
    const apply = between('create function public.apply_room_ready_correction', '\nend $$;');
    expect(apply.indexOf('returning id into audit_id')).toBeLessThan(apply.indexOf('private.resolve_notifications_v1'));
    expect(apply).toContain("c.resolver_kind='submission_terminal'");
    expect(source).toContain('t.cancelled_at=e.effective_at');
    expect(source).toContain('(target_proof->>\'version\')::bigint+1=t.assignment_version');
    expect(source).toContain('not private.room_ready_cancelled_attempt(previous_attempt)');
    expect(source).toContain('private.activation_reason_at_before_stay_segments(public.cleaning_targets,public.cleaning_assignments,timestamptz)');
    expect(source).toContain('not private.room_ready_cancelled_attempt(busy)');
    expect(source).toContain('not private.room_ready_cancelled_attempt(a)');
  });

  it('rejects legacy label-only READY and retains real DB cases for the approved final run', () => {
    expect(source).toContain('ROOM_READY_CORRECTION_REQUIRED');
    expect(source).toContain("from public.assignment_change_requests where cleaning_target_id=any(targets) and status='pending'");
    expect(source).toContain("array_append(blockers,'ASSIGNMENT_CHANGE_PENDING')");
    for (const marker of ['confirmation required', 'earning acknowledgement required', 'stale preview', 'finished physical history preserved',
      'cancelled attempt no longer blocks', 'no new earning', 'same receipt replay', 'legacy READY cannot hide']) expect(fixture).toContain(marker);
    expect(fixture.trimEnd()).toMatch(/rollback;$/);
  });

  it('matches each narrow lifecycle patch once against the authoritative source predicate', () => {
    const origins: Record<string, [string, string?]> = {
      'private.activation_reason_at_before_stay_segments': ['20260915000628_cleaning_template_duration_optional.sql', 'private.activation_reason_at'],
      'private.activation_reason_at': ['20261001001449_cleaning_overdue_preserve_work.sql'],
      'private.assignment_preview_snapshot_at': ['20261001041801_cleaning_overdue_preview_snapshot.sql'],
      'private.attempt_blocks_assignment': ['20260922233136_assignment_unavailability_reassignment.sql'],
      'private.developer_room_deactivation_impact': ['20260920144042_developer_room_catalog_capacity.sql'],
      'public.list_cleaning_inspections_page': ['20260923020000_inspection_queue_pagination.sql'],
      'public.list_cleaning_submissions': ['20260909120308_submission_inspection_reclean.sql'],
      'public.override_room_display_status': ['20260920150000_room_status_admin_correction.sql'],
    };
    const patch = between('do $patch$', 'end $patch$;');
    const predicates = [...patch.matchAll(/\('([^']+)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\)/g)];
    expect(predicates).toHaveLength(9);
    for (const [, signature, escapedNeedle] of predicates) {
      const name = signature!.split('(')[0]!;
      const [file, originalName] = origins[name]!;
      const previous = read(`supabase/migrations/${file}`);
      const body = previous.split(`function ${originalName ?? name}(`)[1]!.split('$$;')[0]!;
      const needle = escapedNeedle!.replaceAll("''", "'");
      expect(body.split(needle).length - 1, signature).toBe(1);
    }
    // Later migrations change clock/metadata predicates, not these exact predicates.
    // The installation's pg_get_functiondef cardinality guard still rejects live drift.
  });
});
