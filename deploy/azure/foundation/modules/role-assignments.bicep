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

// The worker takes a job, deletes it once done, and hands it back early (Update Message, which
// needs messages/write) when the review is busy elsewhere, when it is stopping or when storage or
// the database failed. Storage Queue Data Message Processor has no write, and Storage Queue Data
// Contributor could also create and delete queues, so the worker gets a role of its own: the
// Message Processor's data actions plus write. Role names are unique in a tenant, so the name
// carries this subscription and group.
resource workerQueueRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'clausewise-review-queue-worker')
  properties: {
    roleName: 'Clausewise review queue worker, ${subscription().subscriptionId}, ${resourceGroup().name}'
    description: 'Takes review jobs off the Clausewise queue, deletes them when done and makes them visible again to hand them back.'
    type: 'CustomRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/queueServices/queues/messages/read'
          'Microsoft.Storage/storageAccounts/queueServices/queues/messages/process/action'
          'Microsoft.Storage/storageAccounts/queueServices/queues/messages/write'
        ]
        notDataActions: []
      }
    ]
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource workerQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queueStorage.id, workerPrincipalId, workerQueueRole.id)
  scope: queueStorage
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: workerQueueRole.id
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
