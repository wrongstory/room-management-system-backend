begin;
select no_plan();

-- PAYROLL_REMITTANCE_FIXTURE_BEGIN
create function pg_temp.mark_id(n integer) returns uuid language sql immutable as $$
  select ('f3310000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.mark_week(n integer) returns date language sql stable as $$
  select date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;
insert into auth.users(id) select pg_temp.mark_id(100+n) from generate_series(1,12)n;
select public.bootstrap_first_developer_profile(pg_temp.mark_id(5),pg_temp.mark_id(105),
  'mark-dev','mark-dev','0324',repeat('d',64),'payroll-mark-developer');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.mark_id(1),pg_temp.mark_id(101),'mark-admin','mark-admin','mark-admin','mark-admin',0,'admin','active',false),
  (pg_temp.mark_id(2),pg_temp.mark_id(102),'mark-maid','mark-maid','mark-maid','mark-maid',0,'maid','active',false),
  (pg_temp.mark_id(3),pg_temp.mark_id(103),'mark-other','mark-other','mark-other','mark-other',0,'maid','active',false),
  (pg_temp.mark_id(4),pg_temp.mark_id(104),'mark-admin-b','mark-admin-b','mark-admin-b','mark-admin-b',0,'admin','active',false),
  (pg_temp.mark_id(6),pg_temp.mark_id(106),'mark-temp','mark-temp','mark-temp','mark-temp',0,'admin','active',true),
  (pg_temp.mark_id(7),pg_temp.mark_id(107),'mark-inactive','mark-inactive','mark-inactive','mark-inactive',0,'admin','inactive',false),
  (pg_temp.mark_id(8),pg_temp.mark_id(108),'mark-departed','mark-departed','mark-departed','mark-departed',0,'maid','departed',false),
  (pg_temp.mark_id(9),pg_temp.mark_id(109),'mark-upload','mark-upload','mark-upload','mark-upload',0,'maid','upload_only',false),
  (pg_temp.mark_id(10),pg_temp.mark_id(110),'mark-pending','mark-pending','mark-pending','mark-pending',0,'maid','deactivation_pending',false),
  (pg_temp.mark_id(11),pg_temp.mark_id(111),'mark-empty','mark-empty','mark-empty','mark-empty',0,'maid','active',false),
  (pg_temp.mark_id(12),pg_temp.mark_id(112),'mark-temp-maid','mark-temp-maid','mark-temp-maid','mark-temp-maid',0,'maid','active',true);
insert into auth.sessions(id,user_id) select pg_temp.mark_id(400+n),pg_temp.mark_id(100+n)
  from generate_series(1,12)n;

create function pg_temp.mark_add_earning(n integer,p_maid integer,p_day date,p_amount integer,
  p_snapshot jsonb default null) returns uuid language plpgsql as $$
declare room public.rooms; at_time timestamptz:=least(
  (p_day::timestamp+time '12:00') at time zone 'Asia/Seoul',statement_timestamp());
begin
  select * into room from public.rooms where room_type_id=(select id from public.room_types where code='standard')
    order by room_number limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by) values(pg_temp.mark_id(1000+n),room.id,'additional',
    'manual_room_request','payroll-mark-'||n,p_day,p_day,at_time-interval '2 hours',at_time+interval '2 hours',
    'approved',1,jsonb_build_object('id',room.room_type_id,'code','standard','name','Frozen standard'),
    p_amount,'{}',pg_temp.mark_id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
    sequence_number,revision,is_current,notified_at,changed_by) values(pg_temp.mark_id(2000+n),
    pg_temp.mark_id(1000+n),pg_temp.mark_id(p_maid),p_day,n+1,1,true,at_time-interval '2 hours',pg_temp.mark_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
    attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,
    template_snapshot,room_snapshot) values(pg_temp.mark_id(3000+n),pg_temp.mark_id(1000+n),
    pg_temp.mark_id(2000+n),pg_temp.mark_id(p_maid),1,'approved',1,at_time-interval '1 hour',
    at_time,at_time,'{}',coalesce(p_snapshot,jsonb_build_object('roomId',room.id,'roomNumber',room.room_number,
      'roomType',jsonb_build_object('code','standard','name','Frozen standard'))));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,
    status,photo_manifest,submitted_by,submitted_at) values(pg_temp.mark_id(4000+n),
    pg_temp.mark_id(3000+n),pg_temp.mark_id(6000+n),1,'approved','{}',pg_temp.mark_id(p_maid),at_time);
  insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
    values(pg_temp.mark_id(7000+n),pg_temp.mark_id(4000+n),'approved','QUALITY_OK',pg_temp.mark_id(1),at_time);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,
    base_amount,bomb_room_bonus) values(pg_temp.mark_id(5000+n),pg_temp.mark_id(4000+n),
    pg_temp.mark_id(4000+n),pg_temp.mark_id(p_maid),p_day,p_amount,0);
  return pg_temp.mark_id(5000+n);
