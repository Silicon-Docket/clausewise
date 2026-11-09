import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOracleGenerator } from "@clausewise/review/testing";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allOf,
  checkEntraConfig,
  entraAuthenticator,
  startLocal,
  type EntraOptions,
  type RejectReason,
} from "../src/index.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-9999-000000000000";
const OTHER_CLIENT = "12345678-1234-4234-8234-123456789012";
const OID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let signing: CryptoKey;
let impostor: CryptoKey;
let keySet: JSONWebKeySet;

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  const fake = await generateKeyPair("RS256", { extractable: true });
  signing = real.privateKey;
  impostor = fake.privateKey;
  keySet = {
    keys: [{ ...(await exportJWK(real.publicKey)), kid: "key-1", alg: "RS256", use: "sig" }],
  };
});

const now = () => Math.floor(Date.now() / 1000);

/** A token as Entra ID issues it for this app, with any claim changed or, if undefined, removed. */
async function token(
  overrides: Record<string, unknown> = {},
  header: { kid?: string; key?: CryptoKey } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT,
    tid: TENANT,
    oid: OID,
    scp: "access_as_user",
    azp: CLIENT,
    ver: "2.0",
    iat: now() - 60,
    nbf: now() - 60,
    exp: now() + 3600,
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: header.kid ?? "key-1", typ: "JWT" })
    .sign(header.key ?? signing);
}

const withAuth = (authorization?: string): IncomingMessage =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;

function authenticator(options: EntraOptions = {}) {
  const reasons: RejectReason[] = [];
  const authenticate = entraAuthenticator(
    { tenantId: TENANT, clientId: CLIENT },
    { keys: createLocalJWKSet(keySet), onReject: (reason) => reasons.push(reason), ...options },
  );
  return { authenticate, reasons };
}

describe("a token Entra ID issued for this app", () => {
  it("signs in its user by object id", async () => {
    const { authenticate } = authenticator();
    expect(await authenticate(withAuth(`Bearer ${await token()}`))).toEqual({ id: OID });
  });

  it("accepts the scope among others, and a lower-case scheme", async () => {
    const { authenticate } = authenticator();
    const jwt = await token({ scp: "User.Read access_as_user" });
    expect(await authenticate(withAuth(`bearer ${jwt}`))).toEqual({ id: OID });
  });

  it("allows for a few minutes of clock difference", async () => {
    const { authenticate } = authenticator();
    expect(await authenticate(withAuth(`Bearer ${await token({ exp: now() - 120 })}`))).toEqual({
      id: OID,
    });
  });

  it("writes the user id in lower case, whatever the token's case", async () => {
    const { authenticate } = authenticator();
    const jwt = await token({ oid: OID.toUpperCase() });
    expect(await authenticate(withAuth(`Bearer ${jwt}`))).toEqual({ id: OID });
  });
});

describe("everything else", () => {
  async function refused(
    jwt: string | Promise<string> | undefined,
    reason: RejectReason,
    authorization?: (token: string) => string,
  ) {
    const { authenticate, reasons } = authenticator();
    const value = jwt === undefined ? undefined : await jwt;
    const header =
      value === undefined ? undefined : authorization ? authorization(value) : `Bearer ${value}`;
    expect(await authenticate(withAuth(header))).toBeUndefined();
    expect(reasons).toEqual([reason]);
  }

  it("refuses a request with no token", () => refused(undefined, "no_token"));
  it("refuses another scheme", () => refused(token(), "no_token", (jwt) => `Basic ${jwt}`));
  it("refuses something that is not a token", () =>
    refused(Promise.resolve("not-a-jwt"), "no_token"));
  it("refuses two tokens in one header", () =>
    refused(token(), "no_token", (jwt) => `Bearer ${jwt} ${jwt}`));

  it("refuses a token signed with another key under a known key id", () =>
    refused(token({}, { key: impostor }), "invalid"));

  it("refuses a token signed with a key Entra ID never published", () =>
    refused(token({}, { kid: "key-2" }), "unknown_key"));

  it("refuses a token signed with a shared secret instead of RSA", async () => {
    const hs = await new SignJWT({ iss: ISSUER, aud: CLIENT })
      .setProtectedHeader({ alg: "HS256", kid: "key-1" })
      .sign(new TextEncoder().encode("a-secret-an-attacker-chose-1234567890"));
    await refused(Promise.resolve(hs), "invalid");
  });

  it("refuses an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT })).toString("base64url");
    await refused(Promise.resolve(`${header}.${body}.`), "no_token");
  });

  it("refuses an expired token", () => refused(token({ exp: now() - 600 }), "expired"));
  it("refuses a token not yet valid", () => refused(token({ nbf: now() + 600 }), "wrong_claims"));

  it.each([
    [
      "another tenant's issuer",
      { iss: "https://login.microsoftonline.com/99999999-2222-4333-8444-555555555555/v2.0" },
    ],
    ["the version 1 issuer", { iss: `https://sts.windows.net/${TENANT}/` }],
    ["another app's audience", { aud: OTHER_CLIENT }],
    ["an application ID URI audience", { aud: `api://${CLIENT}` }],
    ["the Microsoft Graph audience", { aud: "00000003-0000-0000-c000-000000000000" }],
    ["another tenant id", { tid: "99999999-2222-4333-8444-555555555555" }],
    ["a version 1 token", { ver: "1.0" }],
  ])("refuses %s", (_label, claims) => refused(token(claims), "wrong_claims"));

  it("refuses this app's own ID token, which has the same audience and keys but no scope", () =>
    refused(token({ scp: undefined, nonce: "n" }), "wrong_claims"));

  it("refuses an app-only token, which carries roles and no scope", () =>
    refused(token({ scp: undefined, roles: ["Admin"] }), "wrong_claims"));

  it("refuses a token for another scope of this app", () =>
    refused(token({ scp: "User.Read" }), "wrong_scope"));

  it("refuses a token another app in the tenant obtained for this scope", () =>
    refused(token({ azp: OTHER_CLIENT }), "wrong_client"));

  it("refuses a token with no user", () => refused(token({ oid: undefined }), "wrong_claims"));
  it("refuses a user id that is not a GUID", () => refused(token({ oid: "admin" }), "no_user"));

  it("never hands the token to the rejection hook, only a reason code", async () => {
    const seen: unknown[] = [];
    const { authenticate } = authenticator({ onReject: (reason) => seen.push(reason) });
    const jwt = await token({ aud: OTHER_CLIENT });
    await authenticate(withAuth(`Bearer ${jwt}`));
    expect(JSON.stringify(seen)).not.toContain(jwt.split(".")[1]);
  });
});

