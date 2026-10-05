-- #329: only sessions visible at the first active -> limited transition may
-- re-enter a restricted account. No credential, raw session ID or old-row backfill.

create table private.limited_session_roots (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id),
  origin_profile_version bigint not null check (origin_profile_version > 0),
  captured_at timestamptz not null,
  unique (actor_profile_id,origin_profile_version),
  unique (id,actor_profile_id)
);
create table private.limited_session_eligibility (
  root_id uuid not null references private.limited_session_roots(id),
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  primary key (root_id,session_digest)
);
create table private.attempt_capability_session_roots (
  capability_id uuid primary key references private.attempt_capability_grants(id),
  root_id uuid not null,
  actor_profile_id uuid not null references public.profiles(id),
  foreign key (root_id,actor_profile_id) references private.limited_session_roots(id,actor_profile_id)
);
create index capability_session_roots_root_actor_idx
  on private.attempt_capability_session_roots(root_id,actor_profile_id);
create index capability_session_roots_actor_idx
  on private.attempt_capability_session_roots(actor_profile_id);

alter table private.limited_session_roots enable row level security;
alter table private.limited_session_eligibility enable row level security;
alter table private.attempt_capability_session_roots enable row level security;
revoke all on table private.limited_session_roots,private.limited_session_eligibility,
  private.attempt_capability_session_roots from public,anon,authenticated,service_role;
create trigger limited_session_roots_immutable before update or delete on private.limited_session_roots
  for each row execute function private.guard_attempt_capability_ledger();
create trigger limited_session_eligibility_immutable before update or delete on private.limited_session_eligibility
  for each row execute function private.guard_attempt_capability_ledger();
create trigger capability_session_roots_immutable before update or delete on private.attempt_capability_session_roots
  for each row execute function private.guard_attempt_capability_ledger();

create function private.guard_capability_session_root_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from private.attempt_capability_grants g where g.id=new.capability_id
    and g.actor_profile_id=new.actor_profile_id) then
    raise exception using errcode='23514',message='CAPABILITY_SESSION_ROOT_IDENTITY_INVALID'; end if;
  return new;
end $$;
revoke all on function private.guard_capability_session_root_identity() from public,anon,authenticated,service_role;
create trigger capability_session_root_identity before insert on private.attempt_capability_session_roots
  for each row execute function private.guard_capability_session_root_identity();

-- This is evidence, not a bearer secret. Domain separation prevents reuse of the
-- existing offline/grant digests. The Auth UUID never leaves this expression.
create function private.limited_session_digest(p_session uuid) returns text
language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(jsonb_build_array('limited-existing-session:v1',p_session)::text,'UTF8'),'sha256'),'hex');
$$;
create function private.current_limited_session_root(p_actor uuid) returns uuid
language sql stable set search_path='' as $$
  select r.id from private.limited_session_roots r join public.profiles p on p.id=r.actor_profile_id
  where r.actor_profile_id=p_actor and r.origin_profile_version<=p.account_lifecycle_version
  order by r.origin_profile_version desc limit 1;
$$;
create function private.capability_matches_session_root(p_capability uuid,p_actor uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from private.attempt_capability_session_roots b
    where b.capability_id=p_capability and b.actor_profile_id=p_actor
      and b.root_id=private.current_limited_session_root(p_actor));
$$;
revoke all on function private.limited_session_digest(uuid),private.current_limited_session_root(uuid),
  private.capability_matches_session_root(uuid,uuid) from public,anon,authenticated,service_role;

