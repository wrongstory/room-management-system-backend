-- #336 typed historical report pipeline; SOURCE CANDIDATE, not installed/runtime verified.
-- Root generated this append with Supabase CLI. Apply only after the exact
-- #329 installer and approved #318/#332/#330 dependency union; no fallback.
do $$ begin
  if to_regprocedure('private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)') is null then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SESSION_DEPENDENCY_REQUIRED';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid='private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)'::regprocedure
      and p.provolatile='v' and p.prosecdef and p.prorettype='public.profiles'::regtype
      and p.proowner='postgres'::regrole
      and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql'))
    or has_function_privilege('anon','private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)','EXECUTE')
    or has_function_privilege('authenticated','private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)','EXECUTE')
    or has_function_privilege('service_role','private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)','EXECUTE') then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SESSION_DEPENDENCY_DRIFT';
  end if;
  if to_regprocedure('private.assert_attempt_actor_session(uuid,uuid,boolean)') is null then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SESSION_DEPENDENCY_REQUIRED';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid='private.assert_attempt_actor_session(uuid,uuid,boolean)'::regprocedure
      and p.provolatile='s' and p.prosecdef and p.prorettype='public.profiles'::regtype
      and p.proowner='postgres'::regrole
      and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql'))
    or has_function_privilege('anon','private.assert_attempt_actor_session(uuid,uuid,boolean)','EXECUTE')
    or has_function_privilege('authenticated','private.assert_attempt_actor_session(uuid,uuid,boolean)','EXECUTE')
    or has_function_privilege('service_role','private.assert_attempt_actor_session(uuid,uuid,boolean)','EXECUTE') then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SESSION_DEPENDENCY_DRIFT';
  end if;
end $$;


-- Match the transport's UTF-16 length and JS whitespace-only rejection.
-- Work is bounded to at most 500 code points; no client-controlled clock.
create function private.post_approval_room_issue_memo_valid(p_memo text) returns boolean
language plpgsql immutable set search_path='' as $$
declare units integer;
begin
  if p_memo is null or char_length(p_memo) not between 1 and 500
    or translate(p_memo,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')='' then return false; end if;
  units:=char_length(p_memo);
  for i in 1..char_length(p_memo) loop
    if ascii(substr(p_memo,i,1))>65535 then units:=units+1; end if;
  end loop;
  return units<=500;
end $$;

create type private.post_approval_room_issue_source_authority as (
  source_submission_id uuid,cleaning_attempt_id uuid,cleaning_target_id uuid,
  assignment_id uuid,assignment_revision bigint,original_performer_profile_id uuid,
  room_id uuid,source_status text
);

-- Historical assignment provenance, never current-room or current-assignment authority.
create function private.post_approval_room_issue_source_authority(p_source uuid)
returns private.post_approval_room_issue_source_authority language plpgsql stable set search_path='' as $$
declare result private.post_approval_room_issue_source_authority;
begin
  select s.id,a.id,t.id,assignment.id,a.assignment_revision,a.maid_profile_id,t.room_id,s.status::text into result
    from public.cleaning_submissions s
    join public.cleaning_attempts a on a.id=s.cleaning_attempt_id and s.submitted_by=a.maid_profile_id
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    join public.cleaning_assignments assignment on assignment.id=a.assignment_id
      and assignment.cleaning_target_id=a.cleaning_target_id and assignment.maid_profile_id=a.maid_profile_id
      and assignment.revision=a.assignment_revision and assignment.notified_at is not null
    where s.id=p_source and a.room_snapshot->>'roomId'=t.room_id::text;
  if result.source_submission_id is null then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  return result;
end $$;

-- Historical access must survive a later inspection rejection or submission replacement.
-- Creation eligibility remains a separate guard; this helper never authorizes new evidence.
create function private.post_approval_issue_notified_assignment(p_actor uuid,p_target uuid)
returns setof public.cleaning_assignments language sql stable set search_path='' as $$
  select a.* from public.cleaning_assignments a
  where a.cleaning_target_id=p_target and a.maid_profile_id=p_actor and a.notified_at is not null
  order by a.revision desc,a.id limit 1
$$;
revoke all on function private.post_approval_issue_notified_assignment(uuid,uuid) from public,anon,authenticated,service_role;

create function private.assert_post_approval_room_issue_source_access(p_actor public.profiles,p_source uuid)
returns private.post_approval_room_issue_source_authority language plpgsql stable set search_path='' as $$
declare result private.post_approval_room_issue_source_authority;
begin
  result:=private.post_approval_room_issue_source_authority(p_source);
  if p_actor.role not in ('admin','maid') or p_actor.status<>'active' or p_actor.must_change_password
    or (p_actor.role='maid' and not exists(select 1 from private.post_approval_issue_notified_assignment(p_actor.id,result.cleaning_target_id))) then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  return result;
end $$;

create function private.assert_post_approval_room_issue_source(p_actor public.profiles,p_source uuid)
returns private.post_approval_room_issue_source_authority language plpgsql stable set search_path='' as $$
declare result private.post_approval_room_issue_source_authority;
begin
  result:=private.assert_post_approval_room_issue_source_access(p_actor,p_source);
  if result.source_status not in ('submitted','approved')
    or (result.source_status='approved' and not exists(select 1 from public.inspection_decisions d
      where d.submission_id=result.source_submission_id and d.decision='approved'))
    or (result.source_status='submitted' and exists(select 1 from public.inspection_decisions d
      where d.submission_id=result.source_submission_id)) then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE'; end if;
  return result;
end $$;

-- Exactly ONE new direct fresh-helper caller. The helper itself is not active-only.
create function private.assert_post_approval_room_issue_actor_fresh(p_actor uuid,p_session uuid)
returns public.profiles language plpgsql volatile security definer set search_path='' as $$
declare result public.profiles;
begin
  select * into result from public.profiles where id=p_actor;
  result:=private.assert_attempt_actor_session_fresh(p_actor,p_session,result.role='admin');
  if result.role not in ('admin','maid') or result.status<>'active' or result.must_change_password then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  return result;
end $$;

create table private.post_approval_room_issue_drafts (
  id uuid primary key default gen_random_uuid(),
  reported_by_profile_id uuid not null references public.profiles(id) on delete restrict,
  client_report_id uuid not null,
  source_submission_id uuid not null,
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  assignment_revision bigint not null check(assignment_revision>0),
  original_performer_profile_id uuid not null references public.profiles(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  draft_revision bigint not null check(draft_revision between 1 and 9007199254740991),
  memo text not null check(private.post_approval_room_issue_memo_valid(memo)),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  updated_at timestamptz not null default clock_timestamp() check(isfinite(updated_at) and updated_at>=created_at),
  unique(reported_by_profile_id,client_report_id),
  unique(source_submission_id,client_report_id),
  unique(id,source_submission_id,client_report_id,reported_by_profile_id,original_performer_profile_id),
  foreign key(source_submission_id,cleaning_attempt_id) references public.cleaning_submissions(id,cleaning_attempt_id) on delete restrict,
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict
);
create index post_approval_issue_drafts_source_idx on private.post_approval_room_issue_drafts(source_submission_id,created_at,id);
create index post_approval_issue_drafts_attempt_idx on private.post_approval_room_issue_drafts(cleaning_attempt_id,cleaning_target_id);
create index post_approval_issue_drafts_target_idx on private.post_approval_room_issue_drafts(cleaning_target_id);
create index post_approval_issue_drafts_assignment_idx on private.post_approval_room_issue_drafts(assignment_id);
create index post_approval_issue_drafts_performer_idx on private.post_approval_room_issue_drafts(original_performer_profile_id);
create index post_approval_issue_drafts_room_idx on private.post_approval_room_issue_drafts(room_id);

create table private.post_approval_room_issue_draft_revisions (
  draft_id uuid not null references private.post_approval_room_issue_drafts(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  revision bigint not null check(revision between 1 and 9007199254740991),
  memo text not null check(private.post_approval_room_issue_memo_valid(memo)),
  recorded_at timestamptz not null default clock_timestamp() check(isfinite(recorded_at)),
  primary key(draft_id,revision)
);
create index post_approval_issue_revision_actor_idx on private.post_approval_room_issue_draft_revisions(actor_profile_id);

-- Immutable historical reports. The deferred seal guard below proves 1..10 actual
-- typed acceptances; the original cleaning submission is never a mutation target.
create table private.post_approval_room_issue_reports (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null unique,
  source_submission_id uuid not null,
  client_report_id uuid not null,
  reported_by_profile_id uuid not null references public.profiles(id) on delete restrict,
  draft_created_by_profile_id uuid not null,
  original_performer_profile_id uuid not null,
  memo text not null check(private.post_approval_room_issue_memo_valid(memo)),
  draft_revision bigint not null check(draft_revision between 1 and 9007199254740991),
  evidence_revision bigint not null check(evidence_revision between 1 and 9007199254740991),
  evidence_count integer not null check(evidence_count between 1 and 10),
  reported_at timestamptz not null default clock_timestamp() check(isfinite(reported_at)),
  foreign key(draft_id,source_submission_id,client_report_id,draft_created_by_profile_id,original_performer_profile_id)
    references private.post_approval_room_issue_drafts(id,source_submission_id,client_report_id,reported_by_profile_id,original_performer_profile_id) on delete restrict
);
create index post_approval_issue_reports_source_idx on private.post_approval_room_issue_reports(source_submission_id,reported_at,id);
create index post_approval_issue_reports_actor_idx on private.post_approval_room_issue_reports(reported_by_profile_id,reported_at,id);
create index post_approval_issue_reports_performer_idx on private.post_approval_room_issue_reports(original_performer_profile_id);

create function private.post_approval_room_issue_append_only() returns trigger
language plpgsql set search_path='' as $$ begin
  raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE';
end $$;
create trigger post_approval_issue_revisions_immutable before update or delete on private.post_approval_room_issue_draft_revisions
  for each row execute function private.post_approval_room_issue_append_only();
create trigger post_approval_issue_reports_immutable before update or delete on private.post_approval_room_issue_reports
  for each row execute function private.post_approval_room_issue_append_only();

-- Independent collection axis: uploads do not rewrite memo/draft revision.
create table private.post_approval_issue_collections (
  draft_id uuid primary key references private.post_approval_room_issue_drafts(id) on delete restrict,
  revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  item_count integer not null default 0 check(item_count between 0 and 10)
);

create function private.guard_post_approval_room_issue_draft() returns trigger
language plpgsql set search_path='' as $$
declare source private.post_approval_room_issue_source_authority;
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  if tg_op='UPDATE' and (row(new.id,new.reported_by_profile_id,new.client_report_id,new.source_submission_id,
      new.cleaning_attempt_id,new.cleaning_target_id,new.assignment_id,new.assignment_revision,
      new.original_performer_profile_id,new.room_id,new.created_at)
    is distinct from row(old.id,old.reported_by_profile_id,old.client_report_id,old.source_submission_id,
      old.cleaning_attempt_id,old.cleaning_target_id,old.assignment_id,old.assignment_revision,
      old.original_performer_profile_id,old.room_id,old.created_at)
    or new.draft_revision<>old.draft_revision+1 or new.updated_at<old.updated_at) then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  source:=private.post_approval_room_issue_source_authority(new.source_submission_id);
  if row(new.cleaning_attempt_id,new.cleaning_target_id,new.assignment_id,new.assignment_revision,new.original_performer_profile_id,new.room_id)
    is distinct from row(source.cleaning_attempt_id,source.cleaning_target_id,source.assignment_id,source.assignment_revision,source.original_performer_profile_id,source.room_id) then
    raise exception using errcode='23514',message='POST_APPROVAL_ROOM_ISSUE_PROVENANCE_INVALID'; end if;
  return new;
end $$;
create trigger post_approval_issue_draft_provenance before insert or update or delete on private.post_approval_room_issue_drafts
  for each row execute function private.guard_post_approval_room_issue_draft();

create function private.post_approval_room_issue_source_projection(p_source private.post_approval_room_issue_source_authority)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('sourceSubmissionId',p_source.source_submission_id,
    'originalPerformerProfileId',p_source.original_performer_profile_id,'sourceStatus',p_source.source_status)
$$;
-- Response-only authority. Call only after the RPC's live-session guard, and
-- after storing its receipt: session-bound proof must never be persisted.
create function private.post_approval_issue_authorized_response(
  p_result jsonb,p_actor public.profiles,p_session uuid,p_source uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare source private.post_approval_room_issue_source_authority; assignment public.cleaning_assignments;
begin
  source:=private.assert_post_approval_room_issue_source_access(p_actor,p_source);
  if p_session is null or p_result#>>'{source,sourceSubmissionId}' is distinct from p_source::text then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  p_result:=p_result#-'{source,notifiedAssignmentAccess}';
  if p_actor.role='admin' or p_actor.id=source.original_performer_profile_id then return p_result; end if;
  select * into assignment from private.post_approval_issue_notified_assignment(p_actor.id,source.cleaning_target_id);
  if assignment.id is null then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  return jsonb_set(p_result,'{source,notifiedAssignmentAccess}',jsonb_build_object(
    'actorProfileId',p_actor.id,'sessionId',p_session,'sourceSubmissionId',source.source_submission_id,
    'assignmentId',assignment.id,'assignmentRevision',assignment.revision,'notifiedAt',assignment.notified_at));
end $$;
revoke all on function private.post_approval_issue_authorized_response(jsonb,public.profiles,uuid,uuid)
  from public,anon,authenticated,service_role;

create function private.post_approval_room_issue_draft_projection(p_draft private.post_approval_room_issue_drafts)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('clientReportId',p_draft.client_report_id,'sourceSubmissionId',p_draft.source_submission_id,
    'draftRevision',p_draft.draft_revision,'evidenceRevision',coalesce((select revision from private.post_approval_issue_collections where draft_id=p_draft.id),0),
    'evidenceCount',coalesce((select item_count from private.post_approval_issue_collections where draft_id=p_draft.id),0),'memo',p_draft.memo)
$$;

-- Exactly ONE additional direct snapshot-helper caller; preserves STABLE read semantics.
create function public.get_post_approval_room_issue_source(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,actor.role='admin');
  source:=private.assert_post_approval_room_issue_source_access(actor,p_source_submission_id);
  return private.post_approval_issue_authorized_response(
    jsonb_build_object('source',private.post_approval_room_issue_source_projection(source)),actor,p_session_id,p_source_submission_id);
end $$;

create function public.save_post_approval_room_issue_draft(
  p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_client_report_id uuid,
  p_expected_draft_revision bigint,p_memo text,p_idempotency_key_digest text,p_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority;
  draft private.post_approval_room_issue_drafts; replay jsonb; result jsonb;
  cmd constant text:='post_approval_room_issue.draft'; at_time timestamptz;
begin
  if p_source_submission_id is null or p_client_report_id is null or p_expected_draft_revision is null
    or p_expected_draft_revision not between 0 and 9007199254740991
    or not private.post_approval_room_issue_memo_valid(p_memo)
    or p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key_digest,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source(actor,p_source_submission_id);
  if replay is not null then
    perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
    return private.post_approval_issue_authorized_response(replay,actor,p_session_id,p_source_submission_id);
  end if;
  if p_expected_draft_revision=9007199254740991 then
    raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'; end if;
  select * into draft from private.post_approval_room_issue_drafts
    where source_submission_id=p_source_submission_id and client_report_id=p_client_report_id for update;
  -- Shared identity does not grant access: only business admins may take over
  -- another creator's draft. A maid's source guard and creator fence both apply.
  if draft.id is not null and actor.role<>'admin' and draft.reported_by_profile_id<>actor.id then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  if draft.id is null and exists(select 1 from private.post_approval_room_issue_drafts
    where reported_by_profile_id=actor.id and client_report_id=p_client_report_id) then
    raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'; end if;
  if draft.id is not null and (draft.source_submission_id<>p_source_submission_id
    or draft.draft_revision<>p_expected_draft_revision) or (draft.id is null and p_expected_draft_revision<>0) then
    raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'; end if;
  if draft.id is not null and exists(select 1 from private.post_approval_room_issue_reports where draft_id=draft.id) then
    raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED'; end if;
  at_time:=clock_timestamp();
  if draft.id is null then
    insert into private.post_approval_room_issue_drafts(reported_by_profile_id,client_report_id,source_submission_id,
      cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,original_performer_profile_id,room_id,
      draft_revision,memo,created_at,updated_at)
    values(actor.id,p_client_report_id,source.source_submission_id,source.cleaning_attempt_id,source.cleaning_target_id,
      source.assignment_id,source.assignment_revision,source.original_performer_profile_id,source.room_id,1,p_memo,at_time,at_time)
    returning * into draft;
  else
    update private.post_approval_room_issue_drafts set memo=p_memo,draft_revision=draft_revision+1,updated_at=at_time
      where id=draft.id and draft_revision=p_expected_draft_revision returning * into draft;
    if draft.id is null then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'; end if;
  end if;
  insert into private.post_approval_room_issue_draft_revisions(draft_id,actor_profile_id,revision,memo,recorded_at)
    values(draft.id,actor.id,draft.draft_revision,draft.memo,at_time);
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),
    'draft',private.post_approval_room_issue_draft_projection(draft));
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('post_approval_room_issue.draft_saved','cleaning_submission',source.source_submission_id,actor.id,actor.display_name,at_time,
      jsonb_build_object('draftRevision',draft.draft_revision,'evidenceRevision',(result#>>'{draft,evidenceRevision}')::bigint,'evidenceCount',(result#>>'{draft,evidenceCount}')::integer),
      private.audit_command_key(actor.id,cmd,p_idempotency_key_digest));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  perform private.complete_command(actor.id,cmd,p_idempotency_key_digest,p_request_hash,draft.id,result);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;

create function public.finalize_post_approval_room_issue_report(
  p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_client_report_id uuid,
  p_expected_draft_revision bigint,p_expected_evidence_revision bigint,p_memo text,p_evidence jsonb,
  p_idempotency_key_digest text,p_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority;
  d private.post_approval_room_issue_drafts; report private.post_approval_room_issue_reports;
  replay jsonb; result jsonb; evidence jsonb; selected integer; at_time timestamptz;
  cmd constant text:='post_approval_room_issue.finalize';
begin
  if p_source_submission_id is null or p_client_report_id is null or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991 or p_expected_evidence_revision is null
    or p_expected_evidence_revision not between 1 and 9007199254740991 or not private.post_approval_room_issue_memo_valid(p_memo)
    or p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$' or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$'
    or jsonb_typeof(p_evidence) is distinct from 'array' then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  if jsonb_array_length(p_evidence) not between 1 and 10 then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key_digest,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source(actor,p_source_submission_id);
  if replay is not null then
    perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
    return private.post_approval_issue_authorized_response(replay,actor,p_session_id,p_source_submission_id);
  end if;
  select * into d from private.post_approval_room_issue_drafts where source_submission_id=p_source_submission_id
    and client_report_id=p_client_report_id and (actor.role='admin' or reported_by_profile_id=actor.id) for update;
  if d.id is null or d.source_submission_id<>p_source_submission_id or d.draft_revision<>p_expected_draft_revision or d.memo<>p_memo
    or not exists(select 1 from private.post_approval_issue_collections c where c.draft_id=d.id and c.revision=p_expected_evidence_revision and c.item_count=jsonb_array_length(p_evidence))
    or exists(select 1 from private.post_approval_room_issue_reports where draft_id=d.id) then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  selected:=0;
  for evidence in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(evidence) is distinct from 'object' or (select count(*) from jsonb_object_keys(evidence))<>3
      or not (evidence ?& array['evidenceId','revision','displayOrder']) or jsonb_typeof(evidence->'evidenceId') is distinct from 'string'
      or jsonb_typeof(evidence->'revision') is distinct from 'number' or jsonb_typeof(evidence->'displayOrder') is distinct from 'number'
      or evidence->>'revision'!~'^[1-9][0-9]{0,15}$' or (evidence->>'revision')::bigint>9007199254740991
      or evidence->>'displayOrder'!~'^[0-9]$' or (evidence->>'displayOrder')::integer<>selected
      or not exists(select 1 from private.post_approval_issue_evidence_items i
        join private.post_approval_issue_evidence_acceptances a on a.operation_id=i.operation_id
        join private.post_approval_issue_provider_objects obj on obj.id=a.object_id
        join private.post_approval_issue_upload_states st on st.operation_id=a.operation_id
        where i.id=(evidence->>'evidenceId')::uuid and i.draft_id=d.id and i.revision=(evidence->>'revision')::bigint
          and i.display_order=selected and st.status='accepted' and obj.purged_at is null
          and not exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id)) then
      raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
    selected:=selected+1;
  end loop;
  at_time:=clock_timestamp();
  insert into private.post_approval_room_issue_reports(draft_id,source_submission_id,client_report_id,reported_by_profile_id,
    draft_created_by_profile_id,original_performer_profile_id,memo,draft_revision,evidence_revision,evidence_count,reported_at)
    values(d.id,d.source_submission_id,d.client_report_id,actor.id,d.reported_by_profile_id,d.original_performer_profile_id,d.memo,d.draft_revision,p_expected_evidence_revision,selected,at_time) returning * into report;
  insert into private.post_approval_issue_report_seals(report_id,draft_id,evidence_id,item_revision,operation_id,display_order)
    select report.id,d.id,i.id,i.revision,i.operation_id,i.display_order from private.post_approval_issue_evidence_items i where i.draft_id=d.id order by i.display_order;
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),'report',private.post_approval_issue_report_projection(report.id));
  -- No memo, media IDs/locators, PIN, inspection/payment or occupancy data in audit/push.
  perform set_config('app.notification_writer_mode','typed_v1',true);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('post_approval_room_issue.reported','post_approval_room_issue_report',report.id,actor.id,actor.display_name,at_time,
      jsonb_build_object('sourceSubmissionId',source.source_submission_id,'evidenceCount',selected),private.audit_command_key(actor.id,cmd,p_idempotency_key_digest));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  perform private.complete_command(actor.id,cmd,p_idempotency_key_digest,p_request_hash,report.id,result);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;

do $$ declare relation text; begin
  foreach relation in array array['post_approval_room_issue_drafts','post_approval_room_issue_draft_revisions','post_approval_room_issue_reports'] loop
    execute format('alter table private.%I enable row level security',relation);
    execute format('alter table private.%I force row level security',relation);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',relation);
  end loop;
end $$;
revoke all on function private.post_approval_room_issue_memo_valid(text),
  private.post_approval_room_issue_source_authority(uuid),
  private.assert_post_approval_room_issue_source_access(public.profiles,uuid),
  private.assert_post_approval_room_issue_source(public.profiles,uuid),
  private.assert_post_approval_room_issue_actor_fresh(uuid,uuid),
  private.post_approval_room_issue_append_only(),private.guard_post_approval_room_issue_draft(),
  private.post_approval_room_issue_source_projection(private.post_approval_room_issue_source_authority),
  private.post_approval_room_issue_draft_projection(private.post_approval_room_issue_drafts)
  from public,anon,authenticated,service_role;
revoke all on function public.get_post_approval_room_issue_source(uuid,uuid,uuid),
  public.save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text),
  public.finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_post_approval_room_issue_source(uuid,uuid,uuid),
  public.save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text),
  public.finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text)
  to service_role;

