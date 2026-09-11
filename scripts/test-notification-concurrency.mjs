import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(value, message) {
  if (!value) throw new Error(message);
}

export async function testNotificationConcurrency(client) {
  const url = new URL(client.supabaseUrl);
  assert(['localhost', '127.0.0.1'].includes(url.hostname), 'notification race requires local Supabase');
  const authUserId = randomUUID();
  const profileId = randomUUID();
  const sessionId = randomUUID();
  const notificationId = randomUUID();
  const actorAuthUserId = randomUUID();
  const actorProfileId = randomUUID();
  const secondRecipientAuthUserId = randomUUID();
  const secondRecipientProfileId = randomUUID();
  const groupingTargetIds = [randomUUID(), randomUUID(), randomUUID()];
  const groupingAssignmentIds = [randomUUID(), randomUUID(), randomUUID()];
  const login = `notification-${profileId}`;
  const sql = `
    insert into auth.users(id) values
      ('${authUserId}'::uuid),
      ('${actorAuthUserId}'::uuid),
      ('${secondRecipientAuthUserId}'::uuid);
    insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${authUserId}'::uuid);
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
      login_id,login_id_normalized,login_sequence,role,status,must_change_password)
    values
      ('${profileId}'::uuid,'${authUserId}'::uuid,'notification-race','notification-race',
        '${login}','${login}',0,'maid','active',false),
      ('${actorProfileId}'::uuid,'${actorAuthUserId}'::uuid,'grouping-admin','grouping-admin',
        'grouping-admin-${actorProfileId}','grouping-admin-${actorProfileId}',0,'admin','active',false),
      ('${secondRecipientProfileId}'::uuid,'${secondRecipientAuthUserId}'::uuid,'grouping-maid','grouping-maid',
        'grouping-maid-${secondRecipientProfileId}','grouping-maid-${secondRecipientProfileId}',0,'maid','active',false);
    insert into public.notifications(id,recipient_profile_id,category,title,body,requires_action)
    values('${notificationId}'::uuid,'${profileId}'::uuid,'race','동시 읽음','안전한 알림 본문',false);
    insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,available_from,due_at,status,assignment_version,
      room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    values
      ('${groupingTargetIds[0]}'::uuid,(select id from public.rooms order by id limit 1),'additional',
        'manual_room_request','grouping-${groupingTargetIds[0]}','2037-01-01','2037-01-01',
        '2037-01-01 00:00:00+00','2037-01-01 12:00:00+00','notified',1,'{}',0,'{}','${actorProfileId}'::uuid),
      ('${groupingTargetIds[1]}'::uuid,(select id from public.rooms order by id limit 1),'additional',
        'manual_room_request','grouping-${groupingTargetIds[1]}','2037-01-01','2037-01-01',
        '2037-01-01 00:00:00+00','2037-01-01 12:00:00+00','notified',1,'{}',0,'{}','${actorProfileId}'::uuid),
      ('${groupingTargetIds[2]}'::uuid,(select id from public.rooms order by id limit 1),'additional',
        'manual_room_request','grouping-${groupingTargetIds[2]}','2037-01-01','2037-01-01',
        '2037-01-01 00:00:00+00','2037-01-01 12:00:00+00','notified',1,'{}',0,'{}','${actorProfileId}'::uuid);
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,
      revision,notified_at,changed_by)
    values
      ('${groupingAssignmentIds[0]}'::uuid,'${groupingTargetIds[0]}'::uuid,'${profileId}'::uuid,31,1,
        '2037-01-01 00:00:00+00','${actorProfileId}'::uuid),
      ('${groupingAssignmentIds[1]}'::uuid,'${groupingTargetIds[1]}'::uuid,'${profileId}'::uuid,32,1,
        '2037-01-01 00:00:00+00','${actorProfileId}'::uuid),
      ('${groupingAssignmentIds[2]}'::uuid,'${groupingTargetIds[2]}'::uuid,'${secondRecipientProfileId}'::uuid,31,1,
        '2037-01-01 00:00:00+00','${actorProfileId}'::uuid);
  `;
  execFileSync('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'
  ], { input: sql, stdio: ['pipe', 'ignore', 'pipe'], timeout: 15000 });

  const calls = await Promise.all(Array.from({ length: 8 }, () => client.rpc('mark_notification_read', {
    p_actor_profile_id: profileId,
    p_session_id: sessionId,
    p_notification_id: notificationId
  })));
  assert(calls.every((result) => !result.error && typeof result.data?.readAt === 'string'),
    'all concurrent markRead calls must succeed');
  const timestamps = new Set(calls.map((result) => result.data.readAt));
  assert(timestamps.size === 1, 'concurrent markRead calls must preserve exactly one first readAt');

  const roomExpression = '(select room_id from public.cleaning_targets where id=';
  const groupingCalls = groupingAssignmentIds.map((assignmentId, index) => {
    const recipientId = index === 2 ? secondRecipientProfileId : profileId;
    const targetId = groupingTargetIds[index];
    const emitSql = `select private.emit_notification_v1(
      'assignment.commit_notified','${actorProfileId}'::uuid,'${recipientId}'::uuid,
      'cleaning_assignment','${assignmentId}','병렬 배정 ${index + 1}','병렬 grouping 회귀입니다.',
      ${roomExpression}'${targetId}'::uuid),'${targetId}'::uuid,'${targetId}'::uuid,
      '2037-01-01 01:00:00+00');`;
    return execFileAsync('docker', [
      'exec', '-i', 'supabase_db_room-management-system-backend',
      'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', emitSql
    ], { encoding: 'utf8', timeout: 15000 });
  });
  const groupingResults = await Promise.all(groupingCalls);
  assert(new Set(groupingResults.map(({ stdout }) => stdout.trim())).size === 3,
    'parallel distinct logical events must emit three distinct notification ids without a dedupe conflict');
  const groupingSummary = JSON.parse(execFileSync('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', `select json_build_object(
      'recipientOneNotifications',count(*) filter(where n.recipient_profile_id='${profileId}'::uuid),
      'recipientOneGroups',count(distinct n.notification_group_id) filter(where n.recipient_profile_id='${profileId}'::uuid),
      'recipientOneDedupe',count(distinct n.dedupe_key) filter(where n.recipient_profile_id='${profileId}'::uuid),
      'recipientOneOutbox',count(o.id) filter(where n.recipient_profile_id='${profileId}'::uuid),
      'recipientTwoNotifications',count(*) filter(where n.recipient_profile_id='${secondRecipientProfileId}'::uuid),
      'recipientTwoGroups',count(distinct n.notification_group_id) filter(where n.recipient_profile_id='${secondRecipientProfileId}'::uuid),
      'recipientTwoOutbox',count(o.id) filter(where n.recipient_profile_id='${secondRecipientProfileId}'::uuid),
      'allGroups',count(distinct n.notification_group_id))
      from public.notifications n
      left join private.notification_delivery_outbox o on o.notification_id=n.id
      where n.source_entity_id in ('${groupingAssignmentIds.join("','")}')`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 15000 }).trim());
  assert(groupingSummary.recipientOneNotifications === 2 && groupingSummary.recipientOneGroups === 1 &&
    groupingSummary.recipientOneDedupe === 2 && groupingSummary.recipientOneOutbox === 2,
  'parallel first events for one recipient must converge to one group, two notifications, and two deliveries');
  assert(groupingSummary.recipientTwoNotifications === 1 && groupingSummary.recipientTwoGroups === 1 &&
    groupingSummary.recipientTwoOutbox === 1 && groupingSummary.allGroups === 2,
  'same-room cross-recipient event must use a separate group and its exact delivery row');

  const raw = await client.from('notifications').select('id').eq('id', notificationId);
  assert(raw.error && /permission denied/i.test(raw.error.message),
    'service-role raw notification SELECT must remain denied');
  console.log('Notification concurrency passed: 8 markRead calls converge; parallel first grouping is 2 events/1 group with exact outbox and cross-recipient isolation; raw SELECT denied.');
}
