-- #30 / #11A: provider-independent model only. No HTTP/upload/submit command is exposed.
-- Legacy JSON is retained; empty/unprovable snapshots never mean complete evidence.
create function private.photo_snapshot_valid(p_snapshot jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare s jsonb; n integer; expected integer; version_number integer;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object'
    or jsonb_typeof(p_snapshot->'templateVersionId') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'roomTypeCode') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'cleaningKind') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'slots') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'version') is distinct from 'number'
    or (p_snapshot->>'version') !~ '^[1-9][0-9]*$'
    or (p_snapshot->>'templateVersionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or p_snapshot->>'roomTypeCode' not in ('standard','premium','oceanPremium','oceanFamily')
    or p_snapshot->>'cleaningKind' not in ('checkout','stayover','additional','reclean')
    or not (p_snapshot ?& array['templateVersionId','version','roomTypeCode','cleaningKind','slots']) then return false; end if;
  version_number:=(p_snapshot->>'version')::integer;
  n:=jsonb_array_length(p_snapshot->'slots');
  if n<1 or n>100 then return false; end if;
  for s in select value from jsonb_array_elements(p_snapshot->'slots') loop
    if jsonb_typeof(s) is distinct from 'object'
      or not(s ?& array['slotKey','required','displayOrder'])
      or jsonb_typeof(s->'slotKey') is distinct from 'string'
      or (s->>'slotKey') !~ '^[a-z][a-z0-9-]{0,79}$'
      or jsonb_typeof(s->'required') is distinct from 'boolean'
      or jsonb_typeof(s->'displayOrder') is distinct from 'number'
      or (s->>'displayOrder') !~ '^(0|[1-9][0-9]*)$'
      or (s->>'displayOrder')::integer>99 then return false; end if;
  end loop;
  if (select count(distinct value->>'slotKey') from jsonb_array_elements(p_snapshot->'slots'))<>n
    or (select count(distinct (value->>'displayOrder')::integer) from jsonb_array_elements(p_snapshot->'slots'))<>n then return false; end if;
  if not exists(select 1 from jsonb_array_elements(p_snapshot->'slots') where (value->>'required')::boolean) then return false; end if;
  if p_snapshot->>'cleaningKind'='checkout' and version_number>=7 then
    expected:=case p_snapshot->>'roomTypeCode' when 'standard' then 10 when 'premium' then 11 when 'oceanPremium' then 13 else 15 end;
    if n<>expected or (select count(*) from jsonb_array_elements(p_snapshot->'slots') where (value->>'required')::boolean)<>expected-1 then return false; end if;
    if version_number>=7 and (select count(*) from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'='tv-on' and (value->>'required')::boolean)<>1 then return false; end if;
  end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end; $$;
revoke all on function private.photo_snapshot_valid(jsonb) from public,anon,authenticated,service_role;

create table private.photo_template_slots (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null references public.cleaning_template_versions(id) on delete restrict,
  slot_key text not null check(slot_key ~ '^[a-z][a-z0-9-]{0,79}$'),
  display_order integer not null check(display_order between 0 and 99),
  required boolean not null,
  slot_snapshot jsonb not null check(jsonb_typeof(slot_snapshot)='object'),
  unique(template_version_id,slot_key), unique(template_version_id,display_order)
);
create table private.target_photo_snapshot_contracts (
  cleaning_target_id uuid primary key references public.cleaning_targets(id) on delete restrict,
  ready boolean not null,
  frozen_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  check(not ready or private.photo_snapshot_valid(frozen_snapshot))
);
create table private.target_photo_slot_snapshots (
  id uuid primary key default gen_random_uuid(),
  cleaning_target_id uuid not null references private.target_photo_snapshot_contracts(cleaning_target_id) on delete restrict,
  template_version_id uuid not null,
  slot_key text not null check(slot_key ~ '^[a-z][a-z0-9-]{0,79}$'),
  display_order integer not null check(display_order between 0 and 99),
  required boolean not null,
  slot_snapshot jsonb not null check(jsonb_typeof(slot_snapshot)='object'),
  unique(cleaning_target_id,slot_key), unique(cleaning_target_id,display_order),
  unique(id,cleaning_target_id)
);
-- Snapshot template ID is historical identity, not a latest-catalog lookup/FK.
create index target_photo_slots_template_idx on private.target_photo_slot_snapshots(template_version_id);

create function private.normalized_target_photo_snapshot(p_target public.cleaning_targets)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('templateVersionId',p_target.template_snapshot->'id',
  'version',p_target.template_snapshot->'version','roomTypeCode',p_target.room_type_snapshot->'code',
  'cleaningKind',p_target.cleaning_kind,'slots',p_target.template_snapshot->'photoSlots')
$$;
revoke all on function private.normalized_target_photo_snapshot(public.cleaning_targets) from public,anon,authenticated,service_role;

create function private.materialize_target_photo_snapshot(p_target public.cleaning_targets,p_legacy boolean default false)
returns void language plpgsql set search_path='' as $$
declare snapshot jsonb:=private.normalized_target_photo_snapshot(p_target); valid boolean:=private.photo_snapshot_valid(snapshot);
begin
  if not p_legacy and not valid and coalesce(p_target.template_snapshot->>'version','') ~ '^[0-9]{1,8}$'
    and (p_target.template_snapshot->>'version')::integer>=7 then
    raise exception using errcode='23514',message='PHOTO_TEMPLATE_INVALID'; end if;
  if not p_legacy and valid then
    -- Match the already chosen immutable catalog version, never fill from the latest one.
    perform 1 from public.cleaning_template_versions t join public.room_types rt on rt.id=t.room_type_id
    where t.id=(snapshot->>'templateVersionId')::uuid and t.version=(snapshot->>'version')::integer
      and t.cleaning_kind=p_target.cleaning_kind and rt.code=snapshot->>'roomTypeCode'
      and t.photo_slots=p_target.template_snapshot->'photoSlots' and t.status in ('published','retired')
    for share of t;
    if not found then raise exception using errcode='23514',message='PHOTO_TEMPLATE_INVALID'; end if;
  end if;
  insert into private.target_photo_snapshot_contracts(cleaning_target_id,ready,frozen_snapshot)
    values(p_target.id,valid,snapshot);
  if valid then
    insert into private.target_photo_slot_snapshots(cleaning_target_id,template_version_id,slot_key,display_order,required,slot_snapshot)
    select p_target.id,(snapshot->>'templateVersionId')::uuid,value->>'slotKey',(value->>'displayOrder')::integer,(value->>'required')::boolean,value
    from jsonb_array_elements(snapshot->'slots');
  end if;
end; $$;
revoke all on function private.materialize_target_photo_snapshot(public.cleaning_targets,boolean) from public,anon,authenticated,service_role;

create function private.target_photo_snapshot_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.template_snapshot is distinct from old.template_snapshot then
      raise exception using errcode='55000',message='PHOTO_TARGET_SNAPSHOT_IMMUTABLE'; end if;
    return new;
  end if;
  perform private.materialize_target_photo_snapshot(new,false);
  return new;
end; $$;
revoke all on function private.target_photo_snapshot_trigger() from public,anon,authenticated,service_role;
create trigger target_photo_snapshot_after_insert after insert on public.cleaning_targets
for each row execute function private.target_photo_snapshot_trigger();
create trigger target_photo_snapshot_before_update before update of template_snapshot on public.cleaning_targets
for each row execute function private.target_photo_snapshot_trigger();
do $$ declare t public.cleaning_targets; begin
  for t in select * from public.cleaning_targets order by id loop
    perform private.materialize_target_photo_snapshot(t,true);
  end loop;
end; $$;

create function private.photo_template_contract_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare snapshot jsonb; room_code text;
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='PHOTO_TEMPLATE_IMMUTABLE'; end if;
  if tg_op='UPDATE' and old.status in ('published','retired') then
    if (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status')
      or (old.status='retired' and new.status<>'retired') or new.status not in ('published','retired') then
      raise exception using errcode='55000',message='PHOTO_TEMPLATE_IMMUTABLE'; end if;
  end if;
  if new.status='published' then
    select code into room_code from public.room_types where id=new.room_type_id;
    snapshot:=jsonb_build_object('templateVersionId',new.id,'version',new.version,'roomTypeCode',room_code,
      'cleaningKind',new.cleaning_kind,'slots',new.photo_slots);
    if not private.photo_snapshot_valid(snapshot) then
      -- Legacy v1 empty fixtures are not evidence templates. Preserve pre-photo business paths.
      if new.version>=7 or new.photo_slots<>'[]'::jsonb then
        raise exception using errcode='23514',message='PHOTO_TEMPLATE_INVALID'; end if;
    end if;
  end if;
  return new;
end; $$;
revoke all on function private.photo_template_contract_trigger() from public,anon,authenticated,service_role;
create trigger photo_template_contract_before_write before insert or update or delete on public.cleaning_template_versions
for each row execute function private.photo_template_contract_trigger();

create function private.materialize_photo_template_slots()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='published' and jsonb_array_length(new.photo_slots)>0
    and not exists(select 1 from private.photo_template_slots where template_version_id=new.id) then
    insert into private.photo_template_slots(template_version_id,slot_key,display_order,required,slot_snapshot)
    select new.id,value->>'slotKey',(value->>'displayOrder')::integer,(value->>'required')::boolean,value from jsonb_array_elements(new.photo_slots);
  end if;
  return new;
end; $$;
revoke all on function private.materialize_photo_template_slots() from public,anon,authenticated,service_role;
create trigger photo_template_slots_after_write after insert or update on public.cleaning_template_versions
for each row execute function private.materialize_photo_template_slots();
insert into private.photo_template_slots(template_version_id,slot_key,display_order,required,slot_snapshot)
select t.id,s.value->>'slotKey',(s.value->>'displayOrder')::integer,(s.value->>'required')::boolean,s.value
from public.cleaning_template_versions t join public.room_types rt on rt.id=t.room_type_id
cross join lateral jsonb_array_elements(case when private.photo_snapshot_valid(jsonb_build_object(
 'templateVersionId',t.id,'version',t.version,'roomTypeCode',rt.code,'cleaningKind',t.cleaning_kind,'slots',t.photo_slots)) then t.photo_slots else '[]'::jsonb end) s
where t.status in ('published','retired');

alter table public.cleaning_attempts add constraint cleaning_attempts_photo_identity_unique unique(id,cleaning_target_id);
create table private.attempt_photo_versions (
  id uuid primary key default gen_random_uuid(),
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  version bigint not null check(version>0),
  validation_status text not null default 'pending' check(validation_status in ('pending','verified','failed')),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check(mime_type in ('image/jpeg','image/webp')),
  size_bytes integer not null check(size_bytes between 1 and 307200),
  uploaded_at timestamptz not null check(isfinite(uploaded_at)),
  purge_after timestamptz not null,
  check(purge_after=uploaded_at+interval '168 hours'),
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict,
  foreign key(target_photo_slot_id,cleaning_target_id) references private.target_photo_slot_snapshots(id,cleaning_target_id) on delete restrict,
  unique(cleaning_attempt_id,target_photo_slot_id,version),
  unique(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version)
);
create index attempt_photo_target_slot_idx on private.attempt_photo_versions(target_photo_slot_id,cleaning_target_id);
create index attempt_photo_target_idx on private.attempt_photo_versions(cleaning_target_id);
create index attempt_photo_purge_idx on private.attempt_photo_versions(purge_after,id);
-- Provider locator is deliberately absent. #9 owns its private object/validation workflow.
create table private.attempt_photo_purge_states (
  photo_version_id uuid primary key references private.attempt_photo_versions(id) on delete restrict,
  purged_at timestamptz not null check(isfinite(purged_at))
);
create table private.attempt_photo_current (
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  revision bigint not null check(revision>0),
  photo_version_id uuid,
  photo_version bigint,
  primary key(cleaning_attempt_id,target_photo_slot_id),
  check((photo_version_id is null)=(photo_version is null)),
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict,
  foreign key(target_photo_slot_id,cleaning_target_id) references private.target_photo_slot_snapshots(id,cleaning_target_id) on delete restrict,
  foreign key(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version)
    references private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version) on delete restrict
);
create index attempt_photo_current_photo_idx on private.attempt_photo_current(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version);
create index attempt_photo_current_slot_idx on private.attempt_photo_current(target_photo_slot_id,cleaning_target_id);
create index attempt_photo_current_target_idx on private.attempt_photo_current(cleaning_target_id);
create table private.attempt_photo_changes (
  id uuid primary key default gen_random_uuid(),
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  revision bigint not null check(revision>0),
  photo_version_id uuid,
  photo_version bigint,
  occurred_at timestamptz not null default clock_timestamp(),
  unique(cleaning_attempt_id,target_photo_slot_id,revision),
  check((photo_version_id is null)=(photo_version is null)),
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict,
  foreign key(target_photo_slot_id,cleaning_target_id) references private.target_photo_slot_snapshots(id,cleaning_target_id) on delete restrict,
  foreign key(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version)
    references private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version) on delete restrict
);
create index attempt_photo_changes_photo_idx on private.attempt_photo_changes(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version);
create index attempt_photo_changes_slot_idx on private.attempt_photo_changes(target_photo_slot_id,cleaning_target_id);
create index attempt_photo_changes_target_idx on private.attempt_photo_changes(cleaning_target_id);

create table private.submission_photo_bindings (
  submission_id uuid not null,
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  photo_version_id uuid not null,
  photo_version bigint not null,
  primary key(submission_id,target_photo_slot_id),
  foreign key(submission_id,cleaning_attempt_id) references public.cleaning_submissions(id,cleaning_attempt_id) on delete restrict,
  foreign key(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version)
    references private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version) on delete restrict
);
create index submission_photo_bindings_photo_idx on private.submission_photo_bindings(photo_version_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version);
create index submission_photo_bindings_attempt_idx on private.submission_photo_bindings(cleaning_attempt_id);
create index submission_photo_bindings_target_idx on private.submission_photo_bindings(cleaning_target_id);
create index submission_photo_bindings_slot_idx on private.submission_photo_bindings(target_photo_slot_id);
create table private.submission_current_pointers (
  cleaning_attempt_id uuid primary key references public.cleaning_attempts(id) on delete restrict,
  submission_id uuid not null unique,
  revision bigint not null check(revision>0),
  foreign key(submission_id,cleaning_attempt_id) references public.cleaning_submissions(id,cleaning_attempt_id) on delete restrict
);

