\set ON_ERROR_STOP on

begin;

create function pg_temp.checkout_upgrade_id(n integer) returns uuid
language sql immutable as $$
  select ('f3310000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id)
values (pg_temp.checkout_upgrade_id(101)),(pg_temp.checkout_upgrade_id(102));

insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.checkout_upgrade_id(1),pg_temp.checkout_upgrade_id(101),'upgrade-admin','upgrade-admin',
    'upgrade-admin','upgrade-admin',0,'admin','active',false),
  (pg_temp.checkout_upgrade_id(2),pg_temp.checkout_upgrade_id(102),'upgrade-maid','upgrade-maid',
    'upgrade-maid','upgrade-maid',0,'maid','active',false);

do $$
declare
  admin_id uuid:=pg_temp.checkout_upgrade_id(1);
  maid_id uuid:=pg_temp.checkout_upgrade_id(2);
  fixture_reservation_id uuid:=pg_temp.checkout_upgrade_id(300);
  room public.rooms;
  target_id uuid;
  assignment_id uuid;
  pin_revision_id uuid:=pg_temp.checkout_upgrade_id(700);
  availability_id uuid:=pg_temp.checkout_upgrade_id(800);
  service_date date:=((clock_timestamp() at time zone 'Asia/Seoul')::date+1);
  week_start date;
  at_time timestamptz:=date_trunc('minute',clock_timestamp());
  result jsonb;
begin
  select * into room from public.rooms order by room_number limit 1;
  insert into public.cleaning_template_versions(
    room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
  ) values(room.room_type_id,'checkout',6,'published',60,jsonb_build_array(jsonb_build_object(
    'slotKey','room-proof','required',true,'displayOrder',0,'sectionKey','checkout',
    'label','객실 증빙','description','v53 upgrade fixture','instanceNumber',1,'instanceCount',1
  )),at_time,admin_id);

  insert into private.room_pin_revisions(
    id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,
    aad_environment,aad_project_ref,recorded_by,recorded_by_role,source
  ) values(
    pin_revision_id,room.id,1,1,
    extensions.digest(convert_to(room.id::text||':v53:cipher','UTF8'),'sha256'),
    substring(extensions.digest(convert_to(room.id::text||':v53:nonce','UTF8'),'sha256') for 12),
    substring(extensions.digest(convert_to(room.id::text||':v53:tag','UTF8'),'sha256') for 16),
    'upgrade-v53','test','local',admin_id,'admin','admin_initial_entry'
  );
  insert into private.room_current_pin(room_id,pin_revision_id,pin_version)
  values(room.id,pin_revision_id,1);
  insert into public.room_pin_sync_events(
    room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
  ) values(room.id,'verified',1,'UPGRADE_FIXTURE',admin_id,at_time);

  result:=public.create_reservation(
    admin_id,fixture_reservation_id,room.id,
    ((service_date-2)+time '16:00') at time zone 'Asia/Seoul',
    (service_date+time '11:00') at time zone 'Asia/Seoul',2,null,room.state_version,
    'checkout-upgrade-create',repeat('1',64)
  );
  select obligation.planned_cleaning_target_id into target_id
  from public.checkout_cleaning_obligations obligation
  where obligation.reservation_id=fixture_reservation_id;

  week_start:=service_date-(extract(isodow from service_date)::integer-1);
  insert into public.availability_versions(
    id,maid_profile_id,week_start,version,submitted_at
  ) values(availability_id,maid_id,week_start,1,at_time);
  insert into public.availability_days(availability_version_id,work_date,available)
  select availability_id,week_start+i,true from generate_series(0,6) i;

  result:=public.save_cleaning_assignment_draft(
    admin_id,target_id,maid_id,1,1,'checkout-upgrade-draft',repeat('2',64)
  );
  assignment_id:=(result->>'assignmentId')::uuid;
  perform private.commit_and_notify_assignments_at(
    admin_id,service_date,
    private.assignment_commit_impact_at(service_date,at_time)->>'impactFingerprint',
    jsonb_build_array(jsonb_build_object(
      'cleaningTargetId',target_id,
      'expectedAssignmentVersion',(select assignment_version from public.cleaning_targets where id=target_id),
      'expectedAvailabilityVersion',1
    )),
    'checkout-upgrade-notify',repeat('3',64),at_time
  );
  update public.reservations set actual_check_in_at=check_in_at where id=fixture_reservation_id;
  perform public.manual_checkout_reservation(
    admin_id,fixture_reservation_id,1,'TEST_GUEST_DEPARTED',at_time,
    'checkout-upgrade-checkout',repeat('4',64)
  );
  perform public.process_due_assignment_lifecycle(
    admin_id,at_time+interval '1 minute','checkout-upgrade-activate',repeat('5',64)
  );
end $$;

commit;
