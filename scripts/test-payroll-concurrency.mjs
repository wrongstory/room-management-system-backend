import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}

const container = 'supabase_db_room-management-system-backend';
const psqlArgs = [
  'exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1'
];

export async function testPayrollConcurrency(client, adminProfileId) {
  const url = new URL(client.supabaseUrl);
  assert(
    ['localhost', '127.0.0.1'].includes(url.hostname),
    'payroll races require local Supabase'
  );

  function sql(statement) {
    try {
      return execFileSync('docker', psqlArgs, {
        input: `set statement_timeout='10s';${statement}`,
        encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch {
      throw new Error('payroll local fixture/check failed (raw details redacted)');
    }
  }

  function execute(statement, applicationName) {
    const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (value) => { output += value.toString(); });
    child.stderr.on('data', (value) => { errors += value.toString(); });
    const result = new Promise((resolve, reject) => {
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('payroll race process failed'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ success: code === 0, output: output.trim(), errors });
      });
    });
    child.stdin.end(
      `begin;set local application_name='${applicationName}';` +
      `set local statement_timeout='10s';${statement};commit;\n`
    );
    return result;
  }

  async function hold(statement) {
    const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let output = '';
    let ready = false;
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('payroll lock setup timed out'));
      }, 10000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('payroll lock process failed'));
      });
      child.once('close', () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error('payroll lock setup failed'));
        }
      });
      child.stdout.on('data', (value) => {
        output += value.toString();
        if (!ready && output.includes('PAYROLL_LOCK_READY')) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.stdin.write(
        `begin;set local statement_timeout='10s';` +
        `set local idle_in_transaction_session_timeout='15s';${statement};\n` +
        '\\echo PAYROLL_LOCK_READY\n'
      );
    });

    let releaseResult;
    return () => releaseResult ??= (async () => {
      child.stdin.end('commit;\n\\q\n');
      assert(await closed === 0, 'payroll first transaction commits without deadlock');
    })();
  }

  async function assertBlocked(applicationName) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waiting = sql(
        `select exists(select 1 from pg_stat_activity ` +
        `where application_name='${applicationName}' and state='active' ` +
        `and wait_event_type='Lock');`
      );
      if (waiting === 't') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('payroll competing transaction did not wait on the global lock');
  }

  async function createMaid() {
    const id = randomUUID();
    const authId = randomUUID();
    ok(await client.auth.admin.createUser({
      id: authId,
      email: `payroll-${authId}@test.invalid`,
      password: `T:${randomUUID()}`,
      email_confirm: true
    }), 'payroll synthetic Auth');
    ok(await client.from('profiles').insert({
      id,
      auth_user_id: authId,
      display_name: `payroll-${id}`,
      display_name_normalized: `payroll-${id}`,
      login_id: `payroll-${id}`,
      login_id_normalized: `payroll-${id}`,
      login_sequence: 0,
      role: 'maid',
      status: 'active',
      must_change_password: false
    }), 'payroll synthetic maid');
    return id;
  }

  const maidProfileId = await createMaid();
  const roomType = ok(
    await client.from('room_types').select('id').eq('code', 'standard').single(),
    'payroll standard room type'
  );
  const templateId = randomUUID();
  const templateVersion = Number(sql(
    `select greatest(coalesce(max(version),0),90)+1 ` +
    `from public.cleaning_template_versions ` +
    `where room_type_id='${roomType.id}' and cleaning_kind='additional';`
  ));
  sql(
    `insert into public.cleaning_template_versions(` +
    `id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)` +
    ` values('${templateId}','${roomType.id}','additional',${templateVersion},` +
    `'retired',30,'[{"slotKey":"proof","required":true,"displayOrder":0,` +
    `"sectionKey":"payroll","label":"synthetic","instanceNumber":1,` +
    `"instanceCount":1}]','${adminProfileId}');`
  );

  const weeks = [-1, -3, -5, -7, -9, -11, -12, -13, -15, -17].map((offset) => sql(
    `select (date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date` +
    `${offset < 0 ? `-${Math.abs(offset * 7)}` : `+${offset * 7}`})::text;`
  ));
  let sequence = 0;

  async function pendingSubmission(weekStart, amount) {
    sequence += 1;
    const roomId = randomUUID();
    const targetId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    ok(await client.from('rooms').insert({
      id: roomId,
      room_number: `${Date.now()}${sequence}`,
      room_type_id: roomType.id,
      elevator_zone: 'A'
    }), 'payroll synthetic room');

    sql(
      `insert into public.cleaning_targets(` +
      `id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,` +
      `available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,` +
      `template_snapshot,created_by)` +
      ` select '${targetId}','${roomId}','additional','manual_room_request',` +
      `'payroll-${targetId}','${weekStart}','${weekStart}',` +
      `('${weekStart}'::date+time '09:00') at time zone 'Asia/Seoul',` +
      `('${weekStart}'::date+time '18:00') at time zone 'Asia/Seoul','notified',2,` +
      `jsonb_build_object('id','${roomType.id}','code','standard'),${amount},` +
      `jsonb_build_object('id',id,'version',version,'photoSlots',photo_slots,` +
      `'durationMinutes',duration_minutes),'${adminProfileId}' ` +
      `from public.cleaning_template_versions where id='${templateId}';` +
      `insert into public.cleaning_assignments(` +
      `id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,` +
      `is_current,notified_at,changed_by)` +
      ` values('${assignmentId}','${targetId}','${maidProfileId}','${weekStart}',${sequence},` +
      `2,true,(('${weekStart}'::date+time '08:00') at time zone 'Asia/Seoul'),` +
      `'${adminProfileId}');` +
      `insert into public.cleaning_attempts(` +
      `id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,` +
      `assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)` +
      ` select '${attemptId}',id,'${assignmentId}','${maidProfileId}',1,'field_completed',2,` +
      `(('${weekStart}'::date+time '10:00') at time zone 'Asia/Seoul'),` +
      `(('${weekStart}'::date+time '11:00') at time zone 'Asia/Seoul'),` +
      `(('${weekStart}'::date+time '11:00') at time zone 'Asia/Seoul'),template_snapshot,` +
      `jsonb_build_object('roomId',room_id) from public.cleaning_targets where id='${targetId}';`
    );
    const slotId = sql(
      `select id from private.target_photo_slot_snapshots ` +
      `where cleaning_target_id='${targetId}' and slot_key='proof';`
    );
    sql(
      `select private.record_validated_attempt_photo('${maidProfileId}','${attemptId}',` +
      `'${slotId}',0,repeat('9',64),'image/jpeg',100,clock_timestamp()-interval '1 minute');`
    );
    return ok(await client.rpc('create_cleaning_submission', {
      p_actor_profile_id: maidProfileId,
      p_attempt_id: attemptId,
      p_client_submission_id: randomUUID(),
      p_expected_revision: 0,
      p_candle_count: 0,
      p_idempotency_key: `payroll-submission-${randomUUID()}`,
      p_request_hash: '8'.repeat(64)
    }), 'payroll pending submission').id;
  }

  async function approve(submissionId, digit = '7') {
    return client.rpc('approve_cleaning_submission', {
      p_actor_profile_id: adminProfileId,
      p_submission_id: submissionId,
      p_reason_code: 'QUALITY_OK',
      p_idempotency_key: `payroll-approval-${randomUUID()}`,
      p_request_hash: digit.repeat(64)
    });
  }

  const exactSubmission = await pendingSubmission(weeks[0], 11000);
  ok(await approve(exactSubmission), 'payroll exact-one baseline approval');
  const exactStarts = await Promise.all([0, 1].map((index) => client.rpc(
    'start_payroll_cycle', {
      p_actor_profile_id: adminProfileId,
      p_maid_profile_id: maidProfileId,
      p_week_start: weeks[0],
      p_expected_version: 0,
      p_idempotency_key: `payroll-exact-${index}-${randomUUID()}`,
      p_request_hash: String(index + 1).repeat(64)
    }
  )));
  assert(
    exactStarts.filter((result) => !result.error).length === 1,
    `concurrent payroll start has exactly one winner (${exactStarts.map((result) =>
      result.error ? `${result.error.code}:${result.error.message}` : 'OK').join(',')})`
  );
  assert(exactStarts.filter((result) => result.error).length === 1,
    'concurrent payroll start rejects exactly one stale/transition loser');
  assert(sql(
    `select (select count(*) from public.payroll_cycles where maid_profile_id='${maidProfileId}' ` +
    `and week_start='${weeks[0]}')=1 and ` +
    `(select count(*) from public.payroll_events event join public.payroll_cycles cycle ` +
    `on cycle.id=event.payroll_cycle_id where cycle.maid_profile_id='${maidProfileId}' ` +
    `and cycle.week_start='${weeks[0]}')=1;`
  ) === 't', 'concurrent start commits one cycle/event');

  const approvalFirstSubmission = await pendingSubmission(weeks[1], 13000);
  const approvalFirstKey = `payroll-approval-first-${randomUUID()}`;
  const releaseApproval = await hold(
    `select public.approve_cleaning_submission('${adminProfileId}',` +
    `'${approvalFirstSubmission}','QUALITY_OK','${approvalFirstKey}',repeat('4',64))`
  );
  const approvalFirstApp = `payroll93-${randomUUID()}`;
  const startAfterApproval = execute(
    `select public.start_payroll_cycle('${adminProfileId}','${maidProfileId}',` +
    `'${weeks[1]}',0,'payroll-after-approval-${randomUUID()}',repeat('5',64))`,
    approvalFirstApp
  );
  await assertBlocked(approvalFirstApp);
  await releaseApproval();
  assert((await startAfterApproval).success,
    'approval-first serialization lets start claim the committed earning');
  assert(sql(
    `select (select count(*) from public.earnings earning left join public.payroll_items item ` +
    `on item.earning_id=earning.id where earning.maid_profile_id='${maidProfileId}' ` +
    `and earning.earned_on>='${weeks[1]}' and earning.earned_on<'${weeks[1]}'::date+7 ` +
    `and item.id is null)=0;`
  ) === 't', 'approval-first ordering has no missed unclaimed earning');

  const baselineSubmission = await pendingSubmission(weeks[2], 17000);
  ok(await approve(baselineSubmission, '6'), 'payroll start-first baseline approval');
  const lateSubmission = await pendingSubmission(weeks[2], 19000);
  const releaseStart = await hold(
    `select public.start_payroll_cycle('${adminProfileId}','${maidProfileId}',` +
    `'${weeks[2]}',0,'payroll-before-approval-${randomUUID()}',repeat('a',64))`
  );
  const startFirstApp = `payroll93-${randomUUID()}`;
  const approvalAfterStart = execute(
    `select public.approve_cleaning_submission('${adminProfileId}','${lateSubmission}',` +
    `'QUALITY_OK','payroll-late-approval-${randomUUID()}',repeat('b',64))`,
    startFirstApp
  );
  await assertBlocked(startFirstApp);
  await releaseStart();
  assert((await approvalAfterStart).success,
    'start-first serialization lets approval commit after the PAYING snapshot');
  const lateProjection = ok(await client.rpc('list_payroll_cycles', {
    p_actor_profile_id: adminProfileId,
    p_week_start: weeks[2],
    p_maid_profile_id: maidProfileId
  }), 'payroll late earning projection')[0];
  assert(lateProjection.status === 'paying' && lateProjection.totalAmount === 17000,
    'start-first ordering never mutates the locked PAYING amount');
  assert(lateProjection.lateEarningCount === 1 && lateProjection.lateEarningAmount === 19000,
    'start-first late earning remains explicitly visible and unclaimed for a future OPEN retry');

  const correctionSubmission = await pendingSubmission(weeks[3], 12000);
  ok(await approve(correctionSubmission, 'c'), 'payroll correction race baseline approval');
  const correctionEarningId = sql(
    `select id from public.earnings where submission_id='${correctionSubmission}';`
  );
  const correctionRace = await Promise.all([
    client.rpc('record_payroll_correction', {
      p_actor_profile_id: adminProfileId,
      p_source_earning_id: correctionEarningId,
      p_source_adjustment_id: null,
      p_amount: -1000,
      p_expected_book_version: 0,
      p_idempotency_key: `payroll-correction-race-a-${randomUUID()}`,
      p_request_hash: 'c'.repeat(64)
    }),
    client.rpc('record_payroll_correction', {
      p_actor_profile_id: adminProfileId,
      p_source_earning_id: correctionEarningId,
      p_source_adjustment_id: null,
      p_amount: -2000,
      p_expected_book_version: 0,
      p_idempotency_key: `payroll-correction-race-b-${randomUUID()}`,
      p_request_hash: 'd'.repeat(64)
    }),
    client.rpc('start_payroll_cycle', {
      p_actor_profile_id: adminProfileId,
      p_maid_profile_id: maidProfileId,
      p_week_start: weeks[3],
      p_expected_version: 0,
      p_idempotency_key: `payroll-correction-start-race-${randomUUID()}`,
      p_request_hash: 'e'.repeat(64)
    })
  ]);
  const correctionErrors = correctionRace.filter((result) => result.error).map((result) => result.error);
  assert(correctionErrors.every((error) => error.code !== '40P01'),
    'correction versus start has zero SQLSTATE 40P01 deadlocks');
  assert(correctionErrors.every((error) =>
    /STALE_ADJUSTMENT_VERSION|PAYROLL_SOURCE_PAYMENT_UNCERTAIN/.test(error.message)
  ), `correction versus start has only stable domain losers (${correctionErrors.map((error) => `${error.code}:${error.message}`).join(',')})`);
  assert(sql(
    `select (select count(*) from public.payroll_adjustments where root_earning_id='${correctionEarningId}')<=1 ` +
    `and (select count(*) from public.payroll_cycles where maid_profile_id='${maidProfileId}' ` +
    `and week_start='${weeks[3]}' and status='paying')=1;`
  ) === 't', 'correction versus start leaves at most one correction and one coherent PAYING cycle');

  const reversalSubmission = await pendingSubmission(weeks[4], 15000);
  ok(await approve(reversalSubmission, 'f'), 'payroll reversal race baseline approval');
  const reversalEarningId = sql(
    `select id from public.earnings where submission_id='${reversalSubmission}';`
  );
  const currentBookVersion = Number(sql(
    `select version from public.payroll_adjustment_books where maid_profile_id='${maidProfileId}';`
  ));
  const reversalRace = await Promise.all([
    client.rpc('reverse_payroll_source', {
      p_actor_profile_id: adminProfileId,
      p_source_earning_id: reversalEarningId,
      p_source_adjustment_id: null,
      p_expected_book_version: currentBookVersion,
      p_idempotency_key: `payroll-reversal-race-a-${randomUUID()}`,
      p_request_hash: '1'.repeat(64)
    }),
    client.rpc('reverse_payroll_source', {
      p_actor_profile_id: adminProfileId,
      p_source_earning_id: reversalEarningId,
      p_source_adjustment_id: null,
      p_expected_book_version: currentBookVersion,
      p_idempotency_key: `payroll-reversal-race-b-${randomUUID()}`,
      p_request_hash: '2'.repeat(64)
    }),
    client.rpc('start_payroll_cycle', {
      p_actor_profile_id: adminProfileId,
      p_maid_profile_id: maidProfileId,
      p_week_start: weeks[4],
      p_expected_version: 0,
      p_idempotency_key: `payroll-reversal-start-race-${randomUUID()}`,
      p_request_hash: '3'.repeat(64)
    })
  ]);
  const reversalErrors = reversalRace.filter((result) => result.error).map((result) => result.error);
  assert(reversalErrors.every((error) => error.code !== '40P01'),
    'reversal versus start has zero SQLSTATE 40P01 deadlocks');
  assert(reversalErrors.every((error) =>
    /STALE_ADJUSTMENT_VERSION|PAYROLL_SOURCE_ALREADY_REVERSED|PAYROLL_NONPOSITIVE_REQUIRES_CARRY|PAYROLL_SOURCE_PAYMENT_UNCERTAIN/.test(error.message)
  ), `reversal versus start has only stable domain losers (${reversalErrors.map((error) => `${error.code}:${error.message}`).join(',')})`);
  assert(sql(
    `select ((select count(*) from public.payroll_adjustments where reversal_of_earning_id='${reversalEarningId}')=1 ` +
    `and (select count(*) from public.payroll_events event join public.payroll_cycles cycle ` +
    `on cycle.id=event.payroll_cycle_id where cycle.maid_profile_id='${maidProfileId}' ` +
    `and cycle.week_start='${weeks[4]}')=0) or ` +
    `((select count(*) from public.payroll_adjustments where reversal_of_earning_id='${reversalEarningId}')=0 ` +
    `and (select count(*) from public.payroll_events event join public.payroll_cycles cycle ` +
    `on cycle.id=event.payroll_cycle_id where cycle.maid_profile_id='${maidProfileId}' ` +
    `and cycle.week_start='${weeks[4]}')=1);`
  ) === 't', 'reversal versus start leaves either one inverse or one immutable PAYING snapshot');

  const priorSourceBaseline = await pendingSubmission(weeks[6], 5000);
  ok(await approve(priorSourceBaseline, '4'), 'prior-late race source baseline approval');
  ok(await client.rpc('start_payroll_cycle', {
    p_actor_profile_id: adminProfileId,
    p_maid_profile_id: maidProfileId,
    p_week_start: weeks[6],
    p_expected_version: 0,
    p_idempotency_key: `payroll-prior-late-source-${randomUUID()}`,
    p_request_hash: '4'.repeat(64)
  }), 'prior-late race source PAYING baseline');
  const nextWeekSubmission = await pendingSubmission(weeks[5], 13000);
  ok(await approve(nextWeekSubmission, '4'), 'prior-late race next-week positive baseline');
  const priorLateSubmission = await pendingSubmission(weeks[6], 17000);
  const priorLateRace = await Promise.all([
    approve(priorLateSubmission, '5'),
    client.rpc('start_payroll_cycle', {
      p_actor_profile_id: adminProfileId,
      p_maid_profile_id: maidProfileId,
      p_week_start: weeks[5],
      p_expected_version: 0,
      p_idempotency_key: `payroll-prior-late-start-${randomUUID()}`,
      p_request_hash: '6'.repeat(64)
    })
  ]);
  const priorLateErrors = priorLateRace.filter((result) => result.error).map((result) => result.error);
  assert(priorLateErrors.every((error) => error.code !== '40P01'),
    `prior late approval versus next freeze has zero SQLSTATE 40P01 deadlocks (${priorLateErrors.map((error) => `${error.code}:${error.message}`).join(',')})`);
  assert(priorLateErrors.length === 1 && priorLateErrors.every((error) =>
    /PAYROLL_PRIOR_LATE_EARNING_PENDING/.test(error.message)
  ), `prior late approval versus next freeze has one stable loser (${priorLateErrors.map((error) => `${error.code}:${error.message}`).join(',')})`);
  assert(priorLateRace.filter((result) => !result.error).length === 1,
    'prior late approval versus next freeze has exactly one serialized winner');
  assert(sql(
    `select not exists(select 1 from public.earnings earning join public.payroll_cycles next_cycle ` +
    `on next_cycle.maid_profile_id=earning.maid_profile_id and next_cycle.week_start='${weeks[5]}' ` +
    `where earning.submission_id='${priorLateSubmission}' and ` +
    `(next_cycle.status in ('paying','check','paid') or next_cycle.offset_settled_at is not null));`
  ) === 't', 'race never strands a prior late earning behind an immutable next-week snapshot');

  async function startPaymentRaceWeek(weekStart, amount, digit) {
    const submissionId = await pendingSubmission(weekStart, amount);
    ok(await approve(submissionId, digit), 'payment-result race approval');
    ok(await client.rpc('start_payroll_cycle', {
      p_actor_profile_id: adminProfileId,
      p_maid_profile_id: maidProfileId,
      p_week_start: weekStart,
      p_expected_version: 0,
      p_idempotency_key: `payroll-payment-race-start-${randomUUID()}`,
      p_request_hash: digit.repeat(64)
    }), 'payment-result race PAYING baseline');
    return sql(
      `select attempt.id from public.payroll_payment_attempts attempt ` +
      `join public.payroll_cycles cycle on cycle.id=attempt.payroll_cycle_id ` +
      `where cycle.maid_profile_id='${maidProfileId}' and cycle.week_start='${weekStart}' ` +
      `order by attempt.attempt_number desc limit 1;`
    );
  }

  function assertStablePaymentRace(results, label) {
    const errors = results.filter((result) => result.error).map((result) => result.error);
    assert(results.filter((result) => !result.error).length === 1 && errors.length === 1,
      `${label} has exactly one serialized winner and loser`);
    assert(errors.every((error) => error.code !== '40P01'),
      `${label} has zero SQLSTATE 40P01 deadlocks`);
    assert(errors.every((error) =>
      /STALE_VERSION|PAYROLL_PAYMENT_TRANSITION_INVALID|PAYROLL_PAYMENT_ATTEMPT_TERMINAL/.test(error.message)
    ), `${label} has only stable domain losers (${errors.map((error) => `${error.code}:${error.message}`).join(',')})`);
  }

  const payingCheckPaidAttempt = await startPaymentRaceWeek(weeks[7], 21000, '6');
  const payingCheckPaidRace = await Promise.all([
    client.rpc('record_payroll_payment_check', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: payingCheckPaidAttempt,
      p_expected_version: 1,
      p_reason_code: 'TRANSFER_RESULT_UNCERTAIN',
      p_idempotency_key: `payroll-check-paid-race-check-${randomUUID()}`,
      p_request_hash: '7'.repeat(64)
    }),
    client.rpc('record_payroll_payment_paid', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: payingCheckPaidAttempt,
      p_expected_version: 1,
      p_payment_method: 'bank_transfer',
      p_canonical_reference: `RACE.CHECK.${sequence}A1`,
      p_idempotency_key: `payroll-check-paid-race-paid-${randomUUID()}`,
      p_request_hash: '8'.repeat(64)
    })
  ]);
  assertStablePaymentRace(payingCheckPaidRace, 'PAYING check versus paid');
  assert(sql(
    `select cycle.status in ('check','paid') and cycle.version=2 ` +
    `and (select count(*) from public.payroll_payment_results result ` +
    `where result.payment_attempt_id='${payingCheckPaidAttempt}')=1 ` +
    `from public.payroll_cycles cycle join public.payroll_payment_attempts attempt ` +
    `on attempt.payroll_cycle_id=cycle.id where attempt.id='${payingCheckPaidAttempt}';`
  ) === 't', 'PAYING check versus paid leaves one result matching a version-2 cycle');

  const payingPaidReopenAttempt = await startPaymentRaceWeek(weeks[8], 23000, '7');
  const payingPaidReopenRace = await Promise.all([
    client.rpc('record_payroll_payment_paid', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: payingPaidReopenAttempt,
      p_expected_version: 1,
      p_payment_method: 'bank_transfer',
      p_canonical_reference: `RACE.REOPEN.${sequence}B2`,
      p_idempotency_key: `payroll-paid-reopen-race-paid-${randomUUID()}`,
      p_request_hash: '9'.repeat(64)
    }),
    client.rpc('reopen_payroll_payment_attempt', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: payingPaidReopenAttempt,
      p_expected_version: 1,
      p_reason_code: 'NO_TRANSFER_CONFIRMED',
      p_idempotency_key: `payroll-paid-reopen-race-reopen-${randomUUID()}`,
      p_request_hash: 'a'.repeat(64)
    })
  ]);
  assertStablePaymentRace(payingPaidReopenRace, 'PAYING paid versus reopen');
  assert(sql(
    `select ((cycle.status='paid' and result.result_type='paid' and cycle.paid_at is not null) ` +
    `or (cycle.status='open' and result.result_type='reopened' and cycle.paid_at is null)) ` +
    `and cycle.version=2 and result.locked_amount=attempt.locked_amount ` +
    `from public.payroll_cycles cycle join public.payroll_payment_attempts attempt ` +
    `on attempt.payroll_cycle_id=cycle.id join public.payroll_payment_results result ` +
    `on result.payment_attempt_id=attempt.id where attempt.id='${payingPaidReopenAttempt}';`
  ) === 't', 'PAYING paid versus reopen leaves one coherent immutable terminal result');

  const checkPaidReopenAttempt = await startPaymentRaceWeek(weeks[9], 25000, '8');
  ok(await client.rpc('record_payroll_payment_check', {
    p_actor_profile_id: adminProfileId,
    p_payment_attempt_id: checkPaidReopenAttempt,
    p_expected_version: 1,
    p_reason_code: 'TRANSFER_RESULT_UNCERTAIN',
    p_idempotency_key: `payroll-check-baseline-${randomUUID()}`,
    p_request_hash: 'b'.repeat(64)
  }), 'CHECK payment race baseline');
  const checkPaidReopenRace = await Promise.all([
    client.rpc('record_payroll_payment_paid', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: checkPaidReopenAttempt,
      p_expected_version: 2,
      p_payment_method: 'bank_transfer',
      p_canonical_reference: `RACE.CHECK.${sequence}C3`,
      p_idempotency_key: `payroll-check-terminal-race-paid-${randomUUID()}`,
      p_request_hash: 'c'.repeat(64)
    }),
    client.rpc('reopen_payroll_payment_attempt', {
      p_actor_profile_id: adminProfileId,
      p_payment_attempt_id: checkPaidReopenAttempt,
      p_expected_version: 2,
      p_reason_code: 'NO_TRANSFER_CONFIRMED',
      p_idempotency_key: `payroll-check-terminal-race-reopen-${randomUUID()}`,
      p_request_hash: 'd'.repeat(64)
    })
  ]);
  assertStablePaymentRace(checkPaidReopenRace, 'CHECK paid versus reopen');
  assert(sql(
    `select ((cycle.status='paid' and terminal.result_type='paid' and cycle.paid_at is not null) ` +
    `or (cycle.status='open' and terminal.result_type='reopened' and cycle.paid_at is null)) ` +
    `and cycle.version=3 and terminal.before_status='check' ` +
    `and (select count(*) from public.payroll_payment_results result ` +
    `where result.payment_attempt_id=attempt.id)=2 ` +
    `from public.payroll_cycles cycle join public.payroll_payment_attempts attempt ` +
    `on attempt.payroll_cycle_id=cycle.id join public.payroll_payment_results terminal ` +
    `on terminal.payment_attempt_id=attempt.id and terminal.result_type in ('paid','reopened') ` +
    `where attempt.id='${checkPaidReopenAttempt}';`
  ) === 't', 'CHECK paid versus reopen preserves check plus one coherent terminal result');

  console.log(
    'Payroll concurrency passed: exact-one start, approval/start, prior-late/freeze, correction/reversal/start, and payment-result races; SQLSTATE 40P01=0, generic errors=0, and only stable domain losers.'
  );
}
