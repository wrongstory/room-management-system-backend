begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('e1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.room_id(n integer) returns uuid language sql stable as $$
  select id from public.rooms order by room_number offset n-1 limit 1
$$;
create function pg_temp.room_number(n integer) returns text language sql stable as $$
  select room_number from public.rooms where id=pg_temp.room_id(n)
$$;
create function pg_temp.developer_id() returns uuid language sql stable as $$
  select id from public.profiles where role='developer' limit 1
$$;

insert into auth.users(id) values(pg_temp.pid(101)),(pg_temp.pid(102)),(pg_temp.pid(103)),(pg_temp.pid(104));
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),
  'PIN DEVELOPER','pin developer','0004','pin-developer-phone-hash','pin-developer-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values
  (pg_temp.pid(1),pg_temp.pid(101),'PIN 관리자','PIN 관리자','pin-admin','pin-admin',0,'admin','active',false),
  (pg_temp.pid(2),pg_temp.pid(102),'PIN 메이드','PIN 메이드','pin-maid','pin-maid',0,'maid','active',false),
  (pg_temp.pid(3),pg_temp.pid(103),'다른 메이드','다른 메이드','pin-other','pin-other',0,'maid','active',false);
insert into auth.sessions(id,user_id) values
  (pg_temp.pid(201),pg_temp.pid(101)),(pg_temp.pid(202),pg_temp.pid(102)),(pg_temp.pid(203),pg_temp.pid(103));

-- Upgrade regression: an old public "verified" marker is not an encrypted credential.
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
values(pg_temp.room_id(1),'verified',1,'LEGACY_VERIFIED_FIXTURE',pg_temp.pid(1),clock_timestamp());
select is(private.current_pin_sync_status(pg_temp.room_id(1)),'unconfigured',
  'legacy verified event without encrypted current pointer is never ready');
select is((select allocation_ready from public.get_room_operational_projection(pg_temp.pid(1),pg_temp.room_id(1))),false,
  'legacy sync-only room is blocked by the authoritative allocation readiness projection');
select ok(array_position((select reason_codes
  from public.get_room_operational_projection(pg_temp.pid(1),pg_temp.room_id(1))),'DATA_UNCONFIRMED') is not null,
  'legacy sync-only room reports the stable unconfigured readiness reason');

create temp table pin_results(label text primary key,value jsonb);
insert into pin_results values('initial',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(1),0,pg_temp.room_number(1),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'Y2FuZGlkYXRl','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-initial-0001',repeat('a',64)));
select is((select value->>'status' from pin_results where label='initial'),'prepared','admin prepares initial physical change');
select is(private.current_pin_sync_status(pg_temp.room_id(1)),'mismatch','prepare immediately exposes unresolved mismatch');
select is((select count(*)::int from private.room_current_pin where room_id=pg_temp.room_id(1)),0,
  'prepare never advances current pointer');
select is((select count(*)::int from public.room_pin_sync_events where room_id=pg_temp.room_id(1)
  and sync_status='mismatch' and reason_code='PIN_PHYSICAL_CHANGE_PREPARED'),1,'prepare appends safe mismatch event');
select ok(not exists(select 1 from public.audit_events where entity_id=pg_temp.room_id(1)
  and (after_state::text like '%Y2FuZGlkYXRl%' or after_state::text like '%AAAAAAAAAAAAAAAA%')),
  'audit state contains no envelope material');

insert into pin_results values('confirmed',public.confirm_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='initial'))::uuid,0,
  'pin-confirm-0001',repeat('b',64)));
insert into pin_results values('confirmed-replay',public.confirm_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='initial'))::uuid,0,
  'pin-confirm-0001',repeat('b',64)));
select is((select value from pin_results where label='confirmed-replay'),
  (select value from pin_results where label='confirmed'),'admin confirm response-loss retry replays the safe receipt');
select is((select pin_version from private.room_current_pin where room_id=pg_temp.room_id(1)),1::bigint,
  'confirm atomically establishes version one current pointer');
