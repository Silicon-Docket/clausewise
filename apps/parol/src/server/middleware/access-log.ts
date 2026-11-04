/**
 * The one line the server logs per request (docs/parol/06): request id, method, route template,
 * status, latency, user id and matter id. Nothing else. No body, header, query string, file name,
 * path value or document text can reach it, because it is built only from the fields below and
 * each is checked to be what it claims to be before it is written.
 */
export interface AccessLogEntry {
  requestId: string;
  method: string;
  /** The template the route was registered with, such as `/matters/:matterId`. Never the path. */
  route: string | null;
  status: number;
  latencyMs: number;
  /** Set only from a verified principal. */
  userId: string | null;
  /** Set only from an authorized matter, so an id typed in a path never appears. */
  matterId: string | null;
  /** The class name of an unexpected error. Never its message. */
  errorName: string | null;
}

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TEMPLATE = /^[\x21-\x7e]{1,200}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const UNMATCHED_ROUTE = "(unmatched)";

export function formatAccessLine(entry: AccessLogEntry): string {
  const id = (value: string | null): string => (value !== null && ID.test(value) ? value : "-");
  const method = KNOWN_METHODS.has(entry.method) ? entry.method : "OTHER";
  const route = entry.route !== null && TEMPLATE.test(entry.route) ? entry.route : UNMATCHED_ROUTE;
  const status = Number.isInteger(entry.status) ? entry.status : 0;
  const latency = Number.isFinite(entry.latencyMs) ? Math.max(0, Math.round(entry.latencyMs)) : 0;
  const fields = [
    `req=${id(entry.requestId)}`,
    `method=${method}`,
    `route=${route}`,
    `status=${status}`,
    `ms=${latency}`,
    `user=${id(entry.userId)}`,
    `matter=${id(entry.matterId)}`,
  ];
  if (entry.errorName !== null)
    fields.push(`error=${ERROR_NAME.test(entry.errorName) ? entry.errorName : "Error"}`);
  return fields.join(" ");
}
