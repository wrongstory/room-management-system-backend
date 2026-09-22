create function pg_temp.eid(n integer) returns uuid language sql immutable as $$
  select ('f1940063-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.e_room() returns uuid language sql stable as $$
  select id from public.rooms order by room_number limit 1
$$;
create function pg_temp.e_room_number() returns text language sql stable as $$
  select room_number from public.rooms where id=pg_temp.e_room()
$$;

insert into auth.users(id) values(pg_temp.eid(101)),(pg_temp.eid(102)),(pg_temp.eid(103));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values
  (pg_temp.eid(1),pg_temp.eid(101),'Upgrade Admin','Upgrade Admin','upgrade-admin','upgrade-admin',0,'admin','active',false),
  (pg_temp.eid(2),pg_temp.eid(102),'Upgrade Maid','Upgrade Maid','upgrade-maid','upgrade-maid',0,'maid','active',false),
  (pg_temp.eid(3),pg_temp.eid(103),'Upgrade Inactive','Upgrade Inactive','upgrade-inactive','upgrade-inactive',0,'maid','active',false);
insert into auth.sessions(id,user_id) values(pg_temp.eid(201),pg_temp.eid(101)),(pg_temp.eid(202),pg_temp.eid(102));

create temp table upgrade_result(label text primary key,value jsonb);
insert into upgrade_result values('prepare',public.prepare_room_pin_change(
  pg_temp.eid(1),pg_temp.eid(201),pg_temp.e_room(),0::bigint,pg_temp.e_room_number(),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'dXBncmFkZQ==','ExMTExMTExMTExMT','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','upgrade-pin-prepare',repeat('a',64)));
insert into upgrade_result values('confirm',public.confirm_room_pin_change(
  pg_temp.eid(1),pg_temp.eid(201),pg_temp.e_room(),
  ((select value->>'lease_id' from upgrade_result where label='prepare'))::uuid,0::bigint,
  'upgrade-pin-confirm',repeat('b',64)));

create function pg_temp.e_assignment(n integer,p_maid uuid,p_status public.cleaning_target_status,p_current boolean)
returns uuid language plpgsql as $$
declare target_id uuid:=pg_temp.eid(300+n); assignment_id uuid:=pg_temp.eid(400+n);
  group_id uuid:=pg_temp.eid(500+n); notification_id uuid:=pg_temp.eid(600+n); outbox_id uuid:=pg_temp.eid(700+n);
begin
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(target_id,pg_temp.e_room(),'additional','manual_room_request','upgrade-entitlement-'||n,current_date,current_date,
    clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day',p_status,2,'{}',10000,'{}',pg_temp.eid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
    is_current,notified_at,ended_at,change_reason_code,changed_by)
  values(assignment_id,target_id,p_maid,n,2,p_current,clock_timestamp(),
    case when p_current then null else clock_timestamp() end,
    case when p_current then null else 'UPGRADE_NONCURRENT' end,pg_temp.eid(1));
  insert into private.notification_groups(id,recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at)
  values(group_id,p_maid,'cleaning_assignment_notified','room',pg_temp.e_room(),
    date_trunc('minute',statement_timestamp()),date_trunc('minute',statement_timestamp())+interval '10 minutes');
  insert into public.notifications(id,recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at,contract_version,actor_profile_id,event_family,
    source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id)
  values(notification_id,p_maid,'cleaning_assignment_notified','assignment','assignment',pg_temp.e_room(),target_id,
    'upgrade-entitlement-'||n,true,clock_timestamp(),1,pg_temp.eid(1),'assignment.commit_notified',
    'cleaning_assignment',assignment_id::text,'cleaningTarget',target_id,group_id);
  insert into private.notification_delivery_outbox(id,notification_id,event_family)
  values(outbox_id,notification_id,'assignment.commit_notified');
  return assignment_id;
end $$;

select pg_temp.e_assignment(1,pg_temp.eid(2),'notified',true);
select pg_temp.e_assignment(2,pg_temp.eid(3),'notified',true);
select pg_temp.e_assignment(3,pg_temp.eid(2),'notified',true);
select pg_temp.e_assignment(4,pg_temp.eid(2),'notified',false);
update public.profiles set status='inactive' where id=pg_temp.eid(3);
update public.cleaning_targets set status='approved' where id=pg_temp.eid(303);

-- The authoritative notification exists while a physical PIN change is
-- unresolved. Migration 64 must preserve that mismatch and still backfill
-- the durable entitlement bound to the unchanged current revision.
insert into upgrade_result values('mismatch-prepare',public.prepare_room_pin_change(
  pg_temp.eid(1),pg_temp.eid(201),pg_temp.e_room(),1::bigint,pg_temp.e_room_number(),null,null,null,
  'ADMIN_PHYSICAL_CHANGE',1::smallint,'dXBncmFkZS1uZXh0','FBQUFBQUFBQUFBQU',
  'AAAAAAAAAAAAAAAAAAAAAA==','v1','test','local','upgrade-pin-mismatch',repeat('c',64)));

insert into private.room_pin_reveal_leases(id,room_id,pin_revision_id,pin_version,actor_profile_id,
  actor_role_snapshot,issued_at,expires_at,finalized_at,request_id)
select pg_temp.eid(801),pin.room_id,pin.pin_revision_id,pin.pin_version,pg_temp.eid(1),'admin',
  clock_timestamp()-interval '10 seconds',clock_timestamp()+interval '10 seconds',null,pg_temp.eid(901)
from private.room_current_pin pin where pin.room_id=pg_temp.e_room();
insert into private.room_pin_reveal_leases(id,room_id,pin_revision_id,pin_version,actor_profile_id,
  actor_role_snapshot,issued_at,expires_at,finalized_at,request_id)
select pg_temp.eid(802),pin.room_id,pin.pin_revision_id,pin.pin_version,pg_temp.eid(1),'admin',
  clock_timestamp()-interval '20 seconds',clock_timestamp()+interval '5 seconds',clock_timestamp()-interval '10 seconds',pg_temp.eid(902)
from private.room_current_pin pin where pin.room_id=pg_temp.e_room();

-- v63 allowed an expired maid reveal to remain unfinalized indefinitely. It
-- carries the old attempt/access-lease binding and must be revoked without
-- rewriting that identity when migration 64 replaces the authorization model.
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
  attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
values(pg_temp.eid(850),pg_temp.eid(301),pg_temp.eid(401),pg_temp.eid(2),1,
  'scheduled',2,'{}',jsonb_build_object('roomId',pg_temp.e_room()));
insert into public.room_pin_access_leases(id,room_id,cleaning_target_id,assignment_id,attempt_id,
  pin_version,issued_to,issued_at,expires_at,revoked_at,revoke_reason_code)
select pg_temp.eid(851),pin.room_id,pg_temp.eid(301),pg_temp.eid(401),pg_temp.eid(850),
  pin.pin_version,pg_temp.eid(2),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',
  clock_timestamp()-interval '90 minutes','TEST_UPGRADE_EXPIRED'
from private.room_current_pin pin where pin.room_id=pg_temp.e_room();
insert into private.room_pin_reveal_leases(id,room_id,pin_revision_id,pin_version,actor_profile_id,
  actor_role_snapshot,assignment_id,attempt_id,authoritative_access_lease_id,
  issued_at,expires_at,finalized_at,request_id)
select pg_temp.eid(803),pin.room_id,pin.pin_revision_id,pin.pin_version,pg_temp.eid(2),'maid',
  pg_temp.eid(401),pg_temp.eid(850),pg_temp.eid(851),
  statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '90 seconds',null,pg_temp.eid(903)
from private.room_current_pin pin where pin.room_id=pg_temp.e_room();
