import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import {
  CANNOT_DECIDE_REASON,
  FIELDS,
  STALE_FINDING_REASON,
  UNVERIFIED_QUOTE_NOTE,
  evidenceIdOfRoleField,
  evidenceRoleField,
} from "../../src/server/pages/index.js";
import { STATUSES, EVIDENCE_ROLES } from "../../src/contracts.js";
import { checkInvariants } from "./invariants.js";
import {
  all,
  attr,
  byId,
  byTag,
  controls,
  first,
  forms,
  hasAttr,
  hasClass,
  readable,
  textOf,
  withClass,
  type El,
} from "./html.js";
import { findingPage, paneOnly } from "./render.js";
import {
  IDS,
  SHAS,
  buildConflictFinding,
  buildDecidedFinding,
  buildEvidence,
  buildFindingView,
  buildStaleFinding,
  buildUndecidableFinding,
  buildUnverifiedFinding,
} from "./support.js";
import type { FindingView } from "../../src/services/views.js";

const pane = (finding: FindingView = buildFindingView()): El =>
  checkInvariants(paneOnly(finding), { fragment: true });
const passages = (root: El): El[] => withClass(root, "passage");
const locationOf = (p: El): string => readable(first(p, (el) => hasClass(el, "location")));

describe("FindingPane header", () => {
  const root = pane();

  it("names the rule, its category and key, and shows severity, status and review state", () => {
    expect(readable(first(root, (el) => el.name === "h2"))).toBe(
      "Duration of confidentiality obligations",
    );
    const eyebrow = withClass(root, "eyebrow")[0]!;
    expect(readable(eyebrow)).toBe("Duration, rule dur-1");
    const chips = readable(withClass(root, "pane-head")[0]!);
    expect(chips).toContain("High");
    expect(chips).toContain("Deviation");
    expect(chips).toContain("Not decided");
  });

  it("links to the decision when the user can decide", () => {
    const link = first(root, (el) => el.name === "a" && readable(el) === "Go to the decision");
    expect(attr(link, "href")).toBe("#decision");
    expect(byId(root, "decision")).toBeDefined();
  });

  it("shows each escalation as a chip in the header, and explains it under the finding", () => {
    const root2 = pane(buildConflictFinding());
    const head = readable(withClass(root2, "pane-head")[0]!);
    expect(head).toContain("Sources conflict");
    expect(head).toContain("Playbook says escalate");
    const flags = readable(withClass(root2, "escalations")[0]!);
    expect(flags).toContain("dv_d1v1:p31 and dv_d2v1:p4 name different courts");
    // The sentence is on the page itself, not only in a hover title.
    expect(flags).toContain(
      "Two passages disagree and the documents do not settle which one governs.",
    );
    expect(flags).toContain("The playbook says this situation goes to an attorney.");
  });
});

