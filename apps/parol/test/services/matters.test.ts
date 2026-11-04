import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRequestError } from "@clausewise/llm";
import { ForbiddenError } from "../../src/services/errors.js";
import {
  baseWorld,
  cleanup,
  gate,
  makeWorld,
  newMatter,
  reviewed,
  uploadCase,
  type World,
} from "./support.js";

afterAll(cleanup);

const errorOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

/** Every table and column that mentions `needle`, found by reading the whole database. */
function mentions(w: World, needle: string): string[] {
  const found: string[] = [];
  const tables = w.repo.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = w.repo.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = w.repo.db
        .prepare(
          `SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`,
        )
        .get(needle) as { n: number };
      if (row.n > 0) found.push(`${name}.${column.name}`);
    }
  }
  return found;
}

describe("create and list", () => {
  it("makes the creator the associate, adds the reviewer, and pins the playbook", () => {
    const w = makeWorld();
    const matter = w.services.matters.create(w.associate, {
      name: "Corvane NDA",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: w.playbookVersionId,
      reviewerUserId: w.reviewer.userId,
    });
    expect(matter).toMatchObject({ name: "Corvane NDA", status: "draft", role: "associate" });
    expect(matter.retainUntil > matter.createdAt).toBe(true);
    expect(w.repo.listMembers(matter.id).map((m) => [m.userId, m.role])).toEqual([
      [w.associate.userId, "associate"],
      [w.reviewer.userId, "reviewer"],
    ]);
  });

  it("lists only the matters the principal belongs to, with the role they hold", () => {
    const w = makeWorld();
    const one = newMatter(w, "one");
    const two = w.services.matters.create(w.engineer, {
      name: "two",
      clientLegalName: "Someone Else, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    expect(w.services.matters.list(w.associate).map((m) => [m.id, m.role])).toEqual([
      [one.matterId, "associate"],
    ]);
    expect(w.services.matters.list(w.reviewer).map((m) => [m.id, m.role])).toEqual([
      [one.matterId, "reviewer"],
    ]);
    expect(w.services.matters.list(w.engineer).map((m) => m.id)).toEqual([two.id]);
    expect(w.services.matters.list(w.admin)).toEqual([]);
  });

  it("leaves nothing behind when part of it is refused", () => {
    const w = makeWorld();
    const count = () => w.repo.listMattersForUser(w.associate.userId).length;
    expect(() =>
      w.services.matters.create(w.associate, {
        name: "x",
        clientLegalName: "y",
        playbookVersionId: "pbv_ffffffffffffffff",
        reviewerUserId: null,
      }),
    ).toThrow(expect.objectContaining({ name: "NotFoundError" }));
    expect(() =>
      w.services.matters.create(w.associate, {
        name: "x",
        clientLegalName: "y",
        playbookVersionId: null,
        reviewerUserId: "usr_nobody",
      }),
    ).toThrow(expect.objectContaining({ name: "NotFoundError" }));
    expect(() =>
      w.services.matters.create(w.associate, {
        name: "  ",
        clientLegalName: "y",
        playbookVersionId: null,
        reviewerUserId: null,
      }),
    ).toThrow(expect.objectContaining({ name: "ValidationError" }));
    expect(count()).toBe(0);
  });

  it("does not add the creator twice when they name themselves as the reviewer", () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const matter = w.services.matters.create(w.associate, {
      name: "solo",
      clientLegalName: "y",
      playbookVersionId: null,
      reviewerUserId: w.associate.userId,
    });
    expect(w.repo.listMembers(matter.id)).toHaveLength(1);
  });
});

