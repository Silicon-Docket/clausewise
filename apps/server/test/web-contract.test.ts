import type { DocumentSummary, Finding, ReviewDetail } from "@clausewise/api";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { readDocx } from "./docx-reader.js";
import { createHarness, fixtureBytes, oracleFor, type Harness } from "./support.js";

// What the web app relies on, written down as tests so that a change on either side shows up here.

const NDA = "nda-aggressive.docx";

let t: Harness;
beforeAll(async () => {
  t = await createHarness({ generator: await oracleFor(NDA), scope: "file" });
});

describe("a decision and wording of the lawyer's own, in one request", () => {
  it("takes both together, and answers with the finding as it now stands", async () => {
    const { review } = await t.reviewedFixture(NDA);
    const answer = await t.send<Finding>("PATCH", `/api/reviews/${review.id}/findings/term`, {
      decision: "accepted",
      editedReplacement: "end three (3) years after disclosure",
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ruleId: "term",
      decision: "accepted",
      editedReplacement: "end three (3) years after disclosure",
    });
    expect(answer.body.edit.kind).toBe("applied");

    const again = await t.json<ReviewDetail>(`/api/reviews/${review.id}`);
    expect(t.finding(again.body, "term")).toEqual(answer.body);
  });

  it("takes a reset: pending, and the lawyer's wording cleared, in one request", async () => {
    const { review } = await t.reviewedFixture(NDA);
    const path = (ruleId: string) => `/api/reviews/${review.id}/findings/${ruleId}`;
    await t.send("PATCH", path("term"), { decision: "accepted", editedReplacement: "x" });

    const reset = await t.send<Finding>("PATCH", path("term"), {
      decision: "pending",
      editedReplacement: null,
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ decision: "pending", editedReplacement: null });

    // The same request is allowed for a finding that has no change to make, where there is
    // nothing to clear, because the screen sends it for every finding it resets.
    await t.send("PATCH", path("compelled-disclosure"), { decision: "accepted" });
    const missing = await t.send<Finding>("PATCH", path("compelled-disclosure"), {
      decision: "pending",
      editedReplacement: null,
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ decision: "pending", editedReplacement: null });
    expect(missing.body.edit.kind).toBe("none");
  });

  it("keeps the wording when only the decision changes, and the decision when only the wording does", async () => {
    const { review } = await t.reviewedFixture(NDA);
    const path = `/api/reviews/${review.id}/findings/term`;
    await t.send("PATCH", path, { decision: "accepted", editedReplacement: "wording" });
    const rejected = await t.send<Finding>("PATCH", path, { decision: "rejected" });
    expect(rejected.body).toMatchObject({ decision: "rejected", editedReplacement: "wording" });
    const edited = await t.send<Finding>("PATCH", path, { editedReplacement: "other wording" });
    expect(edited.body).toMatchObject({ decision: "rejected", editedReplacement: "other wording" });
  });
});

describe("the place of a change in its paragraph", () => {
  // The screen cuts the paragraph with these numbers, in JavaScript, which counts in UTF-16 units.
  // A character outside the basic plane is two units, so a count in characters would be off.
  async function astralDocument(): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await fixtureBytes(NDA));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const before = "obligations under this Agreement are perpetual and shall continue indefinitely";
    expect(xml).toContain(before);
    zip.file(
      "word/document.xml",
      xml
        .replace("obligations under this", "\u{1F600}\u{1F4C4} obligations under this")
        .replace("continue indefinitely, whether", "continue indefinitely \u{1F600}, whether"),
    );
    return zip.generateAsync({ type: "uint8array" });
  }

  it("counts in UTF-16 units into the paragraph text, with an emoji before the change and after it", async () => {
    const bytes = await astralDocument();
    const upload = await t.upload("astral.docx", new Uint8Array(bytes));
    expect(upload.status).toBe(201);
    const document = (await upload.json()) as DocumentSummary;
    const started = await t.startReview(document.id, "builtin:nda-mutual");
    const review = await t.waitFor(started.body.id);
    expect(review.status).toBe("done");

    const edit = t.finding(review, "term").edit;
    if (edit.kind !== "applied") throw new Error("the term rule has an applied edit");
    // The paragraph has characters that are two units long, before the change.
    expect(edit.paragraphText).toContain("\u{1F600}\u{1F4C4}");
    expect([...edit.paragraphText].length).toBeLessThan(edit.paragraphText.length);
    expect(edit.paragraphText.indexOf("\u{1F600}\u{1F4C4}")).toBeLessThan(edit.start);

    // The numbers are UTF-16 offsets: cutting the text with them gives the words, and cutting it
    // by characters would not.
    expect(edit.paragraphText.slice(edit.start, edit.end)).toBe(edit.original);
    expect(edit.start).toBe(edit.paragraphText.indexOf(edit.original));
    expect(edit.end - edit.start).toBe(edit.original.length);
    expect([...edit.paragraphText].slice(edit.start, edit.end).join("")).not.toBe(edit.original);

    // And the same numbers are what the redline is written with: accepted, the paragraph reads
    // as the screen's own cut of it says, emoji and all.
    await t.send("PATCH", `/api/reviews/${review.id}/findings/term`, { decision: "accepted" });
    const response = await t.request(`/api/reviews/${review.id}/docx`);
    expect(response.status).toBe(200);
    const file = await readDocx(new Uint8Array(await response.arrayBuffer()));
    const want =
      edit.paragraphText.slice(0, edit.start) +
      edit.replacement +
      edit.paragraphText.slice(edit.end);
    expect(file.accepted).toContain(want);
    expect(file.rejected).toContain(edit.paragraphText);
  });
});

