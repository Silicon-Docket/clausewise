import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NONE,
  composeProbeTables,
  form,
  json,
  probeKey,
  type EffectOf,
  type ForgedBody,
  type OtherProbe,
  type Probe,
  type ProbeFragment,
} from "../src/parol/exposure/probe-kit.js";
import * as base from "../src/parol/exposure/probes-base.js";
import * as evaluations from "../src/parol/exposure/probes-evaluations.js";
import * as feedback from "../src/parol/exposure/probes-feedback.js";
import * as pilot from "../src/parol/exposure/probes-pilot.js";
import * as retention from "../src/parol/exposure/probes-retention.js";
import * as training from "../src/parol/exposure/probes-training.js";
import {
  EFFECT_KEYS,
  FORGED_BODY_KEYS,
  LIST_PROBES,
  MATTER_PROBES,
  OTHER_PROBES,
  PROBE_FRAGMENTS,
} from "../src/parol/exposure/probes.js";
import { DASHES, ROOT } from "./parol-exposure-support.js";

/**
 * The probe tables are written by the base and by five packages, each in a fragment of its own,
 * and composed in one place. The composition keeps the order of the phases and refuses what two
 * owners both give, so that a package cannot silently replace another's probe, body or effect.
 */

const OWNERS = [
  ["evaluations", evaluations, "EVALUATIONS"],
  ["retention", retention, "RETENTION"],
  ["feedback", feedback, "FEEDBACK"],
  ["training", training, "TRAINING"],
  ["pilot", pilot, "PILOT"],
] as const;

/** The fragments as the owners wrote them, in the order of the phases. */
const FRAGMENTS: readonly ProbeFragment[] = [
  {
    name: "base",
    matter: base.MATTER_PROBES_BASE,
    other: base.OTHER_PROBES_BASE,
    forgedBodies: base.FORGED_BODIES_BASE,
    effects: base.EFFECTS_BASE,
  },
  {
    name: "evaluations",
    matter: evaluations.MATTER_PROBES_EVALUATIONS,
    other: evaluations.OTHER_PROBES_EVALUATIONS,
    forgedBodies: evaluations.FORGED_BODIES_EVALUATIONS,
    effects: evaluations.EFFECTS_EVALUATIONS,
  },
  {
    name: "retention",
    matter: retention.MATTER_PROBES_RETENTION,
    other: retention.OTHER_PROBES_RETENTION,
    forgedBodies: retention.FORGED_BODIES_RETENTION,
    effects: retention.EFFECTS_RETENTION,
  },
  {
    name: "feedback",
    matter: feedback.MATTER_PROBES_FEEDBACK,
    other: feedback.OTHER_PROBES_FEEDBACK,
    forgedBodies: feedback.FORGED_BODIES_FEEDBACK,
    effects: feedback.EFFECTS_FEEDBACK,
  },
  {
    name: "training",
    matter: training.MATTER_PROBES_TRAINING,
    other: training.OTHER_PROBES_TRAINING,
    forgedBodies: training.FORGED_BODIES_TRAINING,
    effects: training.EFFECTS_TRAINING,
  },
  {
    name: "pilot",
    matter: pilot.MATTER_PROBES_PILOT,
    other: pilot.OTHER_PROBES_PILOT,
    forgedBodies: pilot.FORGED_BODIES_PILOT,
    effects: pilot.EFFECTS_PILOT,
  },
];

const matterProbe = (template: string, over: Partial<Probe> = {}): Probe => ({
  method: "POST",
  template,
  action: "feedback.add",
  body: form(),
  reaches: 400,
  ...over,
});
const otherProbe = (template: string, over: Partial<OtherProbe> = {}): OtherProbe => ({
  method: "GET",
  template,
  access: "principal",
  body: NONE,
  ...over,
});
const effect: EffectOf = () => ({
  target: "scratch",
  needs: "documents",
  ids: (_scratch, own) => own,
  body: form({ note: "changed" }),
});
const forged: ForgedBody = () => json({ note: "forged" });
const fragment = (name: string, over: Partial<ProbeFragment> = {}): ProbeFragment => ({
  name,
  matter: [],
  other: [],
  forgedBodies: {},
  effects: {},
  ...over,
});