-- A seal is model metadata for the existing canonical submission, not a second submission ledger.
create table private.submission_photo_binding_sets (
  submission_id uuid primary key,
  cleaning_attempt_id uuid not null,
  photo_count integer not null check(photo_count between 1 and 100),
  sealed_at timestamptz not null default clock_timestamp(),
  foreign key(submission_id,cleaning_attempt_id) references public.cleaning_submissions(id,cleaning_attempt_id) on delete restrict,
  unique(submission_id,cleaning_attempt_id)
);
create index submission_photo_binding_sets_attempt_idx on private.submission_photo_binding_sets(cleaning_attempt_id);
alter table private.submission_current_pointers add constraint submission_current_sealed_fk
  foreign key(submission_id,cleaning_attempt_id) references private.submission_photo_binding_sets(submission_id,cleaning_attempt_id) on delete restrict;

create function private.guard_photo_slot_snapshot_binding()
returns trigger language plpgsql set search_path='' as $$
declare snapshot jsonb;
begin
  if tg_table_name='photo_template_slots' then
    select t.photo_slots into snapshot from public.cleaning_template_versions t where t.id=new.template_version_id and t.status in ('published','retired');
  else
    select c.frozen_snapshot->'slots' into snapshot from private.target_photo_snapshot_contracts c
      where c.cleaning_target_id=new.cleaning_target_id and c.ready
      and (c.frozen_snapshot->>'templateVersionId')::uuid=new.template_version_id;
  end if;
  if snapshot is null or not exists(select 1 from jsonb_array_elements(snapshot) s where
    s->>'slotKey'=new.slot_key and (s->>'displayOrder')::integer=new.display_order and (s->>'required')::boolean=new.required
      and s=new.slot_snapshot) then
    raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
  return new;
