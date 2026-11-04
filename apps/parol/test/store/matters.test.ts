import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { MATTER_STATUSES, RUN_STATUSES, type MatterStatus, type RunStatus } from "../../src/contracts.js";
import {
  ConflictError,
  InputsIncompleteError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  canRunTransition,
  canTransition,
  type NewVersionInput,
} from "../../src/store/index.js";
import { ACTORS, addMatter, buildSpans, fakePath, makeWorld, reviewable, startRun, type World } from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const version = (matterId: string, text: string, over: Partial<NewVersionInput> = {}): NewVersionInput => ({
  mediaType: "txt",
  fileSha256: sha256Hex(`file:${text}`),
  textSha256: sha256Hex(`text:${text}`),
  byteSize: text.length,
  statedDate: null,
  storagePath: fakePath(matterId),
  ...over,
});

describe("demo users", () => {
  it("seeds the four identities with fixed ids, and is safe to run at every boot", () => {
    const users = w.repo.listUsers();
    expect(users.map((u) => [u.id, u.globalRole]).sort()).toEqual(
      [
        [ACTORS.associate, "member"],
        [ACTORS.reviewer, "member"],
        [ACTORS.legalEngineer, "legal_engineer"],
        [ACTORS.admin, "admin"],
      ].sort(),
    );
    expect(users.every((u) => u.demo)).toBe(true);
    w.db.prepare("UPDATE users SET display_name = 'Renamed' WHERE id = ?").run(ACTORS.admin);
    w.repo.seedDemoUsers();
    expect(w.repo.getUser(ACTORS.admin)?.displayName).toBe("Renamed");
    expect(w.repo.listUsers()).toHaveLength(4);
  });

  it("returns undefined for an unknown user", () => {
    expect(w.repo.getUser("usr_nobody")).toBeUndefined();
  });
});

describe("createMatter", () => {
  it("creates a draft with the creator as associate, a retention date, and audit events", () => {
    const m = w.repo.createMatter({ name: "  Acme / Beta NDA ", clientLegalName: "Acme Corp", createdBy: ACTORS.associate });
    expect(m).toMatchObject({
      name: "Acme / Beta NDA",
      clientLegalName: "Acme Corp",
      status: "draft",
      playbookVersionId: null,
      currentInputsSha256: null,
      synthetic: true,
      createdBy: ACTORS.associate,
      deletedAt: null,
    });
    expect(m.id).toMatch(/^mat_[0-9a-f]{16}$/);
    expect(w.repo.getMember(m.id, ACTORS.associate)).toMatchObject({ role: "associate", grantedBy: ACTORS.associate });
    expect(Date.parse(m.retainUntil) - Date.parse(m.createdAt)).toBe(30 * 86_400_000);
    const actions = w.repo.listAuditEvents({ matterId: m.id }).map((e) => e.action);
    expect(actions).toEqual(["matter.create", "member.add"]);
    expect(w.repo.listAuditEvents({ matterId: m.id })[0]?.actorId).toBe(ACTORS.associate);
  });

  it("honours retainDays and synthetic", () => {
    const m = w.repo.createMatter({
      name: "n",
      clientLegalName: "c",
      createdBy: ACTORS.associate,
      synthetic: false,
      retainDays: 7,
    });
    expect(m.synthetic).toBe(false);
    expect(Date.parse(m.retainUntil) - Date.parse(m.createdAt)).toBe(7 * 86_400_000);
  });

  it("refuses bad input without echoing it", () => {
    const secret = "SECRET-CLIENT\u0000";
    const attempt = (over: object) =>
      w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate, ...over });
    for (const over of [
      { name: "" },
      { name: "   " },
      { clientLegalName: "x".repeat(201) },
      { clientLegalName: secret },
      { name: "line\nbreak" },
      { retainDays: 0 },
      { retainDays: 1.5 },
    ]) {
      let error: unknown;
      try {
        attempt(over);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(over)).toBeInstanceOf(ValidationError);
      expect((error as Error).message).not.toContain("SECRET-CLIENT");
    }
    expect(() => attempt({ createdBy: "usr_nobody" })).toThrow(NotFoundError);
    expect(w.repo.listMattersForUser(ACTORS.associate)).toHaveLength(0);
  });

  it("lists matters for a member with their role, newest first, and for nobody else", () => {
    const a = w.repo.createMatter({ name: "a", clientLegalName: "c", createdBy: ACTORS.associate });
    w.clock.tick();
    const b = w.repo.createMatter({ name: "b", clientLegalName: "c", createdBy: ACTORS.associate });
    w.repo.addMember(b.id, ACTORS.reviewer, "reviewer", { actorId: ACTORS.associate });
    expect(w.repo.listMattersForUser(ACTORS.associate).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(w.repo.listMattersForUser(ACTORS.reviewer)).toMatchObject([{ id: b.id, role: "reviewer" }]);
    expect(w.repo.listMattersForUser(ACTORS.admin)).toEqual([]);
  });
});

