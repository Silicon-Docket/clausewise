import { describe, expect, it } from "vitest";
import type { FindingView } from "../../apps/parol/src/services/views.js";
import { decisionFor } from "../src/parol/exposure/review.js";
import { probeKey, type Scratch } from "../src/parol/exposure/probe-kit.js";
import {
  EFFECT_KEYS,
  FORGED_BODY_KEYS,
  MATTER_PROBES,
  effectOf,
} from "../src/parol/exposure/probes.js";

/**
 * The exposure suite and the reason code (package W2.6a, slice A). The suite's own reviewer accepts
 * what is verified and escalates the rest, and neither carries a reason code, so the review routes
 * keep their probe rows, their forged-id bodies and their effect bodies as they were. This test
 * pins that dependency: the day the suite's reviewer edits or rejects, its decision needs a code,
 * and this fails before the effect bodies start answering 400 for the wrong reason. The later
 * slices add the probe rows of a missed issue, a note and the rating below.
 */

const REVIEW_ROUTES = [
  "POST /matters/:matterId/findings/:findingId/reviews",
  "POST /api/matters/:matterId/findings/:findingId/reviews",
] as const;

const viewOf = (verificationState: string, status: string): FindingView =>
  ({
    issue: { verificationState, status },
    contentSha256: "a".repeat(64),
  }) as unknown as FindingView;

describe("the suite's own reviewer", () => {
  it("accepts what is verified and escalates the rest, and neither carries a code or a mark", () => {
    for (const [verification, status, decision] of [
      ["verified", "compliant", "accept"],
      ["verified", "deviation", "accept"],
      ["unverified", "deviation", "escalate"],
      ["verified", "undetermined", "escalate"],
    ] as const) {
      const request = decisionFor(viewOf(verification, status));
      expect(request.decision, `${verification} ${status}`).toBe(decision);
      expect(Object.keys(request).sort()).toEqual([
        "decision",
        "edits",
        "findingContentSha256",
        "reason",
      ]);
      expect(request.edits).toBeNull();
    }
  });
});

describe("the review routes in the probe tables", () => {
  const scratch: Scratch = {
    matterId: "mat_1",
    documentId: "doc_1",
    versionId: "ver_1",
    earlierVersionId: "ver_0",
    amendmentId: "doc_2",
    invitee: "usr_1",
    workflow: "v2",
    runId: "run_1",
    findingId: "fnd_1",
    decision: { decision: "accept", findingContentSha256: "b".repeat(64), reason: null },
  };

  it("are still probed, with a forged-id body and an effect body, as the reviewer's action", () => {
    for (const key of REVIEW_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key);
      expect(probe, key).toBeDefined();
      expect(probe).toMatchObject({ action: "review.decide", reaches: 400 });
      expect(FORGED_BODY_KEYS, key).toContain(key);
      expect(EFFECT_KEYS, key).toContain(key);
      // The body that must change the store is not the probe's own empty one.
      const effect = effectOf(probe!, scratch);
      expect(effect?.needs, key).toBe("run");
      expect(JSON.stringify(effect?.body), key).not.toBe(JSON.stringify(probe!.body));
    }
  });

  it("send a decision that needs no code, so it reaches the store and not the refusal of a missing one", () => {
    for (const key of REVIEW_ROUTES) {
      const effect = effectOf(
        MATTER_PROBES.find((p) => probeKey(p) === key)!,
        scratch,
      )!;
      const fields =
        effect.body.kind === "form"
          ? effect.body.fields
          : effect.body.kind === "json"
            ? (effect.body.json as Record<string, unknown>)
            : {};
      expect(["accept", "escalate"], key).toContain(fields["decision"]);
      expect(Object.keys(fields), key).not.toContain("reasonCode");
      expect(Object.keys(fields), key).not.toContain("minorEdit");
    }
  });
});