describe("view", () => {
  it("says what it needs before a review can start, in fixed words", async () => {
    const w = makeWorld();
    const bare = w.services.matters.create(w.associate, {
      name: "bare",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const am = w.grant(w.associate, bare.id);
    expect(w.services.matters.view(am).start).toEqual({
      ready: false,
      reasons: ["Choose a playbook", "Upload the NDA"],
    });
    // The run is refused with the same words, and nothing is created.
    expect(await errorOf(() => w.services.runs.start(am, {}))).toMatchObject({
      name: "RunNotReadyError",
      message: "the matter is not ready for a review",
      reasons: ["Choose a playbook", "Upload the NDA"],
    });
    expect(w.services.runs.list(am)).toEqual([]);
    expect(w.services.matters.view(am).matter.status).toBe("draft");
    w.services.matters.update(am, { playbookVersionId: w.playbookVersionId });
    await uploadCase(w, bare.id);
    expect(w.services.matters.view(am).start).toEqual({ ready: true, reasons: [] });
  });

  it("says when a document that governs has no text to review", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    expect(w.services.matters.view(am).start.ready).toBe(true);
    // A warning from ingest that a document has nothing to review.
    w.repo.replaceIngestWarnings(matterId, uploaded.versionIds[1]!, [
      { code: "no_reviewable_text", detail: "D2 has no paragraph with reviewable text" },
    ]);
    expect(w.services.matters.view(am).start).toEqual({
      ready: false,
      reasons: ["A document has no reviewable text"],
    });
    expect(await errorOf(() => w.services.runs.start(am, {}))).toMatchObject({
      name: "RunNotReadyError",
      reasons: ["A document has no reviewable text"],
    });
    w.repo.replaceIngestWarnings(matterId, uploaded.versionIds[1]!, []);
    expect(w.services.matters.view(am).start.ready).toBe(true);

    // A version that was registered and never got its spans, as a crash between the two would leave it.
    const orphan = w.repo.addVersion(
      matterId,
      uploaded.documentIds[1]!,
      {
        mediaType: "txt",
        fileSha256: "a".repeat(64),
        textSha256: "b".repeat(64),
        byteSize: 1,
        statedDate: null,
        storagePath: w.files.save(matterId, new TextEncoder().encode("x")),
        operative: true,
      },
      { actorId: w.associate.userId },
    );
    expect(w.repo.hasSpans(matterId, orphan.id)).toBe(false);
    expect(w.services.matters.view(am).start.reasons).toEqual([
      "A document has no reviewable text",
    ]);
  });

  it("is the whole matter: members, documents, playbooks, destination, runs, memos", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { matterId, am, runId } = await reviewed(w);
    const view = w.services.matters.view(am);
    expect(view.destination).toBe(w.model.generator.disclosure);
    expect(view.segregationRelaxed).toBe(true);
    expect(view.playbooks).toEqual([
      {
        versionId: w.playbookVersionId,
        slug: "parol-nda-recipient",
        name: baseWorld.playbook.name,
        version: "1.0.1",
        approvedAt: expect.any(String),
        ruleCount: 8,
      },
    ]);
    expect(view.currentRun?.id).toBe(runId);
    expect(view.activeRun).toBeNull();
    expect(view.runs.map((r) => r.id)).toEqual([runId]);
    expect(view.staleReason).toBeNull();
    expect(view.memos).toEqual([]);
    expect(view.documents).toHaveLength(2);
    expect(view.documents[0]!.versions[0]).toMatchObject({
      versionNo: 1,
      mediaType: "docx",
      operative: true,
      uploadedByName: "Alex Ruiz (associate)",
      statedDate: "2026-02-02",
    });
    expect(view.matter).toMatchObject({ id: matterId, status: "in_review", role: "associate" });
    expect(w.services.matters.view(w.grant(w.reviewer, matterId)).matter.role).toBe("reviewer");
  });

  it("names why results are stale, in fixed words, for each kind of change", async () => {
    const w = makeWorld();
    const { matterId, am, uploaded } = await reviewed(w).then((r) => ({ ...r }));
    expect(matterId).toBeTruthy();
    w.services.matters.update(am, { clientLegalName: "Lanternfish Software, Incorporated" });
    expect(w.services.matters.view(am)).toMatchObject({
      matter: { status: "stale" },
      staleReason: "The client's legal name changed after this review.",
      currentRun: null,
    });
    expect(uploaded.versionIds).toHaveLength(2);
  });

  it("changes the playbook version only to an approved one, and marks the results stale", async () => {
    const w = makeWorld();
    const { am } = await reviewed(w);
    const loaded = baseWorld.playbook;
    const draft = w.repo.importPlaybookDraft(
      {
        slug: loaded.slug,
        version: "1.0.2",
        yaml: loaded.yaml,
        sha256: loaded.sha256,
        rules: loaded.rules,
      },
      { actorId: w.engineer.userId },
    );
    expect(() => w.services.matters.update(am, { playbookVersionId: draft.id })).toThrow(
      expect.objectContaining({ code: "playbook_not_approved" }),
    );
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
    w.repo.approvePlaybookVersion(draft.id, { actorId: w.admin.userId });
    const after = w.services.matters.update(am, { playbookVersionId: draft.id });
    expect(after.matter).toMatchObject({ status: "stale", playbook: { version: "1.0.2" } });
    expect(after.staleReason).toBe("The playbook version changed after this review.");
    expect(after.playbooks.map((p) => p.version)).toEqual(["1.0.1", "1.0.2"]);
  });

  it("lists the demo identities for the reviewer picker", () => {
    const w = makeWorld();
    expect(w.services.matters.users().map((u) => [u.displayName, u.globalRole])).toEqual([
      ["Sam Patel (admin)", "admin"],
      ["Alex Ruiz (associate)", "member"],
      ["Lee Okafor (legal engineer)", "legal_engineer"],
      ["Dana Whitfield (reviewing attorney)", "member"],
    ]);
  });
});