describe("FindingPane evidence (screen S2)", () => {
  const root = pane();

  it("lists each cited passage with its location, governing first", () => {
    expect(passages(root).map(locationOf)).toEqual([
      "Amendment No. 1 (v1), Section 2, paragraph 3",
      "Mutual NDA (v1), Section 9.3, paragraph 29",
      "Mutual NDA (v1), Section 6.1, paragraph 19",
    ]);
  });

  it("labels each passage's role, quote check and support check in words", () => {
    const [governing, supporting, superseded] = passages(root);
    expect(readable(governing!)).toContain("Governing");
    expect(readable(governing!)).toContain("Quote found");
    expect(readable(governing!)).toContain("Supported");
    expect(readable(supporting!)).toContain("Supporting");
    expect(readable(superseded!)).toContain("Superseded");
  });

  it("highlights the verified quote inside the whole paragraph, from the offsets", () => {
    const governing = passages(root)[0]!;
    const marks = all(governing, (el) => el.name === "mark");
    expect(marks).toHaveLength(1);
    expect(readable(marks[0]!)).toBe("Section 6.1 of the Agreement is deleted in its entirety");
    expect(hasAttr(marks[0]!, "data-quote")).toBe(true);
    const body = first(governing, (el) => hasClass(el, "doc-text"));
    expect(textOf(body)).toBe("Section 6.1 of the Agreement is deleted in its entirety.");
    const superseded = passages(root)[2]!;
    const text = textOf(first(superseded, (el) => hasClass(el, "doc-text")));
    expect(text).toBe(
      "The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.",
    );
    expect(readable(all(superseded, (el) => el.name === "mark")[0]!)).toBe(
      "shall continue for two (2) years from the date of each disclosure",
    );
  });

  it("strikes through and labels a superseded passage", () => {
    const superseded = passages(root)[2]!;
    expect(hasClass(superseded, "is-superseded")).toBe(true);
    const struck = all(superseded, (el) => el.name === "del");
    expect(struck).toHaveLength(1);
    expect(textOf(struck[0]!)).toContain("shall continue for two (2) years");
    expect(readable(first(superseded, (el) => hasClass(el, "passage-note")))).toContain(
      "Superseded.",
    );
    expect(readable(superseded)).toContain("struck through");
    for (const other of passages(root).slice(0, 2)) {
      expect(all(other, (el) => el.name === "del")).toHaveLength(0);
      expect(hasClass(other, "is-superseded")).toBe(false);
    }
  });

  it("puts the highlighted quote of each passage in its own paragraph block", () => {
    for (const p of passages(root)) {
      const marks = all(p, (el) => el.name === "mark");
      expect(marks).toHaveLength(1);
      const block = first(p, (el) => hasClass(el, "doc-text"));
      expect(all(block, (el) => el === marks[0]).length).toBe(1);
    }
  });

  it("says when a finding cites nothing", () => {
    const root2 = pane(buildFindingView({ evidence: [] }));
    expect(readable(root2)).toContain("This finding cites no passage");
    expect(passages(root2)).toHaveLength(0);
  });
});

describe("FindingPane conflicting passages", () => {
  const root = pane(buildConflictFinding());

  it("shows them side by side under a plain statement that they disagree", () => {
    const group = withClass(root, "passages-conflict");
    expect(group).toHaveLength(1);
    expect(withClass(group[0]!, "passage")).toHaveLength(2);
    expect(readable(withClass(root, "conflict-lead")[0]!)).toContain("These passages disagree");
    expect(withClass(group[0]!, "passage").every((p) => hasClass(p, "role-conflicting"))).toBe(
      true,
    );
  });

  it("does not put non-conflicting passages in the side-by-side group", () => {
    const finding = buildFindingView({
      evidence: [
        ...buildConflictFinding().evidence,
        buildEvidence({
          id: "ev_x",
          spanId: "s",
          location: "Mutual NDA (v1), Section 1, paragraph 1",
          quote: "alpha",
          role: "governing",
          spanText: "alpha beta",
        }),
      ],
    });
    const r = pane(finding);
    expect(withClass(withClass(r, "passages-conflict")[0]!, "passage")).toHaveLength(2);
    expect(passages(r)).toHaveLength(3);
    expect(locationOf(passages(r)[0]!)).toBe("Mutual NDA (v1), Section 1, paragraph 1");
  });

  it("states the conflict and the status the workflow would not give", () => {
    const text = readable(first(root, (el) => attr(el, "aria-labelledby") === "found-heading"));
    expect(text).toContain(
      "Section 11.1 names Delaware law and Section 11.2 sends disputes to Singapore.",
    );
    expect(text).toContain("The workflow would not state a status");
  });
});

