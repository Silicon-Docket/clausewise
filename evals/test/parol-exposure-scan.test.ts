import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  classifyCell,
  type Expected,
  type Observed,
  type Snapshot,
} from "../src/parol/exposure/authorization.js";
import { ExposureControlFailure } from "../src/parol/exposure/errors.js";
import { createCapturingGenerator } from "../src/parol/exposure/model.js";
import {
  createLedger,
  createScanner,
  maximalIds,
  plainTextOf,
  plantedDocx,
  runControl,
  textViewsOf,
  zipMethod,
  type ScanTarget,
  type Scanner,
  type TokenSet,
} from "../src/parol/exposure/scan.js";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { z } from "zod";

/**
 * A security test that cannot fail proves nothing, so the scanner and the classifier are shown
 * here finding what they are for, on synthetic strings made for the test.
 */

const CANARY = "CANARY-TESTMATTER-0123456789ab";
const OTHER = "CANARY-TESTMATTER-ba9876543210";
const SPAN = "ver_00000000feedface:p17";
const forbid: TokenSet = { canary: [CANARY, OTHER], ids: [SPAN, "mat_00000000deadbeef"] };

const target = (
  content: string | Uint8Array,
  kind: ScanTarget["kind"] = "http_body",
): ScanTarget => ({
  kind,
  label: "test",
  content,
  forbid,
});

/**
 * A Word package like the one the application writes: DEFLATE compressed, so that a scanner that
 * does not inflate reads nothing of it. `compression` "STORE" makes the stored kind the old tests
 * used, to show what it could not tell apart.
 */
async function docx(
  paragraphs: string[],
  runLength: number,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  const runs = (text: string): string =>
    (text.match(new RegExp(`.{1,${runLength}}`, "gs")) ?? [])
      .map((part) => `<w:r><w:t>${part}</w:t></w:r>`)
      .join("");
  zip.file(
    "word/document.xml",
    `<w:document><w:body>${paragraphs.map((p) => `<w:p>${runs(p)}</w:p>`).join("")}</w:body></w:document>`,
  );
  zip.file(
    "docProps/core.xml",
    "<cp:coreProperties><dc:title>Synthetic</dc:title></cp:coreProperties>",
  );
  return zip.generateAsync({ type: "uint8array", compression });
}

/** The bytes of a Word package with one entry's compressed data damaged in a way that cannot be inflated. */
function withBrokenEntry(bytes: Uint8Array, entry: string): Uint8Array {
  const out = Uint8Array.from(bytes);
  const view = new DataView(out.buffer);
  let offset = 0;
  while (offset + 30 < out.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = Buffer.from(out.subarray(offset + 30, offset + 30 + nameLength)).toString("utf8");
    const data = offset + 30 + nameLength + extraLength;
    // The first byte of a DEFLATE stream: final block, block type 3, which does not exist.
    if (name === entry) out[data] = 0x07;
    offset = data + compressed;
  }
  return out;
}

