import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Only the disposable local synthetic database; the parent db:test owns scheduling.
const cli = 'node_modules/supabase/dist/supabase.js';
const run = (command, args, input) => execFileSync(command, args, {
  encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit'
});
const sql = (input) => run('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input).trim();
const id = (n) => `34300000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function upgradeFixture() {
  const source = readFileSync('supabase/tests/complaint_response_attention.sql', 'utf8');
  const beginMarker = '-- BEGIN COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE';
  const endMarker = '-- END COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  assert(begin >= 0 && end > begin, 'Complaint attention upgrade fixture markers must exist');
  const fixture = source.slice(begin + beginMarker.length, end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*select\s+(?:no_plan\(\)|plan\([^;]*\)|(?:\*\s+from\s+)?finish\(\))\s*;\s*$/i.test(line))
    .join('\n');
  assert(fixture.includes('create function pg_temp.attention_case('),
    'Complaint attention case helper must be inside the shared markers');
  assert(fixture.includes('select pg_temp.attention_case(2,true);'),
    'Shared fixture must include the pre-response correction case');
  assert(!/\b(?:no_plan|plan|finish)\s*\(/i.test(fixture),
    'Extracted fixture cannot execute TAP planning or finish statements');
  return fixture;
}

const lifecycle = (asOfSql, key, hash = '9') => `select public.process_due_assignment_lifecycle(
  '${id(1)}',${asOfSql},'${key}',repeat('${hash}',64));`;
const preservedSnapshot = () => JSON.parse(sql(`select json_build_object(
  'digest',md5(string_agg(tag||':'||data,'|' order by tag,data)),
  'cases',(select count(*) from public.complaint_cases),
  'decisions',(select count(*) from public.complaint_decisions),
  'responses',(select count(*) from public.complaint_maid_responses),
  'events',(select count(*) from public.complaint_case_events),
  'audits',(select count(*) from public.audit_events),
  'receipts',(select count(*) from private.command_executions),
  'notices',(select count(*) from public.notifications),
  'groups',(select count(*) from private.notification_groups),
  'deliveries',(select count(*) from private.notification_delivery_outbox)
) from (
  select 'case' tag,row_to_json(t)::text data from public.complaint_cases t union all
  select 'decision',row_to_json(t)::text from public.complaint_decisions t union all
  select 'response',row_to_json(t)::text from public.complaint_maid_responses t union all
  select 'event',row_to_json(t)::text from public.complaint_case_events t union all
  select 'audit',row_to_json(t)::text from public.audit_events t union all
  select 'receipt',row_to_json(t)::text from private.command_executions t union all
  select 'notice',row_to_json(t)::text from public.notifications t union all
  select 'group',row_to_json(t)::text from private.notification_groups t union all
  select 'delivery',row_to_json(t)::text from private.notification_delivery_outbox t
) preserved;`));

try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001113931']);
  sql(`begin; ${upgradeFixture()} commit;`);
  const future = sql(`select (max(response_deadline)+interval '1 second')::text
    from public.complaint_cases where original_earning_id in
      ('${id(50001)}','${id(50002)}','${id(50003)}','${id(50004)}','${id(50005)}');`);
  assert(future.length > 0, 'Fixture must expose a finite future attention threshold');

  const oldReceipt = JSON.parse(sql(lifecycle('transaction_timestamp()', 'attention-upgrade-old', '8')));
  assert.equal(Object.hasOwn(oldReceipt, 'complaintAttentionCount'), false,
    'Version 91 receipt predates complaint attention output');
  const before = preservedSnapshot();

  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.deepEqual(preservedSnapshot(), before,
    '91→92 preserves exact complaint cases, decisions, responses, events, audit, receipts and notification history');
  assert.equal(sql('select count(*) from private.complaint_response_attention_events;'), '0',
    'Installing version 92 never backfills historical attention evidence');
  assert.equal(sql("select count(*) from public.notifications where event_family='complaint.response_attention_admin';"), '0',
    'Installing version 92 never backfills historical attention notices');

  assert.deepEqual(JSON.parse(sql(lifecycle(`'${future}'::timestamptz`, 'attention-upgrade-old', '8'))), oldReceipt,
    'Completed version 91 scheduler receipt replays byte-equivalent output after version 92');
  assert.deepEqual(preservedSnapshot(), before,
    'Old scheduler receipt replay cannot manufacture attention evidence or notices');

  const detected = JSON.parse(sql(lifecycle(`'${future}'::timestamptz`, 'attention-upgrade-new', '7')));
  assert.equal(detected.complaintAttentionCount, 2,
    'A new version 92 scheduler command detects only unanswered initial-decision cases');
  const state = JSON.parse(sql(`select json_build_object(
    'events',(select count(*) from private.complaint_response_attention_events),
    'recipients',(select count(*) from private.complaint_response_attention_recipients),
    'notices',(select count(*) from public.notifications where event_family='complaint.response_attention_admin'),
    'deliveries',(select count(*) from private.notification_delivery_outbox where event_family='complaint.response_attention_admin'),
    'sourceValid',not exists(select 1 from public.notifications n
      where n.event_family='complaint.response_attention_admin' and not exists(
        select 1 from private.complaint_response_attention_events e
        where e.id::text=n.source_entity_id and e.complaint_case_id=n.deep_link_entity_id)),
    'correctedValid',exists(select 1 from private.complaint_response_attention_events e
      join public.complaint_cases c on c.id=e.complaint_case_id
      join public.complaint_decisions initial on initial.id=e.initial_decision_id
      join public.complaint_decisions current on current.id=e.current_decision_id
      where c.original_earning_id='${id(50002)}' and initial.decision_version=1
        and current.decision_version=2 and e.case_version=4
        and e.response_deadline=e.first_decided_at+interval '7 days'),
    'answeredEvents',(select count(*) from private.complaint_response_attention_events e
      join public.complaint_cases c on c.id=e.complaint_case_id
      where c.original_earning_id in ('${id(50003)}','${id(50004)}','${id(50005)}')),
    'missingDeadlinePreserved',exists(select 1 from public.complaint_cases c
      where c.original_earning_id='${id(50011)}' and c.status='decided' and c.response_deadline is null
        and not exists(select 1 from private.complaint_response_attention_events e where e.complaint_case_id=c.id))
  );`));
  assert.deepEqual(state, {
    events: 2, recipients: 4, notices: 4, deliveries: 2,
    sourceValid: true, correctedValid: true, answeredEvents: 0, missingDeadlinePreserved: true
  }, 'New detection uses UUID event provenance, exact admin fanout, original threshold and excludes answered history');
  console.log('Complaint response attention upgrade 91→92: PASS; exact old history/receipt preserved, no backlog writes, new detection valid.');
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001210323']);
}
