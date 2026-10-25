import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const originalPath = 'supabase/migrations/20261004231650_room_board_date_filters.sql';
const appendPath = 'supabase/migrations/20261004231704_room_board_live_projection_compatibility.sql';
const original = readFileSync(originalPath, 'utf8').replaceAll('\r\n', '\n');
const append = readFileSync(appendPath, 'utf8').replaceAll('\r\n', '\n');
const liveFixture = readFileSync('supabase/tests/room_board_live_projection_compatibility.sql', 'utf8').replaceAll('\r\n', '\n');

describe('#318 unapplied baseline ordering and LIVE compatibility source contract', () => {
  it('keeps public correction commands service-role and private ledger readback fixture-owner only', () => {
    const vacantReplay = liveFixture.indexOf("'vacant correction response-loss retry replays the identical receipt'");
    const vacantLedger = liveFixture.indexOf('select is((select count(*)::int from private.room_occupancy_corrections');
    const occupiedCommand = liveFixture.indexOf('create temporary table occupied_correction_result');
    const occupiedReplay = liveFixture.indexOf("'occupied restoration response-loss retry replays the identical receipt'");
    const occupiedLedger = liveFixture.indexOf('select is((select count(*)::int from private.room_occupancy_corrections', vacantLedger + 1);
    const checkoutCommand = liveFixture.indexOf('select public.manual_checkout_reservation(');
    expect(vacantReplay).toBeGreaterThan(0);
    expect(occupiedReplay).toBeGreaterThan(occupiedCommand);
    expect(liveFixture.slice(vacantReplay, vacantLedger)).toContain('reset role;');
    expect(liveFixture.slice(vacantLedger, occupiedCommand)).toContain('set local role service_role;');
    expect(liveFixture.slice(occupiedReplay, occupiedLedger)).toContain('reset role;');
    expect(liveFixture.slice(occupiedLedger, checkoutCommand)).toContain('set local role service_role;');
    expect(liveFixture).not.toMatch(/^\s*grant\b|disable\s+(?:trigger|row level security)/im);
  });
  it('preserves the complete original SQL while appending after existing-session discovery', () => {
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      '65acd2eb26b2605660750c84f1ef20a8d7027bdfe2107c733bfae2680e32a9c6'
    );
    const manifest = JSON.parse(readFileSync('supabase/migration-manifest.dev.json', 'utf8')) as {
      migrations: { name: string; version: string }[];
    };
    const boardIndex = manifest.migrations.findIndex((entry) => entry.name === 'room_board_date_filters');
    const sessionIndex = manifest.migrations.findIndex((entry) => entry.name === 'limited_existing_session_discovery');
    const appendIndex = manifest.migrations.findIndex((entry) => entry.name === 'room_board_live_projection_compatibility');
    expect(boardIndex).toBeGreaterThan(0);
    expect(appendIndex).toBe(boardIndex + 1);
    // #329 is integrated separately; once present, its strict migration-time
    // caller/snapshot inventories must precede the new board RPC.
    if (sessionIndex >= 0) expect(boardIndex).toBeGreaterThan(sessionIndex);
  });

  it('fails closed against the exact original RPC body and single fragment matches', () => {
    const rpc = original.slice(original.indexOf('create function public.get_room_board_projection('));
    const start = rpc.indexOf('as $$') + 'as $$'.length;
    const body = rpc.slice(start, rpc.indexOf('$$;', start));
    const md5 = createHash('md5').update(body).digest('hex');
    expect(md5).toBe('7a4ca74a6410734ac72b251a2cf6c418');
    expect(append).toContain(`md5(old_source) <> '${md5}'`);
    expect(append).toContain('ROOM_BOARD_LIVE_FRAGMENT_DRIFT');
    expect(append).toContain('ROOM_BOARD_LIVE_DEFINITION_DRIFT');
    for (const fragment of [
      'v_server_time timestamptz := clock_timestamp();',
      'private.room_board_cleaning_required_at(room.id, v_evaluated_at) as cleaning_required',
      'private.room_board_pin_sync_status_at(room.id, v_evaluated_at) as pin_status',
      'and (segment.ends_at is null or segment.ends_at > v_evaluated_at)\n    order by segment.starts_at desc, segment.id desc'
    ]) {
      expect(body.split(fragment)).toHaveLength(2);
      expect(append).toContain(fragment.replaceAll('\n', '\\n'));
    }
  });

  it('changes only LIVE selection and the STABLE request clock, retaining date-aware branches', () => {
    expect(append.match(/v_projection_mode = ''LIVE''/g)).toHaveLength(3);
    expect(append).toContain('then private.room_current_cleaning_required_at(room.id, v_evaluated_at)');
    expect(append).toContain('else private.room_board_cleaning_required_at(room.id, v_evaluated_at)');
    expect(append).toContain('then private.current_pin_sync_status(room.id)');
    expect(append).toContain('else private.room_board_pin_sync_status_at(room.id, v_evaluated_at)');
    expect(append).toContain("v_projection_mode = ''LIVE'' and stay.status = ''active''");
    expect(append).toContain('reservation.actual_check_in_at is not null');
    expect(append).toContain('reservation.actual_check_in_at <= v_evaluated_at');
    expect(append).toContain('reservation.actual_checkout_at is null');
    expect(append).toContain('segment.room_id = private.reservation_final_room_id(reservation.id)');
    expect(append).toContain('segment.ends_at is null or segment.ends_at > v_evaluated_at');
    expect(append).toContain('correction.successor_segment_id = segment.id');
    expect(append).toContain('and not correction.occupied');
    expect(append).toContain('correction.effective_at <= v_evaluated_at');
    expect(append).not.toContain('segment.terminal_reason_code');
    expect(append).not.toMatch(/\b(?:insert into|update public\.|delete from|grant execute|revoke all)\b/i);
  });

  it('uses the statement clock without changing the original STABLE declaration or date boundaries', () => {
    expect(append).toContain("'v_server_time timestamptz := clock_timestamp();'");
    expect(append).toContain("'v_server_time timestamptz := statement_timestamp();'");
    expect(append).not.toMatch(/alter function.*volatile|transaction_timestamp\(\)|now\(\)/iu);
    expect(original).toContain('v_server_time timestamptz := clock_timestamp();');
    expect(liveFixture).toContain('with delayed_live_clock as materialized (');
    expect(liveFixture).toContain('pg_sleep(0.02)');
    expect(liveFixture).toContain('board.server_time=statement_timestamp()');
    expect(liveFixture).toContain('board.evaluated_at=statement_timestamp()');
  });

  it('preserves OID, ACL, owner and security/volatility/signature attributes', () => {
    expect(append).toContain('proacl is distinct from old_acl');
    expect(append).toContain('proowner <> old_owner');
    expect(append).toContain('provolatile, prosecdef, proconfig, prorettype, proargtypes::text');
    expect(append).toContain('ROOM_BOARD_LIVE_ATTRIBUTES_DRIFT');
    expect(append).toContain('execute replace(definition, old_source, new_source)');
  });
});
