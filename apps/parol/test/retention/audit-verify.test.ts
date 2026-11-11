import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  describeAuditCheck,
  parseAnchor,
  parseAuditVerifyArgs,
  runAuditVerify,
} from "../../src/audit-verify.js";
import { DATABASE_FILE } from "../../src/cli-common.js";
import {
  DEFAULT_MIGRATIONS_DIR,
  appendAudit,
  checkAudit,
  createRepository,
  loadMigrationFiles,
  openDatabase,
  type Database,
} from "../../src/store/index.js";
import { cleanup, makeWorld, uploadCase, type World } from "../services/support.js";
import { dropAuditTriggers, rewriteChainFrom } from "../store/audit-tamper.js";

/**
 * `pnpm parol:audit-verify`: exits 0 for a log that holds, 1 for one that does not, 2 when it
 * cannot run; names the first broken event by number and a fixed reason; prints nothing that was
 * in a row; and writes nothing.
 */

afterAll(cleanup);

const MARK = "QZMARK-audit-4c1e";
const NEW_ACTOR = "usr_planted_actor";

/** A data folder whose log has events from real use, and no connection left open. */
async function folder(matters = 2): Promise<{ w: World; dataDir: string; ids: string[] }> {
  const w = makeWorld({ onDisk: true });
  const ids: string[] = [];
  for (let i = 0; i < matters; i++) {
    const created = w.services.matters.create(w.associate, {
      name: `Matter ${i} ${MARK}`,
      clientLegalName: `Client ${i} ${MARK}, Inc.`,
      playbookVersionId: w.playbookVersionId,
      reviewerUserId: w.reviewer.userId,
    });
    await uploadCase(w, created.id);
    ids.push(created.id);
  }
  w.repo.db.close();
  return { w, dataDir: w.root, ids };
}

async function verify(dataDir: string, argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAuditVerify(
    { PAROL_DATA_DIR: dataDir },
    argv,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out, err, text: out.join("\n") };
}

