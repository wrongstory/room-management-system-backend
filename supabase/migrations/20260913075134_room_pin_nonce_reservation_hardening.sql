-- Issue #140 follow-up: reserve every room-PIN AES-GCM nonce across both the
-- physical-change lease path and the direct bootstrap revision path.
-- Existing rows are never rewritten. A 52 -> 53 upgrade aborts if historical
-- rows prove that one key-version/nonce pair represented different encryption
-- identities. A confirmed lease and its byte-for-byte matching revision are
-- one logical encryption and therefore share one reservation.

-- The installed CLI requires LOCK TABLE to be inside an authored transaction.
-- Retain both locks through validation, backfill and trigger installation.
begin;

lock table
  private.room_pin_change_leases,
  private.room_pin_revisions
in share row exclusive mode;

create function private.room_pin_envelope_fingerprint(
  p_room_id uuid,
  p_pin_version bigint,
  p_envelope_format smallint,
  p_ciphertext bytea,
  p_auth_tag bytea,
  p_key_version text,
  p_aad_environment text,
  p_aad_project_ref text
)
returns bytea
language sql
immutable
security definer
set search_path = ''
as $$
  select extensions.digest(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        p_room_id,
        p_pin_version,
        p_envelope_format,
        pg_catalog.encode(p_ciphertext, 'base64'),
        pg_catalog.encode(p_auth_tag, 'base64'),
        p_key_version,
        p_aad_environment,
        p_aad_project_ref
      )::text,
      'UTF8'
    ),
    'sha256'
  )
$$;

revoke all on function private.room_pin_envelope_fingerprint(
  uuid, bigint, smallint, bytea, bytea, text, text, text
) from public, anon, authenticated, service_role;

create table private.room_pin_nonce_reservations (
  id uuid primary key default gen_random_uuid(),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  nonce bytea not null check (octet_length(nonce) = 12),
  envelope_fingerprint bytea not null check (octet_length(envelope_fingerprint) = 32),
  reserved_at timestamptz not null default clock_timestamp(),
  unique (key_version, nonce)
);

alter table private.room_pin_nonce_reservations enable row level security;
alter table private.room_pin_nonce_reservations force row level security;
revoke all on table private.room_pin_nonce_reservations
from public, anon, authenticated, service_role;