end $$;

select pg_temp.mark_add_earning(1,2,pg_temp.mark_week(-4)+1,10000);
select pg_temp.mark_add_earning(2,3,pg_temp.mark_week(-4)+1,12000);
select pg_temp.mark_add_earning(3,2,pg_temp.mark_week(0),8000);
-- PAYROLL_REMITTANCE_FIXTURE_END

create function pg_temp.mark_get(p_actor integer default 1,p_maid integer default 2,p_week date default pg_temp.mark_week(-4))
returns jsonb language sql stable as $$
  select public.get_payroll_remittance_marker(pg_temp.mark_id(p_actor),pg_temp.mark_id(400+p_actor),
    (select role::text from public.profiles where id=pg_temp.mark_id(p_actor)),pg_temp.mark_id(p_maid),p_week)
$$;
create function pg_temp.mark_set(p_marked boolean,p_version bigint,p_key text,p_fingerprint text default null,
  p_actor integer default 1,p_maid integer default 2,p_week date default pg_temp.mark_week(-4))
returns jsonb language plpgsql as $$
declare fingerprint text:=coalesce(p_fingerprint,pg_temp.mark_get(p_actor,p_maid,p_week)->>'basisFingerprint');
begin
  return public.set_payroll_remittance_marker(pg_temp.mark_id(p_actor),pg_temp.mark_id(400+p_actor),
    (select role::text from public.profiles where id=pg_temp.mark_id(p_actor)),pg_temp.mark_id(p_maid),p_week,
    p_marked,p_version,fingerprint,p_key,encode(extensions.digest(jsonb_build_object(
      'actor',p_actor,'maid',p_maid,'week',p_week,'marked',p_marked,'version',p_version,'fingerprint',fingerprint)::text,'sha256'),'hex'));
end $$;
create function pg_temp.mark_reconfirm(p_version bigint,p_key text,p_fingerprint text default null,
  p_actor integer default 1,p_maid integer default 2,p_week date default pg_temp.mark_week(-4))
returns jsonb language plpgsql as $$
declare fingerprint text:=coalesce(p_fingerprint,pg_temp.mark_get(p_actor,p_maid,p_week)->>'basisFingerprint');
begin
  return public.reconfirm_payroll_remittance_marker(pg_temp.mark_id(p_actor),pg_temp.mark_id(400+p_actor),
    (select role::text from public.profiles where id=pg_temp.mark_id(p_actor)),pg_temp.mark_id(p_maid),p_week,
    p_version,fingerprint,p_key,encode(extensions.digest(jsonb_build_object(
      'actor',p_actor,'maid',p_maid,'week',p_week,'version',p_version,'fingerprint',fingerprint)::text,'sha256'),'hex'));
end $$;
create function pg_temp.mark_financial_hash() returns text language sql stable as $$
  select md5(jsonb_build_object(
    'earnings',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.earnings t),
    'cycles',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_cycles t),
    'items',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_items t),
    'events',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_events t),
    'books',(select coalesce(jsonb_agg(to_jsonb(t) order by maid_profile_id),'[]') from public.payroll_adjustment_books t),
    'adjustments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_adjustments t),
    'adjustmentItems',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_adjustment_items t),
    'carries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_residual_carries t),
    'carryItems',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_carry_items t),
    'settlements',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_offset_settlements t),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payment_attempts t),
    'results',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payment_results t))::text)