-- Typed tables deliberately do NOT reference old attempt-photo acceptance,
-- current-room issue, provider-object or retention-link ledgers.
create table private.post_approval_issue_upload_admissions (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  draft_id uuid not null references private.post_approval_room_issue_drafts(id) on delete restrict,
  evidence_id uuid not null,
  expected_draft_revision bigint not null check(expected_draft_revision between 1 and 9007199254740991),
  expected_evidence_revision bigint not null check(expected_evidence_revision between 0 and 9007199254740990),
  expected_item_revision bigint not null check(expected_item_revision between 0 and 9007199254740990),
  idempotency_key_digest text not null check(idempotency_key_digest~'^[0-9a-f]{64}$'),
  reserved_bytes integer not null default 307200 check(reserved_bytes=307200),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at=created_at+interval '5 minutes'),
  quota_revision bigint not null check(quota_revision>0),
  unique(actor_profile_id,idempotency_key_digest)
);
create index post_approval_issue_admission_draft_idx on private.post_approval_issue_upload_admissions(draft_id,evidence_id);
create index post_approval_issue_admission_expiry_idx on private.post_approval_issue_upload_admissions(expires_at);
-- Internal per-HTTP-request CPU receipt, not a new user authority or command key.
-- A cold quota read reserves conservative capacity before provider I/O; one
-- logical upload key is counted once across concurrent refresh permits.
create table private.post_approval_issue_quota_permits (
  id uuid primary key default gen_random_uuid(), actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  draft_id uuid not null references private.post_approval_room_issue_drafts(id) on delete restrict,
  evidence_id uuid not null, expected_draft_revision bigint not null check(expected_draft_revision between 1 and 9007199254740991),
  expected_evidence_revision bigint not null check(expected_evidence_revision between 0 and 9007199254740990),
  expected_item_revision bigint not null check(expected_item_revision between 0 and 9007199254740990),
  key_digest text not null check(key_digest~'^[0-9a-f]{64}$'), gate_request_digest text not null check(gate_request_digest~'^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at=created_at+interval '5 minutes'),
  unique(actor_profile_id,gate_request_digest)
);
create index post_approval_issue_quota_permit_draft_idx on private.post_approval_issue_quota_permits(draft_id);
create index post_approval_issue_quota_permit_key_idx on private.post_approval_issue_quota_permits(actor_profile_id,key_digest,expires_at);
create table private.post_approval_issue_quota_refreshes (
  permit_id uuid primary key references private.post_approval_issue_quota_permits(id) on delete restrict,
  refresh_started_at timestamptz not null check(isfinite(refresh_started_at)), usage_bytes bigint not null check(usage_bytes between 0 and 9007199254740991)
);
create table private.post_approval_issue_quota_permit_uses (
  permit_id uuid primary key references private.post_approval_issue_quota_permits(id) on delete restrict,
  admission_id uuid not null references private.post_approval_issue_upload_admissions(id) on delete restrict
);
create index post_approval_issue_quota_use_admission_idx on private.post_approval_issue_quota_permit_uses(admission_id);
create table private.post_approval_issue_upload_operations (
  id uuid primary key default gen_random_uuid(),
  admission_id uuid not null unique references private.post_approval_issue_upload_admissions(id) on delete restrict,
  request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  sha256 text not null check(sha256~'^[0-9a-f]{64}$'),
  mime_type text not null check(mime_type in ('image/jpeg','image/webp')),
  size_bytes integer not null check(size_bytes between 1 and 307200),
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at))
);
create table private.post_approval_issue_upload_handovers (
  operation_id uuid not null references private.post_approval_issue_upload_operations(id) on delete restrict,
  lease_version integer not null check(lease_version between 1 and 8),
  previous_actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  expected_lease_version integer not null check(expected_lease_version between 0 and 7),
  key_digest text not null check(key_digest~'^[0-9a-f]{64}$'),
  request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  fence_token_digest text not null check(fence_token_digest~'^[0-9a-f]{64}$'),
  occurred_at timestamptz not null check(isfinite(occurred_at)),
  primary key(operation_id,lease_version), unique(actor_profile_id,key_digest),
  check(lease_version=expected_lease_version+1), check(previous_actor_profile_id<>actor_profile_id)
);
create index post_approval_issue_handover_previous_idx on private.post_approval_issue_upload_handovers(previous_actor_profile_id);
create function private.post_approval_issue_executor(p_operation uuid) returns uuid
language sql stable set search_path='' as $$
  select coalesce((select actor_profile_id from private.post_approval_issue_upload_handovers
    where operation_id=o.id order by lease_version desc limit 1),ad.actor_profile_id)
  from private.post_approval_issue_upload_operations o
  join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id where o.id=p_operation