-- Validate the complete applied history before installing the registry. The
-- exception rolls this migration back atomically and leaves every lease and
-- revision untouched for operator investigation.
do $$
begin
  if exists (
    with encryption_history as (
      select
        lease.key_version,
        lease.nonce,
        private.room_pin_envelope_fingerprint(
          lease.room_id,
          lease.proposed_pin_version,
          lease.envelope_format,
          lease.ciphertext,
          lease.auth_tag,
          lease.key_version,
          lease.aad_environment,
          lease.aad_project_ref
        ) as envelope_fingerprint
      from private.room_pin_change_leases lease
      union all
      select
        revision.key_version,
        revision.nonce,
        private.room_pin_envelope_fingerprint(
          revision.room_id,
          revision.pin_version,
          revision.envelope_format,
          revision.ciphertext,
          revision.auth_tag,
          revision.key_version,
          revision.aad_environment,
          revision.aad_project_ref
        ) as envelope_fingerprint
      from private.room_pin_revisions revision
    )
    select 1
    from encryption_history history
    group by history.key_version, history.nonce
    having count(distinct history.envelope_fingerprint) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'ROOM_PIN_HISTORICAL_NONCE_REUSE';
  end if;
end;
$$;

insert into private.room_pin_nonce_reservations (
  key_version,
  nonce,
  envelope_fingerprint,
  reserved_at
)
select distinct on (history.key_version, history.nonce)
  history.key_version,
  history.nonce,
  history.envelope_fingerprint,
  history.reserved_at
from (
  select
    lease.key_version,
    lease.nonce,
    private.room_pin_envelope_fingerprint(
      lease.room_id,
      lease.proposed_pin_version,
      lease.envelope_format,
      lease.ciphertext,
      lease.auth_tag,
      lease.key_version,
      lease.aad_environment,
      lease.aad_project_ref
    ) as envelope_fingerprint,
    lease.prepared_at as reserved_at
  from private.room_pin_change_leases lease
  union all
  select
    revision.key_version,
    revision.nonce,
    private.room_pin_envelope_fingerprint(
      revision.room_id,
      revision.pin_version,
      revision.envelope_format,
      revision.ciphertext,
      revision.auth_tag,
      revision.key_version,
      revision.aad_environment,
      revision.aad_project_ref
    ) as envelope_fingerprint,
    revision.created_at as reserved_at
  from private.room_pin_revisions revision
) history
order by history.key_version, history.nonce, history.reserved_at;

create function private.reserve_room_pin_nonce_from_envelope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pin_version bigint;
  v_fingerprint bytea;
  v_reserved_fingerprint bytea;
begin
  v_pin_version := case
    when tg_table_name = 'room_pin_change_leases'
      then (pg_catalog.to_jsonb(new)->>'proposed_pin_version')::bigint
    else (pg_catalog.to_jsonb(new)->>'pin_version')::bigint
  end;
  v_fingerprint := private.room_pin_envelope_fingerprint(
    new.room_id,
    v_pin_version,
    new.envelope_format,
    new.ciphertext,
    new.auth_tag,
    new.key_version,
    new.aad_environment,
    new.aad_project_ref
  );

  insert into private.room_pin_nonce_reservations (
    key_version,
    nonce,
    envelope_fingerprint
  ) values (
    new.key_version,
    new.nonce,
    v_fingerprint
  )
  on conflict (key_version, nonce) do nothing;

  select reservation.envelope_fingerprint
  into strict v_reserved_fingerprint
  from private.room_pin_nonce_reservations reservation
  where reservation.key_version = new.key_version
    and reservation.nonce = new.nonce
  for update;

  if v_reserved_fingerprint <> v_fingerprint then
    raise exception using
      errcode = '23505',
      message = 'ROOM_PIN_NONCE_REUSE';
  end if;

  return new;
end;
$$;

revoke all on function private.reserve_room_pin_nonce_from_envelope()
from public, anon, authenticated, service_role;

-- Lease lifecycle transitions update status/timestamps in place, but the
-- encryption identity that owns the global nonce reservation is immutable.
-- This closes the UPDATE path as well as the INSERT path protected below.
create function private.guard_room_pin_change_lease_encryption_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.room_id is distinct from old.room_id
    or new.expected_pin_version is distinct from old.expected_pin_version
    or new.proposed_pin_version is distinct from old.proposed_pin_version
    or new.envelope_format is distinct from old.envelope_format
    or new.ciphertext is distinct from old.ciphertext
    or new.nonce is distinct from old.nonce
    or new.auth_tag is distinct from old.auth_tag
    or new.key_version is distinct from old.key_version
    or new.aad_environment is distinct from old.aad_environment
    or new.aad_project_ref is distinct from old.aad_project_ref
  then
    raise exception using
      errcode = '55000',
      message = 'ROOM_PIN_CHANGE_ENCRYPTION_IDENTITY_IMMUTABLE';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_room_pin_change_lease_encryption_identity()
from public, anon, authenticated, service_role;

create trigger room_pin_change_lease_nonce_reserved
before insert on private.room_pin_change_leases
for each row execute function private.reserve_room_pin_nonce_from_envelope();

create trigger room_pin_change_lease_encryption_identity_immutable
before update on private.room_pin_change_leases
for each row execute function private.guard_room_pin_change_lease_encryption_identity();

create trigger room_pin_revision_nonce_reserved
before insert on private.room_pin_revisions
for each row execute function private.reserve_room_pin_nonce_from_envelope();

create trigger room_pin_nonce_reservations_append_only
before update or delete on private.room_pin_nonce_reservations
for each row execute function private.prevent_append_only_mutation();

comment on table private.room_pin_nonce_reservations is
  'Private cross-flow AES-GCM nonce registry. One key-version/nonce pair may identify only one logical room PIN encryption; a confirmed lease and its matching revision share it.';

commit;
