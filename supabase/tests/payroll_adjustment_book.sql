begin;
select no_plan();

-- PAYROLL_BOOK_FIXTURE_BEGIN
create function pg_temp.book_id(n integer) returns uuid language sql immutable as $$
  select ('f3250000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.book_week(n integer) returns date language sql stable as $$
  select date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;
insert into auth.users(id) select pg_temp.book_id(100+n) from generate_series(1,12)n;
select public.bootstrap_first_developer_profile(pg_temp.book_id(5),pg_temp.book_id(105),
  'book-dev','book-dev','0325',repeat('d',64),'payroll-book-developer');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.book_id(1),pg_temp.book_id(101),'book-admin-a','book-admin-a','book-admin-a','book-admin-a',0,'admin','active',false),
  (pg_temp.book_id(2),pg_temp.book_id(102),'book-maid','book-maid','book-maid','book-maid',0,'maid','active',false),
  (pg_temp.book_id(3),pg_temp.book_id(103),'book-admin-b','book-admin-b','book-admin-b','book-admin-b',0,'admin','active',false),
  (pg_temp.book_id(4),pg_temp.book_id(104),'book-other','book-other','book-other','book-other',0,'maid','active',false),
  (pg_temp.book_id(6),pg_temp.book_id(106),'book-temp','book-temp','book-temp','book-temp',0,'admin','active',true),
  (pg_temp.book_id(7),pg_temp.book_id(107),'book-inactive-admin','book-inactive-admin','book-inactive-admin','book-inactive-admin',0,'admin','inactive',false),
  (pg_temp.book_id(8),pg_temp.book_id(108),'book-departed-admin','book-departed-admin','book-departed-admin','book-departed-admin',0,'admin','departed',false),
  (pg_temp.book_id(9),pg_temp.book_id(109),'book-inactive-maid','book-inactive-maid','book-inactive-maid','book-inactive-maid',0,'maid','inactive',false),
  (pg_temp.book_id(10),pg_temp.book_id(110),'book-departed-maid','book-departed-maid','book-departed-maid','book-departed-maid',0,'maid','departed',false),
  (pg_temp.book_id(11),pg_temp.book_id(111),'book-empty-maid','book-empty-maid','book-empty-maid','book-empty-maid',0,'maid','active',false),
  (pg_temp.book_id(12),pg_temp.book_id(112),'book-zero-maid','book-zero-maid','book-zero-maid','book-zero-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id) select pg_temp.book_id(400+n),pg_temp.book_id(100+n)
  from generate_series(1,12)n;
insert into public.payroll_adjustment_books(maid_profile_id,version) values(pg_temp.book_id(12),0);
create function pg_temp.book_add_earning(n integer,p_maid integer,p_week integer,p_amount integer)
returns uuid language plpgsql as $$
declare room public.rooms; day date:=pg_temp.book_week(p_week)+1;
  at_time timestamptz:=(day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select * into room from public.rooms order by room_number limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by) values(pg_temp.book_id(1000+n),room.id,'additional',
    'manual_room_request','payroll-book-'||n,day,day,at_time-interval '2 hours',at_time+interval '2 hours',
    'approved',1,jsonb_build_object('id',room.room_type_id),p_amount,'{}',pg_temp.book_id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
    sequence_number,revision,is_current,notified_at,changed_by) values(pg_temp.book_id(2000+n),
    pg_temp.book_id(1000+n),pg_temp.book_id(p_maid),day,n+1,1,true,at_time-interval '2 hours',pg_temp.book_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
    attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,
    template_snapshot,room_snapshot) values(pg_temp.book_id(3000+n),pg_temp.book_id(1000+n),
    pg_temp.book_id(2000+n),pg_temp.book_id(p_maid),1,'approved',1,at_time-interval '1 hour',
    at_time,at_time,'{}',jsonb_build_object('roomId',room.id));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,
    status,photo_manifest,submitted_by,submitted_at) values(pg_temp.book_id(4000+n),
    pg_temp.book_id(3000+n),pg_temp.book_id(6000+n),1,'approved','{}',pg_temp.book_id(p_maid),at_time);
  insert into public.inspection_decisions(submission_id,decision,reason_code,decided_by,decided_at)
    values(pg_temp.book_id(4000+n),'approved','QUALITY_OK',pg_temp.book_id(1),at_time);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,
    base_amount,bomb_room_bonus) values(pg_temp.book_id(5000+n),pg_temp.book_id(4000+n),
    pg_temp.book_id(4000+n),pg_temp.book_id(p_maid),day,p_amount,0);
  return pg_temp.book_id(5000+n);
