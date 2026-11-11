import { existsSync } from "node:fs";
import {
  CliUsageError,
  dataFolder,
  describeFailure,
  isEntryPointOf,
  stderrLine,
  stdoutLine,
} from "./cli-common.js";
import {
  AUDIT_BREAK_TEXT,
  StoreError,
  checkAudit,
  openDatabaseReadOnly,
  type AuditCheck,
  type AuditHead,
} from "./store/index.js";

/**
 * `pnpm parol:audit-verify`: checks the audit log's hash chain (docs/parol/06, "Minimal sensitive
 * logging"). Read only; it opens the database without migrating or writing, so it can run beside
 * the server.
 *
 *   pnpm parol:audit-verify [--json] [--expect-head SEQ:HASH]
 *
 * Exit codes. 0: the chain holds and every matter is accounted for. 1: it is broken (the chain, the
 * anchor, or the matters against their events). 2: it could not run (usage, no database, not a
 * Parol database).
 *
 * The output prints no column of any audit row. What it takes from rows is the number of the first
 * broken event, a fixed reason code and words for it, the head hash (a hash is not content), and
 * counts and ids of matters.
 *
 * What the check cannot show is said in its output: the hash is not keyed, so someone who can write
 * the file and recompute every later hash makes a log that verifies, and the highest number ever
 * issued (`sqlite_sequence`) lives in the same file. A head recorded somewhere the database's writer
 * cannot edit closes both for the history before it: pass it back with `--expect-head`.
 */

const USAGE = "usage: pnpm parol:audit-verify [--json] [--expect-head SEQ:HASH]";

export interface AuditVerifyArgs {
  json: boolean;
  anchor?: AuditHead;
}

/** `SEQ:HASH`: the event's number and its 64 lower-case hex digits. Null for anything else. */
export function parseAnchor(text: string): AuditHead | null {
  const match = /^(\d{1,12}):([0-9a-f]{64})$/.exec(text);
  if (!match) return null;
  const seq = Number(match[1]);
  return seq >= 1 && Number.isSafeInteger(seq) ? { seq, hash: match[2] as string } : null;
}

/** A lone `--` is skipped, because `pnpm parol:audit-verify -- --json` hands it on. */
export function parseAuditVerifyArgs(argv: readonly string[]): AuditVerifyArgs {
  const args: AuditVerifyArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    if (arg === "--json") args.json = true;
    else if (arg === "--expect-head" || arg.startsWith("--expect-head=")) {
      const value = arg === "--expect-head" ? argv[++i] : arg.slice("--expect-head=".length);
      const anchor = value === undefined ? null : parseAnchor(value);
      if (anchor === null)
        throw new CliUsageError(
          `--expect-head needs the event number, a colon and its 64 hex digits, as the head line prints them. ${USAGE}`,
        );
      args.anchor = anchor;
    } else throw new CliUsageError(`an option is not known. ${USAGE}`);
  }
  return args;
}

const idsText = (ids: string[], count: number): string =>
  ids.join(", ") + (count > ids.length ? ` and ${count - ids.length} more` : "");

/** The lines of the text output. Counts, ids of matters, event numbers and one hash. */
export function describeAuditCheck(check: AuditCheck, dataDir: string): string[] {
  const { chain, head, anchor, matters } = check;
  const lines = ["Parol audit log check (read only)", `Data folder: ${dataDir}`];
  if (chain.ok) {
    lines.push(
      chain.events === 0 ? "Events: 0" : `Events: ${chain.events} (1 to ${chain.events})`,
      "Chain: intact. Each event's hash matches its content and the event before it.",
    );
  } else {
    lines.push(
      `Events checked before the break: ${chain.events}`,
      `FAILED: the chain breaks at event ${chain.firstBrokenSeq}: ${AUDIT_BREAK_TEXT[chain.reason]} (${chain.reason}). ${chain.events} events before it check out. Nothing after event ${chain.firstBrokenSeq} can be trusted.`,
    );
  }
  lines.push(
    head === null
      ? "Head: none, the log has no events"
      : `Head: seq ${head.seq}, hash ${head.hash}`,
  );
  if (anchor !== null)
    lines.push(
      anchor.ok
        ? "Anchor: the event you named is in the log with the hash you gave."
        : `FAILED: the anchor does not hold: ${AUDIT_BREAK_TEXT[anchor.reason]} (${anchor.reason}).`,
    );
  lines.push(
    `Matters: ${matters.created} created, ${matters.present} present, ${matters.deleted} deleted with a deletion event; ${matters.goneWithoutDeleteEvent.count} gone without one, ${matters.presentWithoutCreateEvent.count} present without a creation event.`,
  );
  if (matters.goneWithoutDeleteEvent.count > 0)
    lines.push(
      `FAILED: matters gone with no deletion event: ${idsText(matters.goneWithoutDeleteEvent.ids, matters.goneWithoutDeleteEvent.count)}`,
    );
  if (matters.presentWithoutCreateEvent.count > 0)
    lines.push(
      `FAILED: matters present with no creation event: ${idsText(matters.presentWithoutCreateEvent.ids, matters.presentWithoutCreateEvent.count)}`,
    );
  if (matters.deletedButPresent.count > 0)
    lines.push(
      `FAILED: matters with a deletion event that are still present: ${idsText(matters.deletedButPresent.ids, matters.deletedButPresent.count)}`,
    );
  lines.push(
    "This check does not show that the newest events are all still here, or that the log was not rewritten with every later hash recomputed, unless you keep the head line somewhere the database's writer cannot edit and check it with --expect-head.",
  );
  return lines;
}

/** The exit code of a check: 0 intact, 1 broken. */
export const exitCodeOfCheck = (check: AuditCheck): 0 | 1 => (check.ok ? 0 : 1);

const READABLE = [CliUsageError, StoreError] as const;

/**
 * Runs the command and returns its exit code. `env` is read for `PAROL_DATA_DIR` and nothing else.
 */
export async function runAuditVerify(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = stdoutLine,
  err: (line: string) => void = stderrLine,
): Promise<number> {
  try {
    const args = parseAuditVerifyArgs(argv);
    const folder = dataFolder(env);
    if (!existsSync(folder.databasePath)) {
      err(
        "Parol audit check cannot run: there is no database in the data folder. Check PAROL_DATA_DIR.",
      );
      return 2;
    }
    const db = openDatabaseReadOnly(folder.databasePath);
    let check: AuditCheck;
    try {
      check = checkAudit(db, args.anchor === undefined ? {} : { anchor: args.anchor });
    } finally {
      db.close();
    }
    if (args.json) {
      out(
        JSON.stringify({
          ok: check.ok,
          events: check.chain.events,
          firstBrokenSeq: check.chain.ok ? null : check.chain.firstBrokenSeq,
          reason: check.chain.ok ? null : check.chain.reason,
          head: check.head,
          anchor: check.anchor,
          matters: check.matters,
        }),
      );
    } else for (const line of describeAuditCheck(check, folder.dataDir)) out(line);
    return exitCodeOfCheck(check);
  } catch (error) {
    err(`Parol audit check cannot run: ${describeFailure(error, READABLE)}`);
    return 2;
  }
}

if (isEntryPointOf(import.meta.url)) {
  runAuditVerify().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("Parol audit check cannot run.\n");
      process.exitCode = 2;
    },
  );
}