$$;
create table private.post_approval_issue_upload_states (
  operation_id uuid primary key references private.post_approval_issue_upload_operations(id) on delete restrict,
  status text not null default 'reserved' check(status in ('reserved','provider_succeeded','accepted','reconciliation_pending','compensation_pending','compensated')),
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  fence_token_digest text check(fence_token_digest~'^[0-9a-f]{64}$'),
  lease_expires_at timestamptz check(isfinite(lease_expires_at)),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp() check(isfinite(updated_at)),
  check((lease_version=0 and fence_token_digest is null and lease_expires_at is null) or
    (lease_version>0 and fence_token_digest is not null and lease_expires_at is not null))
);
create index post_approval_issue_upload_live_idx on private.post_approval_issue_upload_states(status,lease_expires_at,operation_id);
create table private.post_approval_issue_upload_events (
  operation_id uuid not null references private.post_approval_issue_upload_operations(id) on delete restrict,
  revision bigint not null, state text not null, lease_version integer not null,
  occurred_at timestamptz not null check(isfinite(occurred_at)),
  primary key(operation_id,revision)
);
create table private.post_approval_issue_provider_objects (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references private.post_approval_issue_upload_operations(id) on delete restrict,
  upload_date date not null check(extract(year from upload_date) between 1 and 9999),
  room_number text not null check(room_number~'^[0-9]{3}$'),
  naming_number bigint not null unique check(naming_number>0),
  file_name text not null,
  provider_file_id text unique check(provider_file_id~'^[A-Za-z0-9_-]{10,200}$'),
  provider_folder_id text check(provider_folder_id~'^[A-Za-z0-9_-]{10,200}$'),
  provider_created_at timestamptz check(isfinite(provider_created_at)),
  provider_observed_at timestamptz check(isfinite(provider_observed_at)),
  date_mismatch boolean not null default false,
  purged_at timestamptz check(isfinite(purged_at)),
  unique(id,operation_id),
  check((provider_created_at is null)=(provider_observed_at is null)),
  check(provider_created_at is null or provider_created_at<=provider_observed_at),
  check(purged_at is null or (provider_file_id is null and provider_folder_id is null))
);
create index post_approval_issue_object_folder_idx on private.post_approval_issue_provider_objects(provider_folder_id);
create index post_approval_issue_object_created_idx on private.post_approval_issue_provider_objects(provider_created_at,id) where purged_at is null;
create table private.post_approval_issue_folder_bindings (
  operation_id uuid not null references private.post_approval_issue_upload_operations(id) on delete restrict,
  scope text not null check(scope in ('date','room')),
  folder_registry_id uuid not null references private.photo_drive_folder_identities(id) on delete restrict,
  primary key(operation_id,scope)
);
create index post_approval_issue_folder_registry_idx on private.post_approval_issue_folder_bindings(folder_registry_id,operation_id);
create table private.post_approval_issue_identity_tombstones (
  locator_digest text primary key check(locator_digest~'^[0-9a-f]{64}$'),
  object_id uuid not null references private.post_approval_issue_provider_objects(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at))
);
create index post_approval_issue_tombstone_object_idx on private.post_approval_issue_identity_tombstones(object_id);
create table private.post_approval_issue_evidence_acceptances (
  operation_id uuid primary key references private.post_approval_issue_upload_operations(id) on delete restrict,
  object_id uuid not null unique,
  draft_id uuid not null references private.post_approval_room_issue_drafts(id) on delete restrict,
  evidence_id uuid not null,
  item_revision bigint not null check(item_revision between 1 and 9007199254740991),
  collection_revision bigint not null check(collection_revision between 1 and 9007199254740991),
  display_order integer not null check(display_order between 0 and 9),
  accepted_at timestamptz not null default clock_timestamp() check(isfinite(accepted_at)),
  foreign key(object_id,operation_id) references private.post_approval_issue_provider_objects(id,operation_id) on delete restrict,
  unique(draft_id,evidence_id,item_revision),
  unique(operation_id,draft_id,evidence_id,item_revision,display_order)
);
create index post_approval_issue_acceptance_evidence_idx on private.post_approval_issue_evidence_acceptances(evidence_id,item_revision);
create table private.post_approval_issue_evidence_items (
  id uuid primary key, draft_id uuid not null references private.post_approval_room_issue_drafts(id) on delete restrict,
  revision bigint not null check(revision between 1 and 9007199254740991),
  operation_id uuid not null unique references private.post_approval_issue_evidence_acceptances(operation_id) on delete restrict,
  display_order integer not null check(display_order between 0 and 9),
  unique(draft_id,display_order), unique(id,draft_id,revision,operation_id,display_order)
);
create index post_approval_issue_items_draft_idx on private.post_approval_issue_evidence_items(draft_id,id);
create table private.post_approval_issue_report_seals (
  report_id uuid not null references private.post_approval_room_issue_reports(id) on delete restrict,
  draft_id uuid not null, evidence_id uuid not null, item_revision bigint not null,
  operation_id uuid not null, display_order integer not null check(display_order between 0 and 9),
  primary key(report_id,evidence_id), unique(report_id,display_order),
  foreign key(operation_id,draft_id,evidence_id,item_revision,display_order)
    references private.post_approval_issue_evidence_acceptances(operation_id,draft_id,evidence_id,item_revision,display_order) on delete restrict
);
create index post_approval_issue_seal_acceptance_idx on private.post_approval_issue_report_seals(operation_id,draft_id,evidence_id,item_revision,display_order);
create index post_approval_issue_seal_draft_idx on private.post_approval_issue_report_seals(draft_id);
create table private.post_approval_issue_report_closures (
  report_id uuid primary key references private.post_approval_room_issue_reports(id) on delete restrict,
  closed_by_profile_id uuid not null references public.profiles(id) on delete restrict,
  closed_at timestamptz not null default clock_timestamp() check(isfinite(closed_at))
);
create index post_approval_issue_closure_actor_idx on private.post_approval_issue_report_closures(closed_by_profile_id);
-- This active accounting projection is not the immutable upload/business ledger.
create table private.post_approval_issue_quota_pending (
  admission_id uuid primary key references private.post_approval_issue_upload_admissions(id) on delete restrict,
  operation_id uuid unique references private.post_approval_issue_upload_operations(id) on delete restrict,
  reserved_bytes integer not null check(reserved_bytes=307200), expires_at timestamptz not null,
  provider_created_at timestamptz, provider_observed_at timestamptz
);
create index post_approval_issue_quota_expiry_idx on private.post_approval_issue_quota_pending(expires_at);
-- Permanent prepared DELETE barrier. A provider timeout never removes this fence.
create table private.post_approval_issue_delete_barriers (
  object_id uuid primary key references private.post_approval_issue_provider_objects(id) on delete restrict,
  delete_token uuid not null unique default gen_random_uuid(),
  reason text not null check(reason in ('never_accepted_date_mismatch','true_orphan_30d','closed_report_180d')),
  anchor_at timestamptz not null check(isfinite(anchor_at)),
  prepared_at timestamptz not null default clock_timestamp() check(isfinite(prepared_at)),
  settled_at timestamptz check(isfinite(settled_at)),
  outcome text check(outcome in ('deleted','not_found')),
  check((settled_at is null)=(outcome is null))
);
create table private.post_approval_issue_purge_jobs (
  object_id uuid primary key references private.post_approval_issue_provider_objects(id) on delete restrict,
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  claim_digest text check(claim_digest~'^[0-9a-f]{64}$'),
  lease_expires_at timestamptz check(isfinite(lease_expires_at)),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  status text not null default 'pending' check(status in ('pending','claimed','purged','blocked')),
  next_attempt_at timestamptz not null default clock_timestamp() check(isfinite(next_attempt_at)),
  check((lease_version=0 and claim_digest is null and lease_expires_at is null) or
    (lease_version>0 and claim_digest is not null and lease_expires_at is not null))
);
create index post_approval_issue_purge_due_idx on private.post_approval_issue_purge_jobs(status,lease_expires_at,object_id);
-- Bounded cyclic scanner prevents 100 older live drafts starving newer due rows.
create table private.post_approval_issue_purge_scan (
  singleton boolean primary key default true check(singleton),
  last_created_at timestamptz not null check(isfinite(last_created_at)),
  last_object_id uuid not null
);

create function private.guard_post_approval_issue_mutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  if tg_table_name='post_approval_issue_provider_objects' and tg_op='UPDATE' then
    if (to_jsonb(new)-array['provider_file_id','provider_folder_id','provider_created_at','provider_observed_at','date_mismatch','purged_at'])
      is distinct from (to_jsonb(old)-array['provider_file_id','provider_folder_id','provider_created_at','provider_observed_at','date_mismatch','purged_at'])
      or (old.provider_created_at is not null and row(new.provider_created_at,new.provider_observed_at,new.date_mismatch)
        is distinct from row(old.provider_created_at,old.provider_observed_at,old.date_mismatch))
      or (old.provider_file_id is not null and new.provider_file_id is not null and row(new.provider_file_id,new.provider_folder_id)
        is distinct from row(old.provider_file_id,old.provider_folder_id))
      or (new.purged_at is not null and not exists(select 1 from private.post_approval_issue_delete_barriers b
        where b.object_id=old.id and b.settled_at=new.purged_at)) or old.purged_at is not null then
      raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  elsif tg_table_name='post_approval_issue_provider_objects' and tg_op='INSERT' then
    if not exists(select 1 from private.post_approval_issue_upload_operations o
      join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
      join private.post_approval_room_issue_drafts d on d.id=ad.draft_id
      join public.cleaning_assignments assignment on assignment.id=d.assignment_id
      where o.id=new.operation_id and new.upload_date=(o.created_at at time zone 'Asia/Seoul')::date
        and new.room_number=assignment.notified_room_number_snapshot
        and new.file_name=private.photo_storage_file_name(new.upload_date,'issue-proof',new.room_number,new.naming_number,o.mime_type))
      or exists(select 1 from private.photo_storage_names where naming_number=new.naming_number)
      or new.provider_file_id is not null or new.provider_created_at is not null or new.purged_at is not null then
      raise exception using errcode='23514',message='POST_APPROVAL_ROOM_ISSUE_PROVENANCE_INVALID'; end if;
  elsif tg_table_name='post_approval_issue_upload_states' and tg_op='UPDATE' then
    if new.operation_id<>old.operation_id or new.revision<>old.revision+1 or new.lease_version<old.lease_version
      or new.lease_version>old.lease_version+1 or old.status in ('accepted','compensated')
      or (new.status='accepted' and not exists(select 1 from private.post_approval_issue_evidence_acceptances where operation_id=new.operation_id))
      or (new.status='compensated' and not exists(select 1 from private.post_approval_issue_provider_objects where operation_id=new.operation_id and purged_at is not null)) then
      raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  elsif tg_table_name='post_approval_issue_collections' and tg_op='UPDATE' then
    if new.draft_id<>old.draft_id or new.revision<>old.revision+1 or new.item_count<old.item_count or new.item_count>old.item_count+1
      or exists(select 1 from private.post_approval_room_issue_reports where draft_id=old.draft_id) then
      raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  elsif tg_table_name='post_approval_issue_evidence_items' then
    if tg_op='UPDATE' and (row(new.id,new.draft_id,new.display_order) is distinct from row(old.id,old.draft_id,old.display_order) or new.revision<>old.revision+1)
      or not exists(select 1 from private.post_approval_issue_evidence_acceptances a where a.operation_id=new.operation_id
        and row(a.draft_id,a.evidence_id,a.item_revision,a.display_order)=row(new.draft_id,new.id,new.revision,new.display_order))
      or exists(select 1 from private.post_approval_room_issue_reports where draft_id=new.draft_id) then
      raise exception using errcode='23514',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  elsif tg_table_name='post_approval_issue_delete_barriers' and tg_op='UPDATE' then
    if (to_jsonb(new)-array['settled_at','outcome']) is distinct from (to_jsonb(old)-array['settled_at','outcome'])
      or old.settled_at is not null or new.settled_at is null then
      raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  elsif tg_table_name='post_approval_issue_purge_jobs' and tg_op='UPDATE' then
    if new.object_id<>old.object_id or old.status in ('purged','blocked') or new.revision<>old.revision+1
      or new.lease_version<old.lease_version or new.lease_version>old.lease_version+1 then
      raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_IMMUTABLE'; end if;
  end if;
  return new;
end $$;
create function private.post_approval_issue_state_event() returns trigger language plpgsql set search_path='' as $$ begin
  insert into private.post_approval_issue_upload_events(operation_id,revision,state,lease_version,occurred_at)
    values(new.operation_id,new.revision,new.status,new.lease_version,new.updated_at);
  return new;
end $$;
create trigger post_approval_issue_state_events after insert or update on private.post_approval_issue_upload_states
  for each row execute function private.post_approval_issue_state_event();
create function private.post_approval_issue_draft_collection() returns trigger language plpgsql set search_path='' as $$ begin
  insert into private.post_approval_issue_collections(draft_id) values(new.id); return new;
end $$;
create trigger post_approval_issue_collection_created after insert on private.post_approval_room_issue_drafts
  for each row execute function private.post_approval_issue_draft_collection();

do $$ declare relation text; begin
  foreach relation in array array['post_approval_issue_upload_admissions','post_approval_issue_upload_operations','post_approval_issue_upload_events',
    'post_approval_issue_folder_bindings','post_approval_issue_identity_tombstones','post_approval_issue_evidence_acceptances',
    'post_approval_issue_report_seals','post_approval_issue_report_closures','post_approval_issue_quota_permits','post_approval_issue_quota_refreshes','post_approval_issue_quota_permit_uses','post_approval_issue_upload_handovers'] loop
    execute format('create trigger %I before update or delete on private.%I for each row execute function private.post_approval_room_issue_append_only()',relation||'_immutable',relation);
  end loop;
  foreach relation in array array['post_approval_issue_upload_states','post_approval_issue_provider_objects','post_approval_issue_collections',
    'post_approval_issue_evidence_items','post_approval_issue_delete_barriers','post_approval_issue_purge_jobs'] loop
    execute format('create trigger %I before insert or update or delete on private.%I for each row execute function private.guard_post_approval_issue_mutable()',relation||'_guard',relation);
  end loop;
end $$;

