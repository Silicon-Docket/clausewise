/**
 * The canary scan (docs/parol/05-evaluation.md, "Canary matters"; gate G1).
 *
 * For every case that names a canary matter, the suite builds one store that holds both: the canary
 * matter (Bramblewick for the development split, Saltmarsh for the held-out one), created by its own
 * people, and the case's matter, created by others. It reviews the case through the application's
 * real services with a scripted model that records everything it is sent and everything it answers,
 * has the reviewer decide every finding, exports the memo, and fetches every GET route of the
 * application (the routes that name a matter, as every role that is a member of the case, and the
 * routes that do not, for every caller). Then it scans, in memory, for the canary strings of the
 * other matter and for its span, document, version and matter ids in:
 *
 *   - every prompt, as the model would have received it;
 *   - every model answer;
 *   - every HTTP response body, and the exported memo (the text of its Word package);
 *   - the rows of the case matter in every table that holds matter data (the audit trail and the
 *     run provenance among them) and the services' log.
 *
 * Who reads: the case's associate, reviewer and viewer; the canary matter's associate and reviewer;
 * the global administrator and the legal engineer, who belong to neither matter; and an anonymous
 * client. The application gives a global role no read of a matter it is not a member of (the list
 * of matters is by membership, and the one thing an administrator may do to another's matter is
 * delete it), so the three that belong to neither matter are held to nothing of either: every id
 * and every canary string is forbidden in everything they are sent. A member is held to nothing of
 * the other matter. Nobody belongs to both matters, so these sets need no exception.
 *
 * The scan also runs the other way (the canary matter's own people reading the case matter's routes,
 * and the canary matter's pages and rows being searched for the case's ids), because a leak has two
 * directions. The model is a scripted oracle that answers from the answer key. It is not a language
 * model, and nothing is sent anywhere.
 *
 * Controls, all of which throw `ExposureControlFailure` and none of which is counted: the scanner
 * finds every token it is given (scan.ts); each channel holds the case's own data (canary-controls.ts:
 * prompts hold its clauses, answers parse, every page that loaded has a body and JSON parses, the
 * memo is a Word package holding its names and quotations, the log is not empty); a matter's own
 * rows hold every one of its strings and ids. A GET route of the application that no probe table
 * lists stops the suite (`ExposureSuiteUnavailable`), so the set of routes cannot fall behind the
 * application. An unknown table in the store stops it too.
 *
 * What the scan cannot see, and says so in its sentence: text of the other matter that carries no
 * canary string; an id in a prompt or a model answer (the model is shown clause labels, not ids); the
 * headers of a response and variants of a query; and the canary matter's runs, findings and memos,
 * because the canary matter is never reviewed (it has none).
 *
 * Nothing printed, thrown or returned holds a canary string, a prompt, a model answer or document
 * text. A hit is a kind of artefact, a label (route template or table name), and a token's position.
 */
import type { ObjectGenerator } from "@clausewise/llm";
import { describeRoutes } from "../../../../apps/parol/src/server/matter-route.js";
import { DEMO_USER_IDS } from "../../../../apps/parol/src/store/index.js";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import type { AnswerKeyCase, CanaryKeyMatter, Split } from "../../../../fixtures/parol/types.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import {
  checkAnswers,
  checkBody,
  checkLog,
  checkMemo,
  checkPrompts,
  needlesOf,
  ownPages,
  requireTokensIn,
  type OwnPages,
} from "./canary-controls.js";
import { EXIT_UNTRUSTED, ExposureControlFailure, ExposureSuiteUnavailable } from "./errors.js";
import { fileBytes } from "./files.js";
import { createCaseOracle, createCapturingGenerator, type CapturingGenerator } from "./model.js";
import {
  MATTER_PROBES,
  OTHER_PROBES,
  pathFor,
  probeName,
  type OtherProbe,
  type Probe,
  type ProbeIds,
} from "./probes.js";
import { createCaseMatter, reviewAndExport, type ReviewedMatter } from "./review.js";
import {
  ARTEFACT_KINDS,
  createLedger,
  createScanner,
  runControl,
  type ArtefactKind,
  type Ledger,
  type ScanHit,
  type Scanner,
  type TokenSet,
} from "./scan.js";
import { createExposureSite, type ExposureSite, type SiteClient, type SiteHooks } from "./site.js";

