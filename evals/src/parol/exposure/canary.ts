/**
 * The canary scan (docs/parol/05-evaluation.md, "Canary matters"; gate G1).
 *
 * For every case that names a canary matter, the suite builds one store that holds both: the canary
 * matter (Bramblewick for the development split, Saltmarsh for the held-out one), created by its own
 * people, and the case's matter, created by others. It reviews the case through the application's
 * real services with a scripted model that records everything it is sent and everything it answers,
 * has the reviewer decide every finding, exports the memo, and fetches every page and JSON route a
 * member can fetch for the case matter as each role, and the same as a person who belongs to the
 * canary matter only. Then it scans, in memory, for the canary strings of the other matter and for
 * its span, document, version and matter ids in:
 *
 *   - every prompt, as the model would have received it;
 *   - every model answer;
 *   - every HTTP response body, and the exported memo (the text of its Word package);
 *   - the rows of the case matter in every table that holds matter data (the audit trail and the
 *     run provenance among them) and the services' log.
 *
 * The scan also runs the other way (the canary matter's own people reading the case matter's routes,
 * and the canary matter's pages and rows being searched for the case's ids), because a leak has two
 * directions. The model is a scripted oracle that answers from the answer key. It is not a language
 * model, and nothing is sent anywhere.
 *
 * Nothing printed, thrown or returned holds a canary string, a prompt, a model answer or document
 * text. A hit is a kind of artefact, a label (route template or table name), and a token's position.
 */
import type { ObjectGenerator } from "@clausewise/llm";
import { DEMO_USER_IDS } from "../../../../apps/parol/src/store/index.js";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import type { AnswerKeyCase, CanaryKeyMatter, Split } from "../../../../fixtures/parol/types.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import { EXIT_UNTRUSTED, ExposureControlFailure, ExposureSuiteUnavailable } from "./errors.js";
import { fileBytes } from "./files.js";
import { createCaseOracle, createCapturingGenerator, type CapturingGenerator } from "./model.js";
import { MATTER_PROBES, pathFor, probeName, type Probe, type ProbeIds } from "./probes.js";
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
  factSightings: number;
  cases: CaseScan[];
  byKind: Record<ArtefactKind, number>;
  hits: ScanHit[];
  sentence: string;
}

const CASE_ASSOCIATE = DEMO_USER_IDS.associate;
const CASE_REVIEWER = DEMO_USER_IDS.reviewer;
const CASE_VIEWER = "usr_exposure_case_viewer";

const MISSING_IDS = {
  runId: "run_0000000000000000",
  findingId: "fnd_0000000000000000",
  memoId: "memo_0000000000000000",
};

const GET_PROBES: readonly Probe[] = MATTER_PROBES.filter((probe) => probe.method === "GET");

/** The routes that are not about one matter and that list or describe what a person can see. */
const LIST_PATHS = ["/", "/matters", "/api/matters", "/api/playbooks"] as const;

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
    cases: perCase,
    byKind,
    hits: perCase.flatMap((entry) => entry.hits),
    sentence: "",
  };
  const matterIds = new Set(perCase.flatMap((entry) => entry.matters));
  const strings = (args.dataset.keys.canary?.matters ?? [])
    .filter((matter) => matterIds.has(matter.id))
    .reduce((sum, matter) => sum + matter.strings.length, 0);
  result.sentence =
    `Canary scan: for ${perCase.length} ${perCase.length === 1 ? "case" : "cases"} ` +
    `(${perCase.map((entry) => entry.caseKey).join(", ")}) a synthetic canary matter ` +
    `(${perCase.flatMap((entry) => entry.matters).join(", ")}) sat in the same store as the case; each case was ` +
    `reviewed through the application with a scripted model that records everything, decided, exported and ` +
    `read as every role, and ${result.artefactsScanned} artefacts (${byKind.prompt} prompts, ` +
    `${byKind.model_response} model answers, ${byKind.http_body} response bodies, ${byKind.memo} memos, ` +
    `${byKind.store_rows} tables of stored rows, ${byKind.log} log) were scanned for the ${strings} canary strings ` +
    `of ${matterIds.size === 1 ? "that matter and for its ids" : "those matters and for their ids"}: ` +
    `${result.canaryHits} canary strings and ${result.foreignSpanIdHits} foreign ids found` +
    (result.factSightings > 0
      ? `; the other matter's distinctive fact appeared in ${result.factSightings} artefacts, which is an attempt and is not counted`
      : "") +
    (result.hits.length > 0
      ? `; first found: ${result.hits
          .slice(0, 3)
          .map(
            (hit) =>
              `${hit.token === "canary" ? "a canary string" : "an id"} in ${hit.kind} (${hit.label})`,
          )
          .join(", ")}.`
      : ".");
  return result;
}