end $$;
select pg_temp.book_add_earning(1,2,-4,10000);
select pg_temp.book_add_earning(2,4,-3,8000);
select pg_temp.book_add_earning(3,2,-6,5000);
-- PAYROLL_BOOK_FIXTURE_END

create function pg_temp.book_read(p_maid integer default 2,p_week integer default 0)
returns jsonb language sql stable as $$
  select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
    pg_temp.book_id(p_maid),pg_temp.book_week(p_week))
$$;
create function pg_temp.book_state() returns text language plpgsql as $$
declare item record; pieces text[]:='{}'; value text;
begin
  for item in select n.nspname schema_name,c.relname table_name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private')
    and c.relkind='r' order by n.nspname,c.relname loop
    execute format('select coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''') from %I.%I t',
      item.schema_name,item.table_name) into value;
    pieces:=array_append(pieces,item.schema_name||'.'||item.table_name||':'||value);
  end loop;
  return md5(array_to_string(pieces,'|'));
end $$;
create temporary table book_checkpoints(label text primary key,value jsonb);
insert into book_checkpoints values('before-read',to_jsonb(pg_temp.book_state())),
  ('original-earnings',(select jsonb_agg(to_jsonb(e) order by e.id) from public.earnings e));
select is(pg_temp.book_read(),jsonb_build_object('maidProfileId',pg_temp.book_id(2),
  'weekStart',pg_temp.book_week(0),'currentBookVersion',0),'initial no-book response has exactly the three authoritative fields');
select is(pg_temp.book_read(11)->>'currentBookVersion','0','an empty maid has authoritative initial version 0');
select is(pg_temp.book_read(12)->>'currentBookVersion','0','an existing version 0 book has the same response');
select is((select count(*) from public.payroll_adjustment_books where maid_profile_id=pg_temp.book_id(2)),
  0::bigint,'reading the initial version never inserts a book');
select is(to_jsonb(pg_temp.book_state()),(select value from book_checkpoints where label='before-read'),
  'initial reads leave every whole public/private row byte-exact including receipts and audit/outbox');
select is(jsonb_typeof(pg_temp.book_read()->'currentBookVersion'),'number','CAS version is a JSON number, not a string');
select lives_ok($$select pg_temp.book_read(9)$$,'inactive historical maid is a valid target');
select lives_ok($$select pg_temp.book_read(10)$$,'departed historical maid is a valid target');
select lives_ok($$select pg_temp.book_read(2,-4)$$,'past KST Monday is readable');
select lives_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),'0001-01-01')$$,'a real year 0001 Monday is accepted');
select throws_ok($$select pg_temp.book_read(2,1)$$,'22023','PAYROLL_WEEK_NOT_CLOSED','future Monday remains unavailable');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),pg_temp.book_week(0)+1)$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','Tuesday is not a payroll week');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),null)$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','null date is rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),'infinity')$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','infinite date is rejected before the old week helper');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),'-infinity')$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','negative infinity is rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),'0001-01-01 BC')$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','BC dates are rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(2),'10000-01-03')$$,'22023','PAYROLL_WEEK_MUST_START_MONDAY','five-digit years are rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  pg_temp.book_id(999),pg_temp.book_week(0))$$,'P0002','PAYROLL_MAID_NOT_FOUND','unknown target is not fabricated as version 0');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(401),
  null,pg_temp.book_week(0))$$,'P0002','PAYROLL_MAID_NOT_FOUND','null target is not an initial book');
select throws_ok($$select pg_temp.book_read(1)$$,'P0002','PAYROLL_MAID_NOT_FOUND','an admin ID cannot alias a maid book');
select throws_ok($$select pg_temp.book_read(5)$$,'P0002','PAYROLL_MAID_NOT_FOUND','a developer ID cannot alias a maid book');

