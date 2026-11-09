// Clausewise foundation: everything a firm deploys once, with its own Owner rights, into its own
// Azure subscription. The design is docs/azure-in-tenant.md; section 3.1 lists what is here.
//
// The application (web, worker, add-in host and the migrate job) is a separate, later template
// that deploys into the application resource group created here and reads this deployment's
// outputs. So is the optional Lighthouse delegation of that group.

targetScope = 'subscription'

import { identityInfo } from 'modules/identities.bicep'

metadata description = 'Clausewise foundation: network, data stores, model service, registry, identities, sign-in registration and policy guardrails.'

// ---------------------------------------------------------------------------------------------
// Naming and placement

@description('Short name put in front of every resource name. Lowercase letters and digits only, because storage and registry names allow nothing else.')
@minLength(2)
@maxLength(8)
param prefix string = 'cw'

@description('Region for every resource except, optionally, the model service.')
param location string = deployment().location

@description('Resource group for the foundation: network, data stores, model service, registry, environment.')
param foundationResourceGroupName string = '${prefix}-foundation'

@description('Resource group for the application: its identities now, its container apps and jobs later. This is the only group a provider may be delegated.')
param applicationResourceGroupName string = '${prefix}-application'

@description('Tags put on every resource.')
param tags { *: string } = {
  application: 'clausewise'
}

// ---------------------------------------------------------------------------------------------
// Network

@description('Address space of the virtual network. It must not overlap the firm\'s other networks, nor the ranges Container Apps reserves: 169.254.0.0/16, 172.30.0.0/16, 172.31.0.0/16, 192.0.2.0/24, and 100.100.0.0 to 100.100.223.255.')
param vnetAddressPrefix string = '10.40.0.0/22'

@description('Subnet for the Container Apps environment, /27 or larger. Its size cannot change after the environment is created.')
param containerAppsSubnetPrefix string = '10.40.0.0/24'

@description('Subnet for the private endpoints.')
param privateEndpointSubnetPrefix string = '10.40.1.0/26'

// ---------------------------------------------------------------------------------------------
// Container Apps environment and monitoring

@description('Spread the environment across availability zones. Needs a region with zones.')
param containerAppsZoneRedundant bool = false

