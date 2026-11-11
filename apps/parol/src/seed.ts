import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ObjectGenerator } from "@clausewise/llm";
import { authorizeMatter } from "./auth/authorize.js";
import type { Principal } from "./auth/types.js";
import { registerAll, WORKFLOW_LABELS } from "./boot/register.js";
import {
  DEMO_MATTERS,
  FIXTURE_FILES,
  textFileBytes,
  type DemoDocument,
  type DemoMatter,
} from "./demo/matters.js";
import {
  PILOT_DEMO_NOTICE,
  PilotDemoError,
  createSteppingClock,
  seedPilotDemo,
  type PilotDemoDocument,
  type PilotDemoReport,
} from "./demo/pilot-demo.js";
import { createSimulatedModel } from "./demo/simulated-model.js";
import { ConfigError, parseEnv, type ParolSettings } from "./main.js";
import { createServices } from "./services/index.js";
import { RunNotReadyError } from "./services/errors.js";
import { T01, startTraining } from "./training/index.js";
import type { RunSummary } from "./services/views.js";
import { urls } from "./server/urls.js";
import {
  ConflictError,
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  openDatabase,
  type Database,
  type Repository,
} from "./store/index.js";

/**
 * The demonstration data. `pnpm parol:seed` opens the data folder the way the server does, puts in
 * it what a run depends on (prompts, workflow versions, the approved playbook, the demo users), and
 * creates two matters through the services, as a person using the screens would:
 *
 *  - "Lanternfish / Corvane NDA": the worked example of docs/parol/04, a Word NDA and Amendment
 *    No. 1, owned by the demo associate with the demo reviewing attorney on it, ready to run and
 *    not yet run.
 *  - "Heronbridge / Tamarind NDA": another short NDA owned by someone else, so that signing in as
 *    two people shows that neither sees the other's matter.
 *
 * With `--training` it also makes the training matter T01 for the demo associate, with the demo
 * reviewing attorney on it and the demo legal engineer as its trainer (training/start.ts). It is off
 * by default: the two matters above are what the README's walk-through starts from, and the
 * quickstart page has a button that makes T01 for whoever is signed in.
 *
 * With `--pilot-demo` it also builds a backdated scenario for the pilot measures page, through the
 * services, with the demo identities on synthetic matters (demo/pilot-demo.ts). It is off by
 * default and belongs on a fresh data folder: it dates its rows weeks back, and the pilot page's
 * synthetic scope then has a value in every row it can, while its pilot scope stays empty.
 *
 * Running it again changes nothing: a matter is recognised by its name and its owner, and only
 * what is missing is added. It refuses to run unless the demo identity is on, because the data is
 * only meant to be looked at through it.
 *
 * Everything is synthetic. The summary it prints names matters, people and ids, never a passage of
 * a document.
 */

/** The seed cannot go on. The message is for the person running it and names no input. */
export class SeedError extends Error {
  override name = "SeedError";
}

export interface SeedOptions {
  repo: Repository;
  files: FileStore;
  /** Only used if a run is asked for. Default: the simulated reader. */
  generator?: ObjectGenerator;
  now?: () => Date;
  /** Workflow versions to run on the first matter, in order. Default: none. */
  runs?: readonly string[];
  /** The folder of the committed dataset files. Default: the repository's own. */
  fixturesDir?: string;
  /** Also make the training matter T01 (see above). Default: no. */
  training?: boolean;
  /** The folder of T01's committed files. Default: `apps/parol/training`. */
  trainingDir?: string;
}

export interface SeededMatter {
  key: DemoMatter["key"];
  matterId: string;
  name: string;
  /** False when the matter was already there. */
  created: boolean;
  /** Documents uploaded by this call. */
  documentsAdded: number;
  ownerName: string;
  reviewerName: string | null;
}

export interface SeededTraining {
  matterId: string;
  name: string;
  /** False when the matter was already there. */
  created: boolean;
  /** Documents uploaded by this call. */
  documentsAdded: number;
  ownerName: string;
  reviewerName: string;
  trainerName: string;
}

export interface SeededRun {
  workflowLabel: string;
  matterId: string;
  runId: string;
  /** False when a run of that workflow was already there. */
  started: boolean;
  status: RunSummary["status"];
  findingCount: number;
  errorKind: string | null;
}