describe("the scanner", () => {
  const scanner = createScanner();

  it("finds a canary string in text, in any case", async () => {
    expect(await scanner.scan(target(`before ${CANARY} after`))).toEqual([
      { kind: "http_body", label: "test", token: "canary", index: 0 },
    ]);
    expect((await scanner.scan(target(CANARY.toLowerCase()))).map((hit) => hit.index)).toEqual([0]);
    expect(
      (await scanner.scan(target(`x ${OTHER.toUpperCase()}`))).map((hit) => hit.index),
    ).toEqual([1]);
  });

  it("finds an id, and tells an id from a canary string", async () => {
    const hits = await scanner.scan(target(`{"spanId":"${SPAN}"}`));
    expect(hits).toEqual([{ kind: "http_body", label: "test", token: "id", index: 0 }]);
  });

  it("counts a token once per artefact, however many times it occurs", async () => {
    expect(await scanner.scan(target(`${CANARY} ${CANARY} ${CANARY}`))).toHaveLength(1);
  });

  it("counts an id that is a part of a longer id found beside it as the longer one", async () => {
    const ids: TokenSet = {
      canary: [],
      ids: ["ver_00000000feedface", "ver_00000000feedface:p17", "ver_00000000feedface:p18"],
    };
    const scan = (content: string) => scanner.scan({ ...target(content), forbid: ids });
    // A span id holds its version id: one id found, not two.
    expect((await scan("see ver_00000000feedface:p17")).map((hit) => hit.index)).toEqual([1]);
    expect(
      (await scan("ver_00000000feedface:p17 and ver_00000000feedface:p18")).map((hit) => hit.index),
    ).toEqual([1, 2]);
    // The version id alone is a hit of its own.
    expect((await scan("ver_00000000feedface")).map((hit) => hit.index)).toEqual([0]);
  });

  it("finds nothing in clean text, and nothing for an empty token", async () => {
    expect(await scanner.scan(target("A clean paragraph of synthetic text."))).toEqual([]);
    const blank = await scanner.scan({
      ...target("anything at all"),
      forbid: { canary: [""], ids: [""] },
    });
    expect(blank).toEqual([]);
  });

  it("reads a Word package, every part of it, and finds a string that the runs split", async () => {
    const split = await docx(["Plain paragraph.", CANARY], 5);
    expect((await scanner.scan(target(split, "memo"))).map((hit) => hit.token)).toEqual(["canary"]);
    // Not in the body: in the properties of the package.
    const zip = await JSZip.loadAsync(split);
    zip.file(
      "docProps/core.xml",
      `<cp:coreProperties><dc:title>${SPAN}</dc:title></cp:coreProperties>`,
    );
    const props = await zip.generateAsync({ type: "uint8array" });
    expect((await scanner.scan(target(props, "memo"))).map((hit) => hit.token).sort()).toEqual([
      "canary",
      "id",
    ]);
    expect(await scanner.scan(target(await docx(["Clean."], 3), "memo"))).toEqual([]);
  });

  it("reads bytes that are not a Word package as text", async () => {
    expect(await scanner.scan(target(new TextEncoder().encode(`x ${CANARY} y`)))).toHaveLength(1);
    // Binary that is not a zip, and a zip signature that is not at the start, are text.
    const binary = new Uint8Array([
      0x00,
      0xff,
      0x50,
      0x4b,
      0x03,
      0x04,
      ...new TextEncoder().encode(CANARY),
    ]);
    expect(await scanner.scan(target(binary))).toHaveLength(1);
  });

  it("stops, and does not call it clean, when a Word package cannot be read", async () => {
    // The memo is DEFLATE compressed, so a search of its bytes finds nothing even where it holds a leak.
    const memo = await docx(["Plain paragraph.", CANARY], 5);
    expect(Buffer.from(memo).toString("latin1")).not.toContain(CANARY);
    expect((await scanner.scan(target(memo, "memo"))).map((hit) => hit.token)).toEqual(["canary"]);

    expect(zipMethod(await plantedDocx({ document: [CANARY] }))).toBe(8);
    expect(memo.length).toBeLessThan((await docx(["Plain paragraph.", CANARY], 5, "STORE")).length);
    const damaged: [string, Uint8Array][] = [
      ["a signature with nothing after it", new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
      ["a package cut in two", memo.slice(0, Math.floor(memo.length / 2))],
      ["a package cut just before its directory", memo.slice(0, memo.length - 30)],
      [
        "a package with one entry that cannot be inflated",
        withBrokenEntry(memo, "docProps/core.xml"),
      ],
      [
        "a package whose first entry cannot be inflated",
        withBrokenEntry(memo, "word/document.xml"),
      ],
    ];
    for (const [what, bytes] of damaged) {
      const failure = await scanner.scan(target(bytes, "memo")).catch((error: unknown) => error);
      expect(failure, what).toBeInstanceOf(ExposureControlFailure);
      expect(failure, what).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
      expect((failure as Error).message, what).toMatch(
        /could not be read, so no count can be trusted/,
      );
      expect((failure as Error).message, what).not.toContain("CANARY");
      expect((failure as Error).message, what).not.toContain(SPAN);
    }
  });

  it("stops when the checksum of an entry is wrong, even if the entry reads", async () => {
    const stored = await docx(["Plain paragraph.", CANARY], 5, "STORE");
    // Change one letter of the document part: stored, so it still reads, but the checksum says no.
    const text = Buffer.from(stored).toString("latin1");
    const at = text.indexOf("Plain");
    const bytes = Uint8Array.from(stored);
    bytes[at] = "X".charCodeAt(0);
    await expect(scanner.scan(target(bytes, "memo"))).rejects.toMatchObject({
      name: "ExposureControlFailure",
    });
  });

  it("finds a string that markup cuts in two, as the mark element around a quoted passage does", async () => {
    const cut = `<p>${CANARY.slice(0, 14)}</span><mark class="quote">${CANARY.slice(14)}</mark> more</p>`;
    expect(cut).not.toContain(CANARY);
    expect((await scanner.scan(target(cut))).map((hit) => hit.token)).toEqual(["canary"]);
    // The same, with the cut inside an id.
    const idCut = `<a href="/x">${SPAN.slice(0, 10)}<b>${SPAN.slice(10)}</b></a>`;
    expect((await scanner.scan(target(idCut))).map((hit) => hit.token)).toEqual(["id"]);
  });

  it("finds a string that is written as entities, escapes or with invisible characters", async () => {
    const encoded = [
      "<p>CANARY&#45;TESTMATTER-0123456789ab</p>",
      "<p>&#x43;ANARY-TESTMATTER-0123456789ab</p>",
      // Escapes as a JSON writer may write them, as text.
      String.raw`CANARY-TEST\u004dATTER-0123456789ab`,
      String.raw`CANARY-TESTM\u00adATTER-0123456789ab`,
      String.raw`CANARY-TEST\u200bMATTER-0123456789ab`,
      // The characters themselves: a soft hyphen and a zero width space.
      "CANARY-TEST\u00adMATTER-0123456789ab",
      "CANARY-TEST\u200bMATTER-0123456789ab",
    ];
    for (const text of encoded)
      expect(
        (await scanner.scan(target(text))).map((hit) => hit.index),
        text,
      ).toEqual([0]);
    // An id in a link, percent encoded; in JSON with its colon escaped; and as an entity.
    for (const text of [
      '<a href="/matters?x=ver_00000000feedface%3Ap17">',
      String.raw`{"spanId":"ver_00000000feedface\u003ap17"}`,
      "ver_00000000feedface&#58;p17",
    ])
      expect(
        (await scanner.scan(target(text))).map((hit) => hit.token),
        text,
      ).toEqual(["id"]);
  });

  it("does not find a token in text that only looks a little like it", async () => {
    for (const text of [
      "<p>CANARY</span><mark>TESTMATTER</mark> 0123456789ab</p>",
      "ver_00000000feedface p17 and ver_00000000feedface-p17",
      "CANARY&#45;TESTMATTER&#45;0123456789ac",
      "100%25 of the 5%3 text &amp; &lt;tag&gt;",
    ])
      expect(await scanner.scan(target(text)), text).toEqual([]);
  });

  it("gives the views a text is searched in", () => {
    expect(textViewsOf("plain")).toEqual(["plain"]);
    const views = textViewsOf("<b>A&amp;B</b> C%3Ad");
    expect(views).toContain("<b>a&amp;b</b> c%3ad");
    expect(views).toContain("a&amp;b c%3ad");
    expect(views).toContain("a&b c:d");
    expect(plainTextOf("<b>A&amp;B</b> C%3Ad \u00e9")).toBe("A&B C:d \u00e9");
  });

  it("reports a place and a position, and nothing that was found", async () => {
    const hits = await scanner.scan(target(`secret ${CANARY}`));
    expect(JSON.stringify(hits)).not.toContain("CANARY");
    expect(JSON.stringify(hits)).not.toContain("secret");
  });
});

describe("the control", () => {
  it("passes for a scanner that finds what it is given", async () => {
    await expect(runControl(createScanner(), forbid)).resolves.toBeUndefined();
  });

  it("throws when the scanner finds nothing", async () => {
    const blind: Scanner = { scan: async () => [] };
    const failure = await runControl(blind, forbid).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExposureControlFailure);
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect((failure as Error).message).not.toContain(CANARY);
    expect((failure as Error).message).not.toContain(SPAN);
  });

  it("throws when the scanner finds a hit in a clean artefact", async () => {
    const eager: Scanner = {
      scan: async (t) => [{ kind: t.kind, label: t.label, token: "canary", index: 0 }],
    };
    await expect(runControl(eager, forbid)).rejects.toMatchObject({
      name: "ExposureControlFailure",
    });
  });

  it("throws when the scanner cannot read a Word package, which is where a memo is", async () => {
    const real = createScanner();
    const textOnly: Scanner = {
      scan: (t) => (typeof t.content === "string" ? real.scan(t) : Promise.resolve([])),
    };
    await expect(runControl(textOnly, forbid)).rejects.toThrow(/Word file/);
  });

  it("throws when the scanner cannot tell an id from nothing", async () => {
    const real = createScanner();
    const noIds: Scanner = {
      scan: async (t) => (await real.scan(t)).filter((hit) => hit.token !== "id"),
    };
    await expect(runControl(noIds, forbid)).rejects.toThrow(/id it was given/);
  });

  describe("with a scanner that has a fault", () => {
    const real = createScanner();

    /** Reads every part of a package as it is stored, without inflating it. */
    const neverInflates: Scanner = {
      async scan(t) {
        if (typeof t.content === "string") return real.scan(t);
        const zip = await JSZip.loadAsync(t.content);
        const parts = Object.values(zip.files)
          .filter((entry) => !entry.dir)
          .map((entry) => {
            const data = (entry as unknown as { _data: { compressedContent: Uint8Array } })._data;
            return Buffer.from(data.compressedContent).toString("latin1");
          });
        return real.scan({ ...t, content: parts.join("\n") });
      },
    };

    /** Reads a package without one of its parts. */
    const withoutPart = (part: string): Scanner => ({
      async scan(t) {
        if (typeof t.content === "string") return real.scan(t);
        const zip = await JSZip.loadAsync(t.content);
        zip.remove(part);
        const content = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        return real.scan({ ...t, content });
      },
    });

    it("throws for a scanner that never inflates a Word file, which the old stored control could not tell", async () => {
      // It reads a stored package, so a control that planted a stored package would have passed it ...
      const stored = await docx(["Plain paragraph.", CANARY], 200, "STORE");
      expect((await neverInflates.scan(target(stored, "memo"))).map((hit) => hit.token)).toEqual([
        "canary",
      ]);
      // ... and it reads nothing of the compressed package that the application writes.
      const deflated = await docx(["Plain paragraph.", CANARY], 200);
      expect(await neverInflates.scan(target(deflated, "memo"))).toEqual([]);
      await expect(runControl(neverInflates, forbid)).rejects.toThrow(/Word file/);
    });

    it("throws for a scanner that skips the header part, or the document properties, of a package", async () => {
      for (const part of ["word/header1.xml", "docProps/core.xml", "word/document.xml"]) {
        const failure = await runControl(withoutPart(part), forbid).catch(
          (error: unknown) => error,
        );
        expect(failure, part).toBeInstanceOf(ExposureControlFailure);
        expect((failure as Error).message, part).toMatch(/Word file/);
      }
    });

    it("throws for a scanner that looks for the first id only, or the first string only", async () => {
      const firstIdOnly: Scanner = {
        scan: (t) => real.scan({ ...t, forbid: { ...t.forbid, ids: t.forbid.ids.slice(0, 1) } }),
      };
      await expect(runControl(firstIdOnly, forbid)).rejects.toThrow(/id it was given/);
      const firstStringOnly: Scanner = {
        scan: (t) =>
          real.scan({ ...t, forbid: { ...t.forbid, canary: t.forbid.canary.slice(0, 1) } }),
      };
      await expect(runControl(firstStringOnly, forbid)).rejects.toThrow(/canary it was given/);
    });

    it("throws for a scanner that searches the text as written only", async () => {
      const asWritten: Scanner = {
        async scan(t) {
          const text =
            typeof t.content === "string" ? t.content : Buffer.from(t.content).toString("utf8");
          const hits: Awaited<ReturnType<Scanner["scan"]>> = [];
          t.forbid.canary.forEach((value, index) => {
            if (text.toLowerCase().includes(value.toLowerCase()))
              hits.push({ kind: t.kind, label: t.label, token: "canary", index });
          });
          t.forbid.ids.forEach((value, index) => {
            if (text.toLowerCase().includes(value.toLowerCase()))
              hits.push({ kind: t.kind, label: t.label, token: "id", index });
          });
          return hits;
        },
      };
      // It finds what is in the text as it is, and fails at the first token that markup cuts or an escape hides.
      await expect(runControl(asWritten, forbid)).rejects.toThrow(/mark element|entity|Word file/);
    });
  });

  it("plants every string and every id, in a package that is compressed as the application's memo is", async () => {
    const bytes = await plantedDocx({ document: [CANARY, OTHER, SPAN] });
    expect(zipMethod(bytes)).toBe(8);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain(CANARY);
    const hits = await createScanner().scan(target(bytes, "memo"));
    expect(hits.map((hit) => `${hit.token}${hit.index}`).sort()).toEqual([
      "canary0",
      "canary1",
      "id0",
    ]);
  });

  it("knows which ids a full set reports: those that are not a part of a longer id", () => {
    expect(
      maximalIds(["ver_aaaaaaaa", "ver_aaaaaaaa:p1", "mat_bbbbbbbb", "VER_AAAAAAAA:P2"]),
    ).toEqual([1, 2, 3]);
    expect(maximalIds([])).toEqual([]);
  });

  it("refuses a token too short to mean anything, and a token set with nothing to plant", async () => {
    await expect(runControl(createScanner(), { canary: ["abc"], ids: [SPAN] })).rejects.toThrow(
      /too short/,
    );
    await expect(runControl(createScanner(), { canary: [], ids: [] })).rejects.toThrow(
      /nothing|no canary/i,
    );
  });
});