/** What a test may change to show that the scan can fail. The suite itself never does. */
export interface CanaryHooks extends SiteHooks {
  /** Wraps the scripted model (inside the capture): a model that answers with something it must not. */
  model?: (inner: ObjectGenerator, context: LeakContext) => ObjectGenerator;
  /** Wraps the generator the services call (outside the capture): a prompt builder that leaks. */
  beforeCapture?: (inner: ObjectGenerator, context: LeakContext) => ObjectGenerator;
  /** Runs after the review and the export and before anything is scanned: a place to write something into the store. */
  afterReview?: (
    site: ExposureSite,
    context: LeakContext & { caseMatterId: string },
  ) => void | Promise<void>;
  /** Replaces the scanner. */
  scanner?: Scanner;
}

/** The other matter, as a leaky double would see it. Filled in before the first model call. */
export interface ForeignMatter {
  id: string;
  matterId: string;
  documentIds: string[];
  versionIds: string[];
  spans: { id: string; text: string }[];
  strings: string[];
  fact: string;
}

export interface LeakContext {
  caseKey: string;
  foreign: ForeignMatter[];
}

export interface CanaryArgs {
  dataset: Dataset;
  root: string;
  playbook: LoadedPlaybook;
  signal: AbortSignal;
  /** The splits whose cases are scanned. Default: development only. */
  splits?: readonly Split[];
  hooks?: CanaryHooks;
}

export interface CaseScan {
  caseKey: string;
  matters: string[];
  scanned: number;
  byKind: Record<ArtefactKind, number>;
  canaryHits: number;
  foreignIdHits: number;
  factSightings: number;
  hits: ScanHit[];
}

export interface CanaryResult {
  /** Artefacts scanned, over every case. */
  artefactsScanned: number;
  canaryHits: number;
  /** Ids of the other matter (span, document, version, matter) found. */
  foreignSpanIdHits: number;
  /**
   * Artefacts that hold the distinctive fact of the other matter. Reported, and not a count of gate
   * G1: a fact can be a legitimate coincidence, a canary string cannot.
   */
  factSightings: number;
  /** The GET routes of the application that were fetched (the same for every case). */
  routesFetched: number;
  /** Who read, as the roles are named in the sentence. */
  readers: string[];
  cases: CaseScan[];
  byKind: Record<ArtefactKind, number>;
  hits: ScanHit[];
  sentence: string;
}

const CASE_ASSOCIATE = DEMO_USER_IDS.associate;
const CASE_REVIEWER = DEMO_USER_IDS.reviewer;
const CASE_VIEWER = "usr_exposure_case_viewer";
/** Belong to neither matter: a global role of the application, and nobody. */
const GLOBAL_ADMIN = DEMO_USER_IDS.admin;
const GLOBAL_ENGINEER = DEMO_USER_IDS.legalEngineer;

const MISSING_IDS = {
  runId: "run_0000000000000000",
  findingId: "fnd_0000000000000000",
  memoId: "memo_0000000000000000",
};

const GET_PROBES: readonly Probe[] = MATTER_PROBES.filter((probe) => probe.method === "GET");

/** The routes that do not name a matter and that answer a GET. */
const OTHER_GET: readonly OtherProbe[] = OTHER_PROBES.filter((probe) => probe.method === "GET");

/** Public routes that give every caller the same fixed answer: fetched once, by an anonymous client. */
const STATIC_PUBLIC: ReadonlySet<string> = new Set(["/healthz", "/assets/:name"]);

/** Every GET route the probe tables name, by template. */
const KNOWN_GET: ReadonlySet<string> = new Set(
  [...GET_PROBES, ...OTHER_GET].map((probe) => probe.template),
);

