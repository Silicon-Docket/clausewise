/**
 * The authorization probes, run as an evaluation suite (gate G1, "probes answered with data").
 *
 * The matrix is the one the application tests (apps/parol/test/routes/authorization.test.ts): every
 * route that names a matter (probes.ts), sent as seven callers (an associate, a reviewer and a
 * viewer of the matter, two people who are not members, an administrator who is not a member, and a
 * visitor with no session), twice: once with the segregation of duties on and once relaxed for a
 * single-person demonstration. 36 routes, 7 callers, 2 modes: 504 cells.
 *
 * What each cell should get is written out below from the documented table of roles (docs/parol/03
 * and 06), and is checked to be the table the application uses (`MATTER_ACTIONS`). If the two ever
 * differ, the cells where the application lets in a role the documentation refuses are counted as
 * exposures by the ordinary rule, so a widened table is found and not trusted.
 *
 * A cell is an exposure when a caller who must be refused:
 *  - got through the guard (the access log names the matter, which it does only after the guard has
 *    confirmed it) or got any 2xx answer;
 *  - for a caller with no right to read the matter (a stranger or a visitor): got a body that holds
 *    the matter's title, a window of a document's text, or an id of its documents, versions or
 *    spans;
 *  - for such a caller: got a refusal that is not byte for byte the answer for a matter that does
 *    not exist (status, headers other than the request id, or body), because that tells the caller
 *    the matter is there;
 *  - changed anything in the store.
 * An answer that differs from the expected one in no way that tells a caller more than it should
 * (a member refused with 404 instead of 403, a let-in caller sent away) is a mismatch: counted
 * apart, reported, and not an exposure.
 *
 * Nothing here prints a body. A finding names the route template, the caller and the mode.
 */
import type { MatterAction } from "../../../../apps/parol/src/auth/actions.js";
import { MATTER_ACTIONS } from "../../../../apps/parol/src/auth/actions.js";
import type { MatterRole } from "../../../../apps/parol/src/contracts.js";
import { describeRoutes } from "../../../../apps/parol/src/server/matter-route.js";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import { urls } from "../../../../apps/parol/src/server/urls.js";
import { DEMO_USER_IDS } from "../../../../apps/parol/src/store/index.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import { ExposureControlFailure, ExposureSuiteUnavailable } from "./errors.js";
import { createCaseOracle } from "./model.js";
import {
  MATTER_PROBES,
  initFor,
  isApi,
  pathFor,
  probeName,
  type Probe,
  type ProbeIds,
} from "./probes.js";
import { createCaseMatter, reviewAndExport } from "./review.js";
import { createExposureSite, type ExposureSite, type SiteClient, type SiteHooks } from "./site.js";
import { fileBytes } from "./files.js";

/** The case the matrix is run on: the worked example, with an NDA and an amendment. */
export const AUTHORIZATION_CASE = "PAROL-D05";

export const ACTORS = [
  "associate",
  "reviewer",
  "viewer",
  "outsider",
  "stranger",
  "admin",
  "anonymous",
] as const;
export type Actor = (typeof ACTORS)[number];

const VIEWER = "usr_exposure_viewer";
const OUTSIDER = "usr_exposure_outsider";
const STRANGER = "usr_exposure_stranger";

const USER_OF: Record<Actor, string | null> = {
  associate: DEMO_USER_IDS.associate,
  reviewer: DEMO_USER_IDS.reviewer,
  viewer: VIEWER,
  outsider: OUTSIDER,
  stranger: STRANGER,
  admin: DEMO_USER_IDS.admin,
  anonymous: null,
};
const ROLE_OF: Partial<Record<Actor, MatterRole>> = {
  associate: "associate",
  reviewer: "reviewer",
  viewer: "viewer",
};

const NO_SUCH_MATTER = "mat_0000000000000000";
const MATTER_NAME = "Lanternfish / Corvane NDA (exposure probes)";

/**
 * Who may do what, written out by hand from docs/parol/03 (the HTTP API table) and docs/parol/06,
 * and not read from the table the application uses, so that a wrong edit to either shows up.
 */
