import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { httpAdmissionRoute, beginHttpAdmission } from '../src/modules/developer-reset/http-admission.js';
import { admissionRouteRows, generateAdmissionSql } from '../scripts/generate-operation-admission-sql.mjs';

const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const routes = JSON.parse(read('src/modules/developer-reset/http-admission-routes.json'));
const historical = read('supabase/migrations/20261025032719_operation_admission_authority.sql');

describe('#532 room ready correction maintenance admission', () => {
  it('registers preview as read-only and mutation against its exact command receipt', () => {
    expect(httpAdmissionRoute('POST', '/v1/rooms/room/ready-correction/preview')).toMatchObject({
      routeId: 'previewRoomReadyCorrection', hashMode: 'READ_ONLY', rpc: null,
    });
    expect(httpAdmissionRoute('POST', '/v1/rooms/room/ready-correction')).toMatchObject({
      routeId: 'applyRoomReadyCorrection', authority: 'ACTIVE_SESSION', hashMode: 'CALLER',
      rpc: 'apply_room_ready_correction', commandName: 'room.ready_correction',
    });
    const rows = admissionRouteRows(routes);
    expect(rows).not.toContain("('previewRoomReadyCorrection',");
    expect(rows).toContain("('applyRoomReadyCorrection', 'BUSINESS_WRITE', 'ACTIVE_SESSION', 'CALLER', 'room.ready_correction', 'p_idempotency_key')");
  });

  it('keeps the reviewed historical SQL bytes and does not rewrite source130', () => {
    expect(createHash('sha256').update(historical).digest('hex')).toBe('03d67e06609adad00d72805332c53dc550000145368f428e21f2168bc6ca2b43');
    expect(generateAdmissionSql(routes, read('scripts/operation-admission.sql.in'))).toBe(historical);
  });

  it('blocks correction during maintenance before identity or command execution', async () => {
    const identity = vi.fn(async () => undefined);
    const rpc = vi.fn(async () => ({ data: {
      mode: 'REQUESTED', controlVersion: '5', targetRef: 'test-project',
    }, error: null }));
    await expect(beginHttpAdmission({ config: { target: 'test-project', budgetMs: 1000 },
      route: httpAdmissionRoute('POST', '/v1/rooms/room/ready-correction'), identity, rpc,
    })).rejects.toMatchObject({ code: 'OPERATION_MAINTENANCE_REQUESTED' });
    expect(identity).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not acquire a write admission for the read-only impact preview', async () => {
    const identity = vi.fn(async () => undefined);
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    expect(await beginHttpAdmission({ config: { target: 'test-project', budgetMs: 1000 },
      route: httpAdmissionRoute('POST', '/v1/rooms/room/ready-correction/preview'), identity, rpc,
    })).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it('binds an OPEN admission to the same receipt hash consumed by the new SQL command', async () => {
    const actor = { profileId: '00000000-0000-4000-8000-000000000001',
      authUserId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
    const rpc = vi.fn(async (name: string) => ({ data: name === 'get_operation_admission_control'
      ? { mode: 'OPEN', controlVersion: '5', targetRef: 'test-project' }
      : name === 'acquire_operation_http_admission'
      ? { admissionId: '00000000-0000-4000-8000-000000000004', controlVersion: '5', completionMode: 'COMMAND_RECEIPT' }
      : { completed: true }, error: null }));
    const scope = await beginHttpAdmission({ config: { target: 'test-project', budgetMs: 1000 },
      route: httpAdmissionRoute('POST', '/v1/rooms/room/ready-correction'), identity: async () => actor, rpc,
      nonce: () => 'b'.repeat(64) });
    const args = { p_actor_profile_id: actor.profileId, p_idempotency_key: 'room-ready-confirmation', p_request_hash: 'a'.repeat(64) };
    expect(await scope?.execute('apply_room_ready_correction', args, async () => 'corrected')).toBe('corrected');
    expect(rpc).toHaveBeenNthCalledWith(2, 'acquire_operation_http_admission',
      expect.objectContaining({ p_route_id: 'applyRoomReadyCorrection', p_request_hash: args.p_request_hash,
        p_command_name: 'room.ready_correction', p_idempotency_key: args.p_idempotency_key }), expect.any(AbortSignal));
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_operation_admission_control', 'acquire_operation_http_admission', 'complete_operation_http_admission',
    ]);
    const sql = read('supabase/migrations/20261030123748_room_ready_correction.sql');
    const command = sql.split('create function public.apply_room_ready_correction')[1]?.split('\nend $$;')[0] ?? '';
    expect(command).toContain('canonical_hash:=p_request_hash;');
    expect(command).toContain("private.complete_command(p_actor_profile_id,'room.ready_correction',p_idempotency_key,canonical_hash,p_room_id,result)");
    expect(sql).toContain("'hashMode','CALLER','commandName','room.ready_correction','keyArgument','p_idempotency_key'");
  });

  it('declares the exact two new live-session signatures and preserves the room timeline identity', () => {
    const sql = read('supabase/migrations/20261030123748_room_ready_correction.sql');
    const fixture = read('supabase/tests/limited_existing_session_discovery.sql');
    const signatures = [
      'public.preview_room_ready_correction(uuid,uuid,uuid,text)',
      'public.apply_room_ready_correction(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,boolean,boolean,boolean,text,text,text)',
    ];
    const section = fixture.split('-- BEGIN APPROVED ROOM READY SESSION EXTENSIONS')[1]?.split('-- END APPROVED ROOM READY SESSION EXTENSIONS')[0] ?? '';
    const entries = [...section.matchAll(/\('([^']+)','([^']+)','fresh','v','service-only'\)/g)];
    expect(entries.map((entry) => entry[1])).toEqual(signatures);
    for (const signature of signatures) {
      const name = signature.split('(')[0] ?? '';
      const body = sql.split(`create function ${name}`)[1]?.split('\nend $$;')[0] ?? '';
      expect(body.split('private.assert_attempt_actor_session_fresh(')).toHaveLength(3);
      expect(fixture).toContain(`to_regprocedure('${signature}') is null`);
      expect(fixture).toContain(`to_regprocedure('${signature}') is not null`);
    }
    expect(sql).toContain("pg_get_functiondef('public.list_room_events(uuid,uuid,uuid,integer)'::regprocedure)");
    expect(sql).not.toContain('list_room_events_before_ready_correction');
    expect(sql).toContain('ROOM_READY_HISTORY_SOURCE_DRIFT');
  });

  it.each(['marker', 'route', 'method', 'rpc', 'command', 'path', 'role', 'key', 'alias', 'binding'])(
    'rejects a changed %s extension instead of hiding it from historical checks', (field) => {
      const changed = structuredClone(routes);
      const route = changed.find((r: { routeId: string }) => r.routeId === 'applyRoomReadyCorrection');
      if (field === 'marker') delete route.sqlExtension;
      if (field === 'route') route.routeId = 'unreviewedRoute';
      if (field === 'method') route.method = 'DELETE';
      if (field === 'rpc') route.rpc = 'arbitrary_command';
      if (field === 'command') route.commandName = 'reservation.create';
      if (field === 'path') route.path += '/bypass';
      if (field === 'role') route.authority = 'LIMITED_SESSION';
      if (field === 'key') route.keyArgument = 'p_idempotency_key_digest';
      if (field === 'alias') route.rpcAliases.push('arbitrary_command');
      if (field === 'binding') route.bindings = { p_action: 'delete' };
      expect(() => generateAdmissionSql(changed, read('scripts/operation-admission.sql.in'))).toThrow('ADMISSION_MANIFEST_INVALID');
    },
  );
});
