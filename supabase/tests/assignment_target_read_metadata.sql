begin;
\ir room_pin_fixture.psql
select no_plan();

-- Actual request/assignment commands create provenance and immutable snapshots.
-- Only occupancy and valid notified/scheduled rows use the existing #348 fixture
-- pattern. Never disable a constraint, manufacture a terminal workflow or print
-- a PIN envelope. Every synthetic row is rolled back at the end of this file.
create function pg_temp.metadata_id(n integer) returns uuid language sql immutable as $$
  select ('32600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.metadata_id(100+n) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.metadata_id(6),pg_temp.metadata_id(106),
  '조회 개발자','조회 개발자','0326','metadata-fixture-phone-hash','assignment-metadata-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.metadata_id(n),pg_temp.metadata_id(100+n),'assignment-metadata-'||n,'assignment-metadata-'||n,
  'assignment-metadata-'||n,'assignment-metadata-'||n,0,
  case when n in(1,4,5) then 'admin' else 'maid' end::public.app_role,
  case when n=4 then 'inactive' when n=5 then 'upload_only' else 'active' end::public.account_status,false
from generate_series(1,5) n;
insert into auth.sessions(id,user_id) values(pg_temp.metadata_id(201),pg_temp.metadata_id(101));
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,
  photo_slots,published_at,created_by)
select rt.id,k,1,'published',case when k='checkout' then null else 30 end,'[]'::jsonb,
  clock_timestamp(),pg_temp.metadata_id(1)
from public.room_types rt cross join unnest(array['checkout','stayover','additional']::public.cleaning_kind[]) k;
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.metadata_id(300+n),pg_temp.metadata_id(n),
  date '2041-06-07'-(extract(isodow from date '2041-06-07')::int-1),1,clock_timestamp()
from generate_series(2,3) n;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.metadata_id(300+n),
  date '2041-06-07'-(extract(isodow from date '2041-06-07')::int-1)+d,
  n=2 and d>=4
from generate_series(2,3) n cross join generate_series(0,6) d;
-- Historical display names have no 100-character product/DB/API limit.
-- Use actual request creation below to freeze a valid long catalog name.
update public.room_types set name=name||repeat('N',1001);

create function pg_temp.metadata_fixture(n integer,p_kind public.cleaning_kind default 'additional',
  p_status public.cleaning_target_status default 'unassigned',p_attempt boolean default false)
returns void language plpgsql as $$
declare v_room_id uuid; v_reservation_id uuid;
begin
  select r.id into v_room_id from public.rooms r order by room_number offset n limit 1;
  perform pg_temp.install_room_pin_fixture(v_room_id,pg_temp.metadata_id(1),1);
  insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
  values(v_room_id,'verified',1,'TEST',pg_temp.metadata_id(1),clock_timestamp());
  if p_kind='stayover' then
    v_reservation_id:=pg_temp.metadata_id(4000+n);
    perform public.create_reservation(pg_temp.metadata_id(1),v_reservation_id,v_room_id,
      '2041-06-06 00:00+09','2041-06-10 00:00+09',2,null,
      (select state_version from public.rooms r where r.id=v_room_id),'assignment-metadata-reservation-'||n,repeat('1',64));
    update public.reservations set actual_check_in_at=check_in_at where id=v_reservation_id;
  end if;
  perform public.create_manual_cleaning_request(pg_temp.metadata_id(1),pg_temp.metadata_id(1000+n),v_room_id,
    v_reservation_id,p_kind,'2041-06-07','2041-06-07 00:00+09','2041-06-07 23:00+09',
    (select state_version from public.rooms r where r.id=v_room_id),'METADATA_TEST',
    'assignment-metadata-create-'||n,repeat('2',64));
  if p_status='draft_assigned' then
    perform public.save_cleaning_assignment_draft(pg_temp.metadata_id(1),pg_temp.metadata_id(1000+n),
      pg_temp.metadata_id(2),n,1,'assignment-metadata-draft-'||n,repeat('3',64));
  elsif p_status='notified' then
    update public.cleaning_targets set assignment_version=2,status='notified' where id=pg_temp.metadata_id(1000+n);
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      notified_at,changed_by)
    values(pg_temp.metadata_id(2000+n),pg_temp.metadata_id(1000+n),pg_temp.metadata_id(2),n,2,
      clock_timestamp(),pg_temp.metadata_id(1));
    perform private.emit_notification_v1('assignment.commit_notified',pg_temp.metadata_id(1),pg_temp.metadata_id(2),
      'cleaning_assignment',pg_temp.metadata_id(2000+n)::text,'합성 배정','합성 배정입니다.',
      v_room_id,pg_temp.metadata_id(1000+n),pg_temp.metadata_id(1000+n),clock_timestamp());
  end if;
  if p_attempt then
    insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,template_snapshot,room_snapshot)
    select pg_temp.metadata_id(3000+n),t.id,pg_temp.metadata_id(2000+n),pg_temp.metadata_id(2),1,'scheduled',2,
      t.template_snapshot,t.room_type_snapshot||jsonb_build_object('roomId',v_room_id)
    from public.cleaning_targets t where t.id=pg_temp.metadata_id(1000+n);
  end if;
