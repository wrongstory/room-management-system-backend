begin;
select no_plan();

create function pg_temp.id(n integer) returns uuid language sql immutable as $$
  select ('f1940098-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.room_id() returns uuid language sql stable as $$
  select id from public.rooms order by room_number limit 1
$$;
create function pg_temp.room_number() returns text language sql stable as $$
  select room_number from public.rooms where id=pg_temp.room_id()
$$;

insert into auth.users(id) values(pg_temp.id(101)),(pg_temp.id(102));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password)
values
  (pg_temp.id(1),pg_temp.id(101),'Outbox Admin','Outbox Admin','outbox-admin','outbox-admin',0,
    'admin','active',false),
  (pg_temp.id(2),pg_temp.id(102),'Outbox Maid','Outbox Maid','outbox-maid','outbox-maid',0,
    'maid','active',false);
insert into auth.sessions(id,user_id) values
  (pg_temp.id(201),pg_temp.id(101)),(pg_temp.id(202),pg_temp.id(102));

create temp table result(label text primary key,value jsonb);
insert into result values('pin-prepare',public.prepare_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),0::bigint,pg_temp.room_number(),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'b3V0Ym94','CQkJCQkJCQkJCQkJ','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','outbox-contract-pin-prepare',repeat('9',64)));
insert into result values('pin-confirm',public.confirm_room_pin_change(
  pg_temp.id(1),pg_temp.id(201),pg_temp.room_id(),
  ((select value->>'lease_id' from result where label='pin-prepare'))::uuid,0::bigint,
  'outbox-contract-pin-confirm',repeat('8',64)));

insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
  original_service_date,effective_service_date,available_from,due_at,status,
  assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
values(pg_temp.id(301),pg_temp.room_id(),'additional','manual_room_request',
  'pin-entitlement-outbox-mismatch',current_date,current_date,clock_timestamp()-interval '1 hour',
  clock_timestamp()+interval '1 day','notified',2,'{}',10000,'{}',pg_temp.id(1));
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,
  revision,notified_at,changed_by)
values(pg_temp.id(401),pg_temp.id(301),pg_temp.id(2),1,2,clock_timestamp(),pg_temp.id(1));
insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,
  started_at,ends_at)
values(pg_temp.id(501),pg_temp.id(2),'cleaning_assignment_notified','room',pg_temp.room_id(),
  transaction_timestamp(),transaction_timestamp()+interval '10 minutes');
insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,
  cleaning_target_id,dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,
  event_family,source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,
  notification_group_id)
values(pg_temp.id(601),pg_temp.id(2),'cleaning_assignment_notified','assignment','assignment',
  pg_temp.room_id(),pg_temp.id(301),'pin-entitlement-outbox-mismatch',true,clock_timestamp(),1,
  pg_temp.id(1),'assignment.commit_notified','cleaning_assignment',pg_temp.id(401)::text,
  'cleaningTarget',pg_temp.id(301),pg_temp.id(501));

-- This is a catalog-valid outbox family, but it does not match the positive
-- notification family and therefore cannot become durable PIN authority.
insert into private.notification_delivery_outbox(id,notification_id,event_family)
values(pg_temp.id(701),pg_temp.id(601),'assignment.scheduled_rolled_over');

select ok(not exists(select 1 from private.pin_assignment_outbox_evidence(pg_temp.id(401))
  where outbox_id=pg_temp.id(701)),
  'a denied or mismatched outbox family is never authoritative evidence');
select is((select count(*)::int from private.room_pin_assignment_entitlements
  where assignment_id=pg_temp.id(401)),0,
  'a positive notification paired with a denied outbox family grants no entitlement');

select * from finish();
rollback;
