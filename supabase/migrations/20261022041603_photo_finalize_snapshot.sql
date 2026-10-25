-- #411: retain the separately committed provider acknowledgement, but avoid
-- one HTTP round trip for opt-in finalization + the existing authorized read.
create function public.finalize_photo_upload_with_slots(
  p_actor_profile_id uuid, p_session_id uuid, p_operation_id uuid,
  p_lease_version integer, p_claim_digest text
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare result jsonb; snapshot jsonb := null;
begin
  result := public.finalize_admitted_photo_upload(
    p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
  if result->>'status' = 'accepted' then
    -- Only the optional read is a subtransaction. Its failure cannot roll back
    -- acceptance. Cancellation/connection loss still requires normal receipt recovery.
    begin
      snapshot := public.get_attempt_photo_slots(
        p_actor_profile_id,p_session_id,(result->>'attemptId')::uuid);
    exception when others then
      snapshot := null;
    end;
  end if;
  return jsonb_build_object('upload',result,'photoSlots',snapshot);
end; $$;
revoke all on function public.finalize_photo_upload_with_slots(uuid,uuid,uuid,integer,text)
  from public,anon,authenticated;
grant execute on function public.finalize_photo_upload_with_slots(uuid,uuid,uuid,integer,text)
  to service_role;
