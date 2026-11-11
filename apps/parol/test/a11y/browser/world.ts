import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageFileName } from "../../../src/evaluations/index.js";
import { start, type RunningServer } from "../../../src/main.js";
import { runSeed } from "../../../src/seed.js";
import { CSRF_FIELD, FIELDS } from "../../../src/server/pages/forms.js";
import { urls } from "../../../src/server/urls.js";
import { DEMO_USER_IDS } from "../../../src/store/index.js";
import { comparisonPage, heldoutBody, liveBody } from "../../evaluations/fixtures.js";
import type { PwCookie } from "./playwright.js";

/**
 * The application as the browser tests meet it: the real server (`start`, the same entry as
 * `pnpm parol`) on a free port, a temporary data folder, the demo identity and the scripted reader,
 * and the data the seed builds with every option on: the two demo matters with a review under
 * workflow v2, the training matter, and the backdated pilot scenario. A fifth person who is only a
 * viewer of the demo matter is added, so that every role the pages show can be signed in as. A
 * comparison page is published into the folder the evaluation page reads, so that page is not empty.
 * All of it is synthetic, and nothing is sent anywhere.
 */

export const SECRET = "browser-tests-secret-0123456789abcdef0123456789";

/** The extra person: a member of nothing but a viewer of the first demo matter. */
export const VIEWER_ID = "usr_browser_viewer";
export const VIEWER_NAME = "Vic Okoye (viewer)";

export type RoleName =
  "visitor" | "associate" | "reviewer" | "viewer" | "legal engineer" | "administrator";

export const ROLE_USERS: Readonly<Record<Exclude<RoleName, "visitor">, string>> = {
  associate: DEMO_USER_IDS.associate,
  reviewer: DEMO_USER_IDS.reviewer,
  viewer: VIEWER_ID,
  "legal engineer": DEMO_USER_IDS.legalEngineer,
  administrator: DEMO_USER_IDS.admin,
};

export const DISPLAY_NAMES: Readonly<Record<Exclude<RoleName, "visitor">, string>> = {
  associate: "Alex Ruiz (associate)",
  reviewer: "Dana Whitfield (reviewing attorney)",
  viewer: VIEWER_NAME,
  "legal engineer": "Lee Okafor (legal engineer)",
  administrator: "Sam Patel (admin)",
};

export interface Ids {
  /** The first demo matter: a review under v2, nothing decided, the viewer on it. */
  lanternfish: { matterId: string; runId: string; findingId: string };
  /** The training matter T01 (no review yet). */
  training: { matterId: string };
  /** A pilot demonstration matter with a review, decisions and an exported memo. */
  exported: { matterId: string; runId: string; findingId: string; memoId: string };
  /** A pilot demonstration baseline matter: timers and a reference list, no review. */
  baseline: { matterId: string };
  /** A matter with no document at all. */
  empty: { matterId: string };
  /** The legal engineer's own matter: everybody else is told it is not found. */
  other: { matterId: string };
  /** The id of a published comparison page, for the evaluation page's detail view. */
  comparisonId: string;
}

export interface World {
  base: string;
  dataDir: string;
  server: RunningServer;
  ids: Ids;
  /** The cookies a signed-in browser holds for a person, got the way a form post gets them. */
  cookiesFor(role: Exclude<RoleName, "visitor">): Promise<PwCookie[]>;
  close(): Promise<void>;
}

/** The set-cookie lines of a response as name and value pairs. */
function cookiesOf(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return jar;
}

