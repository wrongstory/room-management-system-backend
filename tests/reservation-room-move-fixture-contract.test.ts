import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixture = readFileSync(
  new URL('../supabase/tests/reservation_room_move_during_stay.sql', import.meta.url),
  'utf8'
).replaceAll('\r\n', '\n');

describe('#393 inactive room-move fixture evaluation fences', () => {
  it.each([
    ['zero_length_preview_context', '000000000007', '410', 'is null'],
    ['cancelled_preview_context', '000000000008', '444', 'is not null']
  ])('materializes the exact %s identity and CAS tuple before the RPC', (name, id, room, retired) => {
    const start = fixture.indexOf(`with ${name} as materialized (`);
    expect(start).toBeGreaterThan(-1);
    const statement = fixture.slice(start, fixture.indexOf(';', start) + 1);
    const parts = statement.split('\n)\nselect ok(');
    expect(parts).toHaveLength(2);
    const identity = parts[0] ?? '';
    const call = parts[1] ?? '';
    expect(identity).toContain(`where reservation.id='8a200000-0000-4000-8000-${id}'`);
    expect(identity).toContain('stay.reservation_id=reservation.id');
    expect(identity).toContain('segment.stay_id=stay.id');
    expect(identity).toContain(`segment.retired_at ${retired}`);
    expect(identity).toContain('source_room.id=segment.room_id');
    expect(identity).toContain(`target_room.room_number='${room}'`);
    expect(identity).not.toContain('public.preview_reservation_room_move(');
    expect(call).toContain(`from ${name} context`);
    expect(call).not.toMatch(/\bjoin (?:public|private)\./u);
    expect(call).toContain('context.reservation_id,context.target_room_id');
    expect(call).toContain('context.reservation_version,context.source_room_version,context.target_room_version');
    expect(call).toContain('context.source_segment_id');
    expect(call).toContain('context.source_room_id');
    expect(call).toContain("preview->'rejectionReasonCodes'?'RESERVATION_NOT_ACTIVE'");
  });

  it('keeps the original 109 assertions, clocks, permissions and no retry/skip', () => {
    expect(fixture).toContain('select plan(109);');
    expect(fixture).toContain("v_effective_at:=clock_timestamp()+interval '15 seconds';");
    expect(fixture).toContain('begin;');
    expect(fixture).toContain('rollback;');
    expect(fixture).not.toMatch(/\b(?:skip|todo|exception when)\b/iu);
    expect(fixture).not.toMatch(/(?:disable trigger|grant all|session_replication_role)/iu);
    expect((fixture.match(/as materialized \(/gu) ?? []).length).toBe(3);
  });

  it.each(['chained_preview_context'])(
    'also fences the remaining multi-join %s RPC from intermediate rows', (name) => {
      const start = fixture.indexOf(`with ${name} as materialized (`);
      expect(start).toBeGreaterThan(-1);
      const statement = fixture.slice(start, fixture.indexOf(';', start) + 1);
      const parts = statement.split('\n)\nselect ok(');
      expect(parts).toHaveLength(2);
      const identity = parts[0] ?? '';
      const call = parts[1] ?? '';
      expect(identity).toContain('join public.reservations reservation on reservation.id=context.reservation_id');
      expect(identity).not.toContain('public.preview_reservation_room_move(');
      expect(call).toContain(`from ${name} context`);
      expect(call).not.toMatch(/\bjoin (?:public|private)\./u);
      expect(call).toContain('context.reservation_id,context.target_room_id');
      expect(call).toContain('context.reservation_version,context.source_room_version,context.target_room_version');
      expect(identity).toContain('source_segment.id=context.target_segment_id');
      expect(identity).toContain('source_room.id=source_segment.room_id');
      expect(call).toContain("context.effective_at,'OPERATIONAL_ADJUSTMENT'");
      expect(call).toContain("preview->'rejectionReasonCodes'?'TARGET_ROOM_NOT_READY'");
    }
  );
});
