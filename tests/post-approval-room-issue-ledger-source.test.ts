import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sql = await readFile(new URL('../supabase/migrations/20261005023103_post_approval_room_issue_ledger.sql', import.meta.url), 'utf8');
function body(name: string) {
  const start = sql.indexOf(`create function ${name}(`);
  if (start < 0) throw new Error(`missing source function ${name}`);
  const from = sql.indexOf('as $$', start) + 5;
  return sql.slice(from, sql.indexOf('$$;', from));
}
const occurrences = (value: string, needle: string) => value.split(needle).length - 1;

describe('#336 ledger source checks (text only, NOT executed PostgreSQL/pgTAP)', () => {
  it('fails closed on absent/drifted authoritative dependency without installing a fallback', () => {
    expect(sql).toContain("to_regprocedure('private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)') is null");
    expect(sql).toContain('POST_APPROVAL_ROOM_ISSUE_SESSION_DEPENDENCY_DRIFT');
    expect(sql).toContain("p.provolatile='v' and p.prosecdef and p.prorettype='public.profiles'::regtype");
    expect(sql).not.toMatch(/create (?:or replace )?function private\.assert_attempt_actor_session(?:_fresh)?\(/i);
  });
  it('adds exactly one direct STABLE snapshot caller and one direct VOLATILE fresh caller', () => {
    const read = body('public.get_post_approval_room_issue_source');
    const fresh = body('private.assert_post_approval_room_issue_actor_fresh');
    expect(occurrences(read, 'private.assert_attempt_actor_session(')).toBe(1);
    expect(occurrences(fresh, 'private.assert_attempt_actor_session_fresh(')).toBe(1);
    const definitions = [...sql.matchAll(/create function ([a-z_.]+)\(/g)].map((match) => body(match[1] ?? '')).join('\n');
    expect(occurrences(definitions, 'private.assert_attempt_actor_session(')).toBe(1);
    expect(occurrences(definitions, 'private.assert_attempt_actor_session_fresh(')).toBe(1);
    expect(sql).toMatch(/get_post_approval_room_issue_source\([^\n]+\)\s+returns jsonb language plpgsql stable security definer set search_path=''/);
    expect(sql).toMatch(/assert_post_approval_room_issue_actor_fresh\([^\n]+\)\s+returns public.profiles language plpgsql volatile security definer set search_path=''/);
  });
  it('uses historical immutable tuple, not current assignment/occupancy or a report deadline', () => {
    const authority = body('private.post_approval_room_issue_source_authority');
    for (const needle of ['s.submitted_by=a.maid_profile_id', 'assignment.id=a.assignment_id',
      'assignment.revision=a.assignment_revision', "a.room_snapshot->>'roomId'=t.room_id::text"]) expect(authority).toContain(needle);
    expect(authority).not.toMatch(/is_current|ended_at|reservations|current_|interval|now\(|clock_timestamp/);
    const source = body('private.assert_post_approval_room_issue_source');
    expect(source).toContain("result.source_status not in ('submitted','approved')");
    expect(source).toContain('private.assert_post_approval_room_issue_source_access(p_actor,p_source)');
    const access = body('private.assert_post_approval_room_issue_source_access');
    expect(access).toContain('private.post_approval_issue_notified_assignment(p_actor.id,result.cleaning_target_id)');
    const notified = body('private.post_approval_issue_notified_assignment');
    expect(notified).toContain('a.cleaning_target_id=p_target');
    expect(notified).toContain('a.maid_profile_id=p_actor');
    expect(notified).toContain('a.notified_at is not null');
    expect(notified).not.toMatch(/is_current|ended_at|interval|current_date/);
    expect(access).toContain("p_actor.status<>'active'");
    expect(access).toContain('p_actor.must_change_password');
    expect(access).not.toMatch(/source_status|inspection_decisions|interval|clock_timestamp/);
  });
  it('separates existing report access/closure from new report creation and preserves media expiry', () => {
    for (const name of ['get_post_approval_room_issue_source', 'get_post_approval_room_issue_draft',
      'list_post_approval_room_issue_reports', 'get_post_approval_room_issue_report',
      'get_post_approval_room_issue_evidence_content', 'close_post_approval_room_issue_report']) {
      const read = body(`public.${name}`);
      expect(read).toContain('private.assert_post_approval_room_issue_source_access(');
      expect(read).not.toContain('private.assert_post_approval_room_issue_source(');
    }
    for (const name of ['save_post_approval_room_issue_draft', 'finalize_post_approval_room_issue_report']) {
      expect(body(`public.${name}`)).toContain('private.assert_post_approval_room_issue_source(');
    }
    const content = body('public.get_post_approval_room_issue_evidence_content');
    expect(content).toContain('obj.purged_at is not null');
    expect(content).toContain('private.post_approval_issue_delete_authority(obj.id) is not null');
    expect(content).toContain('private.post_approval_issue_delete_barriers');
    expect(body('public.close_post_approval_room_issue_report')).toContain("actor.role<>'admin'");
    expect(sql).toContain('private.assert_post_approval_room_issue_source_access(public.profiles,uuid),');
  });
  it('explicitly denies eligible limited actors after the fresh helper', () => {
    const fresh = body('private.assert_post_approval_room_issue_actor_fresh');
    expect(fresh.indexOf("result.status<>'active'")).toBeGreaterThan(fresh.indexOf('private.assert_attempt_actor_session_fresh('));
    expect(fresh).toContain("result.role not in ('admin','maid')");
    expect(fresh).toContain('result.must_change_password');
  });
  it('rechecks post-lock, replay, pre-completion and post-completion and keeps receipt scope atomic', () => {
    const save = body('public.save_post_approval_room_issue_draft');
    expect(occurrences(save, 'private.assert_post_approval_room_issue_actor_fresh(')).toBe(4);
    expect(save.indexOf('for no key update')).toBeLessThan(save.indexOf('private.assert_post_approval_room_issue_actor_fresh('));
    expect(save).toMatch(/if replay is not null then\s+perform private\.assert_post_approval_room_issue_actor_fresh/);
    expect(save).toMatch(/assert_post_approval_room_issue_actor_fresh\([^;]+;\s+perform private\.complete_command[^;]+;\s+perform private\.assert_post_approval_room_issue_actor_fresh/);
    expect(save).toContain('private.replay_command(p_actor_profile_id,cmd,p_idempotency_key_digest,p_request_hash)');
    expect(save).toContain('draft.draft_revision<>p_expected_draft_revision');
    expect(save).toContain('p_expected_draft_revision=9007199254740991');
    expect(sql).toContain('draft_revision between 1 and 9007199254740991');
  });
  it('adds fresh response authority only after receipt storage and on every read/replay', () => {
    const wrapper = body('private.post_approval_issue_authorized_response');
    expect(wrapper).toContain('private.assert_post_approval_room_issue_source_access(p_actor,p_source)');
    expect(wrapper).toContain('private.post_approval_issue_notified_assignment(p_actor.id,source.cleaning_target_id)');
    expect(wrapper).toContain("p_result#>>'{source,sourceSubmissionId}' is distinct from p_source::text");
    expect(wrapper).toContain("p_result:=p_result#-'{source,notifiedAssignmentAccess}'");
    expect(wrapper).not.toMatch(/insert into|update |complete_command/);
    expect(body('private.post_approval_room_issue_source_projection')).not.toContain('notifiedAssignmentAccess');
    for (const name of ['save_post_approval_room_issue_draft', 'finalize_post_approval_room_issue_report']) {
      const command = body(`public.${name}`);
      expect(command).toContain('return private.post_approval_issue_authorized_response(replay,actor,p_session_id,p_source_submission_id)');
      expect(command.indexOf('return private.post_approval_issue_authorized_response(result,')).toBeGreaterThan(command.indexOf('private.complete_command('));
    }
    for (const name of ['get_post_approval_room_issue_source', 'get_post_approval_room_issue_draft',
      'list_post_approval_room_issue_reports', 'get_post_approval_room_issue_report']) {
      expect(body(`public.${name}`)).toContain('return private.post_approval_issue_authorized_response(');
    }
    expect(sql).toContain('revoke all on function private.post_approval_issue_authorized_response(jsonb,public.profiles,uuid,uuid)');
  });
  it('never mutates old evidence, room, inspection or money rows', () => {
    expect(sql).not.toMatch(/(?:insert\s+into|update|delete\s+from|alter\s+table)\s+(?:public\.(?:rooms|room_issues|cleaning_targets|cleaning_attempts|cleaning_assignments|cleaning_submissions|inspection_decisions|earnings|payroll_\w+)|private\.(?:attempt_(?:photo|room_issue)\w*|submission_(?:photo|current)\w*|photo_(?:retention|provider_objects|upload_acceptances|storage_names)\w*))/i);
    expect(sql).not.toMatch(/https?:\/\/|room_pin|pin_cipher/i);
    expect(sql).toContain('insert into private.photo_upload_admission_limits');
    expect(sql).toContain('insert into private.photo_upload_rate_limits');
  });
  it('seals only actual typed current acceptances with atomic receipt/outbox and no old-ID authority', () => {
    const finalize = body('public.finalize_post_approval_room_issue_report');
    for (const needle of ['private.post_approval_issue_evidence_acceptances', 'private.post_approval_issue_evidence_items',
      "st.status='accepted'", 'private.post_approval_issue_delete_barriers', 'p_expected_evidence_revision',
      'private.post_approval_issue_report_seals', 'private.replay_command', 'private.complete_command']) expect(finalize).toContain(needle);
    expect(occurrences(finalize, 'private.assert_post_approval_room_issue_actor_fresh(')).toBe(4);
    expect(sql).toContain('deferrable initially deferred');
    expect(body('private.post_approval_issue_seal_valid')).toContain('r.evidence_count');
    expect(body('private.guard_post_approval_issue_acceptance')).toContain('private.post_approval_issue_check_cas(ad)');
    expect(finalize).not.toMatch(/attempt_photo|photo_provider_objects|room_issues|inspection_decisions/);
    expect(sql).not.toContain('POST_APPROVAL_ROOM_ISSUE_EVIDENCE_PIPELINE_REQUIRED');
  });
  it('shares both admission rate buckets and aggregate inflight/quota with exact fail-closed old patches', () => {
    for (const name of ['public.admit_photo_upload(', 'public.admit_photo_collection_upload(', 'public.begin_photo_upload(',
      'private.photo_quota_context(timestamptz)', 'private.capture_photo_identity_tombstone()', 'private.maybe_retire_photo_folder(uuid,timestamptz)']) expect(sql).toContain(name);
    expect(sql).toContain('POST_APPROVAL_ISSUE_DEPENDENCY_DRIFT');
    expect(sql).toContain('private.post_approval_issue_extra_inflight(p_actor_profile_id,at_time)');
    expect(body('private.post_approval_issue_upload_command')).toContain('private.post_approval_issue_all_inflight(p_actor,at_time)-(case when exists');
    expect(body('private.post_approval_issue_sync_quota')).toContain('p.provider_observed_at<q.request_started_at');
    expect(sql).toContain("nextval('private.photo_storage_name_number'::regclass)");
    expect(sql).not.toMatch(/create sequence/i);
  });
  it('charges cold quota CPU exactly once through an owned durable per-request permit', () => {
    const gate = body('public.admit_post_approval_room_issue_quota_refresh');
    const refresh = body('public.refresh_post_approval_room_issue_quota');
    const command = body('private.post_approval_issue_upload_command');
    const admit = command.slice(command.indexOf("if p_command='admit' then", command.indexOf("if p_command='admit' then") + 1))
      .split("elsif p_command='begin'")[0] ?? '';
    expect(gate).toContain('if permit.id is null then');
    expect(gate).toContain('lim.occurrence_count>=30');
    expect(gate).toContain('private.post_approval_issue_check_quota_boundary(ad)');
    expect(refresh).toContain('private.post_approval_issue_check_quota_boundary(ad)');
    expect(occurrences(gate, 'private.assert_post_approval_room_issue_actor_fresh(')).toBe(2);
    expect(occurrences(refresh, 'private.assert_post_approval_room_issue_actor_fresh(')).toBe(2);
    expect(refresh).toContain('perform public.refresh_photo_storage_quota');
    expect(refresh).toContain('perform private.photo_quota_context(clock_timestamp())');
    expect(admit).toContain('if permit.id is null then');
    expect(admit).toContain('private.post_approval_issue_quota_permit_uses');
    expect(sql).toContain('count(distinct key_digest)');
    expect(sql).toContain('select distinct actor_profile_id,key_digest');
    expect(body('private.post_approval_issue_check_quota_boundary')).toContain('private.post_approval_issue_delete_barriers');
    expect(gate).toContain('private.post_approval_issue_pending_capacity(at_time)');
    expect(body('private.post_approval_issue_pending_capacity')).toContain('private.photo_quota_pending');
  });
  it('excludes only exact live legacy self-admission during single core transition, keeping ceiling8', () => {
    const transition = body('private.post_approval_issue_single_transition_inflight');
    for (const needle of ['ad.actor_profile_id=p_actor', 'ad.idempotency_key_digest=p_key', 'ad.cleaning_attempt_id=p_attempt',
      'ad.cleaning_target_id=', 'ad.assignment_id=p_assignment', 'ad.assignment_revision=p_assignment_revision',
      'ad.target_photo_slot_id=p_slot', 'ad.expected_photo_revision=p_revision', 'ad.expires_at>p_at', 'admission_id=ad.id']) expect(transition).toContain(needle);
    expect(sql).toContain('p_idempotency_key_digest,clock_timestamp())>=8');
    expect(transition).toContain('then 1 else 0 end');
  });
  it('writes durable unknown intent before provider I/O while retaining exact CAS on new writes', () => {
    const command = body('private.post_approval_issue_upload_command');
    const prepare = command.split("elsif p_command='prepare_write' then")[1]?.split("elsif p_command in")[0] ?? '';
    expect(prepare).toContain('private.post_approval_issue_check_cas(ad)');
    expect(prepare).toContain("status='reconciliation_pending'");
    expect(command).toContain("if st.status='reserved' or p_command in ('folder','identity') then perform private.post_approval_issue_check_cas(ad)");
    expect(command).toContain("st.status not in ('reconciliation_pending','provider_succeeded')");
    expect(body('public.settle_post_approval_room_issue_evidence_delete')).toContain('private.post_approval_issue_check_fence(p_operation_id,p_lease_version,p_fence_token_digest)');
  });
  it('separates live business preservation, close+180d, true-orphan30d and proven compensation', () => {
    const proof = body('private.post_approval_issue_delete_authority');
    expect(proof).toContain("closure.closed_at+interval '180 days'");
    expect(proof).toContain("obj.provider_created_at+interval '30 days'");
    expect(proof).toContain("'never_accepted_date_mismatch'");
    expect(proof).toContain('live:=d.draft_revision=ad.expected_draft_revision');
    expect(proof).toContain('private.post_approval_issue_evidence_acceptances');
    expect(sql).toContain('Permanent prepared DELETE barrier');
    expect(body('private.post_approval_issue_settle_delete')).toContain('provider_file_id=null,provider_folder_id=null,purged_at=at_time');
    expect(body('public.claim_post_approval_room_issue_purges')).not.toContain('assert_post_approval_room_issue_actor_fresh');
    expect(body('public.get_post_approval_room_issue_evidence_content')).toContain('assert_post_approval_room_issue_actor_fresh');
  });
  it('uses a separate exact historical notification family and excludes evidence/memo from audit/push', () => {
    expect(sql).toContain("'post_approval_room_issue.reported_admin'");
    const writer = body('private.dispatch_post_approval_issue_notification');
    expect(writer).toContain('private.emit_notification_v1(');
    expect(writer).toContain('r.source_submission_id');
    expect(writer).not.toMatch(/r\.memo|provider_file_id|evidence_id|pin/i);
    const validator = body('private.post_approval_issue_notification_valid');
    expect(validator).toContain("audit.entity_type='post_approval_room_issue_report'");
    expect(validator).not.toMatch(/assignment\.is_current|current_assignment|current_occupancy|public\.room_issues/);
  });
  it('has immutable history/provenance, FK indexes, private RLS and service-only RPC ACLs', () => {
    expect(sql).toContain('foreign key(source_submission_id,cleaning_attempt_id)');
    expect(sql).toContain('foreign key(cleaning_attempt_id,cleaning_target_id)');
    expect(sql).toContain('foreign key(draft_id,source_submission_id,client_report_id,draft_created_by_profile_id,original_performer_profile_id)');
    expect(sql).toContain('post_approval_issue_revisions_immutable before update or delete');
    expect(sql).toContain('post_approval_issue_reports_immutable before update or delete');
    for (const name of ['source', 'attempt', 'target', 'assignment', 'performer', 'room']) expect(sql).toContain(`post_approval_issue_drafts_${name}_idx`);
    expect(sql).toContain('enable row level security'); expect(sql).toContain('force row level security');
    expect(sql).toContain('from public,anon,authenticated,service_role'); expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/create policy|grant .* on table/i);
  });
  it('shares admin draft identity while retaining immutable creator and actual action actors', () => {
    expect(sql).toContain('unique(source_submission_id,client_report_id)');
    const save = body('public.save_post_approval_room_issue_draft');
    expect(save).toContain('where source_submission_id=p_source_submission_id and client_report_id=p_client_report_id for update');
    expect(save).toContain("actor.role<>'admin' and draft.reported_by_profile_id<>actor.id");
    expect(save).toContain('values(draft.id,actor.id,draft.draft_revision,draft.memo,at_time)');
    expect(sql).toContain('post_approval_issue_revision_actor_idx');
    for (const name of ['get_post_approval_room_issue_draft', 'finalize_post_approval_room_issue_report']) {
      expect(body(`public.${name}`)).toContain("actor.role='admin' or reported_by_profile_id=actor.id");
    }
    expect(body('public.finalize_post_approval_room_issue_report')).toContain('d.client_report_id,actor.id,d.reported_by_profile_id,d.original_performer_profile_id');
    expect(body('private.post_approval_issue_notification_valid')).toContain('r.reported_by_profile_id=p_actor');
  });
  it('shares only historical admin status reads without transferring upload execution', () => {
    const command = body('private.post_approval_issue_upload_command');
    expect(command).toContain("p_command not in ('admit','begin') and not (p_command='get' and actor.role='admin')");
    expect(command).toContain('private.post_approval_issue_executor(o.id) is distinct from p_actor');
    expect(command).toMatch(/if p_command='get' then\s+perform private\.assert_post_approval_room_issue_source_access\(actor,d\.source_submission_id\);\s+else\s+perform private\.assert_post_approval_room_issue_source\(actor,d\.source_submission_id\);/);
    expect(command).toContain("actor.role<>'admin' and d.reported_by_profile_id<>p_actor");
    expect(occurrences(command, 'private.assert_post_approval_room_issue_actor_fresh(')).toBe(2);
  });
  it('keeps JS whitespace/UTF-16 memo parity and audit free of memo or media identifiers', () => {
    expect(body('private.post_approval_room_issue_memo_valid')).toContain('ascii(substr(p_memo,i,1))>65535');
    expect(sql).toContain('units<=500'); expect(sql).toContain("\\FEFF','')=''");
    const audit = body('public.save_post_approval_room_issue_draft').split('insert into public.audit_events')[1]?.split('perform private.assert_post_approval_room_issue_actor_fresh')[0];
    expect(audit).toContain("'draftRevision',draft.draft_revision,'evidenceRevision',(result#>>'{draft,evidenceRevision}')::bigint");
    expect(audit).not.toMatch(/p_memo|draft\.memo|p_evidence|photo|pin|locator/i);
  });
  it('has no production route/Edge/global OpenAPI registration', async () => {
    const app = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(app).not.toMatch(/createPostApprovalRoomIssueRoutes|SupabasePostApprovalRoomIssueService/);
  });
  it('authors a real rollback/receipt/source/digest pgTAP candidate without claiming it was run', async () => {
    const tap = await readFile(new URL('../supabase/tests/post_approval_room_issue_ledger.sql', import.meta.url), 'utf8');
    for (const needle of ['select no_plan()', 'session_replication_role=origin', 'expiry at completion rolls back',
      'same actor/command/key cannot select a new source', 'old submitted DTO', "interval '168 hours'", 'select * from finish()', 'rollback;']) expect(tap).toContain(needle);
    expect(tap).toContain('NOT RUN');
  });
});