describe("the published keys", () => {
  it("are fetched from the tenant's own version 2 endpoint", async () => {
    const asked: string[] = [];
    const authenticate = entraAuthenticator(
      { tenantId: TENANT, clientId: CLIENT },
      {
        fetch: (async (url: unknown) => {
          asked.push(String(url));
          return new Response(JSON.stringify(keySet), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof globalThis.fetch,
      },
    );
    expect(await authenticate(withAuth(`Bearer ${await token()}`))).toEqual({ id: OID });
    expect(asked).toEqual([`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`]);
  });

  it.each([
    ["is unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
    ["answers 503", async () => new Response("down", { status: 503 })],
    [
      "answers with something that is not JSON",
      async () => new Response("<html>", { status: 200 }),
    ],
  ])(
    "make sign-in fail as a server problem, not a bad token, when the key service %s",
    async (_label, answer) => {
      const reasons: RejectReason[] = [];
      const authenticate = entraAuthenticator(
        { tenantId: TENANT, clientId: CLIENT },
        { fetch: answer as typeof globalThis.fetch, onReject: (reason) => reasons.push(reason) },
      );
      await expect(authenticate(withAuth(`Bearer ${await token()}`))).rejects.toBeDefined();
      expect(reasons).toEqual([]);
    },
  );
});

describe("checkEntraConfig", () => {
  it("writes both ids in lower case", () => {
    expect(
      checkEntraConfig({ tenantId: TENANT.toUpperCase(), clientId: CLIENT.toUpperCase() }),
    ).toEqual({
      tenantId: TENANT,
      clientId: CLIENT,
    });
  });

  it.each([
    [{ tenantId: "contoso.onmicrosoft.com", clientId: CLIENT }, /TENANT_ID/],
    [{ tenantId: TENANT, clientId: `api://${CLIENT}` }, /CLIENT_ID/],
  ])("refuses %j", (config, message) => {
    expect(() => checkEntraConfig(config)).toThrow(message);
  });
});

describe("allOf", () => {
  it("lets a request in only when every check does", async () => {
    const yes = async () => ({ id: "a" });
    const no = async () => undefined;
    expect(await allOf(yes, yes)(withAuth())).toEqual({ id: "a" });
    expect(await allOf(yes, no)(withAuth())).toBeUndefined();
    expect(await allOf(no, yes)(withAuth())).toBeUndefined();
  });
});

describe("local mode with Entra ID sign-in", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  let keysDown = false;

  beforeAll(async () => {
    const localKeys = createLocalJWKSet(keySet);
    local = await startLocal({
      playbooksDir: join(ROOT, "playbooks"),
      generator: createOracleGenerator({}),
      port: 0,
      entra: {
        tenantId: TENANT,
        clientId: CLIENT,
        options: {
          keys: async (header, input) => {
            if (keysDown) throw new TypeError("fetch failed");
            return localKeys(header, input);
          },
        },
      },
    });
  });

  afterAll(async () => {
    await local.close();
  });

  function get(path: string, headers: Record<string, string>) {
    return new Promise<{ status: number; challenge: string | undefined }>((resolve, reject) => {
      const req = httpRequest(`${local.url}${path}`, { headers }, (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, challenge: res.headers["www-authenticate"] }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("serves a signed-in user on this machine", async () => {
    const response = await get("/api/playbooks", { authorization: `Bearer ${await token()}` });
    expect(response.status).toBe(200);
  });

  it("asks for a bearer token when there is none", async () => {
    expect(await get("/api/playbooks", {})).toEqual({ status: 401, challenge: "Bearer" });
  });

  it("still refuses a valid token sent under another host name", async () => {
    const port = new URL(local.url).port;
    const response = await get("/api/playbooks", {
      authorization: `Bearer ${await token()}`,
      host: `attacker.example:${port}`,
    });
    expect(response.status).toBe(401);
  });

  it("answers 500, not 401, while the key service is down", async () => {
    keysDown = true;
    try {
      const response = await get("/api/playbooks", { authorization: `Bearer ${await token()}` });
      expect(response.status).toBe(500);
    } finally {
      keysDown = false;
    }
  });
});
