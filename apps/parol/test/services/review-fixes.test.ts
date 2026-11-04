import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ModelRequestError } from "@clausewise/llm";
import JSZip from "jszip";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashOf } from "../../src/canonical.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { createServices } from "../../src/services/index.js";
import {
  baseWorld,
  cleanup,
  controlledModel,
  decideAll,
  makeWorld,
  newMatter,
  reviewed,
  uploadCase,
  type World,
} from "./support.js";

/**
 * Regression tests for the findings of the independent review of the services module. Each one was
 * written to fail on the code as it stood, and passes with the fix.
 */

afterAll(cleanup);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const errorOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

const memoText = async (bytes: Uint8Array): Promise<string> => {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
};

const SAME_PERSON = "The reviewer and the associate were the same person for this matter";

/** What the store and the file store hold for a matter, to show that a failed upload left no trace. */
function traces(w: World, matterId: string) {
  const dir = join(w.files.root, matterId);
  let stored: string[] = [];
  try {
    stored = readdirSync(dir).sort();
  } catch {
    stored = [];
  }
  return {
    documents: w.repo.listDocuments(matterId).length,
    versions: w.repo.listVersions(matterId).map((v) => [v.id, v.operative]),
    spans: w.repo
      .listVersions(matterId)
      .reduce((n, v) => n + w.repo.listSpans(matterId, [v.id]).length, 0),
    warnings: w.repo.listIngestWarnings(matterId).length,
    audit: w.repo.listMatterAuditEvents(matterId).events.length,
    inputs: w.repo.getMatter(matterId)!.currentInputsSha256,
    status: w.repo.getMatter(matterId)!.status,
    files: stored,
  };
}

// ---------------------------------------------------------------------------------------------
// Finding 1: a re-saved file with identical text must not undo a review
// ---------------------------------------------------------------------------------------------

