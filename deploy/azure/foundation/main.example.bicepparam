// Example parameters for the foundation. Copy this file to main.bicepparam next to it, replace
// every value in angle brackets, and deploy with the command in deploy/azure/README.md.
// Nothing here is a secret: the foundation takes no password or key anywhere.

using './main.bicep'

param prefix = 'cw'

// Pick address ranges that do not overlap the firm's other networks.
param vnetAddressPrefix = '10.40.0.0/22'
param containerAppsSubnetPrefix = '10.40.0.0/24'
param privateEndpointSubnetPrefix = '10.40.1.0/26'

// An existing Entra ID security group for the database administrators.
param postgresAdminGroupObjectId = '<object id of the PostgreSQL administrators group>'
param postgresAdminGroupName = '<display name of that group>'

// A model and version the region offers for the deployment type. Run the evaluation harness
// against it before anyone relies on it (docs/azure-in-tenant.md, section 8).
param openAiModelName = 'gpt-4.1'
param openAiModelVersion = '2025-04-14'
param openAiDeploymentSku = 'DataZoneStandard'
param openAiDeploymentCapacity = 50

// Where Clausewise's release images are published.
param upstreamImageRepository = 'ghcr.io/silicon-docket/clausewise'

// Empty: users sign in at the web app's own address in the environment,
// https://web.<environment default domain>/. For a custom domain, or to add the Word add-in's
// sign-in page, list every address here, the web interface's included, such as
// 'https://clausewise.example.com/'.
param spaRedirectUris = []

// Groups whose members may sign in. Can be left empty and assigned later.
param signInGroupObjectIds = []
