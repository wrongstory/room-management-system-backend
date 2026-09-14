-- #73: reservation room changes update the reservation, checkout obligation,
-- and planned checkout target in one command transaction.  Keep the composite
-- reservation/room identity strict at commit while allowing those three rows to
-- move through a temporarily inconsistent statement boundary.
--
-- This does not disable or drop the FK.  The existing deferred planned-target
-- and obligation contract FKs plus validate_planned_checkout_at_commit() still
-- require the complete graph to agree before COMMIT.
alter table public.cleaning_targets
  alter constraint cleaning_targets_reservation_room_fk
  deferrable initially deferred;

comment on constraint cleaning_targets_reservation_room_fk
on public.cleaning_targets is
  'Commit-time reservation/room identity guard. Deferred only so change_reservation can atomically synchronize reservation, obligation, and planned target; violations still fail at commit.';