select throws_ok(format('select public.get_payroll_adjustment_book(%L,%L,%L,%L)',pg_temp.book_id(n),
  pg_temp.book_id(400+n),pg_temp.book_id(11),pg_temp.book_week(0)),
  '42501','ADMIN_REQUIRED','actor role/status is checked even for an empty book: '||n)
  from unnest(array[2,4,5,7,8])n;
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(999),pg_temp.book_id(401),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','ADMIN_REQUIRED','missing actor is denied before empty result');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(6),pg_temp.book_id(406),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary password is a distinct rejection');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),null,
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','SESSION_REVOKED','null session is rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(499),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','SESSION_REVOKED','missing/revoked session is rejected');
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(403),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','SESSION_REVOKED','another admin session cannot be borrowed');
update auth.sessions set not_after=statement_timestamp()-interval '1 second' where id=pg_temp.book_id(401);
select throws_ok($$select pg_temp.book_read(11)$$,'42501','SESSION_REVOKED','past exact session expiry is denied');
create function pg_temp.book_equal_expiry() returns jsonb language plpgsql as $$
begin
  update auth.sessions set not_after=statement_timestamp() where id=pg_temp.book_id(401);
  return pg_temp.book_read(11);
end $$;
select throws_ok($$select pg_temp.book_equal_expiry()$$,'42501','SESSION_REVOKED','exact not_after equality is expired, not inclusive');
update auth.sessions set not_after=statement_timestamp()+interval '1 hour' where id=pg_temp.book_id(401);
select lives_ok($$select pg_temp.book_read(11)$$,'future exact-session expiry is valid');
update auth.sessions set not_after=null where id=pg_temp.book_id(401);
select lives_ok($$select pg_temp.book_read(11)$$,'null not_after is valid');
insert into auth.sessions(id,user_id) values(pg_temp.book_id(451),pg_temp.book_id(101));
select is(public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(451),pg_temp.book_id(11),
  pg_temp.book_week(0)),pg_temp.book_read(11),'fresh login/new browser resolves initial version without a creation receipt');
delete from auth.sessions where id=pg_temp.book_id(451);
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(1),pg_temp.book_id(451),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','SESSION_REVOKED','a revoked fresh browser session is denied');
update public.profiles set must_change_password=true where id=pg_temp.book_id(3);
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(3),pg_temp.book_id(403),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','PASSWORD_CHANGE_REQUIRED','latest DB password gate overrides the old session');
update public.profiles set must_change_password=false,status='inactive' where id=pg_temp.book_id(3);
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(3),pg_temp.book_id(403),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','ADMIN_REQUIRED','latest DB status overrides previously active admin');
update public.profiles set status='active',role='maid' where id=pg_temp.book_id(3);
select throws_ok($$select public.get_payroll_adjustment_book(pg_temp.book_id(3),pg_temp.book_id(403),
  pg_temp.book_id(11),pg_temp.book_week(0))$$,'42501','ADMIN_REQUIRED','latest DB role overrides previously authorized admin');
update public.profiles set role='admin' where id=pg_temp.book_id(3);

insert into book_checkpoints values('first-receipt',public.record_payroll_correction(pg_temp.book_id(1),
  pg_temp.book_id(5001),null,-100,0,'book-correction-first',repeat('a',64)));
select public.record_payroll_correction(pg_temp.book_id(1),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  25,1,'book-correction-second',repeat('b',64));
select public.record_payroll_correction(pg_temp.book_id(1),pg_temp.book_id(5001),null,
  50,2,'book-correction-third',repeat('c',64));
select is(pg_temp.book_read()->>'currentBookVersion','3','current book is 3 while the selected old adjustment is version 1');
select is((select book_version from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2)
  order by book_version limit 1),1::bigint,'old row creation version remains immutable');
select is(pg_temp.book_read(2,-4)->>'currentBookVersion',pg_temp.book_read(2,0)->>'currentBookVersion',
  'two different valid week contexts read the same maid-wide CAS book');
set local time zone 'Pacific/Honolulu';
select is(pg_temp.book_read(2,0)->>'weekStart',to_char(pg_temp.book_week(0),'YYYY-MM-DD'),
  'KST week response does not depend on database display time zone');
set local time zone 'UTC';
insert into book_checkpoints values('admin-a-version',pg_temp.book_read()),('admin-b-version',
  public.get_payroll_adjustment_book(pg_temp.book_id(3),pg_temp.book_id(403),pg_temp.book_id(2),pg_temp.book_week(0)));
select is((select value->>'currentBookVersion' from book_checkpoints where label='admin-a-version'),
  (select value->>'currentBookVersion' from book_checkpoints where label='admin-b-version'),'admins A and B can read the same V');
