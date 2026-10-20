/**
 * What kind of failure the provider reported, so a caller can word a precise message without
 * parsing text. "network" means no HTTP answer arrived at all.
 */
export type ModelRequestKind =
  | "auth"
  | "permission"
  | "not_found"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "network"
  | "other";

// A rejected key, a missing model and an exhausted balance fail every call of a review the same
// way, so sending the remaining rules to the provider only repeats the failure.
const FATAL_KINDS: ReadonlySet<ModelRequestKind> = new Set([
  "auth",
  "permission",
  "not_found",
  "billing",
]);

/** The kind a bare HTTP status stands for, when the provider's own error type is not known. */
export function kindFromStatus(status: number | undefined): ModelRequestKind {
  if (status === undefined) return "other";
  if (status === 401) return "auth";
  if (status === 402) return "billing";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "other";
}

/**
 * The provider could not be reached or rejected the request. The SDKs' own errors carry the whole
 * request, which is the contract, so this keeps only the status and the provider's message.
 */
export class ModelRequestError extends Error {
  override name = "ModelRequestError";
  readonly statusCode: number | undefined;
  /**
   * True when every other call of the same review would fail the same way, such as a rejected key,
   * a missing model or an exhausted balance, so a caller should stop instead of sending more.
   */
  readonly fatal: boolean;
  /** What went wrong, in terms a caller can branch on. Derived from the status when not given. */
  readonly kind: ModelRequestKind;

  constructor(
    message: string,
    statusCode: number | undefined,
    fatal?: boolean,
    kind?: ModelRequestKind,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.kind = kind ?? kindFromStatus(statusCode);
    this.fatal = fatal ?? FATAL_KINDS.has(this.kind);
  }
}

export interface ProviderErrorFacts {
  /** The HTTP status, absent for an error that arrived inside an already open stream. */
  status: number | undefined;
  /** The provider's error type, such as "billing_error" or "insufficient_quota". */
  type: string | undefined;
  /** A finer code, such as OpenAI's `code` or Anthropic's `details.error_code`. */
  code: string | undefined;
  message: string;
}

// Markers a provider uses for an account that cannot pay, whatever the status says. A spend cap
// does not clear by waiting a few seconds, so none of these is worth another attempt.
const BILLING_MARKS: ReadonlySet<string> = new Set([
  "billing_error",
  "enforced_spend_limit_reached",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
]);

// Anthropic answers an empty balance and a spend limit the account owner set with a plain 400.
const BILLING_TEXT = /credit balance is too low|reached your specified api usage limits/i;

/** Sorts a provider error into a kind. The status wins; the type decides only when it is absent. */
export function classifyProviderError(facts: ProviderErrorFacts): ModelRequestKind {
  const type = facts.type?.toLowerCase();
  const code = facts.code?.toLowerCase();
  if (
    facts.status === 402 ||
    (type !== undefined && BILLING_MARKS.has(type)) ||
    (code !== undefined && BILLING_MARKS.has(code)) ||
    ((facts.status === 400 || facts.status === 429) && BILLING_TEXT.test(facts.message))
  ) {
    return "billing";
  }
  if (facts.status !== undefined) {
    if (
      facts.status === 503 &&
      /overloaded/i.test(`${type ?? ""} ${code ?? ""} ${facts.message}`)
    ) {
      return "overloaded";
    }
    return kindFromStatus(facts.status);
  }
  switch (type) {
    case "authentication_error":
      return "auth";
    case "permission_error":
      return "permission";
    case "not_found_error":
      return "not_found";
    case "rate_limit_error":
      return "rate_limit";
    case "overloaded_error":
      return "overloaded";
    case "api_error":
      return "server";
    default:
      return "other";
  }
}

export function isFatalKind(kind: ModelRequestKind): boolean {
  return FATAL_KINDS.has(kind);
}

const MAX_PROVIDER_MESSAGE = 300;

// Key shapes seen in the wild. A provider can echo a key it was sent, in another case, cut short or
// masked in the middle, so the exact string is not enough.
const KEY_SHAPE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_*-]{20,}/g;
const BEARER = /\bBearer\s+[^\s"',;]+/gi;

// A cut-off rendering of the configured key is still a piece of it, so what follows the first
// characters is redacted too, up to the end of anything that looks like part of a key.
const KEY_PREFIX_LENGTH = 12;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Makes provider text safe to show. Control and invisible formatting characters go first, so a key
 * cannot be hidden from the redaction by splitting it, then the configured key and anything shaped
 * like a key or bearer token is redacted, and the length is capped last so that no cut can leave a
 * piece of a key behind.
 */
export function scrubProviderText(text: string, apiKey: string | undefined): string {
  let clean = text.replace(/[\t\n\r\f\v\p{Zl}\p{Zp}]+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (apiKey !== undefined && apiKey !== "") {
    clean = clean.replace(new RegExp(escapeRegExp(apiKey), "gi"), "[redacted]");
    if (apiKey.length > KEY_PREFIX_LENGTH) {
      const start = escapeRegExp(apiKey.slice(0, KEY_PREFIX_LENGTH));
      clean = clean.replace(new RegExp(`${start}[\\w*-]*`, "gi"), "[redacted]");
    }
  }
  clean = clean.replace(KEY_SHAPE, "[redacted]").replace(BEARER, "Bearer [redacted]");
  return clean.length > MAX_PROVIDER_MESSAGE ? `${clean.slice(0, MAX_PROVIDER_MESSAGE)}...` : clean;
}