describe("FindingPane unverified quotes", () => {
  const root = pane(buildUnverifiedFinding());
  const bad = passages(root).find((p) => readable(p).includes("five (5) years after termination"))!;

  it("strikes the quote through and says it was not found and is never exported", () => {
    const struck = first(bad, (el) => el.name === "del" && hasClass(el, "unverified-quote"));
    expect(readable(struck)).toBe("shall continue for five (5) years after termination");
    const note = readable(first(bad, (el) => hasClass(el, "unverified-note")));
    expect(note).toBe(`Quote not verified: ${UNVERIFIED_QUOTE_NOTE}.`);
    expect(UNVERIFIED_QUOTE_NOTE).toBe("not found in the document, never exported");
    expect(readable(bad)).toContain("Quote not found");
  });

  it("does not highlight anything in it", () => {
    expect(all(bad, (el) => el.name === "mark")).toHaveLength(0);
  });

  it("keeps the cited paragraph one click away", () => {
    const details = first(bad, (el) => el.name === "details");
    expect(readable(first(details, (el) => el.name === "summary"))).toBe(
      "Show the paragraph it was cited from",
    );
    expect(textOf(first(details, (el) => hasClass(el, "doc-text")))).toContain(
      "The obligations of each Receiving Party",
    );
  });

  it("leaves the verified passages as they were", () => {
    const good = passages(root).filter((p) => p !== bad);
    expect(good).toHaveLength(3);
    for (const p of good) expect(all(p, (el) => el.name === "mark")).toHaveLength(1);
  });

  it("flags the finding as escalated by the system, with the failed check", () => {
    expect(readable(withClass(root, "pane-head")[0]!)).toContain("Quote not found");
    const check = withClass(root, "check-item")[0]!;
    expect(readable(check)).toContain("Failed");
    expect(readable(check)).toContain("1 of 4 quotes not found");
  });
});

describe("FindingPane quotes that cannot be placed", () => {
  it("shows an ambiguous quote without highlighting it, and says why", () => {
    const finding = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_amb",
          spanId: "s1",
          location: "Mutual NDA (v1), Section 4, paragraph 9",
          quote: "the Receiving Party",
          role: "governing",
          spanText: "the Receiving Party and the Receiving Party",
          quoteCheck: "ambiguous",
          offsets: null,
        }),
      ],
    });
    const p = passages(pane(finding))[0]!;
    expect(all(p, (el) => el.name === "mark")).toHaveLength(0);
    expect(readable(p)).toContain("appears more than once in this paragraph");
    expect(readable(p)).toContain("Quote found more than once");
    expect(readable(first(p, (el) => hasClass(el, "quoted")))).toBe("the Receiving Party");
    expect(all(p, (el) => hasClass(el, "unverified-note"))).toHaveLength(0);
  });

  it("never highlights from offsets it cannot use, even when the check says verified", () => {
    const finding = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_bad",
          spanId: "s1",
          location: "Mutual NDA (v1), Section 4, paragraph 9",
          quote: "alpha",
          role: "supporting",
          spanText: "alpha beta",
          offsets: { start: 9, end: 2 },
        }),
      ],
    });
    const p = passages(pane(finding))[0]!;
    expect(all(p, (el) => el.name === "mark")).toHaveLength(0);
    expect(textOf(first(p, (el) => hasClass(el, "doc-text")))).toContain("alpha");
  });

  it("highlights only what is in range when the offsets overhang", () => {
    const finding = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_over",
          spanId: "s1",
          location: "Mutual NDA (v1), Section 4, paragraph 9",
          quote: "beta",
          role: "supporting",
          spanText: "alpha beta",
          offsets: { start: 6, end: 400 },
        }),
      ],
    });
    const p = passages(pane(finding))[0]!;
    expect(readable(all(p, (el) => el.name === "mark")[0]!)).toBe("beta");
  });

  it("says when the paragraph text is missing", () => {
    const finding = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_gone",
          spanId: "s1",
          location: "Mutual NDA (v1), Section 4, paragraph 9",
          quote: "alpha",
          role: "supporting",
          spanText: "",
          offsets: null,
          quoteCheck: "ambiguous",
        }),
      ],
    });
    expect(readable(pane(finding))).toContain("The text of this paragraph is not available");
  });
});

