import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { STORE_SCOPES } from "../../../../evals/src/parol/exposure/canary.js";
import { runRetention } from "../../src/retention/job.js";
import { openDatabase, tablesHoldingMatter } from "../../src/store/index.js";
import {
  censusOf,
  classifyTables,
  findTraces,
  rowsOfMatter,
  unfilledTables,
} from "../store/trace-scan.js";
import { everything, type Everything } from "./everything.js";
import { cleanup, makeWorld, type World } from "./support.js";

/**
 * After a matter is deleted, nothing of it is left: no row in any table, no file, no folder, and
 * none of the words that were written into it, in the tables or in the bytes of the data folder
 * (the database file and its log among them). The audit log keeps ids, hashes, counts and codes
 * and no text, and that is checked too.
 *
 * This is the criterion of W2.7: "after deletion no row or file of the matter remains (test scans
 * tables and the folder)". Every check here can fail: the last tests plant the traces one at a
 * time and show that the scan names each place, and the first ones show that a table nobody
 * classified, and a table the fixture never filled, stop the test.
 *
 * To add a table of matter rows: give it an entry in `STORE_SCOPES` (the exposure suite reads the
 * same list), a delete in `deleteMatter`, and the lines that fill it in `everything()`.
 */

afterAll(cleanup);

const DAY = 86_400_000;

/** A world laid out as a data folder, with two matters: `kept` first, `doomed` second. */
async function twoMatters(): Promise<{ w: World; kept: Everything; doomed: Everything }> {
  const w = makeWorld({ onDisk: true });
  const kept = await everything(w, "kept");
  // The kept matter outlives the doomed one under the job's clock below (the fixture gave both 45 days).
  w.repo.setRetention(kept.matterId, 90, { actorId: w.associate.userId });
  const doomed = await everything(w, "doomed");
  return { w, kept, doomed };
}

/** The audit events that name the matter, deletion event included. */
const eventsOf = (w: World, matterId: string): number =>
  w.repo.listAuditEvents({ matterId, limit: 10_000 }).length;

/** A time after the doomed matter's date (45 days) and before the kept one's (90 days). */
const JOB_CLOCK = (w: World, doomed: Everything): Date => {
  const until = Date.parse(w.repo.getMatter(doomed.matterId)!.retainUntil);
  return new Date(until + DAY);
};

describe("the classification of the tables", () => {
  it("leaves no table of the database unclassified, and none declared as holding no matter data that does", () => {
    const db = openDatabase();
    const classes = classifyTables(db);
    expect(classes.unclassified).toEqual([]);
    expect(classes.badGlobal).toEqual([]);
    // The lists are the exposure suite's own, so a table is classified once for both.
    expect(classes.scoped.sort()).toEqual(
      STORE_SCOPES.map(([table]) => table)
        .filter((table) => table !== "audit_events")
        .sort(),
    );
    expect(classes.audit).toEqual(["audit_events"]);
    db.close();
  });

  it("names a table nobody classified, a table declared global that is tied to a matter, and takes a scoped one", () => {
    const db = openDatabase();
    db.exec("CREATE TABLE zz_new (x TEXT)");
    expect(classifyTables(db).unclassified).toEqual(["zz_new"]);

    // By its column name.
    db.exec("CREATE TABLE zz_keyed (id TEXT PRIMARY KEY, finding_id TEXT, note TEXT)");
    // By its foreign key alone, under a column name the list does not know.
    db.exec(
      "CREATE TABLE zz_linked (id TEXT PRIMARY KEY, about TEXT REFERENCES findings(id) ON DELETE CASCADE)",
    );
    const declared = classifyTables(db, {
      noData: [...classifyTables(db).global, "zz_new", "zz_keyed", "zz_linked"],
    });
    expect(declared.unclassified).toEqual([]);
    expect(declared.badGlobal.sort()).toEqual(["zz_keyed", "zz_linked"]);

    // Added to the scopes, a table is scoped and no longer unclassified.
    const scoped = classifyTables(db, {
      scopes: [...STORE_SCOPES.map(([table]) => table), "zz_new"],
    });
    expect(scoped.scoped).toContain("zz_new");
    expect(scoped.unclassified).not.toContain("zz_new");
    db.close();
  });
});

