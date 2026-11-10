import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `variants.ts` is the base list followed by the lists of six fragment files, one for each package
 * that adds pages. The fragments are empty until their package arrives, so this test puts an entry
 * in each, in turn, and looks for it in the composed list: a fragment that is not spread, or is
 * spread out of order, is found here and not on the day a package adds its first page.
 *
 * All six fragment modules are replaced in every composition (an empty list for a fragment that is
 * not being tried), so the result does not depend on what the real fragments hold: it stays true
 * once a package puts its own entries in its own file.
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

/**
 * The composed list, with the given fragments replaced by lists holding one entry each and every
 * other fragment replaced by an empty list, whatever the real files hold.
 */
async function composed(filled: readonly string[]): Promise<string[]> {
  vi.resetModules();
  for (const { file, name } of FRAGMENTS)
    vi.doMock(`./variants-${file}.js`, () => ({
      [name]: filled.includes(file) ? [[`fixture of ${file}`, () => "<p>a page</p>"]] : [],
    }));
  const { variants } = await import("./variants.js");
  return variants.map(([title]) => title);
}

describe("the page fixtures", () => {
  it("are the base list alone when every fragment is empty", async () => {
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
