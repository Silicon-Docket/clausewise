import { describe, expect, it } from "vitest";
import { SettingsError, readIdentity, readPostgres, readStorage } from "../src/index.js";

const SECRET_LOOKING = "value-that-must-not-be-echoed";

function settingsError(read: () => unknown): SettingsError {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as Error).message).not.toContain(SECRET_LOOKING);
    return error as SettingsError;
  }
  throw new Error("expected a SettingsError");
}

describe("readIdentity", () => {
  const env = {
    IDENTITY_ENDPOINT: "http://localhost:42356/msi/token",
    IDENTITY_HEADER: "header",
    AZURE_CLIENT_ID: "0a0a0a0a-1111-4222-8333-444444444444",
  };

  it("reads the token service and the user-assigned identity", () => {
    expect(readIdentity(env)).toEqual({
      identityEndpoint: "http://localhost:42356/msi/token",
      clientId: "0a0a0a0a-1111-4222-8333-444444444444",
    });
  });

  it("names every missing setting at once", () => {
    expect(settingsError(() => readIdentity({})).message).toBe(
      "Missing settings: IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID.",
    );
  });

  it("needs the client id, because every identity in the template is user-assigned", () => {
    expect(settingsError(() => readIdentity({ ...env, AZURE_CLIENT_ID: "" })).message).toMatch(
      /AZURE_CLIENT_ID/,
    );
    expect(
      settingsError(() => readIdentity({ ...env, AZURE_CLIENT_ID: SECRET_LOOKING })).message,
    ).toMatch(/GUID/);
  });

  it("refuses a token service that is not an http URL", () => {
    settingsError(() => readIdentity({ ...env, IDENTITY_ENDPOINT: `file:///${SECRET_LOOKING}` }));
    settingsError(() => readIdentity({ ...env, IDENTITY_ENDPOINT: SECRET_LOOKING }));
  });
});

describe("readStorage", () => {
  const env = {
    CLAUSEWISE_BLOB_ENDPOINT: "https://contosolegal.blob.core.windows.net",
    CLAUSEWISE_CONTRACTS_CONTAINER: "contracts",
    CLAUSEWISE_RESULTS_CONTAINER: "results",
    CLAUSEWISE_QUEUE_ENDPOINT: "https://contosoqueue.queue.core.windows.net/",
    CLAUSEWISE_QUEUE_NAME: "reviews",
  };

  it("reads the template's outputs, with each endpoint ending in one slash", () => {
    expect(readStorage(env)).toEqual({
      blobEndpoint: "https://contosolegal.blob.core.windows.net/",
      contractsContainer: "contracts",
      resultsContainer: "results",
      queueEndpoint: "https://contosoqueue.queue.core.windows.net/",
      queueName: "reviews",
    });
  });

  it("names a missing setting", () => {
    const { CLAUSEWISE_QUEUE_NAME: _, ...rest } = env;
    expect(settingsError(() => readStorage(rest)).message).toBe(
      "Missing settings: CLAUSEWISE_QUEUE_NAME.",
    );
  });

  it("refuses an endpoint that would send a token in clear text or carry a key", () => {
    expect(
      settingsError(() =>
        readStorage({
          ...env,
          CLAUSEWISE_BLOB_ENDPOINT: "http://contosolegal.blob.core.windows.net/",
        }),
      ).message,
    ).toMatch(/https/);
    settingsError(() =>
      readStorage({
        ...env,
        CLAUSEWISE_BLOB_ENDPOINT: `https://contosolegal.blob.core.windows.net/?sig=${SECRET_LOOKING}`,
      }),
    );
  });
});

describe("readPostgres", () => {
  const env = {
    CLAUSEWISE_POSTGRES_HOST: "contoso-pg.postgres.database.azure.com",
    CLAUSEWISE_POSTGRES_DATABASE: "clausewise",
    CLAUSEWISE_POSTGRES_USER: "clausewise-id-web",
  };

  it("reads the server, the database and the identity's role", () => {
    expect(readPostgres(env)).toEqual({
      host: "contoso-pg.postgres.database.azure.com",
      database: "clausewise",
      user: "clausewise-id-web",
    });
  });

  it.each([
    ["CLAUSEWISE_POSTGRES_HOST", "postgresql://contoso-pg.postgres.database.azure.com"],
    ["CLAUSEWISE_POSTGRES_HOST", "contoso-pg.postgres.database.azure.com:5432"],
    ["CLAUSEWISE_POSTGRES_DATABASE", "clausewise; DROP TABLE reviews"],
    ["CLAUSEWISE_POSTGRES_USER", "web role"],
  ])("refuses %s %j", (name, value) => {
    expect(settingsError(() => readPostgres({ ...env, [name]: value })).message).toContain(name);
  });
});
