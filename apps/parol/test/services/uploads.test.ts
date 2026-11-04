import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseDocument } from "../../src/ingest/parse.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { UploadError } from "../../src/module-contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { toSourceSpans } from "../../src/store/index.js";
import {
  baseWorld,
  cleanup,
  makeWorld,
  newMatter,
  twinOf,
  uploadCase,
  type World,
} from "./support.js";
import { buildCaseWorld } from "../integration/pipeline.js";

afterAll(cleanup);

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const NDA_FILE = baseWorld.files[0]!;
const AMENDMENT_FILE = baseWorld.files[1]!;

const errorOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

/** What the store and the file store hold for a matter, to show that a refused upload left no trace. */
function traces(w: World, matterId: string) {
  const dir = join(w.files.root, matterId);
  let stored: string[] = [];
  try {
    stored = readdirSync(dir);
  } catch {
    stored = [];
  }
  return {
    documents: w.repo.listDocuments(matterId).length,
    versions: w.repo.listVersions(matterId).length,
    spans: w.repo
      .listVersions(matterId)
      .reduce((n, v) => n + w.repo.listSpans(matterId, [v.id]).length, 0),
    warnings: w.repo.listIngestWarnings(matterId).length,
    audit: w.repo.listMatterAuditEvents(matterId).events.length,
    inputs: w.repo.getMatter(matterId)!.currentInputsSha256,
    files: stored,
  };
}

describe("upload", () => {
  it("stores the NDA and an amendment under generated names, with spans equal to what ingest makes", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const first = await w.services.matters.addDocument(am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: "../../etc/Lanternfish Mutual NDA (final).docx",
      bytes: NDA_FILE.bytes,
      statedDate: "2026-02-02",
    });
    expect(first.warnings).toEqual([]);
    const second = await w.services.matters.addDocument(am, {
      title: "Amendment No. 1",
      kind: "amendment",
      fileName: "amendment.TXT",
      bytes: AMENDMENT_FILE.bytes,
      statedDate: "2026-09-15",
    });

    const versions = w.repo.listVersions(matterId);
    expect(versions.map((v) => [v.mediaType, v.operative, v.versionNo])).toEqual([
      ["docx", true, 1],
      ["txt", true, 1],
    ]);
    // The name of the file is read for its extension only; the stored name is generated.
    for (const v of versions)
      expect(v.storagePath).toMatch(new RegExp(`^${matterId}/f_[0-9a-f]{32}$`));
    expect(readdirSync(join(w.files.root, matterId)).sort()).toEqual(
      versions.map((v) => v.storagePath.split("/")[1]!).sort(),
    );

    const ids = [first.versionId, second.versionId];
    const expected = buildIngest({
      documents: baseWorld.documents.map((d, i) => ({ ...d, documentVersionId: ids[i]! })),
    });
    expect(toSourceSpans(w.repo.listSpans(matterId, ids))).toEqual(expected.spans);
    expect(w.repo.listAnnotations(matterId, ids)).toEqual(expected.annotations);
    expect(w.services.matters.view(am).matter.status).toBe("ready");
  });

  it("keeps the annotations equal to what ingest makes of the documents that govern", async () => {
    // A term the NDA defines and the amendment uses is linked across them, and the link follows
    // the set: with the NDA alone there is no such link, and a new NDA version moves it.
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    // The amendment names the parties, which the NDA defines as terms.
    const linked = (ids: string[]) =>
      w.repo
        .listAnnotations(matterId, ids)
        .filter(
          (a) =>
            a.kind === "uses_term" &&
            a.spanId.startsWith(`${ids[1]}:`) &&
            ["Corvane", "Lanternfish"].includes(a.term),
        ).length;
    expect(linked(uploaded.versionIds)).toBe(2);

    // A new NDA version that defines nothing: the amendment's uses of terms are no longer linked.
    const bare = await w.services.matters.addVersion(am, uploaded.documentIds[0]!, {
      fileName: "nda-2.txt",
      bytes: text(
        "MUTUAL NONDISCLOSURE AGREEMENT\n\n1. The parties will protect information they share with each other.",
      ),
      statedDate: "2026-02-02",
    });
    const ids = [bare.versionId, uploaded.versionIds[1]!];
    expect(linked(ids)).toBe(0);
    // Back to the first NDA: the links come back, and equal what ingest makes.
    w.services.matters.setOperative(am, uploaded.documentIds[0]!, uploaded.versionIds[0]!);
    expect(linked(uploaded.versionIds)).toBe(2);
    const expected = buildIngest({
      documents: baseWorld.documents.map((d, i) => ({
        ...d,
        documentVersionId: uploaded.versionIds[i]!,
      })),
    });
    expect(w.repo.listAnnotations(matterId, uploaded.versionIds)).toEqual(expected.annotations);
  });

  it("asks for the NDA first, and for no second NDA", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const amendment = {
      title: "Amendment No. 1",
      kind: "amendment" as const,
      fileName: "a.txt",
      bytes: AMENDMENT_FILE.bytes,
      statedDate: null,
    };
    const before = traces(w, matterId);
    expect(await errorOf(() => w.services.matters.addDocument(am, amendment))).toMatchObject({
      name: "ValidationError",
      code: "nda_first",
    });
    expect(traces(w, matterId)).toEqual(before);

    await uploadCase(w, matterId);
    const nda = {
      ...amendment,
      title: "Another NDA",
      kind: "nda" as const,
      bytes: text("A different mutual agreement about secrets that is long enough."),
    };
    expect(await errorOf(() => w.services.matters.addDocument(am, nda))).toMatchObject({
      name: "ConflictError",
      code: "nda_exists",
    });
    // Two amendments at most.
    for (const n of [2, 3]) {
      const extra = {
        ...amendment,
        title: `Amendment No. ${n}`,
        bytes: text(
          `AMENDMENT NO. ${n}\n\n1. This is the amendment number ${n}, which says something.`,
        ),
      };
      const result = await errorOf(() => w.services.matters.addDocument(am, extra)).catch(
        () => null,
      );
      if (n === 3) expect(result).toMatchObject({ name: "ConflictError", code: "document_limit" });
    }
    expect(w.repo.listDocuments(matterId)).toHaveLength(3);
  });
});