select is(private.current_pin_sync_status(pg_temp.room_id(1)),'verified','exact current revision plus exact public event is verified');
select is((select count(*)::int from private.room_pin_revisions where room_id=pg_temp.room_id(1)),1,
  'confirm appends one immutable revision');
select is((select count(*)::int from private.room_pin_sheet_sync_outbox where room_id=pg_temp.room_id(1)),1,
  'confirm creates one safe Phase-B outbox item');
select is((select count(*)::int from public.audit_events where entity_id=pg_temp.room_id(1)
  and event_type='room.pin_change_confirmed'),1,'admin confirm replay appends no duplicate audit event');

select throws_ok(format('update public.rooms set room_number=%L where id=%L',pg_temp.room_number(1)||'X',pg_temp.room_id(1)),
  '55000','ROOM_PIN_REISSUE_REQUIRED','room number cannot silently rewrite an established credential');
select throws_ok($$update private.room_pin_revisions set key_version='v2'$$,'55000','APPEND_ONLY_LEDGER',
  'encrypted revision is immutable');
select throws_ok($$update private.room_pin_sheet_sync_outbox set room_id=pg_temp.room_id(2)$$,
  '55000','ROOM_PIN_SHEET_OUTBOX_IDENTITY_IMMUTABLE','sheet outbox identity and safe content are immutable');

-- Initial setup room-number race: the snapshot read before encryption must still match under the prepare lock.
create temp table room_race(room_id uuid,old_number text);
insert into room_race select pg_temp.room_id(2),pg_temp.room_number(2);
update public.rooms set room_number='998' where id=(select room_id from room_race);
select throws_ok(format($sql$select public.prepare_room_pin_change(
  %L,%L,%L,0,%L,null,null,null,'ADMIN_INITIAL_PIN',1::smallint,'YQ==','AQEBAQEBAQEBAQEB',
  'AAAAAAAAAAAAAAAAAAAAAA==','v1','test','local','pin-race-0001',%L)$sql$,
  pg_temp.pid(1),pg_temp.pid(201),(select room_id from room_race),(select old_number from room_race),repeat('c',64)),
  '40001','ROOM_NUMBER_CHANGED','stale room-number prefix fails closed at prepare');
select is((select count(*)::int from private.room_pin_change_leases where room_id=(select room_id from room_race)),0,
  'room-number race persists no stale-prefix lease');

-- An expired initial v0 physical change has no old PIN to roll back to. Actual
-- PIN re-entry is the only recovery and establishes the first encrypted current.
insert into pin_results values('expired-initial',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),0,pg_temp.room_number(3),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'aW5pdGlhbA==','AwMDAwMDAwMDAwMD','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-expired-initial',repeat('2',64)));
update private.room_pin_change_leases set prepared_at=clock_timestamp()-interval '6 minutes',
  expires_at=clock_timestamp()-interval '2 minutes'
where id=((select value->>'lease_id' from pin_results where label='expired-initial'))::uuid;
insert into pin_results values('initial-reentry',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),0,pg_temp.room_number(3),null,null,null,
  'ACTUAL_PIN_REENTRY',1::smallint,'cmVlbnRyeQ==','BAQEBAQEBAQEBAQE','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-initial-reentry',repeat('3',64)));
insert into pin_results values('initial-reentry-confirm',public.confirm_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),
  ((select value->>'lease_id' from pin_results where label='initial-reentry'))::uuid,0,
  'pin-initial-reentry-confirm',repeat('4',64)));
insert into pin_results values('expired-initial-prepare-replay',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),0,pg_temp.room_number(3),null,null,null,
  'ADMIN_INITIAL_PIN',1::smallint,'aW5pdGlhbA==','AwMDAwMDAwMDAwMD','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-expired-initial',repeat('2',64)));
select is((select value->>'status' from pin_results where label='expired-initial-prepare-replay'),'prepared',
  'prepare replay returns the immutable initial response after expiry and re-entry resolution');
select is((select value->>'replay' from pin_results where label='expired-initial-prepare-replay'),'true',
  'resolved historical prepare is identified as a replay for trusted plaintext comparison');
