-- General evidence replaces room-section checklists. Existing sealed evidence is immutable.
create function private.flat_cleaning_photo_slots()
returns jsonb language sql immutable set search_path = '' as $$
  select '[{"slotKey":"cleaning-proof","displayOrder":0,"required":true,"label":"청소 사진","maxPhotos":20},
    {"slotKey":"bomb-proof","displayOrder":1,"required":false,"label":"폭탄방 증빙","maxPhotos":10},
    {"slotKey":"issue-proof","displayOrder":2,"required":false,"label":"특이사항 증빙","maxPhotos":10}]'::jsonb
$$;
revoke all on function private.flat_cleaning_photo_slots() from public, anon, authenticated, service_role;

-- Preserve the legacy validator for historical template snapshots, not new UI defaults.
do $$ begin
  execute replace(pg_get_functiondef('private.photo_snapshot_valid(jsonb)'::regprocedure),
    'FUNCTION private.photo_snapshot_valid(', 'FUNCTION private.photo_snapshot_valid_before_flat(');
end $$;
revoke all on function private.photo_snapshot_valid_before_flat(jsonb) from public, anon, authenticated, service_role;

create or replace function private.photo_snapshot_valid(p_snapshot jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_snapshot -> 'slots' = private.flat_cleaning_photo_slots() then
    return coalesce(jsonb_typeof(p_snapshot) = 'object'
      and p_snapshot ->> 'templateVersionId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and p_snapshot ->> 'version' ~ '^[1-9][0-9]*$'
      and jsonb_typeof(p_snapshot -> 'version') = 'number'
      and (p_snapshot ->> 'version')::integer >= 9
      and p_snapshot ->> 'roomTypeCode' in ('standard','premium','oceanPremium','oceanFamily')
      and p_snapshot ->> 'cleaningKind' in ('checkout','stayover','additional','reclean'), false);
  end if;
  return private.photo_snapshot_valid_before_flat(p_snapshot);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create or replace function private.photo_slot_max_photos(p_slot uuid, p_target uuid)
returns integer language sql stable set search_path = '' as $$
  select case
    when c.ready and c.frozen_snapshot -> 'slots' = private.flat_cleaning_photo_slots()
      then (s.slot_snapshot ->> 'maxPhotos')::integer
    when s.slot_key = 'extra-proof' and s.slot_snapshot ->> 'maxPhotos' = '10'
      and c.ready and (c.frozen_snapshot ->> 'version')::integer >= 8
      and c.frozen_snapshot ->> 'cleaningKind' = 'checkout' then 10
    else 1 end
  from private.target_photo_slot_snapshots s
  join private.target_photo_snapshot_contracts c on c.cleaning_target_id = s.cleaning_target_id
  where s.id = p_slot and s.cleaning_target_id = p_target
$$;

-- Evidence reports keep their own immutable record and never substitute for cleaning proof.
create table private.attempt_room_issue_reports (
  issue_id uuid primary key references public.room_issues(id),
  cleaning_attempt_id uuid not null references public.cleaning_attempts(id),
  memo text not null check (length(btrim(memo)) between 1 and 500),
  evidence_photo_ids uuid[] not null check (cardinality(evidence_photo_ids) between 1 and 10),
  reported_at timestamptz not null default clock_timestamp()
);
create index attempt_room_issue_reports_attempt_idx on private.attempt_room_issue_reports(cleaning_attempt_id);
alter table private.attempt_room_issue_reports enable row level security;
revoke all on private.attempt_room_issue_reports from public,anon,authenticated,service_role;
create trigger attempt_room_issue_reports_immutable before update or delete on private.attempt_room_issue_reports
for each row execute function private.photo_collection_append_only();

create function public.report_attempt_room_issue(
  p_actor_profile_id uuid,p_attempt_id uuid,p_evidence_photo_ids uuid[],p_memo text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.cleaning_attempts; t public.cleaning_targets; actor public.profiles;
  replay jsonb; result jsonb; issue_id uuid; evidence record;
begin
  replay := private.replay_command(p_actor_profile_id,'submission.report_room_issue',p_idempotency_key,p_request_hash);
  a := private.submission_receipt_actor(p_actor_profile_id,p_attempt_id);
  if replay is not null then return replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into actor from public.profiles where id=p_actor_profile_id for no key update;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  if actor.role<>'maid' or actor.status<>'active' or actor.must_change_password
    or a.maid_profile_id<>actor.id or a.status not in ('in_progress','field_completed','upload_pending')
    or not exists(select 1 from public.cleaning_assignments s where s.id=a.assignment_id and s.is_current
      and s.notified_at is not null and s.ended_at is null and s.revision=a.assignment_revision
      and t.assignment_version=s.revision and t.status<>'cancelled') then
    raise exception using errcode='42501',message='ROOM_ISSUE_REPORT_ACCESS_REQUIRED';
  end if;
  if nullif(btrim(p_memo),'') is null or length(p_memo)>500 or p_evidence_photo_ids is null
    or cardinality(p_evidence_photo_ids) not between 1 and 10
    or cardinality(p_evidence_photo_ids)<>(select count(distinct x) from unnest(p_evidence_photo_ids) x)
    or exists(select 1 from private.submission_current_pointers where cleaning_attempt_id=a.id) then
    raise exception using errcode='22023',message='INVALID_ROOM_ISSUE_REPORT';
  end if;
  if exists(select 1 from unnest(p_evidence_photo_ids) x where not exists(
    select 1 from private.attempt_photo_collection_items i
    join private.target_photo_slot_snapshots s on s.id=i.target_photo_slot_id
    where i.cleaning_attempt_id=a.id and i.active and i.photo_version_id=x and s.slot_key='issue-proof'
      and private.photo_media_usable(x,clock_timestamp()))) then
    raise exception using errcode='23514',message='ROOM_ISSUE_EVIDENCE_INVALID';
  end if;
  perform 1 from public.rooms where id=t.room_id for update;
  insert into public.room_issues(room_id,category,severity,description,reported_by)
    values(t.room_id,'cleaning_observation','warning',p_memo,actor.id) returning id into issue_id;
  insert into private.attempt_room_issue_reports values(issue_id,a.id,p_memo,p_evidence_photo_ids,clock_timestamp());
  for evidence in select object_id from private.photo_upload_acceptances where photo_version_id=any(p_evidence_photo_ids) loop
    perform private.attach_photo_retention_link(evidence.object_id,'room_issue','room_issue',issue_id,actor.id);
  end loop;
  update public.rooms set state_version=state_version+1 where id=t.room_id;
  result := jsonb_build_object('id',issue_id,'attemptId',a.id,'evidenceCount',cardinality(p_evidence_photo_ids));
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('room.report_issue','room',t.room_id,actor.id,actor.display_name,clock_timestamp(),
      jsonb_build_object('issueId',issue_id,'category','cleaning_observation','severity','warning','blocksGuestAssignment',false,'status','open'),
      private.audit_command_key(actor.id,'submission.report_room_issue',p_idempotency_key));
  perform private.complete_command(actor.id,'submission.report_room_issue',p_idempotency_key,p_request_hash,issue_id,result);
  return result;
end $$;
revoke all on function public.report_attempt_room_issue(uuid,uuid,uuid[],text,text,text) from public,anon,authenticated;
grant execute on function public.report_attempt_room_issue(uuid,uuid,uuid[],text,text,text) to service_role;

do $$ declare definition text; begin
  definition := pg_get_functiondef('public.report_bomb_room(uuid,uuid,uuid[],text,text,text)'::regprocedure);
  execute replace(definition,'and private.photo_media_usable(photo.id, clock_timestamp())',
    'and private.photo_media_usable(photo.id, clock_timestamp())
      and (t.template_snapshot->''photoSlots'' <> private.flat_cleaning_photo_slots() or exists(
        select 1 from private.target_photo_slot_snapshots s where s.id=photo.target_photo_slot_id and s.slot_key=''bomb-proof''))');
end $$;

create function private.attempt_room_issue_projection(p_attempt uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',issue_id,'memo',memo,'evidencePhotoIds',evidence_photo_ids,
    'reportedAt',reported_at) order by reported_at),'[]'::jsonb)
  from private.attempt_room_issue_reports where cleaning_attempt_id=p_attempt
$$;
revoke all on function private.attempt_room_issue_projection(uuid) from public,anon,authenticated,service_role;
do $$ begin
  execute replace(pg_get_functiondef('private.submission_projection(uuid)'::regprocedure),
    'FUNCTION private.submission_projection(', 'FUNCTION private.submission_projection_before_flat(');
end $$;
revoke all on function private.submission_projection_before_flat(uuid) from public,anon,authenticated,service_role;
create or replace function private.submission_projection(p_submission uuid)
returns jsonb language sql stable set search_path = '' as $$
  select private.submission_projection_before_flat(p_submission) || jsonb_build_object(
    'roomIssues',private.attempt_room_issue_projection(s.cleaning_attempt_id))
  from public.cleaning_submissions s where s.id=p_submission
$$;

alter table private.attempt_photo_collection_items
  drop constraint attempt_photo_collection_items_display_order_check,
  add constraint attempt_photo_collection_items_display_order_check check (display_order between 0 and 19);
alter table private.attempt_photo_collection_changes
  drop constraint attempt_photo_collection_changes_display_order_check,
  add constraint attempt_photo_collection_changes_display_order_check check (display_order between 0 and 19);
alter table private.submission_photo_bindings
  drop constraint submission_photo_bindings_collection_shape_check,
  add constraint submission_photo_bindings_collection_shape_check check (
    (collection_item_id is null and item_revision is null and item_display_order is null)
    or (collection_item_id is not null and item_revision > 0 and item_display_order between 0 and 19));

-- Keep the latest retention/CAS implementation; only generalize its collection capacity.
do $$ declare r record; definition text; changed text; begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private' and p.proname in (
      'guard_photo_collection_state','guard_photo_collection_item','guard_photo_collection_upload_shape',
      'record_validated_collection_photo','photo_attempt_complete'))
      or (n.nspname = 'public' and p.proname in (
        'admit_photo_collection_upload','delete_photo_collection_item','get_attempt_photo_slots_before_retention_v2'))
  loop
    definition := pg_get_functiondef(r.oid);
    changed := regexp_replace(definition, '(private\.photo_slot_max_photos\([^\n]+?\)) <> 10', '\1 <= 1', 'g');
    changed := regexp_replace(changed, '(private\.photo_slot_max_photos\([^\n]+?\)) = 10', '\1 > 1', 'g');
    changed := replace(changed, 'max_photos <> 10', 'max_photos <= 1');
    if definition like '%FUNCTION private.record_validated_collection_photo(%' then
      changed := replace(changed, ') >= 10 then', ') >= private.photo_slot_max_photos(p_slot, a.cleaning_target_id) then');
      changed := replace(changed, 'generate_series(0, 9)', 'generate_series(0, private.photo_slot_max_photos(p_slot, a.cleaning_target_id) - 1)');
    elsif definition like '%FUNCTION public.admit_photo_collection_upload(%' then
      changed := replace(changed, ') >= 10 then', ') >= private.photo_slot_max_photos(p_target_slot_id, a.cleaning_target_id) then');
    end if;
    if changed = definition then raise exception 'Flat evidence migration: unchanged function %', r.oid::regprocedure; end if;
    execute changed;
  end loop;