$$;
create temporary table marker_results(name text primary key,value jsonb);
insert into marker_results values('financial_before',to_jsonb(pg_temp.mark_financial_hash()));
insert into marker_results values('notifications_before',to_jsonb((select count(*) from public.notifications)));
insert into marker_results values('initial',pg_temp.mark_get());
select is((select value->>'version' from marker_results where name='initial'),'0','absence is conceptual display version zero');
select is((select value->>'marked' from marker_results where name='initial'),'false','absence is unmarked');
select is((select value->>'canSet' from marker_results where name='initial'),'true','closed positive amount can be marked');
select is((select value->>'needsReconfirmation' from marker_results where name='initial'),'false','absence has no re-confirmation');
select is((select value->'confirmedBasis' from marker_results where name='initial'),'null'::jsonb,'absence has no confirmed basis');
select is((select count(*) from private.payroll_remittance_markers),0::bigint,'GET does not materialize marker');
select is((select count(*) from public.payroll_cycles),0::bigint,'GET does not materialize actual cycle');
select is((select count(*) from public.payroll_adjustment_books),0::bigint,'GET does not materialize financial book');
select is((select count(*) from private.command_executions where command_type like 'payroll.remittance.%'),0::bigint,'GET writes no receipt');
select is((select array_agg(key order by key) from jsonb_object_keys(pg_temp.mark_get()) key),
  array['basis','basisFingerprint','canClear','canReconfirm','canSet','confirmedAt','confirmedBasis','confirmedBy',
    'lastChangedAt','lastChangedBy','maidProfileId','marked','needsReconfirmation','setBlockedReason','version','weekStart']::text[],
  'exact marker response whitelist');
select is((select array_agg(key order by key) from jsonb_object_keys(pg_temp.mark_get()->'basis') key),
  array['accrualAmount','adjustmentAmount','carryInAmount','carryOutAmount','lateEarningAmount','lockedAmount','payableAmount','totalAmount']::text[],
  'exact eight financial basis values, no pending/status/version');
select matches(pg_temp.mark_get()->>'basisFingerprint','^[0-9a-f]{64}$','authoritative fingerprint is bounded nonsecret SHA256');
select is(pg_temp.mark_get()->>'basisFingerprint',private.payroll_remittance_fingerprint(pg_temp.mark_get()->'basis'),'fingerprint is canonical DB JSONB tuple');
select is(pg_temp.mark_get(2)->>'canSet','false','maid cannot mark');
select is(pg_temp.mark_get(2)->>'canClear','false','maid cannot clear');
select is(pg_temp.mark_get(2)->>'canReconfirm','false','maid cannot re-confirm');
select is(pg_temp.mark_get(2)->>'setBlockedReason','ADMIN_REQUIRED','maid advisory prioritizes role');
select is(pg_temp.mark_get(2)->'basis',pg_temp.mark_get()->'basis','admin and self maid see same financial basis');
select is(pg_temp.mark_get(1,8)->>'basisFingerprint',private.payroll_remittance_fingerprint(pg_temp.mark_get(1,8)->'basis'),'admin can read former maid history');
select is(pg_temp.mark_get(1,2,pg_temp.mark_week(0))->>'setBlockedReason','PAYROLL_WEEK_NOT_CLOSED','current week read allowed, mark blocked');
select is(pg_temp.mark_get(1,11)->>'setBlockedReason','NO_PAYROLL_AMOUNT','zero amount read allowed, mark blocked');

