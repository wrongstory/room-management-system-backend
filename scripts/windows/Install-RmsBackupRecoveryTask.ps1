[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [switch]$Enable
)

$ErrorActionPreference = 'Stop'
$taskName = 'RMS-Production-Backup-Recovery'

if (-not $Enable) {
    throw 'BACKUP_TASK_ENABLE_CONFIRMATION_REQUIRED'
}

$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$planner = Join-Path $resolvedRepositoryRoot 'scripts\backup-recovery-operator-plan.mjs'
$runner = Join-Path $resolvedRepositoryRoot 'scripts\windows\Invoke-RmsBackupRecovery.ps1'

if (-not (Test-Path -LiteralPath $planner -PathType Leaf)) {
    throw 'BACKUP_TASK_PLANNER_NOT_FOUND'
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw 'BACKUP_TASK_RUNNER_NOT_FOUND'
}

$planJson = & node $planner --config $resolvedConfigPath
if ($LASTEXITCODE -ne 0) {
    throw 'BACKUP_TASK_PLAN_INVALID'
}
$plan = $planJson | ConvertFrom-Json

$actionArguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ('"{0}"' -f $runner),
    '-RepositoryRoot',
    ('"{0}"' -f $resolvedRepositoryRoot),
    '-ConfigPath',
    ('"{0}"' -f $resolvedConfigPath)
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -Daily -At $plan.scheduleTimeKst
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited

if ($PSCmdlet.ShouldProcess($taskName, 'Register disabled backup and recovery task')) {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Write-Output "BACKUP_TASK_REGISTERED_DISABLED:$taskName"
}
