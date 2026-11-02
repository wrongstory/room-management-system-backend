-- #577: prepared synthetic regression; actual SQL requires final-run approval.
begin;
select no_plan();
-- BEGIN ROOM TYPE FEE FIXTURE
create function pg_temp.fee_id(n integer) returns uuid language sql immutable as $$
  select ('57700000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.fee_id(100+n) from generate_series(1,4)n;
set local role service_role;
select public.bootstrap_first_developer_profile(pg_temp.fee_id(4),pg_temp.fee_id(104),
  'fee-developer','fee-developer','0577','fee-fixture-phone-hash','fee-bootstrap');
reset role;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.fee_id(n),pg_temp.fee_id(100+n),'fee-fixture-'||n,'fee-fixture-'||n,'fee-fixture-'||n,'fee-fixture-'||n,
  0,case when n<3 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
select pg_temp.fee_id(200+n),pg_temp.fee_id(100+n),now(),now(),now()+interval '1 hour' from generate_series(1,4)n;
create temp table fee_initial as select id,base_cleaning_fee,version from public.room_types where code='standard';
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'additional',1,'published',30,'[]',clock_timestamp(),pg_temp.fee_id(1) from fee_initial;
create function pg_temp.fee_write(v bigint,a integer,k text,who integer default 1) returns jsonb language sql as $$
 select public.set_room_type_cleaning_fee(pg_temp.fee_id(who),pg_temp.fee_id(200+who),(select id from fee_initial),v,a,true,k,
   encode(extensions.digest(jsonb_build_array((select id from fee_initial),v,a,true)::text,'sha256'),'hex'))
$$;
create function pg_temp.fee_request(n integer) returns jsonb language plpgsql as $$
declare room public.rooms;
begin
 select r.* into strict room from public.rooms r where r.room_type_id=(select id from fee_initial)
   and r.active and r.data_status='verified' order by r.room_number offset n limit 1;
 return public.create_manual_cleaning_request(pg_temp.fee_id(1),pg_temp.fee_id(1000+n),room.id,null,'additional',
   (transaction_timestamp() at time zone 'Asia/Seoul')::date,transaction_timestamp(),transaction_timestamp()+interval '1 hour',
   room.state_version,'ADMIN_ADDITIONAL_REQUEST','fee577-request-'||n,encode(extensions.digest('fee-request-'||n,'sha256'),'hex'));
end $$;
-- END ROOM TYPE FEE FIXTURE
select pg_temp.fee_request(1);
select is(pg_temp.fee_write((select version from fee_initial),18000,'fee577-raise')->>'baseCleaningFee','18000','admin raises catalog fee');
select is((select version from public.room_types where id=(select id from fee_initial)),(select version+1 from fee_initial),'managed catalog version advances');
select pg_temp.fee_request(2);
select is((select fee_snapshot from public.cleaning_targets where id=pg_temp.fee_id(1002)),18000,'new ordinary request snapshots new fee');
select is((select fee_snapshot from public.cleaning_targets where id=pg_temp.fee_id(1001)),(select base_cleaning_fee from fee_initial),'existing target preserves old fee');
select is(pg_temp.fee_write((select version+1 from fee_initial),9000,'fee577-lower',2)->>'baseCleaningFee','9000','another admin lowers fee');
select pg_temp.fee_request(3);
select is((select fee_snapshot from public.cleaning_targets where id=pg_temp.fee_id(1003)),9000,'new target follows lower fee');
select is(pg_temp.fee_write((select version+2 from fee_initial),0,'fee577-zero')->>'baseCleaningFee','0','explicit zero is valid');
select pg_temp.fee_request(4);
select is((select fee_snapshot from public.cleaning_targets where id=pg_temp.fee_id(1004)),0,'zero snapshot never falls back to current/default');
select is(pg_temp.fee_write((select version from fee_initial),18000,'fee577-raise')->>'baseCleaningFee','18000','old receipt replay is exact despite later edits');
select throws_ok($$select pg_temp.fee_write((select version from fee_initial),20000,'fee577-stale')$$,'40001','STALE_VERSION','stale editor cannot overwrite');
select throws_ok($$select pg_temp.fee_write((select version from fee_initial),19000,'fee577-raise')$$,'23505','IDEMPOTENCY_KEY_REUSED','same key with different fee rejected');
select is(pg_temp.fee_write((select version+3 from fee_initial),0,'fee577-noop')->>'version',(select (version+3)::text from fee_initial),'same current fee is a no-op without artificial version');
select is((select count(*) from public.audit_events where event_type='room_type.cleaning_fee_changed'),3::bigint,'only actual changes append audits');
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),-1,'fee577-negative')$$,'22023','ROOM_TYPE_CLEANING_FEE_INVALID','negative refused');
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),1073741824,'fee577-overflow')$$,'22023','ROOM_TYPE_CLEANING_FEE_INVALID','base plus bomb integer overflow refused');
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),17000,'fee577-maid',3)$$,'42501','ADMIN_REQUIRED','maid cannot set fee');
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),17000,'fee577-developer',4)$$,'42501','ADMIN_REQUIRED','developer is not business admin');
update public.profiles set status='inactive' where id=pg_temp.fee_id(1);
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),17000,'fee577-inactive')$$,'42501','ADMIN_REQUIRED','inactive admin cannot change fee');
select throws_ok($$select pg_temp.fee_write((select version from fee_initial),18000,'fee577-raise')$$,'42501','ADMIN_REQUIRED','inactive admin cannot replay old receipt');
update public.profiles set status='active',must_change_password=true where id=pg_temp.fee_id(1);
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),17000,'fee577-password')$$,'42501','PASSWORD_CHANGE_REQUIRED','password gate blocks edit');
select throws_ok($$select pg_temp.fee_write((select version from fee_initial),18000,'fee577-raise')$$,'42501','PASSWORD_CHANGE_REQUIRED','password gate blocks replay');
update public.profiles set must_change_password=false where id=pg_temp.fee_id(1);
update public.profiles set status='upload_only' where id=pg_temp.fee_id(3);
select throws_ok($$select pg_temp.fee_write((select version+3 from fee_initial),17000,'fee577-upload-only',3)$$,'42501','ADMIN_REQUIRED','upload-only maid has no price authority');
update public.profiles set status='active' where id=pg_temp.fee_id(3);
select throws_ok($$select public.set_room_type_cleaning_fee(pg_temp.fee_id(1),pg_temp.fee_id(201),(select id from fee_initial),(select version+3 from fee_initial),17000,false,'fee577-confirm-false',repeat('c',64))$$,'22023','ROOM_TYPE_CLEANING_FEE_INVALID','false confirmation refused');
select throws_ok($$select public.set_room_type_cleaning_fee(pg_temp.fee_id(1),pg_temp.fee_id(201),(select id from fee_initial),(select version+3 from fee_initial),17000,null,'fee577-confirm-null',repeat('c',64))$$,'22023','ROOM_TYPE_CLEANING_FEE_INVALID','missing confirmation refused');
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.fee_id(201);
select throws_ok($$select pg_temp.fee_write((select version from fee_initial),18000,'fee577-raise')$$,'42501','SESSION_REVOKED','replay also checks current session');
update auth.sessions set not_after=clock_timestamp()+interval '1 hour' where id=pg_temp.fee_id(201);
select is(pg_temp.fee_write((select version+3 from fee_initial),1073741823,'fee577-max')->>'baseCleaningFee','1073741823','safe money representation upper bound accepted');
select is(1073741823::integer+1073741823::integer,2147483646,'approved equal bomb bonus remains integer-safe');
select is((select array_agg(fee_snapshot order by id) from public.cleaning_targets where id in(pg_temp.fee_id(1001),pg_temp.fee_id(1002),pg_temp.fee_id(1003),pg_temp.fee_id(1004))),
  array[(select base_cleaning_fee from fee_initial),18000,9000,0],'all existing target snapshots stay immutable');
select ok(not has_function_privilege('authenticated','public.set_room_type_cleaning_fee(uuid,uuid,uuid,bigint,integer,boolean,text,text)','EXECUTE'),'client role cannot invoke privileged RPC');
select ok(has_function_privilege('service_role','public.set_room_type_cleaning_fee(uuid,uuid,uuid,bigint,integer,boolean,text,text)','EXECUTE'),'service role has exact RPC only');
select * from finish();
rollback;