describe("the fixture", () => {
  it("fills every table that holds a matter's rows, and the check can fail", async () => {
    const w = makeWorld({ onDisk: true });
    const e = await everything(w, "full");
    expect(
      unfilledTables(w.repo.db, e.matterId),
      "a table holds no row of the doomed matter: extend everything() so its deletion is tested",
    ).toEqual([]);
    // Each scoped table has at least one row of the matter, by its own clause.
    for (const table of classifyTables(w.repo.db).scoped)
      expect(rowsOfMatter(w.repo.db, table, e.matterId), table).toBeGreaterThan(0);

    // A scoped table that the fixture never fills is named.
    w.repo.db.exec("CREATE TABLE zz_unfilled (matter_id TEXT)");
    expect(
      unfilledTables(w.repo.db, e.matterId, [...STORE_SCOPES, ["zz_unfilled", "matter_id = ?"]]),
    ).toEqual(["zz_unfilled"]);
    // The marker is in the places that hold text by design, so the scans below have something to find.
    const before = await findTraces({
      db: w.repo.db,
      dataDir: w.root,
      matterId: e.matterId,
      ids: e.ids,
      markers: e.markers,
    });
    expect(before).toEqual(
      expect.arrayContaining([
        "matters.name (text)",
        "matters.client_legal_name (text)",
        "documents.title (text)",
        "source_spans.text (text)",
        "reviews.reason (text)",
        "reviews.edited_json (text)",
        "feedback.text (text)",
      ]),
    );
    // And in a file of the folder: the stored amendment, and the memo's Word package (its part).
    expect(before.filter((trace) => trace.endsWith("!word/document.xml (text)"))).toHaveLength(1);
    expect(
      before.some((trace) => /^matters\/mat_[0-9a-f]{16}\/f_[0-9a-f]{32} \(text\)$/.test(trace)),
    ).toBe(true);
    w.close();
  });
});

describe("a matter deleted by the service", () => {
  it("leaves no row, file or word of itself, and the matter kept beside it is whole", async () => {
    const { w, kept, doomed } = await twoMatters();
    const db = w.repo.db;
    const eventsBefore = (
      db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }
    ).n;
    // The scan is not blind: the doomed matter is found in many places before it goes.
    const trace = (m: Everything) =>
      findTraces({ db, dataDir: w.root, matterId: m.matterId, ids: m.ids, markers: m.markers });
    expect((await trace(doomed)).length).toBeGreaterThan(20);
    const keptBefore = await trace(kept);

    await w.services.matters.delete(w.grant(w.associate, doomed.matterId));

    // The audit log only grew, by the deletion event; nothing was taken out of it.
    expect((db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n).toBe(
      eventsBefore + 1,
    );
    expect(eventsOf(w, doomed.matterId)).toBeGreaterThan(1);

    // Nothing of the doomed matter in any table, any file, or the bytes of the database file.
    for (const table of classifyTables(db).scoped)
      expect(rowsOfMatter(db, table, doomed.matterId), table).toBe(0);
    expect(tablesHoldingMatter(db, doomed.matterId)).toEqual([]);
    expect(await trace(doomed)).toEqual([]);
    expect(existsSync(join(w.files.root, doomed.matterId))).toBe(false);

    // The kept matter is whole: its view loads, its files are there, and it is found as before.
    const keptView = w.services.matters.view(w.grant(w.associate, kept.matterId));
    expect(keptView.documents.length).toBe(2);
    for (const path of kept.storagePaths) expect(w.files.exists(path), path).toBe(true);
    // Found where it was, in the tables and the files. (The bytes of the database file move with the
    // compaction, so they are compared on their own: the words are still in them, which shows that
    // the byte scan is not blind.)
    const apartFromDatabase = (traces: string[]): string[] =>
      traces.filter((trace) => !trace.startsWith("parol.sqlite"));
    const keptAfter = await trace(kept);
    expect(apartFromDatabase(keptAfter)).toEqual(apartFromDatabase(keptBefore));
    expect(keptAfter.some((trace) => trace.startsWith("parol.sqlite"))).toBe(true);
    for (const table of classifyTables(db).scoped)
      expect(rowsOfMatter(db, table, kept.matterId), table).toBeGreaterThan(0);
    w.close();
  });

  it("has a census that returns to what it was before the doomed matter existed", async () => {
    const w = makeWorld({ onDisk: true });
    const kept = await everything(w, "kept");
    const before = censusOf(w.repo.db);
    const doomed = await everything(w, "doomed");
    expect(censusOf(w.repo.db)["matters"]).toBe((before["matters"] as number) + 1);
    await w.services.matters.delete(w.grant(w.associate, doomed.matterId));
    const after = censusOf(w.repo.db);
    const grew = Object.keys(after).filter((table) => after[table] !== before[table]);
    // Only the audit log differs, and by the events of the doomed matter, deletion included.
    expect(grew).toEqual(["audit_events"]);
    expect((after["audit_events"] as number) - (before["audit_events"] as number)).toBe(
      eventsOf(w, doomed.matterId),
    );
    expect(kept.matterId).not.toBe(doomed.matterId);
    w.close();
  });
});