describe("FindingPane checks, rule and suggestion", () => {
  const root = pane();

  it("lists every check in plain words with its outcome and kind", () => {
    const items = withClass(root, "check-item");
    expect(items).toHaveLength(7);
    expect(readable(items[0]!)).toContain("Passed");
    expect(readable(items[0]!)).toContain("Quotes appear word for word in the cited paragraphs");
    expect(readable(items[0]!)).toContain("Automatic check");
    expect(readable(items[4]!)).toContain("Not applicable");
    expect(readable(items[5]!)).toContain("Model check");
    expect(readable(items[5]!)).toContain(
      "A second check agrees the cited passages support the conclusion",
    );
    expect(
      readable(first(root, (el) => attr(el, "aria-labelledby") === "checks-heading")),
    ).toContain("6 passed, 0 failed, 1 not applicable.");
    expect(readable(root)).not.toContain("quote_exists");
    expect(readable(root)).not.toContain("numeric_consistency");
  });

  it("shows the rule's standard, fallback and unacceptable text", () => {
    const rule = first(root, (el) => attr(el, "aria-labelledby") === "rule-heading");
    const text = readable(rule);
    expect(text).toContain("Playbook rule (parol-nda-recipient 1.0.0)");
    expect(text).toContain("Obligations end three years or less after each disclosure.");
    expect(text).toContain("Obligations end five years or less after the agreement ends.");
    expect(text).toContain("Obligations that are perpetual or have no stated end");
  });

  it("leaves out a fallback or unacceptable text the rule does not have", () => {
    const f = buildFindingView();
    const r = pane({ ...f, rule: { ...f.rule, fallback: null, unacceptable: null } });
    const text = readable(first(r, (el) => attr(el, "aria-labelledby") === "rule-heading"));
    expect(text).not.toContain("Fallback");
    expect(text).not.toContain("Unacceptable");
  });

  it("shows the discrepancy and the explanation", () => {
    const text = readable(first(root, (el) => attr(el, "aria-labelledby") === "found-heading"));
    expect(text).toContain("Amendment No. 1 deletes Section 6.1, the only time limit");
    expect(text).toContain("The original two-year term in Section 6.1 no longer applies.");
    expect(text).toContain("The documents fall short of the playbook standard.");
  });

  it("shows the suggested language with its basis in plain words", () => {
    const section = first(root, (el) => attr(el, "aria-labelledby") === "suggestion-heading");
    expect(readable(first(section, (el) => hasClass(el, "suggestion")))).toMatch(
      /^6\.1 The obligations of each Receiving Party under Section 4/,
    );
    expect(readable(first(section, (el) => hasClass(el, "basis")))).toBe(
      "Basis: Approved playbook text, adapted to these documents.",
    );
  });

  it("offers the approved wording to compare with, behind a disclosure", () => {
    const details = first(
      root,
      (el) => el.name === "details" && readable(el).includes("Approved wording from the playbook"),
    );
    expect(readable(details)).toContain(
      "The obligations of each Receiving Party under this Agreement shall continue for three (3) years",
    );
  });

  it("says each basis in its own words", () => {
    const words = (basis: FindingView["fallbackBasis"]): string =>
      readable(
        first(pane(buildFindingView({ fallbackBasis: basis })), (el) => hasClass(el, "basis")),
      );
    expect(words("approved_verbatim")).toContain("unchanged");
    expect(words("generated")).toContain("not approved playbook text");
  });

  it("says when no language is suggested", () => {
    const r = pane(buildFindingView({ fallbackLanguage: null, fallbackBasis: "none" }));
    expect(readable(r)).toContain("No language is suggested for this finding");
    expect(withClass(r, "suggestion")).toHaveLength(0);
  });
});