create function private.post_approval_issue_operation_projection(p_operation uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('operationId',o.id,'status',s.status,'leaseVersion',s.lease_version,
    'evidenceId',ad.evidence_id,'itemRevision',coalesce(a.item_revision,ad.expected_item_revision),
    'evidenceRevision',coalesce(a.collection_revision,ad.expected_evidence_revision),
    'mimeType',o.mime_type,'sizeBytes',o.size_bytes,'sha256',o.sha256)
  from private.post_approval_issue_upload_operations o
  join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
  join private.post_approval_issue_upload_states s on s.operation_id=o.id
  left join private.post_approval_issue_evidence_acceptances a on a.operation_id=o.id where o.id=p_operation
$$;

create function private.post_approval_issue_extra_inflight(p_actor uuid,p_at timestamptz) returns bigint
language sql stable set search_path='' as $$
  select (select count(*) from private.post_approval_issue_upload_admissions ad
    left join private.post_approval_issue_upload_operations o on o.admission_id=ad.id
    left join private.post_approval_issue_upload_states s on s.operation_id=o.id
    where ad.actor_profile_id=p_actor and ((o.id is null and ad.expires_at>p_at)
      or s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending')))
    + (select count(*) from private.post_approval_issue_upload_operations o
      join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
      join private.post_approval_issue_upload_states s on s.operation_id=o.id
      where ad.actor_profile_id<>p_actor and private.post_approval_issue_executor(o.id)=p_actor
        and s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending'))
    + (select count(distinct key_digest) from private.post_approval_issue_quota_permits p where p.actor_profile_id=p_actor and p.expires_at>p_at
      and not exists(select 1 from private.post_approval_issue_upload_admissions ad where ad.actor_profile_id=p.actor_profile_id and ad.idempotency_key_digest=p.key_digest))
    + (select count(*) from private.photo_upload_operations o join private.photo_upload_states s on s.operation_id=o.id
      where o.actor_profile_id=p_actor and s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending')
        and not exists(select 1 from private.photo_upload_admission_bindings b where b.operation_id=o.id))
$$;
create function private.post_approval_issue_all_inflight(p_actor uuid,p_at timestamptz) returns bigint
language sql stable set search_path='' as $$
  select private.post_approval_issue_extra_inflight(p_actor,p_at)+(select count(*) from private.photo_upload_admissions ad
    left join private.photo_upload_admission_bindings b on b.admission_id=ad.id
    left join private.photo_upload_states s on s.operation_id=b.operation_id
    where ad.actor_profile_id=p_actor and ((b.operation_id is null and ad.expires_at>p_at)
      or s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending')))
$$;
-- Legacy single begin runs BEFORE its admitted wrapper inserts the binding.
-- Subtract only the exact live admission that is becoming this operation; all
-- unrelated old/new reservations remain counted. Direct begin without that
-- exact tuple receives no exemption. The global ceiling remains eight.
create function private.post_approval_issue_single_transition_inflight(p_actor uuid,p_attempt uuid,p_assignment uuid,
  p_assignment_revision bigint,p_slot uuid,p_revision bigint,p_key text,p_at timestamptz) returns bigint
language sql stable set search_path='' as $$
  select private.post_approval_issue_all_inflight(p_actor,p_at)-case when exists(
    select 1 from private.photo_upload_admissions ad
    where ad.actor_profile_id=p_actor and ad.idempotency_key_digest=p_key and ad.cleaning_attempt_id=p_attempt
      and ad.cleaning_target_id=(select cleaning_target_id from public.cleaning_attempts where id=p_attempt)
      and ad.assignment_id=p_assignment and ad.assignment_revision=p_assignment_revision
      and ad.target_photo_slot_id=p_slot and ad.expected_photo_revision=p_revision and ad.expires_at>p_at
      and not exists(select 1 from private.photo_upload_admission_bindings where admission_id=ad.id)
  ) then 1 else 0 end
$$;
-- Pending reservations alone are a sound capacity lower bound even when the
-- provider snapshot is unknown/stale. Never invent provider usage at this gate.
create function private.post_approval_issue_pending_capacity(p_at timestamptz) returns bigint
language sql stable set search_path='' as $$
  select (select coalesce(sum(reserved_bytes),0)::bigint from private.photo_quota_pending where operation_id is not null or expires_at>p_at)
    +(select coalesce(sum(reserved_bytes),0)::bigint from private.post_approval_issue_quota_pending where operation_id is not null or expires_at>p_at)
    +307200*(select count(*) from (select distinct actor_profile_id,key_digest from private.post_approval_issue_quota_permits p where p.expires_at>p_at
      and not exists(select 1 from private.post_approval_issue_upload_admissions ad where ad.actor_profile_id=p.actor_profile_id and ad.idempotency_key_digest=p.key_digest)) permits)
$$;

create function private.post_approval_issue_sync_quota() returns trigger language plpgsql set search_path='' as $$ begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if tg_table_name='post_approval_issue_upload_admissions' then
    delete from private.post_approval_issue_quota_pending where operation_id is null and expires_at<=clock_timestamp();
    insert into private.post_approval_issue_quota_pending(admission_id,reserved_bytes,expires_at) values(new.id,new.reserved_bytes,new.expires_at);
  elsif tg_table_name='post_approval_issue_upload_operations' then
    update private.post_approval_issue_quota_pending set operation_id=new.id where admission_id=new.admission_id;
  elsif tg_table_name='post_approval_issue_provider_objects' then
    update private.post_approval_issue_quota_pending set provider_created_at=new.provider_created_at,provider_observed_at=new.provider_observed_at where operation_id=new.operation_id;
    if new.purged_at is not null then delete from private.post_approval_issue_quota_pending where operation_id=new.operation_id; end if;
  else
    delete from private.post_approval_issue_quota_pending where operation_id is null and expires_at<=clock_timestamp();
  end if;
  -- A provider-known timestamp alone is not proof that the refresh included the
  -- object: BOTH provider creation and first DB observation precede the watermark.
  delete from private.post_approval_issue_quota_pending p using private.photo_storage_quota_snapshot q
    where p.provider_created_at<q.request_started_at and p.provider_observed_at<q.request_started_at;
  return new;
end $$;
create trigger post_approval_issue_admission_quota after insert on private.post_approval_issue_upload_admissions for each row execute function private.post_approval_issue_sync_quota();
create trigger post_approval_issue_operation_quota after insert on private.post_approval_issue_upload_operations for each row execute function private.post_approval_issue_sync_quota();
create trigger post_approval_issue_object_quota after insert or update on private.post_approval_issue_provider_objects for each row execute function private.post_approval_issue_sync_quota();
create trigger post_approval_issue_refresh_quota after insert or update on private.photo_storage_quota_snapshot for each row execute function private.post_approval_issue_sync_quota();

-- Fail closed if an upstream implementation differs. Preserve exact existing
-- function identity, owner, language, volatility, SECURITY DEFINER, ACL and all
-- original guards; never copy an obsolete command body or session fallback.
create function private.post_approval_issue_patch(p_signature text,p_needle text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare def text; src text;
begin
  if to_regprocedure(p_signature) is null then raise exception using errcode='55000',message='POST_APPROVAL_ISSUE_DEPENDENCY_REQUIRED'; end if;
  select prosrc into src from pg_catalog.pg_proc where oid=p_signature::regprocedure;
  if (length(src)-length(replace(src,p_needle,'')))/length(p_needle)<>1 then
    raise exception using errcode='55000',message='POST_APPROVAL_ISSUE_DEPENDENCY_DRIFT'; end if;
  def:=pg_get_functiondef(p_signature::regprocedure);
  execute replace(def,src,replace(src,p_needle,p_replacement));
end $$;
select private.post_approval_issue_patch('private.photo_quota_context(timestamptz)',
  'return jsonb_build_object(''revision'',q.revision',
  'pending:=pending+(select coalesce(sum(reserved_bytes),0)::bigint from private.post_approval_issue_quota_pending where operation_id is not null or expires_at>p_at)
    +307200*(select count(*) from (select distinct actor_profile_id,key_digest from private.post_approval_issue_quota_permits p where p.expires_at>p_at
      and not exists(select 1 from private.post_approval_issue_upload_admissions ad where ad.actor_profile_id=p.actor_profile_id and ad.idempotency_key_digest=p.key_digest)) permits);
    return jsonb_build_object(''revision'',q.revision');
select private.post_approval_issue_patch('public.admit_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text)',
  '''compensation_pending'')))>=8 then',
  '''compensation_pending'')))+private.post_approval_issue_extra_inflight(p_actor_profile_id,at_time)>=8 then');
select private.post_approval_issue_patch('public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
  '''compensation_pending''))) >= 8 then',
  '''compensation_pending''))) + private.post_approval_issue_extra_inflight(p_actor_profile_id,at_time) >= 8 then');
select private.post_approval_issue_patch('public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)',
  '(select count(*) from private.photo_upload_states where actor_profile_id=p_actor_profile_id and status in (''reserved'',''provider_succeeded''))>=8',
  'private.post_approval_issue_single_transition_inflight(p_actor_profile_id,p_attempt_id,p_assignment_id,p_assignment_revision,p_target_slot_id,p_expected_photo_revision,p_idempotency_key_digest,clock_timestamp())>=8');
select private.post_approval_issue_patch('private.capture_photo_identity_tombstone()',
  'insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id)',
  'if exists(select 1 from private.post_approval_issue_identity_tombstones where locator_digest=dig) then raise exception using errcode=''23505'',message=''PHOTO_PROVIDER_IDENTITY_CONFLICT''; end if; insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id)');
select private.post_approval_issue_patch('private.maybe_retire_photo_folder(uuid,timestamptz)',
  'if eligible then',
  'if exists(select 1 from private.post_approval_issue_provider_objects o where o.provider_folder_id=folder.provider_folder_id and o.purged_at is null)
    or exists(select 1 from private.post_approval_issue_folder_bindings b join private.post_approval_issue_provider_objects o on o.operation_id=b.operation_id
      where b.folder_registry_id=folder.id and o.purged_at is null) then eligible:=false; end if; if eligible then');
drop function private.post_approval_issue_patch(text,text,text);


create function private.post_approval_issue_check_cas(p_ad private.post_approval_issue_upload_admissions) returns void
language plpgsql set search_path='' as $$
declare d private.post_approval_room_issue_drafts; c private.post_approval_issue_collections; i private.post_approval_issue_evidence_items;
begin
  select * into d from private.post_approval_room_issue_drafts where id=p_ad.draft_id for update;
  select * into c from private.post_approval_issue_collections where draft_id=d.id for update;
  select * into i from private.post_approval_issue_evidence_items where id=p_ad.evidence_id for update;
  if d.id is null or c.draft_id is null or d.draft_revision<>p_ad.expected_draft_revision or c.revision<>p_ad.expected_evidence_revision
    or exists(select 1 from private.post_approval_room_issue_reports where draft_id=d.id)
    or (p_ad.expected_item_revision=0 and i.id is not null) or (p_ad.expected_item_revision>0 and
      (i.id is null or i.draft_id<>d.id or i.revision<>p_ad.expected_item_revision))
    or (i.id is null and c.item_count>=10) then
    raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
end $$;
create function private.post_approval_issue_check_fence(p_operation uuid,p_lease integer,p_digest text) returns void
language plpgsql set search_path='' as $$
begin
  if p_lease is null or p_digest is null or p_digest!~'^[0-9a-f]{64}$' or not exists(
    select 1 from private.post_approval_issue_upload_states where operation_id=p_operation and lease_version=p_lease
      and fence_token_digest=p_digest and lease_expires_at>clock_timestamp()) then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
end $$;
-- A quota read cannot turn an expired/stale create into a valid upload. Only an
-- already-proven terminal replay or exact never-accepted compensation may avoid
-- a current draft CAS, and neither is authority for another create/acceptance.
create function private.post_approval_issue_check_quota_boundary(p_ad private.post_approval_issue_upload_admissions) returns void
language plpgsql volatile set search_path='' as $$
declare o private.post_approval_issue_upload_operations; st private.post_approval_issue_upload_states;
  obj private.post_approval_issue_provider_objects; b private.post_approval_issue_delete_barriers; proof jsonb;
begin
  select * into o from private.post_approval_issue_upload_operations where admission_id=p_ad.id;
  if o.id is null then
    if p_ad.id is not null and p_ad.expires_at<=clock_timestamp() then raise exception using errcode='40001',message='PHOTO_UPLOAD_ADMISSION_EXPIRED'; end if;
    perform private.post_approval_issue_check_cas(p_ad);
    return;
  end if;
  select * into st from private.post_approval_issue_upload_states where operation_id=o.id;
  select * into obj from private.post_approval_issue_provider_objects where operation_id=o.id;
  select * into b from private.post_approval_issue_delete_barriers where object_id=obj.id;
  if st.status='compensated' then
    if obj.purged_at is null or b.settled_at is null then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  elsif st.status='compensation_pending' then
    proof:=private.post_approval_issue_delete_authority(obj.id);
    if proof->>'reason' is distinct from 'never_accepted_date_mismatch'
      or (b.object_id is not null and (b.reason<>proof->>'reason' or b.anchor_at is distinct from (proof->>'anchorAt')::timestamptz)) then
      raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED'; end if;
  else
    if obj.purged_at is not null or b.object_id is not null then raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED'; end if;
    if st.status='accepted' then
      if not exists(select 1 from private.post_approval_issue_evidence_acceptances where operation_id=o.id and object_id=obj.id) then
        raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
    elsif st.status in ('reconciliation_pending','provider_succeeded')
      and obj.provider_file_id is not null and obj.provider_folder_id is not null then
      -- A quota read may unblock inspection of the already-bound identity.
      -- Creating or accepting evidence still checks the current three revisions.
      return;
    else perform private.post_approval_issue_check_cas(p_ad); end if;
  end if;
end $$;
create function private.post_approval_issue_provider_projection(p_operation uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('objectId',obj.id,'fileId',obj.provider_file_id,'folderId',obj.provider_folder_id,
    'fileName',obj.file_name,'uploadDate',obj.upload_date,'roomNumber',obj.room_number,
    'mimeType',o.mime_type,'sizeBytes',o.size_bytes,'sha256',o.sha256)
  from private.post_approval_issue_upload_operations o join private.post_approval_issue_provider_objects obj on obj.operation_id=o.id where o.id=p_operation
$$;
create function private.guard_post_approval_issue_acceptance() returns trigger language plpgsql set search_path='' as $$
declare ad private.post_approval_issue_upload_admissions; obj private.post_approval_issue_provider_objects;
begin
  select a.* into ad from private.post_approval_issue_upload_operations o join private.post_approval_issue_upload_admissions a on a.id=o.admission_id where o.id=new.operation_id;
  select * into obj from private.post_approval_issue_provider_objects where id=new.object_id and operation_id=new.operation_id;
  perform private.post_approval_issue_check_cas(ad);
  if ad.id is null or new.draft_id<>ad.draft_id or new.evidence_id<>ad.evidence_id
    or new.item_revision<>ad.expected_item_revision+1 or new.collection_revision<>ad.expected_evidence_revision+1
    or obj.id is null or obj.provider_file_id is null or obj.provider_folder_id is null or obj.provider_created_at is null
    or obj.date_mismatch or obj.purged_at is not null
    or (obj.provider_created_at at time zone 'Asia/Seoul')::date<>obj.upload_date
    or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id)
    or not exists(select 1 from private.post_approval_issue_upload_states where operation_id=new.operation_id and status='provider_succeeded')
    or new.display_order<>coalesce((select display_order from private.post_approval_issue_evidence_items where id=new.evidence_id),
      (select item_count from private.post_approval_issue_collections where draft_id=new.draft_id)) then
    raise exception using errcode='23514',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  return new;
end $$;
create trigger post_approval_issue_acceptance_proof before insert on private.post_approval_issue_evidence_acceptances
  for each row execute function private.guard_post_approval_issue_acceptance();

-- All uploader commands share the SAME authoritative active-session/ownership
-- boundary. These commands are inaccessible to authenticated/public roles.
-- Provider I/O occurs only between RPCs, never inside this transaction.
create function private.post_approval_issue_upload_command(p_actor uuid,p_session uuid,p_command text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles;
  d private.post_approval_room_issue_drafts; ad private.post_approval_issue_upload_admissions;
  o private.post_approval_issue_upload_operations; st private.post_approval_issue_upload_states;
  obj private.post_approval_issue_provider_objects; c private.post_approval_issue_collections;
  item private.post_approval_issue_evidence_items; f private.photo_drive_folder_identities;
  parent private.photo_drive_folder_identities;
  lim private.photo_upload_admission_limits; bucket private.photo_upload_rate_limits;
  permit private.post_approval_issue_quota_permits;
  at_time timestamptz; q jsonb; result jsonb; room_snapshot text; name_number bigint; uploaded_at timestamptz;
  scope_room text; next_order integer; dig text;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor,p_session);
  at_time:=clock_timestamp();
  if p_command='admit' then
    select * into ad from private.post_approval_issue_upload_admissions where actor_profile_id=p_actor and idempotency_key_digest=p_args->>'keyDigest' for update;
    if ad.id is not null then
      select * into d from private.post_approval_room_issue_drafts where id=ad.draft_id for update;
      perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
      if row(d.client_report_id,d.source_submission_id) is distinct from row((p_args->>'clientReportId')::uuid,(p_args->>'sourceSubmissionId')::uuid) then
        raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    else
      select * into d from private.post_approval_room_issue_drafts where (actor.role='admin' or reported_by_profile_id=p_actor)
        and client_report_id=(p_args->>'clientReportId')::uuid and source_submission_id=(p_args->>'sourceSubmissionId')::uuid for update;
    end if;
  elsif p_command='begin' then
    select * into ad from private.post_approval_issue_upload_admissions where id=(p_args->>'admissionId')::uuid for update;
    select * into o from private.post_approval_issue_upload_operations where admission_id=ad.id for update;
    select * into d from private.post_approval_room_issue_drafts where id=ad.draft_id for update;
  else
    select * into o from private.post_approval_issue_upload_operations where id=(p_args->>'operationId')::uuid for update;
    select * into ad from private.post_approval_issue_upload_admissions where id=o.admission_id;
    select * into d from private.post_approval_room_issue_drafts where id=ad.draft_id for update;
  end if;
  -- Admission identity never transfers; execution does only through a fenced
  -- immutable handover. Original receipt replay cannot reclaim execution.
  if d.id is null or (actor.role<>'admin' and d.reported_by_profile_id<>p_actor)
    or (p_command in ('admit','begin') and ad.id is not null and ad.actor_profile_id<>p_actor)
    or (p_command not in ('admit','begin') and not (p_command='get' and actor.role='admin')
      and private.post_approval_issue_executor(o.id) is distinct from p_actor) then
    raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  -- Observing safe status/lease CAS is shared admin work, not an execution
  -- transfer. Historical status survives source rejection/replacement; all
  -- provider/mutation commands still require creator/executor and fresh source.
  if p_command='get' then
    perform private.assert_post_approval_room_issue_source_access(actor,d.source_submission_id);
  else
    perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  end if;
  select * into c from private.post_approval_issue_collections where draft_id=d.id for update;
  if p_command='admit' then
    if p_args->>'keyDigest' is null or p_args->>'keyDigest'!~'^[0-9a-f]{64}$'
      or (p_args->>'expectedDraftRevision')::bigint not between 1 and 9007199254740991
      or (p_args->>'expectedEvidenceRevision')::bigint not between 0 and 9007199254740990
      or (p_args->>'expectedItemRevision')::bigint not between 0 and 9007199254740990
      or p_args->>'evidenceId' is null then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
    select * into ad from private.post_approval_issue_upload_admissions where actor_profile_id=p_actor and idempotency_key_digest=p_args->>'keyDigest' for update;
    if ad.id is not null and row(ad.draft_id,ad.evidence_id,ad.expected_draft_revision,ad.expected_evidence_revision,ad.expected_item_revision)
      is distinct from row(d.id,(p_args->>'evidenceId')::uuid,(p_args->>'expectedDraftRevision')::bigint,(p_args->>'expectedEvidenceRevision')::bigint,(p_args->>'expectedItemRevision')::bigint) then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    if ad.id is null then
      ad.draft_id:=d.id; ad.evidence_id:=(p_args->>'evidenceId')::uuid; ad.expected_draft_revision:=(p_args->>'expectedDraftRevision')::bigint;
      ad.expected_evidence_revision:=(p_args->>'expectedEvidenceRevision')::bigint; ad.expected_item_revision:=(p_args->>'expectedItemRevision')::bigint;
      perform private.post_approval_issue_check_cas(ad);
      if exists(select 1 from private.post_approval_issue_quota_permits p where p.actor_profile_id=p_actor and p.key_digest=p_args->>'keyDigest'
        and row(p.draft_id,p.evidence_id,p.expected_draft_revision,p.expected_evidence_revision,p.expected_item_revision)
          is distinct from row(d.id,ad.evidence_id,ad.expected_draft_revision,ad.expected_evidence_revision,ad.expected_item_revision)) then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
      if private.post_approval_issue_all_inflight(p_actor,at_time)-(case when exists(select 1 from private.post_approval_issue_quota_permits p
        where p.actor_profile_id=p_actor and p.key_digest=p_args->>'keyDigest' and p.expires_at>at_time) then 1 else 0 end)>=8 then raise exception using errcode='54000',message='PHOTO_UPLOAD_LIMIT_EXCEEDED'; end if;
    elsif ad.expires_at<=at_time and not exists(select 1 from private.post_approval_issue_upload_operations where admission_id=ad.id) then
      raise exception using errcode='55000',message='PHOTO_UPLOAD_ADMISSION_EXPIRED'; end if;
    if ad.id is not null then
      select * into o from private.post_approval_issue_upload_operations where admission_id=ad.id for update;
      -- Unstarted retries must reject stale revisions before reading/decoding
      -- another body. Already-started reconciliation retains its exact identity.
      if o.id is null or exists(select 1 from private.post_approval_issue_upload_states
        where operation_id=o.id and status='reserved') then
        perform private.post_approval_issue_check_cas(ad);
      end if;
    end if;
    if p_args->>'quotaPermitId' is not null then
      select * into permit from private.post_approval_issue_quota_permits where id=(p_args->>'quotaPermitId')::uuid;
      if permit.id is null or permit.actor_profile_id<>p_actor or permit.expires_at<=clock_timestamp()
        or row(permit.draft_id,permit.evidence_id,permit.expected_draft_revision,permit.expected_evidence_revision,permit.expected_item_revision,permit.key_digest)
          is distinct from row(d.id,ad.evidence_id,ad.expected_draft_revision,ad.expected_evidence_revision,ad.expected_item_revision,p_args->>'keyDigest')
        or not exists(select 1 from private.post_approval_issue_quota_refreshes where permit_id=permit.id)
        or exists(select 1 from private.post_approval_issue_quota_permit_uses where permit_id=permit.id and admission_id is distinct from ad.id) then
        raise exception using errcode='40001',message='PHOTO_UPLOAD_ADMISSION_EXPIRED'; end if;
    end if;
    q:=private.photo_quota_context(clock_timestamp());
    if ad.id is null and (q->>'effectiveBytes')::bigint+(case when exists(select 1 from private.post_approval_issue_quota_permits p
      where p.actor_profile_id=p_actor and p.key_digest=p_args->>'keyDigest' and p.expires_at>clock_timestamp()) then 0 else 307200 end)>=12000000000 then raise exception using errcode='54000',message='PHOTO_STORAGE_QUOTA_EXCEEDED'; end if;
    if permit.id is null then
      select * into lim from private.photo_upload_admission_limits where actor_profile_id=p_actor;
      if lim.minute_started_at=date_trunc('minute',at_time) and lim.occurrence_count>=30 then raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
      insert into private.photo_upload_admission_limits values(p_actor,date_trunc('minute',at_time),1) on conflict(actor_profile_id) do update
        set minute_started_at=excluded.minute_started_at,occurrence_count=case when photo_upload_admission_limits.minute_started_at=excluded.minute_started_at then photo_upload_admission_limits.occurrence_count+1 else 1 end;
    end if;
    if ad.id is null then
      insert into private.post_approval_issue_upload_admissions(actor_profile_id,draft_id,evidence_id,expected_draft_revision,expected_evidence_revision,expected_item_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
        values(p_actor,d.id,ad.evidence_id,ad.expected_draft_revision,ad.expected_evidence_revision,ad.expected_item_revision,p_args->>'keyDigest',at_time,at_time+interval '5 minutes',(q->>'revision')::bigint) returning * into ad;
    end if;
    if permit.id is not null then insert into private.post_approval_issue_quota_permit_uses(permit_id,admission_id) values(permit.id,ad.id) on conflict(permit_id) do nothing; end if;
    result:=jsonb_build_object('admissionId',ad.id,'expiresAt',ad.expires_at,'reservedBytes',ad.reserved_bytes,'quotaWarning',(q->>'warning')::boolean);
  elsif p_command='begin' then
    if p_args->>'keyDigest' is distinct from ad.idempotency_key_digest or p_args->>'requestHash' is null or p_args->>'requestHash'!~'^[0-9a-f]{64}$'
      or p_args->>'sha256' is null or p_args->>'sha256'!~'^[0-9a-f]{64}$' or p_args->>'mimeType' not in ('image/jpeg','image/webp')
      or (p_args->>'sizeBytes')::integer not between 1 and 307200 then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
    if o.id is not null then
      if row(o.request_hash,o.sha256,o.mime_type,o.size_bytes) is distinct from row(p_args->>'requestHash',p_args->>'sha256',p_args->>'mimeType',(p_args->>'sizeBytes')::integer) then
        raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    else
      if ad.expires_at<=clock_timestamp() then raise exception using errcode='55000',message='PHOTO_UPLOAD_ADMISSION_EXPIRED'; end if;
      perform private.post_approval_issue_check_cas(ad);
      select notified_room_number_snapshot into room_snapshot from public.cleaning_assignments where id=d.assignment_id;
      if room_snapshot is null or room_snapshot!~'^[0-9]{3}$' then raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE'; end if;
      select * into bucket from private.photo_upload_rate_limits where actor_profile_id=p_actor;
      if bucket.minute_started_at=date_trunc('minute',at_time) and bucket.occurrence_count>=30 then raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
      insert into private.photo_upload_rate_limits values(p_actor,date_trunc('minute',at_time),1) on conflict(actor_profile_id) do update
        set minute_started_at=excluded.minute_started_at,occurrence_count=case when photo_upload_rate_limits.minute_started_at=excluded.minute_started_at then photo_upload_rate_limits.occurrence_count+1 else 1 end;
      insert into private.post_approval_issue_upload_operations(admission_id,request_hash,sha256,mime_type,size_bytes,created_at)
        values(ad.id,p_args->>'requestHash',p_args->>'sha256',p_args->>'mimeType',(p_args->>'sizeBytes')::integer,at_time) returning * into o;
      name_number:=nextval('private.photo_storage_name_number'::regclass);
      insert into private.post_approval_issue_provider_objects(operation_id,upload_date,room_number,naming_number,file_name)
        values(o.id,(at_time at time zone 'Asia/Seoul')::date,room_snapshot,name_number,
          private.photo_storage_file_name((at_time at time zone 'Asia/Seoul')::date,'issue-proof',room_snapshot,name_number,o.mime_type));
      insert into private.post_approval_issue_upload_states(operation_id) values(o.id);
    end if;
    result:=private.post_approval_issue_operation_projection(o.id);
  else
    if o.id is null then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
    select * into st from private.post_approval_issue_upload_states where operation_id=o.id for update;
    select * into obj from private.post_approval_issue_provider_objects where operation_id=o.id for update;
    if p_command='get' then result:=private.post_approval_issue_operation_projection(o.id);
    elsif p_command='claim' then
      if p_args->>'fence' is null or p_args->>'fence'!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
      if st.status='accepted' then result:=private.post_approval_issue_operation_projection(o.id);
      else
        if st.status='compensated' or (st.lease_expires_at>at_time and st.fence_token_digest is distinct from p_args->>'fence') then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
        if st.lease_expires_at is null or st.lease_expires_at<=at_time then
          if st.lease_version>=8 then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
          update private.post_approval_issue_upload_states set lease_version=lease_version+1,fence_token_digest=p_args->>'fence',lease_expires_at=at_time+interval '5 minutes',revision=revision+1,updated_at=at_time where operation_id=o.id;
        end if;
        result:=private.post_approval_issue_operation_projection(o.id);
      end if;
    else
      perform private.post_approval_issue_check_fence(o.id,(p_args->>'lease')::integer,p_args->>'fence');
      if p_command='renew' then
        if st.status='reserved' then perform private.post_approval_issue_check_cas(ad); end if;
        if st.status not in ('accepted','compensated') then update private.post_approval_issue_upload_states set lease_expires_at=at_time+interval '5 minutes',revision=revision+1,updated_at=at_time where operation_id=o.id; end if;
        result:=private.post_approval_issue_operation_projection(o.id);
      elsif p_command='prepare_write' then
        perform private.post_approval_issue_check_cas(ad);
        if st.status<>'reserved' or obj.provider_file_id is null or obj.provider_folder_id is null or obj.purged_at is not null
          or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id) then
          raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
        -- Commit uncertain-I/O intent before the external write. A lost response,
        -- expired actor or CAS change cannot strand a created object as reserved:
        -- renewed authorized retries inspect exact identity, never create again.
        update private.post_approval_issue_upload_states set status='reconciliation_pending',revision=revision+1,updated_at=at_time where operation_id=o.id;
        result:=private.post_approval_issue_operation_projection(o.id);
      elsif p_command in ('provider_context','folder','identity') then
        if st.status in ('accepted','compensated') or obj.purged_at is not null or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id) then
          raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
        -- Reconcile may inspect ONLY its already-persisted identity after a stale
        -- draft, so unknown provider timestamps can be established safely. It is
        -- never a permission to allocate/rebind/write a new object. Reserved
        -- creates and every folder/identity command require current three-axis CAS.
        if st.status='reserved' or p_command in ('folder','identity') then perform private.post_approval_issue_check_cas(ad);
        elsif st.status not in ('reconciliation_pending','provider_succeeded') or obj.provider_file_id is null or obj.provider_folder_id is null then
          raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
        if p_command='folder' then
          if p_args->>'scope' not in ('date','room') or p_args->>'rootFolderId' is null or p_args->>'rootFolderId'!~'^[A-Za-z0-9_-]{10,200}$'
            or p_args->>'candidateFolderId' is null or p_args->>'candidateFolderId'!~'^[A-Za-z0-9_-]{10,200}$' then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
          scope_room:=case when p_args->>'scope'='date' then '' else obj.room_number end;
          if scope_room<>'' then select r.* into parent from private.post_approval_issue_folder_bindings b join private.photo_drive_folder_identities r on r.id=b.folder_registry_id where b.operation_id=o.id and b.scope='date'; end if;
          if scope_room<>'' and (parent.id is null or parent.provider_folder_id is null or parent.parent_folder_id<>p_args->>'rootFolderId') then raise exception using errcode='23514',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
          select * into f from private.photo_drive_folder_identities where upload_date=obj.upload_date and scope_room_number=scope_room for update;
          if f.id is null then
            insert into private.photo_drive_folder_identities(upload_date,scope_room_number,provider_folder_id,parent_folder_id,parent_registry_id)
              values(obj.upload_date,scope_room,p_args->>'candidateFolderId',case when scope_room='' then p_args->>'rootFolderId' else parent.provider_folder_id end,parent.id) returning * into f;
          end if;
          if f.provider_folder_id is null or exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=f.id)
            or f.parent_folder_id is distinct from (case when scope_room='' then p_args->>'rootFolderId' else parent.provider_folder_id end) then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
          insert into private.post_approval_issue_folder_bindings values(o.id,p_args->>'scope',f.id) on conflict(operation_id,scope) do nothing;
          if not exists(select 1 from private.post_approval_issue_folder_bindings where operation_id=o.id and scope=p_args->>'scope' and folder_registry_id=f.id) then raise exception using errcode='23514',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
          result:=jsonb_build_object('folderId',f.provider_folder_id,'parentFolderId',f.parent_folder_id,'name',case when scope_room='' then obj.upload_date::text else scope_room end);
        elsif p_command='identity' then
          select r.* into f from private.post_approval_issue_folder_bindings b join private.photo_drive_folder_identities r on r.id=b.folder_registry_id where b.operation_id=o.id and b.scope='room';
          if p_args->>'fileId' is null or p_args->>'fileId'!~'^[A-Za-z0-9_-]{10,200}$' or f.id is null or f.provider_folder_id is distinct from p_args->>'folderId'
            or exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=f.id) then raise exception using errcode='23514',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
          if obj.provider_file_id is null then
            dig:=encode(extensions.digest(convert_to(p_args->>'fileId','UTF8'),'sha256'),'hex');
            if exists(select 1 from private.photo_provider_identity_tombstones where locator_digest=dig)
              or exists(select 1 from private.post_approval_issue_identity_tombstones where locator_digest=dig)
              or exists(select 1 from private.photo_drive_folder_identities where provider_folder_id=p_args->>'fileId') then raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
            update private.post_approval_issue_provider_objects set provider_file_id=p_args->>'fileId',provider_folder_id=f.provider_folder_id where id=obj.id;
          end if;
          -- First identity is authoritative across retries; a freshly generated
          -- candidate is never used to overwrite a committed locator/name.
          result:=private.post_approval_issue_provider_projection(o.id);
        else result:=private.post_approval_issue_provider_projection(o.id); end if;
      elsif p_command='provider_success' then
        uploaded_at:=(p_args->>'uploadedAt')::timestamptz;
        if uploaded_at is null or not isfinite(uploaded_at) or uploaded_at>clock_timestamp() or obj.provider_file_id is null
          or obj.provider_folder_id is null or obj.purged_at is not null or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id)
          or st.status in ('accepted','compensated') then raise exception using errcode='23514',message='PHOTO_UPLOAD_TIME_INVALID'; end if;
        if obj.provider_created_at is null then
          update private.post_approval_issue_provider_objects set provider_created_at=uploaded_at,provider_observed_at=clock_timestamp(),date_mismatch=(uploaded_at at time zone 'Asia/Seoul')::date<>upload_date where id=obj.id returning * into obj;
        elsif obj.provider_created_at<>uploaded_at then raise exception using errcode='23514',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
        update private.post_approval_issue_upload_states set status=case when obj.date_mismatch then 'compensation_pending' else 'provider_succeeded' end,revision=revision+1,updated_at=clock_timestamp() where operation_id=o.id;
        result:=private.post_approval_issue_operation_projection(o.id);
      elsif p_command='accept' then
        if st.status='accepted' then result:=private.post_approval_issue_operation_projection(o.id);
        else
          if st.status<>'provider_succeeded' or obj.date_mismatch or obj.purged_at is not null or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id) then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
          perform private.post_approval_issue_check_cas(ad);
          select * into item from private.post_approval_issue_evidence_items where id=ad.evidence_id for update;
          next_order:=coalesce(item.display_order,c.item_count);
          insert into private.post_approval_issue_evidence_acceptances(operation_id,object_id,draft_id,evidence_id,item_revision,collection_revision,display_order)
            values(o.id,obj.id,d.id,ad.evidence_id,ad.expected_item_revision+1,ad.expected_evidence_revision+1,next_order);
          insert into private.post_approval_issue_evidence_items(id,draft_id,revision,operation_id,display_order)
            values(ad.evidence_id,d.id,ad.expected_item_revision+1,o.id,next_order) on conflict(id) do update set revision=excluded.revision,operation_id=excluded.operation_id;
          update private.post_approval_issue_collections set revision=revision+1,item_count=item_count+case when item.id is null then 1 else 0 end where draft_id=d.id;
          update private.post_approval_issue_upload_states set status='accepted',revision=revision+1,updated_at=clock_timestamp() where operation_id=o.id;
          result:=private.post_approval_issue_operation_projection(o.id);
        end if;
      elsif p_command='unknown' then
        if st.status not in ('accepted','compensated','compensation_pending') then update private.post_approval_issue_upload_states set status='reconciliation_pending',revision=revision+1,updated_at=clock_timestamp() where operation_id=o.id; end if;
        result:=private.post_approval_issue_operation_projection(o.id);
      else raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
    end if;
  end if;
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor,p_session);
  return result;