end $$;
select pg_temp.metadata_fixture(1);
select pg_temp.metadata_fixture(2,'stayover');
select pg_temp.metadata_fixture(3,'additional','draft_assigned');
select pg_temp.metadata_fixture(4,'stayover','draft_assigned');
select pg_temp.metadata_fixture(5,'additional','notified');
select pg_temp.metadata_fixture(6,'stayover','notified',true);
select pg_temp.metadata_fixture(7,'additional','notified',true);
select pg_temp.metadata_fixture(8,'stayover','notified');
select pg_temp.metadata_fixture(9,'stayover');
select pg_temp.metadata_fixture(10,'additional','draft_assigned');
select pg_temp.metadata_fixture(11,'additional','notified',true);
select pg_temp.metadata_fixture(12);

-- Missing/ill-typed snapshot properties and zero are valid stored read inputs,
-- not a change to the catalog or the real manual command's pricing policy.
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
  effective_service_date,available_from,due_at,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.metadata_id(1000+n),(select id from public.rooms order by room_number offset n limit 1),
  'additional','manual_room_request','assignment-metadata-legacy-'||n,'2041-06-07','2041-06-07',
  '2041-06-07 00:00+09','2041-06-07 23:00+09',
  case when n=13 then '{}'::jsonb when n=14 then '{"code":42,"name":"","elevatorZone":false}'::jsonb
    else '{"code":"","name":"","elevatorZone":""}'::jsonb end,
  case when n=13 then 0 else 7 end,'{}'::jsonb,pg_temp.metadata_id(1)
from generate_series(13,15) n;

select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1001))->>'sourceKind',
  'manual_room_request','additional exposes actual manual source, not inferred kind');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1002))->>'sourceKind',
  'stayover_request','stayover exposes actual occupied reservation request source');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1002))->>'cleaningKind',
  'stayover','cleaning kind remains a separate axis');
select ok(length(private.assignment_target_read_metadata(pg_temp.metadata_id(1001))->>'roomTypeName')>1000,
  'actual request snapshot preserves a long valid catalog display name');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1001))->'roomTypeSnapshot'->>'name',
  (select room_type_snapshot->>'name' from public.cleaning_targets where id=pg_temp.metadata_id(1001)),
  'long canonical and flat names keep the exact stored value');
select is(private.assignment_target_read_metadata(t.id)->'roomTypeSnapshot',
  jsonb_build_object('code',t.room_type_snapshot->>'code','name',t.room_type_snapshot->>'name',
    'elevatorZone',t.room_type_snapshot->>'elevatorZone'),'canonical metadata uses creation snapshot case '||n)
from generate_series(1,12) n join public.cleaning_targets t on t.id=pg_temp.metadata_id(1000+n);
select is(private.assignment_target_read_metadata(t.id)->'feeSnapshot',to_jsonb(t.fee_snapshot),
  'stored fee is not recomputed case '||n)
from generate_series(1,15) n join public.cleaning_targets t on t.id=pg_temp.metadata_id(1000+n);
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1013))->'feeSnapshot','0'::jsonb,
  'zero fee survives without becoming null or catalog fee');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1000+n))->'roomTypeSnapshot',
  '{"code":null,"name":null,"elevatorZone":null}'::jsonb,
  'missing, empty or ill-typed snapshot fields stay explicit nullable keys case '||n) from generate_series(13,15) n;
select ok((private.assignment_target_read_metadata(pg_temp.metadata_id(1013))->'roomTypeSnapshot') ?&
  array['code','name','elevatorZone'],'canonical object never strips null keys');
