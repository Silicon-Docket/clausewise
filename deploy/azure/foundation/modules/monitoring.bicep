// Log Analytics and Application Insights, inside the firm's tenant.

param location string
param tags { *: string }
param prefix string

@minValue(30)
@maxValue(730)
param retentionInDays int

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      // The workspace accepts data only through Entra ID and Azure Monitor's own pipeline, not
      // with the shared workspace key. That is why the Container Apps environment sends its logs
      // through a diagnostic setting rather than with the key.
      disableLocalAuth: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appinsights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    // Telemetry is accepted only with an Entra ID token, so the instrumentation key in the
    // connection string is an address, not a credential. The apps send with their managed
    // identities, which hold Monitoring Metrics Publisher on this component.
    DisableLocalAuth: true
  }
}

output workspaceId string = workspace.id
output appInsightsName string = appInsights.name
output appInsightsId string = appInsights.id
output appInsightsConnectionString string = appInsights.properties.ConnectionString