describe("a file that is already in the matter", () => {
  it("is not stored again, and the person is told which version it is", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const before = traces(w, matterId);

    const again = await w.services.matters.addDocument(am, {
      title: "Amendment No. 1, again",
      kind: "amendment",
      fileName: "same-thing-with-another-name.txt",
      bytes: AMENDMENT_FILE.bytes,
      statedDate: "2026-09-15",
    });
    expect(again).toEqual({
      documentId: uploaded.documentIds[1],
      versionId: uploaded.versionIds[1],
      warnings: [
        {
          code: "duplicate_document",
          documentLabel: "D2",
          spanLabel: null,
          detail: "same file as D2 v1, not stored again",
        },
      ],
    });
    expect(traces(w, matterId)).toEqual(before);
    expect(w.services.matters.view(am).matter.status).toBe("ready");

    // As a new version of another document, too.
    const asVersion = await w.services.matters.addVersion(am, uploaded.documentIds[0]!, {
      fileName: "nda.txt",
      bytes: AMENDMENT_FILE.bytes,
      statedDate: null,
    });
    expect(asVersion.versionId).toBe(uploaded.versionIds[1]);
    expect(asVersion.warnings.map((x) => x.code)).toEqual(["duplicate_document"]);
    expect(traces(w, matterId)).toEqual(before);
  });

  it("does not undo a review: results stay current", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    await w.services.matters.addDocument(am, {
      title: "x",
      kind: "amendment",
      fileName: "x.txt",
      bytes: AMENDMENT_FILE.bytes,
      statedDate: null,
    });
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", current: true });
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
  });

  it("two uploads of one file at once store it once", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await w.services.matters.addDocument(am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: "n.docx",
      bytes: NDA_FILE.bytes,
      statedDate: null,
    });
    const upload = () =>
      w.services.matters.addDocument(am, {
        title: "Amendment No. 1",
        kind: "amendment",
        fileName: "a.txt",
        bytes: AMENDMENT_FILE.bytes,
        statedDate: null,
      });
    const results = await Promise.all([upload(), upload()]);
    expect(results.map((r) => r.warnings.map((x) => x.code)).sort()).toEqual([
      [],
      ["duplicate_document"],
    ]);
    expect(w.repo.listVersions(matterId)).toHaveLength(2);
    expect(readdirSync(join(w.files.root, matterId))).toHaveLength(2);
  });
});

