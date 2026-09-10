\set ON_ERROR_STOP on

begin;

create function pg_temp.upgrade_pid(n integer) returns uuid language sql immutable as $$
  select ('14000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id)
select pg_temp.upgrade_pid(100+n) from generate_series(1,6)n;

insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.upgrade_pid(1),pg_temp.upgrade_pid(101),'upgrade-admin','upgrade-admin',
    'upgrade-admin','upgrade-admin',0,'admin','active',false),
  (pg_temp.upgrade_pid(2),pg_temp.upgrade_pid(102),'upgrade-open','upgrade-open',
    'upgrade-open','upgrade-open',0,'maid','active',false),
  (pg_temp.upgrade_pid(3),pg_temp.upgrade_pid(103),'upgrade-check-event','upgrade-check-event',
    'upgrade-check-event','upgrade-check-event',0,'maid','active',false),
  (pg_temp.upgrade_pid(4),pg_temp.upgrade_pid(104),'upgrade-check-no-event','upgrade-check-no-event',
    'upgrade-check-no-event','upgrade-check-no-event',0,'maid','active',false),
  (pg_temp.upgrade_pid(5),pg_temp.upgrade_pid(105),'upgrade-paid-event','upgrade-paid-event',
    'upgrade-paid-event','upgrade-paid-event',0,'maid','active',false),
  (pg_temp.upgrade_pid(6),pg_temp.upgrade_pid(106),'upgrade-paid-no-event','upgrade-paid-no-event',
    'upgrade-paid-no-event','upgrade-paid-no-event',0,'maid','active',false);