export async function runCanaryScan(args: CanaryArgs): Promise<CanaryResult> {
  const splits = args.splits ?? (["dev"] as const);
  const cases = args.dataset.keys.cases.filter(
    (entry) => splits.includes(entry.split) && (entry.canaryMatters?.length ?? 0) > 0,
  );
  if (cases.length === 0)
    throw new ExposureSuiteUnavailable(
      `No case of the selected split (${splits.join(", ")}) names a canary matter. Nothing was scanned.`,
    );

  const scanner = args.hooks?.scanner ?? createScanner();
  const perCase: CaseScan[] = [];
  for (const key of cases) {
    args.signal.throwIfAborted();
    const matters = (key.canaryMatters ?? []).map((id) => {
      const found = args.dataset.keys.canary?.matters.find((matter) => matter.id === id);
      if (found === undefined)
        throw new ExposureSuiteUnavailable(
          `${key.case} names the canary matter ${id}, which the answer key does not hold. Nothing was scanned.`,
        );
      // A held-out matter must never sit in a development run, nor the other way round.
      if (found.split !== key.split)
        throw new EvalError(
          `${key.case} names the canary matter ${id}, which belongs to another split.`,
          EXIT_UNTRUSTED,
        );
      return found;
    });
    perCase.push(await scanCase({ ...args, key, matters, scanner }));
  }

  const byKind = Object.fromEntries(ARTEFACT_KINDS.map((kind) => [kind, 0])) as Record<
    ArtefactKind,
    number
  >;
  for (const entry of perCase)
    for (const kind of ARTEFACT_KINDS) byKind[kind] += entry.byKind[kind];
  const total = (pick: (entry: CaseScan) => number): number =>
    perCase.reduce((sum, entry) => sum + pick(entry), 0);
  const result: CanaryResult = {
    artefactsScanned: total((entry) => entry.scanned),
    canaryHits: total((entry) => entry.canaryHits),
    foreignSpanIdHits: total((entry) => entry.foreignIdHits),
    factSightings: total((entry) => entry.factSightings),
    routesFetched: KNOWN_GET.size,
    readers: [...READERS],
    cases: perCase,
    byKind,
    hits: perCase.flatMap((entry) => entry.hits),
    sentence: "",
  };
  const matterIds = new Set(perCase.flatMap((entry) => entry.matters));
  const strings = (args.dataset.keys.canary?.matters ?? [])
    .filter((matter) => matterIds.has(matter.id))
    .reduce((sum, matter) => sum + matter.strings.length, 0);
  const one = matterIds.size === 1;
  const found = (count: number): string =>
    result.hits.length === 0
      ? ""
      : `; first found: ${result.hits
          .slice(0, count)
          .map(
            (hit) =>
              `${hit.token === "canary" ? "a canary string" : "an id"} in ${hit.kind} (${hit.label})`,
          )
          .join(", ")}`;
  const sentenceWith = (count: number): string =>
    `Canary scan: for ${perCase.length} ${perCase.length === 1 ? "case" : "cases"} ` +
    `(${perCase.map((entry) => entry.caseKey).join(", ")}) a synthetic canary matter ` +
    `(${perCase.flatMap((entry) => entry.matters).join(", ")}) sat in the same store as the case; each case was ` +
    `reviewed through the application with a scripted key oracle that records everything (not a language ` +
    `model; nothing is sent anywhere), decided and exported, and all ${result.routesFetched} GET routes of ` +
    `the application (checked against its own route list) were fetched as the case's associate, reviewer ` +
    `and viewer, ${one ? "the canary matter's" : "each canary matter's"} associate and reviewer, the global ` +
    `administrator, the legal engineer and an anonymous client; ${result.artefactsScanned} artefacts ` +
    `(${byKind.prompt} prompts, ${byKind.model_response} model answers, ${byKind.http_body} response bodies, ` +
    `${byKind.memo} memos, ${byKind.store_rows} tables of stored rows, ${byKind.log} log) were scanned for ` +
    `the ${strings} canary strings of ${one ? "that matter and for its ids" : "those matters and for their ids"}: ` +
    `${result.canaryHits} canary strings and ${result.foreignSpanIdHits} foreign ids found` +
    (result.factSightings > 0
      ? `; the other matter's distinctive fact appeared in ${result.factSightings} artefacts, which is an attempt and is not counted`
      : "") +
    found(count) +
    `. A global role has no read of a matter it is not a member of, so the administrator, the legal ` +
    `engineer and the anonymous client were held to nothing of either matter, and each member to nothing ` +
    `of the other. Before counting, the scanner found every planted string and id in text, markup and a ` +
    `compressed Word file, and each channel held the case's own data (bodies not empty, JSON parsed, the ` +
    `memo a Word package with the case's names and quotations, prompts with its clauses, answers parsed, ` +
    `rows with every id). Not seen: text of the other matter without a canary string, ids in prompts and ` +
    `answers (the model is shown clause labels), response headers, query variants, and runs, findings or ` +
    `memos of the canary matter (it is never reviewed).`;
  // The record keeps a sentence to 2000 characters at most: list fewer hits before it gets that long.
  let listed = 3;
  while (listed > 1 && sentenceWith(listed).length > SENTENCE_BUDGET) listed -= 1;
  result.sentence = sentenceWith(listed);
  return result;
}

// ---------------------------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------------------------

/** The results file holds a sentence of 2000 characters at most (results.ts). */
const SENTENCE_BUDGET = 1900;

/** The readers of a case, as the sentence names them. */
const READERS = [
  "associate",
  "reviewer",
  "viewer",
  "canary associate",
  "canary reviewer",
  "administrator",
  "legal engineer",
  "anonymous",
] as const;