describe("a re-saved file with the same text", () => {
  it("is stored and warned about, the old version keeps governing, and the associate may choose the copy", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    // Windows line endings: other bytes, the same paragraphs.
    const resaved = text(new TextDecoder().decode(AMENDMENT_FILE.bytes).replace(/\n/g, "\r\n"));
    const parsedBefore = await parseDocument({ bytes: AMENDMENT_FILE.bytes, mediaType: "txt" });
    const parsedAfter = await parseDocument({ bytes: resaved, mediaType: "txt" });
    expect(documentTextSha256(parsedAfter.paragraphs)).toBe(
      documentTextSha256(parsedBefore.paragraphs),
    );

    const result = await w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "amendment-1-resaved.txt",
      bytes: resaved,
      statedDate: "2026-09-15",
    });
    expect(result.warnings).toEqual([
      {
        code: "near_duplicate_version",
        documentLabel: "D2",
        spanLabel: null,
        detail: "same text as D2 v1, saved as a different file",
      },
    ]);
    expect(w.repo.getVersion(matterId, result.versionId)).toMatchObject({
      versionNo: 2,
      operative: false,
    });

    // The old version keeps governing, so the matter is as ready as it was and nothing is stale.
    const view = w.services.matters.view(am);
    expect(view.start).toEqual({ ready: true, reasons: [] });
    expect(view.matter.status).toBe("ready");
    expect(view.staleReason).toBeNull();
    expect(view.documents[1]!.versions.map((v) => [v.versionNo, v.operative])).toEqual([
      [1, true],
      [2, false],
    ]);
    // The copy is on record with its notice, because the associate may have meant to use it.
    expect(view.warnings.map((x) => x.code)).toEqual(["near_duplicate_version"]);
    expect(w.repo.hasSpans(matterId, result.versionId)).toBe(true);

    // Choosing it is the associate's: it makes that file govern, and the spans of it are there.
    w.services.matters.setOperative(am, uploaded.documentIds[1]!, result.versionId);
    expect(w.services.matters.view(am).start.ready).toBe(true);
    expect(
      w.services.matters.view(am).documents[1]!.versions.map((v) => [v.versionNo, v.operative]),
    ).toEqual([
      [1, false],
      [2, true],
    ]);
    // And choosing the first again puts it back. The copy stays on record with its notice.
    w.services.matters.setOperative(am, uploaded.documentIds[1]!, uploaded.versionIds[1]!);
    expect(w.services.matters.view(am).warnings.map((x) => x.code)).toEqual([
      "near_duplicate_version",
    ]);
  });

  it("a changed file is a new version that governs at once", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const result = await w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "amendment-1-v2.txt",
      bytes: text(
        `${new TextDecoder().decode(AMENDMENT_FILE.bytes)}\n5. This is a new paragraph in the amendment.\n`,
      ),
      statedDate: "2026-09-16",
    });
    expect(result.warnings).toEqual([]);
    expect(w.repo.getVersion(matterId, result.versionId)).toMatchObject({
      versionNo: 2,
      operative: true,
      statedDate: "2026-09-16",
    });
    expect(w.repo.getVersion(matterId, uploaded.versionIds[1]!)!.operative).toBe(false);
    expect(w.services.matters.view(am).start.ready).toBe(true);
    // The old version keeps its spans, so findings that cite it can still be read.
    expect(w.repo.hasSpans(matterId, uploaded.versionIds[1]!)).toBe(true);
  });
});