describe("roles", () => {
  /** Each service function that changes something, called with the matter's own ids. */
  async function setup() {
    const w = makeWorld();
    const { matterId, am, uploaded, runId, reviewerAm } = await reviewed(w);
    w.services.matters.addMember(am, { userId: w.admin.userId, role: "viewer" });
    const viewerAm = w.grant(w.admin, matterId);
    const finding = w.services.runs.issues(am, runId)[0]!;
    const view = w.services.runs.finding(am, finding.findingId);
    return { w, matterId, am, reviewerAm, viewerAm, uploaded, runId, finding, view };
  }

  it("lets only the associate change the matter, its documents and its runs", async () => {
    const { w, am, reviewerAm, viewerAm, uploaded, runId } = await setup();
    const { matters, runs } = w.services;
    const upload = {
      title: "x",
      kind: "amendment" as const,
      fileName: "x.txt",
      bytes: new Uint8Array(1),
      statedDate: null,
    };
    const calls: [string, string, (a: typeof am) => unknown][] = [
      ["matter.update", "update", (a) => matters.update(a, { clientLegalName: "x" })],
      ["member.add", "addMember", (a) => matters.addMember(a, { userId: "usr_x", role: "viewer" })],
      ["document.write", "addDocument", (a) => matters.addDocument(a, upload)],
      [
        "document.write",
        "addVersion",
        (a) => matters.addVersion(a, uploaded.documentIds[1]!, upload),
      ],
      [
        "document.write",
        "setOperative",
        (a) => matters.setOperative(a, uploaded.documentIds[1]!, uploaded.versionIds[1]!),
      ],
      [
        "document.write",
        "setStatedDate",
        (a) => matters.setStatedDate(a, uploaded.versionIds[1]!, null),
      ],
      [
        "document.write",
        "removeDocument",
        (a) => matters.removeDocument(a, uploaded.documentIds[1]!),
      ],
      ["run.start", "start", (a) => runs.start(a, {})],
      ["run.resume", "resume", (a) => runs.resume(a, runId)],
      ["run.start", "cancel", (a) => runs.cancel(a, runId)],
    ];
    for (const [action, name, call] of calls)
      for (const who of [reviewerAm, viewerAm]) {
        const error = await errorOf(() => call(who));
        expect(error, `${name} as ${who.role}`).toBeInstanceOf(ForbiddenError);
        expect((error as ForbiddenError).action).toBe(action);
      }
    // Nothing changed.
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
  });

  it("lets every member read, and only the reviewer decide and export", async () => {
    const { w, am, reviewerAm, viewerAm, runId, finding, view } = await setup();
    const { matters, runs, reviews } = w.services;
    for (const who of [am, reviewerAm, viewerAm]) {
      expect(matters.view(who).matter.id).toBe(who.matterId);
      expect(runs.list(who)).toHaveLength(1);
      expect(runs.get(who, runId).id).toBe(runId);
      expect(runs.issues(who)).toHaveLength(8);
      expect(runs.finding(who, finding.findingId).issue.findingId).toBe(finding.findingId);
      expect(reviews.listMemos(who)).toEqual([]);
    }
    const decision = {
      decision: "accept" as const,
      findingContentSha256: view.contentSha256,
      edits: null,
      reason: null,
    };
    for (const who of [am, viewerAm]) {
      expect(await errorOf(() => reviews.decide(who, finding.findingId, decision))).toMatchObject({
        name: "ForbiddenError",
        action: "review.decide",
      });
      expect(await errorOf(() => reviews.exportMemo(who))).toMatchObject({
        name: "ForbiddenError",
        action: "memo.export",
      });
    }
    expect(reviews.decide(reviewerAm, finding.findingId, decision).issue.review?.decision).toBe(
      "accept",
    );
    // The page is told the same, per role.
    expect(runs.finding(am, finding.findingId).canDecide.allowed).toBe(false);
    expect(runs.finding(viewerAm, finding.findingId).canDecide.allowed).toBe(false);
  });

  it("asks the same of a member of this matter as of one with no part in it: ids of another matter do not exist", async () => {
    const { w, am, uploaded, runId, finding } = await setup();
    const other = newMatter(w, "other");
    const otherUploaded = await uploadCase(w, other.matterId);
    const otherRun = w.services.runs.start(other.am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const otherFinding = w.services.runs.issues(other.am, otherRun.id)[0]!;
    const { matters, runs, reviews } = w.services;
    const notFound = expect.objectContaining({ name: "NotFoundError" });
    // The associate of one matter holds ids of the other, and learns nothing from them.
    expect(await errorOf(() => runs.get(am, otherRun.id))).toEqual(notFound);
    expect(runs.issues(am, otherRun.id)).toEqual([]);
    expect(await errorOf(() => runs.finding(am, otherFinding.findingId))).toEqual(notFound);
    expect(
      await errorOf(() =>
        reviews.decide(w.grant(w.reviewer, am.matterId), otherFinding.findingId, {
          decision: "accept",
          findingContentSha256: "0".repeat(64),
          edits: null,
          reason: null,
        }),
      ),
    ).toEqual(notFound);
    expect(await errorOf(() => reviews.memoFile(am, "memo_ffffffffffffffff"))).toEqual(notFound);
    expect(await errorOf(() => runs.resume(am, otherRun.id))).toEqual(notFound);
    expect(await errorOf(() => runs.cancel(am, otherRun.id))).toEqual(notFound);
    expect(
      await errorOf(() =>
        matters.setOperative(am, otherUploaded.documentIds[1]!, otherUploaded.versionIds[1]!),
      ),
    ).toEqual(notFound);
    expect(
      await errorOf(() => matters.setStatedDate(am, otherUploaded.versionIds[1]!, null)),
    ).toEqual(notFound);
    expect(await errorOf(() => matters.removeDocument(am, otherUploaded.documentIds[1]!))).toEqual(
      notFound,
    );
    expect(
      await errorOf(() =>
        matters.addVersion(am, otherUploaded.documentIds[1]!, {
          fileName: "a.txt",
          bytes: new Uint8Array(1),
          statedDate: null,
        }),
      ),
    ).toEqual(notFound);
    // And the other matter is as it was.
    expect(matters.view(other.am).matter.status).toBe("in_review");
    expect(runs.issues(other.am, otherRun.id)).toHaveLength(8);
    expect(uploaded.versionIds.length).toBe(2);
    expect(runId).toBeTruthy();
    expect(finding.findingId).toBeTruthy();
  });

  it("takes the matter from the proof of membership and from nothing else", async () => {
    const { w, am } = await setup();
    // An AuthorizedMatter for the other matter reads the other matter, whatever ids are passed.
    const other = newMatter(w, "other");
    expect(w.services.matters.view(other.am).matter.id).toBe(other.matterId);
    expect(w.services.matters.view(am).matter.id).toBe(am.matterId);
    expect(w.services.matters.view(other.am).documents).toEqual([]);
  });
});

describe("delete", () => {
  it("removes the files and every row, keeps only the audit trail, and frees the disk", async () => {
    const w = makeWorld();
    const { matterId, am, runId, reviewerAm } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    for (const issue of issues) {
      const view = w.services.runs.finding(reviewerAm, issue.findingId);
      w.services.reviews.decide(reviewerAm, issue.findingId, {
        decision:
          view.issue.verificationState === "verified" && view.issue.status !== "undetermined"
            ? "accept"
            : "escalate",
        findingContentSha256: view.contentSha256,
        edits: null,
        reason:
          view.issue.verificationState === "verified" && view.issue.status !== "undetermined"
            ? null
            : "open",
      });
    }
    await w.services.reviews.exportMemo(reviewerAm);
    const paths = [
      ...w.repo.listVersions(matterId).map((v) => v.storagePath),
      ...w.repo.listMemos(matterId).map((m) => m.storagePath),
    ];
    expect(paths).toHaveLength(3);
    const kept = newMatter(w, "kept");
    await uploadCase(w, kept.matterId);
    expect(mentions(w, matterId).length).toBeGreaterThan(8);

    await w.services.matters.delete(am);

    expect(w.repo.getMatter(matterId)).toBeUndefined();
    expect(existsSync(join(w.files.root, matterId))).toBe(false);
    for (const path of paths) expect(w.files.exists(path)).toBe(false);
    // Only the audit trail may still mention it, and it holds ids and counts.
    expect(mentions(w, matterId).every((m) => m.startsWith("audit_events."))).toBe(true);
    expect(w.repo.listMatterAuditEvents(matterId).events.at(-1)).toMatchObject({
      action: "matter.delete",
    });
    // The other matter is whole.
    expect(w.services.matters.view(kept.am).documents).toHaveLength(2);
    expect(w.files.exists(w.repo.listVersions(kept.matterId)[0]!.storagePath)).toBe(true);
    expect(w.services.matters.list(w.associate).map((m) => m.id)).toEqual([kept.matterId]);
    expect(() => w.services.matters.view(am)).toThrow(
      expect.objectContaining({ name: "NotFoundError" }),
    );
  });

  it("is for the creator and an administrator, whatever role they hold", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm } = await reviewed(w);
    w.services.matters.addMember(am, { userId: w.admin.userId, role: "viewer" });
    const adminAm = w.grant(w.admin, matterId);
    expect(await errorOf(() => w.services.matters.delete(reviewerAm))).toMatchObject({
      name: "ForbiddenError",
      action: "matter.delete",
    });
    expect(w.repo.getMatter(matterId)).toBeDefined();
    // An administrator who is only a viewer may.
    await w.services.matters.delete(adminAm);
    expect(w.repo.getMatter(matterId)).toBeUndefined();
  });

  it("cancels a run in flight first, and the run stops quietly", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    w.services.runs.start(am, {});
    await hold.reached(1);
    await w.services.matters.delete(am);
    hold.open();
    await w.services.runs.idle();
    expect(w.repo.getMatter(matterId)).toBeUndefined();
    expect(existsSync(join(w.files.root, matterId))).toBe(false);
    expect(w.logs.some((l) => l.includes("failed"))).toBe(false);
  });

  it("is not reachable by a provider error on a run that no longer exists", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze") {
            await hold.pass();
            throw new ModelRequestError("no", 401);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    w.services.runs.start(am, {});
    await hold.reached(1);
    await w.services.matters.delete(am);
    hold.open();
    await w.services.runs.idle();
    expect(w.repo.getMatter(matterId)).toBeUndefined();
  });
});
