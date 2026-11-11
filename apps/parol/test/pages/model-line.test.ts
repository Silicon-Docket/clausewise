import { describe, expect, it } from "vitest";
import { modelLine } from "../../src/server/views/format.js";

/**
 * The words that say which model answered a review. The provider names the model in its responses,
 * and the name may differ from the one that was asked for, so a page must not print the one it asked
 * for as if it were the one that answered.
 */

describe("modelLine", () => {
  it("names the model that answered when it is the one that was asked for", () => {
    expect(modelLine({ provider: "anthropic", requested: "model-a", reported: "model-a" })).toBe(
      "Answered by model-a",
    );
  });

  it("names both when the provider answered with another name", () => {
    expect(
      modelLine({ provider: "anthropic", requested: "model-a", reported: "model-a-20260101" }),
    ).toBe("Answered by model-a-20260101 (requested model-a)");
  });

  it("says the provider did not say which model answered, and names the one asked for", () => {
    expect(modelLine({ provider: "anthropic", requested: "model-a", reported: null })).toBe(
      "Requested model-a; the provider did not say which model answered",
    );
    expect(modelLine({ provider: "openai", requested: "model-b", reported: null })).toBe(
      "Requested model-b; the provider did not say which model answered",
    );
  });

  it("calls a stand-in a scripted stand-in with its name, whatever it says it was", () => {
    for (const provider of ["scripted", "simulated"]) {
      for (const reported of [null, "some-name"]) {
        const line = modelLine({ provider, requested: "parol-reader", reported });
        expect(line).toBe(`Read by a scripted stand-in (${provider}, parol-reader)`);
        expect(line).not.toContain("Answered by");
      }
    }
  });

  it("never prints the reported name as the requested one, or the other way round", () => {
    const line = modelLine({ provider: "anthropic", requested: "asked", reported: "answered" });
    expect(line.indexOf("answered")).toBeLessThan(line.indexOf("asked"));
    expect(line).toBe("Answered by answered (requested asked)");
  });
});
