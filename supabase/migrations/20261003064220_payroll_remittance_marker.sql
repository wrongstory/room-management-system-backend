-- #331: external remittance DISPLAY axis, never an actual payment command.
-- Applied migrations and all financial tables/functions are deliberately left
-- unchanged. Runtime roles have neither raw table nor private helper access.
create function private.valid_payroll_remittance_basis(p_basis jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare item record; amount numeric;
begin
  if p_basis is null or jsonb_typeof(p_basis)<>'object' or
    (select array_agg(key order by key) from jsonb_object_keys(p_basis) key) is distinct from
    array['accrualAmount','adjustmentAmount','carryInAmount','carryOutAmount','lateEarningAmount',
      'lockedAmount','payableAmount','totalAmount']::text[] then return false; end if;
  for item in select e.key,e.value from jsonb_each(p_basis) e loop
    if item.key='lockedAmount' and item.value='null'::jsonb then continue; end if;
    if jsonb_typeof(item.value)<>'number' then return false; end if;
    amount:=(item.value#>>'{}')::numeric;
    if amount<>trunc(amount) or abs(amount)>9007199254740991 then return false; end if;
    if item.key in ('accrualAmount','totalAmount','lateEarningAmount') and amount<0 then return false; end if;
    if item.key in ('carryInAmount','carryOutAmount') and amount>0 then return false; end if;
    if item.key='lockedAmount' and amount<=0 then return false; end if;
  end loop;
  return true;
end $$;
revoke all on function private.valid_payroll_remittance_basis(jsonb) from public,anon,authenticated,service_role;

create function private.payroll_remittance_basis(p_maid uuid,p_week date)
returns jsonb language sql stable set search_path='' as $$
  with projected as (select private.project_payroll_cycle_bounded(p_week,p_maid,1) value)
  select jsonb_build_object('accrualAmount',value->'accrualAmount','totalAmount',value->'totalAmount',
    'adjustmentAmount',value->'adjustmentAmount','carryInAmount',value->'carryInAmount',
    'carryOutAmount',value->'carryOutAmount','payableAmount',value->'payableAmount',
    'lateEarningAmount',value->'lateEarningAmount','lockedAmount',value->'lockedAmount') from projected
$$;
revoke all on function private.payroll_remittance_basis(uuid,date) from public,anon,authenticated,service_role;

create function private.payroll_remittance_fingerprint(p_basis jsonb)
returns text language sql immutable set search_path='' as $$
  -- lockedAmount is redundant lock metadata, not an economic amount change.
  -- Payable already includes the exact locked amount once a cycle is frozen.
  select encode(extensions.digest('payroll-remittance-basis:v1:'||(p_basis-'lockedAmount')::text,'sha256'),'hex')
$$;
revoke all on function private.payroll_remittance_fingerprint(jsonb) from public,anon,authenticated,service_role;

create table private.payroll_remittance_markers (
  id uuid primary key default gen_random_uuid(),
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  week_start date not null check(isfinite(week_start) and extract(year from week_start) between 1 and 9999
    and extract(isodow from week_start)=1),
  version bigint not null check(version between 1 and 9007199254740991),
  marked boolean not null,
  current_revision_id uuid not null,
  last_changed_revision_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(maid_profile_id,week_start),
  unique(id,maid_profile_id,week_start)
);
create table private.payroll_remittance_marker_revisions (
  id uuid primary key default gen_random_uuid(),
  marker_id uuid not null,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  week_start date not null check(isfinite(week_start) and extract(year from week_start) between 1 and 9999
    and extract(isodow from week_start)=1),
  version bigint not null check(version between 1 and 9007199254740991),
  event_type text not null check(event_type in ('marked','cleared','reconfirmed')),
  marked boolean not null,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  occurred_at timestamptz not null,
  basis jsonb not null check(private.valid_payroll_remittance_basis(basis)),
  basis_fingerprint text not null check(basis_fingerprint=private.payroll_remittance_fingerprint(basis)),
  check(marked=(event_type in ('marked','reconfirmed'))),
  unique(maid_profile_id,week_start,version),
  unique(id,marker_id,maid_profile_id,week_start),
  unique(id,marker_id,maid_profile_id,week_start,version,marked),
  foreign key(marker_id,maid_profile_id,week_start)
    references private.payroll_remittance_markers(id,maid_profile_id,week_start)
    on delete restrict deferrable initially deferred
);
alter table private.payroll_remittance_markers add constraint payroll_remittance_current_revision_fk
  foreign key(current_revision_id,id,maid_profile_id,week_start,version,marked)
  references private.payroll_remittance_marker_revisions(id,marker_id,maid_profile_id,week_start,version,marked)
  on delete restrict deferrable initially deferred;
alter table private.payroll_remittance_markers add constraint payroll_remittance_last_changed_revision_fk
  foreign key(last_changed_revision_id,id,maid_profile_id,week_start)
  references private.payroll_remittance_marker_revisions(id,marker_id,maid_profile_id,week_start)
  on delete restrict deferrable initially deferred;
-- Existing unique indexes cover maid/week history keyset and maid-profile FKs.
-- Cover each complete child FK tuple as leading key columns, not only its first
-- identity column. Revision version remains a suffix after the immutable tuple.
create index payroll_remittance_revisions_marker_idx
  on private.payroll_remittance_marker_revisions(marker_id,maid_profile_id,week_start,version);
create index payroll_remittance_revisions_actor_idx on private.payroll_remittance_marker_revisions(actor_profile_id);
create index payroll_remittance_current_revision_idx
  on private.payroll_remittance_markers(current_revision_id,id,maid_profile_id,week_start,version,marked);
create index payroll_remittance_last_changed_idx
  on private.payroll_remittance_markers(last_changed_revision_id,id,maid_profile_id,week_start);
alter table private.payroll_remittance_markers enable row level security;
alter table private.payroll_remittance_marker_revisions enable row level security;
revoke all on private.payroll_remittance_markers,private.payroll_remittance_marker_revisions
  from public,anon,authenticated,service_role;

create function private.guard_payroll_remittance_current()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_DELETE_FORBIDDEN';
  end if;
  if tg_op='UPDATE' and (new.id<>old.id or new.maid_profile_id<>old.maid_profile_id
    or new.week_start<>old.week_start or new.created_at<>old.created_at
    or new.version<>old.version+1 or new.updated_at<old.updated_at) then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION';
  end if;
  return new;
end $$;
create trigger payroll_remittance_current_guard before update or delete on private.payroll_remittance_markers
  for each row execute function private.guard_payroll_remittance_current();

create function private.guard_payroll_remittance_revision()
returns trigger language plpgsql set search_path='' as $$
declare previous private.payroll_remittance_marker_revisions;
begin
  if tg_op<>'INSERT' then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_HISTORY_IMMUTABLE';
  end if;
  select * into previous from private.payroll_remittance_marker_revisions
    where marker_id=new.marker_id order by version desc limit 1;
  if (previous.id is null and (new.version<>1 or new.event_type<>'marked'))
    or (previous.id is not null and (new.version<>previous.version+1
      or new.maid_profile_id<>previous.maid_profile_id or new.week_start<>previous.week_start
      or new.occurred_at<previous.occurred_at
      or (new.event_type='marked' and previous.marked)
      or (new.event_type in ('cleared','reconfirmed') and not previous.marked)
      or (new.event_type='reconfirmed' and new.basis_fingerprint=previous.basis_fingerprint))) then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION';
  end if;
  return new;
end $$;
create trigger payroll_remittance_revision_guard before insert or update or delete
  on private.payroll_remittance_marker_revisions for each row
  execute function private.guard_payroll_remittance_revision();

create function private.assert_payroll_remittance_lineage(p_marker uuid)
returns void language plpgsql set search_path='' as $$
declare current_row private.payroll_remittance_markers;
  latest private.payroll_remittance_marker_revisions;
  changed private.payroll_remittance_marker_revisions;
  revisions bigint;
begin
  select * into current_row from private.payroll_remittance_markers where id=p_marker;
  select * into latest from private.payroll_remittance_marker_revisions
    where marker_id=p_marker order by version desc limit 1;
  select * into changed from private.payroll_remittance_marker_revisions
    where marker_id=p_marker and event_type in ('marked','cleared') order by version desc limit 1;
  select count(*) into revisions from private.payroll_remittance_marker_revisions where marker_id=p_marker;
  if current_row.id is null or latest.id is null or changed.id is null
    or current_row.current_revision_id<>latest.id or current_row.last_changed_revision_id<>changed.id
    or current_row.version<>latest.version or current_row.version<>revisions
    or current_row.marked<>latest.marked or current_row.updated_at<>latest.occurred_at
    or current_row.created_at is distinct from (select occurred_at from private.payroll_remittance_marker_revisions
      where marker_id=p_marker and version=1) then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION';
  end if;
end $$;
create function private.check_payroll_remittance_lineage()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Trigger records have different row types; branch before resolving a field.
  if tg_table_name='payroll_remittance_markers' then
    perform private.assert_payroll_remittance_lineage(new.id);
  else
    perform private.assert_payroll_remittance_lineage(new.marker_id);
  end if;
  return null;
end $$;
create constraint trigger payroll_remittance_current_lineage after insert or update
  on private.payroll_remittance_markers deferrable initially deferred
  for each row execute function private.check_payroll_remittance_lineage();
create constraint trigger payroll_remittance_history_lineage after insert
  on private.payroll_remittance_marker_revisions deferrable initially deferred
  for each row execute function private.check_payroll_remittance_lineage();
revoke all on function private.guard_payroll_remittance_current(),private.guard_payroll_remittance_revision(),
  private.assert_payroll_remittance_lineage(uuid),private.check_payroll_remittance_lineage()
  from public,anon,authenticated,service_role;

create function private.assert_payroll_remittance_reader(
  p_actor uuid,p_session uuid,p_expected_role text,p_maid uuid,p_week date
) returns public.profiles language plpgsql stable set search_path='' as $$
declare actor public.profiles; evaluated_at timestamptz:=statement_timestamp();
begin
  select * into actor from public.profiles where id=p_actor;
  if actor.id is null or actor.role not in ('admin','maid') or actor.status<>'active'
    or p_expected_role is null or actor.role::text is distinct from p_expected_role then
    raise exception using errcode='42501',message='PAYROLL_ACCESS_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  if p_session is null or not exists(select 1 from auth.sessions s where s.id=p_session
    and s.user_id=actor.auth_user_id and (s.not_after is null or s.not_after>evaluated_at)) then
    raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  if actor.role='maid' and p_maid is distinct from actor.id then
    raise exception using errcode='42501',message='PAYROLL_ACCESS_REQUIRED'; end if;
  if not exists(select 1 from public.profiles where id=p_maid and role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND'; end if;
  if p_week is null or not isfinite(p_week) or extract(year from p_week) not between 1 and 9999 then
    raise exception using errcode='22023',message='PAYROLL_WEEK_MUST_START_MONDAY'; end if;
  perform private.assert_readable_payroll_week(p_week);
  return actor;
end $$;
revoke all on function private.assert_payroll_remittance_reader(uuid,uuid,text,uuid,date)
  from public,anon,authenticated,service_role;

create function private.payroll_remittance_projection(p_maid uuid,p_week date,p_basis jsonb,p_role text)
returns jsonb language plpgsql stable set search_path='' as $$
declare marker private.payroll_remittance_markers; revision private.payroll_remittance_marker_revisions;
  changed private.payroll_remittance_marker_revisions; needs boolean:=false; blocked text;
begin
  if not private.valid_payroll_remittance_basis(p_basis) then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_BASIS_INVARIANT_VIOLATION'; end if;
  select * into marker from private.payroll_remittance_markers where maid_profile_id=p_maid and week_start=p_week;
  if marker.id is not null then
    select * into revision from private.payroll_remittance_marker_revisions where id=marker.current_revision_id;
    select * into changed from private.payroll_remittance_marker_revisions where id=marker.last_changed_revision_id;
    if revision.id is null or changed.id is null then
      raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION'; end if;
    needs:=marker.marked and revision.basis_fingerprint<>private.payroll_remittance_fingerprint(p_basis);
  end if;
  if p_role<>'admin' then blocked:='ADMIN_REQUIRED';
  elsif p_week>=date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date then
    blocked:='PAYROLL_WEEK_NOT_CLOSED';
  elsif coalesce((p_basis->>'lockedAmount')::bigint,(p_basis->>'payableAmount')::bigint)<=0 then
    blocked:='NO_PAYROLL_AMOUNT';
  end if;
  return jsonb_build_object('maidProfileId',p_maid,'weekStart',to_char(p_week,'YYYY-MM-DD'),
    'marked',coalesce(marker.marked,false),'version',coalesce(marker.version,0),
    'lastChangedBy',changed.actor_profile_id,'lastChangedAt',changed.occurred_at,
    'confirmedBy',case when marker.marked then revision.actor_profile_id end,
    'confirmedAt',case when marker.marked then revision.occurred_at end,
    'needsReconfirmation',needs,'basis',p_basis,
    'confirmedBasis',case when marker.marked then revision.basis else null end,
    'basisFingerprint',private.payroll_remittance_fingerprint(p_basis),
    'canSet',blocked is null,'canClear',p_role='admin' and coalesce(marker.marked,false),
    'canReconfirm',p_role='admin' and coalesce(marker.marked,false) and needs,'setBlockedReason',blocked);
end $$;
revoke all on function private.payroll_remittance_projection(uuid,date,jsonb,text)
  from public,anon,authenticated,service_role;

create function public.get_payroll_remittance_marker(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_actor_role text,p_maid_profile_id uuid,p_week_start date
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
  actor:=private.assert_payroll_remittance_reader(p_actor_profile_id,p_session_id,
    p_expected_actor_role,p_maid_profile_id,p_week_start);
  return private.payroll_remittance_projection(p_maid_profile_id,p_week_start,
    private.payroll_remittance_basis(p_maid_profile_id,p_week_start),actor.role::text);
end $$;

create function private.command_payroll_remittance_marker(
  p_actor uuid,p_session uuid,p_expected_role text,p_maid uuid,p_week date,p_action text,p_marked boolean,
  p_expected_version bigint,p_expected_fingerprint text,p_key text,p_hash text
) returns jsonb language plpgsql set search_path='' as $$
declare actor public.profiles; replay jsonb; basis jsonb; result jsonb;
  marker private.payroll_remittance_markers; revision private.payroll_remittance_marker_revisions;
  command text; now_at timestamptz; session_deadline timestamptz; session_found boolean;
  event_kind text; marker_id uuid; new_version bigint; old_marked boolean;
begin
  command:=case when p_action='set' then 'payroll.remittance.set'
    when p_action='reconfirm' then 'payroll.remittance.reconfirm' end;
  if command is null then raise exception using errcode='22023',message='PAYROLL_REMITTANCE_ACTION_INVALID'; end if;
  -- Reject unauthorized requests before the receipt's payload-hash comparison;
  -- recheck under the canonical locks after every possible receipt/global wait.
  select * into actor from public.profiles where id=p_actor;
  if actor.id is null or actor.role<>'admin' or actor.status<>'active'
    or p_expected_role is distinct from 'admin' then
    raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  if p_session is null or not exists(select 1 from auth.sessions s where s.id=p_session
    and s.user_id=actor.auth_user_id and (s.not_after is null or s.not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  -- Take the exact receipt helper's lock first, without comparing a stored
  -- payload until latest authorization has been rechecked after the wait.
  if p_key is null or p_key!~'^[A-Za-z0-9._:-]{8,128}$' then
    raise exception using errcode='22023',message='INVALID_IDEMPOTENCY_KEY'; end if;
  if p_hash is null or p_hash!~'^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_REQUEST_HASH'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||command||':'||p_key,0));
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  -- Same ordered profile lock family as handover: never lock an actor before
  -- the global fence, or a target profile before a lower UUID actor.
  perform 1 from public.profiles where id in (p_actor,p_maid) order by id for no key update;
  select * into actor from public.profiles where id=p_actor;
  if actor.id is null or actor.role<>'admin' or actor.status<>'active'
    or p_expected_role is distinct from 'admin' then
    raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  select s.not_after into session_deadline from auth.sessions s
    where s.id=p_session and s.user_id=actor.auth_user_id for share;
  session_found:=found;
  -- Evaluate after all profile/session waits, not at request/transaction start.
  if p_session is null or not session_found or (session_deadline is not null and session_deadline<=clock_timestamp()) then
    raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  -- Reentrant acquisition cannot wait: this transaction already owns the
  -- receipt key, so even hash mismatch is returned only after latest guards.
  replay:=private.replay_command(p_actor,command,p_key,p_hash);
  if not exists(select 1 from public.profiles where id=p_maid and role='maid') then
    raise exception using errcode='P0002',message='PAYROLL_MAID_NOT_FOUND'; end if;
  if p_week is null or not isfinite(p_week) or extract(year from p_week) not between 1 and 9999 then
    raise exception using errcode='22023',message='PAYROLL_WEEK_MUST_START_MONDAY'; end if;
  perform private.assert_readable_payroll_week(p_week);
  -- Authorization remains mandatory even for replay; a completed response is
  -- immutable historical success, not a current-state re-confirmation.
  if replay is not null then return replay; end if;
  if p_expected_version is null or p_expected_version<0 or p_expected_version>9007199254740991 then
    raise exception using errcode='22023',message='INVALID_EXPECTED_VERSION'; end if;
  if p_expected_fingerprint is null or p_expected_fingerprint!~'^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='PAYROLL_REMITTANCE_BASIS_FINGERPRINT_INVALID'; end if;
  if p_action='set' and p_marked is null then
    raise exception using errcode='22023',message='PAYROLL_REMITTANCE_MARKED_INVALID'; end if;
  select * into marker from private.payroll_remittance_markers
    where maid_profile_id=p_maid and week_start=p_week for update;
  if session_deadline is not null and session_deadline<=clock_timestamp() then
    raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  if coalesce(marker.version,0)<>p_expected_version then
    raise exception using errcode='40001',message='PAYROLL_REMITTANCE_MARKER_STALE_VERSION'; end if;
  basis:=private.payroll_remittance_basis(p_maid,p_week);
  if not private.valid_payroll_remittance_basis(basis) then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_BASIS_INVARIANT_VIOLATION'; end if;
  if private.payroll_remittance_fingerprint(basis)<>p_expected_fingerprint then
    raise exception using errcode='40001',message='PAYROLL_REMITTANCE_BASIS_CHANGED'; end if;
  old_marked:=coalesce(marker.marked,false);
  if p_action='set' and p_marked=old_marked then
    result:=private.payroll_remittance_projection(p_maid,p_week,basis,'admin');
    perform private.complete_command(p_actor,command,p_key,p_hash,marker.id,result);
    return result;
  end if;
  if p_action='reconfirm' then
    if not old_marked then
      raise exception using errcode='55000',message='PAYROLL_REMITTANCE_MARKER_NOT_SET'; end if;
    select * into revision from private.payroll_remittance_marker_revisions where id=marker.current_revision_id;
    if private.payroll_remittance_fingerprint(basis)=revision.basis_fingerprint then
      raise exception using errcode='55000',message='PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED'; end if;
    event_kind:='reconfirmed'; p_marked:=true;
  elsif p_marked then
    if p_week>=date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date then
      raise exception using errcode='22023',message='PAYROLL_WEEK_NOT_CLOSED'; end if;
    if coalesce((basis->>'lockedAmount')::bigint,(basis->>'payableAmount')::bigint)<=0 then
      raise exception using errcode='22023',message='NO_PAYROLL_AMOUNT'; end if;
    event_kind:='marked';
  else event_kind:='cleared';
  end if;
  if coalesce(marker.version,0)>=9007199254740991 then
    raise exception using errcode='23514',message='PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION'; end if;
  marker_id:=coalesce(marker.id,gen_random_uuid()); new_version:=coalesce(marker.version,0)+1;
  now_at:=greatest(clock_timestamp(),coalesce(marker.updated_at,'-infinity'::timestamptz));
  insert into private.payroll_remittance_marker_revisions(marker_id,maid_profile_id,week_start,
    version,event_type,marked,actor_profile_id,occurred_at,basis,basis_fingerprint)
    values(marker_id,p_maid,p_week,new_version,event_kind,p_marked,p_actor,now_at,basis,
      private.payroll_remittance_fingerprint(basis)) returning * into revision;
  if marker.id is null then
    insert into private.payroll_remittance_markers(id,maid_profile_id,week_start,version,marked,
      current_revision_id,last_changed_revision_id,created_at,updated_at)
      values(marker_id,p_maid,p_week,new_version,p_marked,revision.id,revision.id,now_at,now_at);
  else
    update private.payroll_remittance_markers set version=new_version,marked=p_marked,
      current_revision_id=revision.id,last_changed_revision_id=case when event_kind='reconfirmed'
        then marker.last_changed_revision_id else revision.id end,updated_at=now_at
      where id=marker.id and version=p_expected_version;
    if not found then raise exception using errcode='40001',message='PAYROLL_REMITTANCE_MARKER_STALE_VERSION'; end if;
  end if;
  perform private.assert_payroll_remittance_lineage(marker_id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,after_state,idempotency_key)
    values(p_actor,'payroll.remittance_'||event_kind,'payroll_remittance_marker',marker_id,now_at,
      jsonb_build_object('weekStart',p_week,'marked',p_marked,'version',new_version,'eventType',event_kind),
      private.audit_command_key(p_actor,command,p_key));
  result:=private.payroll_remittance_projection(p_maid,p_week,basis,'admin');
  perform private.complete_command(p_actor,command,p_key,p_hash,marker_id,result);
  return result;
end $$;
revoke all on function private.command_payroll_remittance_marker(uuid,uuid,text,uuid,date,text,boolean,bigint,text,text,text)
  from public,anon,authenticated,service_role;

create function public.set_payroll_remittance_marker(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_actor_role text,p_maid_profile_id uuid,p_week_start date,
  p_marked boolean,p_expected_version bigint,p_expected_basis_fingerprint text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.command_payroll_remittance_marker(p_actor_profile_id,p_session_id,p_expected_actor_role,
    p_maid_profile_id,p_week_start,'set',p_marked,p_expected_version,p_expected_basis_fingerprint,p_idempotency_key,p_request_hash)
$$;
create function public.reconfirm_payroll_remittance_marker(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_actor_role text,p_maid_profile_id uuid,p_week_start date,
  p_expected_version bigint,p_expected_basis_fingerprint text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.command_payroll_remittance_marker(p_actor_profile_id,p_session_id,p_expected_actor_role,
    p_maid_profile_id,p_week_start,'reconfirm',null,p_expected_version,p_expected_basis_fingerprint,p_idempotency_key,p_request_hash)
$$;

create function public.list_payroll_remittance_marker_history(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_actor_role text,p_maid_profile_id uuid,p_week_start date,
  p_after_version bigint default null,p_limit integer default 20
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; candidates integer; last_version bigint;
begin
  perform private.assert_payroll_remittance_reader(p_actor_profile_id,p_session_id,
    p_expected_actor_role,p_maid_profile_id,p_week_start);
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception using errcode='22023',message='PAYROLL_REMITTANCE_HISTORY_LIMIT_INVALID'; end if;
  if p_after_version is not null and (p_after_version<1 or p_after_version>9007199254740991) then
    raise exception using errcode='22023',message='PAYROLL_REMITTANCE_HISTORY_CURSOR_INVALID'; end if;
  with candidate as (select * from private.payroll_remittance_marker_revisions
    where maid_profile_id=p_maid_profile_id and week_start=p_week_start
      and (p_after_version is null or version>p_after_version) order by version limit p_limit+1),
    page as (select * from candidate order by version limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('revisionId',id,'version',version,'eventType',event_type,
    'marked',marked,'actorProfileId',actor_profile_id,'occurredAt',occurred_at,'basis',basis)
    order by version),'[]'::jsonb),(select count(*) from candidate),(select max(version) from page)
    into rows,candidates,last_version from page;
  return jsonb_build_object('entries',rows,'hasMore',candidates>p_limit,'lastVersion',last_version);
end $$;

revoke all on function public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date),
  public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text),
  public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text),
  public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date),
  public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text),
  public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text),
  public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)
  to service_role;
