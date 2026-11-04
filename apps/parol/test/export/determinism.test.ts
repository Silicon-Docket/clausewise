import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { buildMemo } from "../../src/export/memo.js";
import type { MemoInput } from "../../src/module-contracts.js";
import { readMemo, review, withReview, workedExample } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
});

const hashOfMemo = async (input: MemoInput): Promise<string> => sha256Hex(await buildMemo(input));

describe("a memo is a function of its input", () => {
  it("gives the same document.xml for the same input, built twice", async () => {
    const a = await readMemo(await buildMemo(workedExample()));
    const b = await readMemo(await buildMemo(workedExample()));
    expect(a.documentXml).toBe(b.documentXml);
    expect(a.documentXml.length).toBeGreaterThan(10_000);
  });

  it("gives the same file, byte for byte, so the stored file hash means something", async () => {
    const first = await hashOfMemo(workedExample());
    expect(await hashOfMemo(workedExample())).toBe(first);
  });

  it("does not read the clock: moving it changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2019-02-03T04:05:06Z"));
    const early = await buildMemo(workedExample());
    vi.setSystemTime(new Date("2041-12-25T23:59:59Z"));
    const late = await buildMemo(workedExample());
    expect(sha256Hex(late)).toBe(sha256Hex(early));
    const text = (await readMemo(late)).paragraphs.join("\n");
    expect(text).toContain("3 November 2026");
    expect(text).not.toContain("2041");
    expect(text).not.toContain("2019");
  });

  it("does not depend on the machine's time zone", async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const east = await hashOfMemo(workedExample());
      process.env.TZ = "Pacific/Pago_Pago";
      const west = await hashOfMemo(workedExample());
      expect(west).toBe(east);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("stamps the file's properties and entries with the export date and nothing else", async () => {
    const read = await readMemo(await buildMemo(workedExample()));
    const core = await read.zip.file("docProps/core.xml")!.async("string");
    expect(core).toMatch(/<dcterms:created[^>]*>2026-11-03T14:05:00Z<\/dcterms:created>/);
    expect(core).toMatch(/<dcterms:modified[^>]*>2026-11-03T14:05:00Z<\/dcterms:modified>/);
    for (const [name, entry] of Object.entries(read.zip.files)) {
      expect(entry.date.toISOString().slice(0, 10), name).toBe("2026-11-03");
    }
  });

  it("changes when the content changes, so equal output is not an accident", async () => {
    const base = await hashOfMemo(workedExample());
    expect(await hashOfMemo(withReview(workedExample(), "dur-1", review("accept")))).not.toBe(base);
    const later = workedExample();
    later.exportedAt = "2026-11-04T14:05:00.000Z";
    expect(await hashOfMemo(later)).not.toBe(base);
    const edited = workedExample();
    edited.matter.name = "Another matter";
    expect(await hashOfMemo(edited)).not.toBe(base);
  });

  it("does not change its input", async () => {
    const input = workedExample();
    const before = JSON.stringify(input);
    await buildMemo(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is the same whether the input arrives as one object or as a structured copy", async () => {
    const input = workedExample();
    expect(await hashOfMemo(structuredClone(input))).toBe(await hashOfMemo(input));
  });
});
