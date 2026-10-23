-- #474: Memo remains required; photos are optional only for supplemental reports.
-- No historical rows/receipts or photo upload policy are changed. Apply only with approval.
alter table private.post_approval_room_issue_reports
  drop constraint post_approval_room_issue_reports_evidence_revision_check,
  drop constraint post_approval_room_issue_reports_evidence_count_check,
  add constraint post_approval_room_issue_reports_evidence_revision_check
    check(evidence_revision between 0 and 9007199254740991),
  add constraint post_approval_room_issue_reports_evidence_count_check
    check(evidence_count between 0 and 10),
  add constraint post_approval_issue_empty_evidence_revision_check
    check((evidence_count=0)=(evidence_revision=0));

-- Existing draft INSERT trigger creates the revision0/item_count0 collection.
-- Existing global/draft locks, exact collection CAS and deferred seal guard are preserved.
create or replace function public.finalize_post_approval_room_issue_report(
  p_actor_profile_id uuid,p_session_id uuid,p_source_submission_id uuid,p_client_report_id uuid,
  p_expected_draft_revision bigint,p_expected_evidence_revision bigint,p_memo text,p_evidence jsonb,
  p_idempotency_key_digest text,p_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor public.profiles; source private.post_approval_room_issue_source_authority;
  d private.post_approval_room_issue_drafts; report private.post_approval_room_issue_reports;
  replay jsonb; result jsonb; evidence jsonb; selected integer; at_time timestamptz;
  cmd constant text:='post_approval_room_issue.finalize';
begin
  if p_source_submission_id is null or p_client_report_id is null or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991 or p_expected_evidence_revision is null
    or p_expected_evidence_revision not between 0 and 9007199254740991 or not private.post_approval_room_issue_memo_valid(p_memo)
    or p_idempotency_key_digest is null or p_idempotency_key_digest!~'^[0-9a-f]{64}$' or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$'
    or jsonb_typeof(p_evidence) is distinct from 'array' then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  if jsonb_array_length(p_evidence) not between 0 and 10 or ((jsonb_array_length(p_evidence)=0) <> (p_expected_evidence_revision=0)) then raise exception using errcode='22023',message='INVALID_POST_APPROVAL_ROOM_ISSUE'; end if;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key_digest,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  source:=private.assert_post_approval_room_issue_source(actor,p_source_submission_id);
  if replay is not null then
    perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
    return private.post_approval_issue_authorized_response(replay,actor,p_session_id,p_source_submission_id);
  end if;
  select * into d from private.post_approval_room_issue_drafts where source_submission_id=p_source_submission_id
    and client_report_id=p_client_report_id and (actor.role='admin' or reported_by_profile_id=actor.id) for update;
  if d.id is null or d.source_submission_id<>p_source_submission_id or d.draft_revision<>p_expected_draft_revision or d.memo<>p_memo
    or not exists(select 1 from private.post_approval_issue_collections c where c.draft_id=d.id and c.revision=p_expected_evidence_revision and c.item_count=jsonb_array_length(p_evidence))
    or exists(select 1 from private.post_approval_room_issue_reports where draft_id=d.id) then raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
  selected:=0;
  for evidence in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(evidence) is distinct from 'object' or (select count(*) from jsonb_object_keys(evidence))<>3
      or not (evidence ?& array['evidenceId','revision','displayOrder']) or jsonb_typeof(evidence->'evidenceId') is distinct from 'string'
      or jsonb_typeof(evidence->'revision') is distinct from 'number' or jsonb_typeof(evidence->'displayOrder') is distinct from 'number'
      or evidence->>'revision'!~'^[1-9][0-9]{0,15}$' or (evidence->>'revision')::bigint>9007199254740991
      or evidence->>'displayOrder'!~'^[0-9]$' or (evidence->>'displayOrder')::integer<>selected
      or not exists(select 1 from private.post_approval_issue_evidence_items i
        join private.post_approval_issue_evidence_acceptances a on a.operation_id=i.operation_id
        join private.post_approval_issue_provider_objects obj on obj.id=a.object_id
        join private.post_approval_issue_upload_states st on st.operation_id=a.operation_id
        where i.id=(evidence->>'evidenceId')::uuid and i.draft_id=d.id and i.revision=(evidence->>'revision')::bigint
          and i.display_order=selected and st.status='accepted' and obj.purged_at is null
          and not exists(select 1 from private.post_approval_issue_delete_barriers where object_id=obj.id)) then
      raise exception using errcode='40001',message='POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID'; end if;
    selected:=selected+1;
  end loop;
  at_time:=clock_timestamp();
  insert into private.post_approval_room_issue_reports(draft_id,source_submission_id,client_report_id,reported_by_profile_id,
    draft_created_by_profile_id,original_performer_profile_id,memo,draft_revision,evidence_revision,evidence_count,reported_at)
    values(d.id,d.source_submission_id,d.client_report_id,actor.id,d.reported_by_profile_id,d.original_performer_profile_id,d.memo,d.draft_revision,p_expected_evidence_revision,selected,at_time) returning * into report;
  insert into private.post_approval_issue_report_seals(report_id,draft_id,evidence_id,item_revision,operation_id,display_order)
    select report.id,d.id,i.id,i.revision,i.operation_id,i.display_order from private.post_approval_issue_evidence_items i where i.draft_id=d.id order by i.display_order;
  result:=jsonb_build_object('source',private.post_approval_room_issue_source_projection(source),'report',private.post_approval_issue_report_projection(report.id));
  -- No memo, media IDs/locators, PIN, inspection/payment or occupancy data in audit/push.
  perform set_config('app.notification_writer_mode','typed_v1',true);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key)
    values('post_approval_room_issue.reported','post_approval_room_issue_report',report.id,actor.id,actor.display_name,at_time,
      jsonb_build_object('sourceSubmissionId',source.source_submission_id,'evidenceCount',selected),private.audit_command_key(actor.id,cmd,p_idempotency_key_digest));
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  perform private.complete_command(actor.id,cmd,p_idempotency_key_digest,p_request_hash,report.id,result);
  perform private.assert_post_approval_room_issue_actor_fresh(p_actor_profile_id,p_session_id);
  return private.post_approval_issue_authorized_response(result,actor,p_session_id,p_source_submission_id);
end $$;

create or replace function private.post_approval_issue_report_projection(p_report uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('reportId',r.id,'clientReportId',r.client_report_id,'sourceSubmissionId',r.source_submission_id,
    'originalPerformerProfileId',r.original_performer_profile_id,'reportedByProfileId',r.reported_by_profile_id,
    'reportedAt',r.reported_at,'memo',r.memo,'evidence',coalesce((select jsonb_agg(jsonb_build_object('evidenceId',evidence_id,
      'revision',item_revision,'displayOrder',display_order) order by display_order) from private.post_approval_issue_report_seals where report_id=r.id),'[]'::jsonb))
  from private.post_approval_room_issue_reports r where r.id=p_report
$$;

-- CREATE OR REPLACE preserves existing ACLs; restate the service-only boundary.
revoke all on function public.finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text) to service_role;
revoke all on function private.post_approval_issue_report_projection(uuid) from public,anon,authenticated,service_role;