describe("the files the web app downloads", () => {
  // A name with a quote, accents, an emoji, a bidirectional override and a bell. Cleaning keeps what
  // can be shown and drops the rest; the header must still hold exactly what the screen shows.
  const NAME = 'Acme "Q3" \u00dcbersicht \u{1F4C4} \u202e\u0007draft.docx';

  it("name them for a person and cannot be bent by what the upload was called", async () => {
    const upload = await t.upload(NAME, await fixtureBytes(NDA));
    expect(upload.status).toBe(201);
    const document = (await upload.json()) as DocumentSummary;
    expect(document.fileName).toBe('Acme "Q3" \u00dcbersicht \u{1F4C4} draft.docx');
    const started = await t.startReview(document.id, "builtin:nda-mutual");
    const review = await t.waitFor(started.body.id);
    await t.send("PATCH", `/api/reviews/${review.id}/findings/term`, { decision: "accepted" });

    const downloads = [
      [`/api/documents/${document.id}/file`, document.fileName],
      [`/api/reviews/${review.id}/docx`, 'Acme "Q3" \u00dcbersicht \u{1F4C4} draft.redlined.docx'],
      [
        `/api/reviews/${review.id}/report?format=json`,
        'Acme "Q3" \u00dcbersicht \u{1F4C4} draft.report.json',
      ],
      [
        `/api/reviews/${review.id}/report?format=md`,
        'Acme "Q3" \u00dcbersicht \u{1F4C4} draft.summary.md',
      ],
    ] as const;
    for (const [path, shownName] of downloads) {
      const response = await t.request(path);
      expect(response.status, path).toBe(200);
      const disposition = response.headers.get("content-disposition") ?? "";
      // An attachment, with a plain ASCII name for old clients and the real one for the rest.
      expect(disposition, path).toMatch(
        /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+=@-]*$/,
      );
      const plain = /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
      expect(plain, path).not.toContain('"');
      expect(plain, path).not.toContain("\\");
      const real = /filename\*=UTF-8''(.*)$/.exec(disposition)?.[1] ?? "";
      expect(decodeURIComponent(real), path).toBe(shownName);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      // Nothing the name said became a header of its own.
      expect(response.headers.get("x-injected"), path).toBeNull();
    }
  });

  it("keep the mark that says which file it is when the document's name is as long as a name can be", async () => {
    const name = `${"n".repeat(195)}.docx`;
    const upload = await t.upload(name, await fixtureBytes(NDA));
    const document = (await upload.json()) as DocumentSummary;
    expect(document.fileName).toBe(name);
    const started = await t.startReview(document.id, "builtin:nda-mutual");
    const review = await t.waitFor(started.body.id);
    const wanted = [
      [`/api/reviews/${review.id}/docx`, ".redlined.docx"],
      [`/api/reviews/${review.id}/report?format=json`, ".report.json"],
      [`/api/reviews/${review.id}/report?format=md`, ".summary.md"],
    ] as const;
    for (const [path, suffix] of wanted) {
      const response = await t.request(path);
      const real = /filename\*=UTF-8''(.*)$/.exec(
        response.headers.get("content-disposition") ?? "",
      )?.[1];
      const shown = decodeURIComponent(real ?? "");
      expect(shown, path).toHaveLength(200);
      expect(shown.endsWith(suffix), path).toBe(true);
    }
  });

  it("send the right kind of file with each name", async () => {
    const { document, review } = await t.reviewedFixture(NDA);
    const expected: [string, string, string][] = [
      [
        `/api/documents/${document.id}/file`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        `attachment; filename="nda-aggressive.docx"; filename*=UTF-8''nda-aggressive.docx`,
      ],
      [
        `/api/reviews/${review.id}/report`,
        "application/json; charset=utf-8",
        `attachment; filename="nda-aggressive.report.json"; filename*=UTF-8''nda-aggressive.report.json`,
      ],
      [
        `/api/reviews/${review.id}/report?format=md`,
        "text/markdown; charset=utf-8",
        `attachment; filename="nda-aggressive.summary.md"; filename*=UTF-8''nda-aggressive.summary.md`,
      ],
    ];
    for (const [path, type, disposition] of expected) {
      const response = await t.request(path);
      expect(response.headers.get("content-type"), path).toBe(type);
      expect(response.headers.get("content-disposition"), path).toBe(disposition);
    }
  });
});
