// Core infrastructure for kdl-classifier
// All auth via managed identity + RBAC — no keys anywhere

@description('Azure region for all resources')
param location string

@description('Unique suffix for globally unique names')
@minLength(3)
@maxLength(8)
param nameSuffix string

@description('Node.js runtime version')
param nodeVersion string = '~22'

// ── AOAI model (parametrized for quota / region flexibility) ────────────────
@description('Azure OpenAI model name')
param aoaiModelName string = 'gpt-5.4-mini'

@description('Azure OpenAI model version (date string)')
param aoaiModelVersion string = '2026-03-17'

@description('Azure OpenAI deployment SKU')
@allowed(['GlobalStandard', 'Standard', 'ProvisionedManaged'])
param aoaiSkuName string = 'GlobalStandard'

@description('Azure OpenAI deployment capacity (thousands of TPM)')
@minValue(1)
param aoaiCapacity int = 50

@description('Public HTTPS URL of a function-app .zip package to mount via WEBSITE_RUN_FROM_PACKAGE. Leave empty to deploy code separately via deploy.ps1 / CI.')
param functionPackageUrl string = ''

// Built-in role definition IDs
var cognitiveServicesUserRole = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var cognitiveServicesOpenAIUserRole = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var eventGridDataSenderRole = 'd5a91429-5739-47e2-a06b-3470a27159e7'
var storageBlobDataOwnerRole = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributorRole = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributorRole = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

// Storage sub-resources that need private endpoints
var storageSubResources = ['blob', 'queue', 'table', 'file']

// ── Storage Account (Functions runtime — managed identity, no shared keys) ──

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stkdl${nameSuffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// ── Virtual Network (Function App integration + private endpoints) ──────────

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-kdl-${nameSuffix}'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    }
  }
}

resource subnetApp 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-app'
  properties: {
    addressPrefix: '10.0.1.0/24'
    delegations: [
      {
        name: 'delegation-app'
        properties: {
          serviceName: 'Microsoft.Web/serverFarms'
        }
      }
    ]
  }
}

resource subnetPe 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-pe'
  properties: {
    addressPrefix: '10.0.2.0/24'
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [subnetApp]
}

// ── App Service Plan (Elastic Premium — supports RBAC-only storage) ─────────

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-kdl-${nameSuffix}'
  location: location
  kind: 'elastic'
  sku: {
    name: 'EP1'
    tier: 'ElasticPremium'
  }
  properties: {
    reserved: true
  }
}

// ── Function App ────────────────────────────────────────────────────────────

var baseAppSettings = [
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: nodeVersion }
  // Storage via managed identity (no connection string)
  { name: 'AzureWebJobsStorage__accountName', value: storage.name }
  // Cognitive Services endpoints
  { name: 'AZURE_AI_VISION_ENDPOINT', value: vision.properties.endpoint }
  { name: 'AZURE_AI_SPEECH_ENDPOINT', value: speech.properties.endpoint }
  { name: 'AZURE_DOC_INTELLIGENCE_ENDPOINT', value: docIntelligence.properties.endpoint }
  // Azure OpenAI
  { name: 'AZURE_OPENAI_ENDPOINT', value: openai.properties.endpoint }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: gptDeployment.name }
  // Event Grid
  { name: 'EVENT_GRID_TOPIC_ENDPOINT', value: eventGridTopic.properties.endpoint }
  // VNet integration
  { name: 'WEBSITE_CONTENTOVERVNET', value: '1' }
  { name: 'WEBSITE_VNET_ROUTE_ALL', value: '1' }
  // Remote build (ignored when WEBSITE_RUN_FROM_PACKAGE is set)
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
]

var packageAppSettings = empty(functionPackageUrl) ? [] : [
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: functionPackageUrl }
]

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-kdl-${nameSuffix}'
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    virtualNetworkSubnetId: subnetApp.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: [
          'https://func-kdl-${nameSuffix}.azurewebsites.net'
        ]
        supportCredentials: false
      }
      appSettings: union(baseAppSettings, packageAppSettings)
    }
  }
  dependsOn: [storagePeDnsGroups]
}