describe("a re-saved file with identical text, after the review is decided", () => {
  // docs/parol/03 (Invalidation): "No change" for findings, decisions and the memo. The service asks
  // the store to store the version without taking the old one out of force (`keepOperative`), so
  // the digest of the inputs is the one the review was made on. Before the store had that option
  // the old operative flag was cleared whatever the new version asked for, the document had no
  // governing version, and the whole review went stale.
  it("keeps every finding, decision and the memo, and the old version keeps governing", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, reviewerAm, issues);
    expect(w.services.matters.view(am).matter.status).toBe("review_complete");
    const documentId = w.repo.listDocuments(matterId)[1]!.id;

    const resaved = text(
      new TextDecoder().decode(baseWorld.files[1]!.bytes).replace(/\n/g, "\r\n"),
    );
    const result = await w.services.matters.addVersion(am, documentId, {
      fileName: "amendment-1-resaved.txt",
      bytes: resaved,
      statedDate: baseWorld.documents[1]!.statedDate,
    });
    expect(result.warnings.map((x) => x.code)).toEqual(["near_duplicate_version"]);

    const view = w.services.matters.view(am);
    expect(view.matter.status).toBe("review_complete");
    expect(view.staleReason).toBeNull();
    expect(w.services.runs.issues(am, runId).map((i) => i.validity)).toEqual(
      issues.map(() => "current"),
    );
    expect(w.services.runs.get(am, runId).current).toBe(true);
    // The decisions stand, the old version still governs, and the memo can be exported.
    expect(w.services.runs.issues(am, runId).every((i) => i.review?.validity === "current")).toBe(
      true,
    );
    expect(view.documents[1]!.versions.map((v) => [v.versionNo, v.operative])).toEqual([
      [1, true],
      [2, false],
    ]);
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    expect(memo.status).toBe("current");

    // Using the re-saved file instead is the associate's own act, and then the results are stale.
    w.services.matters.setOperative(am, documentId, result.versionId);
    expect(w.services.matters.view(am).matter.status).toBe("stale");
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 2: the memo's statement about the roles comes from the recorded decisions
// ---------------------------------------------------------------------------------------------

describe("the memo's statement that the reviewer and the associate were one person", () => {
  it("is not made when a separate reviewer decided everything and the associate exports (relaxed mode)", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    // The associate exports: allowed in the relaxed mode, and not a decision.
    const memo = await w.services.reviews.exportMemo(am);
    const body = await memoText((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    expect(body).not.toContain(SAME_PERSON);
  });

  it("is made from what was recorded, even when the mode has since been switched off", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { matterId, am, runId } = await reviewed(w);
    // The associate who started the run decides every finding.
    decideAll(w, am, w.services.runs.issues(am, runId));

    // The process restarts with the relaxed mode off; the reviewer exports.
    const strict = createServices({ ...w.deps, config: { relaxedSegregation: false } });
    const reviewerAm = w.grant(w.reviewer, matterId);
    const memo = await strict.reviews.exportMemo(reviewerAm);
    const body = await memoText((await strict.reviews.memoFile(reviewerAm, memo.memoId)).bytes);
    expect(body).toContain(SAME_PERSON);
  });

  it("is made when the associate decided only some of the findings", async () => {
    const w = makeWorld({ config: { relaxedSegregation: true } });
    const { am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    decideAll(w, am, issues.slice(0, 1));
    decideAll(w, reviewerAm, issues.slice(1));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const body = await memoText((await w.services.reviews.memoFile(am, memo.memoId)).bytes);
    expect(body).toContain(SAME_PERSON);
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 3: a run is resumed on the provider and model it recorded
// ---------------------------------------------------------------------------------------------

describe("resume", () => {
  it("refuses to carry a run over to a different provider or model, and the run stays as it was", async () => {
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze" && call.ruleKey === "exc-1") {
            await sleep(10);
            throw new ModelRequestError("no", 401);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      model: { provider: "scripted", requested: "scripted-model" },
    });

    // A new process whose model is somewhere else.
    const elsewhere = controlledModel({
      info: {
        provider: "other-provider",
        model: "other-model-9",
        disclosure: "text is sent to another provider",
      },
    });
    const second = createServices({ ...w.deps, generator: elsewhere.generator });
    const error = await errorOf(() => second.runs.resume(am, run.id));
    expect(error).toMatchObject({ name: "ConflictError", code: "run_model_changed" });
    // The message is fixed text: no provider or model name from the configuration is echoed.
    expect((error as Error).message).not.toContain("other-");

    expect(elsewhere.calls).toEqual([]);
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "failed" });
    expect(w.repo.getRun(matterId, run.id)?.status).toBe("failed");
    await second.runs.idle();
    expect(elsewhere.calls).toEqual([]);

    // The same provider and model resume it, as before.
    const same = createServices({ ...w.deps, generator: controlledModel().generator });
    same.runs.resume(am, run.id);
    await same.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded" });
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 4: a version is registered together with its spans, or not at all
// ---------------------------------------------------------------------------------------------

describe("a new version whose spans cannot be stored", () => {
  const NEW_TEXT =
    "AMENDMENT NO. 1\n\n1. Section 6.1 of the Agreement is restated as follows. The obligations continue for two years from each disclosure.\n";

  it("leaves nothing behind: the old version still governs, the file is gone, and the same upload works afterwards", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const before = traces(w, matterId);
    const input = { fileName: "amendment-v2.txt", bytes: text(NEW_TEXT), statedDate: "2026-09-16" };

    const failing = vi.spyOn(w.repo, "insertSpans").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(
      await errorOf(() => w.services.matters.addVersion(am, uploaded.documentIds[1]!, input)),
    ).toMatchObject({
      message: "disk full",
    });
    failing.mockRestore();

    // The version row, its operative flag, the audit trail, the inputs and the file: all as before.
    expect(traces(w, matterId)).toEqual(before);
    expect(w.services.matters.view(am).start).toEqual({ ready: true, reasons: [] });

    // Trying again is an upload like any other, and not a duplicate of something half stored.
    const result = await w.services.matters.addVersion(am, uploaded.documentIds[1]!, input);
    expect(result.warnings).toEqual([]);
    expect(w.repo.getVersion(matterId, result.versionId)).toMatchObject({
      versionNo: 2,
      operative: true,
    });
    expect(w.repo.hasSpans(matterId, result.versionId)).toBe(true);
    expect(w.services.matters.view(am).start).toEqual({ ready: true, reasons: [] });
  });

  it("leaves a new document nothing behind either, not even a record of it having been added and removed", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const before = traces(w, matterId);
    const failing = vi.spyOn(w.repo, "insertSpans").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const file = baseWorld.files[0]!;
    const input = {
      title: "Mutual NDA",
      kind: "nda" as const,
      fileName: file.file,
      bytes: file.bytes,
      statedDate: baseWorld.documents[0]!.statedDate,
    };
    expect(await errorOf(() => w.services.matters.addDocument(am, input))).toMatchObject({
      message: "disk full",
    });
    failing.mockRestore();
    expect(traces(w, matterId)).toEqual(before);

    const result = await w.services.matters.addDocument(am, input);
    expect(result.warnings).toEqual([]);
    expect(w.repo.hasSpans(matterId, result.versionId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 5: a unit that finishes after another met a fatal error is kept
// ---------------------------------------------------------------------------------------------

describe("a fatal provider error on one rule while others are being answered", () => {
  it("keeps the rules that finish a moment later, with their calls on record, and resume does not pay for them again", async () => {
    let broken = true;
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind !== "analyze") return;
          if (broken && call.ruleKey === "pty-1")
            throw new ModelRequestError("the provider said no", 401);
          if (broken) await sleep(30);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    const asked = new Set(
      w.model.calls.filter((c) => c.kind === "analyze").map((c) => c.ruleKey as string),
    );
    expect(asked.has("pty-1")).toBe(true);
    expect(asked.size).toBe(3);
    const siblings = [...asked].filter((k) => k !== "pty-1");

    // The two that were being answered when the third was refused were answered, and are kept.
    const stages = w.repo.listStages(matterId, run.id).filter((s) => s.stage === "analyze");
    expect(stages.map((s) => [s.unit, s.status]).sort()).toEqual(
      [...asked].map((k) => [k, k === "pty-1" ? "failed" : "succeeded"]).sort(),
    );
    // Their spend is on record.
    const calls = w.repo.listModelCalls(matterId, run.id);
    for (const key of siblings)
      expect(calls.filter((c) => c.ruleKey === key).map((c) => c.outcome)).toEqual(["ok"]);
    expect(calls.filter((c) => c.ruleKey === "pty-1").map((c) => c.outcome)).toEqual(["fatal"]);
    // Nothing more was started once the provider had refused.
    expect(w.model.calls.filter((c) => c.kind === "analyze")).toHaveLength(3);

    broken = false;
    const before = w.model.calls.length;
    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
    const again = w.model.calls.slice(before).filter((c) => c.kind === "analyze");
    for (const key of siblings) expect(again.filter((c) => c.ruleKey === key)).toEqual([]);
    expect(again.filter((c) => c.ruleKey === "pty-1")).toHaveLength(1);
  });
});

describe("a fatal provider error in a support check while others are being checked", () => {
  it("keeps the findings whose check finishes a moment later, with their calls on record", async () => {
    let broken = true;
    let seen = 0;
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind !== "support" || !broken) return;
          seen += 1;
          if (seen === 1) throw new ModelRequestError("the provider said no", 401);
          await sleep(30);
        },
      },
    });
    const withSupport = {
      ...WORKFLOWS["v2"]!.manifest,
      label: "v3-support",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
    };
    w.repo.upsertWorkflowVersion({ manifest: withSupport, sha256: hashOf(withSupport) });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v3-support" });
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    expect(w.model.count("support")).toBe(3);
    const verify = w.repo.listStages(matterId, run.id).filter((s) => s.stage === "verify");
    expect(verify.map((s) => s.status).sort()).toEqual(["failed", "succeeded", "succeeded"]);
    const supportCalls = w.repo
      .listModelCalls(matterId, run.id)
      .filter((c) => c.stage === "support");
    expect(supportCalls.map((c) => c.outcome).sort()).toEqual(["fatal", "ok", "ok"]);

    broken = false;
    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
    // The two that were checked are not checked again.
    expect(w.model.count("support")).toBeLessThanOrEqual(3 + 8 - 2);
  });
});