// ---------------------------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------------------------

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
    const created = await createCaseMatter({
      site,
      key,
      files: filesOf,
      people,
      matterName: `${key.case} review (exposure scan)`,
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

    // 3. What may not appear where. The case side must hold nothing of the canary matters; the canary
    //    side nothing of the case. A page that answers for a matter its reader has no part in must
    //    hold nothing of either. The matter id is in the URL of a request for it, so a refusal that
    //    repeats it says nothing new, and it is left out of the set for that request.
    const canaryStrings = sides.flatMap((side) => [...side.matter.strings]);
    const foreignToCase: TokenSet = { canary: canaryStrings, ids: sides.flatMap(idsOf) };
    const canaryIdsExcept = (side: CanarySide): string[] =>
      sides.flatMap(idsOf).filter((id) => id !== side.matterId);
    const readingCanaryRoutes = (side: CanarySide): TokenSet => ({
      canary: canaryStrings,
      ids: canaryIdsExcept(side),
    });
    const canaryUserOnCaseRoutes = (side: CanarySide): TokenSet => ({
      canary: canaryStrings,
      ids: [
        ...canaryIdsExcept(side),
        ...caseSide.documentIds,
        ...caseSide.versionIds,
        ...caseSide.spanIds,
      ],
    });
    const caseIdsForCanarySide: TokenSet = {
      canary: [],
      ids: [
        caseSide.matterId,
        ...caseSide.documentIds,
        ...caseSide.versionIds,
        ...caseSide.spanIds,
      ],
    };
    const facts = sides.map((side) => side.matter.fact);

    // 4. The scanner proves itself before anything is counted.
    await runControl(scanner, foreignToCase);
    // And the tokens have to be the matters' real data: a matter's own rows hold every one of its
    // strings and its ids, or a scan for them could not have seen a leak.
    for (const side of sides) {
      const rows = storeRows(site, side.matterId)
        .map((table) => table.content)
        .join("\n");
      const own: TokenSet = { canary: [...side.matter.strings], ids: idsOf(side) };
      const found = await scanner.scan({
        kind: "store_rows",
        label: "own rows",
        content: rows,
        forbid: own,
      });
      if (
        found.filter((hit) => hit.token === "canary").length !== side.matter.strings.length ||
        !found.some((hit) => hit.token === "id")
      )
        throw new ExposureControlFailure(
          `The rows of the canary matter ${side.matter.id} do not hold all of its canary strings and its ids, so a scan for them could not see a leak. No count can be trusted.`,
        );
    }
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

    // 6. HTTP: every page and JSON route a member can fetch, as every role.
    const caseIds = (findingId: string): ProbeIds => ({
      matterId: created.matterId,
      firstDocumentId: created.documentIds[0]!,
      versionId: created.versionIds[created.versionIds.length - 1]!,
      runId: reviewed.runId,
      findingId,
      memoId: reviewed.memoId,
    });
    for (const [role, user] of [
      ["associate", CASE_ASSOCIATE],
      ["reviewer", CASE_REVIEWER],
      ["viewer", CASE_VIEWER],
    ] as const) {
      const client = await site.signIn(user);
      for (const target of readTargets(reviewed, caseIds))
        await fetchAndAdd({
          client,
          ledger,
          label: `${role} ${target.label}`,
          path: target.path,
          forbid: foreignToCase,
          facts,
          mustLoad: true,
        });
      for (const path of LIST_PATHS)
        await fetchAndAdd({
          client,
          ledger,
          label: `${role} ${path}`,
          path,
          forbid: foreignToCase,
          facts,
          mustLoad: true,
        });
      // The case's people reading the canary matters' routes: no part in them, nothing to see.
      for (const side of sides) {
        for (const target of readTargets({ ...reviewed, findingIds: [MISSING_IDS.findingId] }, () =>
          canaryIds(side),
        ))
          await fetchAndAdd({
            client,
            ledger,
            label: `${role} on canary ${side.matter.id} ${target.label}`,
            path: target.path,
            forbid: readingCanaryRoutes(side),
            facts,
            mustLoad: false,
          });
      }
    }

    // 7. HTTP: the people who belong to a canary matter only, reading the case matter's routes and
    //    their own pages.
    for (const side of sides) {
      const client = await site.signIn(side.associate);
      for (const target of readTargets(reviewed, caseIds))
        await fetchAndAdd({
          client,
          ledger,
          label: `${side.matter.id} associate on case ${target.label}`,
          path: target.path,
          forbid: canaryUserOnCaseRoutes(side),
          facts,
          mustLoad: false,
        });
      for (const target of readTargets({ ...reviewed, findingIds: [MISSING_IDS.findingId] }, () =>
        canaryIds(side),
      ))
        await fetchAndAdd({
          client,
          ledger,
          label: `${side.matter.id} associate ${target.label}`,
          path: target.path,
          forbid: caseIdsForCanarySide,
          facts: [],
          mustLoad: false,
        });
      for (const path of LIST_PATHS)
        await fetchAndAdd({
          client,
          ledger,
          label: `${side.matter.id} associate ${path}`,
          path,
          forbid: caseIdsForCanarySide,
          facts: [],
          mustLoad: false,
        });
    }

    // 8. The exported memo, as the application stores it.
    const memo = await site.services.reviews.memoFile(
      site.authorize(CASE_REVIEWER, created.matterId, "memo.read"),
      reviewed.memoId,
    );
    await ledger.add(
      { kind: "memo", label: "memo", content: memo.bytes, forbid: foreignToCase },
      facts,
    );

    // 9. The rows and the log.
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
  /** A member reading a page of their own matter: anything but 200 would make the scan empty. */
  mustLoad: boolean;
}): Promise<void> {
  const response = await args.client.get(args.path);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (args.mustLoad && response.status !== 200)
    throw new EvalError(
      `A page that a member of the case matter should be able to read did not load (${args.label}, status ${response.status}), so the scan would be empty.`,
    );
  await args.ledger.add(
    { kind: "http_body", label: args.label, content: bytes, forbid: args.forbid },
    args.facts,
  );
}

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
 * The rows of a matter, one artefact per table, as JSON text. A table with a `matter_id` column
 * that this list does not know is an error: a new table would otherwise go unscanned.
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
  const known = new Set(STORE_SCOPES.map(([table]) => table));
  for (const name of tables) {
    if (known.has(name) || name.startsWith("sqlite_")) continue;
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    if (columns.some((column) => column.name === "matter_id" || column.name === "run_id"))
      throw new EvalError(
        `The store has a table with matter data (${name}) that the exposure scan does not read.`,
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