// ── Azure AI Vision (Computer Vision) ───────────────────────────────────────

resource vision 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'cv-kdl-${nameSuffix}'
  location: location
  kind: 'ComputerVision'
  sku: { name: 'S1' }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'cv-kdl-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// ── Azure Document Intelligence (PDF OCR with handwriting support) ───────────

resource docIntelligence 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'di-kdl-${nameSuffix}'
  location: location
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'di-kdl-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// ── Azure AI Speech ─────────────────────────────────────────────────────────

resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'speech-kdl-${nameSuffix}'
  location: location
  kind: 'SpeechServices'
  sku: { name: 'S0' }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'speech-kdl-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// ── Azure OpenAI ────────────────────────────────────────────────────────────

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'oai-kdl-${nameSuffix}'
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: 'oai-kdl-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource gptDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: aoaiModelName
  sku: {
    name: aoaiSkuName
    capacity: aoaiCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: aoaiModelName
      version: aoaiModelVersion
    }
  }
}

// ── Event Grid Topic ────────────────────────────────────────────────────────

resource eventGridTopic 'Microsoft.EventGrid/topics@2024-06-01-preview' = {
  name: 'evgt-kdl-${nameSuffix}'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    inputSchema: 'EventGridSchema'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// ── RBAC: Function App → Cognitive Services User (Vision) ───────────────────

resource visionRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vision.id, functionApp.id, cognitiveServicesUserRole)
  scope: vision
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App → Cognitive Services User (Document Intelligence) ────

resource docIntelligenceRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(docIntelligence.id, functionApp.id, cognitiveServicesUserRole)
  scope: docIntelligence
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App → Cognitive Services User (Speech) ───────────────────

resource speechRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(speech.id, functionApp.id, cognitiveServicesUserRole)
  scope: speech
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App → Cognitive Services OpenAI User ────────────────────

resource openaiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openai.id, functionApp.id, cognitiveServicesOpenAIUserRole)
  scope: openai
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAIUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App → Event Grid Data Sender ────────────────────────────

resource eventGridRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(eventGridTopic.id, functionApp.id, eventGridDataSenderRole)
  scope: eventGridTopic
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventGridDataSenderRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App → Storage (Blob, Queue, Table for Functions runtime) ─

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageBlobDataOwnerRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storageQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageQueueDataContributorRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageTableDataContributorRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Private Endpoints + DNS (Storage over VNet) ─────────────────────────────

resource storageDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for sub in storageSubResources: {
  name: 'privatelink.${sub}.core.windows.net'
  location: 'global'
}]

resource storageDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (sub, i) in storageSubResources: {
  parent: storageDnsZones[i]
  name: 'link-${sub}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}]

resource storagePe 'Microsoft.Network/privateEndpoints@2024-01-01' = [for sub in storageSubResources: {
  name: 'pe-${sub}-kdl-${nameSuffix}'
  location: location
  properties: {
    subnet: { id: subnetPe.id }
    privateLinkServiceConnections: [
      {
        name: sub
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [sub]
        }
      }
    ]
  }
}]

resource storagePeDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = [for (sub, i) in storageSubResources: {
  parent: storagePe[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: sub
        properties: {
          privateDnsZoneId: storageDnsZones[i].id
        }
      }
    ]
  }
}]

// ── Outputs ─────────────────────────────────────────────────────────────────

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output visionEndpoint string = vision.properties.endpoint
output speechEndpoint string = speech.properties.endpoint
output docIntelligenceEndpoint string = docIntelligence.properties.endpoint
output openaiEndpoint string = openai.properties.endpoint
output eventGridTopicEndpoint string = eventGridTopic.properties.endpoint
