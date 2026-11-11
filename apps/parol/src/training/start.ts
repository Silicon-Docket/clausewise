import { authorizeMatter } from "../auth/authorize.js";
import type { Principal } from "../auth/types.js";
import type { Services } from "../services/types.js";
import { ValidationError, type Repository } from "../store/index.js";
import { DEFAULT_TRAINING_DIR, readTrainingFile } from "./files.js";
import { ownTrainingMatter } from "./own.js";
import { T01 } from "./t01.js";

/**
 * Starts a person's training matter T01 (package W2.8): creates it, uploads its two documents, and
 * names the reviewing attorney and, if there is one, the trainer. It goes through the services, as
 * the screens and the seed do, so every step is authorized, invalidating and audited the way a
 * person's own action is. It is for the person who calls it: they become the associate of the new
 * matter.
 *
 * It is safe to repeat. A person has at most one T01 (the database holds the key once per
 * creator), a second call finds it and makes nothing, and a start that stopped half way is finished
 * by the next call, which uploads what is missing.
 *
 * Every error is a `ValidationError` or a `ConflictError` with a fixed code and a fixed message
 * that repeat no input. The codes have phrases in `routes/refusals-training.ts`.
 */

export interface StartTrainingDeps {
  services: Services;
  repo: Repository;
  /** From the server's settings: with true, the associate may be their own reviewer. */
  relaxedSegregation: boolean;
  /** Where the committed files are. Default: `apps/parol/training`. Tests point it elsewhere. */
  trainingDir?: string;
}

export interface StartTrainingInput {
  /** An approved playbook version, which the matter pins. */
  playbookVersionId: string;
  reviewerUserId: string | null;
  trainerUserId: string | null;
}

export interface StartedTraining {
  matterId: string;
  /** False when the person already had a training matter (it may still have been completed). */
  created: boolean;
  /** Documents uploaded by this call. */
  documentsAdded: number;
}

/**
 * Starts that are in flight, by repository and person. A second call for the same person waits for
 * the first, so a double click finds the matter the first made and makes nothing, and two uploads
 * of the same file never race.
 */
const inFlight = new WeakMap<Repository, Map<string, Promise<unknown>>>();

function serialized<T>(repo: Repository, userId: string, work: () => Promise<T>): Promise<T> {
  let byUser = inFlight.get(repo);
  if (byUser === undefined) {
    byUser = new Map();
    inFlight.set(repo, byUser);
  }
  const earlier = byUser.get(userId) ?? Promise.resolve();
  const mine = earlier.then(work, work);
  const tail = mine.catch(() => undefined);
  byUser.set(userId, tail);
  void tail.then(() => {
    if (byUser.get(userId) === tail) byUser.delete(userId);
  });
  return mine;
}

export async function startTraining(
  deps: StartTrainingDeps,
  principal: Principal,
  input: StartTrainingInput,
): Promise<StartedTraining> {
  // The checks run before the call joins the queue, so a refusal is not held up behind a start.
  validate(deps, principal, input);
  return serialized(deps.repo, principal.userId, () => start(deps, principal, input));
}

function validate(
  { repo, relaxedSegregation }: StartTrainingDeps,
  principal: Principal,
  input: StartTrainingInput,
): void {
  const { reviewerUserId, trainerUserId } = input;
  if (reviewerUserId === null && !relaxedSegregation)
    throw new ValidationError("reviewer_required", "a reviewing attorney is required");
  if (reviewerUserId !== null) {
    if (repo.getUser(reviewerUserId) === undefined)
      throw new ValidationError("unknown_identity", "the person is not one of the listed people");
    if (reviewerUserId === principal.userId && !relaxedSegregation)
      throw new ValidationError("bad_reviewer", "the reviewing attorney cannot be the author");
  }
  if (trainerUserId !== null) {
    if (repo.getUser(trainerUserId) === undefined)
      throw new ValidationError("unknown_identity", "the person is not one of the listed people");
    // The trainer is added as a viewer. Someone who is already on the matter cannot be.
    if (trainerUserId === principal.userId || trainerUserId === reviewerUserId)
      throw new ValidationError("bad_trainer", "the trainer is not the author or the reviewer");
  }
}

async function start(
  { services, repo, relaxedSegregation, trainingDir }: StartTrainingDeps,
  principal: Principal,
  input: StartTrainingInput,
): Promise<StartedTraining> {
  const dir = trainingDir ?? DEFAULT_TRAINING_DIR;
  const authorize = (matterId: string, action: "matter.read" | "document.write" | "member.add") =>
    authorizeMatter(repo, principal, matterId, action, { relaxedSegregation });

  // The person's own T01, if they have one: the one they made. Being the associate of a T01 is
  // not enough, because an associate can add another person as associate of theirs.
  const found = ownTrainingMatter(services, repo, principal);
  const present =
    found === undefined
      ? []
      : services.matters.view(authorize(found.id, "matter.read")).documents.map((d) => d.kind);

  // The files that are needed are read before anything is made, so a missing file leaves nothing
  // half made.
  const missing = T01.documents
    .filter((document) => !present.includes(document.kind))
    .map((document) => ({ document, bytes: readTrainingFile(document.fileName, dir) }));

  const matterId =
    found?.id ??
    services.matters.create(principal, {
      name: T01.matterName,
      clientLegalName: T01.clientLegalName,
      playbookVersionId: input.playbookVersionId,
      reviewerUserId: input.reviewerUserId,
      training: T01.key,
    }).id;

  // Upload what is missing, in the order the matter needs (the NDA first).
  let documentsAdded = 0;
  for (const { document, bytes } of missing) {
    await services.matters.addDocument(authorize(matterId, "document.write"), {
      title: document.title,
      kind: document.kind,
      fileName: document.fileName,
      bytes,
      statedDate: document.statedDate,
    });
    documentsAdded += 1;
  }

  // The trainer can then read the matter and see its progress. A viewer holds feedback.add like
  // every role, so they can also add notes, report a missed issue and rate the matter; they cannot
  // decide a finding, start or change a review, export the memo or change the matter.
  if (input.trainerUserId !== null && repo.getMember(matterId, input.trainerUserId) === undefined)
    services.matters.addMember(authorize(matterId, "member.add"), {
      userId: input.trainerUserId,
      role: "viewer",
    });

  return { matterId, created: found === undefined, documentsAdded };
}