export const DOCUMENTED_ROLES: Record<MatterAction, readonly MatterRole[]> = {
  "matter.read": ["associate", "reviewer", "viewer"],
  "matter.update": ["associate"],
  "member.add": ["associate"],
  "document.write": ["associate"],
  "run.start": ["associate"],
  "run.resume": ["associate"],
  "run.read": ["associate", "reviewer", "viewer"],
  "finding.read": ["associate", "reviewer", "viewer"],
  "review.decide": ["reviewer"],
  "memo.export": ["reviewer"],
  "memo.read": ["associate", "reviewer", "viewer"],
  "feedback.add": ["associate", "reviewer", "viewer"],
  "matter.delete": [],
};

/** With segregation relaxed, the associate may also decide and export, and nothing more. */
const RELAXED_EXTRA: Partial<Record<MatterAction, readonly MatterRole[]>> = {
  "review.decide": ["associate"],
  "memo.export": ["associate"],
};

/** The (action, role) pairs on which the application's table and the documented one differ. */
export function tableDrift(): string[] {
  const out: string[] = [];
  for (const action of Object.keys(DOCUMENTED_ROLES) as MatterAction[]) {
    const documented = new Set<string>(DOCUMENTED_ROLES[action]);
    const code = new Set<string>(MATTER_ACTIONS[action]);
    for (const role of new Set([...documented, ...code]))
      if (documented.has(role) !== code.has(role)) out.push(`${action} ${role}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What a cell should get
// ---------------------------------------------------------------------------------------------

export type Expected =
  | { kind: "let_in"; status: number }
  /** `role`: a member whose role does not allow it. `no_part`: not a member. `visitor`: no session. */
  | {
      kind: "refused";
      status: number;
      caller: "role" | "no_part" | "visitor";
      /** Where a visitor sent to sign in is sent: the start page. */
      location?: string;
    };

export function expectedFor(probe: Probe, actor: Actor, relaxed: boolean): Expected {
  const api = isApi(probe.template);
  if (actor === "anonymous")
    return api
      ? { kind: "refused", status: 401, caller: "visitor" }
      : { kind: "refused", status: 303, caller: "visitor", location: urls.home() };
  const role = ROLE_OF[actor];
  if (probe.action === "matter.delete") {
    // Deletion is the creator's, or an administrator's, and is decided apart from the table.
    if (actor === "associate" || actor === "admin")
      return { kind: "let_in", status: probe.reaches };
    return role === undefined
      ? { kind: "refused", status: 404, caller: "no_part" }
      : { kind: "refused", status: 403, caller: "role" };
  }
  if (role === undefined) return { kind: "refused", status: 404, caller: "no_part" };
  const allowed =
    DOCUMENTED_ROLES[probe.action].includes(role) ||
    (relaxed && (RELAXED_EXTRA[probe.action] ?? []).includes(role));
  return allowed
    ? { kind: "let_in", status: probe.reaches }
    : { kind: "refused", status: 403, caller: "role" };
}

// ---------------------------------------------------------------------------------------------
// What a cell got
// ---------------------------------------------------------------------------------------------

/** Headers that differ between two requests for reasons that say nothing about the matter. */
const PER_REQUEST_HEADERS: ReadonlySet<string> = new Set(["x-request-id"]);

export interface Snapshot {
  status: number;
  headers: [string, string][];
  body: string;
}

export function snapshotOf(status: number, headers: Headers, body: string): Snapshot {
  const list: [string, string][] = [];
  headers.forEach((value, name) => {
    if (!PER_REQUEST_HEADERS.has(name.toLowerCase())) list.push([name.toLowerCase(), value]);
  });
  list.sort(([a], [b]) => a.localeCompare(b));
  return { status, headers: list, body };
}

const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
  a.status === b.status &&
  a.body === b.body &&
  JSON.stringify(a.headers) === JSON.stringify(b.headers);

export interface Observed extends Snapshot {
  /** The access log named the matter: the guard confirmed the caller may act on it. */
  letIn: boolean;
  /** Any row count of the store moved. */
  stateChanged: boolean;
}

export type ExposureReason =
  "handler_answered" | "carried_data" | "refusal_differs" | "changed_state";
export const EXPOSURE_REASONS: readonly ExposureReason[] = [
  "handler_answered",
  "carried_data",
  "refusal_differs",
  "changed_state",
];

export type Verdict =
  | { verdict: "expected" }
  | { verdict: "mismatch" }
  | { verdict: "exposure"; reasons: ExposureReason[] };

const containsAny = (body: string, tokens: readonly string[]): boolean => {
  const lower = body.toLowerCase();
  return tokens.some((token) => token.length > 0 && lower.includes(token.toLowerCase()));
};

/**
 * Decides one cell. `missing` is the answer the same caller got for a matter that does not exist,
 * for callers with no right to read the matter. `forbidden` is what must not be in a body those
 * callers get: the title, windows of the text, and the ids of the matter's records.
 */
export function classifyCell(args: {
  expected: Expected;
  observed: Observed;
  missing: Snapshot | null;
  forbidden: readonly string[];
}): Verdict {
  const { expected, observed } = args;
  if (expected.kind === "let_in")
    return observed.letIn && observed.status === expected.status
      ? { verdict: "expected" }
      : { verdict: "mismatch" };

  const reasons: ExposureReason[] = [];
  if (observed.letIn || (observed.status >= 200 && observed.status < 300))
    reasons.push("handler_answered");
  if (observed.stateChanged) reasons.push("changed_state");
  if (expected.caller !== "role") {
    if (containsAny(observed.body, args.forbidden)) reasons.push("carried_data");
    if (args.missing !== null && !sameSnapshot(observed, args.missing))
      reasons.push("refusal_differs");
  }
  if (reasons.length > 0) return { verdict: "exposure", reasons };
  const place = observed.headers.find(([name]) => name === "location")?.[1];
  const wrongPlace = expected.location !== undefined && place !== expected.location;
  return observed.status === expected.status && !wrongPlace
    ? { verdict: "expected" }
    : { verdict: "mismatch" };
}

// ---------------------------------------------------------------------------------------------
// The matter the probes go to
// ---------------------------------------------------------------------------------------------

/** A window of a paragraph that survives HTML escaping: the longest stretch with no markup character. */
export function textWindows(texts: readonly string[], max = 24): string[] {
  const windows = new Set<string>();
  for (const text of texts) {
    const piece = text
      .split(/["'&<>\r\n]/)
      .map((part) => part.trim())
      .sort((a, b) => b.length - a.length)[0];
    if (piece !== undefined && piece.length >= 32) windows.add(piece.slice(0, 48).trim());
    if (windows.size >= max) break;
  }
  return [...windows];
}

/** What the matter holds that must not reach a caller who has no part in it. */
interface MatterTokens {
  title: string;
  windows: string[];
  ids: string[];
  all: string[];
}

function matterTokens(site: ExposureSite, matterId: string, title: string): MatterTokens {
  const repo = site.repo;
  const documents = repo.listDocuments(matterId);
  const versions = repo.listVersions(matterId);
  const spans = repo.listSpans(
    matterId,
    versions.map((version) => version.id),
  );
  const windows = textWindows(spans.map((span) => span.text));
  const ids = [
    ...documents.map((document) => document.id),
    ...versions.map((version) => version.id),
    ...spans.map((span) => span.id),
  ];
  return { title, windows, ids, all: [title, ...windows, ...ids] };
}

/** Row counts of the tables the routes can change, for "a refused request changed nothing". */
export function fingerprint(site: ExposureSite): string {
  const tables = [
    "matters",
    "matter_members",
    "documents",
    "document_versions",
    "source_spans",
    "runs",
    "findings",
    "reviews",
    "memos",
    "feedback",
    "audit_events",
  ];
  return tables
    .map((table) => {
      const row = site.repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return `${table}:${row.n}`;
    })
    .join(" ");
}

export interface AuthorizationFinding {
  probe: string;
  actor: Actor;
  relaxed: boolean;
  reasons: ExposureReason[];
}

export interface AuthorizationResult {
  /** Cells sent. */
  probesRun: number;
  /** Cells where a caller who must be refused was not, or learned something from the refusal. */
  probesAnsweredWithData: number;
  byReason: Record<ExposureReason, number>;
  /** Cells whose answer differed from the expected one without telling the caller more than it should. */
  mismatches: number;
  /** Of the cells run, those that should be let in, those that must be refused, and the refusals compared with a missing matter. */
  shouldBeLetIn: number;
  mustBeRefused: number;
  comparedWithMissing: number;
  routes: number;
  callers: number;
  modes: number;
  /** Differences between the application's role table and the documented one. */
  tableDrift: number;
  /** The first exposed cells, by route template, caller and mode. No content. */
  exposed: AuthorizationFinding[];
  mismatched: AuthorizationFinding[];
  /** One plain sentence for the record. */
  sentence: string;
}

export interface AuthorizationArgs {
  dataset: Dataset;
  root: string;
  playbook: LoadedPlaybook;
  signal: AbortSignal;
  hooks?: SiteHooks;
}

/** Findings kept for the report. The counts are exact whatever this is. */
const KEPT = 8;

/**
 * Runs the 504 cells. Throws `ExposureSuiteUnavailable` if the case is missing, the table is
 * empty or the application has a route that names a matter that the table does not probe.
 */
export async function runAuthorizationProbes(
  args: AuthorizationArgs,
): Promise<AuthorizationResult> {
  const { dataset, signal } = args;
  if (MATTER_PROBES.length === 0)
    throw new ExposureSuiteUnavailable(
      "The authorization probe table is empty. Nothing was probed.",
    );
  const key = dataset.keys.cases.find((entry) => entry.case === AUTHORIZATION_CASE);
  if (key === undefined)
    throw new ExposureSuiteUnavailable(
      `The dataset has no case ${AUTHORIZATION_CASE}, which the authorization probes review. Nothing was probed.`,
    );
  if (key.documents.filter((doc) => doc.operative !== false).length < 2)
    throw new ExposureSuiteUnavailable(
      `The case ${AUTHORIZATION_CASE} has fewer than two documents, and the probes need an amendment. Nothing was probed.`,
    );
  const files = await loadedFiles(args, key);

  const result: AuthorizationResult = {
    probesRun: 0,
    probesAnsweredWithData: 0,
    byReason: { handler_answered: 0, carried_data: 0, refusal_differs: 0, changed_state: 0 },
    mismatches: 0,
    shouldBeLetIn: 0,
    mustBeRefused: 0,
    comparedWithMissing: 0,
    routes: MATTER_PROBES.length,
    callers: ACTORS.length,
    modes: 2,
    tableDrift: tableDrift().length,
    exposed: [],
    mismatched: [],
    sentence: "",
  };

  for (const relaxed of [false, true]) {
    signal.throwIfAborted();
    const oracle = await createCaseOracle({ key, files, playbook: args.playbook });
    const site = createExposureSite({
      playbook: args.playbook,
      generator: oracle,
      relaxed,
      ...(args.hooks === undefined ? {} : { hooks: args.hooks }),
    });
    try {
      await runMode({ site, key, files, relaxed, result, signal });
    } finally {
      site.close();
    }
  }

  const drift =
    result.tableDrift > 0
      ? ` The action table differs from the documented one in ${result.tableDrift} places.`
      : "";
  const named = (list: AuthorizationFinding[]): string =>
    list
      .slice(0, 3)
      .map((f) => `${f.probe} as ${f.actor}${f.relaxed ? " (relaxed)" : ""}`)
      .join("; ");
  result.sentence =
    `Authorization probes: sent ${result.routes} routes that name a matter as ${result.callers} callers ` +
    `in ${result.modes} modes (${result.probesRun} requests, ${result.shouldBeLetIn} of which should be let in ` +
    `and ${result.mustBeRefused} refused, ${result.comparedWithMissing} refusals compared with the answer for a ` +
    `matter that does not exist) to the application running in process on a ` +
    `synthetic matter, and ${result.probesAnsweredWithData} were answered with data or with a ` +
    `refusal that reveals the matter exists (${result.byReason.handler_answered} got through the ` +
    `guard, ${result.byReason.carried_data} carried matter data, ${result.byReason.refusal_differs} ` +
    `refused differently from a missing matter, ${result.byReason.changed_state} changed the store); ` +
    `${result.mismatches} answers differed from the expected one without exposing anything.` +
    drift +
    (result.exposed.length > 0 ? ` First exposed: ${named(result.exposed)}.` : "");
  return result;
}

async function loadedFiles(
  args: Pick<AuthorizationArgs, "dataset" | "root">,
  key: { documents: { file: string; sha256: string }[] },
): Promise<(name: string) => Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const doc of key.documents)
    bytes.set(doc.file, await fileBytes(args.dataset, args.root, doc.file, doc.sha256));
  return (name) => {
    const found = bytes.get(name);
    if (found === undefined) throw new EvalError("A case file was not loaded.");
    return found;
  };
}

interface Mode {
  site: ExposureSite;
  key: Parameters<typeof createCaseMatter>[0]["key"];
  files: (name: string) => Uint8Array;
  relaxed: boolean;
  result: AuthorizationResult;
  signal: AbortSignal;
}

async function runMode(mode: Mode): Promise<void> {
  const { site, key, files, relaxed, result, signal } = mode;
  await site.preflight();
  site.addUser(VIEWER, "Synthetic exposure viewer");
  site.addUser(OUTSIDER, "Synthetic exposure outsider");
  site.addUser(STRANGER, "Synthetic exposure stranger");

  const people = {
    associate: DEMO_USER_IDS.associate,
    reviewer: DEMO_USER_IDS.reviewer,
    viewer: VIEWER,
  };
  const created = await createCaseMatter({ site, key, files, people, matterName: MATTER_NAME });
  const reviewed = await reviewAndExport({ site, key, people, matterId: created.matterId });
  const ids: ProbeIds = {
    matterId: created.matterId,
    firstDocumentId: created.documentIds[0]!,
    versionId: created.versionIds[created.versionIds.length - 1]!,
    runId: reviewed.runId,
    findingId: reviewed.findingId,
    memoId: reviewed.memoId,
  };
  const tokens = matterTokens(site, created.matterId, MATTER_NAME);
  const forbidden = tokens.all;
  const entitled = { title: false, text: false, ids: false };

  // The probe table must be the application's routes: a route that names a matter and has no
  // probe, or a probe for a route that is not there, would make a clean matrix mean less.
  checkCoverage(site);

  const clients = new Map<Actor, SiteClient>();
  for (const actor of ACTORS) {
    const user = USER_OF[actor];
    clients.set(actor, user === null ? site.anonymous() : await site.signIn(user));
  }

  /** One request as a caller sends it, with that caller's own token, and the one log line it made. */
  async function send(actor: Actor, probe: Probe, matterId: string) {
    const client = clients.get(actor)!;
    const token = actor === "anonymous" ? null : await client.apiToken();
    const mark = site.accessLog.length;
    const init = initFor(probe, token);
    const response = await client.send(probe.method, pathFor(probe.template, ids, matterId), init);
    const body = await response.text();
    const lines = site.accessLog.slice(mark);
    if (lines.length !== 1)
      throw new EvalError(
        "The access log is out of step with the requests of the authorization probes.",
      );
    const line = lines[0]!;
    const field = (name: string): string =>
      new RegExp(`(?:^| )${name}=(\\S+)`).exec(line)?.[1] ?? "";
    if (Number(field("status")) !== response.status)
      throw new EvalError("The access log disagrees with an answer of the authorization probes.");
    return {
      snapshot: snapshotOf(response.status, response.headers, body),
      letIn: field("matter") !== "-" && field("matter") !== "",
    };
  }

  for (const probe of MATTER_PROBES) {
    for (const actor of ACTORS) {
      signal.throwIfAborted();
      const expected = expectedFor(probe, actor, relaxed);
      // A request that changes the matter for good runs on a matter made for it.
      const matterId = probe.fresh === true ? freshMatter(site) : ids.matterId;
      const before = fingerprint(site);
      const answer = await send(actor, probe, matterId);
      const after = fingerprint(site);

      let missing: Snapshot | null = null;
      if (expected.kind === "refused" && expected.caller !== "role") {
        missing = (await send(actor, probe, NO_SUCH_MATTER)).snapshot;
        result.comparedWithMissing += 1;
      }
      if (expected.kind === "let_in") result.shouldBeLetIn += 1;
      else result.mustBeRefused += 1;

      const verdict = classifyCell({
        expected,
        observed: { ...answer.snapshot, letIn: answer.letIn, stateChanged: after !== before },
        missing,
        forbidden,
      });
      // The data check has to be able to see matter data: it must find it where a member may read it.
      if (expected.kind === "let_in" && probe.method === "GET" && answer.snapshot.status === 200) {
        const body = answer.snapshot.body;
        if (containsAny(body, [tokens.title])) entitled.title = true;
        if (containsAny(body, tokens.windows)) entitled.text = true;
        if (containsAny(body, tokens.ids)) entitled.ids = true;
      }
      result.probesRun += 1;
      if (verdict.verdict === "exposure") {
        result.probesAnsweredWithData += 1;
        for (const reason of verdict.reasons) result.byReason[reason] += 1;
        if (result.exposed.length < KEPT)
          result.exposed.push({
            probe: probeName(probe),
            actor,
            relaxed,
            reasons: verdict.reasons,
          });
      } else if (verdict.verdict === "mismatch") {
        result.mismatches += 1;
        if (result.mismatched.length < KEPT)
          result.mismatched.push({ probe: probeName(probe), actor, relaxed, reasons: [] });
      }
    }
  }

  // The control of the data check: if the matter's own title, text and ids are nowhere in what its
  // members read, a body without them proves nothing about a body that is read by a stranger.
  const blind = (Object.keys(entitled) as (keyof typeof entitled)[]).filter(
    (name) => !entitled[name],
  );
  if (blind.length > 0)
    throw new ExposureControlFailure(
      `The authorization probes could not find the matter's ${blind.join(" and ")} in any answer a member is entitled to, ` +
        "so the check for matter data in a refusal could not tell data from nothing. No count can be trusted.",
    );
}

/** A matter made for one request, with the viewer as a member as the application's own test has it. */
function freshMatter(site: ExposureSite): string {
  const summary = site.services.matters.create(site.principal(DEMO_USER_IDS.associate), {
    name: "A matter made for one request",
    clientLegalName: "Lanternfish Software, Inc.",
    playbookVersionId: site.playbookVersionId,
    reviewerUserId: DEMO_USER_IDS.reviewer,
  });
  site.repo.addMember(summary.id, VIEWER, "viewer", { actorId: DEMO_USER_IDS.associate });
  return summary.id;
}

function checkCoverage(site: ExposureSite): void {
  const routes = describeRoutes(site.app).filter((route) => route.kind === "matter");
  const key = (method: string, path: string): string => `${method} ${path}`;
  const probes = new Map(MATTER_PROBES.map((probe) => [key(probe.method, probe.template), probe]));
  const missing = routes
    .filter((route) => !probes.has(key(route.method, route.path)))
    .map((route) => key(route.method, route.path));
  if (missing.length > 0)
    throw new ExposureSuiteUnavailable(
      `The application has routes that name a matter and the probe table has no probe for them: ${missing.join(", ")}.`,
    );
  const wrongAction = routes
    .filter((route) => probes.get(key(route.method, route.path))?.action !== route.action)
    .map((route) => key(route.method, route.path));
  if (wrongAction.length > 0)
    throw new ExposureSuiteUnavailable(
      `The probe table names another action than the application checks for: ${wrongAction.join(", ")}.`,
    );
  const registered = new Set(
    describeRoutes(site.app).map((route) => key(route.method, route.path)),
  );
  const stale = MATTER_PROBES.map((probe) => key(probe.method, probe.template)).filter(
    (name) => !registered.has(name),
  );
  if (stale.length > 0)
    throw new ExposureSuiteUnavailable(
      `The probe table has probes for routes the application does not have: ${stale.join(", ")}.`,
    );
}
