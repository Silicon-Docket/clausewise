import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsError } from "@clausewise/azure";
import { createOracleGenerator } from "@clausewise/review/testing";
import { startAzureWeb } from "@clausewise/web";
import { describe, expect, it } from "vitest";
import { runMigrate, startAzureWorker } from "../src/index.js";

// Each entry point reads and checks every setting before it connects to anything, so these need
// no Azure and no network: a fetch that fails the test proves nothing was attempted.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const noNetwork = (async () => {
  throw new Error("nothing may be fetched before the settings are checked");
}) as typeof globalThis.fetch;

const complete = {
  IDENTITY_ENDPOINT: "http://localhost:42356/msi/token",
  IDENTITY_HEADER: "header",
  AZURE_CLIENT_ID: "0a0a0a0a-1111-4222-8333-444444444444",
  CLAUSEWISE_BLOB_ENDPOINT: "https://contosolegal.blob.core.windows.net/",
  CLAUSEWISE_CONTRACTS_CONTAINER: "contracts",
  CLAUSEWISE_RESULTS_CONTAINER: "results",
  CLAUSEWISE_QUEUE_ENDPOINT: "https://contosoqueue.queue.core.windows.net/",
  CLAUSEWISE_QUEUE_NAME: "reviews",
  CLAUSEWISE_POSTGRES_HOST: "contoso-pg.postgres.database.azure.com",
  CLAUSEWISE_POSTGRES_DATABASE: "clausewise",
  CLAUSEWISE_POSTGRES_USER: "clausewise-id-worker",
};

describe("the worker", () => {
  it("names a missing setting and starts nothing", () => {
    const { CLAUSEWISE_QUEUE_ENDPOINT: _, ...rest } = complete;
    expect(() =>
      startAzureWorker({
        env: rest,
        playbooksDir: join(ROOT, "playbooks"),
        generator: createOracleGenerator({}),
        fetch: noNetwork,
      }),
    ).toThrow(new SettingsError("Missing settings: CLAUSEWISE_QUEUE_ENDPOINT."));
  });

  it("needs the model settings when no model is given", () => {
    expect(() =>
      startAzureWorker({ env: complete, playbooksDir: join(ROOT, "playbooks"), fetch: noNetwork }),
    ).toThrow(/ANTHROPIC_API_KEY|CLAUSEWISE_/);
  });
});

describe("the migrate job", () => {
  it.each(["CLAUSEWISE_WEB_ROLE", "CLAUSEWISE_WORKER_ROLE"])(
    "names a missing %s and connects to nothing",
    async (missing) => {
      const env = {
        ...complete,
        CLAUSEWISE_POSTGRES_USER: "clausewise-id-migrate",
        CLAUSEWISE_WEB_ROLE: "clausewise-id-web",
        CLAUSEWISE_WORKER_ROLE: "clausewise-id-worker",
        [missing]: "",
      };
      await expect(runMigrate({ env, fetch: noNetwork })).rejects.toThrow(
        new SettingsError(`Missing settings: ${missing}.`),
      );
    },
  );

  it("refuses a role name that is not one", async () => {
    await expect(
      runMigrate({
        env: {
          ...complete,
          CLAUSEWISE_WEB_ROLE: 'web"; DROP TABLE reviews; --',
          CLAUSEWISE_WORKER_ROLE: "w",
        },
        fetch: noNetwork,
      }),
    ).rejects.toThrow(/CLAUSEWISE_WEB_ROLE is not a role name/);
  });
});

describe("the web app in azure mode", () => {
  it("needs Entra ID sign-in settings and listens on nothing without them", async () => {
    await expect(
      startAzureWeb({
        env: complete,
        playbooksDir: join(ROOT, "playbooks"),
        port: 0,
        fetch: noNetwork,
      }),
    ).rejects.toThrow(/CLAUSEWISE_ENTRA_TENANT_ID and CLAUSEWISE_ENTRA_CLIENT_ID/);
  });
});
