-- #586 / D04-H1-P1 A: exactly 33 residual service_role privileges, preserving
-- 14 business privileges. No rows, sequence values, owners or default ACLs change.
do $guard$
declare v record;
begin
  if current_user <> 'postgres' or not exists (
    select 1 from pg_catalog.pg_roles where rolname='service_role' and not rolsuper
  ) then raise exception 'FINITE_AUTHORITY_ROLE_MISMATCH'; end if;
  for v in select * from (values
    ('room_occupancy_events','r'), ('room_pin_sync_events','r'),
    ('room_candle_events','r'), ('cleaning_target_schedule_revisions','r'),
    ('reservation_schedule_revisions','r'), ('assignment_change_requests','r'),
    ('availability_candidates','v'), ('complaint_case_events_id_seq','S')
  ) expected(name,kind) loop
    if not exists (
      select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=v.name and c.relkind::text=v.kind
        and pg_catalog.pg_get_userbyid(c.relowner)='postgres'
    ) then raise exception 'FINITE_AUTHORITY_OBJECT_MISMATCH: %',v.name; end if;
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_depend d on d.refobjid=a.attrelid and d.refobjsubid=a.attnum
    where a.attrelid='public.complaint_case_events'::regclass and a.attname='id'
      and not a.attisdropped and a.attidentity='a'
      and d.classid='pg_catalog.pg_class'::regclass and d.refclassid='pg_catalog.pg_class'::regclass
      and d.objid='public.complaint_case_events_id_seq'::regclass and d.objsubid=0 and d.deptype='i'
      and pg_catalog.pg_get_serial_sequence('public.complaint_case_events','id')::regclass=d.objid
  ) then raise exception 'FINITE_AUTHORITY_IDENTITY_MISMATCH'; end if;
end $guard$;

revoke update, references, trigger, maintain on table
  public.room_occupancy_events, public.room_pin_sync_events, public.room_candle_events,
  public.cleaning_target_schedule_revisions, public.reservation_schedule_revisions
  from service_role restrict;
revoke references, trigger, maintain on table public.assignment_change_requests from service_role restrict;
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.availability_candidates from service_role restrict;
revoke select, usage, update on sequence public.complaint_case_events_id_seq from service_role restrict;

-- Effective checks also detect PUBLIC/inherited/column grants. Never broaden the
-- revocation to compensate for an unexpected environment; abort this transaction.
do $guard$
declare v record; p text;
begin
  for v in select * from (values
    ('room_occupancy_events',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT']),
    ('room_pin_sync_events',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT']),
    ('room_candle_events',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT']),
    ('cleaning_target_schedule_revisions',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT']),
    ('reservation_schedule_revisions',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT']),
    ('assignment_change_requests',array['REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE'],array['SELECT','INSERT','UPDATE']),
    ('availability_candidates',array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT'])
  ) expected(name,denied,retained) loop
    foreach p in array v.denied loop
      if pg_catalog.has_table_privilege('service_role','public.'||v.name,p) then
        raise exception 'FINITE_AUTHORITY_PRIVILEGE_REMAINS: %.%',v.name,p;
      end if;
      if p in ('INSERT','UPDATE','REFERENCES') then
        if pg_catalog.has_any_column_privilege('service_role','public.'||v.name,p) then
          raise exception 'FINITE_AUTHORITY_COLUMN_PRIVILEGE_REMAINS: %.%',v.name,p;
        end if;
      end if;
    end loop;
    foreach p in array v.retained loop
      if not pg_catalog.has_table_privilege('service_role','public.'||v.name,p) then
        raise exception 'FINITE_AUTHORITY_BUSINESS_PRIVILEGE_MISSING: %.%',v.name,p;
      end if;
    end loop;
  end loop;
  foreach p in array array['SELECT','USAGE','UPDATE'] loop
    if pg_catalog.has_sequence_privilege('service_role','public.complaint_case_events_id_seq',p) then
      raise exception 'FINITE_AUTHORITY_SEQUENCE_PRIVILEGE_REMAINS: %',p;
    end if;
  end loop;
end $guard$;
