import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runRoomBoardBenchmark, summarizeRoomBoard } from '../scripts/benchmark-room-board.mjs';

function fixture() {
  const results: Record<string, unknown>[] = [];
  for (const mode of ['recorded_only','effective_candidate']) for (const sample of [1,2,3]) {
    for (const dayOffset of [-2,0,1]) results.push({ kind: 'read', mode, sample, dayOffset,
      resultEquivalent: true, denials: 2, extraIndexBytes: 0,
      plan: [{ 'Execution Time': 1, 'Planning Time': 0.1, Plan: { 'Node Type': 'Function Scan', 'Actual Rows': 121,
        'Shared Hit Blocks': 5, Filter: 'private row data', Plans: [{ 'Shared Hit Blocks': 999 }] } }] });
    for (const table of ['room_candle_events','room_pin_sync_events']) results.push({ kind: 'write', mode, sample, table,
      extraIndexBytes: 16384, plan: [{ 'Execution Time': 3, 'Planning Time': 0.1,
        Triggers: [{ Time: 2, 'Trigger Name': 'private trigger' }],
        Plan: { 'Node Type': 'ModifyTable', 'Actual Rows': 121, 'WAL Bytes': 44, 'WAL Records': 4 } }] });
  }
  return { scope: 'local-room-board-rpc-and-event-write', serverVersion: '17.6', rooms: 121, eventsPerRoom: 100, results };
}
function processMock() {
  return vi.fn().mockReturnValueOnce({ status: 0, stdout: JSON.stringify('npipe:////./pipe/docker_engine'), stderr: '' })
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ name: '/supabase_db_room-management-system-backend',
      running: true, project: 'room-management-system-backend', ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] } }), stderr: '' })
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(fixture()), stderr: '' });
}
describe('local room-board RPC and event write benchmark', () => {
  it('returns 18 reads and 12 writes with allowlisted root counters only', () => {
    const output = summarizeRoomBoard(JSON.stringify(fixture()));
    expect(output.results.filter((row) => row.kind === 'read')).toHaveLength(18);
    expect(output.results.filter((row) => row.kind === 'write')).toHaveLength(12);
    expect(output.results[0]).toMatchObject({ sharedHitBlocks: 5, resultEquivalent: true, denials: 2 });
    expect(output.results[3]).toMatchObject({ triggerMs: 2, walBytes: 44, walRecords: 4 });
    expect(JSON.stringify(output)).not.toMatch(/private|Filter|Plans|999|Trigger Name/);
  });
  it.each(['missing','duplicate','mismatch','denial','day','table','sample','version','count','time','rows','node','wal','trigger'])(
    'rejects incomplete or unsafe %s evidence', (kind) => {
      const input = fixture();
      const row = input.results[0];
      const write = input.results[3];
      if (!row || !write) throw new Error('fixture missing');
      if (kind === 'missing') input.results.pop();
      if (kind === 'duplicate') input.results[1] = row;
      if (kind === 'mismatch') row.resultEquivalent = false;
      if (kind === 'denial') row.denials = 1;
      if (kind === 'day') row.dayOffset = 999;
      if (kind === 'table') write.table = 'private';
      if (kind === 'sample') row.sample = 4;
      if (kind === 'version') input.serverVersion = 'private';
      if (kind === 'count') input.eventsPerRoom = 1;
      if (kind === 'time') row.plan = [{ 'Execution Time': -1, Plan: { 'Node Type': 'Function Scan', 'Actual Rows': 121 } }];
      if (kind === 'rows') row.plan = [{ Plan: { 'Node Type': 'Function Scan', 'Actual Rows': 120 } }];
      if (kind === 'node') row.plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 121 } }];
      if (kind === 'wal') write.plan = [{ Plan: { 'Node Type': 'ModifyTable', 'Actual Rows': 121, 'WAL Bytes': -1 } }];
      if (kind === 'trigger') write.plan = [{ 'Execution Time': 1, 'Planning Time': 1,
        Plan: { 'Node Type': 'ModifyTable', 'Actual Rows': 121 }, Triggers: [{ Time: -1 }] }];
      expect(() => summarizeRoomBoard(JSON.stringify(input))).toThrow();
    }
  );
  it.each(['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','SUPABASE_WORKDIR','SUPABASE_DB_PORT','SUPABASE_PROJECT_ID'])(
    'rejects %s before running a process', (name) => {
      const run = vi.fn();
      expect(() => runRoomBoardBenchmark({ env: { [name]: 'override' }, run })).toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  );
  it('pins local socket and fixed rollback fixture, never takes a target or SQL argument', () => {
    const run = processMock();
    expect(runRoomBoardBenchmark({ env: {}, run }).results).toHaveLength(30);
    expect(run.mock.calls[2]?.[1]).toEqual(['--context','default','exec','-i','supabase_db_room-management-system-backend',
      'psql','-XqAt','-h','/var/run/postgresql','-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']);
    const options = run.mock.calls[2]?.[2];
    expect(options).toMatchObject({ shell: false, timeout: 120000, windowsHide: true });
    const sql = readFileSync('scripts/fixtures/query-plan-room-board.sql','utf8');
    expect(options.input).toBe(sql);
    expect(sql).toContain('PERF416_EMPTY_LOCAL_BASELINE_REQUIRED');
    expect(sql).toContain("execute 'set local role service_role'");
    expect(sql).toContain("exception when sqlstate 'P0416'");
    expect(sql).toContain('PERF416_WRITE_ROLLBACK_MISMATCH');
    expect(sql).toMatch(/rollback;[\s\S]*PERF416_CLEANUP_FAILED/);
    expect(sql).not.toMatch(/\b(?:delete from|truncate|disable trigger|commit;|alter table)\b/i);
    expect(sql).not.toContain('room_pin_secrets');
  });
  it.each(['remote','stderr','process-error'])('fails closed on %s without forwarding raw diagnostics', (kind) => {
    const run = vi.fn().mockReturnValue({ status: kind === 'process-error' ? 1 : 0,
      stdout: JSON.stringify('tcp://remote:2375'), stderr: kind === 'stderr' ? 'private failure' : '' });
    expect(() => runRoomBoardBenchmark({ env: {}, run })).toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
