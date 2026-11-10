// The application's managed identities. They live in the application resource group so that new
// revisions can be attached to them there; every role they hold is assigned by the foundation,
// on foundation resources, with the firm's rights. No federated credential is ever added.

param location string
param tags { *: string }
param prefix string

@export()
@description('What the application template needs to attach an identity and sign in with it.')
type identityInfo = {
  @description('Resource id, for the app\'s identity block and registry configuration.')
  id: string
  name: string
  @description('Client id, which the app passes as AZURE_CLIENT_ID.')
  clientId: string
  @description('Object id of the identity\'s service principal.')
  principalId: string
}

resource web 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${prefix}-id-web'
  location: location
  tags: tags
}

resource worker 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${prefix}-id-worker'
  location: location
  tags: tags
}

resource migrate 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${prefix}-id-migrate'
  location: location
  tags: tags
}

output web identityInfo = {
  id: web.id
  name: web.name
  clientId: web.properties.clientId
  principalId: web.properties.principalId
}

output worker identityInfo = {
  id: worker.id
  name: worker.name
  clientId: worker.properties.clientId
  principalId: worker.properties.principalId
}

output migrate identityInfo = {
  id: migrate.id
  name: migrate.name
  clientId: migrate.properties.clientId
  principalId: migrate.properties.principalId
}