describe("a matter deleted by the retention job", () => {
  it("leaves the same nothing, and the audit log holds the deletion and the run", async () => {
    const w = makeWorld({ onDisk: true });
    const kept = await everything(w, "kept");
    w.repo.setRetention(kept.matterId, 90, { actorId: w.associate.userId });
    const before = censusOf(w.repo.db);
    const doomed = await everything(w, "doomed");
    const clock = JOB_CLOCK(w, doomed);

    const report = runRetention(
      { repo: w.repo, files: w.files, now: () => clock },
      { apply: true, maxMatters: 25 },
    );
    expect(report).toMatchObject({
      expired: 1,
      deleted: 1,
      skipped: 0,
      failed: 0,
      compaction: "done",
    });
    expect(report.chain.ok).toBe(true);

    const after = censusOf(w.repo.db);
    const grew = Object.keys(after).filter((table) => after[table] !== before[table]);
    expect(grew).toEqual(["audit_events"]);
    // Its events, the deletion event among them, and the one event of the run.
    expect((after["audit_events"] as number) - (before["audit_events"] as number)).toBe(
      eventsOf(w, doomed.matterId) + 1,
    );
    for (const table of classifyTables(w.repo.db).scoped)
      expect(rowsOfMatter(w.repo.db, table, doomed.matterId), table).toBe(0);
    expect(tablesHoldingMatter(w.repo.db, doomed.matterId)).toEqual([]);
    expect(
      await findTraces({
        db: w.repo.db,
        dataDir: w.root,
        matterId: doomed.matterId,
        ids: doomed.ids,
        markers: doomed.markers,
      }),
    ).toEqual([]);
    expect(w.services.matters.view(w.grant(w.associate, kept.matterId)).documents.length).toBe(2);
    w.close();
  });
});