interface CanarySide {
  matter: CanaryKeyMatter;
  associate: string;
  reviewer: string;
  matterId: string;
  documentIds: string[];
  versionIds: string[];
  spanIds: string[];
}

const canaryIds = (side: CanarySide): ProbeIds => ({
  matterId: side.matterId,
  firstDocumentId: side.documentIds[0]!,
  versionId: side.versionIds[0]!,
  ...MISSING_IDS,
});

const idsOf = (side: {
  matterId: string;
  documentIds: string[];
  versionIds: string[];
  spanIds: string[];
}): string[] => [side.matterId, ...side.documentIds, ...side.versionIds, ...side.spanIds];

/**
 * Stops the suite when the application answers a GET at a route that no probe table lists: the
 * scan would never fetch it, and a route that leaks would give zero. A route registered for every
 * method (other than the wildcard middleware) answers a GET too.
 */
function checkRoutes(site: ExposureSite): void {
  const unlisted = describeRoutes(site.app)
    .filter(
      (route) =>
        (route.method === "GET" || (route.method === "ALL" && !route.path.endsWith("*"))) &&
        !KNOWN_GET.has(route.path),
    )
    .map((route) => `${route.method} ${route.path}`);
  if (unlisted.length > 0)
    throw new ExposureSuiteUnavailable(
      `The application answers a GET at routes that no probe table lists, so the canary scan would not fetch them: ${[...new Set(unlisted)].join(", ")}.`,
    );
}

