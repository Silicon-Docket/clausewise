// A storage account that accepts only Entra ID, only over its private endpoint.
//
// Used twice: once for contracts and results (blob), once for the review queue. Keeping the
// queue in its own account means a role on one never reaches the data in the other.

param name string
param location string
param tags { *: string }

@description('Blob containers to create. Empty for the queue account.')
param blobContainers string[] = []

@description('Queues to create. Empty for the blob account.')
param queues string[] = []

@description('Turn on blob versioning and soft delete. Off for the queue account, which holds no blobs.')
param protectBlobs bool = false

@description('Days that deleted blobs and containers can be recovered, when protectBlobs is on.')
@minValue(1)
@maxValue(365)
param blobRetentionDays int = 7

@description('Origins allowed to call Blob Storage from a browser, for uploads with a user delegation SAS.')
param blobCorsOrigins string[] = []

@description('Standard_ZRS keeps a copy in each availability zone. Use Standard_LRS in a region without zones.')
param skuName string

resource account 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: skuName
  }
  properties: {
    // No shared keys means no account keys, no account SAS and no service SAS. User delegation
    // SAS still works, because Entra ID signs it.
    allowSharedKeyAccess: false
    // The portal and tools use Entra ID by default instead of asking for a key.
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    // Copies between accounts only within the same private network scope.
    allowedCopyScope: 'PrivateLink'
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: protectBlobs
    deleteRetentionPolicy: protectBlobs
      ? {
          enabled: true
          days: blobRetentionDays
        }
      : {
          enabled: false
        }
    containerDeleteRetentionPolicy: protectBlobs
      ? {
          enabled: true
          days: blobRetentionDays
        }
      : {
          enabled: false
        }
    cors: {
      corsRules: empty(blobCorsOrigins)
        ? []
        : [
            {
              allowedOrigins: blobCorsOrigins
              // PUT uploads a block or a whole blob; GET and HEAD read results back.
              allowedMethods: [
                'GET'
                'HEAD'
                'PUT'
                'OPTIONS'
              ]
              allowedHeaders: [
                'content-type'
                'x-ms-*'
              ]
              exposedHeaders: [
                'etag'
                'x-ms-*'
              ]
              maxAgeInSeconds: 3600
            }
          ]
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = [
  for container in blobContainers: {
    parent: blobService
    name: container
    properties: {
      publicAccess: 'None'
    }
  }
]

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2025-06-01' = if (!empty(queues)) {
  parent: account
  name: 'default'
}

resource queueList 'Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01' = [
  for queue in queues: {
    parent: queueService
    name: queue
  }
]

output id string = account.id
output name string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
output queueEndpoint string = account.properties.primaryEndpoints.queue