describe("the ledger", () => {
  it("counts artefacts by kind, canary strings and ids apart, and the fact as an attempt", async () => {
    const ledger = createLedger(createScanner());
    await ledger.add({ ...target("clean"), kind: "prompt" });
    await ledger.add({ ...target(`${CANARY} and ${SPAN}`), kind: "model_response" }, [
      "a distinctive fact",
    ]);
    await ledger.add({ ...target("The a distinctive fact is here"), kind: "http_body" }, [
      "a distinctive fact",
    ]);
    expect(ledger.scanned).toBe(3);
    expect(ledger.byKind).toMatchObject({ prompt: 1, model_response: 1, http_body: 1, memo: 0 });
    expect(ledger.canaryHits).toBe(1);
    expect(ledger.idHits).toBe(1);
    expect(ledger.factSightings).toBe(1);
  });

  it("refuses a forbidden token too short to mean anything", async () => {
    const ledger = createLedger(createScanner());
    await expect(
      ledger.add({ ...target("x"), forbid: { canary: ["short"], ids: [] } }),
    ).rejects.toThrow(/too short/);
  });
});

describe("the capturing generator", () => {
  const schema = z.object({ answer: z.string() });

  it("keeps every request before it is passed on and every answer on its way back, and changes neither", async () => {
    const inner = createScriptedGenerator(() => ({ answer: "scripted" }));
    const capture = createCapturingGenerator(inner);
    const result = await capture.generate({
      system: "system words",
      prompt: "prompt words",
      sharedPrefix: "prefix words",
      schema,
      schemaName: "demo",
    });
    expect(result).toEqual({ answer: "scripted" });
    expect(inner.calls).toHaveLength(1);
    expect(capture.captured.requests).toHaveLength(1);
    const text = capture.captured.requests[0]!.text;
    for (const part of ["system words", "prompt words", "prefix words"])
      expect(text).toContain(part);
    expect(capture.captured.responses).toEqual(['{"answer":"scripted"}']);
    expect(capture.provider).toBe(inner.provider);
    expect(capture.disclosure).toBe(inner.disclosure);
  });

  it("counts a failed call, rethrows it, and keeps no answer for it", async () => {
    const capture = createCapturingGenerator(
      createScriptedGenerator(() => {
        throw new Error("provider down");
      }),
    );
    await expect(capture.generate({ system: "s", prompt: "p", schema })).rejects.toThrow(
      "provider down",
    );
    expect(capture.captured.failures).toBe(1);
    expect(capture.captured.requests).toHaveLength(1);
    expect(capture.captured.responses).toEqual([]);
  });
});

