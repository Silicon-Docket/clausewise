import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every live generator the server uses is built in `usage/live.ts`, which hands the Anthropic
 * adapter the hooks that record usage and the model that answered. A file that built one another
 * way would give runs that record nothing, and the review page would say so without anyone having
 * chosen it. This reads the sources, so a call added later is found here.
 */

const SRC = join(import.meta.dirname, "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({
  where: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("where a live generator is built", () => {
  it("reads the sources", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("is usage/live.ts alone", () => {
    const builders = sources
      .filter(({ text }) => /\bcreate(?:Object|Anthropic)Generator\s*\(/.test(text))
      .map(({ where }) => where);
    expect(builders).toEqual(["usage/live.ts"]);
  });

  it("is reached from the server's start through createLiveGenerator", () => {
    const main = sources.find(({ where }) => where === "main.ts")!;
    expect(main.text).toMatch(/\bcreateLiveGenerator\s*\(/);
  });

  it("calls the generator from callModel, which opens a collector around the call, and from the engine's wrapper that only passes it on", () => {
    // A `generate(` elsewhere in the stages or the services would reach the generator with no
    // collector, and its usage would belong to no call.
    const calls = sources
      .filter(({ where }) => where.startsWith("stages/") || where.startsWith("services/"))
      .filter(({ text }) => /\.generate\s*\(/.test(text))
      .map(({ where }) => where);
    expect(calls).toEqual(["services/run-support.ts", "stages/analyze-call.ts"]);
    const wrapper = sources.find(({ where }) => where === "services/run-support.ts")!;
    expect(wrapper.text).toMatch(/base\.generate\(/);
    const call = sources.find(({ where }) => where === "stages/analyze-call.ts")!;
    expect(call.text).toMatch(
      /callStore\.run\(collector, \(\) => call\.generator\.generate\(request\)\)/,
    );
  });
});
