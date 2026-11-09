import {
  POSTGRES_RESOURCE,
  SettingsError,
  azurePostgresPool,
  migrate,
  readIdentity,
  readPostgres,
} from "@clausewise/azure";
import { createManagedIdentityTokenSource } from "@clausewise/llm";

type Env = Record<string, string | undefined>;

const ROLE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

function role(env: Env, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") throw new SettingsError(`Missing settings: ${name}.`);
  if (!ROLE.test(value)) throw new SettingsError(`${name} is not a role name.`);
  return value;
}

/**
 * The migrate job: signs in to PostgreSQL as the migrate identity, which the foundation template
 * makes an Entra administrator, brings the database up to date, creates the web and worker
 * identities as Entra principals if they are not yet, and grants each only what it needs.
 * Returns the migrations it applied.
 */
export async function runMigrate(options: {
  env: Env;
  fetch?: typeof globalThis.fetch;
}): Promise<number[]> {
  const identity = readIdentity(options.env);
  const postgres = readPostgres(options.env);
  const web = role(options.env, "CLAUSEWISE_WEB_ROLE");
  const worker = role(options.env, "CLAUSEWISE_WORKER_ROLE");

  const tokens = createManagedIdentityTokenSource(identity, {
    resource: POSTGRES_RESOURCE,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const pool = azurePostgresPool({ ...postgres, tokens, max: 1 });
  try {
    return await migrate(pool, {
      createEntraPrincipals: true,
      appRoles: [
        { name: web, privileges: ["SELECT", "INSERT", "UPDATE"] },
        { name: worker, privileges: ["SELECT", "UPDATE"] },
      ],
    });
  } finally {
    await pool.end();
  }
}
