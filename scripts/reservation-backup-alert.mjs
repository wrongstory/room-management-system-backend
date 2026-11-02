import { publishBackupAlert } from '../supabase/functions/_shared/reservation-backup-alert.ts';

try {
  if (process.argv.length !== 2 || process.env.GITHUB_REPOSITORY !== 'wrongstory/room-management-system-backend'
      || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.RESERVATION_BACKUP_ENABLED !== 'true'
      || !['failure', 'cancelled', 'skipped'].includes(process.env.RESERVATION_BACKUP_RESULT ?? '')) throw new Error();
  const now = new Date();
  const result = await publishBackupAlert({ code: 'BACKUP_FAILED', checkedAt: now.toISOString(),
    expectedDay: new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
  { token: process.env.GITHUB_TOKEN ?? '', issue: Number(process.env.RESERVATION_BACKUP_ALERT_ISSUE) });
  process.stdout.write(`${JSON.stringify({ status: 'alert-checked', published: result.published })}\n`);
} catch {
  process.stderr.write('BACKUP_ALERT_FAILED: delivery was not confirmed.\n');
  process.exitCode = 1;
}