describe("the scan can fail, one trace at a time", () => {
  /** A deleted matter in a world on disk, and the scan of it. */
  async function afterDeletion() {
    const w = makeWorld({ onDisk: true });
    await everything(w, "kept");
    const doomed = await everything(w, "doomed");
    await w.services.matters.delete(w.grant(w.associate, doomed.matterId));
    const scan = () =>
      findTraces({
        db: w.repo.db,
        dataDir: w.root,
        matterId: doomed.matterId,
        ids: doomed.ids,
        markers: doomed.markers,
      });
    expect(await scan()).toEqual([]);
    return { w, doomed, scan };
  }

  /** What a scan returns names a place. It never shows a value. */
  const showsNoValue = (traces: string[], doomed: Everything): void => {
    for (const trace of traces) {
      expect(trace).not.toContain(doomed.marker);
      for (const id of doomed.ids.filter((id) => id !== doomed.matterId))
        expect(trace).not.toContain(id);
    }
  };

  it("(a) a row in a table that nobody taught the deletion about", async () => {
    const { w, doomed, scan } = await afterDeletion();
    w.repo.db.exec("CREATE TABLE zz_extra (matter_id TEXT)");
    const clean = censusOf(w.repo.db);
    w.repo.db.prepare("INSERT INTO zz_extra (matter_id) VALUES (?)").run(doomed.matterId);
    expect(await scan()).toEqual(["zz_extra.matter_id"]);
    // The residue guard sees it too, and so does the census (it grew) and the classification.
    expect(tablesHoldingMatter(w.repo.db, doomed.matterId)).toEqual(["zz_extra"]);
    expect(censusOf(w.repo.db)["zz_extra"]).toBe((clean["zz_extra"] as number) + 1);
    expect(classifyTables(w.repo.db).unclassified).toEqual(["zz_extra"]);
    w.close();
  });

  it("(b) a marker in a table that has no matter column at all", async () => {
    const { w, doomed, scan } = await afterDeletion();
    w.repo.db.exec("CREATE TABLE zz_notes (body TEXT)");
    w.repo.db.prepare("INSERT INTO zz_notes (body) VALUES (?)").run(`left: ${doomed.marker}`);
    const traces = await scan();
    // The table, and the bytes of the database file that now hold what was just written into it.
    expect(traces).toContain("zz_notes.body (text)");
    expect(traces.filter((trace) => !trace.startsWith("parol.sqlite"))).toEqual([
      "zz_notes.body (text)",
    ]);
    showsNoValue(traces, doomed);
    // The residue guard cannot see this one: it has no matter column. The scan of the text can.
    expect(tablesHoldingMatter(w.repo.db, doomed.matterId)).toEqual([]);
    w.close();
  });

  it("(c) a stray file in the matter's folder, and the folder itself", async () => {
    const { w, doomed, scan } = await afterDeletion();
    mkdirSync(join(w.files.root, doomed.matterId), { recursive: true });
    writeFileSync(join(w.files.root, doomed.matterId, "f_stray"), "nothing of the matter in it");
    const traces = await scan();
    expect(traces).toEqual([`matters/${doomed.matterId}`, `matters/${doomed.matterId}/f_stray`]);
    w.close();
  });

  it("(d) a copy of the words in a Word package elsewhere in the data folder, found inside its part", async () => {
    const { w, doomed, scan } = await afterDeletion();
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:t>${doomed.marker}</w:t>`);
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    // The deflated part does not show the words in the raw bytes: only reading the part finds them.
    expect(bytes.includes(Buffer.from(doomed.marker))).toBe(false);
    mkdirSync(join(w.root, "exports"));
    writeFileSync(join(w.root, "exports", "copy.docx"), bytes);
    const traces = await scan();
    expect(traces).toEqual(["exports/copy.docx!word/document.xml (text)"]);
    showsNoValue(traces, doomed);
    w.close();
  });

  it("(e) a word of the matter in the audit log, which may hold ids and no text", async () => {
    const { w, doomed, scan } = await afterDeletion();
    for (const name of ["audit_events_no_update"]) w.repo.db.exec(`DROP TRIGGER ${name}`);
    w.repo.db
      .prepare("UPDATE audit_events SET detail_json = ? WHERE seq = 1")
      .run(JSON.stringify({ note: doomed.marker }));
    const traces = await scan();
    // The text is found there, and the ids of the matter in the log are not a trace.
    expect(traces).toContain("audit_events.detail_json (text)");
    expect(traces.filter((trace) => trace.startsWith("audit_events."))).toEqual([
      "audit_events.detail_json (text)",
    ]);
    showsNoValue(traces, doomed);
    w.close();
  });

  it("(f) the matter's id in a column of a table that holds no matter data", async () => {
    const { w, doomed, scan } = await afterDeletion();
    w.repo.db.prepare("UPDATE eval_runs SET results_path = ?").run(`left-${doomed.matterId}.json`);
    expect(await scan()).toEqual(["eval_runs.results_path"]);
    w.close();
  });

  it("(g) a database file that was not compacted: its bytes, or its log, still hold the words", async () => {
    const w = makeWorld({ onDisk: true });
    await everything(w, "kept");
    const doomed = await everything(w, "doomed");
    // The service's deletion ends in a compaction. Here it is not run (the claim under test: the
    // compaction is what removes the words from the file and its log).
    (w.repo as { compact: () => void }).compact = () => {};
    await w.services.matters.delete(w.grant(w.associate, doomed.matterId));
    const traces = await findTraces({
      db: w.repo.db,
      dataDir: w.root,
      matterId: doomed.matterId,
      ids: doomed.ids,
      markers: doomed.markers,
    });
    expect(traces.filter((trace) => trace.startsWith("parol.sqlite"))).not.toEqual([]);
    expect(traces.every((trace) => trace.startsWith("parol.sqlite"))).toBe(true);
    w.close();
  });
});

describe("no name in the audit log", () => {
  it("holds ids, counts and codes after the job, and none of the words written into the matter", async () => {
    const w = makeWorld({ onDisk: true });
    await everything(w, "kept");
    const doomed = await everything(w, "doomed");
    const clock = JOB_CLOCK(w, doomed);
    w.repo.setRetention(
      w.repo.listMatterIds().find((id) => id !== doomed.matterId)!,
      90,
      { actorId: w.associate.userId },
    );
    runRetention(
      { repo: w.repo, files: w.files, now: () => clock },
      { apply: true, maxMatters: 25 },
    );
    const log = JSON.stringify(w.repo.listAuditEvents({ limit: 10_000 }));
    expect(log).not.toContain("ZQ-TRACE-doomed");
    // It does record that the matter was deleted by retention, when it was due, and the run.
    const deletion = w.repo.listAuditEvents({
      matterId: doomed.matterId,
      action: "matter.delete",
    })[0]!;
    expect(deletion.actorId).toBeNull();
    expect(deletion.detail).toMatchObject({ reason: "retention" });
    expect(typeof deletion.detail["retainUntil"]).toBe("string");
    expect(w.repo.latestAuditEvent("retention.run")?.detail).toMatchObject({
      mode: "apply",
      expired: 1,
      deleted: 1,
      refused: false,
    });
    w.close();
  });
});