export interface SeedReport {
  playbook: { slug: string; version: string };
  matters: SeededMatter[];
  /** The training matter, when it was asked for, and null when it was not. */
  training: SeededTraining | null;
  /** The pilot demonstration, when it was asked for (`runSeed` fills it in), and null when it was not. */
  pilotDemo: PilotDemoReport | null;
  runs: SeededRun[];
  /** Each demo identity and the matters the services list for it, which is all it can see. */
  people: { name: string; matters: string[] }[];
}

const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL(`../../../${FIXTURE_FILES.join("/")}/`, import.meta.url),
);

function principalOf(repo: Repository, userId: string): Principal {
  const user = repo.getUser(userId);
  // registerAll seeds the demo users first, so this is a store that was changed under the seed.
  if (user === undefined) throw new SeedError("a demo user is missing from the data folder");
  return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
}

function bytesOf(document: DemoDocument, fixturesDir: string): Uint8Array {
  if ("paragraphs" in document.source) return textFileBytes(document.source.paragraphs);
  try {
    return readFileSync(join(fixturesDir, document.source.fixture));
  } catch {
    throw new SeedError(
      "an example document is missing from the dataset. Run pnpm fixtures:parol, or restore the files in fixtures/parol/files",
    );
  }
}

/**
 * The documents of the worked example, as `pnpm parol:seed` uploads them to its first matter, with
 * their bytes read from the dataset. The pilot demonstration uploads the same to each of its
 * matters, and is given them here because the folder it lives in does not read files.
 */
export function workedExampleDocuments(
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): PilotDemoDocument[] {
  const worked = DEMO_MATTERS.find((matter) => matter.key === "lanternfish");
  if (worked === undefined) throw new SeedError("the worked example is not in the seed");
  return worked.documents.map((document) => ({ document, bytes: bytesOf(document, fixturesDir) }));
}

