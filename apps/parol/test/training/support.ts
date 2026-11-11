import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocxParagraph } from "@clausewise/docx";
import type { Principal } from "../../src/auth/types.js";
import type { IngestDocumentInput, RunManifest } from "../../src/contracts.js";
import { createSimulatedModel } from "../../src/demo/simulated-model.js";
import type { controlledModel } from "../services/support.js";
import { createServices } from "../../src/services/index.js";
import type { Services } from "../../src/services/types.js";
import {
  FileStore,
  createRepository,
  openDatabase,
  type Repository,
} from "../../src/store/index.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { readTrainingFile } from "../../src/training/files.js";
import { T01 } from "../../src/training/t01.js";
import { buildCaseWorld, versionIdOf } from "../integration/pipeline.js";
import type { Subject } from "../demo/support.js";

/**
 * The documents of the training matter as the stages see them, for the tests of the reader. The
 * files are the committed ones under apps/parol/training, parsed by the real parser. Nothing here
 * calls a network. Every document, party and person is synthetic.
 */

export interface TrainingEdits {
  /** Replaces the title of the NDA (the marker is in it). */
  ndaTitle?: string;
  /** Changes the parsed paragraphs of the NDA before the stages see them. */
  nda?: (paragraphs: DocxParagraph[]) => DocxParagraph[];
  /** Changes the parsed paragraphs of the amendment. */
  amendment?: (paragraphs: DocxParagraph[]) => DocxParagraph[];
}

const fileOf = (kind: "nda" | "amendment") => T01.documents.find((d) => d.kind === kind)!;

/** The subject of a review: T01, or a copy of it with the edits applied. */
export async function trainingSubject(edits: TrainingEdits = {}): Promise<Subject> {
  const base = await buildCaseWorld("PAROL-D05");
  const documents: IngestDocumentInput[] = [];
  for (const [index, kind] of (["nda", "amendment"] as const).entries()) {
    const document = fileOf(kind);
    const mediaType = document.fileName.endsWith(".docx") ? "docx" : "txt";
    const parsed = await parseDocument({ bytes: readTrainingFile(document.fileName), mediaType });
    const edit = kind === "nda" ? edits.nda : edits.amendment;
    const label = index === 0 ? "D1" : "D2";
    documents.push({
      documentVersionId: versionIdOf(label),
      label,
      kind,
      title: kind === "nda" ? (edits.ndaTitle ?? document.title) : document.title,
      versionNo: 1,
      statedDate: document.statedDate,
      paragraphs: edit === undefined ? parsed.paragraphs : edit(parsed.paragraphs),
      inspection: parsed.inspection,
    });
  }
  const manifest: RunManifest = {
    ...base.manifest,
    matterId: "mat_training_t01",
    clientLegalName: T01.clientLegalName,
    documents: documents.map((d) => ({
      documentVersionId: d.documentVersionId,
      label: d.label,
      kind: d.kind,
      title: d.title,
      versionNo: d.versionNo,
      statedDate: d.statedDate,
      textSha256: documentTextSha256(d.paragraphs),
    })),
  };
  return { ingest: buildIngest({ documents }), manifest, playbook: base.playbook };
}

/** The paragraphs numbered 0, 1, 2 in order again, after one was added or taken out. */
export const reindexed = (paragraphs: DocxParagraph[]): DocxParagraph[] =>
  paragraphs.map((p, index) => ({ ...p, index }));

/** Replaces the text of one paragraph. */
export const withText =
  (index: number, change: (text: string) => string) =>
  (paragraphs: DocxParagraph[]): DocxParagraph[] =>
    paragraphs.map((p, i) => (i === index ? { ...p, text: change(p.text) } : p));

// ---------------------------------------------------------------------------------------------
// A world with the simulated reader
// ---------------------------------------------------------------------------------------------

const roots: string[] = [];

/** Removes the temporary folders the worlds of a test file made. Call it from `afterAll`. */
export function cleanupWorlds(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export interface SimulatedWorld {
  root: string;
  repo: Repository;
  files: FileStore;
  services: Services;
  principal(userId: string): Principal;
}

/**
 * The real store (in memory), a file store in a temporary folder and the real services, with the
 * simulated reader as the model. The demo users are not seeded: `seedDemo` or `registerAll` does it.
 */
export function simulatedWorld(options: { relaxed?: boolean } = {}): SimulatedWorld {
  const root = mkdtempSync(join(tmpdir(), "parol-training-"));
  roots.push(root);
  const repo = createRepository(openDatabase(":memory:"));
  const files = new FileStore(join(root, "matters"));
  const services = createServices({
    repo,
    files,
    generator: createSimulatedModel(),
    config: { relaxedSegregation: options.relaxed === true },
    now: () => new Date(),
    log: () => {},
  });
  const principal = (userId: string): Principal => {
    const user = repo.getUser(userId);
    if (user === undefined) throw new Error("no such demo user");
    return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
  };
  return { root, repo, files, services, principal };
}

/**
 * The simulated reader in the shape the test worlds take a model in (`makeSite({ model2 })`). It
 * keeps no record of its calls.
 */
export function simulatedModel(): ReturnType<typeof controlledModel> {
  return {
    generator: createSimulatedModel() as ReturnType<typeof controlledModel>["generator"],
    calls: [],
    callsFor: () => [],
    count: () => 0,
  };
}

/** The ids of the matters that carry a training key, read from the column. */
export const trainingMatterIds = (repo: Repository): string[] =>
  (
    repo.db.prepare("SELECT id FROM matters WHERE training_key IS NOT NULL ORDER BY id").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
