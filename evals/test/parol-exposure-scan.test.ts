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
  runControl,
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

async function docx(paragraphs: string[], runLength: number): Promise<Uint8Array> {
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
  return zip.generateAsync({ type: "uint8array" });
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

  it("reads bytes that are not a Word package as text, and a broken package as the bytes it is", async () => {
    expect(await scanner.scan(target(new TextEncoder().encode(`x ${CANARY} y`)))).toHaveLength(1);
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(CANARY)]);
    expect(await scanner.scan(target(broken))).toHaveLength(1);
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
