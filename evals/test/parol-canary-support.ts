/**
 * Support for the tests of the canary scan that plant a fault in a copy of the application
 * (parol-canary-*.test.ts and the canary tests next to them). Not a test file.
 */
import { createRequire } from "node:module";
import type { AppDeps } from "../../apps/parol/src/server/deps.js";
import type { App } from "../src/parol/exposure/site.js";
import { MATTER_PROBES, OTHER_PROBES } from "../src/parol/exposure/probes.js";
import { createScanner, type ScanTarget, type Scanner } from "../src/parol/exposure/scan.js";

/** The name the scan gives the canary matters it creates. */
export const CANARY_NAME_PREFIX = "Canary matter ";

/**
 * Whether a request path is under a canary matter (`/matters/<id>` or `/api/matters/<id>`). Reads
 * the store at request time, because the matter's id is made when the scan creates the matter.
 */
export function namesCanaryMatter(deps: AppDeps, path: string): boolean {
  const id = /^(?:\/api)?\/matters\/([^/]+)/.exec(path)?.[1];
  return (
    id !== undefined && (deps.repo.getMatter(id)?.name.startsWith(CANARY_NAME_PREFIX) ?? false)
  );
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The static pages that no caller can tell apart: fetched once, by an anonymous client. */
export const STATIC_PAGES: readonly string[] = ["/healthz", "/assets/:name"];

/** Every GET route the probe tables name that names a matter, and every one that does not. */
export const MATTER_GET: readonly string[] = MATTER_PROBES.filter(
  (probe) => probe.method === "GET",
).map((probe) => probe.template);
export const OTHER_GET: readonly string[] = OTHER_PROBES.filter(
  (probe) => probe.method === "GET",
).map((probe) => probe.template);
export const OTHER_GET_NOT_STATIC: readonly string[] = OTHER_GET.filter(
  (template) => !STATIC_PAGES.includes(template),
);

/**
 * How many response bodies a scan of one case reads: each reader fetches the routes it can name,
 * and a route that takes a finding id is fetched once for each finding of the case (and once, with
 * a made-up id, for a canary matter). Derived from the probe tables and the case, not from a run.
 *
 *   - the case's associate, reviewer and viewer: the case's routes, the routes that name no matter,
 *     and each canary matter's routes;
 *   - each canary matter's associate and reviewer: the case's routes, their own, the routes that
 *     name no matter;
 *   - the administrator, the legal engineer and the anonymous client: the same as the case's people;
 *   - the two static pages, once, anonymously.
 */
export function expectedBodies(args: { canaryMatters: number; findings: number }): number {
  const perFinding = MATTER_GET.filter((template) => template.includes(":findingId")).length;
  const caseRoutes = MATTER_GET.length - perFinding + perFinding * args.findings;
  const canaryRoutes = MATTER_GET.length;
  const others = OTHER_GET_NOT_STATIC.length;
  const sides = args.canaryMatters;
  const caseAndStrangers = 6 * (caseRoutes + others + sides * canaryRoutes);
  const canaryPeople = 2 * sides * (caseRoutes + canaryRoutes + others);
  return caseAndStrangers + canaryPeople + STATIC_PAGES.length;
}

/** A scanner that does what the real one does and notes every artefact it was given. */
export function spyScanner(inner: Scanner = createScanner()): {
  scanner: Scanner;
  /** The artefacts scanned for ids (the scan itself): not the scanner's own controls, and not the second look for the distinctive fact. */
  seen: Pick<ScanTarget, "kind" | "label">[];
} {
  const seen: Pick<ScanTarget, "kind" | "label">[] = [];
  return {
    seen,
    scanner: {
      async scan(target) {
        if (!target.label.startsWith("control ") && target.forbid.ids.length > 0)
          seen.push({ kind: target.kind, label: target.label });
        return inner.scan(target);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------------------------

const fromApplication = createRequire(new URL("../../apps/parol/package.json", import.meta.url));

/** A bare Hono application. `hono` is a dependency of the application, not of the evaluations. */
export const newApp = (): App => new (fromApplication("hono") as { Hono: new () => App }).Hono();
