import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { toSourceSpans } from "../../src/store/index.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { cleanup, decideAll, makeWorld, newMatter, uploadCase, baseWorld } from "./support.js";

afterAll(cleanup);

describe("the story of docs/parol/04 through the services alone", () => {
  it("goes from a new matter to a memo that can be read back", async () => {
    const w = makeWorld();
    const { services } = w;

    // 1. The associate creates the matter and names the reviewer.
    const { summary, matterId, am } = newMatter(w);
    expect(summary).toMatchObject({ status: "draft", role: "associate", synthetic: true });
    expect(summary.playbook).toEqual({ slug: "parol-nda-recipient", version: "1.0.1" });
    expect(services.matters.view(am).members.map((m) => [m.role, m.displayName])).toEqual([
      ["associate", "Alex Ruiz (associate)"],
      ["reviewer", "Dana Whitfield (reviewing attorney)"],
    ]);
    expect(services.matters.view(am).start).toEqual({
      ready: false,
      reasons: ["Upload the NDA"],
    });

    // 2. The two files of PAROL-D05 go in; the matter is ready.
    const uploaded = await uploadCase(w, matterId);
    const before = services.matters.view(am);
    expect(before.matter.status).toBe("ready");
    expect(before.start).toEqual({ ready: true, reasons: [] });
    expect(
      before.documents.map((d) => [d.label, d.kind, d.title, d.versions[0]!.operative]),
    ).toEqual([
      ["D1", "nda", "Mutual NDA", true],
      ["D2", "amendment", "Amendment No. 1", true],
    ]);
    expect(before.destination).toBe(w.model.generator.disclosure);

    // The spans a run reads equal what ingest makes of the same documents.
    const rebuilt = {
      spans: toSourceSpans(w.repo.listSpans(matterId, uploaded.versionIds)),
      annotations: w.repo.listAnnotations(matterId, uploaded.versionIds),
    };
    const expected = buildIngest({
      documents: baseWorld.documents.map((d, i) => ({
        ...d,
        documentVersionId: uploaded.versionIds[i]!,
      })),
    });
    expect(rebuilt.spans).toEqual(expected.spans);
    expect(rebuilt.annotations).toEqual(expected.annotations);

    // 3. The run starts and returns at once.
    const started = services.runs.start(am, { workflowLabel: "v2" });
    expect(started.status).toBe("queued");
    expect(started.workflowLabel).toBe("v2");
    expect(services.matters.view(am).matter.status).toBe("running");
    await services.runs.idle();

    const run = services.runs.get(am, started.id);
    expect(run).toMatchObject({
      status: "succeeded",
      errorKind: null,
      findingCount: 8,
      current: true,
    });
    expect(services.matters.view(am).matter.status).toBe("in_review");

    // 4. The issue table: eight rules, the duration finding is the worked example.
    const issues = services.runs.issues(am);
    expect(issues.map((i) => i.ruleKey)).toEqual([
      "pty-1",
      "def-1",
      "exc-1",
      "pds-1",
      "pds-2",
      "dur-1",
      "ret-1",
      "gov-1",
    ]);
    const dur = issues.find((i) => i.ruleKey === "dur-1")!;
    expect(dur).toMatchObject({ status: "deviation", severity: "high", validity: "current" });
    const view = services.runs.finding(am, dur.findingId);
    expect(view.evidence.map((e) => [e.role, e.location])).toContainEqual([
      "governing",
      "Amendment No. 1 (v1), Section 2, paragraph 3",
    ]);
    for (const e of view.evidence)
      if (e.offsets !== null)
        expect(e.spanText.slice(e.offsets.start, e.offsets.end)).toBe(e.quote);

    // 5. The reviewer decides each finding; the associate cannot.
    const reviewerAm = w.grant(w.reviewer, matterId);
    expect(services.runs.finding(am, dur.findingId).canDecide).toEqual({
      allowed: false,
      reason: "Only the reviewing attorney can record a decision.",
    });
    expect(services.runs.finding(reviewerAm, dur.findingId).canDecide).toEqual({
      allowed: true,
      reason: null,
    });
    const decided = decideAll(w, reviewerAm, issues);
    expect(decided).toHaveLength(8);
    expect(services.matters.view(am).matter.status).toBe("review_complete");

    // 6. Export, and read the memo back.
    const memo = await services.reviews.exportMemo(reviewerAm);
    expect(memo).toMatchObject({ status: "current", runId: started.id });
    // The name is the matter's id without its prefix and the day of the export: no text of anyone's.
    expect(memo.fileName).toBe(
      `parol-memo-${matterId.slice(4)}-${memo.exportedAt.slice(0, 10).replace(/-/g, "")}.docx`,
    );
    expect(services.matters.view(am).matter.status).toBe("exported");
    const file = await services.reviews.memoFile(am, memo.memoId);
    expect(file.fileName).toBe(memo.fileName);
    expect(sha256Hex(file.bytes)).toBe(memo.fileSha256);
    const zip = await JSZip.loadAsync(file.bytes);
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain("Lanternfish Software, Inc.");
    expect(body).toContain("Amendment No. 1 (v1), Section 2, paragraph 3");
    expect(services.reviews.listMemos(am).map((m) => m.memoId)).toEqual([memo.memoId]);
  });
});
