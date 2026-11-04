begin;
select no_plan();

-- #586: effective rights, including inherited/PUBLIC and column-only grants.
create temporary table authority_contract(name text,kind text,denied text[],retained text[]);
insert into authority_contract values
('room_occupancy_events','r',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT']),
('room_pin_sync_events','r',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT']),
('room_candle_events','r',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT']),
('cleaning_target_schedule_revisions','r',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT']),
('reservation_schedule_revisions','r',array['UPDATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT']),
('assignment_change_requests','r',array['REFERENCES','TRIGGER','MAINTAIN'],array['SELECT','INSERT','UPDATE']),
('availability_candidates','v',array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'],array['SELECT']),
('complaint_case_events_id_seq','S',array['SELECT','USAGE','UPDATE'],array[]::text[]);
select is((select sum(cardinality(denied)) from authority_contract),33::bigint,'exact 33 denied pairs');
select is((select sum(cardinality(retained)) from authority_contract),14::bigint,'exact 14 business pairs');
select ok(exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname=a.name and c.relkind::text=a.kind
    and pg_get_userbyid(c.relowner)='postgres'),a.name||' identity and owner preserved')
from authority_contract a order by name;
select ok(case when kind='S' then not has_sequence_privilege('service_role','public.'||name,p)
  else not has_table_privilege('service_role','public.'||name,p) end,name||'.'||p||' denied')
from authority_contract cross join lateral unnest(denied) p order by name,p;
select ok(not has_any_column_privilege('service_role','public.'||name,p),name||'.'||p||' no column bypass')
from authority_contract cross join lateral unnest(denied) p
where kind<>'S' and p in ('INSERT','UPDATE','REFERENCES') order by name,p;
select ok(has_table_privilege('service_role','public.'||name,p),name||'.'||p||' business retained')
from authority_contract cross join lateral unnest(retained) p order by name,p;
select ok(not has_table_privilege('service_role','public.'||name,p),name||'.'||p||' prior history protection retained')
from authority_contract cross join unnest(array['DELETE','TRUNCATE']) p
where name in ('room_occupancy_events','room_pin_sync_events','room_candle_events',
  'cleaning_target_schedule_revisions','reservation_schedule_revisions') order by name,p;
select ok(not has_table_privilege('service_role','public.assignment_change_requests','DELETE')
  and not has_table_privilege('service_role','public.assignment_change_requests','TRUNCATE'),
  'prior149 request history protection retained');
select ok(exists(select 1 from pg_attribute a join pg_depend d
  on d.refobjid=a.attrelid and d.refobjsubid=a.attnum
  where a.attrelid='public.complaint_case_events'::regclass and a.attname='id'
    and not a.attisdropped and a.attidentity='a'
    and d.classid='pg_class'::regclass and d.refclassid='pg_class'::regclass
    and d.objid='public.complaint_case_events_id_seq'::regclass and d.objsubid=0 and d.deptype='i'
    and pg_get_serial_sequence('public.complaint_case_events','id')::regclass=d.objid),
  'complaint event GENERATED ALWAYS identity dependency preserved');
select ok((select reloptions @> array['security_invoker=true','security_barrier=true']
  from pg_class where oid='public.availability_candidates'::regclass),
  'availability view retains invoker and barrier protections');
set local role service_role;
select lives_ok($$select * from public.availability_candidates limit 1$$,'service availability read still works');
reset role;
select * from finish();
rollback;
