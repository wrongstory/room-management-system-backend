import { invariant } from './lib/reservation-backup.js';
import { sourceEnvironment, readReservationSnapshot } from './lib/reservation-backup-source.js';
import { createBackupStore, saveReservationBackup } from './lib/reservation-backup-storage.js';

// No credentials in argv, no plaintext files/artifacts, no raw provider/SQL errors.
let key: Buffer | undefined;
try {
  invariant(process.argv.length === 2 && process.env.RESERVATION_BACKUP_ENABLED === 'true');
  const encoded = process.env.RESERVATION_BACKUP_KEY ?? '';
  key = Buffer.from(encoded, 'base64');
  invariant(key.length === 32 && key.toString('base64') === encoded);
  const env = sourceEnvironment(process.env.RESERVATION_BACKUP_DB_URL ?? '', process.env.RESERVATION_BACKUP_CA_PATH ?? '');
  const store = createBackupStore(process.env.RESERVATION_BACKUP_STORAGE_TOKEN ?? '');
  const snapshot = await readReservationSnapshot(env);
  const result = await saveReservationBackup(snapshot, key, store);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('RESERVATION_BACKUP_FAILED: backup was not confirmed; previous successful backups were not overwritten.\n');
  process.exitCode = 1;
} finally { key?.fill(0); }
