-- #464: release only the caller's exact live claim before a photo identity exists.
-- No reset/backfill, provider deletion, acceptance or capability extension.
create function public.release_pre_provider_photo_upload(
  p_actor_profile_id uuid, p_session_id uuid, p_operation_id uuid,
  p_lease_version integer, p_claim_digest text)
returns boolean language plpgsql security definer set search_path='' as $$
declare o private.photo_upload_operations; s private.photo_upload_states;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform private.assert_admitted_photo_operation(p_operation_id);
  select * into o from private.photo_upload_operations
    where id=p_operation_id and actor_profile_id=p_actor_profile_id;
  if o.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);
  select * into s from private.photo_upload_states where operation_id=o.id for update;
  perform private.assert_photo_operation_session(p_actor_profile_id,p_session_id,o.id);
  if p_lease_version is null or p_lease_version<1 or p_claim_digest is null
    or p_claim_digest !~ '^[0-9a-f]{64}$'
    or s.lease_version is distinct from p_lease_version
    or s.lease_claim_digest is distinct from p_claim_digest then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT';
  end if;
  if s.status<>'reserved'
    or exists(select 1 from private.photo_upload_acceptances where operation_id=o.id)
    or exists(select 1 from private.photo_drive_identities where operation_id=o.id)
    or exists(select 1 from private.photo_provider_objects
      where operation_id=o.id and (provider_locator is not null or uploaded_at is not null)) then
    return false;
  end if;
  if s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then return false; end if;
  -- Keep operation, hash, item, quota reservation and bounded lease count unchanged.
  update private.photo_upload_states set lease_expires_at=clock_timestamp(),revision=revision+1
    where operation_id=o.id;
  return true;
end; $$;
revoke all on function public.release_pre_provider_photo_upload(uuid,uuid,uuid,integer,text)
  from public,anon,authenticated;
grant execute on function public.release_pre_provider_photo_upload(uuid,uuid,uuid,integer,text)
  to service_role;