describe("the five fragments", () => {
  it("each export the four tables of their package, under the names the composition reads", () => {
    for (const [name, module, upper] of OWNERS) {
      expect(Object.keys(module).sort(), name).toEqual(
        [
          `EFFECTS_${upper}`,
          `FORGED_BODIES_${upper}`,
          `MATTER_PROBES_${upper}`,
          `OTHER_PROBES_${upper}`,
        ].sort(),
      );
      const fragment = FRAGMENTS.find((entry) => entry.name === name)!;
      expect(Array.isArray(fragment.matter), name).toBe(true);
      expect(Array.isArray(fragment.other), name).toBe(true);
      expect(typeof fragment.forgedBodies, name).toBe("object");
      expect(typeof fragment.effects, name).toBe("object");
    }
  });

  it("import the kit and no other probe module, so that composing them has no cycle", () => {
    for (const [name] of OWNERS) {
      const text = readFileSync(join(ROOT, `evals/src/parol/exposure/probes-${name}.ts`), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((found) => found[1]);
      expect(imports, name).toEqual(["./probe-kit.js"]);
      expect(text, name).not.toMatch(DASHES);
    }
  });
});

describe("the composed tables", () => {
  it("name the owners in the order of the phases, the base first", () => {
    expect(PROBE_FRAGMENTS.map((entry) => entry.name)).toEqual([
      "base",
      "evaluations",
      "retention",
      "feedback",
      "training",
      "pilot",
    ]);
    expect(PROBE_FRAGMENTS.map((entry) => entry.name)).toEqual(
      FRAGMENTS.map((entry) => entry.name),
    );
  });

  it("hold every probe of the base and of each fragment, once, in that order", () => {
    expect(MATTER_PROBES).toEqual(FRAGMENTS.flatMap((entry) => entry.matter));
    expect(OTHER_PROBES).toEqual(FRAGMENTS.flatMap((entry) => entry.other));
    expect(MATTER_PROBES).toHaveLength(FRAGMENTS.reduce((n, entry) => n + entry.matter.length, 0));
    expect(OTHER_PROBES).toHaveLength(FRAGMENTS.reduce((n, entry) => n + entry.other.length, 0));
    // The entries are the owners' own, not copies: a package edits its fragment and nothing else.
    const owned = new Set<unknown>(FRAGMENTS.flatMap((entry) => [...entry.matter, ...entry.other]));
    for (const probe of [...MATTER_PROBES, ...OTHER_PROBES]) expect(owned.has(probe)).toBe(true);
  });

  it("read the lists, the forged-id bodies and the effect bodies from the merged tables", () => {
    expect(LIST_PROBES).toEqual(OTHER_PROBES.filter((probe) => probe.method === "GET"));
    expect(FORGED_BODY_KEYS).toEqual(FRAGMENTS.flatMap((entry) => Object.keys(entry.forgedBodies)));
    expect(EFFECT_KEYS).toEqual(FRAGMENTS.flatMap((entry) => Object.keys(entry.effects)));
  });

  it("list no route twice, as a route that names a matter or as one that does not", () => {
    const keys = [...MATTER_PROBES, ...OTHER_PROBES].map(probeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("compose the same tables again from the owners' fragments without a refusal", () => {
    const tables = composeProbeTables(FRAGMENTS);
    expect(tables.matter).toEqual([...MATTER_PROBES]);
    expect(tables.other).toEqual([...OTHER_PROBES]);
    expect(Object.keys(tables.forgedBodies)).toEqual([...FORGED_BODY_KEYS]);
    expect(Object.keys(tables.effects)).toEqual([...EFFECT_KEYS]);
  });
});

describe("a duplicate key across fragments", () => {
  const refused = (fragments: readonly ProbeFragment[]): Error => {
    try {
      composeProbeTables(fragments);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    }
    throw new Error("the composition should have refused the fragments");
  };

  it("is refused for a probe of a route that names a matter, with the route and both owners named", () => {
    const route = matterProbe("/matters/:matterId/synthetic");
    const error = refused([
      fragment("feedback", { matter: [route] }),
      fragment("pilot", { matter: [route] }),
    ]);
    expect(error.message).toContain("POST /matters/:matterId/synthetic");
    expect(error.message).toContain("feedback");
    expect(error.message).toContain("pilot");
    expect(error.message).not.toMatch(DASHES);
  });

  it("is refused for a route of the base that a fragment gives again", () => {
    const again = MATTER_PROBES[0]!;
    const error = refused([FRAGMENTS[0]!, fragment("evaluations", { matter: [again] })]);
    expect(error.message).toContain(probeKey(again));
    expect(error.message).toContain("base");
    expect(error.message).toContain("evaluations");
  });

  it("is refused for a route given twice inside one fragment, with that owner named once", () => {
    const route = matterProbe("/matters/:matterId/synthetic");
    const error = refused([fragment("training", { matter: [route, route] })]);
    expect(error.message).toContain("training");
    expect(error.message).not.toContain("training and in training");
  });

  it("is refused for a route that names no matter", () => {
    const error = refused([
      fragment("evaluations", { other: [otherProbe("/synthetic")] }),
      fragment("retention", { other: [otherProbe("/synthetic")] }),
    ]);
    expect(error.message).toContain("GET /synthetic");
    expect(error.message).toContain("evaluations");
    expect(error.message).toContain("retention");
  });

  it("is refused for a route that one owner gives as naming a matter and another as naming none", () => {
    const error = refused([
      fragment("feedback", { matter: [matterProbe("/synthetic")] }),
      fragment("pilot", { other: [otherProbe("/synthetic", { method: "POST" })] }),
    ]);
    expect(error.message).toContain("POST /synthetic");
  });

  it("is refused for the body of a forged request that two owners give for one route", () => {
    const error = refused([
      fragment("feedback", { forgedBodies: { "POST /synthetic/:runId": forged } }),
      fragment("training", { forgedBodies: { "POST /synthetic/:runId": forged } }),
    ]);
    expect(error.message).toContain("POST /synthetic/:runId");
    expect(error.message).toContain("feedback");
    expect(error.message).toContain("training");
  });

  it("is refused for the body that changes the store that two owners give for one route", () => {
    const error = refused([
      fragment("retention", { effects: { "POST /synthetic": effect } }),
      fragment("pilot", { effects: { "POST /synthetic": effect } }),
    ]);
    expect(error.message).toContain("POST /synthetic");
    expect(error.message).toContain("retention");
    expect(error.message).toContain("pilot");
  });

  it("is not confused by two routes that share a path and differ in the method", () => {
    const tables = composeProbeTables([
      fragment("feedback", { matter: [matterProbe("/m/x", { method: "GET", body: NONE })] }),
      fragment("pilot", { matter: [matterProbe("/m/x", { method: "POST" })] }),
    ]);
    expect(tables.matter.map(probeKey)).toEqual(["GET /m/x", "POST /m/x"]);
  });

  it("is not confused by a body that one owner gives and another's route does not have", () => {
    const tables = composeProbeTables([
      fragment("feedback", { forgedBodies: { "POST /a": forged }, effects: { "POST /a": effect } }),
      fragment("pilot", { forgedBodies: { "POST /b": forged }, effects: { "POST /b": effect } }),
    ]);
    expect(Object.keys(tables.forgedBodies)).toEqual(["POST /a", "POST /b"]);
    expect(Object.keys(tables.effects)).toEqual(["POST /a", "POST /b"]);
  });
});

describe("a global action on a probe", () => {
  it("is refused for a route that is public, which defineRoute refuses as well", () => {
    expect(() =>
      composeProbeTables([
        fragment("evaluations", {
          other: [otherProbe("/synthetic", { access: "public", globalAction: "evaluation.read" })],
        }),
      ]),
    ).toThrow(/names a global action but is not for a signed-in person/);
  });

  it("is accepted for a route for a signed-in person, on a read and on a write", () => {
    const tables = composeProbeTables([
      fragment("pilot", {
        other: [
          otherProbe("/pilot", { globalAction: "pilot.read" }),
          otherProbe("/pilot/calendar", {
            method: "POST",
            body: form({ startDate: "2026-11-09" }),
            globalAction: "pilot.manage",
          }),
        ],
      }),
    ]);
    expect(tables.other.map((probe) => probe.globalAction)).toEqual(["pilot.read", "pilot.manage"]);
  });
});