select lives_ok($$select public.record_payroll_correction(pg_temp.book_id(1),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  -10,3,'book-a-correct-old',repeat('d',64))$$,'A can recorrect an old entry using the current book version');
insert into book_checkpoints values('before-stale',to_jsonb(pg_temp.book_state()));
select throws_ok($$select public.record_payroll_correction(pg_temp.book_id(3),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  5,3,'book-b-stale',repeat('e',64))$$,'40001','STALE_ADJUSTMENT_VERSION','B stale V is rejected by the real existing command');
select is(to_jsonb(pg_temp.book_state()),(select value from book_checkpoints where label='before-stale'),
  'stale correction leaves all whole rows, receipts, audit, notifications and outbox unchanged');
select is(public.get_payroll_adjustment_book(pg_temp.book_id(3),pg_temp.book_id(403),pg_temp.book_id(2),
  pg_temp.book_week(0))->>'currentBookVersion','4','B can refetch the latest authoritative V after stale 409');
select lives_ok($$select public.record_payroll_correction(pg_temp.book_id(3),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  5,4,'book-b-retry',repeat('f',64))$$,'B refreshed V can recorrect the old adjustment');
select lives_ok($$select public.reverse_payroll_source(pg_temp.book_id(3),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  5,'book-reverse-old',repeat('1',64))$$,'current V also authorizes the existing full reversal command');
select is((select amount from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2)
  and book_version=6),100,'reversal is the exact opposite signed amount of the old source');
insert into book_checkpoints values('before-repeat-reverse',to_jsonb(pg_temp.book_state()));
select throws_ok($$select public.reverse_payroll_source(pg_temp.book_id(3),null,
  (select id from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2) and book_version=1),
  6,'book-reverse-old-again',repeat('2',64))$$,'23505','PAYROLL_SOURCE_ALREADY_REVERSED','fresh V does not bypass already-reversed source uniqueness');
select is(to_jsonb(pg_temp.book_state()),(select value from book_checkpoints where label='before-repeat-reverse'),
  'already-reversed denial writes no receipt, ledger or side effects');
select is(public.record_payroll_correction(pg_temp.book_id(1),pg_temp.book_id(5001),null,-100,0,
  'book-correction-first',repeat('a',64)),(select value from book_checkpoints where label='first-receipt'),
  'old command receipt replays exact creation version 1, never rehydrates to current version 6');
select is(pg_temp.book_read()->>'currentBookVersion','6','receipt replay does not advance the current book');

select public.start_payroll_cycle(pg_temp.book_id(1),pg_temp.book_id(2),pg_temp.book_week(-6),0,
  'book-paid-start',repeat('3',64));
select public.record_payroll_payment_paid(pg_temp.book_id(1),
  (select id from public.payroll_payment_attempts where maid_profile_id=pg_temp.book_id(2)),
  (select version from public.payroll_cycles where maid_profile_id=pg_temp.book_id(2)),
  'bank_transfer','BOOK-PAID-A1','book-paid-finish',repeat('4',64));
insert into book_checkpoints values('paid-snapshot',jsonb_build_object(
  'cycles',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_cycles t),
  'items',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_items t),
  'events',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_events t),
  'attempts',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_payment_attempts t),
  'results',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_payment_results t)));
select lives_ok($$select public.record_payroll_correction(pg_temp.book_id(1),pg_temp.book_id(5003),null,
  -50,6,'book-paid-source-correct',repeat('5',64))$$,'paid source correction remains append-only in a later week');
select is((select available_week_start from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2)
  and book_version=7),pg_temp.book_week(-5),'paid correction is routed to the next valid week without changing the paid cycle');
select is(jsonb_build_object(
  'cycles',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_cycles t),
  'items',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_items t),
  'events',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_events t),
  'attempts',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_payment_attempts t),
  'results',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_payment_results t)),
  (select value from book_checkpoints where label='paid-snapshot'),'every complete PAID membership/payment snapshot remains exact');
select is((select jsonb_agg(to_jsonb(e) order by e.id) from public.earnings e),
  (select value from book_checkpoints where label='original-earnings'),'all original earning rows remain exact through recorrection and reversal');
select throws_ok($$update public.payroll_adjustments set amount=amount+1 where maid_profile_id=pg_temp.book_id(2)$$,
  '55000','PAYROLL_LEDGER_IMMUTABLE','adjustment originals still cannot be updated');