create function private.freeze_limited_sessions() returns trigger
language plpgsql security definer set search_path='' as $$
declare root_id uuid; captured timestamptz; eligible_count integer; binding_count integer;
begin
  if old.status<>'active' or new.status not in ('deactivation_pending','upload_only') or new.role<>'maid' then
    return new;
  end if;
  captured:=clock_timestamp();
  -- A bounded, single INSERT statement snapshot freezes only actually visible
  -- live sessions. created_at is deliberately not used: an old-timestamp row
  -- committed after this snapshot must not become eligible later.
  insert into private.limited_session_roots(actor_profile_id,origin_profile_version,captured_at)
    values(new.id,new.account_lifecycle_version,captured) returning id into root_id;
  insert into private.limited_session_eligibility(root_id,session_digest)
    select root_id,private.limited_session_digest(s.id) from auth.sessions s
    where s.user_id=new.auth_user_id and (s.not_after is null or s.not_after>captured)
    order by s.id limit 1001;
  get diagnostics eligible_count=row_count;
  if eligible_count>1000 then
    raise exception using errcode='54000',message='LIMITED_SESSION_LIMIT_EXCEEDED';
  end if;
  insert into private.attempt_capability_session_roots(capability_id,root_id,actor_profile_id)
    select g.id,root_id,new.id from private.attempt_capability_grants g
    where g.actor_profile_id=new.id and g.expires_at>captured
      and not exists(select 1 from private.attempt_capability_revocations v where v.capability_id=g.id)
      and not exists(select 1 from private.attempt_capability_session_roots b where b.capability_id=g.id)
    order by g.id limit 1001;
  get diagnostics binding_count=row_count;
  if binding_count>1000 then
    raise exception using errcode='54000',message='LIMITED_DISCOVERY_LIMIT_EXCEEDED'; end if;
  return new;
end $$;
revoke all on function private.freeze_limited_sessions() from public,anon,authenticated,service_role;
create trigger profiles_freeze_limited_sessions after update of status on public.profiles
  for each row execute function private.freeze_limited_sessions();

create function private.inherit_limited_session_root() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.profiles; root_id uuid;
begin
  select * into p from public.profiles where id=new.actor_profile_id;
  if p.role='maid' and p.status in ('deactivation_pending','upload_only') then
    root_id:=private.current_limited_session_root(p.id);
    -- Legacy restricted rows remain unbound and fail closed. Never capture or
    -- renew sessions here; finish -> upload inherits the first root verbatim.
    if root_id is not null then
      insert into private.attempt_capability_session_roots(capability_id,root_id,actor_profile_id)
        values(new.id,root_id,p.id);
    end if;
  end if;
  return new;
end $$;
revoke all on function private.inherit_limited_session_root() from public,anon,authenticated,service_role;
create trigger attempt_capability_inherit_session_root after insert on private.attempt_capability_grants
  for each row execute function private.inherit_limited_session_root();

-- Snapshot reads and fresh command checks share identical authority rules, not
-- identical clocks. The supplied clock is private; no API can choose its time.
create function private.assert_attempt_actor_session_at_clock(p_actor uuid,p_session uuid,p_admin boolean,p_at timestamptz)
returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id=p_actor;
  if p.id is null or (p_admin and (p.role<>'admin' or p.status<>'active')) then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if not p_admin and (p.role<>'maid' or p.status not in ('active','deactivation_pending','upload_only')) then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  if p.must_change_password then raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  if p_at is null or p_session is null or not exists(select 1 from auth.sessions s where s.id=p_session and s.user_id=p.auth_user_id
    and (s.not_after is null or s.not_after>p_at)) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  if p.status in ('deactivation_pending','upload_only') and not exists(
    select 1 from private.limited_session_eligibility e
    where e.root_id=private.current_limited_session_root(p.id)
      and e.session_digest=private.limited_session_digest(p_session)) then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  return p;
end $$;
revoke all on function private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)
  from public,anon,authenticated,service_role;

-- Preserve the original signature, STABLE attribute and request snapshot of
-- the six read-only public RPCs (including their PostgREST GET/HEAD contract).
-- A read result never authorizes a later mutation; that mutation checks fresh.
create or replace function private.assert_attempt_actor_session(p_actor uuid,p_session uuid,p_admin boolean)
returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare result public.profiles;
begin
  select * into result from private.assert_attempt_actor_session_at_clock(p_actor,p_session,p_admin,statement_timestamp());
  return result;
