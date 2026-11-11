import { mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MATTER_ACTIONS, type MatterAction } from "../../src/auth/actions.js";
import { authorizeMatter } from "../../src/auth/authorize.js";
import { registerAll } from "../../src/boot/register.js";
import { PLANTED_RULE_KEY } from "../../src/demo/training-example.js";
import { PASSAGES } from "../../src/demo/worked-example.js";
import type { Services } from "../../src/services/types.js";
import { ForbiddenError } from "../../src/services/errors.js";
import {
  ConflictError,
  DEMO_USER_IDS,
  ValidationError,
  type Repository,
} from "../../src/store/index.js";
import { DEFAULT_TRAINING_DIR } from "../../src/training/files.js";
import {
  startTraining,
  type StartTrainingDeps,
  type StartTrainingInput,
} from "../../src/training/start.js";
import { T01 } from "../../src/training/t01.js";
import { cleanupWorlds, simulatedWorld, trainingMatterIds } from "./support.js";

/**
 * Starting a person's training matter, through the services. The reader is the simulated reader and
 * no review is run here. Every document, party and person is synthetic.
 */

afterAll(cleanupWorlds);

const count = (repo: Repository, table: string): number =>
  (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Every table's row count, so that "makes nothing" is not only about matters. */
function census(repo: Repository): Record<string, number> {
  const tables = repo.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, count(repo, name)]));
}

function setup(options: { relaxed?: boolean } = {}) {
  const w = simulatedWorld(options);
  const registered = registerAll(w.repo, { seedDemoUsers: true });
  const deps: StartTrainingDeps = {
    services: w.services,
    repo: w.repo,
    relaxedSegregation: options.relaxed === true,
  };
  const input = (over: Partial<StartTrainingInput> = {}): StartTrainingInput => ({
    playbookVersionId: registered.playbook.id,
    reviewerUserId: DEMO_USER_IDS.reviewer,
    trainerUserId: DEMO_USER_IDS.legalEngineer,
    ...over,
  });
  return { w, deps, input, alex: w.principal(DEMO_USER_IDS.associate) };
}

async function refused(run: Promise<unknown>): Promise<ValidationError | ConflictError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ConflictError) return error;
    throw error;
  }
  throw new Error("the start was not refused");
}