select throws_ok($$delete from public.payroll_adjustments where maid_profile_id=pg_temp.book_id(2)$$,
  '55000','PAYROLL_LEDGER_IMMUTABLE','adjustment originals still cannot be deleted');
insert into book_checkpoints values('before-wrong-book',to_jsonb(pg_temp.book_state()));
select throws_ok($$select public.record_payroll_correction(pg_temp.book_id(3),pg_temp.book_id(5001),null,
  5,0,'book-other-v-is-not-source-v',repeat('6',64))$$,'40001','STALE_ADJUSTMENT_VERSION','another maid initial V cannot bypass the actual source maid book');
select is(to_jsonb(pg_temp.book_state()),(select value from book_checkpoints where label='before-wrong-book'),
  'wrong-source-book stale rejection writes no changes');
select lives_ok($$select public.record_payroll_correction(pg_temp.book_id(3),pg_temp.book_id(5002),null,
  5,0,'book-actual-other-source',repeat('7',64))$$,'admin may act on another maid source through its own actual book');
select is(pg_temp.book_read(4)->>'currentBookVersion','1','another maid source advances only that actual maid book');
select is(pg_temp.book_read(2)->>'currentBookVersion','7','other source does not advance the first maid book');

create temporary table book_saved_projection as select * from public.payroll_adjustment_books where maid_profile_id=pg_temp.book_id(2);
delete from public.payroll_adjustment_books where maid_profile_id=pg_temp.book_id(2);
select throws_ok($$select pg_temp.book_read()$$,'23514','PAYROLL_ADJUSTMENT_BOOK_INVARIANT_VIOLATION',
  'missing book with real adjustment history fails safely instead of guessing 0 or max row version');
insert into public.payroll_adjustment_books select * from book_saved_projection;
update public.payroll_adjustment_books set version=9007199254740992 where maid_profile_id=pg_temp.book_id(12);
select throws_ok($$select pg_temp.book_read(12)$$,'23514','PAYROLL_ADJUSTMENT_BOOK_INVARIANT_VIOLATION',
  'unsafe JavaScript integer version is rejected before JSON exposure');
update public.payroll_adjustment_books set version=9007199254740991 where maid_profile_id=pg_temp.book_id(12);
select is(pg_temp.book_read(12)->>'currentBookVersion','9007199254740991','largest safe integer remains exact');
update public.payroll_adjustment_books set version=0 where maid_profile_id=pg_temp.book_id(12);
insert into book_checkpoints values('before-final-reads',to_jsonb(pg_temp.book_state()));
select pg_temp.book_read();
select pg_temp.book_read(4);
select pg_temp.book_read(11);
select is(to_jsonb(pg_temp.book_state()),(select value from book_checkpoints where label='before-final-reads'),
  'reads of existing/current/empty books preserve every complete row');
select is((select provolatile::text from pg_proc where oid='public.get_payroll_adjustment_book(uuid,uuid,uuid,date)'::regprocedure),
  's','RPC is STABLE, not a volatile writer');
select ok((select prosecdef and proconfig=array['search_path=""'] from pg_proc
  where oid='public.get_payroll_adjustment_book(uuid,uuid,uuid,date)'::regprocedure),'RPC is security-definer with empty search_path');
select ok(has_function_privilege('service_role','public.get_payroll_adjustment_book(uuid,uuid,uuid,date)','EXECUTE'),
  'only the server service role can execute the guarded read');
select ok(not has_function_privilege('anon','public.get_payroll_adjustment_book(uuid,uuid,uuid,date)','EXECUTE'),
  'anonymous direct RPC is denied');
select ok(not has_function_privilege('authenticated','public.get_payroll_adjustment_book(uuid,uuid,uuid,date)','EXECUTE'),
  'authenticated direct RPC cannot inject an actor/session');
select ok(not has_table_privilege('service_role','public.payroll_adjustment_books','SELECT'),
  'service raw book table access is not widened');
select ok(not has_table_privilege('authenticated','public.payroll_adjustment_books','UPDATE'),
  'authenticated cannot change CAS book projection');
set local role service_role;
select lives_ok($$select public.get_payroll_adjustment_book('f3250000-0000-4000-8000-000000000001',
  'f3250000-0000-4000-8000-000000000401','f3250000-0000-4000-8000-000000000011',
  date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date)$$,'actual service role executes the narrow guarded RPC');
reset role;
select * from finish();
rollback;
