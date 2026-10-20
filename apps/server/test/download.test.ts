import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ApiError, Finding, PatchFindingRequest, ReviewDetail } from "@clausewise/api";
import { parseDocx } from "@clausewise/docx";
import { createOracleGenerator } from "@clausewise/review/testing";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { documents, reviews } from "../src/db/schema.js";
import { MAX_WARNINGS_HEADER_CHARS, WARNINGS_HEADER } from "../src/routes/export.js";
import { readDocx, type ReadDocx } from "./docx-reader.js";
import {
  controllable,
  createHarness,
  fixture,
  fixtureBytes,
  oracleFor,
  tempDir,
  type Harness,
} from "./support.js";
import { oracleScripts } from "../../../evals/src/selftest.js";

const NDA = "nda-aggressive.docx";
const run = promisify(execFile);

// The download is checked against an independent reader of the file (docx-reader.ts), not against
// the library that writes it: what the lawyer opens in Word is what these tests count.

let t: Harness;
let original: ReadDocx;
beforeAll(async () => {
  t = await createHarness({ generator: await oracleFor(NDA), scope: "file" });
  original = await readDocx(await fixtureBytes(NDA));
});

async function reviewed(harness: Harness = t): Promise<ReviewDetail> {
  return (await harness.reviewedFixture(NDA)).review;
}

async function decide(
  harness: Harness,
  review: ReviewDetail,
  ruleId: string,
  body: PatchFindingRequest,
): Promise<Finding> {
  const answer = await harness.send<Finding>(
    "PATCH",
    `/api/reviews/${review.id}/findings/${ruleId}`,
    body,
  );
  expect(answer.status).toBe(200);
  return answer.body;
}