export async function seedDemo(options: SeedOptions): Promise<SeedReport> {
  const { repo, files } = options;
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const now = options.now ?? ((): Date => new Date());

  // Prompts, workflow versions, the approved playbook and the demo users. Safe to repeat.
  const registered = registerAll(repo, { seedDemoUsers: true });
  const services = createServices({
    repo,
    files,
    generator: options.generator ?? createSimulatedModel(),
    config: { relaxedSegregation: false },
    now,
    // The services log ids and codes. The seed prints its own summary instead.
    log: () => {},
  });

  const matters: SeededMatter[] = [];
  for (const definition of DEMO_MATTERS) {
    const owner = principalOf(repo, definition.ownerUserId);
    const reviewer =
      definition.reviewerUserId === null ? null : principalOf(repo, definition.reviewerUserId);

    // A matter is the demonstration's own when it has the name and its owner is its associate.
    const found = services.matters
      .list(owner)
      .find((matter) => matter.name === definition.name && matter.role === "associate");
    const matterId =
      found?.id ??
      services.matters.create(owner, {
        name: definition.name,
        clientLegalName: definition.clientLegalName,
        playbookVersionId: registered.playbook.id,
        reviewerUserId: reviewer?.userId ?? null,
      }).id;

    // Upload what is missing, so a seed that stopped half way is finished by the next one.
    const am = authorizeMatter(repo, owner, matterId, "document.write");
    const view = services.matters.view(am);
    if (found !== undefined && view.matter.playbook === null)
      services.matters.update(am, { playbookVersionId: registered.playbook.id });
    let documentsAdded = 0;
    for (const document of definition.documents) {
      if (view.documents.some((d) => d.title === document.title && d.kind === document.kind))
        continue;
      await services.matters.addDocument(am, {
        title: document.title,
        kind: document.kind,
        fileName: document.fileName,
        bytes: bytesOf(document, fixturesDir),
        statedDate: document.statedDate,
      });
      documentsAdded += 1;
    }
    matters.push({
      key: definition.key,
      matterId,
      name: definition.name,
      created: found === undefined,
      documentsAdded,
      ownerName: owner.displayName,
      reviewerName: reviewer?.displayName ?? null,
    });
  }

  let training: SeededTraining | null = null;
  if (options.training === true) {
    // Alex prepares, Dana decides, Lee is the trainer and can read it and change nothing.
    const owner = principalOf(repo, DEMO_USER_IDS.associate);
    const reviewer = principalOf(repo, DEMO_USER_IDS.reviewer);
    const trainer = principalOf(repo, DEMO_USER_IDS.legalEngineer);
    try {
      const started = await startTraining(
        {
          services,
          repo,
          relaxedSegregation: false,
          ...(options.trainingDir === undefined ? {} : { trainingDir: options.trainingDir }),
        },
        owner,
        {
          playbookVersionId: registered.playbook.id,
          reviewerUserId: reviewer.userId,
          trainerUserId: trainer.userId,
        },
      );
      training = {
        matterId: started.matterId,
        name: T01.matterName,
        created: started.created,
        documentsAdded: started.documentsAdded,
        ownerName: owner.displayName,
        reviewerName: reviewer.displayName,
        trainerName: trainer.displayName,
      };
    } catch (error) {
      if (error instanceof ConflictError && error.code === "training_files_missing")
        throw new SeedError(
          "a document of the training matter is missing. Run pnpm fixtures:parol:training, or restore the files in apps/parol/training",
        );
      throw error;
    }
  }

  const runs: SeededRun[] = [];
  const first = DEMO_MATTERS[0]!;
  const firstMatter = matters.find((matter) => matter.key === first.key)!;
  const associate = principalOf(repo, first.ownerUserId);
  for (const workflowLabel of options.runs ?? []) {
    const am = authorizeMatter(repo, associate, firstMatter.matterId, "run.start");
    // A run that failed or was cancelled does not count: asking for the workflow again is how it is retried.
    const earlier = services.runs
      .list(am)
      .find(
        (run) =>
          run.workflowLabel === workflowLabel &&
          run.status !== "failed" &&
          run.status !== "cancelled",
      );
    let run: RunSummary;
    if (earlier !== undefined) run = earlier;
    else {
      try {
        const started = services.runs.start(am, { workflowLabel });
        await services.runs.idle();
        run = services.runs.get(am, started.id);
      } catch (error) {
        if (error instanceof RunNotReadyError)
          throw new SeedError(`the review could not start: ${error.reasons.join("; ")}`);
        throw error;
      }
    }
    runs.push({
      workflowLabel,
      matterId: firstMatter.matterId,
      runId: run.id,
      started: earlier === undefined,
      status: run.status,
      findingCount: run.findingCount,
      errorKind: run.errorKind,
    });
  }

  // What each person can see is asked of the services, not worked out here.
  const people = Object.values(DEMO_USER_IDS).map((userId) => {
    const person = principalOf(repo, userId);
    return {
      name: person.displayName,
      matters: services.matters.list(person).map((matter) => matter.name),
    };
  });

  return {
    playbook: { slug: registered.playbook.slug, version: registered.playbook.version },
    matters,
    training,
    pilotDemo: null,
    runs,
    people,
  };
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

const USAGE = "usage: pnpm parol:seed [--run v1] [--run v2] [--training] [--pilot-demo]";

/**
 * `--run v1 --run v2` or `--run=v1`: workflow versions to run on the first matter. `--training`
 * also makes the training matter T01 (`training` is present, and true, only then). `--pilot-demo`
 * also builds the backdated scenario of the pilot measures page (`pilotDemo` likewise). A lone `--`
 * is ignored, because `pnpm parol:seed -- --run v1` hands it on.
 */
export function parseSeedArgs(argv: readonly string[]): {
  runs: string[];
  training?: true;
  pilotDemo?: true;
} {
  const runs: string[] = [];
  let training = false;
  let pilotDemo = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm passes on the `--` in `pnpm parol:seed -- --run v1`. It only separates, so it is skipped.
    if (arg === "--") continue;
    if (arg === "--training") {
      training = true;
      continue;
    }
    if (arg === "--pilot-demo") {
      pilotDemo = true;
      continue;
    }
    let label: string | undefined;
    if (arg === "--run") label = argv[++i];
    else if (arg.startsWith("--run=")) label = arg.slice("--run=".length);
    else throw new SeedError(`an option is not known. ${USAGE}`);
    if (label === undefined || !(WORKFLOW_LABELS as readonly string[]).includes(label))
      throw new SeedError(
        `--run needs a workflow version: ${WORKFLOW_LABELS.join(" or ")}. ${USAGE}`,
      );
    if (!runs.includes(label)) runs.push(label);
  }
  return {
    runs,
    ...(training ? { training: true as const } : {}),
    ...(pilotDemo ? { pilotDemo: true as const } : {}),
  };
}