end; $$;
revoke all on function private.guard_photo_slot_snapshot_binding() from public,anon,authenticated,service_role;
create trigger photo_template_slots_validate before insert on private.photo_template_slots
for each row execute function private.guard_photo_slot_snapshot_binding();
create trigger target_photo_slots_validate before insert on private.target_photo_slot_snapshots
for each row execute function private.guard_photo_slot_snapshot_binding();

create function private.guard_photo_pointer_cas()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='PHOTO_MODEL_IMMUTABLE'; end if;
  if tg_op='INSERT' then
    if new.revision<>1 then raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
  elsif new.revision<>old.revision+1 or new.cleaning_attempt_id<>old.cleaning_attempt_id then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT';
  end if;
  if tg_table_name='attempt_photo_current' then
    if tg_op='UPDATE' and (new.cleaning_target_id<>old.cleaning_target_id or new.target_photo_slot_id<>old.target_photo_slot_id) then
      raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
    if new.photo_version_id is not null and (new.photo_version<>new.revision or not exists(
      select 1 from private.attempt_photo_versions p where p.id=new.photo_version_id and p.validation_status='verified'
        and p.uploaded_at<=clock_timestamp() and p.purge_after>clock_timestamp()
        and not exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id))) then
      raise exception using errcode='23514',message='PHOTO_NOT_VERIFIED'; end if;
  elsif tg_op='UPDATE' then
    if (select version from public.cleaning_submissions where id=new.submission_id)<=(select version from public.cleaning_submissions where id=old.submission_id) then
      raise exception using errcode='40001',message='SUBMISSION_VERSION_CONFLICT'; end if;
  end if;
  return new;
