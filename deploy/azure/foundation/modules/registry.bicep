// The firm's container registry, and the cache rule that fills it with Clausewise's images.

param name string
param location string
param tags { *: string }

@description('The public upstream repository prefix, without a trailing slash, such as ghcr.io/<owner>/clausewise.')
param upstreamRepository string

@description('Where the cached images appear in this registry. Images are pulled as <login server>/<this>/<image>@sha256:<digest>.')
param targetNamespace string

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: name
  location: location
  tags: tags
  // Premium is the tier that supports private endpoints.
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleSet: {
      defaultAction: 'Deny'
    }
    // Lets trusted Azure services past the network rules. Open question 2 of the design: one
    // Microsoft Q&A report says the artifact cache cannot store what it fetches into a registry
    // with public access disabled unless this is on. It is on by default for a new registry;
    // it is set here so that the choice is visible. Revisit once phase 1 has tested a cache pull
    // with it off.
    networkRuleBypassOptions: 'AzureServices'
  }
}

// Clausewise's images are public, so the rule has no credential set. The wildcard maps every
// repository under the upstream prefix, so web, worker, migrate and addin need one rule.
resource cacheRule 'Microsoft.ContainerRegistry/registries/cacheRules@2025-04-01' = {
  parent: registry
  name: 'clausewise'
  properties: {
    sourceRepository: '${upstreamRepository}/*'
    targetRepository: '${targetNamespace}/*'
  }
}

output id string = registry.id
output name string = registry.name
output loginServer string = registry.properties.loginServer