async function download(harness: Harness, reviewId: string, query = "") {
  const response = await harness.request(`/api/reviews/${reviewId}/docx${query}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

type AppliedEdit = Extract<Finding["edit"], { kind: "applied" }>;

const appliedEdit = (finding: Finding): AppliedEdit => {
  if (finding.edit.kind !== "applied") throw new Error(`${finding.ruleId} has no applied edit`);
  return finding.edit;
};

/** The paragraph as it reads once the change is accepted, worked out here and not by the writer. */
const afterEdit = (edit: AppliedEdit, replacement: string): string =>
  edit.paragraphText.slice(0, edit.start) + replacement + edit.paragraphText.slice(edit.end);

/** Where the paragraph an edit sits in is in the uploaded file, by the independent reader. */
function paragraphOf(edit: AppliedEdit): number {
  const at = original.rejected.indexOf(edit.paragraphText);
  expect(at, "the reader and the report agree on the paragraph").toBeGreaterThan(-1);
  expect(original.rejected.lastIndexOf(edit.paragraphText)).toBe(at);
  return at;
}

/** The paragraphs that read differently once every change is accepted, with their new text. */
function changed(file: ReadDocx): { index: number; text: string }[] {
  expect(file.accepted).toHaveLength(original.accepted.length);
  return file.accepted.flatMap((text, index) =>
    text === original.accepted[index] ? [] : [{ index, text }],
  );
}

/** The words of the heading line of a finding's comment: severity and title. */
const commentHead = (finding: Finding): string =>
  `[${finding.severity.toUpperCase()}] ${finding.title}`;

describe("GET /api/reviews/:id/docx", () => {
  it("with one accepted finding that has an applied edit: one deletion, one insertion, its comment and no other", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    const term = t.finding(review, "term");
    const edit = appliedEdit(term);

    const { response, bytes } = await download(t, review.id, "?include=accepted");
    expect(response.status).toBe(200);
    const file = await readDocx(bytes);
    expect(file.deletions).toBe(1);
    expect(file.insertions).toBe(1);
    // The writer keeps the words the two versions share, so the change can be smaller than the
    // span, never larger.
    expect(edit.original).toContain(file.deletedTexts[0]);
    expect(edit.replacement).toContain(file.insertedTexts[0]);
    expect(file.comments).toHaveLength(1);
    expect(file.comments[0]?.author).toBe("Clausewise");
    expect(file.comments[0]?.text.startsWith(commentHead(term))).toBe(true);
    expect(file.comments[0]?.text).toContain(term.comment === "" ? term.explanation : term.comment);
    expect(file.commentRanges).toEqual({ starts: 1, ends: 1, references: 1 });

    // The one paragraph reads as the replacement says, and no other paragraph changed. Rejecting
    // the change gives the upload back.
    expect(changed(file)).toEqual([
      { index: paragraphOf(edit), text: afterEdit(edit, edit.replacement) },
    ]);
    expect(file.rejected).toEqual(original.rejected);
  });

  it("sends the file as an attachment under a name made from the document's, and nothing a browser could cache or sniff", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    const { response, bytes } = await download(t, review.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="nda-aggressive.redlined.docx"; filename*=UTF-8''nda-aggressive.redlined.docx`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    // Same origin needs no permission to read a header, so no CORS header is ever sent.
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
    // Nothing to warn about, so no header.
    expect(response.headers.get(WARNINGS_HEADER)).toBeNull();
    // A zip.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("asks for the accepted findings when no mode is given", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    const plain = await readDocx((await download(t, review.id)).bytes);
    const named = await readDocx((await download(t, review.id, "?include=accepted")).bytes);
    expect(plain.insertions).toBe(1);
    expect(plain).toEqual(named);
  });

  it("with two accepted findings: two deletions, two insertions and two comments", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    await decide(t, review, "governing-law", { decision: "accepted" });
    const { bytes } = await download(t, review.id, "?include=accepted");
    const file = await readDocx(bytes);
    expect(file.deletions).toBe(2);
    expect(file.insertions).toBe(2);
    expect(file.comments.map((c) => c.text.split("\n")[0]).sort()).toEqual(
      [
        commentHead(t.finding(review, "term")),
        commentHead(t.finding(review, "governing-law")),
      ].sort(),
    );
    const term = appliedEdit(t.finding(review, "term"));
    const law = appliedEdit(t.finding(review, "governing-law"));
    expect(changed(file)).toEqual(
      [
        { index: paragraphOf(term), text: afterEdit(term, term.replacement) },
        { index: paragraphOf(law), text: afterEdit(law, law.replacement) },
      ].sort((a, b) => a.index - b.index),
    );
  });

  it("with nothing accepted and include=accepted: the file as it was uploaded, with no change and no comment from the review", async () => {
    const review = await reviewed();
    // Rejected and undecided findings are the same to this mode.
    await decide(t, review, "term", { decision: "rejected" });
    const { response, bytes } = await download(t, review.id, "?include=accepted");
    expect(response.status).toBe(200);
    const file = await readDocx(bytes);
    expect(file.deletions + file.insertions).toBe(0);
    expect(file.comments).toEqual([]);
    expect(file.rejected).toEqual(original.rejected);
    expect(Buffer.compare(bytes, await fixtureBytes(NDA))).toBe(0);
    expect(response.headers.get("content-disposition")).toContain("nda-aggressive.redlined.docx");
  });

  it("with include=all: every finding that is not rejected, and no rejected one", async () => {
    const review = await reviewed();
    await decide(t, review, "remedies", { decision: "rejected" });
    await decide(t, review, "governing-law", { decision: "rejected" });
    await decide(t, review, "term", { decision: "accepted" });

    const { bytes } = await download(t, review.id, "?include=all");
    const file = await readDocx(bytes);
    const kept = review.findings.filter((f) => !["remedies", "governing-law"].includes(f.ruleId));
    const changes = kept.filter((f) => f.edit.kind === "applied");
    expect(kept).toHaveLength(8);
    expect(changes.length).toBeGreaterThan(4);
    expect(file.comments).toHaveLength(kept.length);
    expect(file.deletions).toBe(changes.length);
    expect(file.insertions).toBe(changes.length);
    expect(file.comments.map((c) => c.text.split("\n")[0]).sort()).toEqual(
      kept.map(commentHead).sort(),
    );

    // The two that were rejected are nowhere: not their comments, not their words.
    const keptParagraphs = new Set(changes.map((f) => paragraphOf(appliedEdit(f))));
    for (const ruleId of ["remedies", "governing-law"]) {
      const rejected = t.finding(review, ruleId);
      expect(file.comments.some((c) => c.text.startsWith(commentHead(rejected)))).toBe(false);
      // Its paragraph reads as it did, unless a finding that was kept changes the same one.
      const at = paragraphOf(appliedEdit(rejected));
      expect(keptParagraphs.has(at)).toBe(false);
      expect(file.accepted[at]).toBe(original.accepted[at]);
    }
    // And the same mode with the accepted one only has just that one.
    const accepted = await readDocx((await download(t, review.id, "?include=accepted")).bytes);
    expect(accepted.insertions).toBe(1);
  });

  it("writes the wording the lawyer edited, and a deletion alone for an empty wording", async () => {
    const review = await reviewed();
    await decide(t, review, "term", {
      decision: "accepted",
      editedReplacement: "end two (2) years after the date of disclosure",
    });
    await decide(t, review, "governing-law", { decision: "accepted", editedReplacement: "" });

    const file = await readDocx((await download(t, review.id)).bytes);
    const term = appliedEdit(t.finding(review, "term"));
    const law = appliedEdit(t.finding(review, "governing-law"));
    // The lawyer's words are the insertion, whole; the model's are not anywhere.
    expect(file.insertedTexts).toEqual(["end two (2) years after the date of disclosure"]);
    expect(file.accepted.join("\n")).not.toContain(term.replacement);
    // The empty wording is a deletion of the whole span with nothing inserted beside it, and the
    // finding's comment stays.
    expect(file.deletions).toBe(2);
    expect(file.insertions).toBe(1);
    expect(file.deletedTexts.sort()).toEqual([law.original, term.original].sort());
    expect(file.comments).toHaveLength(2);
    expect(changed(file)).toEqual(
      [
        {
          index: paragraphOf(term),
          text: afterEdit(term, "end two (2) years after the date of disclosure"),
        },
        { index: paragraphOf(law), text: afterEdit(law, "") },
      ].sort((a, b) => a.index - b.index),
    );
    expect(file.rejected).toEqual(original.rejected);
  });

  it("restores every paragraph as it was uploaded when all the changes are rejected", async () => {
    const review = await reviewed();
    const { bytes } = await download(t, review.id, "?include=all");
    const file = await readDocx(bytes);
    expect(file.deletions).toBeGreaterThan(4);
    // Insertions dropped and deletions kept: the original paragraphs, in order, nothing else.
    expect(file.rejected).toEqual(original.rejected);
    // Accepting them all does change the text, so the check above could have failed.
    expect(file.accepted).not.toEqual(original.rejected);
    expect(file.accepted).toHaveLength(original.rejected.length);
  });

  it("keeps the comment of an accepted finding that has no change to make", async () => {
    const review = await reviewed();
    const missing = review.findings.find((f) => f.status === "missing");
    if (missing === undefined) throw new Error("the fixture has a missing clause");
    expect(missing.edit.kind).toBe("none");
    await decide(t, review, missing.ruleId, { decision: "accepted" });

    const file = await readDocx((await download(t, review.id)).bytes);
    expect(file.deletions + file.insertions).toBe(0);
    expect(file.comments).toHaveLength(1);
    expect(file.comments[0]?.text.startsWith(commentHead(missing))).toBe(true);
    expect(file.rejected).toEqual(original.rejected);
  });

  it("opens with the docx package, and with the same paragraphs the upload had", async () => {
    const review = await reviewed();
    const { document } = { document: review.documentId };
    await decide(t, review, "term", { decision: "accepted" });
    await decide(t, review, "definition", { decision: "accepted" });
    const { bytes } = await download(t, review.id);
    const parsed = await parseDocx(bytes);
    const listed = await t.json<{ documents: { id: string; paragraphs: number }[] }>(
      "/api/documents",
    );
    expect(parsed.paragraphs).toHaveLength(
      listed.body.documents.find((d) => d.id === document)?.paragraphs ?? -1,
    );
  });
});

