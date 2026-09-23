[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$resolvedRepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$planner = Join-Path $resolvedRepositoryRoot 'scripts\backup-recovery-operator-plan.mjs'

Push-Location $resolvedRepositoryRoot
try {
    & node $planner --config $resolvedConfigPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'BACKUP_TASK_PLAN_INVALID'
    }

    # The remote credential bridge and destructive recovery executor are deliberately
    # not enabled by the source-only scheduler foundation. A scheduled task remains
    # disabled until the separate hosted activation gate installs that bridge.
    throw 'BACKUP_OPERATOR_CREDENTIAL_BRIDGE_NOT_ACTIVATED'
}
finally {
    Pop-Location
}
