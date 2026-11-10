import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `variants.ts` is the base list followed by the lists of six fragment files, one for each package
 * that adds pages. The fragments are empty until their package arrives, so this test puts an entry
 * in each, in turn, and looks for it in the composed list: a fragment that is not spread, or is
 * spread out of order, is found here and not on the day a package adds its first page.
 */

const FRAGMENTS = [
  { file: "usage", name: "VARIANTS_USAGE" },
  { file: "evaluations", name: "VARIANTS_EVALUATIONS" },
  { file: "retention", name: "VARIANTS_RETENTION" },
  { file: "feedback", name: "VARIANTS_FEEDBACK" },
  { file: "training", name: "VARIANTS_TRAINING" },
  { file: "pilot", name: "VARIANTS_PILOT" },
] as const;

afterEach(() => {
  for (const { file } of FRAGMENTS) vi.doUnmock(`./variants-${file}.js`);
  vi.resetModules();
});

/** The composed list, with the given fragments replaced by lists holding one entry each. */
async function composed(filled: readonly string[]): Promise<string[]> {
  vi.resetModules();
  for (const { file, name } of FRAGMENTS)
    if (filled.includes(file))
      vi.doMock(`./variants-${file}.js`, () => ({
        [name]: [[`fixture of ${file}`, () => "<p>a page</p>"]],
      }));
  const { variants } = await import("./variants.js");
  return variants.map(([title]) => title);
}

describe("the page fixtures", () => {
  it("are the base list alone while the fragments are empty", async () => {
    const titles = await composed([]);
    expect(titles.length).toBeGreaterThan(30);
    expect(titles.some((title) => title.startsWith("fixture of "))).toBe(false);
    expect(new Set(titles).size).toBe(titles.length);
  });

  for (const { file } of FRAGMENTS)
    it(`include the entries of the ${file} fragment, after the base list`, async () => {
      const base = await composed([]);
      const titles = await composed([file]);
      expect(titles).toEqual([...base, `fixture of ${file}`]);
    });

  it("follow the base list with the fragments in the order usage, evaluations, retention, feedback, training, pilot", async () => {
    const base = await composed([]);
    const titles = await composed(FRAGMENTS.map((fragment) => fragment.file));
    expect(titles).toEqual([
      ...base,
      ...FRAGMENTS.map((fragment) => `fixture of ${fragment.file}`),
    ]);
  });
});