/** What the pilot demonstration did, in words. Counts of what was done, never a measure and never document text. */
function describePilotDemo(demo: PilotDemoReport, origin: string): string[] {
  const baseline = demo.matters.filter((matter) => matter.kind === "baseline").length;
  const assisted = demo.matters.length - baseline;
  const lines = [
    demo.created
      ? `Pilot demonstration: ${demo.matters.length} matters made (${baseline} baseline, ${assisted} assisted)`
      : "Pilot demonstration: already there, nothing to add",
    `  ${PILOT_DEMO_NOTICE}`,
  ];
  if (demo.startDate !== null)
    lines.push(
      `  The pilot calendar starts on ${demo.startDate} (UTC) and its weeks are backdated.`,
    );
  if (demo.created) {
    const d = demo.done;
    lines.push(
      `  Done through the services: ${d.sittings} timed sittings, ${d.referenceLists} reference lists, ${d.reviews} reviews by the scripted reader, ${d.decisions} decisions, ${d.memos} memos exported, ${d.reports} missed-issue reports, ${d.ratings} ratings.`,
      "  The rows are dated weeks back and the audit log is in the order they were written, so use a fresh data folder.",
    );
  }
  for (const matter of demo.matters)
    lines.push(
      `  ${matter.kind} matter "${matter.name}": ${origin}${urls.matter(matter.matterId)}`,
    );
  lines.push(
    `  Sign in as ${demo.readers.join(" or ")} to read the pilot page: ${origin}${urls.pilot("synthetic")}`,
    `  The pilot scope, ${origin}${urls.pilot()}, stays empty: every person and every matter here is a demonstration.`,
  );
  return lines;
}

/** The lines the command prints. Ids, names fixed by the seed and counts, never document text. */
export function describeSeed(report: SeedReport, settings: ParolSettings): string[] {
  const origin = `http://${settings.host.includes(":") ? `[${settings.host}]` : settings.host}:${settings.port}`;
  const lines = [
    "Parol demonstration data. Every document, party and person is synthetic.",
    `Data folder: ${settings.dataDir}`,
    `Playbook: ${report.playbook.slug} ${report.playbook.version} (approved)`,
    "",
  ];
  for (const matter of report.matters) {
    const state = matter.created
      ? `created, ${matter.documentsAdded} document${matter.documentsAdded === 1 ? "" : "s"} uploaded`
      : matter.documentsAdded > 0
        ? `already there, ${matter.documentsAdded} missing document${matter.documentsAdded === 1 ? "" : "s"} uploaded`
        : "already there, nothing to add";
    lines.push(
      `Matter "${matter.name}": ${state}`,
      `  associate: ${matter.ownerName}`,
      `  reviewer: ${matter.reviewerName ?? "none, this matter is only for showing that matters are separate"}`,
      `  ${origin}${urls.matter(matter.matterId)}`,
    );
  }
  if (report.training !== null) {
    const t = report.training;
    const state = t.created
      ? `created, ${t.documentsAdded} document${t.documentsAdded === 1 ? "" : "s"} uploaded`
      : t.documentsAdded > 0
        ? `already there, ${t.documentsAdded} missing document${t.documentsAdded === 1 ? "" : "s"} uploaded`
        : "already there, nothing to add";
    lines.push(
      `Training matter "${t.name}": ${state}`,
      `  associate: ${t.ownerName}`,
      `  reviewer: ${t.reviewerName}`,
      `  trainer: ${t.trainerName}, who can read it and change nothing`,
      `  ${origin}${urls.matter(t.matterId)}`,
      "  No review has been run on it: the exercise starts at step 1 on the quickstart page.",
      "  The exercise needs the simulated reader (PAROL_SCRIPTED=1). With a provider key the finding it teaches about does not appear.",
      `  ${origin}${urls.quickstart()}`,
    );
  }
  if (report.pilotDemo !== null) lines.push("", ...describePilotDemo(report.pilotDemo, origin));
  if (report.runs.length > 0) {
    lines.push("");
    for (const run of report.runs)
      lines.push(
        `Review with workflow ${run.workflowLabel} on the first matter: ${run.started ? "run" : "already there"}, ${run.status}` +
          (run.status === "succeeded" ? `, ${run.findingCount} findings` : "") +
          (run.errorKind === null ? "" : ` (${run.errorKind})`) +
          `\n  ${origin}${urls.run(run.matterId, run.runId)}`,
      );
    if (report.runs.length > 1)
      lines.push(
        "A review of the same documents replaces the one before it as the current review. The earlier one is kept, marked superseded, at its own address above.",
      );
    lines.push(
      "The reader is the scripted simulation, so what these reviews found is not a measurement of any model.",
    );
  }
  lines.push(
    "",
    "To look at it:",
    "  PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol",
    `  then open ${origin} and choose a demo identity. There are no passwords, and the demo identity is not authentication.`,
    "  Each person sees only their own matters:",
    ...report.people.map(
      (person) =>
        `    ${person.name}: ${person.matters.length === 0 ? "no matters" : person.matters.map((name) => `"${name}"`).join(", ")}`,
    ),
  );
  return lines;
}

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * The pilot demonstration, on its own repository and services: they follow a clock the scenario
 * moves, so that every stored time is backdated. The default seed never reaches this.
 */