select is((select pin_version from private.room_current_pin where room_id=pg_temp.room_id(3)),1::bigint,
  'actual re-entry recovers expired initial setup by establishing version one');
select is((select status from private.room_pin_change_leases
  where id=((select value->>'lease_id' from pin_results where label='expired-initial'))::uuid),'resolved_by_reentry',
  'initial expired mismatch is resolved only by confirmed re-entry');
select throws_ok(format($sql$select public.prepare_room_pin_change(
  %L,%L,%L,1,%L,null,null,null,'ACTUAL_PIN_REENTRY',1::smallint,'bm90YWxsb3dlZA==','BQUFBQUFBQUFBQUF',
  'AAAAAAAAAAAAAAAAAAAAAA==','v1','test','local','pin-reentry-misuse',%L)$sql$,
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(1),pg_temp.room_number(1),repeat('5',64)),
  '23514','INVALID_PIN_CHANGE_REASON','actual re-entry is rejected without an unresolved expired mismatch');

insert into pin_results values('multi-expiry-physical',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),1,pg_temp.room_number(3),null,null,null,
  'ADMIN_PHYSICAL_CHANGE',1::smallint,'bXVsdGkx','BwcHBwcHBwcHBwcH','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-multi-expiry-physical',repeat('8',64)));
update private.room_pin_change_leases set prepared_at=clock_timestamp()-interval '6 minutes',
  expires_at=clock_timestamp()-interval '2 minutes'
where id=((select value->>'lease_id' from pin_results where label='multi-expiry-physical'))::uuid;
insert into pin_results values('multi-expiry-reentry',public.prepare_room_pin_change(
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),1,pg_temp.room_number(3),null,null,null,
  'ACTUAL_PIN_REENTRY',1::smallint,'bXVsdGky','CAgICAgICAgICAgI','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-multi-expiry-reentry',repeat('9',64)));
update private.room_pin_change_leases set prepared_at=clock_timestamp()-interval '6 minutes',
  expires_at=clock_timestamp()-interval '2 minutes',status='expired',resolved_at=clock_timestamp()
where id=((select value->>'lease_id' from pin_results where label='multi-expiry-reentry'))::uuid;
select is((select count(*)::int from private.room_pin_change_leases
  where room_id=pg_temp.room_id(3) and status='expired'),2,'fixture has two unresolved expired uncertainties');
select lives_ok(format($sql$select public.rollback_room_pin_change(%L,%L,%L,%L,1,%L,%L)$sql$,
  pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(3),
  ((select value->>'lease_id' from pin_results where label='multi-expiry-reentry'))::uuid,
  'pin-multi-expiry-rollback',repeat('0',64)),
  'confirmed rollback resolves every outstanding expired uncertainty for the room');
select is((select count(*)::int from private.room_pin_change_leases
  where room_id=pg_temp.room_id(3) and status='expired'),0,'rollback leaves no stale expired mismatch behind');
select is(private.current_pin_sync_status(pg_temp.room_id(3)),'verified',
  'multi-expiry rollback public result agrees with authoritative readiness');

-- Randomness is backed by a DB uniqueness invariant for separately prepared envelopes.
select throws_ok(format($sql$select public.prepare_room_pin_change(
  %L,%L,%L,0,%L,null,null,null,'ADMIN_INITIAL_PIN',1::smallint,'YQ==','AAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAA==','v1','test','local','pin-nonce-0001',%L)$sql$,
  pg_temp.pid(1),pg_temp.pid(201),(select room_id from room_race),
  (select room_number from public.rooms where id=(select room_id from room_race)),repeat('d',64)),
  '23505',null,'separate prepare cannot reuse a key-version and nonce pair');

