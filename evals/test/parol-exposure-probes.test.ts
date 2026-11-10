import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MATTER_ACTIONS, type MatterAction } from "../../apps/parol/src/auth/actions.js";
import * as applicationProbes from "../../apps/parol/test/routes/probes.js";
import {
  ACTORS,
  DOCUMENTED_ROLES,
  expectedFor,
  tableDrift,
  textWindows,
} from "../src/parol/exposure/authorization.js";
import * as shared from "../src/parol/exposure/probes.js";
import { DASHES, ROOT } from "./parol-exposure-support.js";

/**
 * The probe table has one home, and that home imports nothing from vitest, so the application's
 * tests and the evaluation's exposure suite send the same requests.
 */

describe("the probe table", () => {
  it("is one table: the application's tests re-export the evaluation's module and hold no copy", () => {
    expect(applicationProbes.MATTER_PROBES).toBe(shared.MATTER_PROBES);
    expect(applicationProbes.OTHER_PROBES).toBe(shared.OTHER_PROBES);
    expect(applicationProbes.initFor).toBe(shared.initFor);
    expect(applicationProbes.pathFor).toBe(shared.pathFor);
    const own = readFileSync(join(ROOT, "apps/parol/test/routes/probes.ts"), "utf8");
    expect(own).not.toMatch(/template:/);
    expect(own).not.toMatch(/reaches:/);
  });

  it("covers 36 routes that name a matter, and no probe is listed twice", () => {
    expect(shared.MATTER_PROBES).toHaveLength(36);
    const names = shared.MATTER_PROBES.map(shared.probeName);
    expect(new Set(names).size).toBe(names.length);
    expect(ACTORS).toHaveLength(7);
  });

  it("imports nothing from vitest, in any file of the exposure suite", () => {
    const dir = join(ROOT, "evals/src/parol/exposure");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const name of files) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toMatch(/from ["']vitest["']/);
      expect(text, name).not.toMatch(/from ["'][^"']*\/test\//);
    }
  });

  it("has no en dash and no em dash in any file of the suite, its tests or the probe table's re-export", () => {
    const folders = ["evals/src/parol/exposure", "evals/test"];
    const files = folders.flatMap((folder) =>
      readdirSync(join(ROOT, folder))
        .filter(
          (name) =>
            name.endsWith(".ts") &&
            (folder.endsWith("exposure") || name.startsWith("parol-exposure")),
        )
        .map((name) => join(folder, name)),
    );
    files.push("apps/parol/test/routes/probes.ts", "apps/parol/test/routes/support.ts");
    expect(files.length).toBeGreaterThan(15);
    for (const file of files)
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(DASHES);
  });

  it("builds the request of a probe as the application's pages and scripts send it", () => {
    const withBody = shared.MATTER_PROBES.find(
      (probe) => probe.template === "/matters/:matterId/settings",
    )!;
    const page = shared.initFor(withBody, "tok");
    expect(page.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(page.body)).toContain("_csrf=tok");
    const api = shared.initFor(
      shared.MATTER_PROBES.find(
        (probe) => probe.template === "/api/matters/:matterId/runs" && probe.method === "POST",
      )!,
      "tok",
    );
    expect(api.headers["x-csrf-token"]).toBe("tok");
    expect(api.headers["content-type"]).toBe("application/json");
    const read = shared.initFor(shared.MATTER_PROBES[0]!, "tok");
    expect(read.headers).toEqual({});
    expect(read.body).toBeUndefined();
  });
});

describe("what a cell should get", () => {
  it("is the documented table, and the application's table is the same", () => {
    expect(tableDrift()).toEqual([]);
    for (const action of Object.keys(MATTER_ACTIONS) as MatterAction[])
      expect([...MATTER_ACTIONS[action]].sort(), action).toEqual(
        [...DOCUMENTED_ROLES[action]].sort(),
      );
  });

  it("lets a member in only in a role that the action allows, and sends everyone else away", () => {
    const run = shared.MATTER_PROBES.find(
      (probe) => probe.action === "run.start" && probe.template.startsWith("/api"),
    )!;
    expect(expectedFor(run, "associate", false)).toEqual({ kind: "let_in", status: run.reaches });
    expect(expectedFor(run, "reviewer", false)).toEqual({
      kind: "refused",
      status: 403,
      caller: "role",
    });
    expect(expectedFor(run, "viewer", false)).toEqual({
      kind: "refused",
      status: 403,
      caller: "role",
    });
    for (const actor of ["outsider", "stranger", "admin"] as const)
      expect(expectedFor(run, actor, false)).toEqual({
        kind: "refused",
        status: 404,
        caller: "no_part",
      });
    expect(expectedFor(run, "anonymous", false)).toEqual({
      kind: "refused",
      status: 401,
      caller: "visitor",
    });
  });

  it("sends a visitor to sign in on a page, to the start page, and tells a script on the API", () => {
    const page = shared.MATTER_PROBES.find((probe) => probe.template === "/matters/:matterId")!;
    expect(expectedFor(page, "anonymous", true)).toEqual({
      kind: "refused",
      status: 303,
      caller: "visitor",
      location: "/",
    });
    const api = shared.MATTER_PROBES.find((probe) => probe.template === "/api/matters/:matterId")!;
    expect(expectedFor(api, "anonymous", true)).toEqual({
      kind: "refused",
      status: 401,
      caller: "visitor",
    });
  });

  it("relaxes only the decision and the export, and only for the associate", () => {
    const decide = shared.MATTER_PROBES.find((probe) => probe.action === "review.decide")!;
    expect(expectedFor(decide, "associate", false).kind).toBe("refused");
    expect(expectedFor(decide, "associate", true).kind).toBe("let_in");
    const update = shared.MATTER_PROBES.find((probe) => probe.action === "matter.update")!;
    expect(expectedFor(update, "reviewer", true).kind).toBe("refused");
  });

  it("lets the creator and an administrator delete, and nobody else", () => {
    const del = shared.MATTER_PROBES.find(
      (probe) => probe.action === "matter.delete" && probe.method === "DELETE",
    )!;
    expect(expectedFor(del, "associate", false).kind).toBe("let_in");
    expect(expectedFor(del, "admin", false).kind).toBe("let_in");
    expect(expectedFor(del, "reviewer", false)).toEqual({
      kind: "refused",
      status: 403,
      caller: "role",
    });
    expect(expectedFor(del, "stranger", false)).toEqual({
      kind: "refused",
      status: 404,
      caller: "no_part",
    });
  });
});

describe("the windows of a matter's text", () => {
  it("are stretches that HTML escaping leaves alone, and short paragraphs give none", () => {
    const windows = textWindows([
      'The Recipient said "this is quoted" and then, after a long pause for reflection, continued speaking about the plan.',
      "Short.",
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).not.toMatch(/["'&<>]/);
    expect(windows[0]!.length).toBeGreaterThanOrEqual(32);
  });
});
