-- #332: read only registered reports, never current upload/draft collections.
create function public.list_room_reports_page(
  p_actor_profile_id uuid, p_session_id uuid, p_room_id uuid,
  p_limit integer default 5, p_cursor_at timestamptz default null, p_cursor_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz := clock_timestamp(); room_version bigint; items jsonb; has_more boolean; next_cursor jsonb;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='22023',message='ROOM_OPERATION_PAGE_LIMIT_INVALID';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) or (p_cursor_at is not null and not isfinite(p_cursor_at)) then
    raise exception using errcode='22023',message='INVALID_ROOM_OPERATION_CURSOR';
  end if;
  select state_version into room_version from public.rooms where id=p_room_id;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  with reports as (
    select r.issue_id id, r.cleaning_attempt_id attempt_id, 'room_issue'::text kind,
      r.memo, r.reported_at, r.evidence_photo_ids photo_ids, i.status::text status,
      null::uuid sealed_submission_id
    from public.room_issues i join private.attempt_room_issue_reports r on r.issue_id=i.id
    where i.room_id=p_room_id
    union all
    select r.id,r.cleaning_attempt_id,'bomb_room',r.memo,r.reported_at,
      array(select e.photo_version_id from private.bomb_room_report_evidence e where e.report_id=r.id order by e.photo_version_id),
      coalesce(d.decision,case when s.report_id is null then 'reported' else 'pending' end),s.submission_id
    from private.bomb_room_reports r
    join public.cleaning_attempts a on a.id=r.cleaning_attempt_id
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    left join private.bomb_room_report_seals s on s.report_id=r.id
    left join private.bomb_room_decisions d on d.report_id=r.id
    where t.room_id=p_room_id
  ), selected as (
    select * from reports where p_cursor_at is null or (reported_at,id)<(p_cursor_at,p_cursor_id)
    order by reported_at desc,id desc limit p_limit+1
  ), numbered as (
    select *,row_number() over(order by reported_at desc,id desc) n from selected
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'attemptId',r.attempt_id,'kind',r.kind,'memo',r.memo,'reportedAt',r.reported_at,
      'status',r.status,'sealedSubmissionId',r.sealed_submission_id,
      'evidence',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'photoId',p.id,
          'readState',case
            when m.value->>'mediaAvailability'='purged' then 'purged'
            when (m.value->>'expiresAt')::timestamptz<=at_time then 'expired'
            when ac.photo_version_id is null or obj.provider_locator is null or p.validation_status<>'verified'
              or m.value->>'mediaAvailability' is distinct from 'available' then 'unavailable'
            else 'available' end
        ) || m.value order by ids.ordinality),'[]'::jsonb)
        from unnest(r.photo_ids) with ordinality ids(id,ordinality)
        join private.attempt_photo_versions p on p.id=ids.id and p.cleaning_attempt_id=r.attempt_id
        left join private.photo_upload_acceptances ac on ac.photo_version_id=p.id
        left join private.photo_provider_objects obj on obj.id=ac.object_id
        cross join lateral (select private.photo_retention_metadata(p.id) value) m
      )
    ) order by r.reported_at desc,r.id desc) filter(where n<=p_limit),'[]'::jsonb),
    count(*)>p_limit,
    (jsonb_agg(jsonb_build_object('occurredAt',r.reported_at,'id',r.id)) filter(where n=p_limit))->0
    into items,has_more,next_cursor from numbered r;
  return jsonb_build_object('roomId',p_room_id,'roomStateVersion',room_version,'evaluatedAt',at_time,
    'items',items,'hasMore',has_more,'nextCursor',case when has_more then next_cursor else null end);
end $$;
revoke all on function public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid) to service_role;