describe("hostile and broken files", () => {
  it("warns about text that reads like an instruction, names the paragraph, and keeps the words out of it", async () => {
    const hostile = await buildCaseWorld("PAROL-D08");
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const file = hostile.files[0]!;
    const result = await w.services.matters.addDocument(am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: file.file,
      bytes: file.bytes,
      statedDate: null,
    });
    const warning = result.warnings.find((x) => x.code === "instruction_like_text")!;
    expect(warning).toBeDefined();
    expect(warning.documentLabel).toBe("D1");
    expect(warning.spanLabel).toMatch(/^D1-p\d+$/);
    expect(warning.detail).toMatch(/^matched .+ in D1-p\d+$/);
    // The paragraph is stored like any other, as text to be reviewed.
    const span = w.repo
      .listSpans(matterId, [result.versionId])
      .find((s) => s.label === warning.spanLabel)!;
    expect(span.text.length).toBeGreaterThan(20);
    expect(JSON.stringify(result.warnings)).not.toContain(span.text.slice(0, 30));
    expect(w.services.matters.view(am).warnings).toEqual(result.warnings);
    // The twin without that paragraph raises nothing.
    const twin = await twinOf("PAROL-D08");
    const w2 = makeWorld();
    const m2 = newMatter(w2);
    const clean = await w2.services.matters.addDocument(m2.am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: twin.files[0]!.file,
      bytes: twin.files[0]!.bytes,
      statedDate: null,
    });
    expect(clean.warnings).toEqual([]);
  });

  it.each([
    [
      "a file that is not a Word document",
      "nda.docx",
      () => text("this is not a zip file, whatever its name says"),
    ],
    ["an empty file", "nda.txt", () => new Uint8Array()],
    ["a file with almost no text", "nda.txt", () => text("hi")],
    ["a file of another type", "nda.pdf", () => NDA_FILE.bytes],
    ["a file with no extension", "nda", () => NDA_FILE.bytes],
    ["a Word file named as text", "nda.txt.exe", () => NDA_FILE.bytes],
  ])("refuses %s and leaves nothing behind", async (_name, fileName, bytes) => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const before = traces(w, matterId);
    const error = await errorOf(() =>
      w.services.matters.addDocument(am, {
        title: "Mutual NDA",
        kind: "nda",
        fileName,
        bytes: bytes(),
        statedDate: null,
      }),
    );
    expect(error).toBeInstanceOf(UploadError);
    expect(traces(w, matterId)).toEqual(before);
    expect(before.files).toEqual([]);
  });

  it("refuses a new version it cannot read, and the matter is as it was", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const before = traces(w, matterId);
    const error = await errorOf(() =>
      w.services.matters.addVersion(am, uploaded.documentIds[0]!, {
        fileName: "nda-2.docx",
        bytes: text("PK but not really a Word document"),
        statedDate: null,
      }),
    );
    expect(error).toBeInstanceOf(UploadError);
    expect(traces(w, matterId)).toEqual(before);
    expect(w.services.matters.view(am).matter.status).toBe("ready");
  });

  it("takes back the stored file when the store refuses the document, whatever the reason", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const before = traces(w, matterId);
    // A title the store will not accept, found only after the file is saved.
    const error = await errorOf(() =>
      w.services.matters.addDocument(am, {
        title: "   ",
        kind: "nda",
        fileName: "nda.docx",
        bytes: NDA_FILE.bytes,
        statedDate: null,
      }),
    );
    expect(error).toMatchObject({ name: "ValidationError" });
    expect(traces(w, matterId)).toEqual(before);
    // And a date that is not one.
    expect(
      await errorOf(() =>
        w.services.matters.addDocument(am, {
          title: "Mutual NDA",
          kind: "nda",
          fileName: "nda.docx",
          bytes: NDA_FILE.bytes,
          statedDate: "yesterday",
        }),
      ),
    ).toMatchObject({ name: "ValidationError" });
    expect(traces(w, matterId)).toEqual(before);
  });

  it("refuses a kind that is not one, and bytes that are not bytes", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const base = { title: "x", fileName: "a.txt", statedDate: null };
    expect(
      await errorOf(() =>
        w.services.matters.addDocument(am, {
          ...base,
          kind: "memo" as never,
          bytes: NDA_FILE.bytes,
        }),
      ),
    ).toMatchObject({ code: "bad_kind" });
    expect(
      await errorOf(() =>
        w.services.matters.addDocument(am, { ...base, kind: "nda", bytes: "text" as never }),
      ),
    ).toMatchObject({ code: "bad_bytes" });
    expect(traces(w, matterId).documents).toBe(0);
  });
});

