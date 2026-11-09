// Clausewise application: the web app, the worker and the migrate job, in the application
// resource group the foundation created. It runs one release of the server image, referenced by
// digest from the firm's registry, and takes everything else from the foundation's outputs.
//
// It needs roles on this group only: it creates container apps and a job, joins them to the
// environment and attaches the identities the foundation made. That is what lets a provider with
// delegated management deploy releases without any right on the foundation (design section 7).

targetScope = 'resourceGroup'

import { identityInfo } from '../foundation/modules/identities.bicep'

metadata description = 'Clausewise application: web app, review worker and migrate job, from one image digest.'

// The foundation's outputs that this template uses. The foundation's other outputs may be passed
// along too; they are ignored.
type foundationOutputs = {
  tenantId: string
  containerAppsEnvironmentId: string
  containerAppsWorkloadProfileName: string
  webAppName: string
  registryLoginServer: string
  registryImagePrefix: string
  webIdentity: identityInfo
  workerIdentity: identityInfo
  migrateIdentity: identityInfo
  postgresServerFqdn: string
  postgresDatabaseName: string
  contractsBlobEndpoint: string
  contractsContainerName: string
  resultsContainerName: string
  queueEndpoint: string
  reviewQueueName: string
  openAiBaseUrl: string
  openAiDeploymentName: string
  signInClientId: string
}

@description('The foundation deployment\'s outputs, as deploy/azure/README.md shows how to collect them.')
param foundation foundationOutputs

@description('Digest of the server image the web app and the worker run, such as sha256:<64 hex digits>. Releases are published with theirs.')
@minLength(71)
@maxLength(71)
param imageDigest string

@description('Digest of the image the migrate job runs. The same as imageDigest unless an upgrade is being staged: migrations first, then the apps (deploy/azure/README.md).')
@minLength(71)
@maxLength(71)
param migrateImageDigest string = imageDigest

@description('Repository of the server image under the registry\'s Clausewise namespace.')
param imageRepository string = 'server'

@description('Name of the worker container app.')
param workerAppName string = 'worker'

@description('Name of the migrate job.')
param migrateJobName string = 'migrate'

@description('Web app replicas kept running. One or more, so the first request after a quiet spell does not wait for a start.')
@minValue(1)
@maxValue(10)
param webMinReplicas int = 1

@minValue(1)
@maxValue(30)
param webMaxReplicas int = 3

@description('Worker replicas. A fixed number: scaling on queue length would need a role the worker does not hold (deploy/azure/README.md).')
@minValue(1)
@maxValue(30)
param workerReplicas int = 1

@description('Rule checks each worker sends to the model at once (CLAUSEWISE_CONCURRENCY).')
@minValue(1)
@maxValue(32)
param reviewConcurrency int = 4

param location string = resourceGroup().location

param tags { *: string } = {
  application: 'clausewise'
}

// ---------------------------------------------------------------------------------------------

// The firm's registry pulls these through its cache rule. The image policy the foundation assigns
// admits nothing else: another registry, or a tag instead of a digest, is refused.
var image = '${foundation.registryImagePrefix}/${imageRepository}@${imageDigest}'
var migrateImage = '${foundation.registryImagePrefix}/${imageRepository}@${migrateImageDigest}'

// Container Apps sets IDENTITY_ENDPOINT and IDENTITY_HEADER itself once an identity is attached.
func signedInAs(identity identityInfo) object[] => [
  { name: 'AZURE_CLIENT_ID', value: identity.clientId }
  { name: 'CLAUSEWISE_POSTGRES_USER', value: identity.name }
]

func attached(identity identityInfo) object => {
  type: 'UserAssigned'
  userAssignedIdentities: {
    '${identity.id}': {}
  }
}

var database = [
  { name: 'CLAUSEWISE_POSTGRES_HOST', value: foundation.postgresServerFqdn }
  { name: 'CLAUSEWISE_POSTGRES_DATABASE', value: foundation.postgresDatabaseName }
]

var storage = [
  { name: 'CLAUSEWISE_BLOB_ENDPOINT', value: foundation.contractsBlobEndpoint }
  { name: 'CLAUSEWISE_CONTRACTS_CONTAINER', value: foundation.contractsContainerName }
  { name: 'CLAUSEWISE_RESULTS_CONTAINER', value: foundation.resultsContainerName }
  { name: 'CLAUSEWISE_QUEUE_ENDPOINT', value: foundation.queueEndpoint }
  { name: 'CLAUSEWISE_QUEUE_NAME', value: foundation.reviewQueueName }
]

