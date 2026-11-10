// The Entra ID app registration that users sign in with, created in the firm's own directory.
//
// It is a single-page app: the browser signs in with MSAL and PKCE, a public-client flow that
// needs no client secret, so the registration has no credential of any kind. The same
// registration exposes the one delegated scope the API checks for in the tokens it accepts.

extension microsoftGraphV1

@description('Unique key for the registration within the directory. Immutable once created.')
param uniqueName string

param displayName string

@description('Redirect URIs of the web interface and the Word add-in sign-in page. HTTPS only.')
param spaRedirectUris string[]

@description('Object ids of the Entra ID groups allowed to sign in.')
param signInGroupObjectIds string[]

@description('A fixed GUID for the access_as_user scope. Changing it on an existing registration fails unless the old scope is disabled first.')
param accessScopeId string

resource application 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: uniqueName
  displayName: displayName
  // Users of the firm's own directory only.
  signInAudience: 'AzureADMyOrg'
  spa: {
    redirectUris: spaRedirectUris
  }
  // The implicit flow stays off: tokens come from the authorization code flow with PKCE only.
  web: {
    implicitGrantSettings: {
      enableAccessTokenIssuance: false
      enableIdTokenIssuance: false
    }
  }
  api: {
    // Version 2 tokens carry the application id as their audience, so the API can check it
    // without an application ID URI, which this template cannot set on the first deployment
    // because the id is not known until the registration exists.
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: accessScopeId
        value: 'access_as_user'
        type: 'User'
        isEnabled: true
        adminConsentDisplayName: 'Use Clausewise'
        adminConsentDescription: 'Lets the Clausewise web interface and Word add-in call the Clausewise API as the signed-in user.'
        userConsentDisplayName: 'Use Clausewise'
        userConsentDescription: 'Lets Clausewise call its API as you.'
      }
    ]
  }
}

resource servicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: application.appId
  // Only users and groups assigned to the app can sign in (design section 2, access by Entra
  // groups). With no group assigned below, nobody can until the firm assigns one.
  appRoleAssignmentRequired: true
}

// The default access role (the all-zeros id) is the one to use for an app that defines no app
// roles of its own.
resource groupAssignments 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [
  for groupId in signInGroupObjectIds: {
    appRoleId: '00000000-0000-0000-0000-000000000000'
    principalId: groupId
    resourceId: servicePrincipal.id
  }
]

output clientId string = application.appId
output servicePrincipalId string = servicePrincipal.id
output accessScope string = '${application.appId}/access_as_user'