end; $$;
revoke all on function private.guard_photo_pointer_cas() from public,anon,authenticated,service_role;
create trigger attempt_photo_pointer_cas before insert or update or delete on private.attempt_photo_current
for each row execute function private.guard_photo_pointer_cas();
create trigger submission_photo_pointer_cas before insert or update or delete on private.submission_current_pointers
for each row execute function private.guard_photo_pointer_cas();

create function private.guard_submission_photo_binding()
returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from private.submission_photo_binding_sets where submission_id=new.submission_id)
    or not exists(select 1 from private.attempt_photo_current c join private.attempt_photo_versions p on p.id=c.photo_version_id
      where c.cleaning_attempt_id=new.cleaning_attempt_id and c.target_photo_slot_id=new.target_photo_slot_id
        and c.photo_version_id=new.photo_version_id and c.photo_version=new.photo_version and c.cleaning_target_id=new.cleaning_target_id
        and p.validation_status='verified' and p.purge_after>clock_timestamp()
        and not exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id)) then
    raise exception using errcode='55000',message='SUBMISSION_PHOTO_BINDING_INVALID'; end if;
  return new;
end; $$;
revoke all on function private.guard_submission_photo_binding() from public,anon,authenticated,service_role;
create trigger submission_photo_binding_validate before insert on private.submission_photo_bindings
for each row execute function private.guard_submission_photo_binding();

