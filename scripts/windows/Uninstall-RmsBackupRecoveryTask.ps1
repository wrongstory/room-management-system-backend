[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'RMS-Production-Backup-Recovery'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Output "BACKUP_TASK_NOT_FOUND:$taskName"
    exit 0
}

if ($PSCmdlet.ShouldProcess($taskName, 'Unregister backup and recovery task')) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "BACKUP_TASK_REMOVED:$taskName"
}