select ok((private.assignment_target_read_metadata(pg_temp.metadata_id(1000+n))->>'canCancel')::boolean
  and private.assignment_target_read_metadata(pg_temp.metadata_id(1000+n))->'cancelReasonCode'='null'::jsonb,
  'unstarted manual request cancellation guidance true case '||n) from generate_series(1,12) n;
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1001))->>'rolloverCount','0',
  'fresh target has known zero rollover evidence');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1001))->'rolloverReason','null'::jsonb,
  'zero rollover has no reason');
select ok(not (private.assignment_target_read_metadata(pg_temp.metadata_id(1001)) ?| array[
  'source_key','sourceKey','reservationId','maidProfileId','pin','ciphertext','nonce','authTag']),
  'read metadata does not expose source identities, owners or secret material');

-- Old PIN disclosure, elapsed dueAt and a stale assignment schedule do not
-- alter #348 cancellation predicates. Real start/complete commands still do.
insert into public.room_pin_access_leases(id,room_id,cleaning_target_id,assignment_id,attempt_id,pin_version,
  issued_to,issued_at,expires_at,revealed_at)
select pg_temp.metadata_id(5011),t.room_id,t.id,pg_temp.metadata_id(2011),pg_temp.metadata_id(3011),1,
  pg_temp.metadata_id(2),statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute',
  statement_timestamp()-interval '90 seconds' from public.cleaning_targets t where t.id=pg_temp.metadata_id(1011);
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1011))->>'canCancel','true',
  'expired revealed legacy PIN history does not restrict cancellation guidance');
update public.cleaning_targets set due_at=due_at+interval '30 minutes' where id=pg_temp.metadata_id(1010);
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1010))->>'canCancel','true',
  'stale draft schedule is not an added cancellation restriction');
create temp table projections(label text primary key,value jsonb);
insert into projections values('late-preview',private.assignment_preview_snapshot_at(pg_temp.metadata_id(1),
  '2041-06-07','2041-06-07 23:45+09'));
select is((select item->>'canCancel' from jsonb_array_elements((select value->'targets' from projections
  where label='late-preview')) item where item->>'cleaningTargetId'=pg_temp.metadata_id(1005)::text),
  'true','elapsed dueAt does not block an unstarted notified target');
select private.execute_cleaning_attempt_at(pg_temp.metadata_id(2),pg_temp.metadata_id(3007),1,
  pg_temp.metadata_id(2007),2,'assignment-metadata-start',repeat('4',64),'start','2041-06-07 10:00+09');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1007))->>'canCancel','false',
  'actual started work is protected');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1007))->>'cancelReasonCode',
  'CLEANING_REQUEST_CANCEL_CONFLICT','actual start returns the same domain conflict guidance');
select private.execute_cleaning_attempt_at(pg_temp.metadata_id(2),pg_temp.metadata_id(3007),2,
  pg_temp.metadata_id(2007),2,'assignment-metadata-complete',repeat('5',64),'complete_field_work','2041-06-07 11:00+09');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1007))->>'canCancel','false',
  'actual completed field work remains protected');
select ok(pg_get_functiondef('private.assignment_target_read_metadata(uuid,uuid)'::regprocedure)
  ~ 'attempt.status<>''superseded''' and
  pg_get_functiondef('private.assignment_target_read_metadata(uuid,uuid)'::regprocedure) !~* '\mlimit\M|\morder by attempt\M|attempt.assignment_revision=',
  'guard considers any exact-current non-superseded attempt, not only latest/revision-matching display attempt');
select public.cancel_manual_cleaning_request_with_session(pg_temp.metadata_id(1),pg_temp.metadata_id(201),
  pg_temp.metadata_id(1012),1,'METADATA_CANCEL','assignment-metadata-cancel',repeat('6',64));
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1012))->>'cancelReasonCode',
  'CLEANING_REQUEST_CANCEL_CONFLICT','actual cancelled request is not newly cancellable');
select is(private.assignment_target_read_metadata((select planned_cleaning_target_id
  from public.checkout_cleaning_obligations where reservation_id=pg_temp.metadata_id(4002)))->>'sourceKind',
  'scheduled_checkout','actual reservation checkout provenance is preserved');
select is(private.assignment_target_read_metadata((select planned_cleaning_target_id
  from public.checkout_cleaning_obligations where reservation_id=pg_temp.metadata_id(4002)))->>'cancelReasonCode',
  'NOT_MANUAL_CLEANING_REQUEST','automatic checkout target cannot be cancelled as a manual request');