@description('Days Log Analytics keeps logs.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 90

// ---------------------------------------------------------------------------------------------
// PostgreSQL

@description('Object id of the Entra ID group whose members administer PostgreSQL. There is no password administrator.')
param postgresAdminGroupObjectId string

@description('Display name of that group, exactly as Entra ID shows it.')
param postgresAdminGroupName string

@description('PostgreSQL major version.')
param postgresVersion string = '16'

@description('Compute size, such as Standard_D2ds_v5 (General Purpose) or Standard_B2s (Burstable).')
param postgresSkuName string = 'Standard_D2ds_v5'

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string = 'GeneralPurpose'

@minValue(32)
param postgresStorageSizeGB int = 32

@description('Days of point-in-time restore.')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 35

@description('Also keep backups in the paired region. Not every region supports it.')
param postgresGeoRedundantBackup bool = false

@description('ZoneRedundant and SameZone need the GeneralPurpose or MemoryOptimized tier.')
@allowed([
  'Disabled'
  'ZoneRedundant'
  'SameZone'
])
param postgresHighAvailability string = 'Disabled'

// ---------------------------------------------------------------------------------------------
// Storage

@description('Standard_ZRS keeps a copy in each availability zone. Use Standard_LRS in a region without zones.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param storageSku string = 'Standard_ZRS'

@description('Days that deleted contracts and results, and their earlier versions, can be recovered.')
@minValue(1)
@maxValue(365)
param blobRetentionDays int = 30

// ---------------------------------------------------------------------------------------------
// Model service (design section 5)

@description('Region of the Azure OpenAI account, if the model is not offered in the main region. The private endpoint stays in the main region.')
param openAiLocation string = location

@description('Model to deploy, such as gpt-4.1. Run the evaluation harness against it before use (design section 8).')
param openAiModelName string

@description('Model version, such as 2025-04-14. It never changes on its own: automatic upgrades are off.')
param openAiModelVersion string

// Global deployments may process prompts in any Azure region. The design promises the region or
// data zone of the deployment, so only those deployment types are offered.
@description('Deployment type. Standard processes in the account\'s region; DataZoneStandard within its data zone (EU or US).')
@allowed([
  'Standard'
  'DataZoneStandard'
  'ProvisionedManaged'
  'DataZoneProvisionedManaged'
])
param openAiDeploymentSku string = 'DataZoneStandard'

@description('Capacity in the deployment type\'s units: thousands of tokens per minute for Standard and DataZoneStandard.')
@minValue(1)
param openAiDeploymentCapacity int = 50

@description('Name of the model deployment. The application passes it as CLAUSEWISE_MODEL.')
param openAiDeploymentName string = 'clausewise'

// ---------------------------------------------------------------------------------------------
// Registry

@description('Public repository prefix Clausewise\'s images are published under, without a trailing slash, such as ghcr.io/<owner>/clausewise.')
param upstreamImageRepository string

// ---------------------------------------------------------------------------------------------
// Sign-in

@description('Display name of the sign-in app registration.')
param signInAppDisplayName string = 'Clausewise'

@description('Name the application template gives the web container app. Its address is https://<this>.<environment default domain>/.')
param webAppName string = 'web'

@description('HTTPS redirect URIs for sign-in, for a custom domain or the Word add-in\'s sign-in page. Empty means the web app\'s own address in the environment; otherwise list every address, the web interface\'s included.')
param spaRedirectUris string[] = []

@description('Object ids of the Entra ID groups whose members may sign in. Leave empty to assign groups later in Enterprise applications.')
param signInGroupObjectIds string[] = []

// ---------------------------------------------------------------------------------------------

// Storage, registry, PostgreSQL and Azure OpenAI names are global DNS names, so they carry a
// suffix that is stable for this subscription and resource group but unlikely to be taken.
var suffix = uniqueString(subscription().id, foundationResourceGroupName)
var globalPrefix = toLower(prefix)

var names = {
  postgres: '${globalPrefix}-pg-${suffix}'
  contractsStorage: take('${globalPrefix}docs${suffix}', 24)
  queueStorage: take('${globalPrefix}jobs${suffix}', 24)
  openAi: '${globalPrefix}-openai-${suffix}'
  registry: take('${globalPrefix}registry${suffix}', 50)
  environmentInfrastructure: '${prefix}-apps-infrastructure'
  signInApp: '${prefix}-clausewise-signin-${suffix}'
}

var contractsContainers = [
  'contracts'
  'results'
]
var reviewQueue = 'reviews'
var databaseName = 'clausewise'
var registryNamespace = 'clausewise'


resource foundationRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: foundationResourceGroupName
  location: location
  tags: tags
}

resource applicationRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: applicationResourceGroupName
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------------------------
// Network and DNS

module network 'modules/network.bicep' = {
  name: 'network'
  scope: foundationRg
  params: {
    location: location
    tags: tags
    prefix: prefix
    vnetAddressPrefix: vnetAddressPrefix
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
  }
}

module privateDns 'modules/private-dns.bicep' = {
  name: 'private-dns'
  scope: foundationRg
  params: {
    tags: tags
    vnetId: network.outputs.vnetId
  }
}

// ---------------------------------------------------------------------------------------------
// Monitoring and the Container Apps environment

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: foundationRg
  params: {
    location: location
    tags: tags
    prefix: prefix
    retentionInDays: logRetentionDays
  }
}

// The environment sits in the application group because deploying a container app or job needs
// join/action on its environment, and a delegated provider holds roles on that group only.
// Container Apps Contributor can join an environment but not change it, so its network settings
// stay as the firm deployed them.
module appsEnvironment 'modules/container-apps-environment.bicep' = {
  name: 'container-apps-environment'
  scope: applicationRg
  params: {
    location: location
    tags: tags
    prefix: prefix
    infrastructureSubnetId: network.outputs.containerAppsSubnetId
    vnetId: network.outputs.vnetId
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
    zoneRedundant: containerAppsZoneRedundant
    infrastructureResourceGroupName: names.environmentInfrastructure
  }
}

// The environment's default domain is generated when it is created, so the web app's address is
// known only now. Using it means the firm needs no custom domain of its own to start, provided
// Azure serves the domain with a certificate it manages, which phase 1 has to confirm.
var webUrl = 'https://${webAppName}.${appsEnvironment.outputs.defaultDomain}/'
var redirectUris = empty(spaRedirectUris) ? [webUrl] : spaRedirectUris