describe("the classification of one cell", () => {
  const missing: Snapshot = {
    status: 404,
    headers: [["content-type", "application/json"]],
    body: '{"error":{"kind":"not_found"}}',
  };
  const observed = (over: Partial<Observed> = {}): Observed => ({
    ...missing,
    letIn: false,
    stateChanged: false,
    ...over,
  });
  const noPart: Expected = { kind: "refused", status: 404, caller: "no_part" };
  const forbidden = ["Synthetic Matter Title", "ver_00000000feedface:p17"];

  const classify = (expected: Expected, seen: Observed, mustMatch: Snapshot | null = missing) =>
    classifyCell({ expected, observed: seen, missing: mustMatch, forbidden });

  it("accepts the answer for a matter that does not exist", () => {
    expect(classify(noPart, observed())).toEqual({ verdict: "expected" });
  });

  it("counts a refused caller who got through the guard", () => {
    expect(classify(noPart, observed({ letIn: true, status: 400 }))).toMatchObject({
      verdict: "exposure",
      reasons: expect.arrayContaining(["handler_answered"]),
    });
  });

  it("counts a refused caller who got any 2xx answer, even where the log does not say the guard was passed", () => {
    expect(classify(noPart, observed({ status: 200, body: "{}" }))).toMatchObject({
      verdict: "exposure",
      reasons: expect.arrayContaining(["handler_answered"]),
    });
  });

  it("counts a refusal whose body holds the title, a window of the text or an id of the matter", () => {
    for (const leak of forbidden) {
      const result = classify(noPart, observed({ body: `forbidden: ${leak.toUpperCase()}` }), null);
      expect(result).toMatchObject({ verdict: "exposure", reasons: ["carried_data"] });
    }
  });

  it("counts a refusal that is not the answer for a missing matter: another status, header or body", () => {
    for (const change of [
      { status: 403 },
      { body: '{"error":{"kind":"forbidden"}}' },
      { headers: [["content-type", "text/html"]] as [string, string][] },
      { headers: [...missing.headers, ["x-reason", "not a member"]] as [string, string][] },
    ]) {
      expect(classify(noPart, observed(change))).toMatchObject({
        verdict: "exposure",
        reasons: ["refusal_differs"],
      });
    }
  });

  it("counts a refused request that changed the store", () => {
    expect(classify(noPart, observed({ stateChanged: true }))).toMatchObject({
      verdict: "exposure",
      reasons: ["changed_state"],
    });
  });

  it("does not hold a member refused for a role to the rules of existence: a member knows the matter is there", () => {
    const role: Expected = { kind: "refused", status: 403, caller: "role" };
    const refusal = observed({
      status: 403,
      body: "forbidden for this role, Synthetic Matter Title",
    });
    expect(classify(role, refusal, null)).toEqual({ verdict: "expected" });
    expect(classify(role, observed({ status: 200 }), null)).toMatchObject({ verdict: "exposure" });
  });

  it("treats a visitor like a person with no part in the matter", () => {
    const visitor: Expected = { kind: "refused", status: 401, caller: "visitor" };
    expect(classify(visitor, observed({ status: 401 }), { ...missing, status: 401 })).toEqual({
      verdict: "expected",
    });
    expect(classify(visitor, observed({ status: 401 }), { ...missing, status: 303 })).toMatchObject(
      {
        reasons: ["refusal_differs"],
      },
    );
  });

  it("calls a visitor sent somewhere other than the start page a mismatch, which is not an exposure", () => {
    const visitor: Expected = { kind: "refused", status: 303, caller: "visitor", location: "/" };
    const sent = (place: string) => observed({ status: 303, headers: [["location", place]] });
    const same = (place: string): Snapshot => ({ ...sent(place) });
    expect(classify(visitor, sent("/"), same("/"))).toEqual({ verdict: "expected" });
    expect(classify(visitor, sent("/signin"), same("/signin"))).toEqual({ verdict: "mismatch" });
  });

  it("calls a caller who should be let in and is not a mismatch, which is not an exposure", () => {
    const letIn: Expected = { kind: "let_in", status: 200 };
    expect(classify(letIn, observed({ status: 200, letIn: true }))).toEqual({
      verdict: "expected",
    });
    expect(classify(letIn, observed({ status: 404 }))).toEqual({ verdict: "mismatch" });
    expect(classify(letIn, observed({ status: 200, letIn: false }))).toEqual({
      verdict: "mismatch",
    });
  });

  it("calls a refusal with an unexpected status that tells a caller nothing a mismatch", () => {
    const role: Expected = { kind: "refused", status: 403, caller: "role" };
    expect(classify(role, observed({ status: 404 }), null)).toEqual({ verdict: "mismatch" });
  });
});