describe("startTraining", () => {
  it("makes the matter with its two documents, the pinned playbook, the reviewer, the trainer as a viewer, and runs no review", async () => {
    const { w, deps, input, alex } = setup();
    const started = await startTraining(deps, alex, input());
    expect(started).toMatchObject({ created: true, documentsAdded: 2 });
    const matter = w.repo.getMatter(started.matterId)!;
    expect(matter).toMatchObject({
      name: T01.matterName,
      clientLegalName: T01.clientLegalName,
      trainingKey: "T01",
      synthetic: true,
      createdBy: DEMO_USER_IDS.associate,
      status: "ready",
    });
    expect(matter.playbookVersionId).toBe(input().playbookVersionId);
    expect(
      w.repo
        .listMembers(started.matterId)
        .map((m) => [m.userId, m.role])
        .sort(),
    ).toEqual(
      [
        [DEMO_USER_IDS.associate, "associate"],
        [DEMO_USER_IDS.reviewer, "reviewer"],
        [DEMO_USER_IDS.legalEngineer, "viewer"],
      ].sort(),
    );
    expect(w.repo.listDocuments(started.matterId).map((d) => [d.ordinal, d.kind, d.title])).toEqual(
      [
        [1, "nda", T01.documents[0]!.title],
        [2, "amendment", T01.documents[1]!.title],
      ],
    );
    expect(
      w.repo.listVersions(started.matterId).map((v) => [v.mediaType, v.statedDate, v.operative]),
    ).toEqual([
      ["docx", "2026-02-02", true],
      ["txt", "2026-09-15", true],
    ]);
    expect(count(w.repo, "runs")).toBe(0);
    expect(count(w.repo, "model_calls")).toBe(0);
    // The audit log has the person's own events: creation with the key, two uploads, two members.
    const actions = w.repo
      .listAuditEvents({ matterId: started.matterId, limit: 1000 })
      .map((e) => e.action);
    expect(actions.filter((a) => a === "matter.create")).toHaveLength(1);
    expect(actions.filter((a) => a === "document.add")).toHaveLength(2);
    expect(actions.filter((a) => a === "member.add")).toHaveLength(3);
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("lets the trainer read the matter and add feedback to it, and decide, run, export or change nothing", async () => {
    const { w, deps, input, alex } = setup();
    const started = await startTraining(deps, alex, input());
    const lee = w.principal(DEMO_USER_IDS.legalEngineer);
    expect(w.services.matters.list(lee).map((m) => [m.id, m.role, m.training])).toContainEqual([
      started.matterId,
      "viewer",
      "T01",
    ]);
    const roles = new Map(w.repo.listMembers(started.matterId).map((m) => [m.userId, m.role]));
    expect(roles.get(lee.userId)).toBe("viewer");
    // What the quickstart tells the trainee: read, notes, a missed issue and a rating are allowed;
    // deciding, starting or changing a review, exporting and changing the matter are not.
    const allowed = (Object.keys(MATTER_ACTIONS) as MatterAction[]).filter((action) => {
      try {
        authorizeMatter(w.repo, lee, started.matterId, action);
        return true;
      } catch (error) {
        if (error instanceof ForbiddenError) return false;
        throw error;
      }
    });
    expect(allowed.sort()).toEqual(
      ["feedback.add", "finding.read", "matter.read", "memo.read", "run.read"].sort(),
    );
  });

  it("lets the trainer add a note to a finding of the matter and report a missed issue, and keeps them out of the decision", async () => {
    const { w, deps, input, alex } = setup();
    const started = await startTraining(deps, alex, input());
    const findings = await reviewed(w, alex, started.matterId, "v2");
    const lee = w.principal(DEMO_USER_IDS.legalEngineer);
    const finding = findings.get("dur-1")!;
    const am = authorizeMatter(w.repo, lee, started.matterId, "feedback.add");
    const note = w.services.feedback.addNote(am, finding.id, { note: "A note from the trainer." });
    expect(note).toMatchObject({ findingId: finding.id, note: "A note from the trainer." });
    expect(w.repo.listFeedback(started.matterId, { kind: "comment" })).toHaveLength(1);
    const missed = w.services.feedback.reportMissedIssue(am, finding.runId, {
      ruleKey: null,
      location: null,
      note: "A report from the trainer.",
    });
    expect(missed.runId).toBe(finding.runId);
    expect(w.repo.listFeedback(started.matterId, { kind: "missed_issue" })).toHaveLength(1);
    expect(() => authorizeMatter(w.repo, lee, started.matterId, "review.decide")).toThrow(
      ForbiddenError,
    );
  });

  it("is not described, in the training package or on the start form, as unable to change anything", () => {
    const here = join(import.meta.dirname, "../../src");
    const files = [
      ...readdirSync(join(here, "training")).map((name) => join(here, "training", name)),
      join(here, "server/pages/quickstart.tsx"),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files)
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /cannot change anything|change nothing|read-only trainer/i,
      );
  });

  it("makes nothing the second time, and returns the same matter", async () => {
    const { w, deps, input, alex } = setup();
    const first = await startTraining(deps, alex, input());
    const before = census(w.repo);
    const second = await startTraining(deps, alex, input());
    expect(second).toEqual({ matterId: first.matterId, created: false, documentsAdded: 0 });
    expect(census(w.repo)).toEqual(before);
  });

  it("gives each person a training matter of their own", async () => {
    const { w, deps, input, alex } = setup();
    const dana = w.principal(DEMO_USER_IDS.reviewer);
    const mine = await startTraining(deps, alex, input());
    const hers = await startTraining(
      deps,
      dana,
      input({ reviewerUserId: DEMO_USER_IDS.admin, trainerUserId: null }),
    );
    expect(hers.created).toBe(true);
    expect(hers.matterId).not.toBe(mine.matterId);
    expect(trainingMatterIds(w.repo).sort()).toEqual([mine.matterId, hers.matterId].sort());
    // Neither sees the other's: Dana is the reviewer of Alex's and the associate of her own, and
    // the reviewer of hers is someone else.
    expect(w.services.matters.list(alex).map((m) => m.id)).toContain(mine.matterId);
    expect(w.services.matters.list(alex).map((m) => m.id)).not.toContain(hers.matterId);
  });

  it("does not start twice when it is called twice at once", async () => {
    const { w, deps, input, alex } = setup();
    const [a, b] = await Promise.all([
      startTraining(deps, alex, input()),
      startTraining(deps, alex, input()),
    ]);
    expect(a.matterId).toBe(b.matterId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    // One of the two uploaded the documents and the other found them there: the count of what a
    // call added is true, and the second call did not even try.
    expect([a.documentsAdded, b.documentsAdded].sort()).toEqual([0, 2]);
    expect(trainingMatterIds(w.repo)).toEqual([a.matterId]);
    expect(count(w.repo, "documents")).toBe(2);
    expect(count(w.repo, "document_versions")).toBe(2);
  });
});

/** The finding of the planted rule in a review, and the other seven by rule. */
async function reviewed(
  w: ReturnType<typeof setup>["w"],
  alex: ReturnType<typeof setup>["alex"],
  matterId: string,
  workflowLabel: "v1" | "v2",
) {
  const am = authorizeMatter(w.repo, alex, matterId, "run.start");
  const run = w.services.runs.start(am, { workflowLabel });
  await w.services.runs.idle();
  expect(w.services.runs.get(am, run.id).status).toBe("succeeded");
  return new Map(w.repo.listFindings(matterId, run.id).map((f) => [f.ruleKey, f]));
}

describe("whose training matter is the person's own", () => {
  /** Adds a person to a matter as an associate, the way POST /matters/:id/members does. */
  const makeAssociate = (
    w: ReturnType<typeof setup>["w"],
    owner: ReturnType<typeof setup>["alex"],
    matterId: string,
    userId: string,
  ): void =>
    w.services.matters.addMember(authorizeMatter(w.repo, owner, matterId, "member.add"), {
      userId,
      role: "associate",
    });

  it("is the one the person made: a person made associate on someone else's T01 still starts their own", async () => {
    const { w, deps, input, alex } = setup();
    const sam = w.principal(DEMO_USER_IDS.admin);
    const alexs = await startTraining(deps, alex, input({ trainerUserId: null }));
    makeAssociate(w, alex, alexs.matterId, sam.userId);
    expect(w.repo.getMember(alexs.matterId, sam.userId)?.role).toBe("associate");
    const membersOfAlexs = w.repo.listMembers(alexs.matterId).map((m) => [m.userId, m.role]);
    const eventsOfAlexs = w.repo.listAuditEvents({ matterId: alexs.matterId, limit: 1000 }).length;

    const sams = await startTraining(deps, sam, input());
    expect(sams).toMatchObject({ created: true, documentsAdded: 2 });
    expect(sams.matterId).not.toBe(alexs.matterId);
    expect(w.repo.getMatter(sams.matterId)).toMatchObject({
      createdBy: sam.userId,
      trainingKey: "T01",
    });
    expect(trainingMatterIds(w.repo).sort()).toEqual([alexs.matterId, sams.matterId].sort());

    // The trainer Sam named is a viewer of Sam's matter and was not put on Alex's.
    expect(w.repo.getMember(sams.matterId, DEMO_USER_IDS.legalEngineer)?.role).toBe("viewer");
    expect(w.repo.getMember(alexs.matterId, DEMO_USER_IDS.legalEngineer)).toBeUndefined();
    // Alex's matter is as it was.
    expect(w.repo.listMembers(alexs.matterId).map((m) => [m.userId, m.role])).toEqual(
      membersOfAlexs,
    );
    expect(w.repo.listAuditEvents({ matterId: alexs.matterId, limit: 1000 })).toHaveLength(
      eventsOfAlexs,
    );
  });

  it("is found again by the person who made it, even when a newer T01 lists them as associate first", async () => {
    const { w, deps, input, alex } = setup();
    const sam = w.principal(DEMO_USER_IDS.admin);
    const sams = await startTraining(deps, sam, input({ trainerUserId: null }));
    // The list is newest first, so Alex's matter must be newer than Sam's to come first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const alexs = await startTraining(deps, alex, input({ trainerUserId: null }));
    makeAssociate(w, alex, alexs.matterId, sam.userId);
    expect(w.services.matters.list(sam).map((m) => m.id)[0]).toBe(alexs.matterId);

    const again = await startTraining(deps, sam, input());
    expect(again).toEqual({ matterId: sams.matterId, created: false, documentsAdded: 0 });
    // The trainer is added to Sam's matter, and not to Alex's.
    expect(w.repo.getMember(sams.matterId, DEMO_USER_IDS.legalEngineer)?.role).toBe("viewer");
    expect(w.repo.getMember(alexs.matterId, DEMO_USER_IDS.legalEngineer)).toBeUndefined();
  });
});

describe("a review of the matter it made", () => {
  it.each(["v1", "v2"] as const)(
    "holds the finding the exercise is about, under %s: compliant, verified, with no flag, citing the definition clause",
    async (workflow) => {
      const { w, deps, input, alex } = setup();
      const started = await startTraining(deps, alex, input());
      const findings = await reviewed(w, alex, started.matterId, workflow);
      expect(findings.size).toBe(8);
      const planted = findings.get(PLANTED_RULE_KEY)!;
      expect(planted).toMatchObject({ status: "compliant", verificationState: "verified" });
      expect(planted.escalations).toEqual([]);
      expect(planted.evidence.map((e) => e.quote)).toEqual([PASSAGES.ciDefinition.quote]);
      // The reading of the rest is the worked example's under that version.
      expect(findings.get("dur-1")!.status).toBe(workflow === "v1" ? "compliant" : "deviation");
      expect(findings.get("ret-1")!.status).toBe(workflow === "v1" ? "deviation" : "compliant");
    },
  );

  it("still holds it after the stated date of the amendment is changed, which is how the exercise goes on", async () => {
    const { w, deps, input, alex } = setup();
    const started = await startTraining(deps, alex, input());
    await reviewed(w, alex, started.matterId, "v2");
    const amendment = w.repo.listVersions(started.matterId).find((v) => v.mediaType === "txt")!;
    w.services.matters.setStatedDate(
      authorizeMatter(w.repo, alex, started.matterId, "document.write"),
      amendment.id,
      "2026-10-01",
    );
    expect(w.repo.getMatter(started.matterId)!.status).toBe("stale");
    const again = await reviewed(w, alex, started.matterId, "v2");
    expect(again.size).toBe(8);
    expect(again.get(PLANTED_RULE_KEY)!.evidence.map((e) => e.quote)).toEqual([
      PASSAGES.ciDefinition.quote,
    ]);
    expect(again.get("dur-1")!.status).toBe("deviation");
  });
});

describe("a start that stopped half way", () => {
  /** The services, with the n-th upload failing once. */
  function failingUpload(services: Services, n: number): Services {
    let calls = 0;
    return {
      ...services,
      matters: {
        ...services.matters,
        addDocument: (am, input) => {
          calls += 1;
          if (calls === n) return Promise.reject(new Error("the upload stopped"));
          return services.matters.addDocument(am, input);
        },
      },
    };
  }

  it("is finished by the next call when it stopped before any document", async () => {
    const { w, deps, input, alex } = setup();
    await expect(
      startTraining({ ...deps, services: failingUpload(w.services, 1) }, alex, input()),
    ).rejects.toThrow("the upload stopped");
    expect(trainingMatterIds(w.repo)).toHaveLength(1);
    expect(count(w.repo, "documents")).toBe(0);

    const finished = await startTraining(deps, alex, input());
    expect(finished).toMatchObject({ created: false, documentsAdded: 2 });
    expect(count(w.repo, "documents")).toBe(2);
    expect(w.repo.getMatter(finished.matterId)!.status).toBe("ready");
  });

  it("is finished by the next call when it stopped after the NDA, adding the amendment only", async () => {
    const { w, deps, input, alex } = setup();
    await expect(
      startTraining({ ...deps, services: failingUpload(w.services, 2) }, alex, input()),
    ).rejects.toThrow("the upload stopped");
    expect(w.repo.listDocuments(trainingMatterIds(w.repo)[0]!).map((d) => d.kind)).toEqual(["nda"]);
    const finished = await startTraining(deps, alex, input());
    expect(finished).toMatchObject({ created: false, documentsAdded: 1 });
    expect(w.repo.listDocuments(finished.matterId).map((d) => d.kind)).toEqual([
      "nda",
      "amendment",
    ]);
  });

  it("adds the trainer when an earlier call stopped before naming them", async () => {
    const { w, deps, input, alex } = setup();
    const noTrainer = await startTraining(deps, alex, input({ trainerUserId: null }));
    expect(w.repo.listMembers(noTrainer.matterId)).toHaveLength(2);
    const again = await startTraining(deps, alex, input());
    expect(again).toMatchObject({ created: false, documentsAdded: 0 });
    expect(w.repo.listMembers(again.matterId)).toHaveLength(3);
  });
});

describe("what it refuses", () => {
  it("a missing reviewer, unless the server is set for one person", async () => {
    const { w, deps, input, alex } = setup();
    const error = await refused(startTraining(deps, alex, input({ reviewerUserId: null })));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe("reviewer_required");
    expect(count(w.repo, "matters")).toBe(0);

    const relaxed = setup({ relaxed: true });
    const made = await startTraining(
      relaxed.deps,
      relaxed.alex,
      relaxed.input({ reviewerUserId: null, trainerUserId: null }),
    );
    expect(made.created).toBe(true);
    expect(relaxed.w.repo.listMembers(made.matterId)).toHaveLength(1);
  });

  it("the person as their own reviewer, unless the server is set for one person", async () => {
    const { w, deps, input, alex } = setup();
    const error = await refused(
      startTraining(deps, alex, input({ reviewerUserId: DEMO_USER_IDS.associate })),
    );
    expect(error.code).toBe("bad_reviewer");
    expect(count(w.repo, "matters")).toBe(0);

    const relaxed = setup({ relaxed: true });
    const made = await startTraining(
      relaxed.deps,
      relaxed.alex,
      relaxed.input({ reviewerUserId: DEMO_USER_IDS.associate, trainerUserId: null }),
    );
    expect(made.created).toBe(true);
  });

  it("a reviewer or a trainer who is not a user", async () => {
    const { w, deps, input, alex } = setup();
    for (const over of [
      { reviewerUserId: "usr_QZX-TYPED" },
      { trainerUserId: "usr_QZX-TYPED" },
    ] as const) {
      const error = await refused(startTraining(deps, alex, input(over)));
      expect(error.code).toBe("unknown_identity");
      // It names the kind of problem and never repeats what was typed.
      expect(error.message).not.toContain("QZX-TYPED");
    }
    expect(count(w.repo, "matters")).toBe(0);
  });

  it("a trainer who is the person or the reviewer, who are on the matter already", async () => {
    const { w, deps, input, alex } = setup();
    for (const trainerUserId of [DEMO_USER_IDS.associate, DEMO_USER_IDS.reviewer]) {
      const error = await refused(startTraining(deps, alex, input({ trainerUserId })));
      expect(error.code).toBe("bad_trainer");
      expect(error).toBeInstanceOf(ValidationError);
    }
    expect(count(w.repo, "matters")).toBe(0);
  });

  it("a playbook version that is not an approved one, and makes no matter", async () => {
    const { w, deps, input, alex } = setup();
    await expect(
      startTraining(deps, alex, input({ playbookVersionId: "pbv_nothing" })),
    ).rejects.toThrow();
    expect(count(w.repo, "matters")).toBe(0);
  });

  it("a missing training file, with a fixed message that names no path, and makes nothing", async () => {
    const { w, deps, input, alex } = setup();
    const dir = mkdtempSync(join(tmpdir(), "parol-training-dir-"));
    // The NDA is there and the amendment is not.
    copyFileSync(join(DEFAULT_TRAINING_DIR, "t01-nda.docx"), join(dir, "t01-nda.docx"));
    const error = await refused(startTraining({ ...deps, trainingDir: dir }, alex, input()));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("training_files_missing");
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toMatch(/[\\/]|t01/);
    expect(count(w.repo, "matters")).toBe(0);
    expect(count(w.repo, "documents")).toBe(0);
    // A file that is there but is not a Word file is an upload error of the ordinary kind.
    writeFileSync(join(dir, "t01-amendment-1.txt"), "x");
    writeFileSync(join(dir, "t01-nda.docx"), "not a word file");
    await expect(startTraining({ ...deps, trainingDir: dir }, alex, input())).rejects.toThrow();
  });
});