describe("documents", () => {
  it("are removed last first, with their files and everything derived from them", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const paths = w.repo.listVersions(matterId).map((v) => v.storagePath);
    // The NDA cannot go while an amendment depends on it being D1.
    expect(() => w.services.matters.removeDocument(am, uploaded.documentIds[0]!)).toThrow(
      expect.objectContaining({ code: "remove_later_first" }),
    );
    w.services.matters.removeDocument(am, uploaded.documentIds[1]!);
    expect(w.files.exists(paths[1]!)).toBe(false);
    expect(w.files.exists(paths[0]!)).toBe(true);
    expect(w.repo.listSpans(matterId, [uploaded.versionIds[1]!])).toEqual([]);
    expect(w.repo.listIngestWarnings(matterId, [uploaded.versionIds[1]!])).toEqual([]);
    expect(w.services.matters.view(am).start.ready).toBe(true);
    w.services.matters.removeDocument(am, uploaded.documentIds[0]!);
    expect(w.services.matters.view(am).matter.status).toBe("draft");
    expect(w.services.matters.view(am).start.reasons).toEqual(["Upload the NDA"]);
    expect(readdirSync(join(w.files.root, matterId))).toEqual([]);
    // After removing the NDA, the new NDA is D1 again.
    const fresh = await w.services.matters.addDocument(am, {
      title: "Mutual NDA",
      kind: "nda",
      fileName: "nda.docx",
      bytes: NDA_FILE.bytes,
      statedDate: null,
    });
    expect(w.services.matters.view(am).documents[0]!.label).toBe("D1");
    expect(fresh.documentId).toBeTruthy();
  });

  it("have a stated date that is validated and that makes the results stale", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(() =>
      w.services.matters.setStatedDate(am, uploaded.versionIds[1]!, "15 September"),
    ).toThrow(expect.objectContaining({ name: "ValidationError" }));
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
    w.services.matters.setStatedDate(am, uploaded.versionIds[1]!, "2026-09-14");
    expect(w.services.matters.view(am)).toMatchObject({
      matter: { status: "stale" },
      staleReason: "The stated date of a document changed after this review.",
    });
    // A version of another matter is as good as absent.
    const other = newMatter(w, "other");
    expect(() => w.services.matters.setStatedDate(other.am, uploaded.versionIds[1]!, null)).toThrow(
      expect.objectContaining({ name: "NotFoundError" }),
    );
    expect(matterId).toBeTruthy();
  });

  it("can be made operative only as a version of that document", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    expect(() =>
      w.services.matters.setOperative(am, uploaded.documentIds[0]!, uploaded.versionIds[1]!),
    ).toThrow(expect.objectContaining({ name: "NotFoundError" }));
    expect(w.repo.getVersion(matterId, uploaded.versionIds[1]!)!.operative).toBe(true);
  });
});
