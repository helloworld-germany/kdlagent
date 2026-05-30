<#
.SYNOPSIS
  Deploy kdl-classifier infrastructure and function code to Azure.

.DESCRIPTION
  1. Deploys Bicep template (subscription-scoped) → creates resource group + all resources
  2. Publishes function code via Azure Functions Core Tools

.PARAMETER Location
  Azure region (default: westeurope)

.PARAMETER NameSuffix
  Short unique suffix for resource names (3-8 chars, lowercase)

.PARAMETER ResourceGroupName
  Resource group name (default: rg-kdl-classifier)

.PARAMETER SkipInfra
  Skip Bicep deployment, only publish function code

.EXAMPLE
  .\deploy.ps1 -NameSuffix "abc1"
  .\deploy.ps1 -NameSuffix "abc1" -SkipInfra
#>

param(
  [Parameter(Mandatory)]
  [ValidateLength(3, 8)]
  [string]$NameSuffix,

  [string]$Location = 'westeurope',
  [string]$ResourceGroupName = 'rg-kdl-classifier',
  [switch]$SkipInfra
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$funcAppName = "func-kdl-$NameSuffix"

# ── 1. Infrastructure ───────────────────────────────────────────────────────

if (-not $SkipInfra) {
  Write-Host "`n=== Deploying infrastructure ===" -ForegroundColor Cyan

  az deployment sub create `
    --location $Location `
    --template-file "$PSScriptRoot\infra\main.bicep" `
    --parameters resourceGroupName=$ResourceGroupName `
                 location=$Location `
                 nameSuffix=$NameSuffix `
    --name "kdl-classifier-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
    --output table

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Bicep deployment failed."
    exit 1
  }

  Write-Host "Infrastructure deployed." -ForegroundColor Green
}

# ── 2. Publish function code ────────────────────────────────────────────────

Write-Host "`n=== Publishing function app ===" -ForegroundColor Cyan

Push-Location $PSScriptRoot
try {
  func azure functionapp publish $funcAppName --javascript
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Function publish failed."
    exit 1
  }
} finally {
  Pop-Location
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Function App: https://$funcAppName.azurewebsites.net"
Write-Host "Debug page:   https://$funcAppName.azurewebsites.net/api/debug"
Write-Host "Classify API: https://$funcAppName.azurewebsites.net/api/classify"