create function private.append_photo_pointer_history()
returns trigger language plpgsql set search_path='' as $$
begin
  insert into private.attempt_photo_changes(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,revision,photo_version_id,photo_version)
  values(new.cleaning_attempt_id,new.cleaning_target_id,new.target_photo_slot_id,new.revision,new.photo_version_id,new.photo_version);
  return new;
end; $$;
revoke all on function private.append_photo_pointer_history() from public,anon,authenticated,service_role;
create trigger attempt_photo_pointer_history after insert or update on private.attempt_photo_current
for each row execute function private.append_photo_pointer_history();

create function private.guard_photo_purge_state()
returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from private.attempt_photo_versions where id=new.photo_version_id and purge_after<=new.purged_at) then
    raise exception using errcode='23514',message='PHOTO_PURGE_TIME_INVALID'; end if;
  return new;
end; $$;
revoke all on function private.guard_photo_purge_state() from public,anon,authenticated,service_role;
create trigger attempt_photo_purge_state_validate before insert on private.attempt_photo_purge_states
for each row execute function private.guard_photo_purge_state();

create function private.guard_photo_model_append_only()
returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='55000',message='PHOTO_MODEL_IMMUTABLE'; end; $$;
revoke all on function private.guard_photo_model_append_only() from public,anon,authenticated,service_role;
do $$ declare table_name text; begin
  foreach table_name in array array['photo_template_slots','target_photo_snapshot_contracts','target_photo_slot_snapshots',
    'attempt_photo_versions','attempt_photo_purge_states','attempt_photo_changes','submission_photo_bindings','submission_photo_binding_sets'] loop
    execute format('create trigger photo_model_append_only before update or delete on private.%I for each row execute function private.guard_photo_model_append_only()',table_name);
  end loop;
  foreach table_name in array array['photo_template_slots','target_photo_snapshot_contracts','target_photo_slot_snapshots',
    'attempt_photo_versions','attempt_photo_purge_states','attempt_photo_current','attempt_photo_changes','submission_photo_bindings','submission_photo_binding_sets','submission_current_pointers'] loop
    execute format('alter table private.%I enable row level security',table_name);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',table_name);
  end loop;
