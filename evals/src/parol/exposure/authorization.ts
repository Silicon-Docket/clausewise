/**
 * The authorization probes, run as an evaluation suite (gate G1, "probes answered with data").
 *
 * Three groups of cells, each sent in two modes: once with the segregation of duties on and once
 * relaxed for a single-person demonstration.
 *
 *  1. The matrix (the one the application tests, apps/parol/test/routes/authorization.test.ts):
 *     every route that names a matter (probes.ts), sent as seven callers: an associate, a reviewer
 *     and a viewer of the matter, a person who belongs to another matter only, a signed-in person
 *     who belongs to no matter, an administrator who is not a member, and a visitor with no
 *     session. Routes x callers x modes.
 *  2. The forged ids: for every route that takes the id of a document, a version, a run, a finding
 *     or a memo, and for the places outside the path where such an id goes (the PATCH body, a form
 *     field, a query string), the request of a member of this matter that names a record of a
 *     second matter in its place. The answer must be the one for an id that exists nowhere, and
 *     neither matter may change.
 *  3. The routes that name no matter and only read (the lists, the start page, the session), read
 *     as every caller, because a list can show a person the title of a matter they have no part in.
 *
 * What each matrix cell should get is written out below from the documented table of roles
 * (docs/parol/03 and 06), and is checked to be the table the application uses (`MATTER_ACTIONS`).
 * If the two ever differ, the cells where the application lets in a role the documentation refuses
 * are counted as exposures by the ordinary rule, so a widened table is found and not trusted.
 *
 * A matrix cell is an exposure when a caller who must be refused:
 *  - got through the guard (the access log names the matter, which it does only after the guard has
 *    confirmed it) or got any 2xx answer;
 *  - for a caller with no right to read the matter (a stranger or a visitor): got a body that holds
 *    the matter's title, a window of a document's text, or an id of its documents, versions, spans,
 *    runs, findings or memos;
 *  - for such a caller: got a refusal that is not byte for byte the answer for a matter that does
 *    not exist (status, headers other than the request id, or body), because that tells the caller
 *    the matter is there. The answer it is compared with is fictional in every segment, so an
 *    answer that depends on a run, a finding or a document existing is found as well;
 *  - changed anything in the store (a hash of every row of every table, before and after).
 * A forged-id cell is an exposure when the answer is a success, holds an id or the title of the
 * second matter, differs from the answer for an id of no record (which tells the caller that the
 * record exists elsewhere), or changed any row of the store. A list cell is an exposure when it
 * holds the title or an id of a matter the caller has no part in, or answers a visitor.
 *
 * An answer that differs from the expected one in no way that tells a caller more than it should
 * (a member refused with 404 instead of 403, a let-in caller sent away) is a mismatch: counted
 * apart, reported, and not an exposure. One kind of mismatch is counted again on its own: a cell
 * whose caller should have been let in and was not (`letInNotReached`). Such a cell was stopped
 * before the handler it was written to test, so it proves nothing about that handler, and gate G1
 * does not call a run clean while there is one.
 *
 * Nothing here prints a body. A finding names the route template, the caller and the mode.
 */
import { createHash } from "node:crypto";
import type { MatterAction } from "../../../../apps/parol/src/auth/actions.js";
import { MATTER_ACTIONS } from "../../../../apps/parol/src/auth/actions.js";
import type { MatterRole } from "../../../../apps/parol/src/contracts.js";
import {
  describeRoutes,
  findMatterUrlsWithoutGuard,
  isMatterScopedPath,
} from "../../../../apps/parol/src/server/matter-route.js";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import { urls } from "../../../../apps/parol/src/server/urls.js";
import { DEMO_USER_IDS } from "../../../../apps/parol/src/store/index.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import { ExposureControlFailure, ExposureSuiteUnavailable } from "./errors.js";
import { createCaseOracle } from "./model.js";
import {
  FORGED_PROBES,
  LIST_PROBES,
  MATTER_PROBES,
  NO_MATTER,
  NO_RECORD,
  effectOf,
  initFor,
  isApi,
  noRecordIds,
  pathFor,
  probeKeyOf,
  probeName,
  type BorrowedIds,
  type ForgedProbe,
  type OtherProbe,
  type Probe,
  type ProbeBody,
  type ProbeIds,
  type Scratch,
  type ScratchLevel,
} from "./probes.js";
import { createCaseMatter, decisionFor, reviewAndExport } from "./review.js";
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
/** The reviewer of the second matter. Not a caller. */
const OTHER_REVIEWER = "usr_exposure_other_reviewer";
/** A person the writes try to add to a matter. Not a caller. */
const INVITEE = "usr_exposure_invitee";