end $$;
revoke all on function private.assert_attempt_actor_session(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;

-- Explicit SPI SELECT gets a fresh snapshot inside this VOLATILE function;
-- the STABLE core uses that query snapshot and the actual post-wait clock.
create function private.assert_attempt_actor_session_fresh(p_actor uuid,p_session uuid,p_admin boolean)
returns public.profiles language plpgsql volatile security definer set search_path='' as $$
declare result public.profiles;
begin
  select * into result from private.assert_attempt_actor_session_at_clock(p_actor,p_session,p_admin,clock_timestamp());
  return result;
end $$;
revoke all on function private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;

-- Classify every installed baseline caller before introducing new direct
-- callers. Unknown/overloaded/changed source or volatility fails closed. Read
-- names alone are not a classification: five existing list RPCs are VOLATILE.
do $patch$
declare caller record; definition text; actual_callers oid[]; expected_callers oid[];
  needle constant text:='private.assert_attempt_actor_session(';
begin
  select array_agg(p.oid order by p.oid) into actual_callers
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','public') and strpos(p.prosrc,needle)>0;
  select array_agg(signature::regprocedure::oid order by signature::regprocedure::oid) into expected_callers
    from (values
      ('public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)'),
      ('public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)'),
      ('public.get_offline_event_quarantine(uuid,uuid,uuid)'),
      ('public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid)'),
      ('public.list_checkout_cleaning_templates(uuid,uuid)'),
      ('public.list_room_type_catalog(uuid,uuid)'),
      ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)'),
      ('private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)'),
      ('private.start_attempt_with_lease_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)'),
      ('private.sync_attempt_event_at(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint,timestamptz)'),
      ('private.resolve_offline_quarantine_at(uuid,uuid,uuid,text,bigint,text,text,text,timestamptz)'),
      ('private.assert_photo_upload_actor(uuid,uuid,uuid)'),
      ('public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)'),
      ('public.list_room_operation_blocks(uuid,uuid,uuid,text)'),
      ('public.list_room_issues(uuid,uuid,uuid,text)'),
      ('public.list_room_events(uuid,uuid,uuid,integer)'),
      ('public.correct_room_occupancy(uuid,uuid,uuid,uuid,boolean,timestamptz,bigint,text,text,text)'),
      ('public.override_room_display_status(uuid,uuid,uuid,text,bigint,text,text,text)'),
      ('private.cancel_unavailable_cleaning_assignment_at(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)'),
      ('public.list_room_operation_blocks_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)'),
      ('public.list_room_issues_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)')
    ) classified(signature);
  if actual_callers is distinct from expected_callers then
    raise exception 'LIMITED_SESSION_CALLER_SET_DRIFT'; end if;
  for caller in select * from (values
    ('public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)',1,'s'),
    ('public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)',1,'s'),
    ('public.get_offline_event_quarantine(uuid,uuid,uuid)',1,'s'),
    ('public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid)',1,'s'),
    ('public.list_checkout_cleaning_templates(uuid,uuid)',1,'s'),
    ('public.list_room_type_catalog(uuid,uuid)',1,'s'),
    ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)',2,'v'),
    ('private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)',2,'v'),
    ('private.start_attempt_with_lease_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)',2,'v'),
    ('private.sync_attempt_event_at(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint,timestamptz)',2,'v'),
    ('private.resolve_offline_quarantine_at(uuid,uuid,uuid,text,bigint,text,text,text,timestamptz)',2,'v'),
    ('private.assert_photo_upload_actor(uuid,uuid,uuid)',1,'v'),
    ('public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)',1,'v'),
    ('public.list_room_operation_blocks(uuid,uuid,uuid,text)',1,'v'),
    ('public.list_room_issues(uuid,uuid,uuid,text)',1,'v'),
    ('public.list_room_events(uuid,uuid,uuid,integer)',1,'v'),
    ('public.correct_room_occupancy(uuid,uuid,uuid,uuid,boolean,timestamptz,bigint,text,text,text)',1,'v'),
    ('public.override_room_display_status(uuid,uuid,uuid,text,bigint,text,text,text)',1,'v'),
    ('private.cancel_unavailable_cleaning_assignment_at(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)',1,'v'),
    ('public.list_room_operation_blocks_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)',1,'v'),
    ('public.list_room_issues_page(uuid,uuid,uuid,text,integer,timestamptz,uuid)',1,'v')
  ) classified(signature,occurrences,volatility) loop
    definition:=replace(pg_get_functiondef(caller.signature::regprocedure),E'\r\n',E'\n');
    if (select p.provolatile::text from pg_proc p where p.oid=caller.signature::regprocedure)<>caller.volatility
      or (length(definition)-length(replace(definition,needle,'')))/length(needle)<>caller.occurrences then
      raise exception 'LIMITED_SESSION_CALLER_SOURCE_DRIFT'; end if;
    if caller.volatility='v' then
      execute replace(definition,needle,'private.assert_attempt_actor_session_fresh(');
    end if;
  end loop;
end $patch$;

