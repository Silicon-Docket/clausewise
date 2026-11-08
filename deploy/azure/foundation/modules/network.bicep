// The virtual network, and the rules that keep the application from reaching the internet.
//
// Two layers do the same job on purpose. The network security group refuses every outbound
// connection that is not on its allow list, and the route table drops every packet that is not
// headed for the virtual network or one of the Azure services Container Apps itself depends on.
// Either one alone would stop a release from sending a contract to an address of its choosing;
// together a mistake in one of them is not enough.

param location string
param tags { *: string }
param prefix string

param vnetAddressPrefix string
param containerAppsSubnetPrefix string
param privateEndpointSubnetPrefix string

// Microsoft's list of what a Container Apps environment on workload profiles needs outbound is in
// "Securing a virtual network in Azure Container Apps" (firewall-integration). Each service tag
// in it is allowed by the network security group below and routed to Azure's own network by the
// route table. Only those four tags are reachable; the README says what each one is for.

// The Azure DNS resolver. Microsoft says never to deny it explicitly, so it is allowed by name,
// although NSGs do not filter it unless the AzurePlatformDNS tag is used.
var azureDnsAddress = '168.63.129.16'

resource containerAppsNsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: '${prefix}-nsg-apps'
  location: location
  tags: tags
  properties: {
    // Inbound keeps the default rules: they admit the virtual network (which includes networks
    // peered to it and the firm's own network behind a gateway) and the Azure load balancer's
    // health probes, and refuse everything else. The environment is internal, so nothing on the
    // internet can reach it in any case.
    securityRules: [
      {
        // Required by Container Apps: the nodes, the environment's internal load balancer and the
        // app replicas talk to one another inside the subnet.
        name: 'allow-within-apps-subnet'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: containerAppsSubnetPrefix
          destinationPortRange: '*'
        }
      }
      {
        // Every data store and the model service are reached through private endpoints in one
        // subnet: HTTPS for Blob, Queue, Azure OpenAI and the registry, 5432 for PostgreSQL.
        name: 'allow-private-endpoints'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: privateEndpointSubnetPrefix
          destinationPortRanges: [
            '443'
            '5432'
          ]
        }
      }
      {
        name: 'allow-azure-dns'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: azureDnsAddress
          destinationPortRange: '53'
        }
      }
      {
        // Microsoft Artifact Registry, for the platform's system containers.
        name: 'allow-microsoft-container-registry'
        properties: {
          priority: 200
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: 'MicrosoftContainerRegistry'
          destinationPortRange: '443'
        }
      }
      {
        // Microsoft lists it as a dependency of MicrosoftContainerRegistry.
        name: 'allow-azure-front-door-first-party'
        properties: {
          priority: 210
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureFrontDoor.FirstParty'
          destinationPortRange: '443'
        }
      }
      {
        // Entra ID, where the managed identities get their tokens.
        name: 'allow-entra-id'
        properties: {
          priority: 220
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureActiveDirectory'
          destinationPortRange: '443'
        }
      }
      {
        // Azure Monitor, for the environment's logs and the apps' telemetry.
        name: 'allow-azure-monitor'
        properties: {
          priority: 230
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureMonitor'
          destinationPortRange: '443'
        }
      }
      {
        // Placed above the default AllowVnetOutBound and AllowInternetOutBound rules, so that
        // neither the internet nor the rest of the firm's network (where an outbound proxy might
        // live) can be reached from the apps.
        name: 'deny-all-other-outbound'
        properties: {
          priority: 4096
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource containerAppsRoutes 'Microsoft.Network/routeTables@2025-05-01' = {
  name: '${prefix}-routes-apps'
  location: location
  tags: tags
  properties: {
    // Gateway routes stay on: without them, replies to users on the firm's own network (VPN or
    // ExpressRoute) would match the drop route below and never arrive. A default route the firm
    // advertises over BGP loses to the user-defined one, so it cannot reopen the internet.
    disableBgpRoutePropagation: false
    // A service tag as the prefix of a route needs no address list kept up to date, and its
    // prefixes are more specific than 0.0.0.0/0, so they win over the drop route. Next hop
    // Internet keeps traffic to Azure's public service addresses on Microsoft's network.
    routes: [
      {
        // Next hop None drops the packet. Destinations in the virtual network, peered networks
        // and the firm's network keep their more specific system and gateway routes.
        name: 'drop-everything-else'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'None'
        }
      }
      {
        name: 'to-microsoft-container-registry'
        properties: {
          addressPrefix: 'MicrosoftContainerRegistry'
          nextHopType: 'Internet'
        }
      }
      {
        name: 'to-azure-front-door-first-party'
        properties: {
          addressPrefix: 'AzureFrontDoor.FirstParty'
          nextHopType: 'Internet'
        }
      }
      {
        name: 'to-entra-id'
        properties: {
          addressPrefix: 'AzureActiveDirectory'
          nextHopType: 'Internet'
        }
      }
      {
        name: 'to-azure-monitor'
        properties: {
          addressPrefix: 'AzureMonitor'
          nextHopType: 'Internet'
        }
      }
    ]
  }
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: '${prefix}-nsg-endpoints'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        // HTTPS from the whole virtual network, not only the apps: browsers on the firm's network
        // upload contracts straight to Blob Storage with a user delegation SAS.
        name: 'allow-https-from-virtual-network'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: privateEndpointSubnetPrefix
          destinationPortRange: '443'
        }
      }
      {
        // Only the apps talk to PostgreSQL. Database administrators who need a session can add
        // a rule for their own network, or work through the migrate job.
        name: 'allow-postgres-from-apps'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: containerAppsSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: privateEndpointSubnetPrefix
          destinationPortRange: '5432'
        }
      }
      {
        name: 'deny-all-other-inbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          // Workload profile environments need the subnet delegated to Microsoft.App/environments.
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          networkSecurityGroup: {
            id: containerAppsNsg.id
          }
          routeTable: {
            id: containerAppsRoutes.id
          }
          // No implicit outbound address. The environment's own egress goes through the load
          // balancer Container Apps creates in its managed resource group.
          defaultOutboundAccess: false
        }
      }
      {
        name: 'endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          networkSecurityGroup: {
            id: privateEndpointNsg.id
          }
          // Without this, network security groups do not apply to private endpoints.
          privateEndpointNetworkPolicies: 'Enabled'
          defaultOutboundAccess: false
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output containerAppsSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
