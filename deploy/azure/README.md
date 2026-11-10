# Azure templates

Status: the foundation written 8 November 2026 and the application 9 November 2026, and both
**never deployed**. The templates compile and pass the Bicep linter (Bicep CLI 0.49.2, with the
Microsoft Graph extension restored from the Microsoft Artifact Registry), but no part of them has
run against a real subscription. Read
[What is not confirmed](#what-is-not-confirmed) before you deploy.

These are the templates for running Clausewise inside a firm's own Azure tenant, as designed in
[docs/azure-in-tenant.md](../../docs/azure-in-tenant.md):

| Template     | What it is                                                          | State   |
| ------------ | ------------------------------------------------------------------- | ------- |
| `foundation` | Deployed once by the firm, with its own rights (design section 3.1) | Written |
| application  | `web`, `worker` and the `migrate` job; later the add-in host        | Written |
| delegation   | The optional Lighthouse delegation (design section 7)               | Not yet |

## What the foundation creates

Two resource groups, `<prefix>-foundation` and `<prefix>-application`, and in them:

| Resource                   | Settings that matter                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtual network            | Subnet `apps` (delegated to `Microsoft.App/environments`) and subnet `endpoints`, both without implicit outbound access                                                    |
| Network security groups    | Outbound from `apps` limited to the list below; inbound to `endpoints` limited to HTTPS from the network and PostgreSQL from `apps`                                        |
| Route table on `apps`      | `0.0.0.0/0` dropped; only the Container Apps platform service tags routed out                                                                                              |
| Private DNS zones          | Blob, Queue, PostgreSQL, Azure OpenAI and the registry, plus a zone for the environment's own domain, all linked to the network                                            |
| Log Analytics              | Workspace key access off                                                                                                                                                   |
| Application Insights       | Local authentication off: telemetry only with an Entra ID token                                                                                                            |
| Container Apps environment | Workload profiles (Consumption), internal, public network access off, logs through a diagnostic setting, traffic between apps encrypted                                    |
| PostgreSQL flexible server | Entra ID only (password authentication off, no local administrator), public access off, private endpoint, point-in-time restore, database `clausewise`                     |
| Storage for contracts      | Shared keys off, public access off, TLS 1.2, versioning, soft delete for blobs and containers, containers `contracts` and `results`, private endpoint for blob             |
| Storage for the queue      | Same hardening, queue `reviews`, private endpoint for queue                                                                                                                |
| Azure OpenAI               | Custom subdomain, keys off, public access off, private endpoint, one model deployment with automatic version upgrades off                                                  |
| Container Registry         | Premium, admin user and anonymous pull off, public access off, private endpoint, trusted Azure services allowed, one cache rule for Clausewise's images with no credential |
| Managed identities         | `web`, `worker`, `migrate`, in the application group                                                                                                                       |
| Role assignments           | The data roles below, on foundation resources                                                                                                                              |
| Entra ID app registration  | Single-page app, this directory only, no credential, one delegated scope `access_as_user`, assignment required                                                             |
| Azure Policy               | The four guardrails below, assigned to both resource groups                                                                                                                |

Container Apps also creates its own resource group, `<prefix>-apps-infrastructure`, for the
environment's load balancer and egress address. Do not change anything in it.

Not in the foundation yet: the Application Gateway option for access from outside the firm's
network (design section 3.4), Azure Monitor Private Link, Claude in Microsoft Foundry, diagnostic
settings for the data stores, and resource locks. The default address space leaves
`10.40.2.0/23` free for an Application Gateway subnet.

## Before you deploy

You need, in the firm's own tenant:

- **Owner** on the subscription. The template creates role assignments and policy definitions.
- **An Entra ID role that can create app registrations.** Azure Owner gives no rights in Entra
  ID. The Microsoft Graph extension deploys as the signed-in user with the delegated permission
  `Application.ReadWrite.All`, so the user needs a role such as Application Developer or Cloud
  Application Administrator. Assigning sign-in groups in the same deployment also needs
  `AppRoleAssignment.ReadWrite.All`; Cloud Application Administrator should cover it, which has
  not been tested.
- **An Entra ID security group for the PostgreSQL administrators,** and its object id and display
  name. There is no database password to fall back on.
- **Model quota** in the region for the model, version and deployment type you choose.
- **The Bicep CLI 0.36.1 or later** (`az bicep upgrade`), which the Microsoft Graph extension
  needs, and the Azure CLI signed in to the right tenant and subscription.

Assigning groups, rather than users, to an enterprise application needs Microsoft Entra ID P1 or
P2. Without it, assign users one by one.

## Deploy

```sh
cd deploy/azure/foundation
cp main.example.bicepparam main.bicepparam   # then replace every value in angle brackets

az login --tenant <tenant id>
az account set --subscription <subscription id>
az deployment sub create \
  --name clausewise-foundation \
  --location <region> \
  --template-file main.bicep \
  --parameters main.bicepparam
```

Redeploying the same template with the same parameters is meant to change nothing. Microsoft
says `what-if` and deployment stacks do not support Microsoft Graph resources, so a preview will
not show the app registration.

## After you deploy

1. **Let the firm's network in.** Users reach the environment through the virtual network
   (contracts are uploaded through the API, so browsers never reach Blob Storage), so the firm's
   network needs a route to it (peering, VPN or ExpressRoute) and DNS that resolves the
   environment's own domain. Forward that zone, listed in the `privateDnsZones` output, to Azure
   DNS, for example through an Azure DNS Private Resolver inbound endpoint in a peered network.
2. **Allow sign-in.** If no group was given in `signInGroupObjectIds`, assign one under
   Enterprise applications. If users may not consent to apps in the firm's tenant, an
   administrator grants consent once for the `access_as_user` scope, for example by opening
   `https://login.microsoftonline.com/<tenant id>/v2.0/adminconsent?client_id=<signInClientId>&scope=<signInClientId>/access_as_user&redirect_uri=<webUrl>`.
3. **Database roles.** Bicep cannot create roles inside PostgreSQL, so the foundation does not
   create them. The application's `migrate` job does, before its migrations: it signs in as its
   own identity, which the foundation makes an Entra administrator of the server, and calls
   `pgaadauth_create_principal` with the names of the `web` and `worker` identities, from the
   outputs, then grants each only what it needs. Only an Entra administrator may call that
   function, which is why `migrate` is one.
4. **Check the model.** Run the evaluation harness against the deployed model before anyone
   relies on it (design section 8).

## Outbound network rules

The design says the network refuses outbound internet. Container Apps itself cannot run that way:
its nodes fetch system containers and binaries and sign in through Microsoft services with public
addresses. So the `apps` subnet can reach exactly those services and nothing else. The list comes
from Microsoft Learn, "Securing a virtual network in Azure Container Apps"
([firewall-integration](https://learn.microsoft.com/azure/container-apps/firewall-integration)),
workload profiles tab, and "Azure Container Apps environment integration with Azure Firewall"
([use-azure-firewall](https://learn.microsoft.com/azure/container-apps/use-azure-firewall)).

Network security group on `apps`, outbound:

| Priority | Destination                  | Ports         | Why                                                                                                    |
| -------- | ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| 100      | The `apps` subnet            | any           | Required by Container Apps: nodes, the internal load balancer and replicas talk inside the subnet      |
| 110      | The `endpoints` subnet       | TCP 443, 5432 | Blob, Queue, Azure OpenAI and the registry over HTTPS; PostgreSQL                                      |
| 120      | `168.63.129.16`              | 53            | Azure DNS. Microsoft says never to deny it                                                             |
| 200      | `MicrosoftContainerRegistry` | TCP 443       | Microsoft Artifact Registry, for the platform's system containers                                      |
| 210      | `AzureFrontDoor.FirstParty`  | TCP 443       | Listed by Microsoft as a dependency of `MicrosoftContainerRegistry`                                    |
| 220      | `AzureActiveDirectory`       | TCP 443       | Managed identity tokens                                                                                |
| 230      | `AzureMonitor`               | TCP 443       | The environment's logs and the apps' telemetry                                                         |
| 4096     | any                          | any           | Deny. Above the default rules, so neither the internet nor the rest of the firm's network is reachable |

Route table on `apps`: `0.0.0.0/0` to next hop None, and one route per service tag above to next
hop Internet. Routes to the virtual network, peered networks and the firm's network (through a
gateway) are more specific and still work. Gateway route propagation stays on so that replies to
users on the firm's network find their way back; a default route the firm advertises over BGP
loses to the user-defined one.

Deliberately absent:

- **`AzureContainerRegistry` and `Storage.<region>`.** Microsoft lists them for pulling from
  Container Registry over its public endpoint. Here the registry is reached through its private
  endpoint, and Microsoft says no rule is needed then.
- **`packages.aks.azure.com` and `acs-mirror.azureedge.net`.** The firewall page lists them for
  every scenario, but as an alternative to the network rules for Microsoft Artifact Registry,
  which are the two service tags above.
- **NTP (UDP 123).** Listed for Consumption-only environments, not for workload profiles.

What this does not stop: `AzureMonitor` and `AzureActiveDirectory` are services every Azure
tenant shares. A hostile release could send data to another tenant's Application Insights
through the `AzureMonitor` rule. Closing that needs Azure Monitor Private Link with ingestion
limited to private access, or an Azure Firewall with FQDN rules in place of the service tags.
Neither is in the foundation yet.

## PostgreSQL

The server is reached through a private endpoint rather than a subnet delegated to it. That keeps
one pattern for every data store (same subnet, same network security group), makes
`publicNetworkAccess: Disabled` explicit, needs no subnet for the server alone, and lets the
firm add endpoints in other networks without peering. The network mode is chosen when the server
is created.

Authentication is Entra ID only. The Entra administrators are the group you name and the
`migrate` identity (see [After you deploy](#after-you-deploy), step 3). Backups are kept for
`postgresBackupRetentionDays` days (7 to 35), and the server can be restored to any moment in
that period.

## Roles

| Identity  | Role                                    | On                                       |
| --------- | --------------------------------------- | ---------------------------------------- |
| `web`     | Storage Blob Data Contributor           | The `contracts` and `results` containers |
| `web`     | Storage Queue Data Message Sender       | The queue storage account                |
| `web`     | Monitoring Metrics Publisher            | Application Insights                     |
| `worker`  | Storage Blob Data Contributor           | The `contracts` and `results` containers |
| `worker`  | Clausewise review queue worker (custom) | The queue storage account                |
| `worker`  | Cognitive Services OpenAI User          | The Azure OpenAI account                 |
| `worker`  | Monitoring Metrics Publisher            | Application Insights                     |
| all three | AcrPull                                 | The registry                             |
| `migrate` | Entra administrator (not Azure RBAC)    | The PostgreSQL server                    |

The blob roles are on the two containers, not the account, so that neither identity can create or
delete containers. Contracts are uploaded through the API rather than straight from the browser,
because Blob Storage has no public endpoint and a browser outside the firm's network could not
reach it, so no identity signs upload links and none holds Storage Blob Delegator.

The worker hands a job back to the queue early (when the review is busy elsewhere, when the
worker is stopping, or when storage or the database failed) by making its message visible again,
which Azure Storage authorizes as `messages/write`. Storage Queue Data Message Processor does not
include that, and Storage Queue Data Contributor would also let the worker create and delete
queues, so the foundation defines a custom role with the Message Processor's data actions plus
`messages/write`, assignable only in the foundation group. Creating it needs
`Microsoft.Authorization/roleDefinitions/write`, which Owner has.

## Policy guardrails

Assigned to both resource groups, each with effect Deny (design section 7.2):

| Guardrail                                     | Definition                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No key access to the model service            | Built-in `71ef260a-8f18-47b7-abcb-62d0673d94dc`, "Azure AI Services resources should have key access disabled (disable local authentication)"                                |
| No shared-key access to storage               | Built-in `8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54`, "Storage accounts should prevent shared key access"                                                                         |
| PostgreSQL accepts only Entra ID sign-in      | Custom, [policies/postgres-entra-only.json](foundation/policies/postgres-entra-only.json). The built-in `fa498b91-8a7e-4710-9578-da944c68d1fe` is preview and Audit only     |
| Images only from the firm registry, by digest | Custom, [policies/container-images-from-registry.json](foundation/policies/container-images-from-registry.json), for container apps and jobs, containers and init containers |

The custom definitions are created in the subscription, under the names
`clausewise-postgres-entra-only` and `clausewise-images-from-registry`.

## Outputs

Everything the application template needs, none of it secret: the two resource group names; the
environment's id, default domain, static address and workload profile; the web app's name and
address; the registry login server and image prefix; each identity's resource id, name, client id
and object id; the PostgreSQL host name and database; the storage account names, endpoints,
container names and queue name; the Azure OpenAI endpoint, the v1 base URL (`CLAUSEWISE_BASE_URL`)
and the deployment name (`CLAUSEWISE_MODEL`); the Application Insights connection string (an
address only, since local authentication is off); the Log Analytics workspace; and the sign-in
client id and API scope.

## Application settings

The web app, the worker and the migrate job read these environment variables. All three are
Container Apps resources in the application group, each with its own user-assigned identity.
Container Apps sets `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` itself once an identity is
assigned; none of the values below is a secret.

| Variable                         | Output                               | Web | Worker | Migrate |
| -------------------------------- | ------------------------------------ | --- | ------ | ------- |
| `AZURE_CLIENT_ID`                | `clientId` of the app's own identity | yes | yes    | yes     |
| `CLAUSEWISE_POSTGRES_HOST`       | `postgresServerFqdn`                 | yes | yes    | yes     |
| `CLAUSEWISE_POSTGRES_DATABASE`   | `postgresDatabaseName`               | yes | yes    | yes     |
| `CLAUSEWISE_POSTGRES_USER`       | `name` of the app's own identity     | yes | yes    | yes     |
| `CLAUSEWISE_BLOB_ENDPOINT`       | `contractsBlobEndpoint`              | yes | yes    |         |
| `CLAUSEWISE_CONTRACTS_CONTAINER` | `contractsContainerName`             | yes | yes    |         |
| `CLAUSEWISE_RESULTS_CONTAINER`   | `resultsContainerName`               | yes | yes    |         |
| `CLAUSEWISE_QUEUE_ENDPOINT`      | `queueEndpoint`                      | yes | yes    |         |
| `CLAUSEWISE_QUEUE_NAME`          | `reviewQueueName`                    | yes | yes    |         |
| `CLAUSEWISE_WEB_MODE`            | `azure`                              | yes |        |         |
| `CLAUSEWISE_ENTRA_TENANT_ID`     | `tenantId`                           | yes |        |         |
| `CLAUSEWISE_ENTRA_CLIENT_ID`     | `signInClientId`                     | yes |        |         |
| `CLAUSEWISE_PROVIDER`            | `azure-openai`                       |     | yes    |         |
| `CLAUSEWISE_BASE_URL`            | `openAiBaseUrl`                      |     | yes    |         |
| `CLAUSEWISE_MODEL`               | `openAiDeploymentName`               |     | yes    |         |
| `CLAUSEWISE_WEB_ROLE`            | `webIdentity.name`                   |     |        | yes     |
| `CLAUSEWISE_WORKER_ROLE`         | `workerIdentity.name`                |     |        | yes     |

The web app listens on port 8080 unless `PORT` says otherwise. Run `migrate` before the web app
and the worker are first started, and again before each release; it is safe to run twice.

## Deploy the application

The application template, `application/main.bicep`, deploys into the application group and needs
roles on that group only. It takes the foundation's outputs as one parameter, and the digest of a
release of the server image, which the web app, the worker and the migrate job all run.

1. **Collect the foundation's outputs,** none of which is secret, once per foundation deployment.
   A provider with delegated management cannot read the subscription's deployments, so the firm
   sends it this file.

   ```sh
   az deployment sub show --name clausewise-foundation --query properties.outputs --output json \
     | jq '{"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#", contentVersion: "1.0.0.0", parameters: {foundation: {value: with_entries(.value |= .value)}}}' \
     > foundation.parameters.json
   ```

2. **Deploy a release.**

   ```sh
   az deployment group create \
     --name clausewise-application \
     --resource-group <applicationResourceGroupName> \
     --template-file application/main.bicep \
     --parameters @foundation.parameters.json \
     --parameters imageDigest=sha256:<digest of the release's server image>
   ```

3. **Run the migrate job** and wait until its execution has succeeded. Until it has run once, the
   web app answers API requests with an error, because the database has no tables.

   ```sh
   az containerapp job start --name migrate --resource-group <applicationResourceGroupName>
   az containerapp job execution list --name migrate --resource-group <applicationResourceGroupName> --output table
   ```

4. **Open the app** at the `webUrl` output. It should be the foundation's `webUrl`, which sign-in
   redirects to.

**Upgrading.** Migrations follow expand-then-contract (design section 8), so the running release
keeps working on the new schema. Upgrade in two deployments: first with `migrateImageDigest` set to
the new release and `imageDigest` left at the running one, then run the migrate job; then again
with `imageDigest` set to the new release and `migrateImageDigest` left out. In single revision
mode Container Apps keeps the old web revision serving until the new one passes its probes. An
old worker that is stopped hands its review back to the queue, and a new one takes it.

**The image.** No release is published yet. The image builds from the repository root with
`docker build --tag clausewise-server .`. Releases are to be published as
`<upstreamImageRepository>/server`, which the foundation's cache rule maps to
`<registryImagePrefix>/server`; the digest a release publishes is the `imageDigest` to deploy.
The image holds Node.js, the bundled server and its third-party notices, and nothing else: no
shell, no package manager. It runs as a non-root user and writes nothing to its file system.

## What is not confirmed

Checked against Microsoft's documentation or the Azure Policy repository, but not by a
deployment:

- **The outbound rules are enough.** They follow Microsoft's published list, but the route table
  that drops `0.0.0.0/0` (next hop None) and sends only service tags out is not a pattern Microsoft
  documents for Container Apps, which describes a firewall as the next hop. Phase 1 must show the
  environment starts, pulls images and gets tokens, and that the worker cannot reach anything
  else. Whether `AzureFrontDoor.FirstParty` is accepted as a route prefix is not confirmed.
- **Subnets without default outbound access** (`defaultOutboundAccess: false`) for the Container
  Apps subnet. Container Apps says its egress goes through a load balancer it creates, which
  should not need it.
- **Policy aliases.** `Microsoft.App/containerApps/template.containers[*].image`,
  `Microsoft.App/containerApps/template.initContainers[*].image`,
  `Microsoft.App/jobs/template.containers[*].image` and
  `Microsoft.App/jobs/template.initContainers[*].image` were not found in any built-in policy.
  They follow the naming of `Microsoft.App/containerApps/template.volumes[*]`, which a built-in
  uses. An alias that does not exist makes the deployment fail when the definition is created,
  so it cannot pass silently. Check with
  `az provider show --namespace Microsoft.App --expand "resourceTypes/aliases" --query "resourceTypes[?resourceType=='jobs'].aliases[].name"`.
  The other aliases are taken from built-in definitions: `authConfig.activeDirectoryAuth` and
  `authConfig.passwordAuth` for PostgreSQL, `allowSharedKeyAccess` for storage,
  `disableLocalAuth` for Azure AI services.
- **The registry cache.** That a wildcard cache rule can be created through Azure Resource
  Manager, that a first pull by digest fills the cache, and whether the trusted-services bypass
  is needed (design open question 2). No Clausewise image is published yet, so the upstream path
  in the example is where images are expected, not where they are.
- **Sign-in.** That the web interface can ask for `<client id>/access_as_user` without an
  application ID URI (the template cannot set `api://<client id>` in the same deployment that
  creates the id), and that an internal environment serves its default domain with a certificate
  browsers trust.
- **Queue scaling.** If the worker scales on queue length with its own identity, the scaler reads
  the queue's message count, which needs `Microsoft.Storage/storageAccounts/queueServices/queues/read`.
  The worker's role does not include it, so the application template runs a fixed number of
  workers for now.
- **The worker's queue role.** Microsoft's table of data operations lists `messages/write` for
  Update Message and `messages/process/action` for Get Messages and Delete Message; no deployment
  has confirmed the custom role is enough.
- **API versions** were chosen from those the Bicep type index knows, and Bicep checked every
  property name and type against them. It cannot check enumerated values, such as next hop types,
  deployment types or `azure-monitor` as a log destination; those were checked by reading, not by
  a tool.
- **The application's roles.** That Container Apps Contributor, Container Apps Jobs Contributor
  and Managed Identity Operator on the application group are enough to deploy the application
  template: to create the apps and the job, join them to the environment and attach the
  foundation's identities.
- **Ingress in an internal environment.** That `external: true` makes the web app reachable from
  the virtual network and the networks peered with it, at the foundation's `webUrl`, and from
  nowhere else.
- **Log Analytics with local authentication off** still accepts diagnostic settings. Microsoft
  lists only agents and the Data Collector API as affected.

## Open points for the later templates

- **Migrations are started by hand.** A deployment cannot wait for a job to finish without a
  deployment script, which would need a storage account with shared keys and outbound access, so
  the migrate job is started between deployments, by a person or a release pipeline.

- **Settled: the environment is in the application group.** Creating or updating a container
  app or job needs `Microsoft.App/managedEnvironments/join/action` on the environment, and a
  delegated provider holds roles on the application group only. Container Apps Contributor can
  join an environment but not change it, so its network settings stay as the firm deployed them.
- **Settled: uploads go through the API.** Blob Storage has no public endpoint, so a browser
  outside the firm's network could not upload to it directly, and the Application Gateway option
  (design section 3.4) would have had to carry Blob traffic too.