describe("a finding the model could not turn into a change", () => {
  it("keeps its comment, with the wording that could not be applied, when it is accepted", async () => {
    const fix = await fixture(NDA);
    const scripts = oracleScripts(fix);
    const term = scripts["term"];
    if (term === undefined) throw new Error("the fixture scripts a term rule");
    // The model quotes words the clause does not contain, so the pipeline cannot place the change.
    const generator = createOracleGenerator({
      ...scripts,
      term: {
        ...term,
        edit: {
          clauseNumber: "3.1",
          quote: "words the clause does not contain",
          replacement: "x y",
        },
      },
    });
    const own = await createHarness({ generator });
    const review = await reviewed(own);
    const finding = own.finding(review, "term");
    expect(finding.edit.kind).toBe("comment-only");
    await decide(own, review, "term", { decision: "accepted" });

    const { response, bytes } = await download(own, review.id);
    expect(response.status).toBe(200);
    const file = await readDocx(bytes);
    expect(file.deletions + file.insertions).toBe(0);
    expect(file.comments).toHaveLength(1);
    expect(file.comments[0]?.text.startsWith(commentHead(finding))).toBe(true);
    expect(file.comments[0]?.text).toContain(
      "Suggested wording (could not be applied automatically): x y",
    );
    // That was the review's own doing, not a surprise at download time.
    expect(response.headers.get(WARNINGS_HEADER)).toBeNull();
  });
});