-- Current, notified, in-progress maid work and its public access lease are authoritative.
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
values(pg_temp.pid(301),pg_temp.room_id(1),'additional','manual_room_request','pin-work-1',current_date,current_date,
  clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','notified',2,'{}',10000,'{}',pg_temp.pid(1));
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
values(pg_temp.pid(401),pg_temp.pid(301),pg_temp.pid(2),1,2,clock_timestamp()-interval '1 hour',pg_temp.pid(1));
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot,started_at,execution_version)
values(pg_temp.pid(501),pg_temp.pid(301),pg_temp.pid(401),pg_temp.pid(2),1,'scheduled',2,'{}',
  jsonb_build_object('roomId',pg_temp.room_id(1)),null,1);
insert into public.room_pin_access_leases(id,room_id,cleaning_target_id,assignment_id,attempt_id,pin_version,
  issued_to,issued_at,expires_at,revoked_at,revoke_reason_code)
values
  (pg_temp.pid(601),pg_temp.room_id(1),pg_temp.pid(301),pg_temp.pid(401),pg_temp.pid(501),1,
    pg_temp.pid(2),clock_timestamp()-interval '20 minutes',clock_timestamp()+interval '1 hour',null,null),
  (pg_temp.pid(602),pg_temp.room_id(1),pg_temp.pid(301),pg_temp.pid(401),pg_temp.pid(501),1,
    pg_temp.pid(2),clock_timestamp()-interval '20 minutes',clock_timestamp()+interval '1 hour',clock_timestamp(),'TEST_REVOKED');

select throws_ok($$select public.get_room_pin_change_context(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601))$$,'42501','PIN_CHANGE_IN_PROGRESS_REQUIRED',
  'maid cannot prepare a PIN change before starting physical work');
update public.cleaning_attempts set status='in_progress',started_at=clock_timestamp()-interval '30 minutes',execution_version=2
where id=pg_temp.pid(501);
update public.cleaning_targets set available_from=clock_timestamp()+interval '1 hour' where id=pg_temp.pid(301);
select throws_ok($$select public.begin_room_pin_reveal(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),pg_temp.pid(799))$$,'42501','PIN_ACCESS_REQUIRED',
  'maid cannot reveal before available_from');
update public.cleaning_targets set available_from=clock_timestamp()-interval '1 hour' where id=pg_temp.pid(301);

select throws_ok($$select public.get_room_pin_change_context(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,
  pg_temp.pid(401),pg_temp.pid(501),null)$$,'42501','PIN_ACCESS_REQUIRED','maid change requires an authoritative access lease');
select throws_ok($$select public.get_room_pin_change_context(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(602))$$,'42501','PIN_ACCESS_LEASE_REQUIRED',
  'maid change rejects a revoked authoritative access lease');
select throws_ok($$select public.get_room_pin_change_context(pg_temp.pid(3),pg_temp.pid(203),pg_temp.room_id(1),1,
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601))$$,'42501','PIN_ACCESS_REQUIRED',
  'another maid cannot use a known assignment, attempt, and lease');
select lives_ok($$select public.get_room_pin_change_context(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601))$$,'exact maid in-progress lease can inspect change context');

insert into pin_results values('reveal',public.begin_room_pin_reveal(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),pg_temp.pid(701)));
select is((select value->>'aad_environment' from pin_results where label='reveal'),'test','reveal returns immutable stored AAD context');
select lives_ok($$select public.finalize_room_pin_reveal(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='reveal'))::uuid,pg_temp.pid(701))$$,
  'final authorization recheck and sensitive read append succeed together');
select ok((select revealed_at is not null from public.room_pin_access_leases where id=pg_temp.pid(601)),
  'successful maid reveal marks the existing authoritative access lease');
select is((select count(*)::int from private.actor_activity_events where source='edge.sensitive.room_pin'
  and resource_id=pg_temp.room_id(1)),1,'successful reveal appends one safe sensitive.read event');

insert into pin_results values('maid-change',public.prepare_room_pin_change(
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,pg_temp.room_number(1),pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),
  'MAID_CLEANING_CHANGE',1::smallint,'Y2FuZGlkYXRlMg==','AgICAgICAgICAgIC','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-maid-0001',repeat('e',64)));
