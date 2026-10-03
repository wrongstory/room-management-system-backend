import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsRoot = resolve('scripts/windows');

describe('Windows backup recovery scheduler source', () => {
  it('creates the future operating-PC Desktop folder and fixed non-secret config', async () => {
    const source = await readFile(resolve(scriptsRoot, 'New-RmsBackupRecoveryConfig.ps1'), 'utf8');
    expect(source).toContain("$folderName = 'RoomManagementSystemBackups'");
    expect(source).toContain('[Environment+SpecialFolder]::Desktop');
    expect(source).toContain("scheduleTimeKst = '03:00'");
    expect(source).toContain('System.Text.UTF8Encoding($false)');
    expect(source).toContain('Move-Item -LiteralPath $temporaryConfigPath');
    expect(source).toContain('TaskInstalled = $false');
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//iu);
  });

  it('registers only after explicit enable input and leaves the task disabled', async () => {
    const source = await readFile(resolve(scriptsRoot, 'Install-RmsBackupRecoveryTask.ps1'), 'utf8');
    expect(source).toContain('[switch]$Enable');
    expect(source).toContain('BACKUP_TASK_ENABLE_CONFIRMATION_REQUIRED');
    expect(source).toContain('Register-ScheduledTask');
    expect(source).toContain('Disable-ScheduledTask');
    expect(source).not.toContain('Enable-ScheduledTask');
  });

  it('does not report a scheduled run as successful before the credential bridge exists', async () => {
    const source = await readFile(resolve(scriptsRoot, 'Invoke-RmsBackupRecovery.ps1'), 'utf8');
    expect(source).toContain('BACKUP_OPERATOR_CREDENTIAL_BRIDGE_NOT_ACTIVATED');
    expect(source).not.toMatch(/supabase\s+db\s+dump/iu);
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//iu);
  });

  it('removes only the fixed task name', async () => {
    const source = await readFile(resolve(scriptsRoot, 'Uninstall-RmsBackupRecoveryTask.ps1'), 'utf8');
    expect(source).toContain("$taskName = 'RMS-Production-Backup-Recovery'");
    expect(source).toContain('Unregister-ScheduledTask -TaskName $taskName');
    expect(source).not.toContain('-TaskName *');
  });

  it('reports only bounded task metadata and never action arguments', async () => {
    const source = await readFile(resolve(scriptsRoot, 'Get-RmsBackupRecoveryTask.ps1'), 'utf8');
    expect(source).toContain("$taskName = 'RMS-Production-Backup-Recovery'");
    expect(source).toContain('LastTaskResult');
    expect(source).toContain('NextRunTime');
    expect(source).not.toContain('.Actions');
    expect(source).not.toContain('.Arguments');
  });
});
