import { beforeAll, describe, expect, it, vi } from "vitest";
import { runCanaryScan, type CanaryResult } from "../src/parol/exposure/canary.js";
import {
  CANARY_OWN_PAGES,
  requireOwnPagesAmong,
  requireRoutesFetched,
} from "../src/parol/exposure/canary-controls.js";
import type { Dataset } from "../src/parol/dataset.js";
import { MATTER_GET, OTHER_GET } from "./parol-canary-support.js";
import { completeDataset, never, playbook, ROOT } from "./parol-exposure-support.js";

/**
 * Two controls of the canary scan stop it for a fault that the probe tables would have to carry (a
 * route renamed, a route left out of the reads), and a test cannot rewrite the tables. So the controls
 * themselves are tested on their own (parol-canary-guards.test.ts) and here the scan is shown to
 * call them, with what they need to see. A call that was taken out would leave every other test green.
 */

vi.mock("../src/parol/exposure/canary-controls.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/parol/exposure/canary-controls.js")>();
  return {
    ...real,
    requireOwnPagesAmong: vi.fn(real.requireOwnPagesAmong),
    requireRoutesFetched: vi.fn(real.requireRoutesFetched),
  };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
let result: CanaryResult;
beforeAll(async () => {
  dataset = await completeDataset();
  vi.mocked(requireOwnPagesAmong).mockClear();
  vi.mocked(requireRoutesFetched).mockClear();
  result = await runCanaryScan({ dataset, root: ROOT, playbook, signal: never() });
});

describe("the scan calls the controls that a change to the probe tables would trigger", () => {
  it("checks, for each canary matter, that the pages its people must be let into are among the routes it reads", () => {
    const calls = vi.mocked(requireOwnPagesAmong).mock.calls;
    expect(calls).toHaveLength(1);
    const labels = new Set(calls[0]![0]);
    for (const page of CANARY_OWN_PAGES) expect(labels).toContain(page);
  });

  it("checks, once for each case, that every route the tables name was fetched, against what was fetched", () => {
    const calls = vi.mocked(requireRoutesFetched).mock.calls;
    expect(calls).toHaveLength(result.cases.length);
    const [fetched, known] = calls[0]!;
    expect(new Set(known)).toEqual(new Set([...MATTER_GET, ...OTHER_GET].map((t) => `GET ${t}`)));
    expect(new Set(fetched)).toEqual(new Set(known));
    expect(new Set(fetched)).toEqual(new Set(result.cases[0]!.routes));
  });
});