describe("FindingPane decision form (screen S3)", () => {
  const root = pane();
  const form = first(root, (el) => el.name === "form");

  it("posts to the review URL of this finding", () => {
    expect(forms(root)).toHaveLength(1);
    expect(attr(form, "action")).toBe(urls.review(IDS.matter, IDS.finding));
  });

  it("binds the decision to the finding's content hash with a hidden field", () => {
    const hidden = controls(form, FIELDS.findingContentSha256);
    expect(hidden).toHaveLength(1);
    expect(attr(hidden[0]!, "type")).toBe("hidden");
    expect(attr(hidden[0]!, "value")).toBe(SHAS.finding);
  });

  it("offers accept, edit, reject and escalate, each described", () => {
    const radios = controls(form, FIELDS.decision);
    expect(radios.map((r) => attr(r, "value"))).toEqual(["accept", "edit", "reject", "escalate"]);
    for (const radio of radios) {
      expect(attr(radio, "type")).toBe("radio");
      expect(hasAttr(radio, "required")).toBe(true);
      expect(hasAttr(radio, "checked")).toBe(false);
      const hint = byId(root, attr(radio, "aria-describedby")!)!;
      expect(readable(hint).length).toBeGreaterThan(10);
    }
    expect(readable(form)).toContain("Accept");
    expect(readable(form)).toContain("Escalate");
  });

  it("asks for a reason and says when it is required", () => {
    expect(controls(form, FIELDS.reason)).toHaveLength(1);
    expect(readable(form)).toContain("Required for edit, reject and escalate.");
    expect(hasAttr(controls(form, FIELDS.reason)[0]!, "required")).toBe(false);
  });

  it("lets the reviewer edit status, discrepancy, fallback language and evidence roles", () => {
    const status = controls(form, FIELDS.status)[0]!;
    expect(byTag(status, "option").map((o) => attr(o, "value"))).toEqual([...STATUSES]);
    expect(
      byTag(status, "option")
        .filter((o) => hasAttr(o, "selected"))
        .map((o) => attr(o, "value")),
    ).toEqual(["deviation"]);
    // The first newline of a textarea is dropped by a browser, so the page adds one.
    expect(textOf(controls(form, FIELDS.discrepancy)[0]!)).toBe(
      `\n${buildFindingView().discrepancy}`,
    );
    expect(textOf(controls(form, FIELDS.fallbackLanguage)[0]!)).toBe(
      `\n${buildFindingView().fallbackLanguage}`,
    );
    expect(textOf(controls(form, FIELDS.reason)[0]!)).toBe("\n");
  });

  it("has a role select for every cited passage, set to its current role", () => {
    const finding = buildFindingView();
    for (const evidence of finding.evidence) {
      const select = controls(form, evidenceRoleField(evidence.evidenceId))[0]!;
      expect(byTag(select, "option").map((o) => attr(o, "value"))).toEqual([...EVIDENCE_ROLES]);
      const selected = byTag(select, "option").filter((o) => hasAttr(o, "selected"));
      expect(selected.map((o) => attr(o, "value"))).toEqual([evidence.role]);
      const label = all(
        root,
        (el) => el.name === "label" && attr(el, "for") === attr(select, "id"),
      )[0]!;
      expect(readable(label)).toBe(evidence.location);
    }
  });

  it("says the decision is bound to the finding as shown and goes stale if inputs change", () => {
    const binding = readable(withClass(form, "binding")[0]!);
    expect(binding).toContain("You are deciding dur-1 as shown");
    expect(binding).toContain(`content hash ${SHAS.finding.slice(0, 12)}`);
    expect(binding).toContain("If the documents or the playbook change, it becomes stale");
  });

  it("has a save button", () => {
    expect(readable(first(form, (el) => el.name === "button"))).toBe("Save decision");
  });

  it("shows the current decision and says a new one replaces it", () => {
    const decided = pane(buildDecidedFinding());
    expect(readable(first(decided, (el) => el.name === "form"))).toContain(
      "Currently edited by D. Whitfield. Saving a new decision replaces it.",
    );
  });
});

