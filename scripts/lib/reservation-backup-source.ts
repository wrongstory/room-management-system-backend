import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { invariant, MAX_BYTES, SNAPSHOT_SQL, SOURCE_PROJECT, validateBackup } from './reservation-backup.js';

export function sourceEnvironment(url: string, certificatePath: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  invariant(['postgres:', 'postgresql:'].includes(parsed.protocol) && parsed.pathname === '/postgres'
    && (!parsed.port || parsed.port === '5432') && parsed.search === '' && parsed.hash === '', 'RESERVATION_BACKUP_SOURCE_INVALID');
  invariant((parsed.hostname === `db.${SOURCE_PROJECT}.supabase.co` && user === 'postgres')
    || (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname) && user === `postgres.${SOURCE_PROJECT}`),
  'RESERVATION_BACKUP_SOURCE_INVALID');
  invariant(parsed.password && isAbsolute(certificatePath), 'RESERVATION_BACKUP_SOURCE_INVALID');
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    PGHOST: parsed.hostname, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: user,
    PGPASSWORD: decodeURIComponent(parsed.password), PGSSLMODE: 'verify-full', PGSSLROOTCERT: certificatePath,
    PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'reservation-backup-readonly', PGCLIENTENCODING: 'UTF8' };
}

export async function readReservationSnapshot(env: NodeJS.ProcessEnv) {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('psql', ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const parts: Buffer[] = []; let bytes = 0; let errorBytes = 0; let failed = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timeout = setTimeout(fail, 90000);
    child.stdout.on('data', (value: Buffer) => { bytes += value.length; if (bytes > MAX_BYTES) fail(); else parts.push(value); });
    child.stderr.on('data', (value: Buffer) => { errorBytes += value.length; if (errorBytes > 65536) fail(); });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('RESERVATION_BACKUP_SOURCE_FAILED')); });
    child.on('close', code => { clearTimeout(timeout);
      if (failed || code !== 0) { for (const p of parts) p.fill(0); reject(new Error('RESERVATION_BACKUP_SOURCE_FAILED')); }
      else { const result = Buffer.concat(parts); for (const p of parts) p.fill(0); resolve(result); } });
    child.stdin.on('error', fail);
    child.stdin.end(SNAPSHOT_SQL);
  });
  try { return validateBackup(JSON.parse(raw.toString('utf8'))); }
  catch { throw new Error('RESERVATION_BACKUP_SOURCE_INVALID'); }
  finally { raw.fill(0); }
}
