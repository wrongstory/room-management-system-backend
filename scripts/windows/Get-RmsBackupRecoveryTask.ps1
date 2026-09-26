[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'RMS-Production-Backup-Recovery'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{
        TaskName = $taskName
        Installed = $false
        State = 'NotInstalled'
    } | ConvertTo-Json -Compress
    exit 0
}

$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $taskName
    Installed = $true
    State = [string]$task.State
    LastTaskResult = $info.LastTaskResult
    LastRunTime = $info.LastRunTime.ToString('o')
    NextRunTime = $info.NextRunTime.ToString('o')
} | ConvertTo-Json -Compress