select throws_ok($$select pg_temp.mark_get(3)$$,'42501','PAYROLL_ACCESS_REQUIRED','other maid read denied');
select throws_ok($$select pg_temp.mark_get(5)$$,'42501','PAYROLL_ACCESS_REQUIRED','developer is not business admin');
select throws_ok($$select pg_temp.mark_get(6)$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary admin denied');
select throws_ok($$select pg_temp.mark_get(7)$$,'42501','PAYROLL_ACCESS_REQUIRED','inactive actor denied');
select throws_ok($$select pg_temp.mark_get(9,9)$$,'42501','PAYROLL_ACCESS_REQUIRED','upload-only is not general payroll access');
select throws_ok($$select pg_temp.mark_get(10,10)$$,'42501','PAYROLL_ACCESS_REQUIRED','deactivation capability cannot read payroll');
select throws_ok($$select pg_temp.mark_get(12,12)$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary maid denied');
select throws_ok($$select pg_temp.mark_get(1,1)$$,'P0002','PAYROLL_MAID_NOT_FOUND','admin target is not a maid');
select throws_ok($$select pg_temp.mark_get(1,2,pg_temp.mark_week(1))$$,'22023','PAYROLL_WEEK_NOT_CLOSED','future week denied');
select throws_ok($$select pg_temp.mark_get(1,2,pg_temp.mark_week(-4)+1)$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','non-Monday denied');
select throws_ok($$select pg_temp.mark_get(1,2,'infinity')$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','infinite week denied');
select throws_ok($$select public.get_payroll_remittance_marker(pg_temp.mark_id(1),pg_temp.mark_id(401),null,pg_temp.mark_id(2),pg_temp.mark_week(-4))$$,
  '42501','PAYROLL_ACCESS_REQUIRED','missing expected role fails closed');
select throws_ok($$select public.get_payroll_remittance_marker(pg_temp.mark_id(1),pg_temp.mark_id(401),'maid',pg_temp.mark_id(2),pg_temp.mark_week(-4))$$,
  '42501','PAYROLL_ACCESS_REQUIRED','role drift binding fails closed');
select throws_ok($$select public.get_payroll_remittance_marker(pg_temp.mark_id(1),pg_temp.mark_id(402),'admin',pg_temp.mark_id(2),pg_temp.mark_week(-4))$$,
  '42501','SESSION_REVOKED','other user session cannot authorize actor');
update auth.sessions set not_after=statement_timestamp() where id=pg_temp.mark_id(401);
select throws_ok($$select pg_temp.mark_get()$$,'42501','SESSION_REVOKED','retained but expired session denied');
update auth.sessions set not_after=null where id=pg_temp.mark_id(401);

insert into marker_results values('noop_false',pg_temp.mark_set(false,0,'marker-noop-false'));
select is((select value->>'version' from marker_results where name='noop_false'),'0','same false no-op returns conceptual zero');
select is((select count(*) from private.payroll_remittance_markers),0::bigint,'same false no-op creates no current marker');
select is((select count(*) from private.payroll_remittance_marker_revisions),0::bigint,'same false no-op creates no history');
select is((select count(*) from private.command_executions where command_type='payroll.remittance.set'),1::bigint,'same false no-op stores replay receipt');
select throws_ok($$select pg_temp.mark_set(true,0,'marker-current',null,1,2,pg_temp.mark_week(0))$$,
  '22023','PAYROLL_WEEK_NOT_CLOSED','new on cannot use current week');
select throws_ok($$select pg_temp.mark_set(true,0,'marker-zero',null,1,11)$$,
  '22023','NO_PAYROLL_AMOUNT','new on requires positive authoritative amount');
select throws_ok($$select pg_temp.mark_set(true,0,'marker-maid',null,2)$$,
  '42501','ADMIN_REQUIRED','maid cannot set');
select throws_ok($$select pg_temp.mark_set(true,-1,'marker-bad-version')$$,
  '22023','INVALID_EXPECTED_VERSION','negative display CAS denied');
select throws_ok($$select pg_temp.mark_set(true,0,'marker-bad-fingerprint','bad')$$,
  '22023','PAYROLL_REMITTANCE_BASIS_FINGERPRINT_INVALID','malformed basis fingerprint denied');
select throws_ok($$select pg_temp.mark_set(null,0,'marker-null-bool')$$,
  '22023','PAYROLL_REMITTANCE_MARKED_INVALID','null boolean denied');
select throws_ok($$select pg_temp.mark_set(true,0,'marker-stale-basis',repeat('0',64))$$,
  '40001','PAYROLL_REMITTANCE_BASIS_CHANGED','different aggregate must reload before marking');
select throws_ok($$select pg_temp.mark_reconfirm(0,'marker-reconfirm-absent')$$,
  '55000','PAYROLL_REMITTANCE_MARKER_NOT_SET','cannot re-confirm absent marker');

insert into marker_results values('on',pg_temp.mark_set(true,0,'marker-first-on'));
select is(pg_temp.mark_get()->>'version','1','first effective on increments marker version');
select is(pg_temp.mark_get()->>'marked','true','effective on is durable');
select is(pg_temp.mark_get()->>'confirmedBy',pg_temp.mark_id(1)::text,'confirmed actor is actual admin');
select is(pg_temp.mark_get()->>'lastChangedBy',pg_temp.mark_id(1)::text,'on is last display change');
select is(pg_temp.mark_get()->'confirmedBasis',pg_temp.mark_get()->'basis','on confirms current authoritative tuple');
select is(pg_temp.mark_get()->>'needsReconfirmation','false','just confirmed tuple needs no re-confirmation');
select is(pg_temp.mark_financial_hash(),(select value#>>'{}' from marker_results where name='financial_before'),'on does not change any financial row');
select is((select count(*) from public.notifications)::text,(select value#>>'{}' from marker_results where name='notifications_before'),'display on sends no actual-payment notification');
select is((select count(*) from public.audit_events where event_type='payroll.remittance_marked'),1::bigint,'effective on creates one safe audit');
select is((select count(*) from private.payroll_remittance_marker_revisions),1::bigint,'effective on creates one immutable history revision');
select is(pg_temp.mark_get(4),pg_temp.mark_get(),'another active administrator reads same current display');
select is(pg_temp.mark_get(2)-array['canSet','canClear','canReconfirm','setBlockedReason'],
  pg_temp.mark_get()-array['canSet','canClear','canReconfirm','setBlockedReason'],'self maid has identical business display and confirmation');
select is(pg_temp.mark_get(1,3)->>'version','0','different maid unchanged');
select is(pg_temp.mark_get(1,2,pg_temp.mark_week(-3))->>'version','0','different week unchanged');
select throws_ok($$select pg_temp.mark_set(false,0,'marker-stale-display')$$,
  '40001','PAYROLL_REMITTANCE_MARKER_STALE_VERSION','display CAS prevents stale concurrent toggle');
select throws_ok($$select pg_temp.mark_reconfirm(1,'marker-no-reconfirm')$$,
  '55000','PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED','explicit re-confirm only when tuple changed');
select is(pg_temp.mark_set(true,0,'marker-first-on',(select value->>'basisFingerprint' from marker_results where name='initial')),
  (select value from marker_results where name='on'),'same key/payload replays first result');
select throws_ok($$select pg_temp.mark_set(false,0,'marker-first-on',(select value->>'basisFingerprint' from marker_results where name='initial'))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same key cannot become opposite toggle');
insert into marker_results values('noop_true',pg_temp.mark_set(true,1,'marker-noop-true'));
select is(pg_temp.mark_get()->>'version','1','same true new key is no-op, not re-confirmation');
select is((select count(*) from private.payroll_remittance_marker_revisions),1::bigint,'same true stores no new history');
select is((select count(*) from public.audit_events where event_type like 'payroll.remittance_%'),1::bigint,'same true stores no new audit');

-- Signed correction changes this week's amount without changing its earning.
select public.record_payroll_correction(pg_temp.mark_id(1),pg_temp.mark_id(5001),null,2000,0,'marker-correction',repeat('a',64));
insert into marker_results values('financial_corrected',to_jsonb(pg_temp.mark_financial_hash()));
insert into marker_results values('changed',pg_temp.mark_get());
select is(pg_temp.mark_get()->>'marked','true','amount change preserves on');
select is(pg_temp.mark_get()->>'version','1','financial amount changes do not mutate display CAS');
select is(pg_temp.mark_get()->>'needsReconfirmation','true','financial tuple change requires re-confirmation');
select is(pg_temp.mark_get()->>'canReconfirm','true','admin gets explicit re-confirm capability');
select isnt(pg_temp.mark_get()->>'basisFingerprint',(select value->>'basisFingerprint' from marker_results where name='on'),'changed amount has different fingerprint');
select is(pg_temp.mark_get()->'confirmedBasis',(select value->'confirmedBasis' from marker_results where name='on'),'original confirmation remains immutable');
select is(pg_temp.mark_set(true,0,'marker-first-on',(select value->>'basisFingerprint' from marker_results where name='initial')),
  (select value from marker_results where name='on'),'old replay is historical success, not new confirmation');
select is(pg_temp.mark_get()->>'needsReconfirmation','true','historical replay does not clear live needs state');
select throws_ok($$select pg_temp.mark_reconfirm(1,'marker-stale-reconfirm',(select value->>'basisFingerprint' from marker_results where name='on'))$$,
  '40001','PAYROLL_REMITTANCE_BASIS_CHANGED','re-confirm requires latest basis CAS');
insert into marker_results values('reconfirmed',pg_temp.mark_reconfirm(1,'marker-reconfirm',null,4));
select is(pg_temp.mark_get()->>'version','2','explicit re-confirm advances display version');
select is(pg_temp.mark_get()->>'marked','true','explicit re-confirm does not toggle off');
select is(pg_temp.mark_get()->>'confirmedBy',pg_temp.mark_id(4)::text,'re-confirm captures second actual admin');
select is(pg_temp.mark_get()->>'lastChangedBy',pg_temp.mark_id(1)::text,'re-confirm preserves last on/off actor');
select is(pg_temp.mark_get()->'lastChangedAt',(select value->'lastChangedAt' from marker_results where name='on'),'re-confirm preserves last on/off instant');
select is(pg_temp.mark_get()->>'needsReconfirmation','false','new confirmation clears tuple mismatch');
select is(pg_temp.mark_financial_hash(),(select value#>>'{}' from marker_results where name='financial_corrected'),'re-confirm does not change financial rows');
select is((select count(*) from private.payroll_remittance_marker_revisions),2::bigint,'re-confirm appends rather than overwrites');
select is((select basis from private.payroll_remittance_marker_revisions where version=1),
  (select value->'confirmedBasis' from marker_results where name='on'),'first history basis still exact');
select is((select count(*) from public.audit_events where event_type='payroll.remittance_reconfirmed'),1::bigint,'re-confirm audit exactly once');

-- Actual financial command is used only to create a valid PAID fixture. Marker
-- off/confirmation never calls it or manufactures a provider reference.
insert into marker_results values('paying',public.start_payroll_cycle(pg_temp.mark_id(1),pg_temp.mark_id(2),pg_temp.mark_week(-4),0,
  'marker-real-start',repeat('b',64)));
select public.record_payroll_payment_paid(pg_temp.mark_id(1),(select (value->>'paymentAttemptId')::uuid from marker_results where name='paying'),
  1,'bank_transfer','FIXTURE-MARKER-331-A','marker-real-paid',repeat('c',64));
insert into marker_results values('financial_paid',to_jsonb(pg_temp.mark_financial_hash()));
insert into marker_results values('paid_cycle',(select to_jsonb(t) from public.payroll_cycles t where maid_profile_id=pg_temp.mark_id(2)));
select is(pg_temp.mark_get()->>'marked','true','actual payment preserves separate display');
select is(pg_temp.mark_get()->>'needsReconfirmation','false','actual start/paid lock metadata alone does not change financial basis');
select is(pg_temp.mark_get()->>'version','2','actual PAID does not advance display version');
select throws_ok($$select pg_temp.mark_reconfirm(2,'marker-paid-reconfirm')$$,
  '55000','PAYROLL_REMITTANCE_RECONFIRM_NOT_REQUIRED','same amount lock/status transition does not require re-confirm');
select pg_temp.mark_add_earning(5,2,pg_temp.mark_week(-4)+2,5000);
insert into marker_results values('financial_late',to_jsonb(pg_temp.mark_financial_hash()));
select is(pg_temp.mark_get()->>'marked','true','late approval after PAID preserves marker on');
select is(pg_temp.mark_get()->>'needsReconfirmation','true','late approval detected despite fixed payable');
select is(pg_temp.mark_get()->'basis'->>'payableAmount','12000','actual locked payable remains unchanged');
select is(pg_temp.mark_get()->'basis'->>'accrualAmount','15000','accrual detects immutable late earning');
select is(pg_temp.mark_get()->'basis'->>'lateEarningAmount','5000','late component remains distinct from payable');
select is((select to_jsonb(t) from public.payroll_cycles t where maid_profile_id=pg_temp.mark_id(2)),
  (select value from marker_results where name='paid_cycle'),'late approval does not rewrite PAID snapshot');
select pg_temp.mark_reconfirm(2,'marker-late-reconfirm');
select is(pg_temp.mark_financial_hash(),(select value#>>'{}' from marker_results where name='financial_late'),'late re-confirm leaves all financial rows exact');
select pg_temp.mark_set(false,3,'marker-clear-paid');
select is(pg_temp.mark_get()->>'marked','false','off clears only display');
select is(pg_temp.mark_get()->>'version','4','off appends display version');
select is(pg_temp.mark_get()->'confirmedBasis','null'::jsonb,'off removes current confirmation only');
select is(pg_temp.mark_get()->'confirmedBy','null'::jsonb,'off has no current confirmed actor');
select is(pg_temp.mark_get()->>'needsReconfirmation','false','off does not claim confirmed state');
select is(pg_temp.mark_financial_hash(),(select value#>>'{}' from marker_results where name='financial_late'),'off does not reopen or alter PAID/payment/earning/adjustments');
select is((select status::text from public.payroll_cycles where maid_profile_id=pg_temp.mark_id(2)),'paid','off never makes paid earning re-payable');
select is((select count(*) from private.payroll_remittance_marker_revisions where event_type='cleared'),1::bigint,'off retains clear event');
select is((select basis from private.payroll_remittance_marker_revisions where version=1),
  (select value->'confirmedBasis' from marker_results where name='on'),'off retains first confirmation history');

-- Exact bounded history; old entries remain append-only and paginated by CAS.
insert into marker_results values('history_first',public.list_payroll_remittance_marker_history(pg_temp.mark_id(1),pg_temp.mark_id(401),
  'admin',pg_temp.mark_id(2),pg_temp.mark_week(-4),null,2));
insert into marker_results values('history_rest',public.list_payroll_remittance_marker_history(pg_temp.mark_id(2),pg_temp.mark_id(402),
  'maid',pg_temp.mark_id(2),pg_temp.mark_week(-4),2,100));
select is(jsonb_array_length((select value->'entries' from marker_results where name='history_first')),2,'history page uses exact limit');
select is((select value->>'hasMore' from marker_results where name='history_first'),'true','history detects next candidate with limit+1');
select is((select value->>'lastVersion' from marker_results where name='history_first'),'2','history cursor is displayed final version');
select is(jsonb_array_length((select value->'entries' from marker_results where name='history_rest')),2,'exclusive afterVersion resumes remaining events');
select is((select value->>'hasMore' from marker_results where name='history_rest'),'false','terminal history page exact');
select is((select value->'entries'->0->>'version' from marker_results where name='history_rest'),'3','history order version ASC');
select is((select value->'entries'->1->>'eventType' from marker_results where name='history_rest'),'cleared','history preserves off as event not deletion');
select is((select array_agg(key order by key) from jsonb_object_keys((select value->'entries'->0 from marker_results where name='history_first')) key),
  array['actorProfileId','basis','eventType','marked','occurredAt','revisionId','version']::text[],'history exact safe whitelist');
select throws_ok($$select public.list_payroll_remittance_marker_history(pg_temp.mark_id(1),pg_temp.mark_id(401),'admin',pg_temp.mark_id(2),pg_temp.mark_week(-4),null,101)$$,
  '22023','PAYROLL_REMITTANCE_HISTORY_LIMIT_INVALID','history technical limit enforced in DB');
select throws_ok($$select public.list_payroll_remittance_marker_history(pg_temp.mark_id(1),pg_temp.mark_id(401),'admin',pg_temp.mark_id(2),pg_temp.mark_week(-4),0,25)$$,
  '22023','PAYROLL_REMITTANCE_HISTORY_CURSOR_INVALID','history cursor must be actual positive version');
select throws_ok($$select public.list_payroll_remittance_marker_history(pg_temp.mark_id(3),pg_temp.mark_id(403),'maid',pg_temp.mark_id(2),pg_temp.mark_week(-4),null,25)$$,
  '42501','PAYROLL_ACCESS_REQUIRED','other maid history denied');
select throws_ok($$update private.payroll_remittance_marker_revisions set basis=basis where version=1$$,
  '23514','PAYROLL_REMITTANCE_HISTORY_IMMUTABLE','even privileged history UPDATE denied');
select throws_ok($$delete from private.payroll_remittance_marker_revisions where version=1$$,
  '23514','PAYROLL_REMITTANCE_HISTORY_IMMUTABLE','even privileged history DELETE denied');
select throws_ok($$delete from private.payroll_remittance_markers$$,
  '23514','PAYROLL_REMITTANCE_MARKER_DELETE_FORBIDDEN','current projection cannot erase ledger identity');
select throws_ok($$update private.payroll_remittance_markers set version=version+2$$,
  '23514','PAYROLL_REMITTANCE_MARKER_INVARIANT_VIOLATION','current CAS must be consecutive');
set constraints all immediate;
select pass('all existing and new commit-time financial and marker constraints hold');
set constraints all deferred;

-- Replays revalidate latest role/status/password and owned live sessions.
update auth.sessions set not_after=statement_timestamp() where id=pg_temp.mark_id(401);
select throws_ok($$select pg_temp.mark_set(true,0,'marker-first-on',(select value->>'basisFingerprint' from marker_results where name='initial'))$$,
  '42501','SESSION_REVOKED','expired session cannot replay old success');
update auth.sessions set not_after=null where id=pg_temp.mark_id(401);
update public.profiles set must_change_password=true where id=pg_temp.mark_id(1);
select throws_ok($$select public.set_payroll_remittance_marker(pg_temp.mark_id(1),pg_temp.mark_id(401),'admin',pg_temp.mark_id(2),pg_temp.mark_week(-4),true,0,
  (select value->>'basisFingerprint' from marker_results where name='initial'),'marker-first-on',
  (select request_hash from private.command_executions where idempotency_key='marker-first-on'))$$,
  '42501','PASSWORD_CHANGE_REQUIRED','password gate also protects replay');
update public.profiles set must_change_password=false where id=pg_temp.mark_id(1);
delete from auth.sessions where id=pg_temp.mark_id(401);
select throws_ok($$select pg_temp.mark_get()$$,'42501','SESSION_REVOKED','deleted session closes read');
insert into auth.sessions(id,user_id) values(pg_temp.mark_id(401),pg_temp.mark_id(101));

select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'private.payroll_remittance_markers'::regclass,'private.payroll_remittance_marker_revisions'::regclass)),'new private tables have RLS defense');
select ok(not exists(select 1 from unnest(array['anon','authenticated','service_role']) role
  cross join unnest(array['private.payroll_remittance_markers','private.payroll_remittance_marker_revisions']) relation
  cross join unnest(array['select','insert','update','delete']) privilege
  where has_table_privilege(role,relation,privilege)),'no raw runtime table privilege');
select ok(not exists(select 1 from unnest(array[
  'public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date)',
  'public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text)',
  'public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text)',
  'public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)']) signature
  cross join unnest(array['anon','authenticated']) role where has_function_privilege(role,signature,'execute')),'RPC is not granted to client roles');
select ok((select bool_and(has_function_privilege('service_role',signature,'execute')) from unnest(array[
  'public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date)',
  'public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text)',
  'public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text)',
  'public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)']) signature),'only app-owned service RPC access granted');
select ok((select bool_and(prosecdef and 'search_path=""'=any(proconfig)) from pg_proc where oid in(
  'public.get_payroll_remittance_marker(uuid,uuid,text,uuid,date)'::regprocedure,
  'public.set_payroll_remittance_marker(uuid,uuid,text,uuid,date,boolean,bigint,text,text,text)'::regprocedure,
  'public.reconfirm_payroll_remittance_marker(uuid,uuid,text,uuid,date,bigint,text,text,text)'::regprocedure,
  'public.list_payroll_remittance_marker_history(uuid,uuid,text,uuid,date,bigint,integer)'::regprocedure)),'all app RPCs are SECDEF with empty search_path');
select ok(not has_function_privilege('service_role','private.command_payroll_remittance_marker(uuid,uuid,text,uuid,date,text,boolean,bigint,text,text,text)','execute'),
  'runtime cannot bypass public command with private helper');
select ok(not exists(select 1 from public.audit_events where event_type like 'payroll.remittance_%'
  and (after_state ?| array['maidProfileId','basis','basisFingerprint','sessionId','amount','providerReferenceId']
    or before_state is not null)),'audit excludes money/session/reference raw material');
select is((select count(*) from private.payroll_remittance_marker_revisions),4::bigint,'history is exactly effective on/reconfirm/reconfirm/off');
select is((select count(*) from public.audit_events where event_type like 'payroll.remittance_%'),4::bigint,'one audit per effective revision and none for failed/no-op/replay');

-- Another maid's confirmed amount can become zero without auto-clearing. The
-- root earning is preserved; this is a real typed signed correction command.
select pg_temp.mark_set(true,0,'marker-other-on',null,1,3);
select public.record_payroll_correction(pg_temp.mark_id(1),pg_temp.mark_id(5002),null,-12000,0,
  'marker-other-zero-correction',repeat('e',64));
insert into marker_results values('financial_zero',to_jsonb(pg_temp.mark_financial_hash()));
select is(pg_temp.mark_get(1,3)->>'marked','true','later zero amount keeps previously on marker');
select is(pg_temp.mark_get(1,3)->>'needsReconfirmation','true','zeroed amount still requires explicit re-confirm');
select is(pg_temp.mark_get(1,3)->>'setBlockedReason','NO_PAYROLL_AMOUNT','zero amount cannot become a new on');
select is(pg_temp.mark_get(1,3)->>'canClear','true','current zero does not block display clear');
select is(pg_temp.mark_get(1,3)->>'canReconfirm','true','current zero does not block explicit re-confirm');
select pg_temp.mark_reconfirm(1,'marker-other-zero-reconfirm',null,4,3);
select is(pg_temp.mark_get(1,3)->>'marked','true','re-confirm zero amount preserves on');
select is(pg_temp.mark_get(1,3)->>'needsReconfirmation','false','zero basis explicit re-confirm succeeds');
select pg_temp.mark_set(false,2,'marker-other-zero-clear',null,1,3);
select is(pg_temp.mark_get(1,3)->>'marked','false','zero amount can clear without positive gate');
select is(pg_temp.mark_financial_hash(),(select value#>>'{}' from marker_results where name='financial_zero'),
  'zero amount re-confirm and off never change earning/correction/payment data');
select is(pg_temp.mark_get()->>'version','4','other maid amount and display changes leave main maid version unchanged');
select throws_ok($$select pg_temp.mark_set(true,3,'marker-other-zero-reon',null,1,3)$$,
  '22023','NO_PAYROLL_AMOUNT','cleared zero cannot be marked again');
set constraints all immediate;
select pass('zero amount transitions satisfy all immutable source and marker lineage constraints');
select * from finish();
rollback;