select is(private.current_pin_sync_status(pg_temp.room_id(1)),'mismatch','maid prepare blocks reveal and readiness immediately');
select throws_ok($$select public.begin_room_pin_reveal(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),pg_temp.pid(702))$$,
  '55000','ROOM_PIN_MISMATCH_UNRESOLVED','unresolved physical mismatch blocks PIN reveal');

delete from auth.sessions where id=pg_temp.pid(202);
select ok(not exists(select 1 from auth.sessions where id=pg_temp.pid(202)),
  'prepared and reveal business leases never block Auth session deletion');
select throws_ok($$select public.confirm_room_pin_change(pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='maid-change'))::uuid,1,'pin-maid-confirm',repeat('f',64))$$,
  '42501','SESSION_REVOKED','revoked session wins before physical-change confirmation');
insert into auth.sessions(id,user_id) values(pg_temp.pid(202),pg_temp.pid(102));

select lives_ok($$select public.rollback_room_pin_change(pg_temp.pid(1),pg_temp.pid(201),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='maid-change'))::uuid,1,'pin-rollback-0001',repeat('1',64))$$,
  'confirmed physical rollback resolves the mismatch against existing current revision');
select is(private.current_pin_sync_status(pg_temp.room_id(1)),'verified','rollback returns exact current version to verified');

insert into pin_results values('maid-confirmed-change',public.prepare_room_pin_change(
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,pg_temp.room_number(1),pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),
  'MAID_CLEANING_CHANGE',1::smallint,'Y2FuZGlkYXRlMw==','BgYGBgYGBgYGBgYG','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-maid-confirmed-prepare',repeat('6',64)));
insert into pin_results values('maid-confirmed-result',public.confirm_room_pin_change(
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='maid-confirmed-change'))::uuid,1,
  'pin-maid-confirmed-confirm',repeat('7',64)));
insert into pin_results values('maid-confirmed-replay',public.confirm_room_pin_change(
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),
  ((select value->>'lease_id' from pin_results where label='maid-confirmed-change'))::uuid,1,
  'pin-maid-confirmed-confirm',repeat('7',64)));
select is((select value from pin_results where label='maid-confirmed-replay'),
  (select value from pin_results where label='maid-confirmed-result'),
  'maid confirm response-loss retry replays after the old authority was revoked');
insert into pin_results values('maid-confirmed-prepare-replay',public.prepare_room_pin_change(
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),1,pg_temp.room_number(1),pg_temp.pid(401),pg_temp.pid(501),pg_temp.pid(601),
  'MAID_CLEANING_CHANGE',1::smallint,'Y2FuZGlkYXRlMw==','BgYGBgYGBgYGBgYG','AAAAAAAAAAAAAAAAAAAAAA==',
  'v1','test','local','pin-maid-confirmed-prepare',repeat('6',64)));
select is((select value->>'status' from pin_results where label='maid-confirmed-prepare-replay'),'prepared',
  'maid prepare replay returns the immutable response after confirm revoked the old authority');
select ok((select value ? 'access_lease_id' from pin_results where label='maid-confirmed-result'),
  'maid confirm returns the atomically reissued access lease identifier');
select ok((select revoked_at is not null and revoke_reason_code='PIN_VERSION_SUPERSEDED'
  from public.room_pin_access_leases where id=pg_temp.pid(601)),
  'maid confirm revokes the superseded authoritative access lease');
select is((select pin_version from public.room_pin_access_leases where id=
  ((select value->>'access_lease_id' from pin_results where label='maid-confirmed-result'))::uuid),2::bigint,
  'maid confirm reissues the same work authority at the new current PIN version');
select is((select count(*)::int from public.room_pin_access_leases where cleaning_target_id=pg_temp.pid(301)
  and pin_version=2),1,'maid confirm replay does not issue a second successor access lease');
select is((select count(*)::int from public.audit_events where entity_id=pg_temp.room_id(1)
  and event_type='room.pin_change_confirmed'),2,'maid confirm replay appends no duplicate audit event');
select is((select count(*)::int from private.room_pin_sheet_sync_outbox where room_id=pg_temp.room_id(1)),3,
  'maid confirm replay appends no duplicate sheet outbox item');