// ---------------------------------------------------------------------------------------------
// Application identities, in the application resource group

module identities 'modules/identities.bicep' = {
  name: 'identities'
  scope: applicationRg
  params: {
    location: location
    tags: tags
    prefix: prefix
  }
}

// ---------------------------------------------------------------------------------------------
// Data stores

module contractsStorage 'modules/storage-account.bicep' = {
  name: 'storage-contracts'
  scope: foundationRg
  params: {
    name: names.contractsStorage
    location: location
    tags: tags
    skuName: storageSku
    blobContainers: contractsContainers
    protectBlobs: true
    blobRetentionDays: blobRetentionDays
  }
}

module contractsEndpoint 'modules/private-endpoint.bicep' = {
  name: 'endpoint-contracts-blob'
  scope: foundationRg
  params: {
    name: '${prefix}-pe-contracts-blob'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: contractsStorage.outputs.id
    groupId: 'blob'
    privateDnsZoneId: privateDns.outputs.zoneIds.blob
  }
}

module queueStorage 'modules/storage-account.bicep' = {
  name: 'storage-queue'
  scope: foundationRg
  params: {
    name: names.queueStorage
    location: location
    tags: tags
    skuName: storageSku
    queues: [
      reviewQueue
    ]
  }
}

module queueEndpoint 'modules/private-endpoint.bicep' = {
  name: 'endpoint-reviews-queue'
  scope: foundationRg
  params: {
    name: '${prefix}-pe-reviews-queue'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: queueStorage.outputs.id
    groupId: 'queue'
    privateDnsZoneId: privateDns.outputs.zoneIds.queue
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  scope: foundationRg
  params: {
    name: names.postgres
    location: location
    tags: tags
    version: postgresVersion
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageSizeGB
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    highAvailabilityMode: postgresHighAvailability
    databaseName: databaseName
    adminGroupObjectId: postgresAdminGroupObjectId
    adminGroupName: postgresAdminGroupName
    migratePrincipalId: identities.outputs.migrate.principalId
    migrateIdentityName: identities.outputs.migrate.name
  }
}

module postgresEndpoint 'modules/private-endpoint.bicep' = {
  name: 'endpoint-postgres'
  scope: foundationRg
  params: {
    name: '${prefix}-pe-postgres'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: postgres.outputs.id
    groupId: 'postgresqlServer'
    privateDnsZoneId: privateDns.outputs.zoneIds.postgres
  }
}

// ---------------------------------------------------------------------------------------------
// Model service

module openAi 'modules/openai.bicep' = {
  name: 'openai'
  scope: foundationRg
  params: {
    name: names.openAi
    location: openAiLocation
    tags: tags
    deploymentName: openAiDeploymentName
    modelName: openAiModelName
    modelVersion: openAiModelVersion
    deploymentSku: openAiDeploymentSku
    deploymentCapacity: openAiDeploymentCapacity
  }
}

module openAiEndpoint 'modules/private-endpoint.bicep' = {
  name: 'endpoint-openai'
  scope: foundationRg
  params: {
    name: '${prefix}-pe-openai'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: openAi.outputs.id
    groupId: 'account'
    privateDnsZoneId: privateDns.outputs.zoneIds.openAi
  }
}

// ---------------------------------------------------------------------------------------------
// Registry

module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: foundationRg
  params: {
    name: names.registry
    location: location
    tags: tags
    upstreamRepository: upstreamImageRepository
    targetNamespace: registryNamespace
  }
}

module registryEndpoint 'modules/private-endpoint.bicep' = {
  name: 'endpoint-registry'
  scope: foundationRg
  params: {
    name: '${prefix}-pe-registry'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: registry.outputs.id
    groupId: 'registry'
    privateDnsZoneId: privateDns.outputs.zoneIds.registry
  }
}

// ---------------------------------------------------------------------------------------------
// Roles for the application identities, on foundation resources

module roleAssignments 'modules/role-assignments.bicep' = {
  name: 'role-assignments'
  scope: foundationRg
  params: {
    webPrincipalId: identities.outputs.web.principalId
    workerPrincipalId: identities.outputs.worker.principalId
    migratePrincipalId: identities.outputs.migrate.principalId
    contractsStorageName: contractsStorage.outputs.name
    contractsContainerNames: contractsContainers
    queueStorageName: queueStorage.outputs.name
    openAiName: openAi.outputs.name
    registryName: registry.outputs.name
    appInsightsName: monitoring.outputs.appInsightsName
  }
}

