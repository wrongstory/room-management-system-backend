import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const { runBenchmark, summarizePlans, validateBenchmarkSource } = await import('../scripts/benchmark-query-plans.mjs');

function fixture() {
  const results = [];
  for (const eventsPerRoom of [1,100,1000]) for (const cutoff of ['before','middle','latest'])
    for (const mode of ['recorded_only','effective_candidate']) for (const sample of [1,2,3]) {
      results.push({ eventsPerRoom, cutoff, mode, sample, extraIndexBytes: 16384, resultEquivalent: true,
        plan: [{ 'Execution Time': 1, 'Planning Time': 0.1, Plan: { 'Actual Rows': 121,
          'Node Type': 'Nested Loop', 'Local Hit Blocks': 9, Filter: 'never forward SQL literals',
          Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'perf416_effective' }] } }] });
    }
  return { serverVersion: '17.6', scope: 'synthetic-event-order-component', rooms: 121, results };
}

describe('local-only query-plan evidence', () => {
  it('emits bounded aggregate counters, never raw query/filter/rows', () => {
    const output = summarizePlans(JSON.stringify(fixture()));
    expect(output.results).toHaveLength(54);
    expect(output.results[0]).toMatchObject({ executionMs: 1, localHitBlocks: 9, effectiveIndexUsed: true, sortNodes: 0 });
    expect(JSON.stringify(output)).not.toMatch(/never forward|Filter|Plans|Index Scan/);
  });
  it.each(['missing','duplicate','mismatch','bad-size','negative-time','wrong-rows','version-leak'])('rejects %s evidence', (kind) => {
    const input = fixture();
    const row = input.results[0];
    if (!row) throw new Error('fixture missing');
    if (kind === 'missing') input.results.pop();
    if (kind === 'duplicate') input.results[1] = row;
    if (kind === 'mismatch') row.resultEquivalent = false;
    if (kind === 'bad-size') row.eventsPerRoom = 1000000;
    if (kind === 'negative-time' && row.plan[0]) row.plan[0]['Execution Time'] = -1;
    if (kind === 'wrong-rows' && row.plan[0]) row.plan[0].Plan['Actual Rows'] = 120;
    if (kind === 'version-leak') input.serverVersion = 'secret';
    expect(() => summarizePlans(JSON.stringify(input))).toThrow();
  });
  it('binds component predicate/order and existing index to reviewed source', () => {
    const board = readFileSync('supabase/migrations/20261004231650_room_board_date_filters.sql', 'utf8');
    const indexes = readFileSync('supabase/migrations/20260827224644_room_reservation_commands.sql', 'utf8');
    expect(() => validateBenchmarkSource(board, indexes)).not.toThrow();
    expect(() => validateBenchmarkSource(board.replaceAll('event.effective_at <= p_at', 'event.recorded_at <= p_at'), indexes)).toThrow();
    expect(() => validateBenchmarkSource(board, indexes.replaceAll('(room_id, recorded_at desc)', '(room_id, effective_at desc)'))).toThrow();
  });
  it.each(['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','SUPABASE_WORKDIR','SUPABASE_DB_PORT','SUPABASE_PROJECT_ID'])(
    'rejects %s override before any process runs', (name) => {
      const run = vi.fn();
      expect(() => runBenchmark({ env: { [name]: 'override' }, run })).toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  );
  it('pins validated local engine/container/socket and supplies only the fixed temp SQL through stdin', () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: JSON.stringify('npipe:////./pipe/docker_engine'), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ name: '/supabase_db_room-management-system-backend',
        running: true, project: 'room-management-system-backend', ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] } }), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(fixture()), stderr: '' });
    const output = runBenchmark({ env: {}, run });
    expect(output.results).toHaveLength(54);
    const call = run.mock.calls[2];
    expect(call?.[0]).toBe('docker');
    expect(call?.[1]).toEqual(['--context','default','exec','-i','supabase_db_room-management-system-backend','psql','-XqAt',
      '-h','/var/run/postgresql','-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']);
    expect(call?.[2]).toMatchObject({ shell: false, windowsHide: true, timeout: 120000 });
    const sql = String(call?.[2].input);
    expect(sql).toBe(readFileSync('scripts/fixtures/query-plan-event-order.sql', 'utf8'));
    expect(sql).toContain('rollback;');
    expect(sql).not.toMatch(/(?:from|into|update|table|index|on)\s+(?:public|private|auth)\./i);
    expect(sql).not.toMatch(/\b(?:commit|grant|alter|delete)\b(?! drop)/i);
  });
  it.each(['remote','process-error','stderr'])('rejects %s diagnostics without returning them', (kind) => {
    const run = vi.fn().mockReturnValue({ status: kind === 'process-error' ? 1 : 0,
      stdout: JSON.stringify('tcp://untrusted:2375'), stderr: kind === 'stderr' ? 'private diagnostic' : '' });
    expect(() => runBenchmark({ env: {}, run })).toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
