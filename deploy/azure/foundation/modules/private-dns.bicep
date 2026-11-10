// Private DNS zones for every private endpoint the foundation creates, linked to the virtual
// network, so that the public names of the services resolve to their private addresses there.
//
// The firm's own network resolves these names only if its DNS forwards the zones to Azure (for
// example through an Azure DNS Private Resolver). Browsers need that for Blob Storage uploads.

param tags { *: string }
param vnetId string

@description('PostgreSQL flexible server private link zone. Azure does not expose this suffix through environment().')
param postgresZoneName string = 'privatelink.postgres.database.azure.com'

@description('Azure OpenAI private link zone. Azure does not expose this suffix through environment().')
param openAiZoneName string = 'privatelink.openai.azure.com'

var zoneNames = {
  blob: 'privatelink.blob.${environment().suffixes.storage}'
  queue: 'privatelink.queue.${environment().suffixes.storage}'
  postgres: postgresZoneName
  openAi: openAiZoneName
  // acrLoginServer starts with a dot. The registry's regional data endpoint gets its records in
  // this same zone, so no separate data zone is created.
  registry: 'privatelink${environment().suffixes.acrLoginServer}'
}

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for zone in items(zoneNames): {
    name: zone.value
    location: 'global'
    tags: tags
  }
]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (zone, i) in items(zoneNames): {
    parent: zones[i]
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
]

// Reading the output waits for the module, so a private endpoint never links to a zone that is
// still being created.
output zoneIds { *: string } = toObject(
  items(zoneNames),
  zone => zone.key,
  zone => resourceId('Microsoft.Network/privateDnsZones', zone.value)
)

output zoneNames string[] = map(items(zoneNames), zone => zone.value)
