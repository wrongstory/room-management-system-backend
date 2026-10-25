-- #416: measured local component + full RPC evidence in PR #420.
-- Add only the historical/effective lookup path. Keep recorded-order indexes
-- used by current-state helpers and the candle recording-order trigger.
-- Ordinary transactional builds: release under a brief write pause; do not
-- pretend this is CONCURRENTLY. Lock contention fails instead of waiting long.
set local lock_timeout = '5s';

create index room_candle_events_effective_lookup_idx
  on public.room_candle_events (room_id, effective_at desc, recorded_at desc, id desc);
create index room_pin_sync_events_effective_lookup_idx
  on public.room_pin_sync_events (room_id, effective_at desc, recorded_at desc, id desc);
