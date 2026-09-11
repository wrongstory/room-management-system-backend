import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
  const login = `notification-${profileId}`;
  const sql = `
    insert into auth.users(id) values('${authUserId}'::uuid);
    insert into auth.sessions(id,user_id) values('${sessionId}'::uuid,'${authUserId}'::uuid);
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
      login_id,login_id_normalized,login_sequence,role,status,must_change_password)
    values('${profileId}'::uuid,'${authUserId}'::uuid,'notification-race','notification-race',
      '${login}','${login}',0,'maid','active',false);
    insert into public.notifications(id,recipient_profile_id,category,title,body,requires_action)
    values('${notificationId}'::uuid,'${profileId}'::uuid,'race','동시 읽음','안전한 알림 본문',false);
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

  const raw = await client.from('notifications').select('id').eq('id', notificationId);
  assert(raw.error && /permission denied/i.test(raw.error.message),
    'service-role raw notification SELECT must remain denied');
  console.log('Notification concurrency passed: 8 calls returned one immutable server readAt; raw SELECT denied.');
}