select lives_ok(format($sql$select public.begin_room_pin_reveal(%L,%L,%L,%L,%L,%L,%L)$sql$,
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),pg_temp.pid(401),pg_temp.pid(501),
  ((select value->>'access_lease_id' from pin_results where label='maid-confirmed-result'))::uuid,pg_temp.pid(797)),
  'same in-progress maid can reveal the new PIN through the reissued authoritative lease');

update public.cleaning_attempts set status='field_completed',field_completed_at=statement_timestamp(),ended_at=statement_timestamp(),
  execution_version=3
where id=pg_temp.pid(501);
select throws_ok(format($sql$select public.begin_room_pin_reveal(%L,%L,%L,%L,%L,%L,%L)$sql$,
  pg_temp.pid(2),pg_temp.pid(202),pg_temp.room_id(1),pg_temp.pid(401),pg_temp.pid(501),
  ((select value->>'access_lease_id' from pin_results where label='maid-confirmed-result'))::uuid,pg_temp.pid(798)),
  '42501','PIN_ACCESS_REQUIRED',
  'maid reveal fails closed after the attempt terminal boundary');

select is((select summary from public.list_developer_audit_events(pg_temp.developer_id(),
  array['room.pin_mismatch_resolved'],null,null,null,null,null,10)
  where entity_id=pg_temp.room_id(1) limit 1),
  jsonb_build_object('roomId',pg_temp.room_id(1),'leaseId',
    ((select value->>'lease_id' from pin_results where label='maid-change'))::uuid,'pinVersion',1,'status','verified'),
  'developer PIN audit projection exposes only the approved nonsecret summary');
select ok(not exists(select 1 from public.list_developer_audit_events(pg_temp.developer_id(),
  array['room.pin_change_prepared','room.pin_change_confirmed','room.pin_mismatch_resolved'],null,null,null,null,null,100) e
  where e.summary ?| array['requestHash','ciphertext','nonce','authTag','aadEnvironment','aadProjectRef']),
  'developer PIN audit projection excludes request hashes and envelope material');

select ok(not has_table_privilege(role_name,table_name,'SELECT,INSERT,UPDATE,DELETE'),
  role_name||' has no Data API privileges on '||table_name)
from unnest(array['anon','authenticated','service_role']) role_name
cross join unnest(array[
  'private.room_pin_revisions','private.room_current_pin','private.room_pin_change_leases',
  'private.room_pin_reveal_leases','private.room_pin_sheet_sync_outbox']) table_name;
select ok(to_regclass('private.'||index_name) is not null,index_name||' covers a new private FK path')
from unnest(array[
  'room_pin_revision_recorded_by_idx','room_pin_revision_assignment_idx','room_pin_revision_attempt_idx',
  'room_pin_revision_access_lease_idx','room_pin_change_room_idx','room_pin_change_access_lease_idx',
  'room_pin_reveal_revision_idx','room_pin_reveal_assignment_idx','room_pin_reveal_attempt_idx',
  'room_pin_reveal_access_lease_idx']) index_name;
select ok(not has_function_privilege(role_name,function_name,'EXECUTE'),role_name||' cannot call '||function_name)
from unnest(array['anon','authenticated']) role_name
cross join unnest(array[
  'public.prepare_room_pin_change(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,smallint,text,text,text,text,text,text,text,text)',
  'public.confirm_room_pin_change(uuid,uuid,uuid,uuid,bigint,text,text)',
  'public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
  'public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)']) function_name;
select ok(not exists(select 1 from private.room_pin_change_leases
  where to_jsonb(room_pin_change_leases)::text like '%'||pg_temp.pid(202)::text||'%'),
  'raw Auth session ID is absent from change leases');
select ok(not exists(select 1 from private.room_pin_reveal_leases
  where to_jsonb(room_pin_reveal_leases)::text like '%'||pg_temp.pid(202)::text||'%'),
  'raw Auth session ID is absent from reveal leases');

select * from finish();
rollback;