/** Runs `fn` on a read-write connection to the folder's database. */
function editing<T>(dataDir: string, fn: (db: Database) => T): T {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const sha = (dataDir: string): string =>
  createHash("sha256")
    .update(readFileSync(join(dataDir, DATABASE_FILE)))
    .digest("hex");

const headOf = (dataDir: string) =>
  editing(dataDir, (db) => createRepository(db).auditHead() as { seq: number; hash: string });

describe("a log that holds", () => {
  it("exits 0, says so, prints the head, and accounts for the matters", async () => {
    const { dataDir } = await folder();
    const head = headOf(dataDir);

    const { code, out, err } = await verify(dataDir);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe("Parol audit log check (read only)");
    expect(out).toContain(`Data folder: ${dataDir}`);
    expect(out).toContain(`Events: ${head.seq} (1 to ${head.seq})`);
    expect(out).toContain(
      "Chain: intact. Each event's hash matches its content and the event before it.",
    );
    expect(out).toContain(`Head: seq ${head.seq}, hash ${head.hash}`);
    expect(out).toContain(
      "Matters: 2 created, 2 present, 0 deleted with a deletion event; 0 gone without one, 0 present without a creation event.",
    );
    expect(out.at(-1)).toContain("--expect-head");
    expect(out.join("\n")).not.toContain(MARK);
    expect(out.some((line) => line.startsWith("FAILED"))).toBe(false);
  });

  it("exits 0 for a log with no events", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-verify-empty-"));
    try {
      openDatabase(join(parent, DATABASE_FILE)).close();
      const { code, out } = await verify(parent);
      expect(code).toBe(0);
      expect(out).toContain("Events: 0");
      expect(out).toContain("Head: none, the log has no events");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("prints one JSON object with --json", async () => {
    const { dataDir } = await folder(1);
    const { code, out } = await verify(dataDir, ["--json"]);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const head = headOf(dataDir);
    expect(JSON.parse(out[0]!)).toEqual({
      ok: true,
      events: head.seq,
      firstBrokenSeq: null,
      reason: null,
      head,
      anchor: null,
      matters: {
        created: 1,
        present: 1,
        deleted: 0,
        goneWithoutDeleteEvent: { count: 0, ids: [] },
        presentWithoutCreateEvent: { count: 0, ids: [] },
        deletedButPresent: { count: 0, ids: [] },
      },
    });
  });

  it("is not stopped by the matters being deleted: a deleted matter is accounted for by its event", async () => {
    const { w, dataDir, ids } = await folder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    createRepository(db).deleteMatter(ids[0]!, { actorId: null, reason: "retention" });
    db.close();
    const { code, out } = await verify(dataDir);
    expect(code).toBe(0);
    expect(out).toContain(
      "Matters: 2 created, 1 present, 1 deleted with a deletion event; 0 gone without one, 0 present without a creation event.",
    );
    void w;
  });
});

describe("a log that does not hold", () => {
  it("exits 1 for one altered row and names that row, with a fixed reason and none of its content", async () => {
    const { dataDir } = await folder();
    editing(dataDir, (db) => {
      dropAuditTriggers(db);
      db.prepare("UPDATE audit_events SET actor_id = ?, detail_json = ? WHERE seq = 5").run(
        NEW_ACTOR,
        JSON.stringify({ note: MARK }),
      );
    });

    const { code, out } = await verify(dataDir);

    expect(code).toBe(1);
    const failed = out.find((line) => line.startsWith("FAILED: the chain breaks"))!;
    expect(failed).toBe(
      "FAILED: the chain breaks at event 5: this event's content does not match its hash (hash_mismatch). 4 events before it check out. Nothing after event 5 can be trusted.",
    );
    const text = out.join("\n");
    expect(text).not.toContain(NEW_ACTOR);
    expect(text).not.toContain(MARK);
  });

  it("names the missing number for a deleted event, and the first number after the last for events cut from the end", async () => {
    const gap = await folder();
    editing(gap.dataDir, (db) => {
      dropAuditTriggers(db);
      db.exec("DELETE FROM audit_events WHERE seq = 4");
    });
    const missing = await verify(gap.dataDir);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain(
      "the chain breaks at event 4: an event is missing here (sequence_gap)",
    );

    const cut = await folder();
    const head = headOf(cut.dataDir);
    editing(cut.dataDir, (db) => {
      dropAuditTriggers(db);
      db.prepare("DELETE FROM audit_events WHERE seq > ?").run(head.seq - 2);
    });
    const truncated = await verify(cut.dataDir);
    expect(truncated.code).toBe(1);
    expect(truncated.text).toContain(
      `the chain breaks at event ${head.seq - 1}: the newest events are missing (truncated)`,
    );
  });

  it("names an inserted row that does not chain", async () => {
    const { dataDir } = await folder();
    const head = headOf(dataDir);
    editing(dataDir, (db) => {
      dropAuditTriggers(db);
      db.prepare(
        `INSERT INTO audit_events (at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash)
         VALUES ('2026-11-04T00:00:00.000Z', NULL, NULL, 'a.b', 'x', 'y', '{}', ?, ?)`,
      ).run("e".repeat(64), "f".repeat(64));
    });
    const { code, text } = await verify(dataDir);
    expect(code).toBe(1);
    expect(text).toContain(
      `the chain breaks at event ${head.seq + 1}: this event does not follow the one before it (prev_hash_mismatch)`,
    );
  });

  it("reports a matter that is gone with no deletion event, by its id", async () => {
    const { dataDir, ids } = await folder(3);
    editing(dataDir, (db) => {
      db.prepare("DELETE FROM matters WHERE id = ?").run(ids[1]!);
    });
    const { code, out } = await verify(dataDir);
    expect(code).toBe(1);
    expect(out).toContain(`FAILED: matters gone with no deletion event: ${ids[1]}`);
    expect(out).toContain(
      "Matters: 3 created, 2 present, 0 deleted with a deletion event; 1 gone without one, 0 present without a creation event.",
    );
    // The chain itself holds: only the matters do not add up.
    expect(out).toContain(
      "Chain: intact. Each event's hash matches its content and the event before it.",
    );
    expect(out.join("\n")).not.toContain(MARK);
  });

  it("says --json's reason and number for a broken chain", async () => {
    const { dataDir } = await folder(1);
    editing(dataDir, (db) => {
      dropAuditTriggers(db);
      db.exec("UPDATE audit_events SET action = 'review.forged' WHERE seq = 2");
    });
    const { code, out } = await verify(dataDir, ["--json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: false,
      firstBrokenSeq: 2,
      reason: "hash_mismatch",
      events: 1,
    });
  });
});

describe("--expect-head", () => {
  it("holds for the head it was given, and for an earlier event after the log has grown", async () => {
    const { dataDir } = await folder(1);
    const head = headOf(dataDir);
    const same = await verify(dataDir, ["--expect-head", `${head.seq}:${head.hash}`]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("Anchor: the event you named is in the log with the hash you gave.");

    editing(dataDir, (db) => {
      appendAudit(db, {
        at: "2026-11-05T00:00:00.000Z",
        actorId: null,
        matterId: null,
        action: "retention.run",
        targetType: "retention",
        targetId: "retention",
        detail: {},
      });
    });
    const later = await verify(dataDir, [`--expect-head=${head.seq}:${head.hash}`]);
    expect(later.code).toBe(0);
  });

  it("fails after a rewrite that recomputed every later hash, which the chain alone does not see", async () => {
    const { dataDir } = await folder(1);
    const head = headOf(dataDir);
    editing(dataDir, (db) => {
      rewriteChainFrom(db, 3, (row) => {
        row.detail_json = JSON.stringify({ rewritten: true });
      });
    });
    // By itself the log verifies: the limit the output says it has.
    const alone = await verify(dataDir);
    expect(alone.code).toBe(0);
    // Against the head that was kept elsewhere, it does not.
    const anchored = await verify(dataDir, ["--expect-head", `${head.seq}:${head.hash}`]);
    expect(anchored.code).toBe(1);
    expect(anchored.text).toContain(
      "FAILED: the anchor does not hold: the event the anchor names has a different hash (anchor_mismatch).",
    );
  });

  it("fails after events are cut from the end, even when the highest number issued was edited to match", async () => {
    const { dataDir } = await folder(1);
    const head = headOf(dataDir);
    editing(dataDir, (db) => {
      dropAuditTriggers(db);
      db.prepare("DELETE FROM audit_events WHERE seq > ?").run(head.seq - 3);
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_events'").run(
        head.seq - 3,
      );
    });
    // The chain, with its head edited as well, is clean.
    const alone = await verify(dataDir);
    expect(alone.code).toBe(0);
    const anchored = await verify(dataDir, ["--expect-head", `${head.seq}:${head.hash}`]);
    expect(anchored.code).toBe(1);
    expect(anchored.text).toContain(
      "FAILED: the anchor does not hold: the event the anchor names is not in the log (anchor_missing).",
    );
  });

  it("is a usage error when it is not an event number, a colon and 64 lower-case hex digits", async () => {
    const { dataDir } = await folder(1);
    for (const value of [
      "",
      "abc",
      "5:xyz",
      `0:${"a".repeat(64)}`,
      `5:${"A".repeat(64)}`,
      `5:${"a".repeat(63)}`,
      `x:${"a".repeat(64)}`,
    ]) {
      const { code, err } = await verify(dataDir, ["--expect-head", value]);
      expect(code, value).toBe(2);
      expect(err.join("\n")).toContain("--expect-head needs the event number");
    }
    expect((await verify(dataDir, ["--expect-head"])).code).toBe(2);
    expect(parseAnchor(`12:${"0".repeat(64)}`)).toEqual({ seq: 12, hash: "0".repeat(64) });
  });
});

describe("it writes nothing", () => {
  it("leaves the database file byte for byte as it was, and the log as many events", async () => {
    const { dataDir } = await folder();
    const before = sha(dataDir);
    await verify(dataDir);
    await verify(dataDir, ["--json"]);
    await verify(dataDir, ["--expect-head", `1:${"a".repeat(64)}`]);
    expect(sha(dataDir)).toBe(before);
  });

  it("applies no migration to a database that is one migration behind", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-verify-behind-"));
    try {
      const files = loadMigrationFiles();
      const old = join(parent, "migrations");
      mkdirSync(old);
      for (const file of files.slice(0, files.length - 1)) {
        const name = `${String(file.version).padStart(3, "0")}_${file.name}.sql`;
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(old, name));
      }
      const location = join(parent, DATABASE_FILE);
      const db = openDatabase(location, { migrationsDir: old });
      createRepository(db).seedDemoUsers();
      appendAudit(db, {
        at: "2026-11-04T00:00:00.000Z",
        actorId: null,
        matterId: null,
        action: "member.add",
        targetType: "user",
        targetId: "usr_demo_admin",
        detail: {},
      });
      db.close();
      const versions = (): number[] => {
        const reader = openDatabase(location, { migrationsDir: old });
        try {
          return (
            reader.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
              version: number;
            }[]
          ).map((row) => row.version);
        } finally {
          reader.close();
        }
      };
      expect(versions()).toEqual(files.slice(0, files.length - 1).map((f) => f.version));

      const { code } = await verify(parent);
      expect(code).toBe(0);
      expect(versions()).toEqual(files.slice(0, files.length - 1).map((f) => f.version));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("creates nothing when there is no database, and exits 2", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-verify-none-"));
    try {
      const missing = join(parent, "nowhere");
      const { code, err, out } = await verify(missing);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("there is no database in the data folder");
      expect(existsSync(missing)).toBe(false);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("exits 2 for a file that is not a Parol database, and for an SQLite file that has no audit log", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-verify-notdb-"));
    try {
      writeFileSync(join(parent, DATABASE_FILE), `${MARK} this is not an SQLite file at all`);
      const garbage = await verify(parent);
      expect(garbage.code).toBe(2);
      expect(garbage.err.join("\n")).toContain("Parol audit check cannot run:");
      expect(garbage.err.join("\n")).not.toContain(MARK);

      const other = mkdtempSync(join(tmpdir(), "parol-verify-other-"));
      try {
        const db = new DatabaseSync(join(other, DATABASE_FILE));
        db.exec("CREATE TABLE unrelated (x TEXT)");
        db.close();
        const foreign = await verify(other);
        expect(foreign.code).toBe(2);
        expect(foreign.err.join("\n")).toContain("StoreError: the file is not a Parol database");
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("exits 2 for a usage error and says which option, never its value", async () => {
    const { dataDir } = await folder(1);
    for (const argv of [["--surprise"], [MARK], ["--apply"]]) {
      const { code, err } = await verify(dataDir, argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(err.join("\n")).toContain("usage: pnpm parol:audit-verify");
      expect(err.join("\n")).not.toContain(MARK);
    }
    expect(parseAuditVerifyArgs(["--", "--json"])).toEqual({ json: true });
  });
});

describe("the words of the output", () => {
  it("name the matters that are unaccounted for by id, and cut a long list", async () => {
    const { dataDir } = await folder(1);
    const check = editing(dataDir, (db) => checkAudit(db));
    const many = {
      ...check,
      ok: false,
      matters: {
        ...check.matters,
        goneWithoutDeleteEvent: { count: 23, ids: ["mat_a", "mat_b"] },
      },
    };
    expect(describeAuditCheck(many, "/d").join("\n")).toContain(
      "matters gone with no deletion event: mat_a, mat_b and 21 more",
    );
  });
});
