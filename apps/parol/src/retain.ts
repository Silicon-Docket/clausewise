import { existsSync } from "node:fs";
import { acquireInstanceLock } from "./boot/instance-lock.js";
import {
  CliUsageError,
  describeFailure,
  dataFolder,
  isEntryPointOf,
  stderrLine,
  stdoutLine,
  type DataFolder,
} from "./cli-common.js";
import {
  DEFAULT_MAX_MATTERS_PER_RUN,
  MAX_MATTERS_CEILING,
  RetentionUsageError,
  runRetention,
  type RetentionReport,
} from "./retention/job.js";
import {
  AUDIT_BREAK_TEXT,
  FileStore,
  StoreError,
  createRepository,
  openDatabase,
  openDatabaseReadOnly,
  type Database,
  type Repository,
} from "./store/index.js";

/**
 * `pnpm parol:retain`: the retention command (docs/parol/06, "Retention and deletion").
 *
 *   pnpm parol:retain [--apply] [--max-matters N] [--as-of ISO_TIME_OR_DATE] [--json]
 *
 * A dry run by default: it lists the matters that are past their retention date, with a count and
 * its denominator, and changes nothing. `--apply` deletes them, and refuses to run while the server
 * has the data folder (the same exclusive lock the server takes), because the deletion rewrites the
 * database file and the server keeps parsed document text in memory that only it can drop.
 *
 * Who may run it: whoever can run commands against the data folder. It is not an application role
 * and takes no request, so no person is authorized and the actor of its events is null (the
 * system), the same trust that the seed and the start-up sweep rely on.
 *
 * Exit codes. 0: it finished and nothing is wrong (a dry run that lists matters is 0). 1: it ran
 * and something is wrong (a matter could not be deleted, a folder could not be removed, compaction
 * failed, or the audit chain does not verify; deletions that could run did run, because the duty to
 * delete on time does not wait for a log that cannot be repaired). 2: it could not run (usage, no
 * database, the folder is in use). 3: it refused (more matters are past their date than
 * `--max-matters`, so nothing was deleted). When more than one holds, 2 wins over 1 and 1 over 3,
 * so that a broken audit chain is never hidden behind a refusal.
 *
 * Output holds ids, statuses, ISO times and counts. It never prints a matter's name, its client's
 * name or a title: look a matter up by its id.
 *
 * A dry run opens the database read only, so no row, file or event is written and not a byte of
 * `parol.sqlite` changes. When a read-only connection to a database in WAL mode closes, SQLite
 * leaves two files beside it (`parol.sqlite-wal`, empty, and `parol.sqlite-shm`). They hold no
 * data. They are not removed here, because another process (the server) may have them open; the
 * next read-write open and close removes them.
 */

const USAGE =
  "usage: pnpm parol:retain [--apply] [--max-matters N] [--as-of ISO_TIME_OR_DATE] [--json]";

export interface RetainArgs {
  apply: boolean;
  maxMatters: number;
  asOf?: Date;
  json: boolean;
}

/**
 * A date alone (`2026-12-01`, midnight UTC) or a full ISO time with its zone. The text is
 * round-tripped, because JavaScript reads `2026-02-31` as the 3rd of March.
 */