end; $$;

-- All submissions, including unconsumed legacy rows, retain immutable historical payloads.
create function private.guard_submission_payload()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-array['status','superseded_at']) is distinct from (to_jsonb(old)-array['status','superseded_at']) then
    raise exception using errcode='55000',message='SUBMISSION_PAYLOAD_IMMUTABLE'; end if;
  return new;
end; $$;
revoke all on function private.guard_submission_payload() from public,anon,authenticated,service_role;
create trigger zz_submission_payload_immutable before update or delete on public.cleaning_submissions
for each row execute function private.guard_submission_payload();
-- Old raw provider/manifest tables cannot become an alternate service-role write API.
revoke insert,update,delete,truncate,references,trigger on public.cleaning_submissions,public.submission_photos from service_role;

-- Pure model helper, intentionally NOT a future API authorization shortcut.
-- #9/#31 must add verified Auth/session and byte/provider validation before exposing commands.
create function private.assert_photo_model_actor(p_actor uuid,p_attempt uuid,p_action text)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor for no key update;
  select * into a from public.cleaning_attempts where id=p_attempt for update;
  at_time:=clock_timestamp();
  if p.id is null or p.role<>'maid' or p.must_change_password or a.id is null or a.maid_profile_id<>p.id then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  if p.status='active' and a.status in ('in_progress','field_completed','upload_pending')
    and exists(select 1 from public.cleaning_assignments s join public.cleaning_targets t on t.id=s.cleaning_target_id
      where s.id=a.assignment_id and s.is_current and s.notified_at is not null and s.ended_at is null
      and s.maid_profile_id=p.id and s.revision=a.assignment_revision and t.assignment_version=s.revision and t.status<>'cancelled') then
    if p_action='submit' and a.field_completed_at is null then
      raise exception using errcode='55000',message='FIELD_COMPLETION_REQUIRED'; end if;
    return a;
  end if;
  if (private.live_attempt_capability(p_actor,p_attempt,a.assignment_revision,p_action,at_time)).id is null then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  return a;
end; $$;
revoke all on function private.assert_photo_model_actor(uuid,uuid,text) from public,anon,authenticated,service_role;

create function private.record_validated_attempt_photo(p_actor uuid,p_attempt uuid,p_slot uuid,p_expected_revision bigint,
  p_sha256 text,p_mime text,p_size integer,p_uploaded_at timestamptz)
