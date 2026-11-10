// The model service: an Azure OpenAI account with one model deployment, reachable only over its
// private endpoint and only with Entra ID.

param name string
param location string
param tags { *: string }

param deploymentName string
param modelName string
param modelVersion string
param deploymentSku string
param deploymentCapacity int

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    // A custom subdomain is what lets the account accept Entra ID tokens at all, and it gives the
    // private endpoint a name to resolve: <name>.openai.azure.com.
    customSubDomainName: name
    // No API keys. The built-in policy assigned in the foundation would refuse this account
    // otherwise.
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: deploymentSku
    capacity: deploymentCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    // The model version changes only when the firm deploys a new one, after the evaluation
    // harness has been run against it (design section 8). Azure must not swap it underneath.
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output id string = account.id
output name string = account.name
output endpoint string = account.properties.endpoint
output deploymentName string = deployment.name