end $$;

create function public.admit_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_client_report_id uuid,p_evidence_id uuid,p_expected_draft_revision bigint,p_expected_evidence_revision bigint,p_expected_item_revision bigint,p_idempotency_key_digest text,p_quota_refresh_permit_id uuid default null)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'admit',jsonb_build_object('sourceSubmissionId',p_source_submission_id,'clientReportId',p_client_report_id,'evidenceId',p_evidence_id,'expectedDraftRevision',p_expected_draft_revision,'expectedEvidenceRevision',p_expected_evidence_revision,'expectedItemRevision',p_expected_item_revision,'keyDigest',p_idempotency_key_digest,'quotaPermitId',p_quota_refresh_permit_id))
$$;

create function public.begin_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_admission_id uuid,p_sha256 text,p_mime_type text,p_size_bytes integer,p_idempotency_key_digest text,p_request_hash text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'begin',jsonb_build_object('admissionId',p_admission_id,'sha256',p_sha256,'mimeType',p_mime_type,'sizeBytes',p_size_bytes,'keyDigest',p_idempotency_key_digest,'requestHash',p_request_hash))
$$;

create function public.claim_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'claim',jsonb_build_object('operationId',p_operation_id,'fence',p_fence_token_digest))
$$;

create function public.get_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'get',jsonb_build_object('operationId',p_operation_id))
$$;

