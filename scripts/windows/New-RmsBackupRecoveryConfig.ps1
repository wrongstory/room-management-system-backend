[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$folderName = 'RoomManagementSystemBackups'
$configFileName = 'backup-operator.json'
$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$planner = Join-Path $resolvedRepositoryRoot 'scripts\backup-recovery-operator-plan.mjs'

if (-not (Test-Path -LiteralPath $planner -PathType Leaf)) {
    throw 'BACKUP_TASK_PLANNER_NOT_FOUND'
}

$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
if ([string]::IsNullOrWhiteSpace($desktop) -or -not [IO.Path]::IsPathRooted($desktop)) {
    throw 'BACKUP_DESKTOP_PATH_INVALID'
}

$backupRoot = Join-Path $desktop $folderName
$configPath = Join-Path $backupRoot $configFileName
$temporaryConfigPath = "$configPath.tmp"
$config = [ordered]@{
    schemaVersion = 1
    productionProjectRef = 'aodikrxcczbogjpsjwjt'
    recoveryProjectRef = 'matalcofimnhuzslfhdd'
    backupRoot = $backupRoot
    scheduleTimeKst = '03:00'
    retentionDays = 15
    credentialTargets = [ordered]@{
        productionDatabaseUrl = 'RMS.Backup.ProductionDbUrl'
        recoveryDatabaseUrl = 'RMS.Backup.RecoveryDbUrl'
        artifactEncryptionKey = 'RMS.Backup.ArtifactEncryptionKey'
    }
}

if ($PSCmdlet.ShouldProcess($backupRoot, 'Create backup root and validated operator config')) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    try {
        $json = $config | ConvertTo-Json -Depth 4
        $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($temporaryConfigPath, $json, $utf8WithoutBom)
        & node $planner --config $temporaryConfigPath | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'BACKUP_TASK_PLAN_INVALID'
        }
        Move-Item -LiteralPath $temporaryConfigPath -Destination $configPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryConfigPath -Force -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
        BackupRoot = $backupRoot
        ConfigPath = $configPath
        ScheduleTimeKst = '03:00'
        RetentionDays = 15
        TaskInstalled = $false
    } | ConvertTo-Json -Compress
}