end $$;

-- Existing completeness covers byte verification, frozen snapshots and legacy pointers.
do $$ begin
  execute replace(pg_get_functiondef('private.photo_attempt_complete(uuid,timestamp with time zone)'::regprocedure),
    'FUNCTION private.photo_attempt_complete(', 'FUNCTION private.photo_attempt_complete_before_flat(');
end $$;
revoke all on function private.photo_attempt_complete_before_flat(uuid,timestamptz) from public, anon, authenticated, service_role;
create or replace function private.photo_attempt_complete(p_attempt uuid, p_as_of timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select private.photo_attempt_complete_before_flat(p_attempt, p_as_of)
    and not exists (
      select 1 from public.cleaning_attempts a
      join private.target_photo_slot_snapshots s on s.cleaning_target_id = a.cleaning_target_id
      where a.id = p_attempt and private.photo_slot_max_photos(s.id, a.cleaning_target_id) > 1
        and (select count(*) from private.attempt_photo_collection_items i
          where i.cleaning_attempt_id = a.id and i.target_photo_slot_id = s.id and i.active)
          not between case when s.required then 1 else 0 end and private.photo_slot_max_photos(s.id, a.cleaning_target_id)
    )
$$;

-- Publication remains compatible with legacy idempotency receipts.
do $$ declare definition text; begin
  definition := pg_get_functiondef('private.normalized_checkout_template_slots(jsonb)'::regprocedure);
  execute replace(definition, '(v_slot ->> ''maxPhotos'')::integer > 10', '(v_slot ->> ''maxPhotos'')::integer > 20');
  definition := pg_get_functiondef('public.publish_checkout_cleaning_template(uuid,uuid,text,integer,integer,jsonb,text,text)'::regprocedure);
  execute replace(definition, 'greatest(v_max_version + 1, 8)', 'greatest(v_max_version + 1, case when v_slots = private.flat_cleaning_photo_slots() then 9 else 8 end)');
end $$;

-- Copy current operating values, never invent a fee/duration/profile fixture.
do $$ declare template public.cleaning_template_versions; next_version integer; begin
  for template in select * from public.cleaning_template_versions where status = 'published' for update loop
    select greatest(max(version) + 1, 9) into next_version from public.cleaning_template_versions
      where room_type_id = template.room_type_id and cleaning_kind = template.cleaning_kind;
    update public.cleaning_template_versions set status = 'retired' where id = template.id;
    insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
      values(template.room_type_id,template.cleaning_kind,next_version,'published',template.duration_minutes,
        private.flat_cleaning_photo_slots(),clock_timestamp(),template.created_by);
  end loop;
end $$;

-- A private, append-only migration receipt preserves every superseded unstarted snapshot.
create table private.flat_evidence_migration_receipts (
  cleaning_target_id uuid primary key references public.cleaning_targets(id),
  previous_template_snapshot jsonb not null,
  previous_photo_contract jsonb,
  previous_slots jsonb not null,
  migrated_at timestamptz not null default clock_timestamp()
);
alter table private.flat_evidence_migration_receipts enable row level security;
revoke all on table private.flat_evidence_migration_receipts from public, anon, authenticated, service_role;
create trigger flat_evidence_migration_receipts_immutable before update or delete on private.flat_evidence_migration_receipts
for each row execute function private.photo_collection_append_only();

-- Only untouched, unstarted targets are migrated. Historical or uploaded work is never rewritten.
do $$ declare target public.cleaning_targets; template public.cleaning_template_versions; trigger_row record; begin
  set constraints all immediate;
  lock table public.cleaning_targets, public.cleaning_attempts, private.photo_upload_admissions,
    private.photo_upload_operations, private.attempt_photo_versions in share row exclusive mode;
  create temporary table flat_evidence_targets on commit drop as
    select t.id from public.cleaning_targets t where t.status not in ('approved','cancelled')
      and not exists(select 1 from public.cleaning_attempts a where a.cleaning_target_id=t.id
        and (a.status <> 'scheduled' or a.started_at is not null))
      and not exists(select 1 from private.photo_upload_admissions p where p.cleaning_target_id=t.id)
      and not exists(select 1 from private.photo_upload_operations p where p.cleaning_target_id=t.id)
      and not exists(select 1 from private.attempt_photo_versions p where p.cleaning_target_id=t.id);
  -- Snapshot guards are restored in this same transaction; no application bypass is exposed.
  alter table public.cleaning_targets disable trigger target_photo_snapshot_before_update;
  alter table public.cleaning_attempts disable trigger cleaning_attempts_snapshot_immutable;
  set constraints all deferred;
  for trigger_row in select tgname, tgrelid::regclass relation from pg_trigger
    where tgrelid in ('private.target_photo_snapshot_contracts'::regclass,'private.target_photo_slot_snapshots'::regclass)
      and not tgisinternal loop
    execute format('alter table %s disable trigger %I',trigger_row.relation,trigger_row.tgname);
  end loop;
  for target in select t.* from public.cleaning_targets t join flat_evidence_targets f on f.id=t.id loop
    select v.* into template from public.cleaning_template_versions v join public.room_types rt on rt.id=v.room_type_id
      where v.status='published' and v.cleaning_kind=target.cleaning_kind and rt.code=target.room_type_snapshot->>'code';
    if template.id is null then continue; end if;
    insert into private.flat_evidence_migration_receipts(cleaning_target_id,previous_template_snapshot,previous_photo_contract,previous_slots)
      select target.id,target.template_snapshot,
        (select frozen_snapshot from private.target_photo_snapshot_contracts where cleaning_target_id=target.id),
        coalesce((select jsonb_agg(to_jsonb(s)) from private.target_photo_slot_snapshots s where cleaning_target_id=target.id),'[]'::jsonb);
    delete from private.target_photo_slot_snapshots where cleaning_target_id=target.id;
    delete from private.target_photo_snapshot_contracts where cleaning_target_id=target.id;
    update public.cleaning_targets set template_snapshot=template_snapshot || jsonb_build_object(
      'id',template.id,'version',template.version,'photoSlots',template.photo_slots,'durationMinutes',template.duration_minutes)
      where id=target.id returning * into target;
    update public.cleaning_attempts set template_snapshot=target.template_snapshot where cleaning_target_id=target.id;
    perform private.materialize_target_photo_snapshot(target,false);
  end loop;
  set constraints all immediate;
  for trigger_row in select tgname, tgrelid::regclass relation from pg_trigger
    where tgrelid in ('private.target_photo_snapshot_contracts'::regclass,'private.target_photo_slot_snapshots'::regclass)
      and not tgisinternal loop
    execute format('alter table %s enable trigger %I',trigger_row.relation,trigger_row.tgname);
  end loop;
  alter table public.cleaning_attempts enable trigger cleaning_attempts_snapshot_immutable;
  alter table public.cleaning_targets enable trigger target_photo_snapshot_before_update;
  set constraints all deferred;
end $$;

create function public.get_cleaning_history_submission(p_actor_profile_id uuid,p_session_id uuid,p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor public.profiles; submission public.cleaning_submissions; attempt public.cleaning_attempts; result jsonb;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if actor.id is null or actor.status<>'active' or actor.must_change_password or actor.role not in ('admin','maid')
    or not public.is_active_auth_session(actor.auth_user_id,p_session_id) then
    raise exception using errcode='42501',message='CLEANING_HISTORY_ACCESS_REQUIRED';
  end if;
  select * into submission from public.cleaning_submissions where id=p_submission_id;
  select * into attempt from public.cleaning_attempts where id=submission.cleaning_attempt_id;
  if submission.id is null or (actor.role='maid' and attempt.maid_profile_id<>actor.id) then
    raise exception using errcode='42501',message='CLEANING_HISTORY_ACCESS_REQUIRED';
  end if;
  result := private.submission_projection(submission.id) || jsonb_build_object(
    'reviewContext',private.submission_review_context(submission.id),
    'fieldCompletedAt',attempt.field_completed_at,
    'photos',coalesce((select jsonb_agg(jsonb_build_object(
      'photoId',b.photo_version_id,'slotKey',s.slot_key,'label',s.slot_snapshot->>'label',
      'mediaAvailability',case when r.expires_at<=clock_timestamp() then 'expired' else coalesce(r.media_availability,'unavailable') end,
      'expiresAt',r.expires_at) order by s.display_order,coalesce(b.item_display_order,0),b.photo_version_id)
      from private.submission_photo_bindings b join private.target_photo_slot_snapshots s on s.id=b.target_photo_slot_id
      left join private.photo_upload_acceptances a on a.photo_version_id=b.photo_version_id
      left join private.photo_retention_records r on r.object_id=a.object_id
      where b.submission_id=submission.id),'[]'::jsonb),
    'bombReport',(select jsonb_build_object('id',b.id,'memo',b.memo,'reportedAt',b.reported_at,
      'evidencePhotoIds',(select jsonb_agg(e.photo_version_id) from private.bomb_room_report_evidence e where e.report_id=b.id))
      from private.bomb_room_report_seals seal join private.bomb_room_reports b on b.id=seal.report_id where seal.submission_id=submission.id)
  );
  return result;
end $$;
revoke all on function public.get_cleaning_history_submission(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_cleaning_history_submission(uuid,uuid,uuid) to service_role;

-- Read-only accrual projection. Payment locks and earning ledgers are unchanged.
do $$ begin
  execute replace(pg_get_functiondef('private.project_payroll_cycle_bounded(date,uuid,integer)'::regprocedure),
    'FUNCTION private.project_payroll_cycle_bounded(', 'FUNCTION private.project_payroll_cycle_before_workflow(');
end $$;
revoke all on function private.project_payroll_cycle_before_workflow(date,uuid,integer) from public,anon,authenticated,service_role;

create or replace function private.project_payroll_cycle_bounded(p_week_start date,p_maid_profile_id uuid,p_nested_limit integer)
returns jsonb language sql stable set search_path = '' as $$
with work as (
  select a.status,t.fee_snapshot::bigint * case when exists(
    select 1 from private.bomb_room_report_seals seal
    join private.bomb_room_decisions d on d.submission_id=seal.submission_id
    join public.cleaning_submissions s on s.id=seal.submission_id
    where s.cleaning_attempt_id=a.id and d.decision='approved') then 2 else 1 end amount
  from public.cleaning_attempts a
  join public.cleaning_targets t on t.id=a.cleaning_target_id
  join public.cleaning_assignments assignment on assignment.id=a.assignment_id
  where a.maid_profile_id=p_maid_profile_id and t.status<>'cancelled'
    and t.source<>'inspection_reclean' and assignment.is_current and assignment.notified_at is not null
    and a.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
    and coalesce((a.field_completed_at at time zone 'Asia/Seoul')::date,t.effective_service_date)>=p_week_start
    and coalesce((a.field_completed_at at time zone 'Asia/Seoul')::date,t.effective_service_date)<p_week_start+7
    and not exists(select 1 from public.cleaning_submissions s join public.earnings e on e.submission_id=s.id
      where s.cleaning_attempt_id=a.id)
), confirmed as (
  select coalesce(sum(total_amount),0)::bigint amount from public.earnings
    where maid_profile_id=p_maid_profile_id and earned_on>=p_week_start and earned_on<p_week_start+7
), summary as (
  select coalesce(sum(amount),0)::bigint amount,
    coalesce(sum(amount) filter(where status='submitted'),0)::bigint pending,
    count(*) filter(where status='submitted')::integer pending_count from work
)
select private.project_payroll_cycle_before_workflow(p_week_start,p_maid_profile_id,p_nested_limit)
  || jsonb_build_object('accrualAmount',confirmed.amount,'expectedAmount',confirmed.amount+summary.amount,
    'pendingAmount',summary.pending,'pendingCount',summary.pending_count)
from confirmed cross join summary
$$;

-- Reading this week must not inherit the closed-week gate used by payment commands.
create function private.assert_readable_payroll_week(p_week_start date)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode='22023',message='PAYROLL_WEEK_MUST_START_MONDAY';
  end if;
  if p_week_start > date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date then
    raise exception using errcode='22023',message='PAYROLL_WEEK_NOT_CLOSED';
  end if;
end $$;
revoke all on function private.assert_readable_payroll_week(date) from public,anon,authenticated,service_role;
do $$ declare signature text; definition text; changed text; begin
  foreach signature in array array[
    'public.list_payroll_cycles_page(uuid,date,uuid,uuid,integer)',
    'public.list_payroll_entries_page(uuid,date,uuid,text,date,uuid,integer)',
    'public.get_payroll_cycle(uuid,uuid)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    changed := replace(definition,'private.assert_closed_payroll_week(','private.assert_readable_payroll_week(');
    if changed=definition then raise exception 'Payroll read gate missing: %',signature; end if;
    execute changed;
  end loop;
end $$;
