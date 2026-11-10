import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Authenticator } from "./handler.js";

/** The delegated scope the app registration exposes (deploy/azure/foundation/modules/entra-app.bicep). */
export const ACCESS_SCOPE = "access_as_user";

export interface EntraConfig {
  /** The firm's directory, a GUID. Tokens from any other tenant are refused. */
  tenantId: string;
  /** The app registration's application (client) id, a GUID. */
  clientId: string;
}

/** Why a token was refused, as a code safe to log. Never the token or any of its claims. */
export type RejectReason =
  | "no_token"
  | "invalid"
  | "expired"
  | "unknown_key"
  | "wrong_claims"
  | "wrong_scope"
  | "wrong_client"
  | "no_user";

export interface EntraOptions {
  /** The signing keys. Default: the tenant's published v2.0 keys, fetched and cached. */
  keys?: JWTVerifyGetKey;
  /** Used to fetch the published keys. Default: the global fetch. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onReject?: (reason: RejectReason) => void;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Clocks in a firm's network and in Entra ID drift a little; five minutes is the usual allowance.
const CLOCK_TOLERANCE_SECONDS = 300;

/** Checks the two ids before anything is fetched, so a typo fails at startup, not at sign-in. */
export function checkEntraConfig(config: EntraConfig): EntraConfig {
  if (!GUID.test(config.tenantId)) {
    throw new Error("CLAUSEWISE_ENTRA_TENANT_ID must be the directory (tenant) id, a GUID.");
  }
  if (!GUID.test(config.clientId)) {
    throw new Error("CLAUSEWISE_ENTRA_CLIENT_ID must be the application (client) id, a GUID.");
  }
  return { tenantId: config.tenantId.toLowerCase(), clientId: config.clientId.toLowerCase() };
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * A failure to get the signing keys says nothing about the token, so it must not be answered as
 * a bad sign-in. Those errors are thrown on, and the API answers them as a server problem.
 */
function isKeyServiceFailure(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  return (
    error.code === "ERR_JOSE_GENERIC" ||
    error.code === "ERR_JWKS_TIMEOUT" ||
    error.code === "ERR_JWKS_INVALID"
  );
}

function reasonFor(error: errors.JOSEError): RejectReason {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWKSNoMatchingKey) return "unknown_key";
  if (error instanceof errors.JWTClaimValidationFailed) return "wrong_claims";
  return "invalid";
}

/**
 * Accepts only an access token that Entra ID issued for this app, to a user of the firm's own
 * directory, through this app: RS256 with the tenant's published keys; issuer, tenant, audience
 * and token version as a version 2 token for this registration has them; the access_as_user
 * scope; and this app as the authorized party.
 *
 * The scope check is what keeps out an ID token: it has the same audience and the same keys as an
 * access token for this app, but no scope. The authorized-party check keeps out another app in
 * the tenant that was granted the scope. Access by group is enforced by Entra ID itself, which
 * issues no token to a user the firm has not assigned to the app.
 */
export function entraAuthenticator(config: EntraConfig, options: EntraOptions = {}): Authenticator {
  const { tenantId, clientId } = checkEntraConfig(config);
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const keys =
    options.keys ??
    createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
      {
        timeoutDuration: 5000,
        // A token signed with a key not in the cached set causes one refetch, at most every
        // thirty seconds, so a flood of made-up key ids cannot hammer Entra ID.
        cooldownDuration: 30_000,
        cacheMaxAge: 24 * 60 * 60 * 1000,
        ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
      },
    );
  const reject = (reason: RejectReason): undefined => {
    options.onReject?.(reason);
    return undefined;
  };

  return async (request) => {
    const token = bearerToken(request);
    if (token === undefined) return reject("no_token");

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer,
        audience: clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp", "nbf", "iat", "tid", "oid", "scp", "azp", "ver"],
        ...(options.now === undefined ? {} : { currentDate: options.now() }),
      }));
    } catch (error) {
      if (isKeyServiceFailure(error)) throw error;
      return reject(reasonFor(error as errors.JOSEError));
    }

    if (payload.ver !== "2.0" || String(payload.tid).toLowerCase() !== tenantId) {
      return reject("wrong_claims");
    }
    const scopes = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
    if (!scopes.includes(ACCESS_SCOPE)) return reject("wrong_scope");
    if (typeof payload.azp !== "string" || payload.azp.toLowerCase() !== clientId) {
      return reject("wrong_client");
    }
    if (typeof payload.oid !== "string" || !GUID.test(payload.oid)) return reject("no_user");
    return { id: payload.oid.toLowerCase() };
  };
}

/** Every authenticator must accept the request; the user is the last one's. */
export function allOf(...authenticators: Authenticator[]): Authenticator {
  return async (request) => {
    let user;
    for (const authenticate of authenticators) {
      user = await authenticate(request);
      if (user === undefined) return undefined;
    }
    return user;
  };
}
