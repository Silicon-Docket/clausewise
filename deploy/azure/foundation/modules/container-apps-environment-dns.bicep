// An internal environment answers on one private address for every app, under its generated
// default domain. Azure does not publish that domain in any DNS, so this zone does: every name
// under it points at the environment's internal load balancer.

param tags { *: string }
param vnetId string
param defaultDomain string
param staticIp string

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: defaultDomain
  location: 'global'
  tags: tags
}

resource wildcard 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*'
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: staticIp
      }
    ]
  }
}

resource apex 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '@'
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: staticIp
      }
    ]
  }
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: 'foundation-vnet'
  location: 'global'
  tags: tags
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}