export async function bootWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "parol-browser-"));
  const dataDir = join(root, "data");
  const env = {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
  };
  const seeded = await runSeed(env, ["--run", "v2", "--training", "--pilot-demo"], () => {});

  // A comparison page for the evaluation page to list, so that it is not shown empty.
  mkdirSync(join(dataDir, "evaluations"), { recursive: true });
  const pages = [
    comparisonPage(),
    comparisonPage(liveBody(), "live"),
    comparisonPage(heldoutBody(), "heldout"),
  ];
  for (const page of pages)
    writeFileSync(join(dataDir, "evaluations", pageFileName(page.id)), JSON.stringify(page));

  const server = await start(env, { log: () => {}, notice: () => {} });
  const { repo } = server;
  const firstMatter = seeded.matters.find((m) => m.key === "lanternfish")!;
  const other = seeded.matters.find((m) => m.key === "heronbridge")!;

  // The viewer: a person with no global role, on the first demo matter and on the training matter.
  repo.db
    .prepare("INSERT INTO users (id, display_name, global_role, demo) VALUES (?, ?, 'member', 1)")
    .run(VIEWER_ID, VIEWER_NAME);
  repo.addMember(firstMatter.matterId, VIEWER_ID, "viewer", { actorId: DEMO_USER_IDS.associate });
  const exportedMatter = seeded.pilotDemo?.matters.find(
    (m) => m.kind === "assisted" && repo.listMemos(m.matterId).length > 0,
  );
  const baselineMatter = seeded.pilotDemo?.matters.find((m) => m.kind === "baseline");
  if (exportedMatter === undefined || baselineMatter === undefined || seeded.training === null)
    throw new Error("the seed did not build the matters the browser tests need");
  repo.addMember(exportedMatter.matterId, VIEWER_ID, "viewer", {
    actorId: DEMO_USER_IDS.associate,
  });

  const empty = repo.createMatter({
    name: "Browser test matter with nothing in it",
    clientLegalName: "Lanternfish Software, Inc.",
    createdBy: DEMO_USER_IDS.associate,
  });
  repo.addMember(empty.id, DEMO_USER_IDS.reviewer, "reviewer", {
    actorId: DEMO_USER_IDS.associate,
  });
  repo.addMember(empty.id, VIEWER_ID, "viewer", { actorId: DEMO_USER_IDS.associate });

  const firstRun = seeded.runs.find((r) => r.matterId === firstMatter.matterId && r.runId !== "");
  if (firstRun === undefined) throw new Error("the seed did not run a review");
  const findingOf = (matterId: string, runId: string): string => {
    const f = repo.listFindings(matterId, runId)[0];
    if (f === undefined) throw new Error("a review has no finding");
    return f.id;
  };
  // The pilot demonstration matter that has a memo: find the run and the memo through the store.
  const memo = repo.listMemos(exportedMatter.matterId)[0];
  if (memo === undefined) throw new Error("the demonstration matter has no memo");

  const ids: Ids = {
    lanternfish: {
      matterId: firstMatter.matterId,
      runId: firstRun.runId,
      findingId: findingOf(firstMatter.matterId, firstRun.runId),
    },
    training: { matterId: seeded.training.matterId },
    exported: {
      matterId: exportedMatter.matterId,
      runId: memo.runId,
      findingId: findingOf(exportedMatter.matterId, memo.runId),
      memoId: memo.id,
    },
    baseline: { matterId: baselineMatter.matterId },
    empty: { matterId: empty.id },
    other: { matterId: other.matterId },
    comparisonId: pages[1]!.id,
  };

  const base = `http://127.0.0.1:${server.port}`;
  const cookiesFor = async (role: Exclude<RoleName, "visitor">): Promise<PwCookie[]> => {
    const jar = new Map<string, string>();
    const send = async (path: string, init: RequestInit): Promise<Response> => {
      const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
      const response = await fetch(`${base}${path}`, {
        ...init,
        redirect: "manual",
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(cookie ? { cookie } : {}),
        },
      });
      for (const [n, v] of cookiesOf(response)) jar.set(n, v);
      return response;
    };
    const session = await send("/api/session", { method: "GET" });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const signedIn = await send(urls.session(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [FIELDS.intent]: "sign-in",
        [FIELDS.userId]: ROLE_USERS[role],
        [CSRF_FIELD]: csrfToken,
      }).toString(),
    });
    if (signedIn.status !== 303) throw new Error(`signing in as the ${role} was refused`);
    return [...jar].map(([name, value]) => ({ name, value, url: base }));
  };

  return {
    base,
    dataDir,
    server,
    ids,
    cookiesFor,
    async close() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
