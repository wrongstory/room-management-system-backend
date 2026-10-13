import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  bytes: Buffer.from('{}'),
  file: true,
  advertisedSize: null as number | null,
  failure: false,
  closeFailure: false,
  close: vi.fn(),
  open: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  open: fake.open,
}));

import { runBackupPlanCommand } from '../scripts/plan-one-time-backup.mjs';

const valid = () => ({
  version: 1,
  mode: 'plan',
  sourceProjectRef: 'aodikrxcczbogjpsjwjt',
  retentionDays: 15,
  localAppDataDirectory: 'C:\\Users\\operator\\AppData\\Local',
  repositoryDirectories: ['C:\\Repositories\\backend'],
  backupDirectory: 'C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\ReleaseBackups',
  credentialReference: {
    kind: 'windows-dpapi-current-user',
    path: 'C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\Secrets\\connection.dpapi',
  },
  backupKeyReference: {
    kind: 'windows-dpapi-current-user',
    path: 'C:\\Users\\operator\\AppData\\Local\\RoomManagementSystem\\Secrets\\backup-key.dpapi',
  },
  restoreTarget: {
    kind: 'local-isolated-database',
    isolationId: '17f3376c-9a9e-4e29-a3aa-6822e918899d',
  },
});

async function invoke(argv: string[]) {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const code = await runBackupPlanCommand(argv, {
    stdout: { write: stdout }, stderr: { write: stderr },
  });
  return { code, stdout: stdout.mock.calls.flat().join(''), stderr: stderr.mock.calls.flat().join('') };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.bytes = Buffer.from(JSON.stringify(valid()));
  fake.file = true;
  fake.advertisedSize = null;
  fake.failure = false;
  fake.closeFailure = false;
  fake.close.mockImplementation(async () => {
    if (fake.closeFailure) throw new Error('synthetic-secret-do-not-print');
  });
  fake.open.mockImplementation(async () => {
    if (fake.failure) throw new Error('synthetic-secret-do-not-print');
    return {
      stat: async () => ({ size: fake.advertisedSize ?? fake.bytes.length, isFile: () => fake.file }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const size = Math.min(length, Math.max(0, fake.bytes.length - position));
        fake.bytes.copy(buffer, offset, position, position + size);
        return { bytesRead: size };
      },
      close: fake.close,
    };
  });
});

describe('inactive one-time backup plan CLI', () => {
  it('shows help without reading a file', async () => {
    const result = await invoke(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Plan only');
    expect(fake.open).not.toHaveBeenCalled();
  });

  it.each([[], ['--execute'], ['--config'], ['--config', 'plan.json', '--execute']])(
    'rejects unsupported or execution arguments %j', async (...args) => {
      const result = await invoke(args as string[]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BACKUP_PLAN_USAGE');
      expect(fake.open).not.toHaveBeenCalled();
    },
  );

  it('prints only a non-executable safe plan, never paths or secret references', async () => {
    const result = await invoke(['--config', 'plan.json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).executionAllowed).toBe(false);
    expect(result.stdout).toContain('PLANNED_NOT_EXECUTABLE');
    expect(result.stdout).not.toMatch(/operator|connection\.dpapi|backup-key\.dpapi|Repositories/);
    expect(result.stderr).toBe('');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it.each(['not-json', 'synthetic-secret-do-not-print', '{"password":"synthetic-secret-do-not-print"}'])
    ('rejects invalid or secret-bearing input without reflecting it: %s', async (value) => {
      fake.bytes = Buffer.from(value);
      const result = await invoke(['--config', 'plan.json']);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(value);
      expect(result.stderr).not.toContain('synthetic-secret');
      expect(fake.close).toHaveBeenCalledOnce();
    });

  it.each(['connection.env', 'postgresql://synthetic-secret', 'unsafe\nname.json'])
    ('rejects invalid config file arguments without opening: %s', async (file) => {
      const result = await invoke(['--config', file]);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain(file);
      expect(fake.open).not.toHaveBeenCalled();
    });

  it('rejects invalid UTF-8 without outputting bytes', async () => {
    fake.bytes = Buffer.from([0xff, 0xfe]);
    const result = await invoke(['--config', 'plan.json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BACKUP_PLAN_CONFIG_INVALID');
  });

  it('bounds actual bytes even if the file grows beyond its stat size', async () => {
    fake.bytes = Buffer.alloc(20 * 1024, 0x61);
    fake.advertisedSize = 3;
    const result = await invoke(['--config', 'plan.json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BACKUP_PLAN_CONFIG_UNAVAILABLE');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it.each(['size', 'file', 'open', 'close'])('redacts native %s failures', async (kind) => {
    if (kind === 'size') fake.advertisedSize = 20 * 1024;
    if (kind === 'file') fake.file = false;
    if (kind === 'open') fake.failure = true;
    if (kind === 'close') fake.closeFailure = true;
    const result = await invoke(['--config', 'plan.json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('synthetic-secret');
    expect(result.stderr).not.toContain('plan.json');
  });
});