create function public.renew_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'renew',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest))
$$;

create function public.get_post_approval_room_issue_evidence_provider_context(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'provider_context',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest))
$$;

create function public.finalize_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'accept',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest))
$$;
create function public.prepare_post_approval_room_issue_evidence_provider_write(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'prepare_write',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest))
$$;

create function public.mark_post_approval_room_issue_evidence_unknown(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'unknown',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest))
$$;

create function public.reserve_post_approval_room_issue_evidence_folder(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text,p_scope text,p_root_folder_id text,p_candidate_folder_id text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'folder',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest,'scope',p_scope,'rootFolderId',p_root_folder_id,'candidateFolderId',p_candidate_folder_id))
$$;

create function public.reserve_post_approval_room_issue_evidence_identity(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text,p_provider_file_id text,p_provider_folder_id text)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'identity',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest,'fileId',p_provider_file_id,'folderId',p_provider_folder_id))
$$;

create function public.record_post_approval_room_issue_evidence_provider_success(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text,p_uploaded_at timestamptz)
returns jsonb language sql volatile security definer set search_path='' as $$
  select private.post_approval_issue_upload_command(p_actor_profile_id,p_session_id,'provider_success',jsonb_build_object('operationId',p_operation_id,'lease',p_lease_version,'fence',p_fence_token_digest,'uploadedAt',p_uploaded_at))
$$;

create function private.post_approval_issue_report_projection(p_report uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('reportId',r.id,'clientReportId',r.client_report_id,'sourceSubmissionId',r.source_submission_id,
    'originalPerformerProfileId',r.original_performer_profile_id,'reportedByProfileId',r.reported_by_profile_id,
    'reportedAt',r.reported_at,'memo',r.memo,'evidence',(select jsonb_agg(jsonb_build_object('evidenceId',evidence_id,
      'revision',item_revision,'displayOrder',display_order) order by display_order) from private.post_approval_issue_report_seals where report_id=r.id))
  from private.post_approval_room_issue_reports r where r.id=p_report
$$;
create function private.post_approval_issue_seal_valid() returns trigger language plpgsql set search_path='' as $$
declare rid uuid; r private.post_approval_room_issue_reports;
begin
  if tg_table_name='post_approval_room_issue_reports' then
    rid:=new.id;
  else
    rid:=new.report_id;
  end if;
  select * into r from private.post_approval_room_issue_reports where id=rid;
  if r.id is null or not exists(select 1 from private.post_approval_room_issue_drafts d join private.post_approval_issue_collections c on c.draft_id=d.id
      where d.id=r.draft_id and d.memo=r.memo and d.draft_revision=r.draft_revision and c.revision=r.evidence_revision and c.item_count=r.evidence_count)
    or (select count(*) from private.post_approval_issue_report_seals where report_id=rid)<>r.evidence_count
    or exists(select 1 from private.post_approval_issue_report_seals s
      left join private.post_approval_issue_evidence_items i on i.id=s.evidence_id and i.draft_id=s.draft_id and i.revision=s.item_revision and i.operation_id=s.operation_id and i.display_order=s.display_order
      join private.post_approval_issue_evidence_acceptances a on a.operation_id=s.operation_id
      join private.post_approval_issue_provider_objects obj on obj.id=a.object_id
      where s.report_id=rid and (s.draft_id<>r.draft_id or i.id is null or obj.purged_at is not null or
        exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id))) then
    raise exception using errcode='23514',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  return null;
end $$;
create constraint trigger post_approval_issue_report_sealed after insert on private.post_approval_room_issue_reports
  deferrable initially deferred for each row execute function private.post_approval_issue_seal_valid();
create constraint trigger post_approval_issue_seal_complete after insert on private.post_approval_issue_report_seals
  deferrable initially deferred for each row execute function private.post_approval_issue_seal_valid();

-- Retention is derived from immutable typed business provenance, not old links.
-- Accepted replaced versions remain bound to the same draft/report: never orphan.
-- A never-accepted upload with still-live 3-CAS is also NOT an orphan.
create function private.post_approval_issue_delete_authority(p_object uuid) returns jsonb
language plpgsql volatile set search_path='' as $$
declare obj private.post_approval_issue_provider_objects; ad private.post_approval_issue_upload_admissions;
  d private.post_approval_room_issue_drafts; closure private.post_approval_issue_report_closures; live boolean;
begin
  select * into obj from private.post_approval_issue_provider_objects where id=p_object;
  select a.* into ad from private.post_approval_issue_upload_operations o join private.post_approval_issue_upload_admissions a on a.id=o.admission_id where o.id=obj.operation_id;
  select * into d from private.post_approval_room_issue_drafts where id=ad.draft_id;
  perform private.post_approval_room_issue_source_authority(d.source_submission_id);
  if obj.id is null or obj.provider_file_id is null or obj.provider_created_at is null or obj.purged_at is not null then return null; end if;
  if exists(select 1 from private.post_approval_issue_evidence_acceptances where object_id=obj.id) then
    select c.* into closure from private.post_approval_room_issue_reports r join private.post_approval_issue_report_closures c on c.report_id=r.id where r.draft_id=d.id;
    if closure.report_id is not null and closure.closed_at+interval '180 days'<=clock_timestamp() then
      return jsonb_build_object('reason','closed_report_180d','anchorAt',closure.closed_at); end if;
    return null;
  end if;
  if exists(select 1 from private.post_approval_issue_report_seals where operation_id=obj.operation_id) then return null; end if;
  if obj.date_mismatch and exists(select 1 from private.post_approval_issue_upload_states where operation_id=obj.operation_id and status='compensation_pending') then
    return jsonb_build_object('reason','never_accepted_date_mismatch','anchorAt',obj.provider_created_at); end if;
  live:=d.draft_revision=ad.expected_draft_revision
    and exists(select 1 from private.post_approval_issue_collections where draft_id=d.id and revision=ad.expected_evidence_revision)
    and not exists(select 1 from private.post_approval_room_issue_reports where draft_id=d.id)
    and ((ad.expected_item_revision=0 and not exists(select 1 from private.post_approval_issue_evidence_items where id=ad.evidence_id))
      or exists(select 1 from private.post_approval_issue_evidence_items where id=ad.evidence_id and draft_id=d.id and revision=ad.expected_item_revision));
  if not live and obj.provider_created_at+interval '30 days'<=clock_timestamp() then
    return jsonb_build_object('reason','true_orphan_30d','anchorAt',obj.provider_created_at); end if;
  return null;
end $$;
create function private.post_approval_issue_prepare_delete(p_object uuid) returns jsonb
language plpgsql set search_path='' as $$
declare proof jsonb; b private.post_approval_issue_delete_barriers; obj private.post_approval_issue_provider_objects;
begin
  select * into obj from private.post_approval_issue_provider_objects where id=p_object for update;
  select * into b from private.post_approval_issue_delete_barriers where object_id=p_object for update;
  if b.settled_at is not null then return jsonb_build_object('deleteToken',b.delete_token,'objectId',p_object,'fileId',null); end if;
  proof:=private.post_approval_issue_delete_authority(p_object);
  if proof is null then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED'; end if;
  if b.object_id is null then
    insert into private.post_approval_issue_delete_barriers(object_id,reason,anchor_at) values(p_object,proof->>'reason',(proof->>'anchorAt')::timestamptz) returning * into b;
  elsif row(b.reason,b.anchor_at) is distinct from row(proof->>'reason',(proof->>'anchorAt')::timestamptz) then
    raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED'; end if;
  return jsonb_build_object('deleteToken',b.delete_token,'objectId',obj.id,'fileId',obj.provider_file_id);
end $$;
create function private.post_approval_issue_settle_delete(p_token uuid,p_outcome text) returns uuid
language plpgsql set search_path='' as $$
declare b private.post_approval_issue_delete_barriers; obj private.post_approval_issue_provider_objects; at_time timestamptz; folder record;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found') then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  select * into b from private.post_approval_issue_delete_barriers where delete_token=p_token for update;
  select * into obj from private.post_approval_issue_provider_objects where id=b.object_id for update;
  if b.object_id is null then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED'; end if;
  if b.settled_at is null then
    perform private.post_approval_issue_prepare_delete(obj.id);
    at_time:=clock_timestamp();
    update private.post_approval_issue_delete_barriers set settled_at=at_time,outcome=p_outcome where object_id=obj.id;
    update private.post_approval_issue_provider_objects set provider_file_id=null,provider_folder_id=null,purged_at=at_time where id=obj.id;
    if not exists(select 1 from private.post_approval_issue_evidence_acceptances where object_id=obj.id) then
      update private.post_approval_issue_upload_states set status='compensated',revision=revision+1,updated_at=at_time where operation_id=obj.operation_id;
    end if;
    -- Shared folders are retired only after exact physical deletion settles.
    -- The patched old reference guard still checks BOTH domains and descendants.
    for folder in select folder_registry_id from private.post_approval_issue_folder_bindings where operation_id=obj.operation_id order by scope desc loop
      perform private.maybe_retire_photo_folder(folder.folder_registry_id,at_time);
    end loop;
  end if;
  return obj.operation_id;
end $$;