async function buildPilotDemo(db: Database, files: FileStore): Promise<PilotDemoReport> {
  const clock = createSteppingClock(new Date());
  const repo = createRepository(db, { now: clock.now });
  const services = createServices({
    repo,
    files,
    generator: createSimulatedModel(),
    config: { relaxedSegregation: false },
    now: clock.now,
    // The services log ids and codes. The seed prints its own summary instead.
    log: () => {},
  });
  try {
    return await seedPilotDemo({ repo, services, clock, documents: workedExampleDocuments() });
  } catch (error) {
    if (error instanceof PilotDemoError) throw new SeedError(error.message);
    throw error;
  }
}

/**
 * Seeds the data folder the environment names. Refuses, before it opens anything, unless the demo
 * identity is on.
 */
export async function runSeed(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
  out: (line: string) => void = stdout,
): Promise<SeedReport> {
  const settings = parseEnv(env);
  if (!settings.demoIdentity)
    throw new SeedError(
      "the demonstration data is only for the demo identity. Set PAROL_DEMO_IDENTITY=1 to seed it",
    );
  const { runs, training, pilotDemo } = parseSeedArgs(argv);

  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(settings.dataDir, "parol.sqlite"));
  try {
    const files = new FileStore(join(settings.dataDir, "matters"));
    const seeded = await seedDemo({
      repo: createRepository(db),
      files,
      runs,
      ...(training === true ? { training } : {}),
    });
    const report =
      pilotDemo === true ? { ...seeded, pilotDemo: await buildPilotDemo(db, files) } : seeded;
    for (const line of describeSeed(report, settings)) out(line);
    return report;
  } finally {
    db.close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runSeed().then(
    (report) => {
      // A run that failed is reported above and makes the command fail. One that a later review
      // superseded finished well, and an earlier seed's runs are in that state.
      if (report.runs.some((run) => run.status === "failed" || run.status === "cancelled"))
        process.exitCode = 1;
    },
    (error: unknown) => {
      if (error instanceof SeedError || error instanceof ConfigError)
        process.stderr.write(`Parol seed cannot run: ${error.message}\n`);
      // Any other error is about the data folder or the database (a path that is a file, a folder
      // that cannot be written), which is what the person running the command has to fix. The server
      // prints the same two things when it cannot start.
      else if (error instanceof Error)
        process.stderr.write(`Parol seed cannot run: ${error.name}: ${error.message}\n`);
      else process.stderr.write("Parol seed cannot run.\n");
      process.exitCode = 1;
    },
  );
}