create or replace function private.live_attempt_capability(p_actor uuid,p_attempt uuid,p_revision bigint,p_action text,p_at timestamptz)
returns private.attempt_capability_grants language plpgsql stable set search_path='' as $$
declare g private.attempt_capability_grants%rowtype; a public.cleaning_attempts%rowtype; p public.profiles%rowtype;
begin
  select * into p from public.profiles where id=p_actor;
  select * into a from public.cleaning_attempts where id=p_attempt and maid_profile_id=p_actor and assignment_revision=p_revision;
  if a.id is null or p.id is null or p.role<>'maid' or p.status not in ('active','deactivation_pending','upload_only') then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  select c.* into g from private.attempt_capability_grants c where c.actor_profile_id=p_actor
    and c.attempt_id=p_attempt and c.assignment_id=a.assignment_id and c.assignment_revision=p_revision
    and c.issued_at<=p_at and c.expires_at>p_at and (p_action is null or p_action=any(c.allowed_actions))
    and not exists(select 1 from private.attempt_capability_revocations r where r.capability_id=c.id)
    and (p.status='active' or private.capability_matches_session_root(c.id,p_actor))
    and ((c.kind='finish_current' and p.status='deactivation_pending' and a.status='in_progress')
      or (c.kind='upload_submit' and p.status='upload_only' and a.status in ('field_completed','upload_pending'))
      or (c.kind='evidence_upload' and p.status in ('active','upload_only') and a.status='interrupted'))
    and (c.kind='evidence_upload' or exists(select 1 from public.cleaning_assignments s join public.cleaning_targets t on t.id=s.cleaning_target_id
      where s.id=a.assignment_id and s.is_current and s.notified_at is not null and s.revision=a.assignment_revision
        and t.assignment_version=s.revision and t.status<>'cancelled'))
    order by c.issued_at desc limit 1;
  if g.id is null then raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  return g;
end $$;

