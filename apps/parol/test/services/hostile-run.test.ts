import { afterAll, describe, expect, it } from "vitest";
import { buildCaseWorld } from "../integration/pipeline.js";
import { cleanup, makeWorld, newMatter } from "./support.js";

afterAll(cleanup);

/**
 * A document with a paragraph aimed at the software (the evaluation's PAROL-D08) and its twin
 * without it, through the services. The scripted model is an oracle for the answer key and does
 * not follow instructions, so what these pin is what the code around it does with hostile text:
 * it is warned about, it reaches the model only as contract text, it cannot reach a check, and
 * the outcome is the twin's.
 */
describe("a document that tries to steer the review", () => {
  it("is warned about, and the review comes out as the twin's does", async () => {
    const hostile = await buildCaseWorld("PAROL-D08");
    const twin = await buildCaseWorld("PAROL-D08", { twin: true });

    async function review(world: typeof hostile) {
      const w = makeWorld({ model: { world } });
      const { matterId, am } = newMatter(w);
      const file = world.files[0]!;
      const doc = world.documents[0]!;
      const upload = await w.services.matters.addDocument(am, {
        title: doc.title,
        kind: "nda",
        fileName: file.file,
        bytes: file.bytes,
        statedDate: doc.statedDate,
      });
      const run = w.services.runs.start(am, { workflowLabel: "v2" });
      await w.services.runs.idle();
      return { w, matterId, am, upload, run };
    }

    const a = await review(hostile);
    const b = await review(twin);
    const view = a.w.services.matters.view(a.am);
    const warning = view.warnings.find((x) => x.code === "instruction_like_text")!;
    expect(warning).toMatchObject({ documentLabel: "D1" });
    expect(b.w.services.matters.view(b.am).warnings).toEqual([]);

    const statuses = (r: typeof a) =>
      r.w.services.runs
        .issues(r.am, r.run.id)
        .map((i) => [i.ruleKey, i.status, i.escalations.map((e) => e.code)]);
    expect(a.w.services.runs.get(a.am, a.run.id).status).toBe("succeeded");
    expect(statuses(a)).toEqual(statuses(b));

    // The paragraph is in the contract block of each prompt that carries it, between the tags,
    // and nowhere outside them.
    const span = a.w.repo
      .listSpans(a.matterId, [a.upload.versionId])
      .find((s) => s.label === warning.spanLabel)!;
    const sentence = span.text.slice(0, 40);
    const carrying = a.w.model.calls.filter((c) => c.prompt.includes(sentence));
    expect(carrying.length).toBeGreaterThan(0);
    for (const call of carrying) {
      const open = call.prompt.indexOf("<contract>");
      const close = call.prompt.lastIndexOf("</contract>");
      const at = call.prompt.indexOf(sentence);
      expect(open).toBeGreaterThanOrEqual(0);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }

    // No check's detail and no escalation carries the paragraph.
    for (const issue of a.w.services.runs.issues(a.am, a.run.id)) {
      const finding = a.w.services.runs.finding(a.am, issue.findingId);
      const details = JSON.stringify([finding.checks, finding.issue.escalations]);
      expect(details).not.toContain(sentence);
    }
    // And the paragraph can be read in place, like any other.
    expect(span.text.length).toBeGreaterThan(40);
  });
});