describe("FindingPane when the finding cannot be decided", () => {
  const noForm = (root: El): void => {
    expect(forms(root)).toHaveLength(0);
    expect(byTag(root, "textarea")).toHaveLength(0);
    expect(all(root, (el) => el.name === "input")).toHaveLength(0);
    expect(byTag(root, "select")).toHaveLength(0);
    expect(byTag(root, "button")).toHaveLength(0);
  };

  it("shows no form and the fixed reason for a stale finding", () => {
    const root = pane(buildStaleFinding());
    noForm(root);
    expect(readable(byId(root, "decision")!)).toContain(STALE_FINDING_REASON);
    expect(readable(withClass(root, "banner-stale")[0]!)).toContain("Out of date.");
    expect(readable(withClass(root, "pane-head")[0]!)).toContain("Out of date");
    expect(
      all(root, (el) => el.name === "a" && readable(el) === "Go to the decision"),
    ).toHaveLength(0);
  });

  it("treats a stale finding as undecidable even if the service says it may be decided", () => {
    const f = buildStaleFinding();
    const root = pane({ ...f, canDecide: { allowed: true, reason: null } });
    noForm(root);
    expect(readable(byId(root, "decision")!)).toContain(STALE_FINDING_REASON);
  });

  it("shows no form and the service's reason when the user may not decide", () => {
    const root = pane(buildUndecidableFinding("Only the reviewing attorney can decide findings."));
    noForm(root);
    expect(readable(byId(root, "decision")!)).toContain(
      "Only the reviewing attorney can decide findings.",
    );
    expect(
      all(root, (el) => el.name === "a" && readable(el) === "Go to the decision"),
    ).toHaveLength(0);
  });

  it("falls back to a fixed reason when the service gives none", () => {
    const root = pane(buildUndecidableFinding(""));
    expect(readable(byId(root, "decision")!)).toContain(
      `This finding cannot be decided here. ${CANNOT_DECIDE_REASON}`,
    );
    const none = pane({ ...buildFindingView(), canDecide: { allowed: false, reason: null } });
    expect(readable(byId(none, "decision")!)).toContain(CANNOT_DECIDE_REASON);
  });

  it("still shows the evidence, the checks and the history", () => {
    const root = pane(buildStaleFinding());
    expect(passages(root)).toHaveLength(3);
    expect(withClass(root, "check-item").length).toBeGreaterThan(0);
    expect(
      readable(first(root, (el) => attr(el, "aria-labelledby") === "history-heading")),
    ).toContain("D. Whitfield");
  });
});

describe("FindingPane review history", () => {
  it("says nobody has decided yet", () => {
    expect(
      readable(first(pane(), (el) => attr(el, "aria-labelledby") === "history-heading")),
    ).toContain("Nobody has decided this finding yet");
  });

  it("shows who decided what, when, why and what they changed", () => {
    const root = pane(buildDecidedFinding());
    const history = first(root, (el) => attr(el, "aria-labelledby") === "history-heading");
    const text = readable(history);
    expect(text).toContain("Edited");
    expect(text).toContain("Current");
    expect(text).toContain("D. Whitfield, 3 November 2026, 15:30 UTC");
    expect(text).toContain("The parties agreed two years in February.");
    expect(text).toContain("Fallback language changed to:");
    expect(text).toContain(
      "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years",
    );
    expect(text).toContain("Mutual NDA (v1), Section 9.3, paragraph 29 relabelled Governing.");
  });

  it("marks a decision that no longer counts", () => {
    const root = pane(buildStaleFinding());
    const item = withClass(root, "history")[0]!.children.find(
      (c): c is El => c.type === "element",
    )!;
    expect(hasClass(item, "is-stale")).toBe(true);
    expect(readable(item)).toContain("Out of date");
    expect(readable(item)).not.toContain("Current");
  });
});

describe("FindingPage", () => {
  const root = checkInvariants(findingPage());

  it("is a page of its own with the rule title as the one h1", () => {
    expect(readable(first(root, (el) => el.name === "h1"))).toBe(
      "Duration of confidentiality obligations",
    );
    expect(withClass(root, "finding-pane")).toHaveLength(1);
    expect(byTag(root, "h2").length).toBeGreaterThan(3);
  });

  it("links back to the matter", () => {
    const crumbs = first(root, (el) => hasClass(el, "crumbs"));
    expect(byTag(crumbs, "a").map((a) => attr(a, "href"))).toEqual([
      urls.matters(),
      urls.matter(IDS.matter),
    ]);
  });
});

describe("evidence role field names", () => {
  it("round trip", () => {
    expect(evidenceIdOfRoleField(evidenceRoleField("ev_1"))).toBe("ev_1");
    expect(evidenceIdOfRoleField(evidenceRoleField("a:b"))).toBe("a:b");
  });

  it("only recognise their own prefix", () => {
    expect(evidenceIdOfRoleField("reason")).toBeNull();
    expect(evidenceIdOfRoleField("evidenceRole:")).toBeNull();
    expect(evidenceIdOfRoleField("xevidenceRole:ev")).toBeNull();
  });
});