async function scanCase(
  args: CanaryArgs & { key: AnswerKeyCase; matters: CanaryKeyMatter[]; scanner: Scanner },
): Promise<CaseScan> {
  const { key, scanner, signal } = args;
  const hooks = args.hooks ?? {};

  // The case's files, and the canary matters' documents, each checked against its recorded hash.
  const caseFiles = new Map<string, Uint8Array>();
  for (const doc of key.documents)
    caseFiles.set(doc.file, await fileBytes(args.dataset, args.root, doc.file, doc.sha256));
  const filesOf = (name: string): Uint8Array => {
    const found = caseFiles.get(name);
    if (found === undefined) throw new EvalError(`${key.case}: a case file was not loaded.`);
    return found;
  };
  const canaryBytes = new Map<string, Uint8Array>();
  for (const matter of args.matters)
    canaryBytes.set(
      matter.document.file,
      await fileBytes(args.dataset, args.root, matter.document.file, matter.document.sha256),
    );

  // The model: the key oracle, optionally doubled by a test, recorded, optionally wrapped again.
  const context: LeakContext = { caseKey: key.case, foreign: [] };
  const oracle = await createCaseOracle({ key, files: filesOf, playbook: args.playbook });
  const model: ObjectGenerator = hooks.model === undefined ? oracle : hooks.model(oracle, context);
  const capture: CapturingGenerator = createCapturingGenerator(model);
  const front: ObjectGenerator =
    hooks.beforeCapture === undefined ? capture : hooks.beforeCapture(capture, context);

  const siteHooks: SiteHooks = {
    ...(hooks.beforeRoutes === undefined ? {} : { beforeRoutes: hooks.beforeRoutes }),
    ...(hooks.wrapMemoBuilder === undefined ? {} : { wrapMemoBuilder: hooks.wrapMemoBuilder }),
  };
  const site = createExposureSite({ playbook: args.playbook, generator: front, hooks: siteHooks });
  try {
    await site.preflight();
    // Every GET route of the application is one the scan fetches.
    checkRoutes(site);
    site.addUser(CASE_VIEWER, "Synthetic case viewer");

    // 1. The canary matters, made by their own people.
    const sides: CanarySide[] = [];
    for (const matter of args.matters) {
      const associate = `usr_exposure_${matter.id}_associate`;
      const reviewer = `usr_exposure_${matter.id}_reviewer`;
      site.addUser(associate, `Synthetic ${matter.name} associate`);
      site.addUser(reviewer, `Synthetic ${matter.name} reviewer`);
      const summary = site.services.matters.create(site.principal(associate), {
        name: `Canary matter ${matter.id} (synthetic)`,
        clientLegalName: matter.clientLegalName,
        playbookVersionId: site.playbookVersionId,
        reviewerUserId: reviewer,
      });
      const am = site.authorize(associate, summary.id, "document.write");
      const stored = await site.services.matters.addDocument(am, {
        title: matter.document.title,
        kind: matter.document.kind,
        fileName: matter.document.file,
        bytes: canaryBytes.get(matter.document.file)!,
        statedDate: matter.document.statedDate,
      });
      const versionIds = [stored.versionId];
      const spans = site.repo.listSpans(summary.id, versionIds);
      if (spans.length === 0 || matter.strings.length === 0)
        throw new ExposureControlFailure(
          `The canary matter ${matter.id} has no spans or no canary strings, so a scan for them could not see a leak.`,
        );
      sides.push({
        matter,
        associate,
        reviewer,
        matterId: summary.id,
        documentIds: [stored.documentId],
        versionIds,
        spanIds: spans.map((span) => span.id),
      });
      context.foreign.push({
        id: matter.id,
        matterId: summary.id,
        documentIds: [stored.documentId],
        versionIds,
        spans: spans.map((span) => ({ id: span.id, text: span.text })),
        strings: [...matter.strings],
        fact: matter.fact,
      });
    }

    // 2. The case's matter, reviewed, decided and exported by others.
    const people = { associate: CASE_ASSOCIATE, reviewer: CASE_REVIEWER, viewer: CASE_VIEWER };
    const matterName = `${key.case} review (exposure scan)`;
    const created = await createCaseMatter({
      site,
      key,
      files: filesOf,
      people,
      matterName,
    });
    signal.throwIfAborted();
    const reviewed = await reviewAndExport({ site, key, people, matterId: created.matterId });
    const caseSpans = site.repo.listSpans(created.matterId, created.versionIds);
    const caseSide = {
      matterId: created.matterId,
      documentIds: created.documentIds,
      versionIds: created.versionIds,
      spanIds: caseSpans.map((span) => span.id),
    };
    await hooks.afterReview?.(site, { ...context, caseMatterId: created.matterId });
    if (capture.captured.requests.length === 0 || capture.captured.responses.length === 0)
      throw new EvalError(
        `${key.case}: the review sent nothing to the scripted model, so there is nothing to scan.`,
      );
    if (caseSide.spanIds.length === 0)
      throw new ExposureControlFailure(
        `${key.case}: the case matter has no spans, so a scan for its ids could not see a leak.`,
      );

    // 3. What may not appear where. The case side must hold nothing of the canary matters; the canary
    //    side nothing of the case. A page that answers for a matter its reader has no part in must
    //    hold nothing of either. The matter id is in the URL of a request for it, so a refusal that
    //    repeats it says nothing new, and it is left out of the set for that request.
    const canaryStrings = sides.flatMap((side) => [...side.matter.strings]);
    const canaryAllIds = sides.flatMap(idsOf);
    const caseAllIds = idsOf(caseSide);
    const foreignToCase: TokenSet = { canary: canaryStrings, ids: canaryAllIds };
    const canaryIdsExcept = (side: CanarySide): string[] =>
      canaryAllIds.filter((id) => id !== side.matterId);
    const readingCanaryRoutes = (side: CanarySide): TokenSet => ({
      canary: canaryStrings,
      ids: canaryIdsExcept(side),
    });
    const canaryUserOnCaseRoutes = (side: CanarySide): TokenSet => ({
      canary: canaryStrings,
      ids: [...canaryIdsExcept(side), ...caseAllIds.filter((id) => id !== caseSide.matterId)],
    });
    const caseIdsForCanarySide: TokenSet = { canary: [], ids: caseAllIds };
    // Nobody who belongs to neither matter may see anything of either.
    const nobodyOnLists: TokenSet = {
      canary: canaryStrings,
      ids: [...caseAllIds, ...canaryAllIds],
    };
    const nobodyOnCaseRoutes: TokenSet = {
      canary: canaryStrings,
      ids: [...caseAllIds.filter((id) => id !== caseSide.matterId), ...canaryAllIds],
    };
    const nobodyOnCanaryRoutes = (side: CanarySide): TokenSet => ({
      canary: canaryStrings,
      ids: [...caseAllIds, ...canaryIdsExcept(side)],
    });
    const facts = sides.map((side) => side.matter.fact);

    // 4. The scanner proves itself before anything is counted.
    await runControl(scanner, foreignToCase);
    // And the tokens have to be the matters' real data: a matter's own rows hold every one of its
    // strings and its ids, one by one, or a scan for them could not have seen a leak.
    for (const side of sides)
      await requireTokensIn({
        scanner,
        what: `The rows of the canary matter ${side.matter.id}`,
        content: storeRows(site, side.matterId)
          .map((table) => table.content)
          .join("\n"),
        tokens: { canary: [...side.matter.strings], ids: idsOf(side) },
      });
    await requireTokensIn({
      scanner,
      what: `The rows of the case matter of ${key.case}`,
      content: storeRows(site, created.matterId)
        .map((table) => table.content)
        .join("\n"),
      tokens: caseIdsForCanarySide,
    });

    // The channels hold the case's own data: its clauses in every prompt, answers that parse, a log.
    const clauseNeedles = needlesOf(caseSpans.map((span) => span.text));
    checkPrompts({
      caseKey: key.case,
      requests: capture.captured.requests,
      needles: clauseNeedles,
      ruleKeys: args.playbook.rules.map((rule) => rule.key),
    });
    checkAnswers({
      caseKey: key.case,
      requests: capture.captured.requests.length,
      responses: capture.captured.responses,
      failures: capture.captured.failures,
    });
    checkLog(key.case, site.serviceLog);
    const names = [matterName, key.intake.clientLegalName];
    const ledger = createLedger(scanner);

    // 5. Prompts and model answers, as the model boundary saw them.
    for (const [index, request] of capture.captured.requests.entries())
      await ledger.add(
        {
          kind: "prompt",
          label: `${request.schemaName ?? "request"} ${index + 1}`,
          content: request.text,
          forbid: foreignToCase,
        },
        facts,
      );
    for (const [index, response] of capture.captured.responses.entries())
      await ledger.add(
        {
          kind: "model_response",
          label: `answer ${index + 1}`,
          content: response,
          forbid: foreignToCase,
        },
        facts,
      );

    // 6. HTTP: every GET route, as everyone who reads.
    const caseIds = (findingId: string): ProbeIds => ({
      matterId: created.matterId,
      firstDocumentId: created.documentIds[0]!,
      versionId: created.versionIds[created.versionIds.length - 1]!,
      runId: reviewed.runId,
      findingId,
      memoId: reviewed.memoId,
    });
    const caseTargets = readTargets(reviewed, caseIds);
    const noFinding = { ...reviewed, findingIds: [MISSING_IDS.findingId] };
    const canaryTargets = (side: CanarySide) => readTargets(noFinding, () => canaryIds(side));
    /** The routes that do not name a matter, for a reader who is not the static page's anonymous client. */
    const otherRoutes = (): { template: string; path: string; public: boolean }[] =>
      OTHER_GET.filter((probe) => !STATIC_PUBLIC.has(probe.template)).map((probe) => ({
        template: probe.template,
        path: pathFor(probe.template, caseIds(reviewed.findingIds[0]!)),
        public: probe.access === "public",
      }));
    /**
     * One read. `load`: the reader must be let in, so anything but 200 stops the suite. `shape`: the
     * body of such a read must also hold something and, for JSON, parse (the case's own readers and
     * the strangers are the reference channel for this; the canary matter's readers are checked for
     * status only, because their channel is the same fetch). `own`: collects what the pages hold.
     */
    const read = (
      client: SiteClient,
      label: string,
      path: string,
      forbid: TokenSet,
      how: { load?: boolean; shape?: boolean; facts?: boolean; own?: OwnPages } = {},
    ) =>
      fetchAndAdd({
        client,
        ledger,
        label,
        path,
        forbid,
        facts: how.facts === false ? [] : facts,
        mustLoad: how.load === true,
        shape: how.shape ?? how.load === true,
        ...(how.own === undefined ? {} : { own: how.own }),
      });

    for (const [role, user] of [
      ["associate", CASE_ASSOCIATE],
      ["reviewer", CASE_REVIEWER],
      ["viewer", CASE_VIEWER],
    ] as const) {
      const client = await site.signIn(user);
      const own = ownPages({ caseKey: key.case, names, needles: clauseNeedles });
      for (const target of caseTargets)
        await read(client, `${role} ${target.label}`, target.path, foreignToCase, {
          load: true,
          own,
        });
      for (const route of otherRoutes())
        await read(client, `${role} GET ${route.template}`, route.path, foreignToCase, {
          load: true,
        });
      own.require(`the case's ${role}`);
      // The case's people reading the canary matters' routes: no part in them, nothing to see.
      for (const side of sides)
        for (const target of canaryTargets(side))
          await read(
            client,
            `${role} on canary ${side.matter.id} ${target.label}`,
            target.path,
            readingCanaryRoutes(side),
          );
    }

    // 7. HTTP: the people who belong to a canary matter only, reading the case matter's routes and
    //    their own pages.
    for (const side of sides) {
      for (const [who, user] of [
        ["associate", side.associate],
        ["reviewer", side.reviewer],
      ] as const) {
        const client = await site.signIn(user);
        for (const target of caseTargets)
          await read(
            client,
            `${side.matter.id} ${who} on case ${target.label}`,
            target.path,
            canaryUserOnCaseRoutes(side),
          );
        for (const target of canaryTargets(side))
          await read(
            client,
            `${side.matter.id} ${who} ${target.label}`,
            target.path,
            caseIdsForCanarySide,
            { facts: false },
          );
        for (const route of otherRoutes())
          await read(
            client,
            `${side.matter.id} ${who} GET ${route.template}`,
            route.path,
            caseIdsForCanarySide,
            { load: true, shape: false, facts: false },
          );
      }
    }

    // 8. HTTP: the people who belong to neither matter. They are let into no matter, so nothing of
    //    either may reach them, on the lists, on the routes of the case and on the routes of the canary
    //    matters. The static pages that no caller can tell apart are fetched once, anonymously.
    const strangers = [
      ["administrator", await site.signIn(GLOBAL_ADMIN)],
      ["legal engineer", await site.signIn(GLOBAL_ENGINEER)],
      ["anonymous", site.anonymous()],
    ] as const;
    for (const [who, client] of strangers) {
      const signedIn = who !== "anonymous";
      for (const route of otherRoutes())
        await read(client, `${who} GET ${route.template}`, route.path, nobodyOnLists, {
          load: signedIn || route.public,
        });
      for (const target of caseTargets)
        await read(client, `${who} on case ${target.label}`, target.path, nobodyOnCaseRoutes);
      for (const side of sides)
        for (const target of canaryTargets(side))
          await read(
            client,
            `${who} on canary ${side.matter.id} ${target.label}`,
            target.path,
            nobodyOnCanaryRoutes(side),
          );
    }
    const anonymous = site.anonymous();
    for (const probe of OTHER_GET.filter((other) => STATIC_PUBLIC.has(other.template)))
      await read(
        anonymous,
        `anonymous GET ${probe.template}`,
        pathFor(probe.template, caseIds(reviewed.findingIds[0]!)),
        nobodyOnLists,
        { load: true },
      );

    // 9. The exported memo, as the application stores it.
    const memo = await site.services.reviews.memoFile(
      site.authorize(CASE_REVIEWER, created.matterId, "memo.read"),
      reviewed.memoId,
    );
    await checkMemo({
      caseKey: key.case,
      bytes: memo.bytes,
      names,
      quotes: Object.values(key.expect).flatMap((rule) =>
        rule.governing.map((anchor) => anchor.anchor),
      ),
    });
    await ledger.add(
      { kind: "memo", label: "memo", content: memo.bytes, forbid: foreignToCase },
      facts,
    );

    // 10. The rows and the log.
    for (const table of storeRows(site, created.matterId))
      await ledger.add(
        {
          kind: "store_rows",
          label: `case ${table.label}`,
          content: table.content,
          forbid: foreignToCase,
        },
        facts,
      );
    for (const side of sides) {
      for (const table of storeRows(site, side.matterId))
        await ledger.add({
          kind: "store_rows",
          label: `${side.matter.id} ${table.label}`,
          content: table.content,
          forbid: caseIdsForCanarySide,
        });
    }
    await ledger.add(
      {
        kind: "log",
        label: "service log",
        content: site.serviceLog.join("\n"),
        forbid: foreignToCase,
      },
      facts,
    );

    return {
      caseKey: key.case,
      matters: sides.map((side) => side.matter.id),
      scanned: ledger.scanned,
      byKind: { ...ledger.byKind },
      canaryHits: ledger.canaryHits,
      foreignIdHits: ledger.idHits,
      factSightings: ledger.factSightings,
      hits: [...ledger.hits],
    };
  } finally {
    site.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * The reads a member can make: every GET route that names a matter, with each finding id for the
 * routes that take one. A route template is the label; a path is what is sent.
 */
function readTargets(
  reviewed: Pick<ReviewedMatter, "findingIds">,
  idsFor: (findingId: string) => ProbeIds,
): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  for (const probe of GET_PROBES) {
    const perFinding = probe.template.includes(":findingId");
    const findingIds = perFinding ? reviewed.findingIds : [reviewed.findingIds[0]!];
    for (const findingId of findingIds)
      out.push({
        label: probeName(probe),
        path: pathFor(probe.template, idsFor(findingId)),
      });
  }
  return out;
}

async function fetchAndAdd(args: {
  client: SiteClient;
  ledger: Ledger;
  label: string;
  path: string;
  forbid: TokenSet;
  facts: readonly string[];
  /**
   * A page that this reader must be able to read: anything but 200 would make the scan empty, and
   * a body that is empty, or a JSON body that does not parse, would make it empty too.
   */
  mustLoad: boolean;
  /** Also require that the body of a page that loaded is not empty and that JSON parses. */
  shape: boolean;
  /** Collects what the member's own pages hold, for the real-data control. */
  own?: OwnPages;
}): Promise<void> {
  const response = await args.client.get(args.path);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (args.mustLoad && response.status !== 200)
    throw new EvalError(
      `A page that a reader should be able to read did not load (${args.label}, status ${response.status}), so the scan would be empty.`,
    );
  const found = args.ledger.canaryHits + args.ledger.idHits;
  await args.ledger.add(
    { kind: "http_body", label: args.label, content: bytes, forbid: args.forbid },
    args.facts,
  );
  if (!args.mustLoad) return;
  args.own?.note(routeOf(args.label), Buffer.from(bytes).toString("utf8"));
  // A body that holds something forbidden is a count, whatever else is wrong with it. One that holds
  // nothing forbidden must not be an empty or a damaged body, or its zero would mean nothing.
  if (args.shape && args.ledger.canaryHits + args.ledger.idHits === found)
    checkBody({
      label: args.label,
      contentType: response.headers.get("content-type") ?? "",
      bytes,
    });
}

/** The route template at the end of a label such as `associate GET /matters/:matterId`. */
const routeOf = (label: string): string => /(GET \S+)$/.exec(label)?.[1] ?? label;

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

const RUN_OF_MATTER = "run_id IN (SELECT id FROM runs WHERE matter_id = ?)";
const FINDING_OF_MATTER = "finding_id IN (SELECT id FROM findings WHERE matter_id = ?)";

/** Every table that holds matter data, and how its rows are tied to the matter. */
export const STORE_SCOPES: readonly (readonly [table: string, where: string])[] = [
  ["matters", "id = ?"],
  ["matter_members", "matter_id = ?"],
  ["documents", "matter_id = ?"],
  ["document_versions", "matter_id = ?"],
  ["source_spans", "matter_id = ?"],
  ["span_annotations", "span_id IN (SELECT id FROM source_spans WHERE matter_id = ?)"],
  ["ingest_warnings", "matter_id = ?"],
  ["runs", "matter_id = ?"],
  ["run_stages", RUN_OF_MATTER],
  ["model_calls", RUN_OF_MATTER],
  ["eval_slot_results", RUN_OF_MATTER],
  ["findings", "matter_id = ?"],
  ["finding_evidence", FINDING_OF_MATTER],
  ["verification_results", FINDING_OF_MATTER],
  ["reviews", "matter_id = ?"],
  ["memos", "matter_id = ?"],
  ["feedback", "matter_id = ?"],
  ["audit_events", "matter_id = ? OR matter_id IS NULL"],
];

/**
 * The tables that hold no matter data: the users, the playbook, prompt and workflow versions that
 * every matter shares, the evaluation's own datasets and runs, and the migration log. A table that
 * is in neither list is an error, whatever its columns: a table keyed by a finding or a span, or by
 * nothing at all (a shared cache, a search index), would otherwise go unscanned.
 */
export const NO_MATTER_DATA: readonly string[] = [
  "users",
  "playbook_versions",
  "playbook_rules",
  "prompt_versions",
  "workflow_versions",
  "eval_datasets",
  "eval_runs",
  "schema_migrations",
];

/**
 * The rows of a matter, one artefact per table, as JSON text. A table that is neither read here nor
 * listed as holding no matter data is an error, and so is a listed table that has a `matter_id` or
 * `run_id` column.
 */
export function storeRows(
  site: ExposureSite,
  matterId: string,
): { label: string; content: string }[] {
  const db = site.repo.db;
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const read = new Set(STORE_SCOPES.map(([table]) => table));
  const noData = new Set(NO_MATTER_DATA);
  for (const name of tables) {
    if (read.has(name) || name.startsWith("sqlite_")) continue;
    if (!noData.has(name))
      throw new ExposureSuiteUnavailable(
        `The store has a table (${name}) that the exposure scan neither reads nor lists as holding no matter data.`,
      );
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    if (columns.some((column) => column.name === "matter_id" || column.name === "run_id"))
      throw new ExposureSuiteUnavailable(
        `The store has a table (${name}) listed as holding no matter data that has a matter or run column.`,
      );
  }
  return STORE_SCOPES.map(([table, where]) => {
    if (!tables.includes(table))
      throw new EvalError(`The store has no table ${table}, which the exposure scan reads.`);
    const params = (where.match(/\?/g) ?? []).map(() => matterId);
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params);
    return {
      label: table,
      content: JSON.stringify(rows, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    };
  });
}