describe("what the download refuses", () => {
  it("answers 409 for a review that has not finished, 404 for one that is not there, 400 for a mode it does not know", async () => {
    const control = controllable(await oracleFor(NDA));
    const own = await createHarness({ generator: control.generator });
    const document = await own.uploadFixture(NDA);
    const started = await own.startReview(document.id, "builtin:nda-mutual");
    await control.calls(1);
    const waiting = await download(own, started.body.id);
    expect(waiting.response.status).toBe(409);
    expect(((await new Response(waiting.bytes).json()) as ApiError).error.code).toBe("conflict");
    control.release();
    await own.waitFor(started.body.id);

    expect((await download(own, "00000000-0000-4000-8000-0000000000ab")).response.status).toBe(404);
    expect((await download(own, "not-an-id")).response.status).toBe(404);
    for (const query of [
      "?include=everything",
      "?include=",
      "?include=ALL",
      "?include=accepted,all",
    ]) {
      const refused = await download(own, started.body.id, query);
      expect([query, refused.response.status]).toEqual([query, 400]);
    }
  });

  it("answers 409 with a message that names the rule and not the contract when the stored file is not the one reviewed", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    const [row] = await t.database.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, review.documentId));
    // Another contract under the same key: the words the report says were changed are not there.
    const other = await fixtureBytes("nda-balanced.docx");
    await t.storage.write(row?.key ?? "", other);

    const { response, bytes } = await download(t, review.id);
    expect(response.status).toBe(409);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as ApiError;
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("The document does not match the report");
    expect(body.error.message).toContain(t.finding(review, "term").title);
    // No sentence of either contract is in the message.
    for (const text of [...original.rejected, ...(await readDocx(other)).rejected]) {
      if (text.length > 30) expect(body.error.message).not.toContain(text.slice(0, 30));
    }
  });

  it("answers 500 with a request id, and no detail, for a failure that is not the file's fault", async () => {
    const review = await reviewed();
    await decide(t, review, "term", { decision: "accepted" });
    const [row] = await t.database.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, review.documentId));
    await t.storage.write(
      row?.key ?? "",
      new TextEncoder().encode("PK\u0003\u0004 this is not a zip"),
    );

    const before = t.lines.length;
    const { response, bytes } = await download(t, review.id);
    expect(response.status).toBe(500);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as ApiError;
    expect(body.error.code).toBe("internal_error");
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.error.message).not.toContain("zip");
    // The log has the kind of error and the request id, nothing it said.
    const logged = t.lines.slice(before).filter((line) => line.includes('"level":"error"'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(body.error.requestId ?? "missing");
    expect(logged[0]).not.toContain("this is not a zip");
  });
});

