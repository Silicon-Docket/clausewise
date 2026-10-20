import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { documents } from "../src/db/schema.js";
import { HttpError } from "../src/errors.js";
import { loadRedlineInput } from "../src/routes/export.js";
import { controllable, createHarness, fixtureBytes, oracleFor, type Harness } from "./support.js";

// The download route is added on top of this function, so what it hands to the redline writer is
// decided here: the stored file, the stored report, and which findings go in with whose wording.

const NDA = "builtin:nda-mutual";

describe("what the download is built from", () => {
  let t: Harness;
  let reviewId: string;
  beforeAll(async () => {
    t = await createHarness({ generator: await oracleFor("nda-aggressive.docx"), scope: "file" });
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    reviewId = review.id;
    const patch = (ruleId: string, body: unknown) =>
      t.send("PATCH", `/api/reviews/${reviewId}/findings/${ruleId}`, body);
    await patch("term", { decision: "accepted", editedReplacement: "end after three years" });
    await patch("governing-law", { decision: "accepted" });
    await patch("compelled-disclosure", { decision: "accepted" });
    await patch("remedies", {
      decision: "rejected",
      editedReplacement: "damages as provided by law",
    });
    // Wording of its own on a finding that is still undecided.
    await patch("definition", { editedReplacement: "that is marked confidential" });
  });

  it("with accepted: the accepted findings only, with the lawyer's own wording", async () => {
    const input = await loadRedlineInput(t.deps, reviewId, "accepted");
    expect([...input.include].sort()).toEqual(["compelled-disclosure", "governing-law", "term"]);
    expect([...input.replacements]).toEqual([["term", "end after three years"]]);
    expect(input.fileName).toBe("nda-aggressive.docx");
    expect(Buffer.compare(input.docx, await fixtureBytes("nda-aggressive.docx"))).toBe(0);
    expect(input.report.results).toHaveLength(10);
    expect(input.report.playbook.name).toBe("Mutual NDA (receiving party)");
  });

  it("with all: everything that is not rejected, and wording only for what is included", async () => {
    const input = await loadRedlineInput(t.deps, reviewId, "all");
    expect(input.include.has("remedies")).toBe(false);
    expect(input.include.size).toBe(9);
    expect(input.include.has("definition")).toBe(true);
    expect(input.replacements.get("definition")).toBe("that is marked confidential");
    expect(input.replacements.get("term")).toBe("end after three years");
    // Rejected, so neither the finding nor its wording goes into the file.
    expect(input.replacements.has("remedies")).toBe(false);
  });

  it("includes an accepted comment-only finding with no wording to replace", async () => {
    const input = await loadRedlineInput(t.deps, reviewId, "accepted");
    expect(input.include.has("compelled-disclosure")).toBe(true);
    expect(input.replacements.has("compelled-disclosure")).toBe(false);
  });

  it("holds nothing when nothing is accepted", async () => {
    const u = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    const { review } = await u.reviewedFixture("nda-aggressive.docx");
    const input = await loadRedlineInput(u.deps, review.id, "accepted");
    expect(input.include.size).toBe(0);
    expect(input.replacements.size).toBe(0);
    expect((await loadRedlineInput(u.deps, review.id, "all")).include.size).toBe(10);
  });

  it("refuses a review that is not done, one that does not exist, and a file that is gone", async () => {
    const reason = async (promise: Promise<unknown>): Promise<HttpError> => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof HttpError) return error;
        throw error;
      }
      throw new Error("expected a refusal");
    };
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const u = await createHarness({ generator: control.generator });
    const document = await u.uploadFixture("nda-aggressive.docx");
    const started = await u.startReview(document.id, NDA);
    await control.calls(1);
    const notDone = await reason(loadRedlineInput(u.deps, started.body.id, "accepted"));
    expect([notDone.status, notDone.code]).toEqual([409, "conflict"]);
    control.release();
    await u.waitFor(started.body.id);

    const missing = await reason(
      loadRedlineInput(u.deps, "00000000-0000-4000-8000-0000000000ab", "all"),
    );
    expect([missing.status, missing.code]).toEqual([404, "not_found"]);

    const [row] = await u.database.db.select().from(documents).where(eq(documents.id, document.id));
    await rm(join(u.dataDir, "documents", row?.storageKey ?? ""));
    const gone = await reason(loadRedlineInput(u.deps, started.body.id, "all"));
    expect([gone.status, gone.code]).toEqual([404, "not_found"]);
    expect(gone.message).toContain("missing");
  });
});