-- Explicit historical rollover seam is real source validation and evidence,
-- not scheduler auto-rollover or inferred dates/carryover counters.
select is(private.rollover_cleaning_target_at(pg_temp.metadata_id(1),pg_temp.metadata_id(1008),
  '2041-06-07 23:30+09',pg_temp.metadata_id(2008),2,'2041-06-07')->>'status',
  'rolledOver','valid unstarted notified stayover creates real rollover evidence');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008))->>'rolloverCount','1',
  'current read counts known rollover evidence');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008))->>'rolloverReason',
  'ROLLED_OVER_NOT_STARTED','current read retains exact known rollover reason');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008))->>'originalServiceDate',
  '2041-06-07','rollover preserves original service date');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008))->>'effectiveServiceDate',
  '2041-06-08','current read exposes actual effective service date');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008),pg_temp.metadata_id(2008))->>'rolloverCount',
  '0','historical assignment cannot see a future schedule revision');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1008),pg_temp.metadata_id(2008))->>'cancelReasonCode',
  'ASSIGNMENT_NOT_CURRENT','historical assignment guidance is always non-cancellable');
select is(private.rollover_cleaning_target_at(pg_temp.metadata_id(1),pg_temp.metadata_id(1009),
  '2041-06-07 23:30+09',null,1,'2041-06-07')->>'status','rolledOver','real unassigned rollover succeeds');
select is(private.rollover_cleaning_target_at(pg_temp.metadata_id(1),pg_temp.metadata_id(1009),
  '2041-06-08 23:30+09',null,2,'2041-06-08')->>'status','rolledOver','second valid rollover succeeds');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1009))->>'rolloverCount','2',
  'multiple known rollover revisions are counted without date inference');
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1009))->>'rolloverReason',
  'ROLLED_OVER_UNASSIGNED','latest known rollover reason survives');

-- Changing current configuration cannot rewrite stored snapshot read values.
insert into projections values('snapshot-before',private.assignment_target_read_metadata(pg_temp.metadata_id(1001)));
update public.room_types set name=name||'-current',base_cleaning_fee=base_cleaning_fee+100;
update public.rooms set elevator_zone=case when elevator_zone='A' then 'B' else 'A' end;
select is(private.assignment_target_read_metadata(pg_temp.metadata_id(1001)),
  (select value from projections where label='snapshot-before'),'live catalog/room changes cannot hydrate immutable target metadata');

-- Both impact arrays and preview use the same additive object; old preview
-- routing classifications remain unknown, never a live elevator fallback.
insert into projections values('impact',private.assignment_commit_impact_at('2041-06-07','2041-06-07 09:00+09')),
  ('preview',private.assignment_preview_snapshot_at(pg_temp.metadata_id(1),'2041-06-07','2041-06-07 09:00+09'));
select is(item->'roomTypeSnapshot','{"code":null,"name":null,"elevatorZone":null}'::jsonb,
  'preview canonical empty snapshot remains nullable')