returns uuid language plpgsql set search_path='' as $$
declare a public.cleaning_attempts; c private.attempt_photo_current; result_id uuid; at_time timestamptz;
begin
  a:=private.assert_photo_model_actor(p_actor,p_attempt,'upload_evidence');
  at_time:=clock_timestamp();
  if p_uploaded_at is null or not isfinite(p_uploaded_at) or p_uploaded_at>at_time or p_uploaded_at+interval '168 hours'<=at_time then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_TIME_INVALID'; end if;
  if not exists(select 1 from private.target_photo_slot_snapshots slot_row join private.target_photo_snapshot_contracts contract_row
    on contract_row.cleaning_target_id=slot_row.cleaning_target_id where slot_row.id=p_slot and slot_row.cleaning_target_id=a.cleaning_target_id and contract_row.ready) then
    raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
  select * into c from private.attempt_photo_current where cleaning_attempt_id=p_attempt and target_photo_slot_id=p_slot;
  if p_expected_revision is null or p_expected_revision<0 or coalesce(c.revision,0)<>p_expected_revision then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
  insert into private.attempt_photo_versions(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,
    validation_status,sha256,mime_type,size_bytes,uploaded_at,purge_after)
  values(p_attempt,a.cleaning_target_id,p_slot,p_expected_revision+1,'verified',p_sha256,p_mime,p_size,p_uploaded_at,p_uploaded_at+interval '168 hours') returning id into result_id;
  if c.revision is null then
    insert into private.attempt_photo_current(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,revision,photo_version_id,photo_version)
    values(p_attempt,a.cleaning_target_id,p_slot,1,result_id,1);
  else
    update private.attempt_photo_current set revision=p_expected_revision+1,photo_version_id=result_id,photo_version=p_expected_revision+1
      where cleaning_attempt_id=p_attempt and target_photo_slot_id=p_slot;
  end if;
  return result_id;
end; $$;
revoke all on function private.record_validated_attempt_photo(uuid,uuid,uuid,bigint,text,text,integer,timestamptz) from public,anon,authenticated,service_role;

create function private.clear_attempt_photo(p_actor uuid,p_attempt uuid,p_slot uuid,p_expected_revision bigint)
returns bigint language plpgsql set search_path='' as $$
declare c private.attempt_photo_current;
begin
  perform private.assert_photo_model_actor(p_actor,p_attempt,'upload_evidence');
  select * into c from private.attempt_photo_current where cleaning_attempt_id=p_attempt and target_photo_slot_id=p_slot;
  if c.revision is null or p_expected_revision is null or c.revision<>p_expected_revision or c.photo_version_id is null then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
  update private.attempt_photo_current set revision=revision+1,photo_version_id=null,photo_version=null
    where cleaning_attempt_id=p_attempt and target_photo_slot_id=p_slot;
  return p_expected_revision+1;
end; $$;
revoke all on function private.clear_attempt_photo(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;

create function private.photo_attempt_complete(p_attempt uuid,p_as_of timestamptz)
returns boolean language sql stable set search_path='' as $$
 select coalesce(isfinite(p_as_of) and exists(select 1 from public.cleaning_attempts a
   join private.target_photo_snapshot_contracts contract on contract.cleaning_target_id=a.cleaning_target_id
   where a.id=p_attempt and contract.ready
     and (select count(*) from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id)=jsonb_array_length(contract.frozen_snapshot->'slots')
     and exists(select 1 from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id and s.required)
     and not exists((select value from jsonb_array_elements(contract.frozen_snapshot->'slots'))
       except(select slot_snapshot from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id))
     and a.template_snapshot=(select template_snapshot from public.cleaning_targets where id=a.cleaning_target_id)
     and not exists(select 1 from private.target_photo_slot_snapshots s where s.cleaning_target_id=a.cleaning_target_id and s.required
       and not exists(select 1 from private.attempt_photo_current c join private.attempt_photo_versions p on p.id=c.photo_version_id
         where c.cleaning_attempt_id=a.id and c.target_photo_slot_id=s.id and p.validation_status='verified'
           and p.uploaded_at<=p_as_of and p.purge_after>p_as_of
           and not exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id)))
     and not exists(select 1 from private.attempt_photo_current c join private.attempt_photo_versions p on p.id=c.photo_version_id
       where c.cleaning_attempt_id=a.id and (p.validation_status<>'verified' or p.uploaded_at>p_as_of or p.purge_after<=p_as_of
         or exists(select 1 from private.attempt_photo_purge_states x where x.photo_version_id=p.id)))
 ),false)