const USER_OF: Record<Actor, string | null> = {
  associate: DEMO_USER_IDS.associate,
  reviewer: DEMO_USER_IDS.reviewer,
  viewer: VIEWER,
  outsider: OUTSIDER,
  stranger: STRANGER,
  admin: DEMO_USER_IDS.admin,
  anonymous: null,
};
/** The role each caller holds in the matter the matrix goes to. The stranger holds none in it. */
const ROLE_OF: Partial<Record<Actor, MatterRole>> = {
  associate: "associate",
  reviewer: "reviewer",
  viewer: "viewer",
};

const NO_SUCH_MATTER = NO_MATTER;
const MATTER_NAME = "Lanternfish / Corvane NDA (exposure probes)";
const SECOND_NAME = "Second matter for the forged id probes (Lanternfish / Corvane)";

/** What the sentence calls the seven callers, in the order of `ACTORS`. */
const CALLER_KINDS =
  "an associate, a reviewer and a viewer of the matter, a person who belongs to another matter only, " +
  "a signed-in person who belongs to no matter, an administrator who is not a member, and a visitor with no session";

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

/**
 * What a read of a route that names no matter should get: everyone is answered by a public route,
 * a signed-in person by the others, and a visitor is told to sign in (a script is told, a page
 * sends the visitor to the start page).
 */
export function expectedList(probe: OtherProbe, actor: Actor): Expected {
  if (probe.access === "public" || actor !== "anonymous") return { kind: "let_in", status: 200 };
  return isApi(probe.template)
    ? { kind: "refused", status: 401, caller: "visitor" }
    : { kind: "refused", status: 303, caller: "visitor", location: urls.home() };
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
  /** Some row of the store is not what it was: the hash of every row of every table moved. */
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
 * Decides one cell. `missing` is the answer the same caller got for a matter that does not exist
 * (and records that do not exist), for callers with no right to read the matter. `forbidden` is
 * what must not be in a body those callers get: the title, windows of the text, and the ids of the
 * matter's records.
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

/**
 * Decides one forged-id cell: a member of the matter named a record of another matter. `invented`
 * is the answer the same caller got for an id of no record in the same place. The answer must be
 * that answer, and the guard must have let the member in (so that the lookup of the id was what
 * answered).
 *
 * A success, an id or the title of the other matter in the body, a changed row, and any difference
 * from the answer for an id of no record are exposures: each tells a member of one matter that a
 * record of another exists, or hands it over. Where the answer is the same as for an id of no
 * record but is not the status the cell was built to reach (a 400 where the lookup was to answer),
 * the request never got to the lookup: a mismatch, and a cell that did not reach its handler.
 */
export function classifyForged(args: {
  expectedStatus: number;
  observed: Observed;
  invented: Snapshot;
  forbidden: readonly string[];
}): Verdict {
  const { expectedStatus, observed, invented } = args;
  const reasons: ExposureReason[] = [];
  const success = observed.status >= 200 && observed.status < 300;
  const expectedSuccess = expectedStatus >= 200 && expectedStatus < 300;
  if (success && !expectedSuccess) reasons.push("handler_answered");
  if (observed.stateChanged) reasons.push("changed_state");
  if (containsAny(observed.body, args.forbidden)) reasons.push("carried_data");
  if (!sameSnapshot(observed, invented)) reasons.push("refusal_differs");
  if (reasons.length > 0) return { verdict: "exposure", reasons };
  return observed.letIn && observed.status === expectedStatus
    ? { verdict: "expected" }
    : { verdict: "mismatch" };
}

/**
 * Decides one read of a route that names no matter. `forbidden` holds the title and the ids of the
 * matters the caller has no part in.
 */
export function classifyListing(args: {
  expected: Expected;
  observed: Observed;
  forbidden: readonly string[];
}): Verdict {
  const { expected, observed } = args;
  const reasons: ExposureReason[] = [];
  if (
    expected.kind === "refused" &&
    ((observed.status >= 200 && observed.status < 300) || observed.letIn)
  )
    reasons.push("handler_answered");
  if (observed.stateChanged) reasons.push("changed_state");
  if (containsAny(observed.body, args.forbidden)) reasons.push("carried_data");
  if (reasons.length > 0) return { verdict: "exposure", reasons };
  const place = observed.headers.find(([name]) => name === "location")?.[1];
  const wrongPlace =
    expected.kind === "refused" && expected.location !== undefined && place !== expected.location;
  return observed.status === expected.status && !wrongPlace
    ? { verdict: "expected" }
    : { verdict: "mismatch" };
}

// ---------------------------------------------------------------------------------------------
// The matters the probes go to
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

/** What a matter holds that must not reach a caller who has no part in it. */
interface MatterTokens {
  title: string;
  windows: string[];
  ids: string[];
  all: string[];
}

function matterTokens(
  site: ExposureSite,
  matterId: string,
  title: string,
  recordIds: readonly string[],
): MatterTokens {
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
    ...recordIds,
  ];
  return { title, windows, ids, all: [title, ...windows, ...ids] };
}

