// ---------------------------------------------------------------------------
// kdl-classifier — Full infrastructure (subscription-scoped, 1-click ready)
// ---------------------------------------------------------------------------
// Usage:
//   az deployment sub create \
//     --location <region> \
//     --template-file infra/main.bicep \
//     --parameters infra/main.bicepparam
// ---------------------------------------------------------------------------

targetScope = 'subscription'

@description('Name of the resource group to create')
param resourceGroupName string

@description('Azure region for all resources')
param location string

@description('Unique suffix for globally unique names (lowercase, 3-8 chars)')
@minLength(3)
@maxLength(8)
param nameSuffix string

@description('Node.js runtime version')
param nodeVersion string = '~22'

// ── AOAI model (defaults match the validated configuration) ────────────────
@description('Azure OpenAI model name. Must be available in your subscription/region.')
param aoaiModelName string = 'gpt-5.4-mini'

@description('Azure OpenAI model version (date string).')
param aoaiModelVersion string = '2026-03-17'

@description('Azure OpenAI deployment SKU.')
@allowed(['GlobalStandard', 'Standard', 'ProvisionedManaged'])
param aoaiSkuName string = 'GlobalStandard'

@description('Azure OpenAI deployment capacity (thousands of TPM). Lower this if you hit quota limits.')
@minValue(1)
param aoaiCapacity int = 50

// ── Run-from-package: optional public ZIP URL for true 1-click code deploy ─────
@description('Optional public HTTPS URL of a Function App .zip package. When set, the app runs directly from this package (no separate code deploy needed).')
param functionPackageUrl string = ''

// ── Resource Group ──────────────────────────────────────────────────────────

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

// ── Module: core infra ──────────────────────────────────────────────────────

module core 'modules/core.bicep' = {
  scope: rg
  name: 'core-${nameSuffix}'
  params: {
    location: location
    nameSuffix: nameSuffix
    nodeVersion: nodeVersion
    aoaiModelName: aoaiModelName
    aoaiModelVersion: aoaiModelVersion
    aoaiSkuName: aoaiSkuName
    aoaiCapacity: aoaiCapacity
    functionPackageUrl: functionPackageUrl
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

output resourceGroupName string = rg.name
output functionAppName string = core.outputs.functionAppName
output functionAppUrl string = core.outputs.functionAppUrl
output visionEndpoint string = core.outputs.visionEndpoint
output speechEndpoint string = core.outputs.speechEndpoint
output docIntelligenceEndpoint string = core.outputs.docIntelligenceEndpoint
output openaiEndpoint string = core.outputs.openaiEndpoint
output eventGridTopicEndpoint string = core.outputs.eventGridTopicEndpoint