var webPort = 8080
var health = '/api/health'

// ---------------------------------------------------------------------------------------------
// The web app: the page and the API, reachable from the firm's network only, since the
// environment is internal

resource web 'Microsoft.App/containerApps@2025-07-01' = {
  name: foundation.webAppName
  location: location
  tags: tags
  identity: attached(foundation.webIdentity)
  properties: {
    environmentId: foundation.containerAppsEnvironmentId
    workloadProfileName: foundation.containerAppsWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // In an internal environment, external means reachable from the virtual network (and the
        // networks peered with it), not from the internet.
        external: true
        targetPort: webPort
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: foundation.registryLoginServer
          identity: foundation.webIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          args: [
            'web'
          ]
          env: concat(signedInAs(foundation.webIdentity), database, storage, [
            { name: 'CLAUSEWISE_WEB_MODE', value: 'azure' }
            { name: 'PORT', value: string(webPort) }
            { name: 'CLAUSEWISE_ENTRA_TENANT_ID', value: foundation.tenantId }
            { name: 'CLAUSEWISE_ENTRA_CLIENT_ID', value: foundation.signInClientId }
          ])
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // Health says only that the process answers. Every setting was checked before it
          // started listening, so a replica that answers has a usable configuration.
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: health
                port: webPort
              }
              periodSeconds: 2
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: health
                port: webPort
              }
              periodSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: health
                port: webPort
              }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'requests'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The worker: takes review jobs off the queue. No ingress; it only calls out, to storage, the
// database and the model, each through its private endpoint.

resource worker 'Microsoft.App/containerApps@2025-07-01' = {
  name: workerAppName
  location: location
  tags: tags
  identity: attached(foundation.workerIdentity)
  properties: {
    environmentId: foundation.containerAppsEnvironmentId
    workloadProfileName: foundation.containerAppsWorkloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: foundation.registryLoginServer
          identity: foundation.workerIdentity.id
        }
      ]
    }
    template: {
      // On SIGTERM a worker hands its review back to the queue at once, for another to take.
      terminationGracePeriodSeconds: 60
      containers: [
        {
          name: 'worker'
          image: image
          args: [
            'worker'
          ]
          env: concat(signedInAs(foundation.workerIdentity), database, storage, [
            { name: 'CLAUSEWISE_PROVIDER', value: 'azure-openai' }
            { name: 'CLAUSEWISE_BASE_URL', value: foundation.openAiBaseUrl }
            { name: 'CLAUSEWISE_MODEL', value: foundation.openAiDeploymentName }
            { name: 'CLAUSEWISE_CONCURRENCY', value: string(reviewConcurrency) }
          ])
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: workerReplicas
        maxReplicas: workerReplicas
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The migrate job: started by hand before the apps first run and before each release
// (deploy/azure/README.md). It signs in as the migrate identity, the only Entra administrator of
// the database, and touches nothing else.

resource migrate 'Microsoft.App/jobs@2025-07-01' = {
  name: migrateJobName
  location: location
  tags: tags
  identity: attached(foundation.migrateIdentity)
  properties: {
    environmentId: foundation.containerAppsEnvironmentId
    workloadProfileName: foundation.containerAppsWorkloadProfileName
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 600
      // Each migration runs in a transaction under a lock, so a second attempt after a dropped
      // connection is safe; a second failure is for a person to read.
      replicaRetryLimit: 1
      registries: [
        {
          server: foundation.registryLoginServer
          identity: foundation.migrateIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migrateImage
          args: [
            'migrate'
          ]
          env: concat(signedInAs(foundation.migrateIdentity), database, [
            { name: 'CLAUSEWISE_WEB_ROLE', value: foundation.webIdentity.name }
            { name: 'CLAUSEWISE_WORKER_ROLE', value: foundation.workerIdentity.name }
          ])
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------------------------

@description('Where users open Clausewise. It should be the foundation\'s webUrl, which sign-in redirects to.')
output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}/'

output image string = image
output migrateImage string = migrateImage
output workerAppName string = worker.name
output migrateJobName string = migrate.name
