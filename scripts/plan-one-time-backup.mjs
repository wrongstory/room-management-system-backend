import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOneTimeBackupPlan, OneTimeBackupPlanError } from './lib/one-time-backup-plan.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;
const HELP = 'Usage: npm run backup:plan -- --config <explicit-config.json>\nPlan only: no credential reads, file writes, database connection, dump, restore, or scheduled task.\n';

class ConfigError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function readConfig(file) {
  let handle;
  try {
    if (typeof file !== 'string' || !file.endsWith('.json') || [...file].some((character) => {
      const point = character.codePointAt(0);
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
    })) {
      throw new ConfigError('BACKUP_PLAN_CONFIG_UNAVAILABLE');
    }
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) {
      throw new ConfigError('BACKUP_PLAN_CONFIG_UNAVAILABLE');
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) throw new ConfigError('BACKUP_PLAN_CONFIG_UNAVAILABLE');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
    } catch {
      throw new ConfigError('BACKUP_PLAN_CONFIG_INVALID');
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('BACKUP_PLAN_CONFIG_UNAVAILABLE');
  } finally {
    await handle?.close();
  }
}

export async function runBackupPlanCommand(argv, io = process) {
  if (argv.length === 1 && argv[0] === '--help') {
    io.stdout.write(HELP);
    return 0;
  }
  try {
    if (argv.length !== 2 || argv[0] !== '--config') {
      throw new ConfigError('BACKUP_PLAN_USAGE');
    }
    const plan = createOneTimeBackupPlan(await readConfig(argv[1]));
    io.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  } catch (error) {
    // Never print paths, configuration values, native errors, SQL, or a stack.
    const code = error instanceof ConfigError || error instanceof OneTimeBackupPlanError
      ? error.code
      : 'BACKUP_PLAN_REJECTED';
    io.stderr.write(`${JSON.stringify({ status: 'REJECTED', code })}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runBackupPlanCommand(process.argv.slice(2));
}