$$;
revoke all on function private.photo_attempt_complete(uuid,timestamptz) from public,anon,authenticated,service_role;

create function private.guard_submission_photo_seal()
returns trigger language plpgsql set search_path='' as $$
begin
  if not private.photo_attempt_complete(new.cleaning_attempt_id,clock_timestamp())
    or new.photo_count<>(select count(*) from private.submission_photo_bindings where submission_id=new.submission_id)
    or exists((select target_photo_slot_id,photo_version_id,photo_version from private.attempt_photo_current
       where cleaning_attempt_id=new.cleaning_attempt_id and photo_version_id is not null)
       except (select target_photo_slot_id,photo_version_id,photo_version from private.submission_photo_bindings where submission_id=new.submission_id))
    or exists((select target_photo_slot_id,photo_version_id,photo_version from private.submission_photo_bindings where submission_id=new.submission_id)
       except(select target_photo_slot_id,photo_version_id,photo_version from private.attempt_photo_current
         where cleaning_attempt_id=new.cleaning_attempt_id and photo_version_id is not null)) then
    raise exception using errcode='55000',message='PHOTO_EVIDENCE_INCOMPLETE'; end if;
  return new;
end; $$;
revoke all on function private.guard_submission_photo_seal() from public,anon,authenticated,service_role;
create trigger submission_photo_seal_validate before insert on private.submission_photo_binding_sets
for each row execute function private.guard_submission_photo_seal();

create function private.bind_submission_photo_model(p_actor uuid,p_submission uuid,p_expected_revision bigint)
returns bigint language plpgsql set search_path='' as $$
declare s public.cleaning_submissions; a public.cleaning_attempts; current_row private.submission_current_pointers;
begin
  select * into s from public.cleaning_submissions where id=p_submission;
  if s.id is null then raise exception using errcode='23514',message='SUBMISSION_INVALID'; end if;
  a:=private.assert_photo_model_actor(p_actor,s.cleaning_attempt_id,'submit');
  select * into s from public.cleaning_submissions where id=p_submission for update;
  select * into current_row from private.submission_current_pointers where cleaning_attempt_id=a.id;
  if p_expected_revision is null or p_expected_revision<0 or coalesce(current_row.revision,0)<>p_expected_revision then
    raise exception using errcode='40001',message='SUBMISSION_VERSION_CONFLICT'; end if;
  if s.submitted_by<>p_actor or s.status<>'submitted' or s.version<=coalesce((select version from public.cleaning_submissions where id=current_row.submission_id),0)
    or exists(select 1 from private.submission_photo_bindings where submission_id=s.id) then
    raise exception using errcode='23514',message='SUBMISSION_INVALID'; end if;
  if not private.photo_attempt_complete(a.id,clock_timestamp()) then
    raise exception using errcode='55000',message='PHOTO_EVIDENCE_INCOMPLETE'; end if;
  -- The JSON manifest is legacy presentation data, never proof of a verified upload.
  insert into private.submission_photo_bindings(submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version)
  select s.id,a.id,a.cleaning_target_id,c.target_photo_slot_id,c.photo_version_id,c.photo_version
  from private.attempt_photo_current c where c.cleaning_attempt_id=a.id and c.photo_version_id is not null;
  insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count)
    select s.id,a.id,count(*) from private.submission_photo_bindings where submission_id=s.id;
  if current_row.revision is null then
    insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision) values(a.id,s.id,1);
  else
    update private.submission_current_pointers set submission_id=s.id,revision=p_expected_revision+1 where cleaning_attempt_id=a.id;
  end if;
  return p_expected_revision+1;
end; $$;
revoke all on function private.bind_submission_photo_model(uuid,uuid,bigint) from public,anon,authenticated,service_role;