create function public.prepare_post_approval_room_issue_evidence_delete(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; d private.post_approval_room_issue_drafts; obj private.post_approval_issue_provider_objects; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  select draft.* into d from private.post_approval_issue_upload_operations o join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
    join private.post_approval_room_issue_drafts draft on draft.id=ad.draft_id where o.id=p_operation_id and private.post_approval_issue_executor(o.id)=actor.id;
  if d.id is null or (actor.role<>'admin' and d.reported_by_profile_id<>actor.id) then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  perform private.post_approval_issue_check_fence(p_operation_id,p_lease_version,p_fence_token_digest);
  select * into obj from private.post_approval_issue_provider_objects where operation_id=p_operation_id;
  result:=private.post_approval_issue_prepare_delete(obj.id);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;
create function public.settle_post_approval_room_issue_evidence_delete(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_fence_token_digest text,p_delete_token uuid,p_result text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; d private.post_approval_room_issue_drafts; op uuid; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  select draft.* into d from private.post_approval_issue_delete_barriers b join private.post_approval_issue_provider_objects obj on obj.id=b.object_id
    join private.post_approval_issue_upload_operations o on o.id=obj.operation_id join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
    join private.post_approval_room_issue_drafts draft on draft.id=ad.draft_id where b.delete_token=p_delete_token and private.post_approval_issue_executor(o.id)=actor.id;
  if d.id is null or (actor.role<>'admin' and d.reported_by_profile_id<>actor.id) then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  if not exists(select 1 from private.post_approval_issue_delete_barriers b join private.post_approval_issue_provider_objects obj on obj.id=b.object_id
    where b.delete_token=p_delete_token and obj.operation_id=p_operation_id) then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  perform private.post_approval_issue_check_fence(p_operation_id,p_lease_version,p_fence_token_digest);
  op:=private.post_approval_issue_settle_delete(p_delete_token,p_result);
  result:=private.post_approval_issue_operation_projection(op);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;
create function public.get_post_approval_room_issue_evidence_content(p_actor_profile_id uuid,p_session_id uuid,p_evidence_id uuid,p_revision bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; d private.post_approval_room_issue_drafts; obj private.post_approval_issue_provider_objects; o private.post_approval_issue_upload_operations; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  select draft.* into d from private.post_approval_issue_evidence_acceptances a join private.post_approval_room_issue_drafts draft on draft.id=a.draft_id where a.evidence_id=p_evidence_id and a.item_revision=p_revision;
  if d.id is null then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source_access(actor,d.source_submission_id);
  select object.* into obj from private.post_approval_issue_evidence_acceptances a join private.post_approval_issue_provider_objects object on object.id=a.object_id where a.evidence_id=p_evidence_id and a.item_revision=p_revision;
  select * into o from private.post_approval_issue_upload_operations where id=obj.operation_id;
  if obj.purged_at is not null or obj.provider_file_id is null or exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id)
    or private.post_approval_issue_delete_authority(obj.id) is not null then raise exception using errcode='55000',message='POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED'; end if;
  result:=jsonb_build_object('fileId',obj.provider_file_id,'mimeType',o.mime_type,'sizeBytes',o.size_bytes,'sha256',o.sha256);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;

create function public.get_post_approval_room_issue_draft(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_client_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority; d private.post_approval_room_issue_drafts; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source_access(actor,p_source_submission_id);
  select * into d from private.post_approval_room_issue_drafts where source_submission_id=p_source_submission_id
    and (actor.role='admin' or reported_by_profile_id=actor.id) and client_report_id=p_client_report_id for update;
  if d.id is null then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT'; end if;
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),
    'draft',private.post_approval_room_issue_draft_projection(d),
    'evidence',coalesce((select jsonb_agg(jsonb_build_object('evidenceId',id,'revision',revision,'displayOrder',display_order) order by display_order)
      from private.post_approval_issue_evidence_items where draft_id=d.id),'[]'::jsonb),
    'reportId',(select id from private.post_approval_room_issue_reports where draft_id=d.id));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;
create function public.list_post_approval_room_issue_reports(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source_access(actor,p_source_submission_id);
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),
    'reports',coalesce((select jsonb_agg(private.post_approval_issue_report_projection(reports.id)
      ||jsonb_build_object('closureRevision',case when c.report_id is null then 0 else 1 end,
        'closedAt',c.closed_at,'closedByProfileId',c.closed_by_profile_id) order by reports.reported_at desc,reports.id desc)
      from (select id,reported_at from private.post_approval_room_issue_reports where source_submission_id=p_source_submission_id
        order by reported_at desc,id desc limit 50) reports
      left join private.post_approval_issue_report_closures c on c.report_id=reports.id),'[]'::jsonb));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;
create function public.get_post_approval_room_issue_report(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source_access(actor,p_source_submission_id);
  if not exists(select 1 from private.post_approval_room_issue_reports where id=p_report_id and source_submission_id=p_source_submission_id) then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),'report',
    (select private.post_approval_issue_report_projection(r.id)
      ||jsonb_build_object('closureRevision',case when c.report_id is null then 0 else 1 end,
        'closedAt',c.closed_at,'closedByProfileId',c.closed_by_profile_id)
      from private.post_approval_room_issue_reports r
      left join private.post_approval_issue_report_closures c on c.report_id=r.id where r.id=p_report_id));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;
create function public.close_post_approval_room_issue_report(p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_report_id uuid,p_expected_closure_revision bigint,p_idempotency_key_digest text,p_request_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; report private.post_approval_room_issue_reports; closed private.post_approval_issue_report_closures;
  replay jsonb; result jsonb; at_time timestamptz; cmd constant text:='post_approval_room_issue.close';
begin
  if p_expected_closure_revision is distinct from 0::bigint or p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key_digest,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  if actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source_access(actor,p_source_submission_id);
  if replay is not null then perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id); return replay; end if;
  select * into report from private.post_approval_room_issue_reports where id=p_report_id and source_submission_id=p_source_submission_id for update;
  if report.id is null or exists(select 1 from private.post_approval_issue_report_closures where report_id=report.id) then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_REPORT_SEALED'; end if;
  at_time:=clock_timestamp();
  insert into private.post_approval_issue_report_closures(report_id,closed_by_profile_id,closed_at) values(report.id,actor.id,at_time) returning * into closed;
  result:=jsonb_build_object('reportId',report.id,'closureRevision',1,'closedAt',closed.closed_at);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('post_approval_room_issue.closed','post_approval_room_issue_report',report.id,actor.id,actor.display_name,at_time,
      jsonb_build_object('closureRevision',1),private.audit_command_key(actor.id,cmd,p_idempotency_key_digest));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  perform private.complete_command(actor.id,cmd,p_idempotency_key_digest,p_request_hash,report.id,result);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;

-- Unattended retention worker boundary, NOT human upload/finalize authority.
-- Service-only ACL + independent worker lease/fence + immutable due proof.
create function public.claim_post_approval_room_issue_purges(p_claim_digest text,p_limit integer default 10)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare obj private.post_approval_issue_provider_objects; job private.post_approval_issue_purge_jobs;
  scan private.post_approval_issue_purge_scan; items jsonb:='[]'::jsonb; at_time timestamptz; inspected integer:=0; blocked integer:=0;
begin
  if p_claim_digest is null or p_claim_digest!~'^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  select * into scan from private.post_approval_issue_purge_scan where singleton for update;
  for obj in select * from private.post_approval_issue_provider_objects where provider_file_id is not null and purged_at is null
    and provider_created_at is not null and (scan.singleton is null or row(provider_created_at,id)>row(scan.last_created_at,scan.last_object_id))
    order by provider_created_at,id limit 100 loop
    inspected:=inspected+1;
    insert into private.post_approval_issue_purge_scan(singleton,last_created_at,last_object_id) values(true,obj.provider_created_at,obj.id)
      on conflict(singleton) do update set last_created_at=excluded.last_created_at,last_object_id=excluded.last_object_id;
    if private.post_approval_issue_delete_authority(obj.id) is null then continue; end if;
    -- Newly discovered due work is eligible in this claim's captured time window.
    -- Existing jobs retain their retry schedule and lease on conflict.
    insert into private.post_approval_issue_purge_jobs(object_id,next_attempt_at)
      values(obj.id,at_time) on conflict(object_id) do nothing;
  end loop;
  if inspected=0 then delete from private.post_approval_issue_purge_scan where singleton; end if;
  for job in select * from private.post_approval_issue_purge_jobs where status in ('pending','claimed') and next_attempt_at<=at_time
    and (lease_expires_at is null or lease_expires_at<=at_time or claim_digest=p_claim_digest) order by next_attempt_at,object_id for update skip locked limit p_limit loop
    if private.post_approval_issue_delete_authority(job.object_id) is null then continue; end if;
    if job.lease_expires_at>at_time and job.claim_digest=p_claim_digest then
      items:=items||jsonb_build_array(jsonb_build_object('objectId',job.object_id,'leaseVersion',job.lease_version)); continue; end if;
    if job.lease_version>=8 then update private.post_approval_issue_purge_jobs set status='blocked',revision=revision+1 where object_id=job.object_id; blocked:=blocked+1; continue; end if;
    update private.post_approval_issue_purge_jobs set status='claimed',lease_version=lease_version+1,claim_digest=p_claim_digest,
      lease_expires_at=at_time+interval '5 minutes',revision=revision+1 where object_id=job.object_id returning * into job;
    items:=items||jsonb_build_array(jsonb_build_object('objectId',job.object_id,'leaseVersion',job.lease_version));
  end loop;
  return jsonb_build_object('items',items,'blocked',blocked);
