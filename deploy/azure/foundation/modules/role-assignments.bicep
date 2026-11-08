// Every data role the application's identities hold, assigned on foundation resources with the
// firm's own rights. A provider with delegated management of the application resource group
// holds no role here and cannot change these.

param webPrincipalId string
param workerPrincipalId string
param migratePrincipalId string

param contractsStorageName string
param contractsContainerNames string[]
param queueStorageName string
param openAiName string
param registryName string
param appInsightsName string

// Built-in role definition ids, from Microsoft Learn "Azure built-in roles".
var roles = {
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageQueueDataMessageSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
  storageQueueDataMessageProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  cognitiveServicesOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource contractsStorage 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: contractsStorageName

  resource blobService 'blobServices' existing = {
    name: 'default'
  }
}

resource contractsContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' existing = [
  for container in contractsContainerNames: {
    parent: contractsStorage::blobService
    name: container
  }
]

resource queueStorage 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: queueStorageName
}

resource openAi 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: openAiName
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Blob data roles are on the two containers rather than the account, so neither identity can
// create, delete or read any other container. Contracts are uploaded through the API, not straight
// from the browser, so no identity needs to sign upload links and none holds Storage Blob
// Delegator.
resource webBlobData 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (container, i) in contractsContainerNames: {
    name: guid(contractsContainers[i].id, webPrincipalId, roles.storageBlobDataContributor)
    scope: contractsContainers[i]
    properties: {
      principalId: webPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    }
  }
]

resource workerBlobData 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (container, i) in contractsContainerNames: {
    name: guid(contractsContainers[i].id, workerPrincipalId, roles.storageBlobDataContributor)
    scope: contractsContainers[i]
    properties: {
      principalId: workerPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    }
  }
]

// web only adds review jobs; worker reads them and deletes them once done.
resource webQueueSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queueStorage.id, webPrincipalId, roles.storageQueueDataMessageSender)
  scope: queueStorage
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageQueueDataMessageSender)
  }
}

resource workerQueueProcessor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queueStorage.id, workerPrincipalId, roles.storageQueueDataMessageProcessor)
  scope: queueStorage
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageQueueDataMessageProcessor)
  }
}

// Only the worker sends contract text to the model.
resource workerOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openAi.id, workerPrincipalId, roles.cognitiveServicesOpenAiUser)
  scope: openAi
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesOpenAiUser)
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in [webPrincipalId, workerPrincipalId, migratePrincipalId]: {
    name: guid(registry.id, principalId, roles.acrPull)
    scope: registry
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    }
  }
]

// Application Insights accepts telemetry only with an Entra ID token (local auth is off), and
// this is the role that lets a token write it.
resource telemetry 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in [webPrincipalId, workerPrincipalId]: {
    name: guid(appInsights.id, principalId, roles.monitoringMetricsPublisher)
    scope: appInsights
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
    }
  }
]
