// The guardrails of design section 7.2, assigned to one resource group. The foundation assigns
// them to both of its groups. A provider with delegated management cannot change or remove a
// policy assignment, so these hold whatever it deploys into the application group.

param postgresPolicyDefinitionId string
param imagePolicyDefinitionId string
param registryLoginServer string

// Built-in definitions, from github.com/Azure/azure-policy (built-in-policies/policyDefinitions):
// "Azure AI Services resources should have key access disabled (disable local authentication)"
// (Azure Ai Services/DisableLocalAuth_Audit.json) and "Storage accounts should prevent shared
// key access" (Storage/StorageAccountAllowSharedKeyAccess_Audit.json). Both accept Deny.
var aiServicesKeyAccessDisabled = '71ef260a-8f18-47b7-abcb-62d0673d94dc'
var storageSharedKeyAccessDisabled = '8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54'

resource noModelKeys 'Microsoft.Authorization/policyAssignments@2025-03-01' = {
  name: 'clausewise-no-ai-keys'
  properties: {
    displayName: 'Clausewise: no key access to the model service'
    policyDefinitionId: tenantResourceId('Microsoft.Authorization/policyDefinitions', aiServicesKeyAccessDisabled)
    enforcementMode: 'Default'
    parameters: {
      effect: {
        value: 'Deny'
      }
    }
    nonComplianceMessages: [
      {
        message: 'Clausewise guardrail: Azure AI services accounts here must have disableLocalAuth set to true.'
      }
    ]
  }
}

resource noStorageKeys 'Microsoft.Authorization/policyAssignments@2025-03-01' = {
  name: 'clausewise-no-storage-keys'
  properties: {
    displayName: 'Clausewise: no shared-key access to storage'
    policyDefinitionId: tenantResourceId('Microsoft.Authorization/policyDefinitions', storageSharedKeyAccessDisabled)
    enforcementMode: 'Default'
    parameters: {
      effect: {
        value: 'Deny'
      }
    }
    nonComplianceMessages: [
      {
        message: 'Clausewise guardrail: storage accounts here must have allowSharedKeyAccess set to false.'
      }
    ]
  }
}

resource postgresEntraOnly 'Microsoft.Authorization/policyAssignments@2025-03-01' = {
  name: 'clausewise-postgres-entra-only'
  properties: {
    displayName: 'Clausewise: PostgreSQL accepts only Entra ID sign-in'
    policyDefinitionId: postgresPolicyDefinitionId
    enforcementMode: 'Default'
    parameters: {
      effect: {
        value: 'Deny'
      }
    }
    nonComplianceMessages: [
      {
        message: 'Clausewise guardrail: PostgreSQL flexible servers here must have Entra authentication enabled and password authentication disabled.'
      }
    ]
  }
}

resource imagesFromRegistry 'Microsoft.Authorization/policyAssignments@2025-03-01' = {
  name: 'clausewise-images-by-digest'
  properties: {
    displayName: 'Clausewise: images only from the firm registry, by digest'
    policyDefinitionId: imagePolicyDefinitionId
    enforcementMode: 'Default'
    parameters: {
      loginServer: {
        value: registryLoginServer
      }
      effect: {
        value: 'Deny'
      }
    }
    nonComplianceMessages: [
      {
        message: 'Clausewise guardrail: every container image must be ${registryLoginServer}/<repository>@sha256:<digest>.'
      }
    ]
  }
}