export function parseAsOf(text: string): Date | null {
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
  }
  const full =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!full) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  // The calendar day must be a real one: compare the date part in the text's own zone.
  const probe = new Date(`${full[1]}T00:00:00.000Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== full[1]) return null;
  if (Number(full[2]) > 23 || Number(full[3]) > 59 || Number(full[4] ?? "0") > 59) return null;
  return date;
}

/**
 * `--apply`, `--max-matters N` or `--max-matters=N`, `--as-of X` or `--as-of=X`, `--json`. A lone
 * `--` is skipped, because `pnpm parol:retain -- --apply` hands it on. Messages name the option and
 * never repeat its value.
 */
export function parseRetainArgs(argv: readonly string[]): RetainArgs {
  const args: RetainArgs = { apply: false, maxMatters: DEFAULT_MAX_MATTERS_PER_RUN, json: false };
  let asOfGiven = false;
  const valueOf = (option: string, arg: string, i: number): [string | undefined, number] => {
    if (arg === option) return [argv[i + 1], i + 1];
    return [arg.slice(option.length + 1), i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--max-matters" || arg.startsWith("--max-matters=")) {
      const [value, next] = valueOf("--max-matters", arg, i);
      i = next;
      if (value === undefined || !/^\d{1,5}$/.test(value))
        throw new CliUsageError(
          `--max-matters needs a whole number from 1 to ${MAX_MATTERS_CEILING}. ${USAGE}`,
        );
      const count = Number(value);
      if (count < 1 || count > MAX_MATTERS_CEILING)
        throw new CliUsageError(
          `--max-matters needs a whole number from 1 to ${MAX_MATTERS_CEILING}. ${USAGE}`,
        );
      args.maxMatters = count;
    } else if (arg === "--as-of" || arg.startsWith("--as-of=")) {
      const [value, next] = valueOf("--as-of", arg, i);
      i = next;
      const date = value === undefined ? null : parseAsOf(value);
      if (date === null)
        throw new CliUsageError(
          `--as-of needs a date (YYYY-MM-DD) or an ISO time with its zone, such as 2026-12-01T09:00:00Z. ${USAGE}`,
        );
      args.asOf = date;
      asOfGiven = true;
    } else throw new CliUsageError(`an option is not known. ${USAGE}`);
  }
  if (args.apply && asOfGiven)
    throw new CliUsageError(
      `--as-of is for a dry run: a deletion is judged at the clock, so --apply and --as-of cannot be used together. ${USAGE}`,
    );
  return args;
}

/** The lines of the text output. Ids, statuses, ISO times and counts only. */
export function describeRetention(
  report: RetentionReport,
  context: { dataDir: string; args: Pick<RetainArgs, "apply" | "maxMatters"> },
): string[] {
  const apply = report.mode === "apply";
  const lines: string[] = [
    apply ? "Parol retention (apply)" : "Parol retention (dry run: nothing is changed)",
    `Data folder: ${context.dataDir}`,
    `Judged at: ${report.at}`,
    `Matters past their retention date: ${report.expired} of ${report.totalMatters}`,
  ];
  for (const line of report.lines) {
    const base = `${line.matterId}  ${line.status}  kept until ${line.retainUntil}  created by ${line.createdBy}`;
    if (!apply || report.refusedByLimit) {
      lines.push(
        `  ${base}${line.outcome === "would_skip" ? "  [a run is in flight: would be skipped]" : ""}`,
      );
      continue;
    }
    if (line.outcome === "deleted")
      lines.push(
        `  deleted ${line.matterId}: ${line.rows ?? 0} rows, ${line.filesRemoved ?? 0} files`,
      );
    else if (line.outcome === "skipped")
      lines.push(`  skipped ${line.matterId}: a run is in flight`);
    else lines.push(`  FAILED ${line.matterId}: ${line.failure ?? "unexpected"}`);
  }
  if (report.refusedByLimit)
    lines.push(
      `Refused: ${report.expired} matters are past their date and --max-matters is ${context.args.maxMatters}. Nothing was deleted. Look at the list above, then raise --max-matters if the list is right.`,
    );
  else if (!apply && report.expired > context.args.maxMatters)
    lines.push(
      `--apply would refuse: more than ${context.args.maxMatters} matters are past their date (--max-matters).`,
    );
  if (apply && !report.refusedByLimit)
    lines.push(
      `Deleted ${report.deleted}, skipped ${report.skipped}, failed ${report.failed}, of ${report.expired} past their date (${report.totalMatters} matters in the database).`,
    );
  if (apply) {
    lines.push(
      `Folders with no matter removed: ${report.orphansRemoved}` +
        (report.orphansFailed > 0 ? ` (${report.orphansFailed} could not be removed)` : ""),
      `Database compacted: ${
        report.compaction === "done"
          ? "yes"
          : report.compaction === "not_needed"
            ? "not needed"
            : report.compaction === "failed"
              ? "no, see exit code"
              : "no, nothing was deleted"
      }`,
    );
  } else lines.push(`Matter folders that no matter names: ${report.orphanFolders.length}`);
  lines.push(
    report.chain.ok
      ? `Audit log: intact, ${report.chain.events} events`
      : `Audit log: BROKEN at event ${report.chain.firstBrokenSeq} (${AUDIT_BREAK_TEXT[report.chain.reason]}). Run pnpm parol:audit-verify.`,
  );
  if (!apply && report.expired > 0)
    lines.push("To delete these, stop the server and run: pnpm parol:retain --apply");
  lines.push("Names are not printed. Look a matter up by its id.");
  return lines;
}

/** The exit code of a finished run. See the top of this file. */
export function exitCodeOf(report: RetentionReport): 0 | 1 | 3 {
  const wrong =
    report.failed > 0 ||
    report.orphansFailed > 0 ||
    report.compaction === "failed" ||
    !report.chain.ok;
  if (wrong) return 1;
  return report.refusedByLimit ? 3 : 0;
}

const READABLE = [CliUsageError, RetentionUsageError, StoreError] as const;

/** Opens what the mode needs, runs the job, closes. Returns the report. */
function execute(
  folder: DataFolder,
  args: RetainArgs,
  now: () => Date,
): RetentionReport | "in_use" {
  let db: Database | undefined;
  let release: (() => void) | undefined;
  try {
    let repo: Repository;
    if (args.apply) {
      // The server holds this lock for as long as it runs. Nothing that opens the data folder for
      // a write may happen before it is ours.
      const lock = acquireInstanceLock(folder.dataDir);
      if (lock === null) return "in_use";
      release = () => lock.release();
      db = openDatabase(folder.databasePath);
      repo = createRepository(db, { now });
      const files = new FileStore(folder.mattersDir);
      return runRetention({ repo, files, now }, { apply: true, maxMatters: args.maxMatters });
    }
    // A dry run writes nothing, not even the folder of the files: the file store's constructor
    // creates its root, so a folder that does not exist yet is read as holding no matter.
    db = openDatabaseReadOnly(folder.databasePath);
    repo = createRepository(db, { now });
    const files = existsSync(folder.mattersDir)
      ? new FileStore(folder.mattersDir)
      : { listMatterIds: (): string[] => [] };
    return runRetention(
      { repo, files, now },
      {
        apply: false,
        maxMatters: args.maxMatters,
        ...(args.asOf === undefined ? {} : { asOf: args.asOf }),
      },
    );
  } finally {
    db?.close();
    release?.();
  }
}

/**
 * Runs the command and returns its exit code. `env` is read for `PAROL_DATA_DIR` and nothing else.
 * `out` and `err` take one line each; the tests pass their own.
 */
export async function runRetain(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = stdoutLine,
  err: (line: string) => void = stderrLine,
  now: () => Date = () => new Date(),
): Promise<number> {
  try {
    const args = parseRetainArgs(argv);
    const folder = dataFolder(env);
    // Nothing is created for a data folder that has no database: not the folder, not the lock file.
    if (!existsSync(folder.databasePath)) {
      err(
        "Parol retention cannot run: there is no database in the data folder. Check PAROL_DATA_DIR.",
      );
      return 2;
    }
    const result = execute(folder, args, now);
    if (result === "in_use") {
      err(
        "Parol retention cannot run: another Parol process is using this data folder. Stop the server and run this again.",
      );
      return 2;
    }
    if (args.json) out(JSON.stringify({ dataFolder: folder.dataDir, ...result }));
    else for (const line of describeRetention(result, { dataDir: folder.dataDir, args })) out(line);
    return exitCodeOf(result);
  } catch (error) {
    err(`Parol retention cannot run: ${describeFailure(error, READABLE)}`);
    return 2;
  }
}

if (isEntryPointOf(import.meta.url)) {
  runRetain().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("Parol retention cannot run.\n");
      process.exitCode = 2;
    },
  );
}