from jsonb_array_elements((select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1013)::text;
select is(item->>'roomTypeCode','unknown','preview old room type classifier stays unknown')
from jsonb_array_elements((select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1013)::text;
select is(item->>'elevatorZone','unknown','preview old elevator classifier cannot fall back to live room')
from jsonb_array_elements((select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1013)::text;
select is(item->'feeSnapshot','0'::jsonb,'preview preserves zero stored fee')
from jsonb_array_elements((select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1013)::text;
select is(item->'roomTypeSnapshot','{"code":null,"name":null,"elevatorZone":null}'::jsonb,
  'preview canonical ill-typed or empty stored snapshot remains unknown case '||n)
from generate_series(14,15) n cross join lateral jsonb_array_elements(
  (select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1000+n)::text;
select is(item->>'roomTypeCode','unknown','preview ill-typed or empty code classifier is unknown case '||n)
from generate_series(14,15) n cross join lateral jsonb_array_elements(
  (select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1000+n)::text;
select is(item->>'elevatorZone','unknown','preview ill-typed or empty zone classifier is unknown case '||n)
from generate_series(14,15) n cross join lateral jsonb_array_elements(
  (select value->'targets' from projections where label='preview')) item
where item->>'cleaningTargetId'=pg_temp.metadata_id(1000+n)::text;
select ok(item ?& array['cleaningKind','sourceKind','roomTypeSnapshot','roomTypeName','feeSnapshot',
  'originalServiceDate','effectiveServiceDate','rolloverCount','rolloverReason','canCancel','cancelReasonCode'],
  'impact enriched row keeps complete additive metadata')
from jsonb_array_elements((select (value->'committableDrafts')||(value->'blockedDrafts')||(value->'remainingUnassignedTargets')
  from projections where label='impact')) item;
select is((select item->>'canCancel' from jsonb_array_elements((select value->'blockedDrafts'
  from projections where label='impact')) item where item->>'cleaningTargetId'=pg_temp.metadata_id(1010)::text),
  'true','blocked stale draft still exposes independent manual cancellation capability');
select is((select item->>'targetAssignmentVersion' from jsonb_array_elements((select value->'committableDrafts'
  from projections where label='impact')) item where item->>'cleaningTargetId'=pg_temp.metadata_id(1003)::text),
  '2','impact retains authoritative existing target CAS');

-- Query digest is opaque: full PIN/history rows are protected without logging
-- them. Assertions must not mask an undeclared write or a hidden backfill.
-- Exercise deferred invariants too; final ROLLBACK must not hide invalid fixtures.
set constraints all immediate;
create function pg_temp.metadata_digest() returns text language sql stable as $$
  select md5(string_agg(tag||':'||data,'|' order by tag,data)) from (
    select 'target' tag,row_to_json(t)::text data from public.cleaning_targets t union all
    select 'assignment',row_to_json(t)::text from public.cleaning_assignments t union all
    select 'attempt',row_to_json(t)::text from public.cleaning_attempts t union all
    select 'schedule',row_to_json(t)::text from public.cleaning_target_schedule_revisions t union all
    select 'room',row_to_json(t)::text from public.rooms t union all
    select 'type',row_to_json(t)::text from public.room_types t union all
    select 'profile',row_to_json(t)::text from public.profiles t union all
    select 'reservation',row_to_json(t)::text from public.reservations t union all
    select 'obligation',row_to_json(t)::text from public.checkout_cleaning_obligations t union all
    select 'availability',row_to_json(t)::text from public.availability_versions t union all
    select 'day',row_to_json(t)::text from public.availability_days t union all
    select 'audit',row_to_json(t)::text from public.audit_events t union all
    select 'receipt',row_to_json(t)::text from private.command_executions t union all
    select 'notice',row_to_json(t)::text from public.notifications t union all
    select 'group',row_to_json(t)::text from private.notification_groups t union all
    select 'delivery',row_to_json(t)::text from private.notification_delivery_outbox t union all
    select 'outbox',row_to_json(t)::text from private.notification_outbox t union all
    select 'legacy-pin',row_to_json(t)::text from public.room_pin_access_leases t union all
    select 'revision',row_to_json(t)::text from private.room_pin_revisions t union all
    select 'current-pin',row_to_json(t)::text from private.room_current_pin t union all
    select 'entitlement',row_to_json(t)::text from private.room_pin_assignment_entitlements t union all
    select 'reveal',row_to_json(t)::text from private.room_pin_reveal_leases t union all
    select 'activity',row_to_json(t)::text from private.actor_activity_events t
  ) protected
$$;
create temp table read_before as select pg_temp.metadata_digest() value;
select lives_ok($$select private.assignment_target_read_rows(jsonb_build_array(
  jsonb_build_object('cleaningTargetId',pg_temp.metadata_id(1001))))$$,'metadata row enrichment lives');
select is(private.assignment_target_read_rows('[]'::jsonb),'[]'::jsonb,'empty rows stay empty');
select throws_ok($$select private.assignment_target_read_metadata(pg_temp.metadata_id(9999))$$,
  '23514','ASSIGNMENT_TARGET_READ_INVALID','missing target fails closed');
select throws_ok($$select private.assignment_target_read_metadata(pg_temp.metadata_id(1001),pg_temp.metadata_id(2005))$$,
  '23514','ASSIGNMENT_TARGET_READ_INVALID','another target assignment identity fails closed');
select throws_ok($$select private.assignment_target_read_rows(null)$$,'23514','ASSIGNMENT_TARGET_READ_INVALID','null rows fail closed');
select throws_ok($$select private.assignment_target_read_rows('{}'::jsonb)$$,'23514','ASSIGNMENT_TARGET_READ_INVALID','non-array rows fail closed');
select throws_ok($$select private.assignment_target_read_rows((select jsonb_agg(jsonb_build_object(
  'cleaningTargetId',pg_temp.metadata_id(1001))) from generate_series(1,1001)))$$,
  '23514','ASSIGNMENT_TARGET_READ_INVALID','bounded row enrichment rejects overflow');

-- Only server-facing readers authorize actors; the raw private helper must
-- remain unavailable even to service_role, without new raw table privileges.
select ok(not has_function_privilege(role_name,signature,'EXECUTE'),role_name||' cannot execute '||signature)
from unnest(array['anon','authenticated','service_role']) role_name cross join unnest(array[
  'private.assignment_target_read_metadata(uuid,uuid)','private.assignment_target_read_rows(jsonb)',
  'private.assignment_commit_read_metadata(jsonb)']) signature;
select ok(not exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
  where f.oid in('private.assignment_target_read_metadata(uuid,uuid)'::regprocedure,
    'private.assignment_target_read_rows(jsonb)'::regprocedure,'private.assignment_commit_read_metadata(jsonb)'::regprocedure)
  and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC private helper execution stays revoked');
select ok(provolatile='s' and prosecdef and coalesce('search_path=""'=any(proconfig),false),
  proname||' is STABLE with definer-owned empty search path') from pg_proc
where oid in('private.assignment_target_read_metadata(uuid,uuid)'::regprocedure,
  'private.assignment_target_read_rows(jsonb)'::regprocedure,'private.assignment_commit_read_metadata(jsonb)'::regprocedure);
set local role anon;
select throws_ok($$select public.get_assignment_preview_snapshot(pg_temp.metadata_id(1),current_date)$$,
  '42501',null,'anon cannot execute preview reader');
select throws_ok($$select public.get_assignment_commit_impact(pg_temp.metadata_id(1),current_date)$$,
  '42501',null,'anon cannot execute impact reader');
reset role;
set local role authenticated;
select throws_ok($$select public.get_assignment_preview_snapshot(pg_temp.metadata_id(1),current_date)$$,
  '42501',null,'authenticated cannot bypass server preview reader');
select throws_ok($$select public.get_assignment_commit_impact(pg_temp.metadata_id(1),current_date)$$,
  '42501',null,'authenticated cannot bypass server impact reader');
reset role;
set local role service_role;
select throws_ok($$select private.assignment_target_read_metadata(pg_temp.metadata_id(1001))$$,
  '42501',null,'service role cannot invoke raw metadata helper');
select lives_ok($$select public.get_assignment_preview_snapshot(pg_temp.metadata_id(1),
  (clock_timestamp() at time zone 'Asia/Seoul')::date)$$,'active admin can invoke existing server preview reader');
select lives_ok($$select public.get_assignment_commit_impact(pg_temp.metadata_id(1),'2041-06-07')$$,
  'active admin can invoke existing server impact reader');
select throws_ok(format('select public.get_assignment_preview_snapshot(%L,(clock_timestamp() at time zone %L)::date)',
  pg_temp.metadata_id(n),'Asia/Seoul'),'42501',case when n in(4,5) then 'ACTIVE_ACCOUNT_REQUIRED' else 'ADMIN_REQUIRED' end,
  'preview reader rechecks current role/status actor '||n) from unnest(array[2,3,4,5,6]) n;
select throws_ok(format('select public.get_assignment_commit_impact(%L,%L)',pg_temp.metadata_id(n),'2041-06-07'),
  '42501',case when n in(4,5) then 'ACTIVE_ACCOUNT_REQUIRED' else 'ADMIN_REQUIRED' end,
  'impact reader rechecks current role/status actor '||n) from unnest(array[2,3,4,5,6]) n;
reset role;
select is(pg_temp.metadata_digest(),(select value from read_before),'all reads and denied reads leave exact protected ledgers unchanged');

set local transaction_read_only=on;
select lives_ok($$select private.assignment_target_read_metadata(pg_temp.metadata_id(1001))$$,
  'metadata helper executes in actual READ ONLY transaction');
select lives_ok($$select private.assignment_target_read_rows(jsonb_build_array(jsonb_build_object(
  'cleaningTargetId',pg_temp.metadata_id(1001))))$$,'row enrichment executes in actual READ ONLY transaction');
select lives_ok($$select private.assignment_commit_impact_at('2041-06-07','2041-06-07 09:00+09')$$,
  'impact with nested metadata executes in actual READ ONLY transaction');
select lives_ok($$select private.assignment_preview_snapshot_at(pg_temp.metadata_id(1),'2041-06-07','2041-06-07 09:00+09')$$,
  'preview with nested metadata executes in actual READ ONLY transaction');
select is(pg_temp.metadata_digest(),(select value from read_before),'read-only metadata queries never backfill history');
select * from finish();
rollback;