create function public.list_limited_cleaning_attempts(p_actor_profile_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; at_time timestamptz; items jsonb; item_count integer;
begin
  p:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor_profile_id for share;
  perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  p:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  at_time:=clock_timestamp();
  select coalesce(jsonb_agg(item order by attempt_id),'[]'),count(*) into items,item_count from (
    select a.id attempt_id,jsonb_build_object('attemptId',a.id,'assignmentId',a.assignment_id,
      'assignmentRevision',a.assignment_revision,'executionVersion',a.execution_version,'status',a.status,
      'kind',g.kind,'allowedActions',g.allowed_actions,'issuedAt',g.issued_at,'expiresAt',g.expires_at) item
    from private.attempt_capability_grants g join public.cleaning_attempts a on a.id=g.attempt_id
    where g.actor_profile_id=p.id and a.maid_profile_id=p.id and g.assignment_id=a.assignment_id
      and g.assignment_revision=a.assignment_revision and g.issued_at<=at_time and g.expires_at>at_time
      and not exists(select 1 from private.attempt_capability_revocations r where r.capability_id=g.id)
      and (p.status='active' or private.capability_matches_session_root(g.id,p.id))
      and ((g.kind='finish_current' and p.status='deactivation_pending' and a.status='in_progress')
        or (g.kind='upload_submit' and p.status='upload_only' and a.status in ('field_completed','upload_pending'))
        or (g.kind='evidence_upload' and p.status in ('active','upload_only') and a.status='interrupted'))
      and (g.kind='evidence_upload' or exists(select 1 from public.cleaning_assignments s
        join public.cleaning_targets t on t.id=s.cleaning_target_id where s.id=a.assignment_id
          and s.is_current and s.notified_at is not null and s.revision=a.assignment_revision
          and t.assignment_version=s.revision and t.status<>'cancelled'))
    order by a.id limit 1001
  ) bounded;
  if item_count>1000 then raise exception using errcode='54000',message='LIMITED_DISCOVERY_LIMIT_EXCEEDED'; end if;
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  return jsonb_build_object('profileStatus',p.status,'evaluatedAt',at_time,'items',items);
end $$;
revoke all on function public.list_limited_cleaning_attempts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_limited_cleaning_attempts(uuid,uuid) to service_role;

-- Keep the current notification/evidence/submission implementation byte for
-- byte except the explicit session argument, ordered pre-lock checks and fresh
-- final guard. No caller-controlled GUC carries authentication context.
do $patch$
declare definition text; old_fragment text; new_fragment text;
begin
  definition:=replace(pg_get_functiondef('public.create_cleaning_submission(uuid,uuid,uuid,bigint,integer,text,text)'::regprocedure),E'\r\n',E'\n');
  old_fragment:='public.create_cleaning_submission(p_actor_profile_id uuid, p_attempt_id uuid,';
  new_fragment:='private.create_cleaning_submission_session_core(p_actor_profile_id uuid, p_session_id uuid, p_attempt_id uuid,';
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'LIMITED_SUBMISSION_SIGNATURE_DRIFT'; end if;
  definition:=replace(definition,old_fragment,new_fragment);
  old_fragment:='replay jsonb; result jsonb; sid uuid; next_version integer; v_report_id uuid; at_time timestamptz:=clock_timestamp();';
  new_fragment:='replay jsonb; result jsonb; sid uuid; next_version integer; v_report_id uuid; at_time timestamptz; limited_expires timestamptz;';
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'LIMITED_SUBMISSION_DECLARATION_DRIFT'; end if;
  definition:=replace(definition,old_fragment,new_fragment);
  old_fragment:=E'  replay:=private.replay_command(p_actor_profile_id,\'submission.create\',p_idempotency_key,p_request_hash);\n  a:=private.submission_receipt_actor(p_actor_profile_id,p_attempt_id);\n  if replay is not null then return replay; end if;';
  new_fragment:=$body$
  if p_session_id is not null then
    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  else
    if not exists(select 1 from public.profiles where id=p_actor_profile_id and role='maid'
      and status='active' and not must_change_password) then
      raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED'; end if;
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode='22023',message='INVALID_IDEMPOTENCY_KEY'; end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_REQUEST_HASH'; end if;
  -- Match the established receipt -> global -> profile -> session -> attempt
  -- order. Acquiring profile before inner replay/global would deadlock.
  perform pg_advisory_xact_lock(hashtextextended(p_actor_profile_id::text||':submission.create:'||p_idempotency_key,0));
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor_profile_id for no key update;
  if p_session_id is not null then
    perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
    if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  end if;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  if p_session_id is not null then
    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
    if p.status in ('deactivation_pending','upload_only') and not exists(
      select 1 from private.attempt_capability_grants g where g.attempt_id=p_attempt_id and g.actor_profile_id=p_actor_profile_id
        and private.capability_matches_session_root(g.id,p_actor_profile_id)) then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  elsif p.id is null or p.role<>'maid' or p.status<>'active' or p.must_change_password then
    raise exception using errcode='42501',message='SUBMISSION_ACCESS_REQUIRED';
  end if;
  a:=private.submission_receipt_actor(p_actor_profile_id,p_attempt_id);
  replay:=private.replay_command(p_actor_profile_id,'submission.create',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
$body$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'LIMITED_SUBMISSION_REPLAY_DRIFT'; end if;
  definition:=replace(definition,old_fragment,new_fragment);
  old_fragment:='  if not private.photo_attempt_complete(a.id,at_time) then';
  new_fragment:=$body$
  at_time:=clock_timestamp();
  if p_session_id is not null then
    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
    if p.status<>'active' then
      limited_expires:=(private.live_attempt_capability(p_actor_profile_id,a.id,a.assignment_revision,'submit',at_time)).expires_at;
    end if;
  end if;
  if not private.photo_attempt_complete(a.id,at_time) then
$body$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'LIMITED_SUBMISSION_PHOTO_DRIFT'; end if;
  definition:=replace(definition,old_fragment,new_fragment);
  old_fragment:='  perform private.complete_command(p_actor_profile_id,''submission.create'',p_idempotency_key,p_request_hash,sid,result);';
  new_fragment:=$body$
  if p_session_id is not null then
    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
    if limited_expires is not null and limited_expires<=clock_timestamp() then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  end if;
  perform private.complete_command(p_actor_profile_id,'submission.create',p_idempotency_key,p_request_hash,sid,result);
  if p_session_id is not null then
    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
    if limited_expires is not null and limited_expires<=clock_timestamp() then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  end if;
$body$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'LIMITED_SUBMISSION_COMMIT_DRIFT'; end if;
  definition:=replace(definition,old_fragment,new_fragment);
  execute definition;
end $patch$;
revoke all on function private.create_cleaning_submission_session_core(uuid,uuid,uuid,uuid,bigint,integer,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.create_cleaning_submission(
  p_actor_profile_id uuid,p_attempt_id uuid,p_client_submission_id uuid,p_expected_revision bigint,
  p_candle_count integer,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return private.create_cleaning_submission_session_core(p_actor_profile_id,null,p_attempt_id,p_client_submission_id,
    p_expected_revision,p_candle_count,p_idempotency_key,p_request_hash);
end
$$;
create function public.create_cleaning_submission_with_session(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_client_submission_id uuid,p_expected_revision bigint,
  p_candle_count integer,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_session_id is null then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  return private.create_cleaning_submission_session_core(p_actor_profile_id,p_session_id,p_attempt_id,p_client_submission_id,
    p_expected_revision,p_candle_count,p_idempotency_key,p_request_hash);
end $$;
revoke all on function public.create_cleaning_submission_with_session(uuid,uuid,uuid,uuid,bigint,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.create_cleaning_submission_with_session(uuid,uuid,uuid,uuid,bigint,integer,text,text)
  to service_role;

create function public.get_photo_upload_receipt_with_session(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles; o private.photo_upload_operations; s private.photo_upload_states; a public.cleaning_attempts;
begin
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  -- Read-only receipt: no provider work, grant issuance, CAS or idempotent write.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor_profile_id for no key update;
  perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into o from private.photo_upload_operations where id=p_operation_id and actor_profile_id=p.id;
  select * into a from public.cleaning_attempts where id=o.cleaning_attempt_id;
  if o.id is null or a.id is null or a.maid_profile_id<>p.id or a.assignment_id<>o.assignment_id
    or a.assignment_revision<>o.assignment_revision then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  select * into s from private.photo_upload_states where operation_id=o.id for share;
  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);
  if p.status<>'active' and not exists(select 1 from private.attempt_capability_grants g
    where g.attempt_id=a.id and g.actor_profile_id=p.id and g.assignment_id=a.assignment_id
      and g.assignment_revision=a.assignment_revision and private.capability_matches_session_root(g.id,p.id)) then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  -- Historical accepted receipts survive TTL/inspection transitions; new work
  -- still goes through the live capability guard. Revoked/expired sessions never
  -- converge an HTTP result, including an already accepted provider operation.
  if s.status<>'accepted' or not exists(select 1 from private.photo_upload_acceptances where operation_id=o.id) then
    raise exception using errcode='55000',message='PHOTO_PROVIDER_RESULT_REQUIRED'; end if;
  return private.photo_upload_projection(o.id);
end $$;
revoke all on function public.get_photo_upload_receipt_with_session(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_photo_upload_receipt_with_session(uuid,uuid,uuid) to service_role;

create function private.assert_photo_operation_session(p_actor uuid,p_session uuid,p_operation uuid) returns void
language plpgsql set search_path='' as $$
declare operation private.photo_upload_operations;
begin
  select * into operation from private.photo_upload_operations where id=p_operation and actor_profile_id=p_actor;
  if operation.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor,p_session,operation.cleaning_attempt_id);
end $$;
revoke all on function private.assert_photo_operation_session(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Surgical post-lock clock checks preserve all existing transitions, receipts,
-- version fences and typed notification writers. Drift fails migration closed.
do $patch$
declare patch record; definition text;
begin
  for patch in select * from (values
    ('private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)',
      '  at_time:=coalesce(p_command_at,clock_timestamp());',
      E'  at_time:=coalesce(p_command_at,clock_timestamp());\n  p:=private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);'),
    ('private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)',
      '  perform private.complete_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash,a.id,result);',
      E'  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);\n  if g.expires_at<=coalesce(p_command_at,clock_timestamp()) then\n    raise exception using errcode=\'42501\',message=\'CAPABILITY_ACCESS_REQUIRED\'; end if;\n  perform private.complete_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash,a.id,result);\n  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,false);\n  if g.expires_at<=clock_timestamp() then\n    raise exception using errcode=\'42501\',message=\'CAPABILITY_ACCESS_REQUIRED\'; end if;'),
    ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)',
      E'  select * into a from public.cleaning_attempts where id=p_attempt_id for update;\n  at_time:=coalesce(p_command_at,clock_timestamp());',
      E'  select * into a from public.cleaning_attempts where id=p_attempt_id for update;\n  at_time:=coalesce(p_command_at,clock_timestamp());\n  perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);'),
    ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)',
      E'    perform pg_advisory_xact_lock(hashtextextended(\'availability:\'||next_maid::text||\':\'||wk::text,0));\n    at_time:=coalesce(p_command_at,clock_timestamp());',
      E'    perform pg_advisory_xact_lock(hashtextextended(\'availability:\'||next_maid::text||\':\'||wk::text,0));\n    at_time:=coalesce(p_command_at,clock_timestamp());\n    perform private.assert_attempt_actor_session_fresh(p_actor_profile_id,p_session_id,true);'),
    ('private.assert_photo_upload_actor(uuid,uuid,uuid)',
      '  a:=private.assert_photo_model_actor(p_actor,p_attempt,''upload_evidence'');',
      E'  a:=private.assert_photo_model_actor(p_actor,p_attempt,\'upload_evidence\');\n  perform private.assert_attempt_actor_session_fresh(p_actor,p_session,false);'),
    ('public.claim_photo_upload(uuid,uuid,uuid,text)',
      '  at_time:=clock_timestamp();',
      E'  at_time:=clock_timestamp();\n  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);'),
    ('public.finalize_photo_upload(uuid,uuid,uuid,integer,text)',
      '  at_time := clock_timestamp();',
      E'  at_time := clock_timestamp();\n  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);'),
    ('private.submission_actor(uuid,uuid)',
      '  select * into a from public.cleaning_attempts where id=p_attempt for update;',
      E'  select * into a from public.cleaning_attempts where id=p_attempt for update;\n  at_time:=clock_timestamp();')
  ) changes(signature,needle,replacement) loop
    definition:=replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
    if (length(definition)-length(replace(definition,patch.needle,'')))/length(patch.needle)<>1 then
      raise exception 'LIMITED_POST_LOCK_SOURCE_DRIFT'; end if;
    execute replace(definition,patch.needle,patch.replacement);
  end loop;
end $patch$;

-- Provider/state/collection/quota rows can be held by credentialless workers.
-- Re-check at each source-controlled return after those waits, not merely before
-- the first profile lock. Raised denials roll back any intervening writes.
do $patch$
declare patch record; definition text; guard text;
begin
  for patch in select * from (values
    ('public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)',
      'return private.photo_upload_projection(o.id);',2,'attempt','p_attempt_id'),
    ('public.claim_photo_upload(uuid,uuid,uuid,text)',
      'return private.photo_upload_projection(o.id);',3,'operation','p_operation_id'),
    ('public.finalize_photo_upload(uuid,uuid,uuid,integer,text)',
      'return private.photo_upload_projection(o.id);',2,'operation','p_operation_id'),
    ('public.admit_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text)',
      'return jsonb_build_object(''admissionId'',ad.id,',1,'attempt','p_attempt_id'),
    ('public.begin_admitted_photo_upload(uuid,uuid,uuid,text,text,integer,text,text)',
      'return result;',1,'attempt','ad.cleaning_attempt_id'),
    ('public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
      'return jsonb_build_object(',1,'attempt','p_attempt_id'),
    ('public.begin_admitted_photo_collection_upload(uuid,uuid,uuid,text,text,integer,text,text)',
      'return private.photo_upload_projection(existing.id);',1,'attempt','ad.cleaning_attempt_id'),
    ('public.begin_admitted_photo_collection_upload(uuid,uuid,uuid,text,text,integer,text,text)',
      'return private.photo_upload_projection(op.id);',1,'attempt','ad.cleaning_attempt_id'),
    ('public.delete_photo_collection_item(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text,text)',
      'return receipt.response_payload;',1,'attempt','p_attempt_id'),
    ('public.delete_photo_collection_item(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text,text)',
      'return result;',1,'attempt','p_attempt_id'),
    ('public.get_photo_provider_context(uuid,uuid,uuid,integer,text)',
      'return jsonb_build_object(''operationId'',o.id,',1,'operation','p_operation_id'),
    ('public.reserve_photo_drive_folder(uuid,uuid,uuid,integer,text,text,text,text)',
      'return jsonb_build_object(''scope'',p_scope,',1,'operation','p_operation_id')
  ) changes(signature,needle,occurrences,kind,argument) loop
    definition:=replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
    if (length(definition)-length(replace(definition,patch.needle,'')))/length(patch.needle)<>patch.occurrences then
      raise exception 'LIMITED_PHOTO_FINAL_SOURCE_DRIFT'; end if;
    guard:=case when patch.kind='operation' then 'private.assert_photo_operation_session'
      else 'private.assert_photo_upload_actor' end;
    execute replace(definition,patch.needle,format('perform %s(p_actor_profile_id,p_session_id,%s);%s  %s',
      guard,patch.argument,E'\n',patch.needle));
  end loop;
end $patch$;

-- The final installed matrix must contain exactly the six snapshot RPCs and
-- eighteen direct fresh callers. Photo operation guards inherit freshness via
-- assert_photo_upload_actor and are not miscounted as direct session callers.
do $verify$
declare classification record; caller record; actual_names text[]; expected_names text[]; source text;
begin
  for classification in select * from (values
    ('private.assert_attempt_actor_session(',array[
      'public.get_limited_cleaning_attempt','public.get_cleaning_attempt_lifecycle_impact',
      'public.get_offline_event_quarantine','public.list_offline_event_quarantine',
      'public.list_checkout_cleaning_templates','public.list_room_type_catalog']::text[]),
    ('private.assert_attempt_actor_session_fresh(',array[
      'private.manage_cleaning_attempt_lifecycle_at','private.complete_limited_attempt_at',
      'private.start_attempt_with_lease_at','private.sync_attempt_event_at','private.resolve_offline_quarantine_at',
      'private.assert_photo_upload_actor','public.publish_checkout_cleaning_template',
      'public.list_room_operation_blocks','public.list_room_issues','public.list_room_events',
      'public.correct_room_occupancy','public.override_room_display_status',
      'private.cancel_unavailable_cleaning_assignment_at','public.list_room_operation_blocks_page',
      'public.list_room_issues_page','public.list_limited_cleaning_attempts',
      'private.create_cleaning_submission_session_core','public.get_photo_upload_receipt_with_session']::text[]),
    ('private.assert_attempt_actor_session_at_clock(',array[
      'private.assert_attempt_actor_session','private.assert_attempt_actor_session_fresh']::text[])
  ) matrix(needle,names) loop
    select array_agg(name order by name) into expected_names from unnest(classification.names) expected(name);
    select array_agg(n.nspname||'.'||p.proname order by n.nspname,p.proname) into actual_names
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and strpos(p.prosrc,classification.needle)>0;
    if actual_names is distinct from expected_names then
      raise exception 'LIMITED_SESSION_FINAL_CALLER_DRIFT'; end if;
  end loop;
  for caller in select * from (values
    ('public.get_limited_cleaning_attempt',1,'s'),
    ('public.get_cleaning_attempt_lifecycle_impact',1,'s'),
    ('public.get_offline_event_quarantine',1,'s'),
    ('public.list_offline_event_quarantine',1,'s'),
    ('public.list_checkout_cleaning_templates',1,'s'),
    ('public.list_room_type_catalog',1,'s'),
    ('private.manage_cleaning_attempt_lifecycle_at',4,'v'),
    ('private.complete_limited_attempt_at',5,'v'),
    ('private.start_attempt_with_lease_at',2,'v'),
    ('private.sync_attempt_event_at',2,'v'),
    ('private.resolve_offline_quarantine_at',2,'v'),
    ('private.assert_photo_upload_actor',2,'v'),
    ('public.publish_checkout_cleaning_template',1,'v'),
    ('public.list_room_operation_blocks',1,'v'),
    ('public.list_room_issues',1,'v'),
    ('public.list_room_events',1,'v'),
    ('public.correct_room_occupancy',1,'v'),
    ('public.override_room_display_status',1,'v'),
    ('private.cancel_unavailable_cleaning_assignment_at',1,'v'),
    ('public.list_room_operation_blocks_page',1,'v'),
    ('public.list_room_issues_page',1,'v'),
    ('public.list_limited_cleaning_attempts',3,'v'),
    ('private.create_cleaning_submission_session_core',5,'v'),
    ('public.get_photo_upload_receipt_with_session',2,'v')
  ) matrix(name,occurrences,volatility) loop
    select p.prosrc into strict source from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname||'.'||p.proname=caller.name and p.provolatile::text=caller.volatility;
    if (length(source)-length(replace(source,case when caller.volatility='s'
      then 'private.assert_attempt_actor_session(' else 'private.assert_attempt_actor_session_fresh(' end,'')))
      /length(case when caller.volatility='s' then 'private.assert_attempt_actor_session('
        else 'private.assert_attempt_actor_session_fresh(' end)<>caller.occurrences then
      raise exception 'LIMITED_SESSION_FINAL_SOURCE_DRIFT'; end if;
  end loop;
end $verify$;
