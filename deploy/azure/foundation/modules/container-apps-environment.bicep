// The Container Apps environment the application's apps and jobs run in.

param location string
param tags { *: string }
param prefix string
param infrastructureSubnetId string
param vnetId string
param logAnalyticsWorkspaceId string
param zoneRedundant bool

@description('The resource group Container Apps creates for its own load balancer and egress address.')
param infrastructureResourceGroupName string

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: '${prefix}-apps'
  location: location
  tags: tags
  properties: {
    // Workload profiles, because Microsoft supports user-defined routes and controlled egress
    // only on that environment type. The Consumption profile is enough for the thin slice; a
    // Dedicated profile can be added later without recreating the environment.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      // Internal: the environment gets an internal load balancer and no public address for
      // ingress, so it is reachable only from the firm's network (design section 3.4).
      internal: true
    }
    publicNetworkAccess: 'Disabled'
    infrastructureResourceGroup: infrastructureResourceGroupName
    zoneRedundant: zoneRedundant
    // azure-monitor, not log-analytics: the log-analytics destination needs the workspace's
    // shared key, which would be a stored secret and which the workspace refuses anyway.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    // Traffic between apps inside the environment is encrypted as well.
    peerTrafficConfiguration: {
      encryption: {
        enabled: true
      }
    }
  }
}

resource logs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: managedEnvironment
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// The zone's name is the environment's generated default domain, which is known only once the
// environment exists, so it is created one level down where it can be passed in.
module dns 'container-apps-environment-dns.bicep' = {
  name: 'environment-dns'
  params: {
    tags: tags
    vnetId: vnetId
    defaultDomain: managedEnvironment.properties.defaultDomain
    staticIp: managedEnvironment.properties.staticIp
  }
}

output environmentId string = managedEnvironment.id
output environmentName string = managedEnvironment.name
output defaultDomain string = managedEnvironment.properties.defaultDomain
output staticIp string = managedEnvironment.properties.staticIp
output workloadProfileName string = 'Consumption'