// ---------------------------------------------------------------------------------------------
// Sign-in registration, in the firm's directory

module signIn 'modules/entra-app.bicep' = {
  name: 'entra-sign-in'
  scope: foundationRg
  params: {
    uniqueName: names.signInApp
    displayName: signInAppDisplayName
    spaRedirectUris: redirectUris
    signInGroupObjectIds: signInGroupObjectIds
    accessScopeId: guid(subscription().id, names.signInApp, 'access_as_user')
  }
}

// ---------------------------------------------------------------------------------------------
// Policy guardrails (design section 7.2): custom definitions in the subscription, assignments
// on both resource groups

resource postgresPolicy 'Microsoft.Authorization/policyDefinitions@2025-03-01' = {
  name: 'clausewise-postgres-entra-only'
  properties: loadJsonContent('policies/postgres-entra-only.json')
}

resource imagePolicy 'Microsoft.Authorization/policyDefinitions@2025-03-01' = {
  name: 'clausewise-images-from-registry'
  properties: loadJsonContent('policies/container-images-from-registry.json')
}

module foundationPolicies 'modules/policy-assignments.bicep' = {
  name: 'policy-assignments-foundation'
  scope: foundationRg
  params: {
    postgresPolicyDefinitionId: postgresPolicy.id
    imagePolicyDefinitionId: imagePolicy.id
    registryLoginServer: registry.outputs.loginServer
  }
}

module applicationPolicies 'modules/policy-assignments.bicep' = {
  name: 'policy-assignments-application'
  scope: applicationRg
  params: {
    postgresPolicyDefinitionId: postgresPolicy.id
    imagePolicyDefinitionId: imagePolicy.id
    registryLoginServer: registry.outputs.loginServer
  }
}

// ---------------------------------------------------------------------------------------------
// Outputs for the application template. None of them is a secret.

output tenantId string = tenant().tenantId
output foundationResourceGroupName string = foundationRg.name
output applicationResourceGroupName string = applicationRg.name

output containerAppsEnvironmentId string = appsEnvironment.outputs.environmentId
output containerAppsEnvironmentDefaultDomain string = appsEnvironment.outputs.defaultDomain
// Every private DNS zone the deployment uses. Users need only the last, the environment's own
// domain, which the firm's DNS forwards to Azure; the others resolve private endpoints inside the
// virtual network.
output privateDnsZones string[] = concat(privateDns.outputs.zoneNames, [appsEnvironment.outputs.defaultDomain])
output containerAppsEnvironmentStaticIp string = appsEnvironment.outputs.staticIp
output containerAppsWorkloadProfileName string = appsEnvironment.outputs.workloadProfileName
output webAppName string = webAppName
output webUrl string = webUrl

output registryLoginServer string = registry.outputs.loginServer
output registryImagePrefix string = '${registry.outputs.loginServer}/${registryNamespace}'

output webIdentity identityInfo = identities.outputs.web
output workerIdentity identityInfo = identities.outputs.worker
output migrateIdentity identityInfo = identities.outputs.migrate

output postgresServerFqdn string = postgres.outputs.fqdn
output postgresDatabaseName string = postgres.outputs.databaseName

output contractsStorageAccountName string = contractsStorage.outputs.name
output contractsBlobEndpoint string = contractsStorage.outputs.blobEndpoint
output contractsContainerName string = contractsContainers[0]
output resultsContainerName string = contractsContainers[1]
output queueStorageAccountName string = queueStorage.outputs.name
output queueEndpoint string = queueStorage.outputs.queueEndpoint
output reviewQueueName string = reviewQueue

output openAiEndpoint string = openAi.outputs.endpoint
// What @clausewise/llm reads as CLAUSEWISE_BASE_URL for the azure-openai provider.
output openAiBaseUrl string = '${openAi.outputs.endpoint}openai/v1'
output openAiDeploymentName string = openAi.outputs.deploymentName

output appInsightsConnectionString string = monitoring.outputs.appInsightsConnectionString
output logAnalyticsWorkspaceId string = monitoring.outputs.workspaceId

output signInClientId string = signIn.outputs.clientId
output signInApiScope string = signIn.outputs.accessScope