end $$;
create function public.get_post_approval_room_issue_purge_context(p_object_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.post_approval_issue_purge_jobs; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into job from private.post_approval_issue_purge_jobs where object_id=p_object_id for update;
  if job.object_id is null or job.status<>'claimed' or job.lease_version is distinct from p_lease_version
    or job.claim_digest is distinct from p_claim_digest or job.lease_expires_at<=clock_timestamp() then raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  result:=private.post_approval_issue_prepare_delete(p_object_id);
  return result;
end $$;
create function public.settle_post_approval_room_issue_purge(p_object_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job private.post_approval_issue_purge_jobs; context jsonb; d private.post_approval_room_issue_drafts; b private.post_approval_issue_delete_barriers; at_time timestamptz;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found','retryable') then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into job from private.post_approval_issue_purge_jobs where object_id=p_object_id for update;
  if job.status='purged' and job.lease_version=p_lease_version and job.claim_digest=p_claim_digest and p_outcome in ('deleted','not_found') then return jsonb_build_object('status','purged'); end if;
  context:=public.get_post_approval_room_issue_purge_context(p_object_id,p_lease_version,p_claim_digest);
  at_time:=clock_timestamp();
  if p_outcome='retryable' then
    update private.post_approval_issue_purge_jobs set status=case when lease_version>=8 then 'blocked' else 'pending' end,
      lease_expires_at=at_time,next_attempt_at=at_time+make_interval(secs=>least(3600,30*(2^(lease_version-1))::integer)),revision=revision+1 where object_id=p_object_id;
    return jsonb_build_object('status','retryable');
  end if;
  perform private.post_approval_issue_settle_delete((context->>'deleteToken')::uuid,p_outcome);
  update private.post_approval_issue_purge_jobs set status='purged',revision=revision+1 where object_id=p_object_id;
  select * into b from private.post_approval_issue_delete_barriers where object_id=p_object_id;
  select draft.* into d from private.post_approval_issue_provider_objects obj join private.post_approval_issue_upload_operations o on o.id=obj.operation_id
    join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id join private.post_approval_room_issue_drafts draft on draft.id=ad.draft_id where obj.id=p_object_id;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_display_name_snapshot,effective_at,after_state)
    values('post_approval_room_issue.media_purged','cleaning_submission',d.source_submission_id,'typed_retention_worker',at_time,
      jsonb_build_object('reason',b.reason,'anchorAt',b.anchor_at));
  return jsonb_build_object('status','purged');
end $$;

insert into private.notification_event_catalog(event_family,category,source_entity_kind,recipient_capability,
  requires_action,push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind)
values('post_approval_room_issue.reported_admin','room_issue_reported','post_approval_room_issue_report','admin.inspection_queue',
  false,true,'none','submission','post_approval_room_issue_reported','room');
create function private.post_approval_issue_notification_valid(p_actor uuid,p_recipient uuid,p_source_id text,p_room uuid,p_target uuid,p_deep uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare r private.post_approval_room_issue_reports; d private.post_approval_room_issue_drafts; audit public.audit_events;
begin
  if current_setting('app.notification_terminal_kind',true) is distinct from 'audit_event' then return false; end if;
  select * into r from private.post_approval_room_issue_reports where id=p_source_id::uuid;
  select * into d from private.post_approval_room_issue_drafts where id=r.draft_id;
  select * into audit from public.audit_events where id=nullif(current_setting('app.notification_terminal_id',true),'')::uuid;
  return r.id is not null and d.id is not null and r.reported_by_profile_id=p_actor and audit.actor_profile_id=p_actor
    and audit.event_type='post_approval_room_issue.reported' and audit.entity_type='post_approval_room_issue_report'
    and audit.entity_id=r.id and audit.effective_at=r.reported_at
    and audit.after_state=jsonb_build_object('sourceSubmissionId',r.source_submission_id,'evidenceCount',r.evidence_count)
    and p_room=d.room_id and p_target=d.cleaning_target_id and p_deep=r.source_submission_id
    and exists(select 1 from public.profiles actor where actor.id=p_actor and actor.status='active' and not actor.must_change_password
      and (actor.role='admin' or (actor.role='maid' and exists(select 1 from private.post_approval_issue_notified_assignment(actor.id,d.cleaning_target_id)))))
    and exists(select 1 from public.profiles recipient where recipient.id=p_recipient and recipient.role='admin')
    and (select count(*) from private.post_approval_issue_report_seals where report_id=r.id)=r.evidence_count
    and not exists(select 1 from public.audit_events prior where prior.event_type=audit.event_type and prior.entity_type=audit.entity_type and prior.entity_id=r.id and prior.id<>audit.id);
exception when invalid_text_representation then return false;
end $$;
-- Extend the exact existing validator in place; preserve every older family and
-- its exact helper caller signature instead of renaming it out of the catalogue.
do $$ declare src text; def text; needle text:=E'\nbegin\n'; extension text; begin
  select prosrc into src from pg_catalog.pg_proc where oid='private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)'::regprocedure;
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 or position('post_approval_room_issue.reported_admin' in src)>0 then
    raise exception using errcode='55000',message='POST_APPROVAL_ISSUE_DEPENDENCY_DRIFT'; end if;
  extension:=needle||' if p_event_family=''post_approval_room_issue.reported_admin'' then return private.post_approval_issue_notification_valid(p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity); end if;'||E'\n';
  def:=pg_get_functiondef('private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)'::regprocedure);
  execute replace(def,src,replace(src,needle,extension));
end $$;
create function private.dispatch_post_approval_issue_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare r private.post_approval_room_issue_reports; d private.post_approval_room_issue_drafts; recipient record;
  previous_kind text:=current_setting('app.notification_terminal_kind',true); previous_id text:=current_setting('app.notification_terminal_id',true);
begin
  if new.event_type<>'post_approval_room_issue.reported' then return null; end if;
  select * into r from private.post_approval_room_issue_reports where id=new.entity_id;
  select * into d from private.post_approval_room_issue_drafts where id=r.draft_id;
  if r.id is null or d.id is null then raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID'; end if;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',new.id::text,true);
  for recipient in select id from public.profiles where role='admin' order by id loop
    perform private.emit_notification_v1('post_approval_room_issue.reported_admin',new.actor_profile_id,recipient.id,
      'post_approval_room_issue_report',r.id::text,'사후 객실 특이사항이 접수되었습니다','과거 수행 이력의 별도 신고를 확인해 주세요.',
      d.room_id,d.cleaning_target_id,r.source_submission_id,new.recorded_at);
  end loop;
  perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
  return null;
exception when others then
  perform set_config('app.notification_terminal_kind',coalesce(previous_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_id,''),true);
  raise;
end $$;
create trigger post_approval_issue_report_notification after insert on public.audit_events for each row
  when (new.event_type='post_approval_room_issue.reported') execute function private.dispatch_post_approval_issue_notification();

-- Explicit new-family protection without opening any private table/function.
create function public.admit_post_approval_room_issue_quota_refresh(p_actor_profile_id uuid,p_session_id uuid,
  p_source_submission_id uuid,p_client_report_id uuid,p_evidence_id uuid,p_expected_draft_revision bigint,p_expected_evidence_revision bigint,
  p_expected_item_revision bigint,p_idempotency_key_digest text,p_gate_request_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; d private.post_approval_room_issue_drafts; ad private.post_approval_issue_upload_admissions;
  permit private.post_approval_issue_quota_permits; lim private.photo_upload_admission_limits; at_time timestamptz; result jsonb;
begin
  if p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$' or p_gate_request_digest is null or p_gate_request_digest!~'^[0-9a-f]{64}$'
    or p_source_submission_id is null or p_client_report_id is null or p_evidence_id is null or p_expected_draft_revision is null or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_evidence_revision is null or p_expected_evidence_revision not between 0 and 9007199254740990 or p_expected_item_revision is null or p_expected_item_revision not between 0 and 9007199254740990 then
    raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id); at_time:=clock_timestamp();
  select * into ad from private.post_approval_issue_upload_admissions where actor_profile_id=actor.id and idempotency_key_digest=p_idempotency_key_digest;
  if ad.id is not null then
    select * into d from private.post_approval_room_issue_drafts where id=ad.draft_id for update;
    perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
    if row(d.client_report_id,d.source_submission_id) is distinct from row(p_client_report_id,p_source_submission_id) then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  else
    select * into d from private.post_approval_room_issue_drafts where (actor.role='admin' or reported_by_profile_id=actor.id) and client_report_id=p_client_report_id and source_submission_id=p_source_submission_id for update;
  end if;
  if d.id is null or (actor.role<>'admin' and d.reported_by_profile_id<>actor.id) then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  if ad.id is not null and row(ad.draft_id,ad.evidence_id,ad.expected_draft_revision,ad.expected_evidence_revision,ad.expected_item_revision)
    is distinct from row(d.id,p_evidence_id,p_expected_draft_revision,p_expected_evidence_revision,p_expected_item_revision)
    or exists(select 1 from private.post_approval_issue_quota_permits p where p.actor_profile_id=actor.id and p.key_digest=p_idempotency_key_digest
      and row(p.draft_id,p.evidence_id,p.expected_draft_revision,p.expected_evidence_revision,p.expected_item_revision)
        is distinct from row(d.id,p_evidence_id,p_expected_draft_revision,p_expected_evidence_revision,p_expected_item_revision)) then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  select * into permit from private.post_approval_issue_quota_permits where actor_profile_id=actor.id and gate_request_digest=p_gate_request_digest;
  if permit.id is not null and (row(permit.draft_id,permit.evidence_id,permit.expected_draft_revision,permit.expected_evidence_revision,permit.expected_item_revision,permit.key_digest)
    is distinct from row(d.id,p_evidence_id,p_expected_draft_revision,p_expected_evidence_revision,p_expected_item_revision,p_idempotency_key_digest) or permit.expires_at<=at_time) then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  if ad.id is null then
    ad.draft_id:=d.id; ad.evidence_id:=p_evidence_id; ad.expected_draft_revision:=p_expected_draft_revision;
    ad.expected_evidence_revision:=p_expected_evidence_revision; ad.expected_item_revision:=p_expected_item_revision;
    if not exists(select 1 from private.post_approval_issue_quota_permits p where p.actor_profile_id=actor.id and p.key_digest=p_idempotency_key_digest and p.expires_at>at_time)
      and private.post_approval_issue_all_inflight(actor.id,at_time)>=8 then raise exception using errcode='54000',message='PHOTO_UPLOAD_LIMIT_EXCEEDED'; end if;
  end if;
  perform private.post_approval_issue_check_quota_boundary(ad);
  if ad.id is null and private.post_approval_issue_pending_capacity(at_time)+(case when exists(
    select 1 from private.post_approval_issue_quota_permits p where p.actor_profile_id=actor.id and p.key_digest=p_idempotency_key_digest and p.expires_at>at_time)
    then 0 else 307200 end)>=12000000000 then raise exception using errcode='54000',message='PHOTO_STORAGE_QUOTA_EXCEEDED'; end if;
  if permit.id is null then
    select * into lim from private.photo_upload_admission_limits where actor_profile_id=actor.id;
    if lim.minute_started_at=date_trunc('minute',at_time) and lim.occurrence_count>=30 then raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
    insert into private.photo_upload_admission_limits values(actor.id,date_trunc('minute',at_time),1) on conflict(actor_profile_id) do update
      set minute_started_at=excluded.minute_started_at,occurrence_count=case when photo_upload_admission_limits.minute_started_at=excluded.minute_started_at then photo_upload_admission_limits.occurrence_count+1 else 1 end;
    insert into private.post_approval_issue_quota_permits(actor_profile_id,draft_id,evidence_id,expected_draft_revision,expected_evidence_revision,expected_item_revision,key_digest,gate_request_digest,created_at,expires_at)
      values(actor.id,d.id,p_evidence_id,p_expected_draft_revision,p_expected_evidence_revision,p_expected_item_revision,p_idempotency_key_digest,p_gate_request_digest,at_time,at_time+interval '5 minutes') returning * into permit;
  end if;
  result:=jsonb_build_object('permitId',permit.id,'expiresAt',permit.expires_at);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;
create function public.refresh_post_approval_room_issue_quota(p_actor_profile_id uuid,p_session_id uuid,p_permit_id uuid,p_refresh_started_at timestamptz,p_usage_bytes bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; permit private.post_approval_issue_quota_permits; d private.post_approval_room_issue_drafts;
  ad private.post_approval_issue_upload_admissions; recorded private.post_approval_issue_quota_refreshes;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  select * into permit from private.post_approval_issue_quota_permits where id=p_permit_id;
  if permit.id is null or permit.actor_profile_id<>actor.id or permit.expires_at<=clock_timestamp() then raise exception using errcode='40001',message='PHOTO_UPLOAD_ADMISSION_EXPIRED'; end if;
  select * into d from private.post_approval_room_issue_drafts where id=permit.draft_id for update;
  if d.id is null or (actor.role<>'admin' and d.reported_by_profile_id<>actor.id) then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  select * into ad from private.post_approval_issue_upload_admissions where actor_profile_id=actor.id and idempotency_key_digest=permit.key_digest;
  if ad.id is null then
    ad.draft_id:=d.id; ad.evidence_id:=permit.evidence_id; ad.expected_draft_revision:=permit.expected_draft_revision;
    ad.expected_evidence_revision:=permit.expected_evidence_revision; ad.expected_item_revision:=permit.expected_item_revision;
  end if;
  perform private.post_approval_issue_check_quota_boundary(ad);
  select * into recorded from private.post_approval_issue_quota_refreshes where permit_id=permit.id;
  if recorded.permit_id is not null then
    if row(recorded.refresh_started_at,recorded.usage_bytes) is distinct from row(p_refresh_started_at,p_usage_bytes) then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  else
    begin perform public.refresh_photo_storage_quota(p_refresh_started_at,p_usage_bytes);
    exception when check_violation or serialization_failure then raise exception using errcode='55000',message='PHOTO_STORAGE_QUOTA_UNAVAILABLE'; end;
    insert into private.post_approval_issue_quota_refreshes(permit_id,refresh_started_at,usage_bytes) values(permit.id,p_refresh_started_at,p_usage_bytes);
  end if;
  perform private.photo_quota_context(clock_timestamp());
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return jsonb_build_object('refreshed',true);
end $$;
-- Explicit takeover is separate from upload admission/body decoding. No provider
-- I/O or new object identity is allowed here; uncertain state remains uncertain.
create function public.handover_post_approval_room_issue_evidence_upload(p_actor_profile_id uuid,p_session_id uuid,
  p_operation_id uuid,p_expected_lease_version integer,p_idempotency_key_digest text,p_request_hash text,p_fence_token_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; d private.post_approval_room_issue_drafts;
  st private.post_approval_issue_upload_states; h private.post_approval_issue_upload_handovers;
  lim private.photo_upload_admission_limits; previous_actor uuid; original_actor uuid; at_time timestamptz; result jsonb;
begin
  if p_operation_id is null or p_expected_lease_version is null or p_expected_lease_version not between 0 and 7
    or p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$'
    or p_fence_token_digest is null or p_fence_token_digest!~'^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  if actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  select draft.* into d
    from private.post_approval_issue_upload_operations o join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
    join private.post_approval_room_issue_drafts draft on draft.id=ad.draft_id where o.id=p_operation_id for update of draft;
  select ad.actor_profile_id into original_actor from private.post_approval_issue_upload_operations o
    join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id where o.id=p_operation_id;
  if d.id is null then raise exception using errcode='42501',message='POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED'; end if;
  perform private.assert_post_approval_room_issue_source(actor,d.source_submission_id);
  select * into st from private.post_approval_issue_upload_states where operation_id=p_operation_id for update;
  previous_actor:=private.post_approval_issue_executor(p_operation_id);
  select * into h from private.post_approval_issue_upload_handovers where actor_profile_id=actor.id and key_digest=p_idempotency_key_digest;
  if h.operation_id is not null then
    if row(h.operation_id,h.expected_lease_version,h.request_hash,h.fence_token_digest) is distinct from
      row(p_operation_id,p_expected_lease_version,p_request_hash,p_fence_token_digest) then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    if previous_actor is distinct from actor.id or st.lease_version<h.lease_version or st.fence_token_digest is distinct from h.fence_token_digest then
      raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
    -- Receipt replay cannot extend the lease or resurrect a displaced actor.
    -- Same-fence current-executor claims may have advanced the bounded lease.
    result:=private.post_approval_issue_operation_projection(p_operation_id);
  else
    at_time:=clock_timestamp();
    if st.operation_id is null or st.status in ('accepted','compensated') or previous_actor=actor.id
      or st.lease_version<>p_expected_lease_version or st.lease_version>=8
      or st.fence_token_digest is not distinct from p_fence_token_digest then
      raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
    -- Original admission continues to account for its upload; a different current
    -- executor is additionally counted, never charged as a second storage object.
    if original_actor<>actor.id and private.post_approval_issue_all_inflight(actor.id,at_time)>=8 then
      raise exception using errcode='54000',message='PHOTO_UPLOAD_LIMIT_EXCEEDED'; end if;
    select * into lim from private.photo_upload_admission_limits where actor_profile_id=actor.id;
    if lim.minute_started_at=date_trunc('minute',at_time) and lim.occurrence_count>=30 then
      raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
    insert into private.photo_upload_admission_limits values(actor.id,date_trunc('minute',at_time),1)
      on conflict(actor_profile_id) do update set minute_started_at=excluded.minute_started_at,
      occurrence_count=case when photo_upload_admission_limits.minute_started_at=excluded.minute_started_at
        then photo_upload_admission_limits.occurrence_count+1 else 1 end;
    insert into private.post_approval_issue_upload_handovers(operation_id,lease_version,previous_actor_profile_id,actor_profile_id,
      expected_lease_version,key_digest,request_hash,fence_token_digest,occurred_at)
      values(p_operation_id,st.lease_version+1,previous_actor,actor.id,p_expected_lease_version,
        p_idempotency_key_digest,p_request_hash,p_fence_token_digest,at_time);
    update private.post_approval_issue_upload_states set lease_version=lease_version+1,fence_token_digest=p_fence_token_digest,
      lease_expires_at=at_time+interval '5 minutes',revision=revision+1,updated_at=at_time where operation_id=p_operation_id;
    result:=private.post_approval_issue_operation_projection(p_operation_id);
  end if;
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return result;
end $$;

create function private.post_approval_issue_capture_identity() returns trigger language plpgsql set search_path='' as $$
declare dig text; existing uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if new.provider_file_id is null then return new; end if;
  dig:=encode(extensions.digest(convert_to(new.provider_file_id,'UTF8'),'sha256'),'hex');
  if exists(select 1 from private.photo_provider_identity_tombstones where locator_digest=dig) then raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  insert into private.post_approval_issue_identity_tombstones(locator_digest,object_id) values(dig,new.id) on conflict(locator_digest) do nothing;
  select object_id into existing from private.post_approval_issue_identity_tombstones where locator_digest=dig;
  if existing is distinct from new.id then raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return new;
end $$;
create trigger post_approval_issue_object_tombstone after insert or update of provider_file_id on private.post_approval_issue_provider_objects
  for each row execute function private.post_approval_issue_capture_identity();
create function private.guard_post_approval_issue_folder_binding() returns trigger language plpgsql set search_path='' as $$ begin
  if not exists(select 1 from private.post_approval_issue_provider_objects o join private.photo_drive_folder_identities f
    on f.upload_date=o.upload_date and f.scope_room_number=case when new.scope='date' then '' else o.room_number end
    where o.operation_id=new.operation_id and f.id=new.folder_registry_id and f.provider_folder_id is not null
      and not exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=f.id)
      and not exists(select 1 from private.post_approval_issue_delete_barriers where object_id=o.id)) then
    raise exception using errcode='23514',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return new;
end $$;
create trigger post_approval_issue_folder_provenance before insert on private.post_approval_issue_folder_bindings
  for each row execute function private.guard_post_approval_issue_folder_binding();
do $$ declare relation record; fn record; begin
  for relation in select relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relkind='r' and c.relname like 'post_approval_issue_%' loop
    execute format('alter table private.%I enable row level security',relation.relname);
    execute format('alter table private.%I force row level security',relation.relname);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',relation.relname);
  end loop;
  for fn in select p.oid::regprocedure signature,n.nspname,p.proname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='private' and (p.proname like 'post_approval_issue_%' or p.proname like 'guard_post_approval_issue_%' or p.proname='dispatch_post_approval_issue_notification'))
      or (n.nspname='public' and p.proname like '%post_approval_room_issue%') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
    if fn.nspname='public' then execute format('grant execute on function %s to service_role',fn.signature); end if;
  end loop;
end $$;
