import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { start, type RunningServer } from "../../src/main.js";
import { reportRetentionNotices, type RetentionNoticeDeps } from "../../src/retention/notices.js";
import { DEMO_USER_IDS, createRepository, openDatabase } from "../../src/store/index.js";
import { dropAuditTriggers } from "../store/audit-tamper.js";

/**
 * The start-up notices of slice D: when the server starts it says, in its own notice lines, how many
 * matters are past their retention date (out of how many there are) and whether the audit log
 * verifies. It says nothing when both are fine, it never holds a name, and it never stops the start
 * or deletes anything. The wording of one line against fake repositories is checked at the end.
 */

const SECRET = "retention-notice-secret-retention-0001";
const NAME_MARK = "QZNAME-5d1f";
const CLIENT_MARK = "QZCLIENT-8e02";
const TAMPER_MARK = "QZTAMPER-77ac";
const DAY = 86_400_000;

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function env(dataDir: string): Record<string, string> {
  return {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
  };
}

interface Booted {
  server: RunningServer;
  /** What `start` printed through `notice`, and through `log`. */
  notices: string[];
  logs: string[];
  /** Both, in the order they came, each tagged with where it went. */
  order: string[];
}

async function boot(dataDir: string): Promise<Booted> {
  const notices: string[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const server = await start(env(dataDir), {
    log: (line) => {
      logs.push(line);
      order.push(`log: ${line}`);
    },
    notice: (line) => {
      notices.push(line);
      order.push(`notice: ${line}`);
    },
  });
  running.push(server);
  return { server, notices, logs, order };
}

/** The lines about retention or the audit log, out of everything `start` printed. */
const aboutRetention = (lines: string[]): string[] =>
  lines.filter((line) => /retention date|audit log/.test(line));

interface Folder {
  dataDir: string;
  /** The ids of the matters made past their date, and of those that are not. */
  expired: string[];
  fresh: string[];
}

/**
 * A data folder as an earlier run left it: the server is started once so the database exists with
 * the demonstration users, stopped, and then matters are written with a clock three days back, so
 * those with one day to keep are past their date by the time the next start reads them.
 */
async function folder(options: { expired?: number; fresh?: number } = {}): Promise<Folder> {
  const root = mkdtempSync(join(tmpdir(), "parol-retention-notice-"));
  roots.push(root);
  const dataDir = join(root, "data");
  await (await boot(dataDir)).server.close();
  running.pop();

  const db = openDatabase(join(dataDir, "parol.sqlite"));
  try {
    const past = createRepository(db, { now: () => new Date(Date.now() - 3 * DAY) });
    const present = createRepository(db);
    const make = (repo: typeof past, label: string, retainDays: number): string =>
      repo.createMatter({
        name: `${label} ${NAME_MARK}`,
        clientLegalName: `${label} ${CLIENT_MARK}, Inc.`,
        createdBy: DEMO_USER_IDS.associate,
        retainDays,
      }).id;
    const expired = Array.from({ length: options.expired ?? 0 }, (_, i) =>
      make(past, `Expired ${i}`, 1),
    );
    const fresh = Array.from({ length: options.fresh ?? 0 }, (_, i) =>
      make(present, `Fresh ${i}`, 30),
    );
    return { dataDir, expired, fresh };
  } finally {
    db.close();
  }
}

/** Alters the second audit event by raw SQL, as someone with write access to the file could. */
function tamper(dataDir: string): void {
  const db = openDatabase(join(dataDir, "parol.sqlite"));
  try {
    const events = (db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n;
    expect(events).toBeGreaterThanOrEqual(3);
    dropAuditTriggers(db);
    db.prepare("UPDATE audit_events SET target_id = ?, detail_json = ? WHERE seq = 2").run(
      TAMPER_MARK,
      JSON.stringify({ note: TAMPER_MARK }),
    );
  } finally {
    db.close();
  }
}

describe("start-up notices about retention", () => {
  it("says how many matters are past their date, out of how many there are, and deletes nothing", async () => {
    const made = await folder({ expired: 2, fresh: 1 });
    const { server, notices } = await boot(made.dataDir);

    expect(aboutRetention(notices)).toEqual([
      "notice: 2 of 3 matters are past their retention date. The server deletes nothing. " +
        "Run pnpm parol:retain to see them.",
    ]);

    // The matters are all still there, and no deletion was recorded.
    expect(server.repo.listMatterIds().sort()).toEqual([...made.expired, ...made.fresh].sort());
    const events = server.repo.db
      .prepare("SELECT count(*) AS n FROM audit_events WHERE action IN (?, ?)")
      .get("matter.delete", "retention.run") as { n: number };
    expect(events.n).toBe(0);
  });

  it("uses the singular for one matter, and counts it out of the matters of the database", async () => {
    const one = await folder({ expired: 1 });
    expect(aboutRetention((await boot(one.dataDir)).notices)).toEqual([
      "notice: 1 of 1 matter is past its retention date. The server deletes nothing. " +
        "Run pnpm parol:retain to see it.",
    ]);

    const mixed = await folder({ expired: 1, fresh: 2 });
    expect(aboutRetention((await boot(mixed.dataDir)).notices)).toEqual([
      "notice: 1 of 3 matters is past its retention date. The server deletes nothing. " +
        "Run pnpm parol:retain to see it.",
    ]);
  });

  it("says nothing on a folder with no matter, and none on a folder whose matters are all in date", async () => {
    const empty = await folder();
    expect(aboutRetention((await boot(empty.dataDir)).notices)).toEqual([]);

    const kept = await folder({ fresh: 2 });
    const { server, notices } = await boot(kept.dataDir);
    expect(server.repo.listMatterIds()).toHaveLength(2);
    expect(aboutRetention(notices)).toEqual([]);
  });

  it("warns when the audit log does not verify, with the number of the event and the reason", async () => {
    const made = await folder({ fresh: 1 });
    tamper(made.dataDir);
    const { server, notices } = await boot(made.dataDir);

    expect(aboutRetention(notices)).toEqual([
      "warning: the audit log does not verify. It breaks at event 2 (hash_mismatch: this event's " +
        "content does not match its hash). Events before it that check out: 1. " +
        "Nothing after event 2 can be trusted. Run pnpm parol:audit-verify.",
    ]);
    // The warning is advice: the server started and answers.
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/healthz`).then((r) => r.status)).toString(),
    ).toBe("200");
  });

  it("gives the audit warning first and the retention notice second when both apply", async () => {
    const made = await folder({ expired: 1, fresh: 1 });
    tamper(made.dataDir);
    const lines = aboutRetention((await boot(made.dataDir)).notices);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^warning: the audit log does not verify\. It breaks at event 2 /);
    expect(lines[1]).toMatch(/^notice: 1 of 2 matters is past its retention date\./);
  });

  it("holds no name, no id and nothing read from an event, in any line the server printed", async () => {
    const made = await folder({ expired: 2, fresh: 1 });
    tamper(made.dataDir);
    const { notices, logs } = await boot(made.dataDir);
    expect(aboutRetention(notices)).toHaveLength(2);

    const printed = [...notices, ...logs].join("\n");
    for (const forbidden of [NAME_MARK, CLIENT_MARK, TAMPER_MARK, "mat_", ...made.expired])
      expect(printed).not.toContain(forbidden);
  });

  it("comes after the sweep of folders that no matter names", async () => {
    const made = await folder({ expired: 1 });
    const orphan = "mat_00000000000000ab";
    mkdirSync(join(made.dataDir, "matters", orphan), { recursive: true });
    writeFileSync(join(made.dataDir, "matters", orphan, "f_stray"), "x");

    const { order } = await boot(made.dataDir);
    const swept = order.findIndex((line) => line.includes(`matter ${orphan}: removed files`));
    const noticed = order.findIndex(
      (line) => line.includes("are past") || line.includes("is past"),
    );
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(noticed).toBeGreaterThan(swept);
  });
});

/** A repository that answers with what the test gives it, and records what it was asked. */
function fake(
  answers: {
    chain?: ReturnType<RetentionNoticeDeps["repo"]["verifyAuditChain"]> | Error;
    expired?: number | Error;
    total?: number | Error;
  } = {},
) {
  const asked: { expiredAt: Date[]; totalAsked: number } = { expiredAt: [], totalAsked: 0 };
  const give = <T>(value: T | Error): T => {
    if (value instanceof Error) throw value;
    return value;
  };
  const repo: RetentionNoticeDeps["repo"] = {
    verifyAuditChain: () => give(answers.chain ?? { ok: true as const, events: 9 }),
    listExpiredMatters: (at?: Date | string) => {
      asked.expiredAt.push(at as Date);
      const count = give(answers.expired ?? 0);
      return Array.from({ length: count }, () => ({}) as never);
    },
    listMatterIds: () => {
      asked.totalAsked += 1;
      return Array.from({ length: give(answers.total ?? 0) }, (_, i) => `mat_${i}`);
    },
  };
  return { repo, asked };
}

function report(
  answers: Parameters<typeof fake>[0] = {},
  now: Date = new Date("2026-11-11T12:00:00.000Z"),
): { lines: string[]; asked: ReturnType<typeof fake>["asked"] } {
  const { repo, asked } = fake(answers);
  const lines: string[] = [];
  reportRetentionNotices({ repo, now: () => now, notice: (line) => lines.push(line) });
  return { lines, asked };
}

describe("reportRetentionNotices", () => {
  it("prints nothing when the chain verifies and no matter is past its date, and does not count the matters", () => {
    const { lines, asked } = report({ expired: 0, total: 40 });
    expect(lines).toEqual([]);
    expect(asked.totalAsked).toBe(0);
  });

  it("judges the date at the clock it was given", () => {
    const at = new Date("2027-03-04T05:06:07.000Z");
    const { asked } = report({ expired: 1, total: 4 }, at);
    expect(asked.expiredAt.map((d) => d.toISOString())).toEqual([at.toISOString()]);
  });

  it("states the count with its denominator, in the plural and the singular", () => {
    expect(report({ expired: 25, total: 90 }).lines).toEqual([
      "notice: 25 of 90 matters are past their retention date. The server deletes nothing. " +
        "Run pnpm parol:retain to see them.",
    ]);
    expect(report({ expired: 1, total: 1 }).lines[0]).toMatch(/^notice: 1 of 1 matter is past its/);
    expect(report({ expired: 2, total: 2 }).lines[0]).toMatch(/^notice: 2 of 2 matters are past/);
  });

  it("names the first broken event, the reason code and its fixed words, and nothing else", () => {
    const { lines } = report({
      chain: { ok: false, firstBrokenSeq: 41, reason: "sequence_gap", events: 40 },
    });
    expect(lines).toEqual([
      "warning: the audit log does not verify. It breaks at event 41 (sequence_gap: an event is " +
        "missing here). Events before it that check out: 40. Nothing after event 41 can be " +
        "trusted. Run pnpm parol:audit-verify.",
    ]);
  });

  it("gives a fixed line, never the error, when a check cannot be made, and still makes the other", () => {
    const secret = new Error(`no such column ${TAMPER_MARK}`);
    const chainFails = report({ chain: secret, expired: 3, total: 5 }).lines;
    expect(chainFails).toEqual([
      "warning: the audit log could not be checked at start-up. Run pnpm parol:audit-verify.",
      expect.stringMatching(/^notice: 3 of 5 matters are past their retention date\./),
    ]);

    const countFails = report({
      chain: { ok: false, firstBrokenSeq: 2, reason: "truncated", events: 1 },
      expired: secret,
    }).lines;
    expect(countFails).toEqual([
      expect.stringMatching(/^warning: the audit log does not verify\. It breaks at event 2 /),
      "warning: the matters past their retention date could not be counted at start-up. " +
        "Run pnpm parol:retain to see them.",
    ]);

    const totalFails = report({ expired: 1, total: secret }).lines;
    expect(totalFails).toEqual([
      "warning: the matters past their retention date could not be counted at start-up. " +
        "Run pnpm parol:retain to see them.",
    ]);

    for (const line of [...chainFails, ...countFails, ...totalFails])
      expect(line).not.toContain(TAMPER_MARK);
  });
});
