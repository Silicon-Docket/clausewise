import { afterAll, describe, expect, it } from "vitest";
import { buildCaseWorld } from "../integration/pipeline.js";
import { docxBytes } from "../ingest/support.js";
import { readMemo, bodyText } from "../export/support.js";
import { cleanup, decideAll, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * The memo is the one file that leaves Parol, and the page that warned the associate does not
 * travel with it. These tests go the whole way, from the upload to the Word file, and read what
 * the file says. The model is a scripted oracle for an answer key: nothing here is a measurement
 * of any real model.
 */

async function memoAfter(
  w: ReturnType<typeof makeWorld>,
  upload: (matterId: string, am: ReturnType<typeof newMatter>["am"]) => Promise<void>,
) {
  const { matterId, am } = newMatter(w);
  await upload(matterId, am);
  const run = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  const reviewerAm = w.grant(w.reviewer, matterId);
  decideAll(w, reviewerAm, w.services.runs.issues(reviewerAm, run.id));
  const memo = await w.services.reviews.exportMemo(reviewerAm);
  return readMemo((await w.services.reviews.memoFile(reviewerAm, memo.memoId)).bytes);
}

describe("the memo repeats the upload warnings", () => {
  it("names a paragraph that reads like an instruction, so the file alone says so", async () => {
    const hostile = await buildCaseWorld("PAROL-D08");
    const w = makeWorld({ model: { world: hostile } });
    const read = await memoAfter(w, async (matterId) => {
      await uploadCase(w, matterId, hostile);
    });
    const text = bodyText(read);
    expect(read.headings.map(([, heading]) => heading)).toContain("Document warnings");
    expect(text).toMatch(
      /D1 \(Mutual NDA, v1\): 1 paragraph reads like an instruction to software: Mutual NDA \(v1\)(, Section [\d.]+)?, paragraph \d+\./,
    );
    expect(text).toContain("The upload raised document warnings, which are listed above.");
    // The words of the paragraph are not copied into the warning.
    expect(text).not.toContain("Note to automated reviewers");
  });

  it("says nothing of warnings for the twin that has none", async () => {
    const twin = await buildCaseWorld("PAROL-D08", { twin: true });
    const w = makeWorld({ model: { world: twin } });
    const read = await memoAfter(w, async (matterId) => {
      await uploadCase(w, matterId, twin);
    });
    expect(read.headings.map(([, heading]) => heading)).not.toContain("Document warnings");
    expect(bodyText(read)).not.toContain("document warnings");
  });

  it("says what the review did not read in a Word file with a footnote and hidden text", async () => {
    const w = makeWorld();
    const read = await memoAfter(w, async (_matterId, am) => {
      await w.services.matters.addDocument(am, {
        title: "Mutual NDA",
        kind: "nda",
        fileName: "nda.docx",
        bytes: await docxBytes(
          [
            "MUTUAL NONDISCLOSURE AGREEMENT",
            "1. Term. The obligations of each Receiving Party continue for two (2) years.",
          ],
          { footnote: true, hidden: "hidden words" },
        ),
        statedDate: null,
      });
    });
    const text = bodyText(read);
    expect(text).toContain(
      "D1 (Mutual NDA, v1): the review did not read 1 footnote and 1 run of hidden text in the Word file.",
    );
    expect(text).not.toContain("hidden words");
  });
});