create function pg_temp.add_upgrade_earning(
  n integer,p_maid integer,p_day date,p_amount integer
) returns uuid language plpgsql as $$
declare
  v_room public.rooms;
  v_target uuid:=pg_temp.upgrade_pid(1000+n);
  v_assignment uuid:=pg_temp.upgrade_pid(2000+n);
  v_attempt uuid:=pg_temp.upgrade_pid(3000+n);
  v_submission uuid:=pg_temp.upgrade_pid(4000+n);
  v_earning uuid:=pg_temp.upgrade_pid(5000+n);
  v_at timestamptz:=(p_day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select * into v_room from public.rooms order by room_number limit 1;
  insert into public.cleaning_targets(
    id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,
    room_type_snapshot,fee_snapshot,template_snapshot,created_by
  ) values(
    v_target,v_room.id,'additional','manual_room_request','upgrade-v39-'||n,p_day,p_day,
    v_at-interval '2 hours',v_at+interval '2 hours','approved',1,
    jsonb_build_object('id',v_room.room_type_id),p_amount,'{}',pg_temp.upgrade_pid(1)
  );
  insert into public.cleaning_assignments(
    id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,
    is_current,notified_at,changed_by
  ) values(
    v_assignment,v_target,pg_temp.upgrade_pid(p_maid),p_day,n+1,1,true,
    v_at-interval '2 hours',pg_temp.upgrade_pid(1)
  );
  insert into public.cleaning_attempts(
    id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
    assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot
  ) values(
    v_attempt,v_target,v_assignment,pg_temp.upgrade_pid(p_maid),1,'approved',1,
    v_at-interval '1 hour',v_at,v_at,'{}',jsonb_build_object('roomId',v_room.id)
  );
  insert into public.cleaning_submissions(
    id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,
    submitted_by,submitted_at
  ) values(
    v_submission,v_attempt,pg_temp.upgrade_pid(6000+n),1,'approved','{}',
    pg_temp.upgrade_pid(p_maid),v_at
  );
  insert into public.inspection_decisions(
    submission_id,decision,reason_code,decided_by,decided_at
  ) values(v_submission,'approved','QUALITY_OK',pg_temp.upgrade_pid(1),v_at);
  insert into public.earnings(
    id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus
  ) values(
    v_earning,v_submission,v_submission,pg_temp.upgrade_pid(p_maid),p_day,p_amount,0
  );
  return v_earning;
end $$;

select pg_temp.add_upgrade_earning(1,2,date '2026-07-07',11000);
select pg_temp.add_upgrade_earning(2,3,date '2026-07-14',12000);
select pg_temp.add_upgrade_earning(3,4,date '2026-07-21',13000);
select pg_temp.add_upgrade_earning(4,5,date '2026-07-28',14000);
select pg_temp.add_upgrade_earning(5,6,date '2026-08-04',15000);

-- v39 accepted free-form operational reasons. These exact values are fixtures,
-- not values that v40 is allowed to create or expose through HTTP.
insert into public.payroll_cycles(
  id,maid_profile_id,week_start,status,version,last_reopen_reason,last_reopened_by,last_reopened_at
) values
  (pg_temp.upgrade_pid(7001),pg_temp.upgrade_pid(2),date '2026-07-06','open',2,
    'LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER',pg_temp.upgrade_pid(1),'2026-07-10T01:00:00Z'),
  (pg_temp.upgrade_pid(7002),pg_temp.upgrade_pid(3),date '2026-07-13','open',1,null,null,null),
  (pg_temp.upgrade_pid(7003),pg_temp.upgrade_pid(4),date '2026-07-20','open',1,null,null,null),
  (pg_temp.upgrade_pid(7004),pg_temp.upgrade_pid(5),date '2026-07-27','open',1,null,null,null),
  (pg_temp.upgrade_pid(7005),pg_temp.upgrade_pid(6),date '2026-08-03','open',1,null,null,null);

insert into public.payroll_items(payroll_cycle_id,earning_id,maid_profile_id,locked_amount) values
  (pg_temp.upgrade_pid(7002),pg_temp.upgrade_pid(5002),pg_temp.upgrade_pid(3),12000),
  (pg_temp.upgrade_pid(7003),pg_temp.upgrade_pid(5003),pg_temp.upgrade_pid(4),13000),
  (pg_temp.upgrade_pid(7004),pg_temp.upgrade_pid(5004),pg_temp.upgrade_pid(5),14000),
  (pg_temp.upgrade_pid(7005),pg_temp.upgrade_pid(5005),pg_temp.upgrade_pid(6),15000);

update public.payroll_cycles set
  status='check',locked_amount=12000,payment_started_by=pg_temp.upgrade_pid(1),
  payment_started_at='2026-07-18T01:00:00Z',check_reason='LEGACY_BANK_STATUS_PENDING',version=2
where id=pg_temp.upgrade_pid(7002);
update public.payroll_cycles set
  status='check',locked_amount=13000,payment_started_by=pg_temp.upgrade_pid(1),
  payment_started_at='2026-07-25T01:00:00Z',check_reason='LEGACY_MANUAL_CHECK',version=2
where id=pg_temp.upgrade_pid(7003);
update public.payroll_cycles set
  status='paid',locked_amount=14000,payment_started_by=pg_temp.upgrade_pid(1),
  payment_started_at='2026-08-01T01:00:00Z',paid_at='2026-08-01T02:00:00Z',
  check_reason='LEGACY_PAID_REVIEW',version=2
where id=pg_temp.upgrade_pid(7004);
update public.payroll_cycles set
  status='paid',locked_amount=15000,payment_started_by=pg_temp.upgrade_pid(1),
  payment_started_at='2026-08-08T01:00:00Z',paid_at='2026-08-08T02:00:00Z',
  check_reason='LEGACY_PAID_MANUAL',version=2
where id=pg_temp.upgrade_pid(7005);

-- Only two of the four historical frozen cycles have authoritative v39
-- payment_started evidence. v40 may backfill attempts only for these rows.
insert into public.payroll_events(
  payroll_cycle_id,maid_profile_id,event_type,before_status,after_status,
  actor_profile_id,cycle_version,locked_amount,occurred_at
) values
  (pg_temp.upgrade_pid(7002),pg_temp.upgrade_pid(3),'payment_started','open','paying',
    pg_temp.upgrade_pid(1),1,12000,'2026-07-18T01:00:00Z'),
  (pg_temp.upgrade_pid(7004),pg_temp.upgrade_pid(5),'payment_started','open','paying',
    pg_temp.upgrade_pid(1),1,14000,'2026-08-01T01:00:00Z');

do $$
begin
  if (select last_reopen_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7001))
      <> 'LEGACY_OPERATOR_CONFIRMED_NO_TRANSFER'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7002))
      <> 'LEGACY_BANK_STATUS_PENDING'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7003))
      <> 'LEGACY_MANUAL_CHECK'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7004))
      <> 'LEGACY_PAID_REVIEW'
    or (select check_reason from public.payroll_cycles where id=pg_temp.upgrade_pid(7005))
      <> 'LEGACY_PAID_MANUAL' then
    raise exception 'UPGRADE_V39_FIXTURE_REASON_MISMATCH';
  end if;
end $$;

commit;