describe("members", () => {
  it("adds a member once, audits it, and refuses duplicates and strangers", () => {
    const m = addMatter(w);
    const member = w.repo.addMember(m.id, ACTORS.reviewer, "reviewer", { actorId: ACTORS.associate });
    expect(member).toMatchObject({ role: "reviewer", grantedBy: ACTORS.associate });
    expect(w.repo.listMembers(m.id).map((x) => x.userId).sort()).toEqual([ACTORS.associate, ACTORS.reviewer].sort());
    expect(() => w.repo.addMember(m.id, ACTORS.reviewer, "viewer", { actorId: ACTORS.associate })).toThrow(ConflictError);
    expect(() => w.repo.addMember(m.id, "usr_nobody", "viewer", { actorId: ACTORS.associate })).toThrow(NotFoundError);
    expect(() => w.repo.addMember(m.id, ACTORS.admin, "owner" as never, { actorId: ACTORS.associate })).toThrow(ValidationError);
    expect(() => w.repo.addMember("mat_0000000000000000", ACTORS.admin, "viewer", { actorId: ACTORS.associate })).toThrow(NotFoundError);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "member.add" })).toHaveLength(2);
  });
});

describe("the matter state machine", () => {
  const diagram: [MatterStatus, MatterStatus][] = [
    ["draft", "ready"],
    ["ready", "running"],
    ["running", "in_review"],
    ["running", "ready"],
    ["in_review", "review_complete"],
    ["review_complete", "exported"],
    ["in_review", "stale"],
    ["review_complete", "stale"],
    ["exported", "stale"],
    ["stale", "running"],
    ["draft", "deleted"],
    ["ready", "deleted"],
    ["stale", "deleted"],
    ["exported", "deleted"],
  ];
  // Documented additions, each with its reason in states.ts.
  const additions: [MatterStatus, MatterStatus][] = [
    ["review_complete", "in_review"],
    ["running", "stale"],
    ["ready", "draft"],
    ["in_review", "deleted"],
    ["review_complete", "deleted"],
  ];

  it("allows exactly the diagram's edges and the documented additions", () => {
    const allowed = new Set([...diagram, ...additions].map(([a, b]) => `${a}>${b}`));
    for (const from of MATTER_STATUSES)
      for (const to of MATTER_STATUSES)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
  });

  it("never leaves deleted, and never allows deleting a running matter", () => {
    for (const to of MATTER_STATUSES) expect(canTransition("deleted", to)).toBe(false);
    expect(canTransition("running", "deleted")).toBe(false);
  });

  it("allows exactly the run diagram's edges", () => {
    const active: RunStatus[] = ["queued", "ingesting", "extracting", "retrieving", "analyzing", "verifying"];
    const next: Record<string, RunStatus> = {
      queued: "ingesting",
      ingesting: "extracting",
      extracting: "retrieving",
      retrieving: "analyzing",
      analyzing: "verifying",
      verifying: "succeeded",
    };
    const allowed = new Set<string>();
    for (const s of active) {
      allowed.add(`${s}>${next[s]}`);
      allowed.add(`${s}>failed`);
      allowed.add(`${s}>cancelled`);
      allowed.add(`${s}>superseded`);
    }
    allowed.add("succeeded>superseded");
    allowed.add("failed>queued");
    for (const from of RUN_STATUSES)
      for (const to of RUN_STATUSES)
        expect(canRunTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
  });

  it("guards setMatterStatus with the edge and with the state it claims", () => {
    const m = addMatter(w, { pinPlaybook: false });
    expect(w.repo.getMatter(m.id)?.status).toBe("draft");
    expect(() => w.repo.setMatterStatus(m.id, "ready", { actorId: ACTORS.associate })).toThrow(InputsIncompleteError);
    expect(() => w.repo.setMatterStatus(m.id, "exported", { actorId: ACTORS.associate })).toThrow(InvalidTransitionError);
    expect(() => w.repo.setMatterStatus(m.id, "deleted", { actorId: ACTORS.associate })).toThrow(ValidationError);
    expect(() => w.repo.setMatterStatus("mat_0000000000000000", "ready", { actorId: null })).toThrow(NotFoundError);

    w.repo.setPlaybookVersion(m.id, w.playbook.id, { actorId: ACTORS.associate });
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
    expect(() => w.repo.setMatterStatus(m.id, "running", { actorId: null })).toThrow(/no run in flight/);
    // Same status is a no-op, not an error.
    expect(w.repo.setMatterStatus(m.id, "ready", { actorId: null }).status).toBe("ready");
  });

  it("will not call a matter review_complete or exported while findings are undecided", () => {
    const r = reviewable(w);
    expect(w.repo.getMatter(r.m.id)?.status).toBe("in_review");
    expect(() => w.repo.setMatterStatus(r.m.id, "review_complete", { actorId: null })).toThrow(/undecided/);
    expect(() => w.repo.setMatterStatus(r.m.id, "exported", { actorId: null })).toThrow(InvalidTransitionError);
  });

  it("records a matter.status event for a change it makes", () => {
    const m = addMatter(w, { pinPlaybook: false });
    w.repo.setPlaybookVersion(m.id, w.playbook.id, { actorId: ACTORS.associate });
    w.repo.setMatterStatus(m.id, "draft", { actorId: ACTORS.associate });
    const event = w.repo.listAuditEvents({ matterId: m.id, action: "matter.status" })[0];
    expect(event?.detail).toEqual({ from: "ready", to: "draft" });
  });
});

describe("documents", () => {
  it("labels documents D1, D2, D3 in the order added, with one NDA and at most two amendments", () => {
    const matter = w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate });
    const add = (kind: "nda" | "amendment", title: string) =>
      w.repo.addDocument(matter.id, { kind, title, version: version(matter.id, title) }, { actorId: ACTORS.associate });
    expect(add("amendment", "Early amendment").document).toMatchObject({ ordinal: 1, label: "D1" });
    expect(add("nda", "The NDA").document).toMatchObject({ ordinal: 2, label: "D2" });
    expect(add("amendment", "Second amendment").document).toMatchObject({ ordinal: 3, label: "D3" });
    expect(() => add("amendment", "Third amendment")).toThrow(ConflictError);
    expect(() => add("nda", "Second NDA")).toThrow(/already has an NDA/);
    expect(w.repo.listDocuments(matter.id).map((d) => d.label)).toEqual(["D1", "D2", "D3"]);
  });

  it("allows only one NDA, and reports the reason", () => {
    const matter = w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate });
    const add = (kind: "nda" | "amendment") =>
      w.repo.addDocument(matter.id, { kind, title: kind, version: version(matter.id, `${kind}${Math.random()}`) }, { actorId: ACTORS.associate });
    add("nda");
    expect(() => add("nda")).toThrowError(/already has an NDA/);
    add("amendment");
    add("amendment");
    expect(() => add("amendment")).toThrowError(/already has two amendments/);
  });

  it("reuses the smallest free label after a document is removed", () => {
    const m = addMatter(w, { amendment: true });
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    expect(w.repo.getDocument(m.id, amendment.documentId)?.label).toBe("D2");
    w.repo.removeDocument(m.id, amendment.documentId, { actorId: ACTORS.associate });
    const again = w.repo.addDocument(
      m.id,
      { kind: "amendment", title: "Replacement", version: version(m.id, "replacement") },
      { actorId: ACTORS.associate },
    );
    expect(again.document.label).toBe("D2");
  });

  it("numbers versions per document and clears the operative flag when a version arrives", () => {
    const m = addMatter(w);
    const v2 = w.repo.addVersion(m.id, m.nda.documentId, version(m.id, "v2 text"), { actorId: ACTORS.associate });
    expect(v2).toMatchObject({ versionNo: 2, operative: false });
    expect(w.repo.getVersion(m.id, m.nda.versionId)?.operative).toBe(false);
    expect(w.repo.listOperativeDocuments(m.id)).toEqual([]);
    expect(w.repo.computeInputsDigest(m.id)).toBeNull();
    expect(w.repo.getMatter(m.id)?.status).toBe("draft");

    w.repo.setOperativeVersion(m.id, v2.id, { actorId: ACTORS.associate });
    expect(w.repo.listOperativeDocuments(m.id).map((o) => o.version.id)).toEqual([v2.id]);
    expect(w.repo.computeInputsDigest(m.id)).not.toBeNull();
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
  });

  it("can make a new version operative in the same step", () => {
    const m = addMatter(w);
    const v2 = w.repo.addVersion(m.id, m.nda.documentId, version(m.id, "v2", { operative: true }), { actorId: ACTORS.associate });
    expect(v2.operative).toBe(true);
    expect(w.repo.getVersion(m.id, m.nda.versionId)?.operative).toBe(false);
  });

  it("keeps exactly one operative version per document when switching", () => {
    const m = addMatter(w);
    const v2 = w.repo.addVersion(m.id, m.nda.documentId, version(m.id, "v2"), { actorId: ACTORS.associate });
    w.repo.setOperativeVersion(m.id, v2.id, { actorId: ACTORS.associate });
    w.repo.setOperativeVersion(m.id, m.nda.versionId, { actorId: ACTORS.associate });
    const flags = w.repo.listVersions(m.id, m.nda.documentId).map((v) => [v.versionNo, v.operative]);
    expect(flags).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("treats choosing the version that is already operative as nothing at all", () => {
    const m = addMatter(w);
    const before = w.repo.listAuditEvents({ matterId: m.id }).length;
    w.repo.setOperativeVersion(m.id, m.nda.versionId, { actorId: ACTORS.associate });
    expect(w.repo.listAuditEvents({ matterId: m.id })).toHaveLength(before);
  });

  it("validates stated dates", () => {
    const m = addMatter(w);
    for (const bad of ["2026-02-30", "Feb 1 2026", "2026-1-1", "2026-13-01", "", "2026-01-01T00:00:00Z"])
      expect(() => w.repo.setStatedDate(m.id, m.nda.versionId, bad, { actorId: ACTORS.associate }), bad).toThrow(ValidationError);
    expect(w.repo.setStatedDate(m.id, m.nda.versionId, "2026-03-01", { actorId: ACTORS.associate }).statedDate).toBe("2026-03-01");
    expect(w.repo.setStatedDate(m.id, m.nda.versionId, null, { actorId: ACTORS.associate }).statedDate).toBeNull();
    expect(w.repo.getVersion(m.id, m.nda.versionId)?.statedDate).toBeNull();
  });

  it("refuses version input that is malformed or points outside the matter's folder", () => {
    const m = addMatter(w);
    const other = addMatter(w);
    const add = (over: Partial<NewVersionInput>) =>
      w.repo.addVersion(m.id, m.nda.documentId, { ...version(m.id, "x"), ...over }, { actorId: ACTORS.associate });
    expect(() => add({ fileSha256: "nothex" })).toThrow(ValidationError);
    expect(() => add({ textSha256: "A".repeat(64) })).toThrow(ValidationError);
    expect(() => add({ byteSize: -1 })).toThrow(ValidationError);
    expect(() => add({ byteSize: 1.5 })).toThrow(ValidationError);
    expect(() => add({ mediaType: "pdf" as never })).toThrow(ValidationError);
    expect(() => add({ statedDate: "tomorrow" })).toThrow(ValidationError);
    // A version cannot point at another matter's file, or climb out of its own folder.
    expect(() => add({ storagePath: fakePath(other.id) })).toThrow(/own folder/);
    expect(() => add({ storagePath: `${m.id}/../${other.id}/f_x` })).toThrow(ValidationError);
    expect(() => add({ storagePath: `${m.id}/..` })).toThrow(ValidationError);
    expect(() => add({ storagePath: `${m.id}/a/b` })).toThrow(ValidationError);
    expect(() => add({ storagePath: "/etc/passwd" })).toThrow(ValidationError);
    expect(w.repo.listVersions(m.id)).toHaveLength(1);
  });

  it("finds a version by file hash, and by text hash, inside one matter only", () => {
    const m = addMatter(w);
    const other = addMatter(w, { name: "other" });
    const v = w.repo.getVersion(m.id, m.nda.versionId);
    expect(w.repo.findVersionByFileSha256(m.id, v?.fileSha256 as string)?.id).toBe(m.nda.versionId);
    expect(w.repo.findVersionByTextSha256(m.id, v?.textSha256 as string)?.id).toBe(m.nda.versionId);
    expect(w.repo.findVersionByFileSha256(m.id, sha256Hex("unknown"))).toBeUndefined();
    // The same bytes in another matter are that matter's business.
    const twin = w.repo.addVersion(other.id, other.nda.documentId, version(other.id, "t", { fileSha256: v?.fileSha256 as string }), { actorId: ACTORS.associate });
    expect(w.repo.findVersionByFileSha256(other.id, v?.fileSha256 as string)?.id).toBe(twin.id);
    expect(w.repo.findVersionByFileSha256(m.id, v?.fileSha256 as string)?.matterId).toBe(m.id);
  });

  it("removes a document with its versions and spans, and returns the files to delete", () => {
    const m = addMatter(w, { amendment: true });
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    const paths = w.repo.removeDocument(m.id, amendment.documentId, { actorId: ACTORS.associate });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.startsWith(`${m.id}/`)).toBe(true);
    expect(w.repo.getDocument(m.id, amendment.documentId)).toBeUndefined();
    expect(w.repo.listSpans(m.id, [amendment.versionId])).toEqual([]);
    expect(w.repo.listAnnotations(m.id, [amendment.versionId])).toEqual([]);
    expect(w.repo.listSpans(m.id, [m.nda.versionId])).toHaveLength(4);
  });
});

