# @clausewise/azure

The Azure storage behind the review service: the `BlobStore`, `JobQueue` and `ReviewRecords`
of `@clausewise/service`, over Azure Blob Storage, an Azure Storage queue and Azure Database for
PostgreSQL. Every one signs in with the app's managed identity. There is no key, connection
string or database password anywhere.

| Adapter             | Talks to                                 | Signs in with                                                                               |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `azureBlobStore`    | One Blob Storage container, over REST    | A token for `https://storage.azure.com`, as a bearer token                                  |
| `azureStorageQueue` | One storage queue, over REST             | The same                                                                                    |
| `postgresRecords`   | The `reviews` table, through a `pg` pool | A token for `https://ossrdbms-aad.database.windows.net`, as the password, over verified TLS |

Blob and queue use the REST API directly (version `2023-11-03`) rather than the Azure SDK, so the
package adds two small dependencies: `pg` and `@xmldom/xmldom`. Errors name the operation, the
HTTP status and Azure's error code, never a token, a response body or a file. Redirects are
refused.

`migrate` brings the database up to date in one transaction under an advisory lock, so two
migrate jobs cannot both run, and grants each app role only what it needs: in the foundation
template's terms, `web` gets `SELECT`, `INSERT` and `UPDATE` on `reviews`, and `worker` gets
`SELECT` and `UPDATE`. With `createEntraPrincipals` it first creates each role as an Entra
principal with `pgaadauth_create_principal`, which only an Entra administrator can call; the
`migrate` identity is one (`deploy/azure/README.md`).

## Tests

The Blob and Queue tests run against a scripted network and need nothing. The records contract
runs against the in-memory store always, and against PostgreSQL when
`CLAUSEWISE_TEST_POSTGRES_URL` names a database owned by `clausewise_migrate`, on a server with
login roles `clausewise_web` and `clausewise_worker`:

```sh
psql -c "CREATE ROLE clausewise_migrate LOGIN" \
     -c "CREATE ROLE clausewise_web LOGIN" \
     -c "CREATE ROLE clausewise_worker LOGIN" \
     -c "CREATE DATABASE clausewise_test OWNER clausewise_migrate"
CLAUSEWISE_TEST_POSTGRES_URL=postgresql://127.0.0.1:5432/clausewise_test pnpm vitest run packages/azure
```

The tests drop and recreate the tables in that database, so use one that holds nothing else.