describe("the warnings header", () => {
  // The words of clause 3.1 sit inside a hyperlink in the stored copy, which the Word engine will
  // not edit. The text is the same, so the report still fits the file; only the change is refused.
  async function withLinkedClause(
    harness: Harness,
    review: ReviewDetail,
    words: string,
  ): Promise<void> {
    const [row] = await harness.database.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, review.documentId));
    const zip = await JSZip.loadAsync(await fixtureBytes(NDA));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expect(xml).toContain(words);
    zip.file(
      "word/document.xml",
      xml.replace(
        words,
        `</w:t></w:r><w:hyperlink w:anchor="top"><w:r><w:t xml:space="preserve">${words}</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">`,
      ),
    );
    await harness.storage.write(row?.key ?? "", await zip.generateAsync({ type: "uint8array" }));
  }

  const decoded = (value: string | null): string[] => {
    expect(value).not.toBeNull();
    // Plain ASCII, so any proxy and any fetch reads it the same.
    expect(value).toMatch(/^[\x21-\x7e]+$/);
    return JSON.parse(decodeURIComponent(value ?? "")) as string[];
  };

  it("says so when the engine refuses a change, and the comment carries the wording instead", async () => {
    const review = await reviewed();
    const term = t.finding(review, "term");
    await decide(t, review, "term", { decision: "accepted" });
    await withLinkedClause(t, review, appliedEdit(term).original);

    const { response, bytes } = await download(t, review.id);
    expect(response.status).toBe(200);
    expect(decoded(response.headers.get(WARNINGS_HEADER))).toEqual([
      `The tracked change for "${term.title}" could not be written (the range includes a hyperlink, which cannot be edited safely), so its comment is on the paragraph and carries the suggested wording.`,
    ]);
    const file = await readDocx(bytes);
    expect(file.deletions + file.insertions).toBe(0);
    expect(file.comments).toHaveLength(1);
    expect(file.comments[0]?.text).toContain(
      `Suggested wording (could not be applied automatically): ${appliedEdit(term).replacement}`,
    );
  });

  it("cuts a long list at whole warnings, to 4000 characters, with a last one that counts what was left out", async () => {
    const review = await reviewed();
    const term = t.finding(review, "term");
    const edit = appliedEdit(term);
    await withLinkedClause(t, review, edit.original);

    // Sixty copies of the finding, all of them refused for the same reason.
    const [stored] = await t.database.db
      .select({ report: reviews.report })
      .from(reviews)
      .where(eq(reviews.id, review.id));
    const report = stored?.report;
    const original_ = report?.results.find((r) => r.ruleId === "term");
    if (report === null || report === undefined || original_ === undefined) {
      throw new Error("the stored report has the term rule");
    }
    const copies = Array.from({ length: 60 }, (_, i) => ({
      ...structuredClone(original_),
      ruleId: `term-copy-${i}`,
      title: `Copy ${i} of the term rule`,
    }));
    await t.database.db
      .update(reviews)
      .set({ report: { ...report, results: [...report.results, ...copies] } })
      .where(eq(reviews.id, review.id));

    const { response } = await download(t, review.id, "?include=all");
    expect(response.status).toBe(200);
    const header = response.headers.get(WARNINGS_HEADER) ?? "";
    expect(header.length).toBeLessThanOrEqual(MAX_WARNINGS_HEADER_CHARS);
    expect(header.length).toBeGreaterThan(MAX_WARNINGS_HEADER_CHARS - 600);
    const warnings = decoded(header);
    const last = warnings.at(-1) ?? "";
    const kept = warnings.slice(0, -1);
    // 61 findings were refused: the original, and the 60 copies.
    expect(last).toBe(
      `${61 - kept.length} more warnings were left out because there was no room for them here.`,
    );
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(61);
    for (const warning of kept) expect(warning).toMatch(/^The tracked change for "/);
  });
});

describe("a download opened in LibreOffice", () => {
  const hasSoffice = spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0;

  it("shows as many tracked changes and comments as were written", async (context) => {
    if (!hasSoffice) {
      context.skip(
        "LibreOffice (soffice) is not installed here, so the converted file could not be inspected. The same counts are checked with the independent reader in the other tests.",
      );
      return;
    }
    const review = await reviewed();
    for (const ruleId of ["term", "governing-law", "remedies"]) {
      await decide(t, review, ruleId, { decision: "accepted" });
    }
    await decide(t, review, "compelled-disclosure", { decision: "accepted" });
    const { bytes } = await download(t, review.id);
    const written = await readDocx(bytes);
    expect(written.deletions + written.insertions).toBe(6);
    expect(written.comments).toHaveLength(4);

    const dir = await tempDir("clausewise-lo-");
    await mkdir(join(dir, "profile"), { recursive: true });
    const input = join(dir, "redline.docx");
    await writeFile(input, bytes);
    await run(
      "soffice",
      [
        `-env:UserInstallation=file://${join(dir, "profile")}`,
        "--headless",
        "--convert-to",
        "odt",
        "--outdir",
        dir,
        input,
      ],
      { timeout: 150_000 },
    );
    const odt = await JSZip.loadAsync(await readFile(join(dir, "redline.odt")));
    const content = (await odt.file("content.xml")?.async("string")) ?? "";
    expect(content.match(/<text:changed-region[ >]/g)?.length ?? 0).toBe(
      written.deletions + written.insertions,
    );
    expect(content.match(/<office:annotation[ >]/g)?.length ?? 0).toBe(written.comments.length);
  }, 180_000);
});
