// Azure Database for PostgreSQL flexible server: Entra ID sign-in only, no public access,
// point-in-time restore.
//
// Private access is through a private endpoint, not through a subnet delegated to the server
// (VNet integration). Reasons: it is the same pattern as every other data store here, in the
// same subnet under the same network security group; publicNetworkAccess is an explicit
// Disabled that policy and reviewers can read; no subnet has to be set aside for the server
// alone; and the firm can add endpoints in other networks (a hub, say) without peering. The
// network mode is chosen when the server is created, so it is worth choosing once.

param name string
param location string
param tags { *: string }

param version string
param skuName string
param skuTier string
param storageSizeGB int
param backupRetentionDays int
param geoRedundantBackup bool
param highAvailabilityMode string

param databaseName string

@description('Object id of the Entra ID group whose members administer the server.')
param adminGroupObjectId string

@description('Display name of that group, exactly as Entra ID shows it.')
param adminGroupName string

@description('Principal id (object id) of the migrate job identity.')
param migratePrincipalId string

@description('Name of the migrate job identity.')
param migrateIdentityName string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: version
    createMode: 'Default'
    // No administratorLogin and no password: with password authentication disabled the server
    // has no local administrator to set one for.
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    network: {
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    // Point-in-time restore is to any moment within the retention period.
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource adminGroup 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: server
  name: adminGroupObjectId
  properties: {
    principalType: 'Group'
    principalName: adminGroupName
    tenantId: tenant().tenantId
  }
  // The server applies one change at a time, so these run one after another.
  dependsOn: [
    database
  ]
}

// The migrate job creates the database roles for the web and worker identities with
// pgaadauth_create_principal, which only an Entra administrator of the server may call. Bicep
// cannot create those roles: they live inside the database, not in Azure Resource Manager.
resource adminMigrate 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: server
  name: migratePrincipalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: migrateIdentityName
    tenantId: tenant().tenantId
  }
  dependsOn: [
    adminGroup
  ]
}

output id string = server.id
output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