describe("spans and annotations", () => {
  it("stores spans and returns them in document, then paragraph order, with where they sit", () => {
    const m = addMatter(w, { amendment: true });
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    const spans = w.repo.listSpans(m.id, [amendment.versionId, m.nda.versionId]);
    expect(spans.map((s) => s.label)).toEqual(["D1-p0", "D1-p1", "D1-p2", "D1-p3", "D2-p0", "D2-p1"]);
    const clause = w.repo.getSpan(m.id, m.nda.spanIds[2] as string);
    expect(clause).toMatchObject({
      id: m.nda.spanIds[2],
      label: "D1-p2",
      docLabel: "D1",
      paragraphIndex: 2,
      clauseId: "c3",
      clauseNumber: "6.1",
      documentTitle: "Mutual NDA",
      documentKind: "nda",
      versionNo: 1,
      matterId: m.id,
    });
    expect(clause?.textSha256).toBe(sha256Hex(clause?.text as string));
    expect(w.repo.listSpans(m.id, [])).toEqual([]);
  });

  it("round-trips annotations", () => {
    const m = addMatter(w, { amendment: true });
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    expect(w.repo.listAnnotations(m.id, [amendment.versionId])).toEqual([
      { kind: "cross_reference", spanId: amendment.spanIds[1], target: "6.1", verb: "deletes" },
    ]);
    expect(w.repo.listAnnotations(m.id, [m.nda.versionId])).toEqual([
      { kind: "defines_term", spanId: m.nda.spanIds[1], term: "Confidential Information" },
    ]);
  });

  it("is idempotent for identical spans and refuses different ones", () => {
    const m = addMatter(w);
    const same = buildSpans(m.nda.versionId, "D1", m.nda.texts);
    expect(w.repo.insertSpans(m.id, same)).toEqual({ inserted: 0, skipped: 4 });
    const changed = buildSpans(m.nda.versionId, "D1", [...m.nda.texts.slice(0, 3), "9.2 This Agreement is governed by Ruritanian law."]);
    expect(() => w.repo.insertSpans(m.id, changed)).toThrow(ConflictError);
    expect(w.repo.getSpan(m.id, m.nda.spanIds[3] as string)?.text).toBe(m.nda.texts[3]);
    expect(w.repo.listSpans(m.id, [m.nda.versionId])).toHaveLength(4);
  });

  it("validates spans and annotations before writing anything", () => {
    const m = addMatter(w, { spans: false });
    const good = buildSpans(m.nda.versionId, "D1", m.nda.texts);
    const bad = (mutate: (s: (typeof good)[number]) => object) => [...good.slice(0, 2), { ...good[2], ...mutate(good[2] as never) }];
    expect(() => w.repo.insertSpans(m.id, bad(() => ({ id: `${m.nda.versionId}:p9` })) as never)).toThrow(/span id must be/);
    expect(() => w.repo.insertSpans(m.id, bad(() => ({ textSha256: sha256Hex("different") })) as never)).toThrow(/hash/);
    expect(() => w.repo.insertSpans(m.id, bad(() => ({ paragraphIndex: -1 })) as never)).toThrow(ValidationError);
    expect(() => w.repo.insertSpans(m.id, bad(() => ({ documentVersionId: "ver_unknown", id: "ver_unknown:p2" })) as never)).toThrow(NotFoundError);
    expect(() =>
      w.repo.insertSpans(m.id, good, [{ kind: "cross_reference", spanId: good[0]?.id as string, target: "6.1", verb: "burns" as never }]),
    ).toThrow(ValidationError);
    expect(() =>
      w.repo.insertSpans(m.id, good, [{ kind: "uses_term", spanId: "ver_x:p0", term: "Term" }]),
    ).toThrow(NotFoundError);
    // Nothing from the failed attempts was kept.
    expect(w.repo.listSpans(m.id, [m.nda.versionId])).toEqual([]);
    expect(w.repo.insertSpans(m.id, good)).toEqual({ inserted: 4, skipped: 0 });
  });

  it("will not store spans for a version of another matter", () => {
    const a = addMatter(w, { spans: false });
    const b = addMatter(w, { spans: false });
    const foreign = buildSpans(b.nda.versionId, "D1", b.nda.texts);
    expect(() => w.repo.insertSpans(a.id, foreign)).toThrow(NotFoundError);
    expect(w.repo.listSpans(b.id, [b.nda.versionId])).toEqual([]);
  });

  it("reports whether a version has spans", () => {
    const m = addMatter(w, { spans: false });
    expect(w.repo.hasSpans(m.id, m.nda.versionId)).toBe(false);
    w.repo.insertSpans(m.id, buildSpans(m.nda.versionId, "D1", m.nda.texts));
    expect(w.repo.hasSpans(m.id, m.nda.versionId)).toBe(true);
  });
});

describe("a started run keeps the matter's document list honest", () => {
  it("supersedes a run that is in flight when one of its documents is removed", () => {
    const m = addMatter(w, { amendment: true });
    const run = startRun(w, m);
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    w.repo.removeDocument(m.id, amendment.documentId, { actorId: ACTORS.associate });
    expect(w.repo.getRun(m.id, run.id)?.status).toBe("superseded");
    expect(w.repo.getMatter(m.id)?.status).toBe("stale");
  });
});