/** The tables of the store, in name order, with the statement that reads every row of each. */
const READERS = new WeakMap<object, { name: string; read: () => unknown[] }[]>();

/**
 * A hash of every row of every table of the store, in the order the rows were made. Two equal
 * hashes mean that no row was added, removed or changed in between, which a count of rows would
 * not say about an update that keeps the count (a role, a name, the operative version, a status).
 */
export function fingerprint(site: Pick<ExposureSite, "repo">): string {
  const db = site.repo.db;
  let readers = READERS.get(db);
  if (readers === undefined) {
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    readers = names.map((name) => {
      const statement = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`);
      return { name, read: () => statement.all() };
    });
    READERS.set(db, readers);
  }
  const hash = createHash("sha256");
  for (const { name, read } of readers) {
    hash.update(name);
    hash.update(JSON.stringify(read()));
  }
  return hash.digest("hex");
}

/** The point of the store a request is sent against. */
export interface StorePoint {
  changes: number;
  hash: string;
}

export interface StoreWatch {
  /** The store as it is now. Costs a hash only if something wrote to it since the last point. */
  take(): StorePoint;
  /** Whether any row of the store is not what it was at `since`. */
  changedSince(since: StorePoint): boolean;
}

const COUNTERS = new WeakMap<object, () => number>();

/**
 * Watches the store for the cells. SQLite counts every row it inserts, updates or deletes, so a
 * request that wrote nothing is known to have changed nothing without reading the store. When the
 * counter has moved, the hash of every row (`fingerprint`) says whether the rows are now different,
 * because a write can put back what was there.
 */
export function storeWatch(site: Pick<ExposureSite, "repo">): StoreWatch {
  const db = site.repo.db;
  let counter = COUNTERS.get(db);
  if (counter === undefined) {
    const statement = db.prepare("SELECT total_changes() AS n");
    counter = () => (statement.get() as { n: number }).n;
    COUNTERS.set(db, counter);
  }
  const changesNow = counter;
  let known: StorePoint | null = null;
  const take = (): StorePoint => {
    const changes = changesNow();
    if (known === null || known.changes !== changes) known = { changes, hash: fingerprint(site) };
    return known;
  };
  return {
    take,
    changedSince(since) {
      return changesNow() === since.changes ? false : take().hash !== since.hash;
    },
  };
}

export interface AuthorizationFinding {
  probe: string;
  actor: Actor;
  relaxed: boolean;
  reasons: ExposureReason[];
}

export interface AuthorizationResult {
  /** Cells sent: the matrix, the forged ids and the reads of the routes that name no matter. */
  probesRun: number;
  /** Cells where a caller who must be refused was not, or learned something from the answer. */
  probesAnsweredWithData: number;
  byReason: Record<ExposureReason, number>;
  /**
   * Cells whose answer differed from the expected one without telling the caller more than it
   * should. Includes `letInNotReached`.
   */
  mismatches: number;
  /**
   * Cells whose caller should have been let in (or, for a forged id, should have reached the
   * lookup of the id) and was not. Such a cell was stopped before the handler it was written to
   * test. A subset of `mismatches`.
   */
  letInNotReached: number;
  /** Of the matrix cells, those that should be let in, those that must be refused, and the refusals compared with a missing matter. */
  shouldBeLetIn: number;
  mustBeRefused: number;
  comparedWithMissing: number;
  /** Cells of each group. `probesRun` is their sum. */
  matrixCells: number;
  forgedCells: number;
  listCells: number;
  /** Routes that name a matter, in the matrix. */
  routes: number;
  /** Forged-id requests (one per id a route takes, and one per place outside a path). */
  forgedRequests: number;
  /** Routes that name no matter and are only read. */
  listRoutes: number;
  callers: number;
  modes: number;
  /** Write routes of the matrix, and those whose refused callers were sent a body that changes the store for a caller who is let in. */
  writeRoutes: number;
  writesWithEffect: number;
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
 * Runs the cells. Throws `ExposureSuiteUnavailable` if the case is missing, the table is empty or
 * the application has a route that names a matter that the table does not probe, whether it was
 * registered with `defineMatterRoute` or another way.
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
    letInNotReached: 0,
    shouldBeLetIn: 0,
    mustBeRefused: 0,
    comparedWithMissing: 0,
    matrixCells: 0,
    forgedCells: 0,
    listCells: 0,
    routes: MATTER_PROBES.length,
    forgedRequests: FORGED_PROBES.length,
    listRoutes: LIST_PROBES.length,
    callers: ACTORS.length,
    modes: 2,
    writeRoutes: MATTER_PROBES.filter((probe) => probe.method !== "GET").length,
    writesWithEffect: MATTER_PROBES.filter(
      (probe) => probe.method !== "GET" && effectOf(probe, DUMMY_SCRATCH) !== null,
    ).length,
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

  result.sentence = sentenceOf(result);
  return result;
}

/** The sentence of the record. It states the counts of this run and holds no number of its own. */
export function sentenceOf(result: Omit<AuthorizationResult, "sentence">): string {
  const drift =
    result.tableDrift > 0
      ? ` The action table differs from the documented one in ${result.tableDrift} places.`
      : "";
  const named = (list: AuthorizationFinding[]): string =>
    list
      .slice(0, 3)
      .map((f) => `${f.probe} as ${f.actor}${f.relaxed ? " (relaxed)" : ""}`)
      .join("; ");
  const unreached =
    result.letInNotReached > 0
      ? `, ${result.letInNotReached} of them cells whose caller should have been let in and was not, ` +
        "which did not reach their handler and so tested nothing past the guard"
      : ", and every cell whose caller should have been let in reached its handler";
  return (
    `Authorization probes: sent ${result.probesRun} cells to the application running in process ` +
    `on synthetic matters that a scripted key oracle, which is not a language model, had reviewed. ` +
    `${result.probesAnsweredWithData} were answered with data or with an answer that reveals that a matter or a ` +
    `record exists (${result.byReason.handler_answered} got through the guard or succeeded, ` +
    `${result.byReason.carried_data} carried data of a matter, ${result.byReason.refusal_differs} ` +
    `answered differently from a matter or record that does not exist, ${result.byReason.changed_state} ` +
    `changed a row of the store); ${result.mismatches} answered differently from the expected answer ` +
    `without exposing anything${unreached}. ` +
    `The cells: ${result.matrixCells} for ${result.routes} routes that name a matter as ${result.callers} ` +
    `callers (${CALLER_KINDS}) in ${result.modes} modes, ${result.shouldBeLetIn} of which should be let in ` +
    `and ${result.mustBeRefused} refused, with ${result.comparedWithMissing} refusals compared with the ` +
    `answer for a matter and records that exist nowhere; ${result.forgedCells} in which a member of the ` +
    `matter sent ${result.forgedRequests} requests that name a record of another matter (in a path, a body or ` +
    `a query string), which must be answered as an id of no record is and change no row; and ` +
    `${result.listCells} in which the ${result.listRoutes} routes that name no matter and only read were read ` +
    `as every caller, which must hold no title or id of a matter the caller has no part in. ` +
    `Changes were found by comparing a hash of every row of every table before and after each cell, ` +
    `and callers who must be refused were sent a body that changes the store for a caller who is let in on ` +
    `${result.writesWithEffect} of ${result.writeRoutes} write routes (the others, such as resuming a ` +
    `finished run, are answered the same whoever sends them and cannot change it).` +
    drift +
    (result.exposed.length > 0 ? ` First exposed: ${named(result.exposed)}.` : "")
  );
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

/** A request as it is sent: the method, the template (which says whether it is the API), the path and the body. */
interface Wire {
  method: string;
  template: string;
  path: string;
  body: ProbeBody;
}

async function runMode(mode: Mode): Promise<void> {
  const { site, key, files, relaxed, result, signal } = mode;
  await site.preflight();

  // The probe table must be the application's routes: a route that names a matter and has no
  // probe, or a probe for a route that is not there, would make a clean matrix mean less.
  checkCoverage(site);

  site.addUser(VIEWER, "Synthetic exposure viewer");
  site.addUser(OUTSIDER, "Synthetic exposure outsider");
  site.addUser(STRANGER, "Synthetic exposure stranger");
  site.addUser(OTHER_REVIEWER, "Synthetic reviewer of the second matter");
  site.addUser(INVITEE, "Synthetic person to be added");

  // The matter the matrix goes to, reviewed and exported.
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
  const tokens = matterTokens(site, created.matterId, MATTER_NAME, [
    reviewed.runId,
    ...reviewed.findingIds,
    reviewed.memoId,
  ]);

  // A second matter, of a second associate and a second reviewer, reviewed the same way. The
  // stranger is its associate: a signed-in person who belongs to a matter, though not to this one.
  const second = { associate: STRANGER, reviewer: OTHER_REVIEWER, viewer: null };
  const createdB = await createCaseMatter({
    site,
    key,
    files,
    people: second,
    matterName: SECOND_NAME,
  });
  const reviewedB = await reviewAndExport({
    site,
    key,
    people: second,
    matterId: createdB.matterId,
  });
  const tokensB = matterTokens(site, createdB.matterId, SECOND_NAME, [
    reviewedB.runId,
    ...reviewedB.findingIds,
    reviewedB.memoId,
  ]);
  // And the reviewer of a third, so that the stranger holds each of the two roles somewhere.
  site.services.matters.create(site.principal(DEMO_USER_IDS.associate), {
    name: "A third matter, reviewed by the stranger",
    clientLegalName: "Lanternfish Software, Inc.",
    playbookVersionId: site.playbookVersionId,
    reviewerUserId: STRANGER,
  });
  const foreignHash = site.services.runs.finding(
    site.authorize(OTHER_REVIEWER, createdB.matterId, "finding.read"),
    reviewedB.findingId,
  ).contentSha256;
  const borrowed: BorrowedIds = {
    // The last document is the one that may be removed, so a hole in the removal shows.
    documentId: createdB.documentIds[createdB.documentIds.length - 1]!,
    versionId: createdB.versionIds[createdB.versionIds.length - 1]!,
    runId: reviewedB.runId,
    findingId: reviewedB.findingId,
    memoId: reviewedB.memoId,
    findingContentSha256: foreignHash,
  };
  const invented: BorrowedIds = { ...NO_RECORD, findingContentSha256: foreignHash };

  const clients = new Map<Actor, SiteClient>();
  for (const actor of ACTORS) {
    const user = USER_OF[actor];
    clients.set(actor, user === null ? site.anonymous() : await site.signIn(user));
  }

  /** One request as a caller sends it, with that caller's own token, and the one log line it made. */
  async function send(actor: Actor, wire: Wire) {
    const client = clients.get(actor)!;
    const token = actor === "anonymous" ? null : await client.apiToken();
    const mark = site.accessLog.length;
    const init = initFor(wire, token);
    const response = await client.send(wire.method, wire.path, init);
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

  const wireOf = (
    probe: Pick<Probe, "method" | "template">,
    path: string,
    body: ProbeBody,
  ): Wire => ({
    method: probe.method,
    template: probe.template,
    path,
    body,
  });

  const watch = storeWatch(site);
  /** A run that a cell started runs on by itself; wait for it so that its rows are not taken for the next cell's. */
  const settle = (): Promise<void> => site.services.runs.idle();

  const record = (
    verdict: Verdict,
    cell: { probe: string; actor: Actor },
    shouldBeLetIn: boolean,
  ): void => {
    result.probesRun += 1;
    if (verdict.verdict === "exposure") {
      result.probesAnsweredWithData += 1;
      for (const reason of verdict.reasons) result.byReason[reason] += 1;
      if (result.exposed.length < KEPT)
        result.exposed.push({ ...cell, relaxed, reasons: verdict.reasons });
    } else if (verdict.verdict === "mismatch") {
      result.mismatches += 1;
      if (shouldBeLetIn) result.letInNotReached += 1;
      if (result.mismatched.length < KEPT)
        result.mismatched.push({ ...cell, relaxed, reasons: [] });
    }
  };

  // What the data checks must be able to find. If the matter's own title, text and ids are
  // nowhere in what its members read, a body without them proves nothing about a body that is
  // read by a stranger.
  const entitled = { title: false, text: false, ids: false };
  const entitledLists = { own: false, second: false };
  const entitledSecond = { title: false, ids: false };
  /** The writes whose body is shown to change the store for a caller who is let in. */
  const shown = new Set<string>();
  const effectKeys: string[] = [];

  // --- 1. the matrix ---------------------------------------------------------------------------

  async function makeScratch(level: ScratchLevel): Promise<Scratch> {
    const made = await createCaseMatter({
      site,
      key,
      files,
      people,
      matterName: "A matter made to be written to",
    });
    const author = site.authorize(DEMO_USER_IDS.associate, made.matterId, "document.write");
    // A second version of the NDA, so that the operative version can be changed back.
    const version = await site.services.matters.addVersion(author, made.documentIds[0]!, {
      fileName: "nda-version-2.txt",
      bytes: new TextEncoder().encode(
        "MUTUAL NONDISCLOSURE AGREEMENT\n\n1. A paragraph of synthetic text that is long enough to be reviewed.\n",
      ),
      statedDate: null,
    });
    const scratch: Scratch = {
      matterId: made.matterId,
      documentId: made.documentIds[0]!,
      versionId: version.versionId,
      earlierVersionId: made.versionIds[0]!,
      amendmentId: made.documentIds[made.documentIds.length - 1]!,
      invitee: INVITEE,
    };
    if (level === "documents") return scratch;
    // Reviewed: a finished run whose findings are open.
    const starter = site.authorize(DEMO_USER_IDS.associate, made.matterId, "run.start");
    const started = site.services.runs.start(starter, { workflowLabel: "v2" });
    await site.services.runs.idle();
    const issues = site.services.runs.issues(starter, started.id);
    const reviewer = site.authorize(DEMO_USER_IDS.reviewer, made.matterId, "review.decide");
    const open = issues[0];
    if (open === undefined)
      throw new EvalError(
        "The authorization probes could not review a matter made to be written to.",
      );
    scratch.runId = started.id;
    scratch.findingId = open.findingId;
    const request = decisionFor(site.services.runs.finding(reviewer, open.findingId));
    scratch.decision = {
      decision: request.decision,
      findingContentSha256: request.findingContentSha256,
      reason: request.reason ?? null,
    };
    if (level === "run") return scratch;
    for (const issue of issues) {
      const view = site.services.runs.finding(reviewer, issue.findingId);
      site.services.reviews.decide(reviewer, issue.findingId, decisionFor(view));
    }
    return scratch;
  }

  for (const probe of MATTER_PROBES) {
    const key_ = probeKeyOf(probe);
    let scratch: Scratch | null = null;
    // A route that has a body meant to change the store sends it to the callers who must be refused.
    const shape = probe.method === "GET" ? null : effectOf(probe, DUMMY_SCRATCH);
    const hasEffect = shape !== null;
    if (hasEffect) effectKeys.push(key_);
    for (const actor of ACTORS) {
      signal.throwIfAborted();
      const expected = expectedFor(probe, actor, relaxed);
      let cellIds: ProbeIds = ids;
      let body: ProbeBody = probe.body;
      // A request that changes the matter for good runs on a matter made for it.
      if (probe.fresh === true) {
        cellIds = { ...ids, matterId: freshMatter(site) };
      }
      if (shape !== null && expected.kind === "refused") {
        if (shape.target === "scratch") {
          if (scratch === null) {
            scratch = await makeScratch(shape.needs);
          }
          const effect = effectOf(probe, scratch)!;
          body = effect.body;
          cellIds = effect.ids(scratch, ids);
        } else {
          body = shape.body;
        }
      }
      const before = watch.take();
      const wire = wireOf(probe, pathFor(probe.template, cellIds), body);
      const answer = await send(actor, wire);

      let missing: Snapshot | null = null;
      if (expected.kind === "refused" && expected.caller !== "role") {
        // The answer for a matter that exists nowhere, with records that exist nowhere either.
        missing = (
          await send(
            actor,
            wireOf(probe, pathFor(probe.template, noRecordIds(NO_SUCH_MATTER)), body),
          )
        ).snapshot;
        result.comparedWithMissing += 1;
      }
      await settle();
      const changed = watch.changedSince(before);
      if (expected.kind === "let_in") result.shouldBeLetIn += 1;
      else result.mustBeRefused += 1;

      const verdict = classifyCell({
        expected,
        observed: { ...answer.snapshot, letIn: answer.letIn, stateChanged: changed },
        missing,
        forbidden: tokens.all,
      });
      // The data check has to be able to see matter data: it must find it where a member may read it.
      if (expected.kind === "let_in" && probe.method === "GET" && answer.snapshot.status === 200) {
        const text = answer.snapshot.body;
        if (containsAny(text, [tokens.title])) entitled.title = true;
        if (containsAny(text, tokens.windows)) entitled.text = true;
        if (containsAny(text, tokens.ids)) entitled.ids = true;
      }
      // The deletion of a matter made for the request is its own proof: it is let in, answered with a
      // success, and the matter is gone.
      if (
        shape?.target === "fresh" &&
        expected.kind === "let_in" &&
        verdict.verdict === "expected" &&
        changed
      )
        shown.add(key_);
      result.matrixCells += 1;
      record(verdict, { probe: probeName(probe), actor }, expected.kind === "let_in");
    }

    // The proof that the body sent to the refused callers changes the store when a caller who is
    // let in sends it, on the matter they were sent to. Without it a clean count says nothing.
    if (shape?.target === "scratch" && scratch !== null) {
      const effect = effectOf(probe, scratch)!;
      const role = DOCUMENTED_ROLES[probe.action][0] ?? "associate";
      const letInActor: Actor = probe.action === "matter.delete" ? "associate" : role;
      const before = watch.take();
      await send(
        letInActor,
        wireOf(probe, pathFor(probe.template, effect.ids(scratch, ids)), effect.body),
      );
      await settle();
      if (watch.changedSince(before)) shown.add(key_);
    }
  }

  // --- 2. the forged ids -----------------------------------------------------------------------

  for (const forged of FORGED_PROBES) {
    signal.throwIfAborted();
    // The caller holds the role that the route needs in this matter, and nothing in the other.
    const actor = (DOCUMENTED_ROLES[forged.action][0] ?? "associate") as Actor;
    const real = forged.request(ids, borrowed);
    const made = forged.request(ids, invented);
    const before = watch.take();
    const answer = await send(actor, wireOf(forged, real.path, real.body));
    const reference = await send(actor, wireOf(forged, made.path, made.body));
    await settle();
    const verdict = classifyForged({
      expectedStatus: forged.reaches,
      observed: {
        ...answer.snapshot,
        letIn: answer.letIn,
        stateChanged: watch.changedSince(before),
      },
      invented: reference.snapshot,
      // The second matter's text is the first one's (the same case), so only its title and ids tell them apart.
      forbidden: [tokensB.title, ...tokensB.ids],
    });
    result.forgedCells += 1;
    record(verdict, { probe: forged.name, actor }, true);
  }

  // --- 3. the routes that name no matter -------------------------------------------------------

  const membersOf = (actor: Actor): { first: boolean; second: boolean } => ({
    first: actor === "associate" || actor === "reviewer" || actor === "viewer",
    second: actor === "stranger",
  });
  for (const probe of LIST_PROBES) {
    for (const actor of ACTORS) {
      signal.throwIfAborted();
      const expected = expectedList(probe, actor);
      const member = membersOf(actor);
      const forbidden = [
        ...(member.first ? [] : tokens.all),
        ...(member.second ? [] : tokensB.all),
      ];
      const before = watch.take();
      const answer = await send(actor, wireOf(probe, pathFor(probe.template, ids), probe.body));
      await settle();
      const verdict = classifyListing({
        expected,
        observed: {
          ...answer.snapshot,
          letIn: answer.letIn,
          stateChanged: watch.changedSince(before),
        },
        forbidden,
      });
      if (probe.template === "/api/matters" && answer.snapshot.status === 200) {
        if (member.first && containsAny(answer.snapshot.body, [tokens.title]))
          entitledLists.own = true;
        if (member.second && containsAny(answer.snapshot.body, [tokensB.title]))
          entitledLists.second = true;
      }
      result.listCells += 1;
      record(verdict, { probe: probeName(probe), actor }, expected.kind === "let_in");
    }
  }

  // --- the controls ----------------------------------------------------------------------------

  // The data check of the forged ids has to be able to see the second matter's title and ids, where its member reads them.
  for (const path of [
    `/api/matters/${createdB.matterId}`,
    `/api/matters/${createdB.matterId}/runs/${reviewedB.runId}/findings`,
  ]) {
    const body = await (await clients.get("stranger")!.get(path)).text();
    if (containsAny(body, [tokensB.title])) entitledSecond.title = true;
    if (containsAny(body, tokensB.ids)) entitledSecond.ids = true;
  }

  const blind = (Object.keys(entitled) as (keyof typeof entitled)[]).filter(
    (name) => !entitled[name],
  );
  if (blind.length > 0)
    throw new ExposureControlFailure(
      `The authorization probes could not find the matter's ${blind.join(" and ")} in any answer a member is entitled to, ` +
        "so the check for matter data in a refusal could not tell data from nothing. No count can be trusted.",
    );
  const blindSecond = (Object.keys(entitledSecond) as (keyof typeof entitledSecond)[]).filter(
    (name) => !entitledSecond[name],
  );
  if (blindSecond.length > 0)
    throw new ExposureControlFailure(
      `The authorization probes could not find the second matter's ${blindSecond.join(" and ")} in any answer its member reads, ` +
        "so the check for the data of another matter in a forged request could not tell data from nothing. No count can be trusted.",
    );
  if (!entitledLists.own || !entitledLists.second)
    throw new ExposureControlFailure(
      "The authorization probes could not find a matter's title in the list its member reads, " +
        "so the check of the lists could not tell data from nothing. No count can be trusted.",
    );
  const unproven = effectKeys.filter((name) => !shown.has(name));
  if (unproven.length > 0)
    throw new ExposureControlFailure(
      `A body meant to change the store did not change it when a caller who is let in sent it (${unproven.join(", ")}), ` +
        "so a clean check for changes made by a refused caller could not tell a change from nothing. No count can be trusted.",
    );
}

/** Stands in for a matter when the question is only whether a route has a body that changes the store. */
const DUMMY_SCRATCH: Scratch = {
  matterId: "mat_0000000000000000",
  documentId: "doc_0000000000000000",
  versionId: "ver_0000000000000000",
  earlierVersionId: "ver_0000000000000001",
  amendmentId: "doc_0000000000000001",
  invitee: INVITEE,
};

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

/**
 * Every route that can name a matter has a probe. A route made with `defineMatterRoute` must have
 * the probe's action. A route that names a matter and was registered another way (`app.get`,
 * `app.all`) is not guarded by the shared code, so it is let through only if the table probes it
 * under the method and path it was registered with, which makes the matrix send it every caller;
 * any other is the suite's to refuse, because nothing would have sent it a request. A wildcard
 * middleware that hands on (`app.use("/api/matters/*")`) answers nothing itself and is covered by
 * every probe that passes through it. A generic route that would answer a matter's URL
 * (`/:area/:id`) is found by asking the router, as `findMatterUrlsWithoutGuard` does.
 */
function checkCoverage(site: ExposureSite): void {
  const described = describeRoutes(site.app);
  const routes = described.filter((route) => route.kind === "matter");
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
  const registered = new Set(described.map((route) => key(route.method, route.path)));
  const stale = MATTER_PROBES.map((probe) => key(probe.method, probe.template)).filter(
    (name) => !registered.has(name),
  );
  if (stale.length > 0)
    throw new ExposureSuiteUnavailable(
      `The probe table has probes for routes the application does not have: ${stale.join(", ")}.`,
    );
  const staleLists = LIST_PROBES.map((probe) => key(probe.method, probe.template)).filter(
    (name) => !registered.has(name),
  );
  if (staleLists.length > 0)
    throw new ExposureSuiteUnavailable(
      `The list of routes that name no matter has routes the application does not have: ${staleLists.join(", ")}.`,
    );

  const templates = new Set(MATTER_PROBES.map((probe) => probe.template));
  const isMiddleware = (route: { method: string; path: string }): boolean =>
    route.method === "ALL" && route.path.endsWith("*");
  const covered = (route: { method: string; path: string }): boolean =>
    isMiddleware(route) ||
    probes.has(key(route.method, route.path)) ||
    (route.method === "ALL" && templates.has(route.path));
  const strayed = described
    .filter(
      (route) => route.kind === "unmanaged" && isMatterScopedPath(route.path) && !covered(route),
    )
    .map((route) => key(route.method, route.path));
  if (strayed.length > 0)
    throw new ExposureSuiteUnavailable(
      `The application has routes that name a matter, were not made with defineMatterRoute and are not in the probe table: ${strayed.join(", ")}.`,
    );
  const answeredElsewhere = findMatterUrlsWithoutGuard(site.app).filter((entry) => {
    const answered = /answered by (\S+) (\S+)$/.exec(entry);
    return answered === null || !covered({ method: answered[1]!, path: answered[2]! });
  });
  if (answeredElsewhere.length > 0)
    throw new ExposureSuiteUnavailable(
      `A route other than a matter route would answer a URL that names a matter: ${answeredElsewhere.join(", ")}.`,
    );
}
