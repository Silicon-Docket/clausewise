import { describe, expect, it } from "vitest";
import { buildMemo, MEMO_TITLE, SHORT_HASH_LENGTH } from "../../src/export/memo.js";
import type { MemoInput } from "../../src/module-contracts.js";
import {
  DUR_EDITED_FALLBACK,
  DUR_QUOTES,
  SPAN,
  bodyText,
  locationOf,
  memoFinding,
  passage,
  readMemo,
  replaceFinding,
  review,
  sectionOf,
  tableRows,
  verifiedFinding,
  withReview,
  workedExample,
  type ReadMemo,
} from "./support.js";

async function memoOf(input: MemoInput): Promise<ReadMemo> {
  return readMemo(await buildMemo(input));
}

const indexOfLine = (read: ReadMemo, startsWith: string, from = 0): number =>
  read.paragraphs.findIndex((line, at) => at >= from && line.startsWith(startsWith));

describe("memo layout", () => {
  it("opens with the demonstration banner, built from the constant", async () => {
    expect(MEMO_TITLE).toBe(
      "MEMORANDUM: DRAFT FOR ATTORNEY REVIEW. SYNTHETIC DEMONSTRATION, NOT LEGAL ADVICE.",
    );
    const read = await memoOf(workedExample());
    expect(read.paragraphs[0]).toBe(MEMO_TITLE);
    expect(read.headings[0]).toEqual([0, MEMO_TITLE]);
  });

  it("carries the banner at the top of every page, in the page header", async () => {
    const read = await memoOf(workedExample());
    const header = await read.zip.file("word/header1.xml")!.async("string");
    expect(header).toContain(
      "Draft for attorney review. Synthetic demonstration, not legal advice.",
    );
  });

  it("has a Re line with the matter, the documents and the playbook name and version", async () => {
    const read = await memoOf(workedExample());
    const re = read.paragraphs[1]!;
    expect(re).toBe(
      "Re: Lanternfish / Corvane NDA, Mutual NDA (v1) and Amendment No. 1 (v1), review against Parol NDA (Recipient) playbook 1.0.0",
    );
    expect(read.paragraphs[2]).toBe("Client: Lanternfish Software, Inc.");
    expect(read.paragraphs[3]).toBe("Date: 3 November 2026");
  });

  it("lists three documents with commas and an and", async () => {
    const input = workedExample();
    input.documents.push({
      label: "D3",
      title: "Amendment No. 2",
      versionNo: 2,
      statedDate: null,
      fileSha256: "ab".repeat(32),
    });
    const re = (await memoOf(input)).paragraphs[1]!;
    expect(re).toContain("Mutual NDA (v1), Amendment No. 1 (v1) and Amendment No. 2 (v2)");
  });

  it("orders the sections: open items, summary, findings, rejected appendix, provenance", async () => {
    const read = await memoOf(workedExample());
    const h1 = read.headings.filter(([level]) => level === 1).map(([, text]) => text);
    expect(h1).toEqual([
      "Open items",
      "Summary",
      "Findings",
      "Appendix A. Considered and rejected",
      "Appendix B. Provenance",
    ]);
    const order = (text: string) => read.headings.findIndex(([, heading]) => heading === text);
    expect(order("Open items")).toBeLessThan(order("Summary"));
    // The body agrees with the heading list: open items text sits before the summary table.
    expect(indexOfLine(read, "Open items")).toBeLessThan(indexOfLine(read, "Summary"));
  });

  it("has one section per finding, in the order the findings were given", async () => {
    const input = workedExample();
    const read = await memoOf(input);
    const h2 = read.headings.filter(([level]) => level === 2).map(([, text]) => text);
    expect(h2).toHaveLength(8);
    expect(h2.map((text) => /\(([A-Z]+-\d)/.exec(text)![1])).toEqual(
      input.findings.map((item) => item.finding.ruleKey.toUpperCase()),
    );
    expect(h2.map((text) => Number.parseInt(text, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Order is the caller's: reversing the input reverses the sections.
    const reversed = await memoOf({ ...input, findings: [...input.findings].reverse() });
    const rev = reversed.headings.filter(([level]) => level === 2).map(([, text]) => text);
    expect(rev[0]).toMatch(/^1\. Governing law and forum \(GOV-1/);
    expect(rev[7]).toMatch(/^8\. Parties correctly identified \(PTY-1/);
  });

  it("falls back to the category name when no rule title is given", async () => {
    const input = workedExample();
    delete input.ruleTitles;
    const read = await memoOf(input);
    const h2 = read.headings.filter(([level]) => level === 2).map(([, text]) => text);
    expect(h2[5]).toBe("6. Duration (DUR-1, high severity): deviation.");
    expect(tableRows(read)[0]![6]![1]).toBe("DUR-1 Duration");
  });
});

describe("summary table", () => {
  it("has a header and one row per rule in playbook order", async () => {
    const read = await memoOf(workedExample());
    const tables = tableRows(read);
    expect(tables).toHaveLength(1);
    const rows = tables[0]!;
    expect(rows[0]).toEqual(["No.", "Rule", "Severity", "Status", "Decision"]);
    expect(rows.slice(1)).toEqual([
      ["1", "PTY-1 Parties correctly identified", "Medium", "Compliant", "Accepted"],
      ["2", "DEF-1 Scope of Confidential Information", "Medium", "Compliant", "Accepted"],
      ["3", "EXC-1 Four standard exclusions", "High", "Compliant", "Accepted"],
      ["4", "PDS-1 Disclosure to representatives", "Medium", "Deviation (edited)", "Edited"],
      ["5", "PDS-2 Disclosure required by law", "Medium", "Missing", "Accepted (open item)"],
      ["6", "DUR-1 Duration of confidentiality obligations", "High", "Deviation", "Edited"],
      ["7", "RET-1 Return or destruction of information", "Low", "Compliant", "Accepted"],
      ["8", "GOV-1 Governing law and forum", "Medium", "Deviation", "Escalated (open item)"],
    ]);
  });

  it("shows the status as decided: a reviewer edit overrides the workflow's status", async () => {
    // pds-1 was compliant for the workflow and deviation for the reviewer.
    const input = workedExample();
    expect(input.findings[3]!.finding.status).toBe("compliant");
    const row = tableRows(await memoOf(input))[0]![4]!;
    expect(row[3]).toBe("Deviation (edited)");
  });

  it("states the counts of rules by severity", async () => {
    const read = await memoOf(workedExample());
    expect(bodyText(read)).toContain(
      "8 rule(s) reviewed against the Parol NDA (Recipient) playbook, version 1.0.0, in playbook order: 2 high, 5 medium, 1 low severity.",
    );
  });

  it("shows a rejected rule as having no conclusion", async () => {
    const input = withReview(
      workedExample(),
      "ret-1",
      review("reject", { reason: "Not relevant." }),
    );
    const row = tableRows(await memoOf(input))[0]![7]!;
    expect(row).toEqual([
      "7",
      "RET-1 Return or destruction of information",
      "Low",
      "No conclusion",
      "Rejected",
    ]);
  });
});

describe("open items", () => {
  it("lists the escalated finding with its reasons and the reviewer's reason", async () => {
    const read = await memoOf(workedExample());
    const start = indexOfLine(read, "Open items");
    const end = indexOfLine(read, "Summary");
    const open = read.paragraphs.slice(start, end).join("\n");
    expect(open).toContain("8. Governing law and forum (GOV-1, medium severity)");
    expect(open).toContain("Escalated by D. Whitfield on 3 November 2026");
    expect(open).toContain("The playbook says this situation goes to an attorney.");
    expect(open).toContain("Detail: escalateWhen forum-outside-list");
    expect(open).toContain(
      "Reviewer's reason: Forum outside the approved list. Send to the supervising partner.",
    );
  });

  it("lists an accepted finding that the workflow still escalates, with the escalation noted", async () => {
    const read = await memoOf(workedExample());
    const open = read.paragraphs
      .slice(indexOfLine(read, "Open items"), indexOfLine(read, "Summary"))
      .join("\n");
    expect(open).toContain("5. Disclosure required by law (PDS-2, medium severity)");
    expect(open).toContain(
      "Accepted by D. Whitfield on 3 November 2026, but the workflow's escalation stands.",
    );
    expect(open).toContain(
      "The finding says the topic is missing, but the documents hold passages that may cover it.",
    );
  });

  it("leaves out findings that are verified and decided", async () => {
    const read = await memoOf(workedExample());
    const open = read.paragraphs
      .slice(indexOfLine(read, "Open items"), indexOfLine(read, "Summary"))
      .join("\n");
    for (const closed of ["PTY-1", "DEF-1", "EXC-1", "PDS-1", "DUR-1", "RET-1"]) {
      expect(open).not.toContain(closed);
    }
  });

  it("says so when nothing is open", async () => {
    let input = workedExample();
    input = withReview(input, "gov-1", review("accept"));
    input = replaceFinding(input, "pds-2", (item) => ({
      ...item,
      finding: verifiedFinding({
        ruleKey: "pds-2",
        category: "permitted-disclosures",
        severity: "medium",
        status: "missing",
        discrepancy: "No clause covers disclosure required by law.",
      }),
    }));
    input = replaceFinding(input, "gov-1", (item) => ({
      ...item,
      finding: verifiedFinding({
        ruleKey: "gov-1",
        category: "governing-law",
        severity: "medium",
        status: "compliant",
        evidence: item.finding.evidence,
      }),
    }));
    const read = await memoOf(input);
    const open = read.paragraphs.slice(
      indexOfLine(read, "Open items"),
      indexOfLine(read, "Summary"),
    );
    expect(open[1]).toMatch(/^None\./);
    expect(read.headings.filter(([, text]) => text === "Open items")).toHaveLength(1);
  });

  it("keeps an edited finding open when the reviewer's status is still undetermined", async () => {
    const input = replaceFinding(workedExample(), "pty-1", (item) => ({
      finding: verifiedFinding({
        ruleKey: "pty-1",
        category: "parties",
        severity: "medium",
        status: "undetermined",
        abstainReason: "The parties passage was not in the context.",
        escalations: [{ code: "model_abstained", detail: "no status stated" }],
      }),
      locations: [],
      review: review("edit", {
        reason: "Reworded only.",
        edits: { discrepancy: "Check the preamble." },
      }),
    }));
    const read = await memoOf(input);
    const open = read.paragraphs
      .slice(indexOfLine(read, "Open items"), indexOfLine(read, "Summary"))
      .join("\n");
    expect(open).toContain("1. Parties correctly identified (PTY-1, medium severity)");
    expect(open).toContain("The decision leaves the rule without a stated status.");
    expect(open).toContain("The workflow declined to state a status.");
  });

  const flagged = (input: MemoInput): MemoInput =>
    replaceFinding(input, "dur-1", (item) => ({
      ...item,
      finding: {
        ...item.finding,
        escalations: [{ code: "support_not_confirmed", detail: "check support failed" }],
        verificationState: "escalated_by_system",
      },
    }));

  const openText = (read: ReadMemo): string =>
    read.paragraphs.slice(indexOfLine(read, "Open items"), indexOfLine(read, "Summary")).join("\n");

  it("does not list an edited finding when the reviewer changed the status it was flagged on", async () => {
    // The reviewer replaced the conclusion, so the workflow's doubt no longer decides the status.
    const input = replaceFinding(flagged(workedExample()), "dur-1", (item) => ({
      ...item,
      review: review("edit", { reason: "Not a deviation.", edits: { status: "compliant" } }),
    }));
    const read = await memoOf(input);
    expect(openText(read)).not.toContain("DUR-1");
    // The section still tells the reader about the flag.
    expect(bodyText(read)).toContain("The cited passages do not clearly establish the conclusion.");
  });

  it("does not list an edited finding when the reviewer rewrote the discrepancy it was flagged on", async () => {
    const input = replaceFinding(flagged(workedExample()), "dur-1", (item) => ({
      ...item,
      review: review("edit", {
        reason: "Reworded.",
        edits: { discrepancy: "Amendment No. 1 deletes the only time limit." },
      }),
    }));
    const read = await memoOf(input);
    expect(openText(read)).not.toContain("DUR-1");
    expect(bodyText(read)).toContain("The cited passages do not clearly establish the conclusion.");
  });

  it("keeps an edited finding open when the edit leaves the status and discrepancy as the workflow stated them", async () => {
    // The worked example edits the proposed language only, so the flagged conclusion stands.
    const read = await memoOf(flagged(workedExample()));
    const open = openText(read);
    expect(open).toContain("6. Duration of confidentiality obligations (DUR-1, high severity)");
    expect(open).toContain(
      "Edited by D. Whitfield on 3 November 2026, but the edit leaves the status and discrepancy as the workflow stated them, and the workflow's escalation stands.",
    );
    expect(open).toContain("The cited passages do not clearly establish the conclusion.");
    expect(open).toContain("Detail: check support failed");
    expect(open).toContain("Reviewer's reason: The parties agreed two years in February.");
    expect(tableRows(read)[0]![6]).toEqual([
      "6",
      "DUR-1 Duration of confidentiality obligations",
      "High",
      "Deviation",
      "Edited (open item)",
    ]);
    expect(sectionOf(read, 6)).toContain(
      "Open item: This finding is listed under Open items at the top.",
    );
  });

  it("keeps an edited finding open when the edit changes nothing the workflow flagged", async () => {
    const input = replaceFinding(flagged(workedExample()), "dur-1", (item) => ({
      ...item,
      review: review("edit", { reason: "Confirmed.", edits: null }),
    }));
    expect(openText(await memoOf(input))).toContain("DUR-1");
    // Setting the status or the discrepancy to what it already was changes nothing either.
    const same = replaceFinding(flagged(workedExample()), "dur-1", (item) => ({
      ...item,
      review: review("edit", {
        reason: "Confirmed.",
        edits: { status: "deviation", discrepancy: item.finding.discrepancy },
      }),
    }));
    expect(openText(await memoOf(same))).toContain("DUR-1");
  });

  it("does not list an edited finding that the workflow did not flag", async () => {
    expect(openText(await memoOf(workedExample()))).not.toContain("DUR-1");
  });
});

describe("the worked example finding (dur-1)", () => {
  async function section(): Promise<string[]> {
    return sectionOf(await memoOf(workedExample()), 6);
  }

  it("names the rule, the severity and the status, and who decided", async () => {
    const lines = await section();
    expect(lines[0]).toBe(
      "6. Duration of confidentiality obligations (DUR-1, high severity): deviation.",
    );
    expect(lines).toContain("Decision: Edited by D. Whitfield on 3 November 2026.");
    expect(lines).toContain("Status: Deviation.");
  });

  it("gives the discrepancy and the explanation", async () => {
    const lines = (await section()).join("\n");
    expect(lines).toContain(
      "Discrepancy: Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4",
    );
    expect(lines).toContain(
      "Explanation: The original two-year term in Section 6.1 no longer applies.",
    );
  });

  it("cites the governing quotation first, then supporting, then superseded, each with its location", async () => {
    const lines = await section();
    const at = (label: string) => lines.findIndex((line) => line.startsWith(label));
    const governing = at("Governing.");
    const supporting = at("Supporting.");
    const superseded = at("Superseded.");
    expect(governing).toBeGreaterThan(-1);
    expect(governing).toBeLessThan(supporting);
    expect(supporting).toBeLessThan(superseded);
    expect(lines[governing]).toBe(
      `Governing. "${DUR_QUOTES.governing}"\nLocation: Amendment No. 1 (v1), Section 2, paragraph 3`,
    );
    expect(lines[supporting]).toBe(
      `Supporting. "${DUR_QUOTES.supporting}"\nLocation: Mutual NDA (v1), Section 9.3, paragraph 29`,
    );
    expect(lines[superseded]).toBe(
      `Superseded. "${DUR_QUOTES.superseded}"\nLocation: Mutual NDA (v1), Section 6.1, paragraph 19`,
    );
  });

  it("shows the edited fallback with its basis and keeps the original in a note", async () => {
    const lines = await section();
    const edited = lines.find((line) => line.startsWith("Proposed language"))!;
    expect(edited).toBe(
      `Proposed language (edited by the reviewer; the workflow's version was approved playbook text, adapted): "${DUR_EDITED_FALLBACK}"`,
    );
    const original = lines.find((line) => line.startsWith("Original before edit:"))!;
    expect(original).toContain(
      "shall continue for three (3) years from the date of each disclosure",
    );
    expect(original).not.toContain("two (2) years");
    // Only the fallback was edited: status and discrepancy carry no edit mark.
    expect(lines).toContain("Status: Deviation.");
    expect(lines.some((line) => line.startsWith("Discrepancy:"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Discrepancy (edited"))).toBe(false);
  });

  it("gives the reviewer's note and says the workflow flagged nothing", async () => {
    const lines = await section();
    expect(lines).toContain(
      "Reviewer note: The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists.",
    );
    expect(lines).toContain("Flagged by the workflow: nothing.");
  });
});

describe("a finding section", () => {
  it("marks an overridden status, discrepancy and fallback as edited and keeps the originals", async () => {
    const read = await memoOf(workedExample());
    const start = read.paragraphs.findIndex((line) =>
      line.startsWith("4. Disclosure to representatives"),
    );
    const lines = read.paragraphs.slice(start, start + 14);
    expect(lines).toContain("Status: Deviation (edited by the reviewer).");
    expect(lines).toContain("Original before edit: Compliant.");
    expect(lines).toContain(
      "Discrepancy (edited by the reviewer): The clause does not let the Receiving Party share information with its affiliates.",
    );
    expect(lines).toContain("Original before edit: none stated.");
    expect(lines.find((line) => line.startsWith("Proposed language"))).toContain(
      "added by the reviewer; the workflow proposed none",
    );
  });

  it("does not mark an edit that leaves a field as it was", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", {
        reason: "Confirmed.",
        edits: {
          status: "deviation",
          discrepancy: item.finding.discrepancy,
          fallbackLanguage: item.finding.fallbackLanguage ?? "",
        },
      }),
    }));
    const section = sectionOf(await memoOf(input), 6).join("\n");
    expect(section).toContain("Decision: Edited by D. Whitfield");
    expect(section).not.toContain("edited by the reviewer");
    expect(section).not.toContain("Original before edit");
    expect(section).not.toContain("original status");
  });

  it("shows the reviewer removing the proposed language", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", {
        reason: "Leave it to the partner.",
        edits: { fallbackLanguage: "  " },
      }),
    }));
    const text = bodyText(await memoOf(input));
    expect(text).toContain(
      "Proposed language (edited by the reviewer): None. The reviewer removed it.",
    );
    expect(text).toContain(
      'Original before edit: "The obligations of each Receiving Party under this Agreement',
    );
  });

  it("explains each basis of the proposed language in plain words", async () => {
    const text = bodyText(await memoOf(workedExample()));
    // pds-2 adapted, gov-1 verbatim.
    expect(text).toContain("Proposed language (approved playbook text, adapted):");
    expect(text).toContain("Proposed language (approved playbook text):");
    const generated = replaceFinding(workedExample(), "gov-1", (item) => ({
      ...item,
      finding: { ...item.finding, fallbackBasis: "generated" },
    }));
    expect(bodyText(await memoOf(generated))).toContain(
      "Proposed language (text generated by the workflow, not approved playbook text):",
    );
  });

  it("orders passages governing, supporting, definition, superseded, conflicting whatever order they arrive in", async () => {
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "undetermined",
      evidence: [
        passage(SPAN.d1Duration, DUR_QUOTES.superseded, "conflicting"),
        passage(SPAN.d1Survival, DUR_QUOTES.supporting, "superseded"),
        passage(SPAN.d1Definition, "means non-public information", "definition"),
        passage(SPAN.d2Deletes, DUR_QUOTES.governing, "supporting"),
        passage(SPAN.d1Return, "Within ten (10) business days", "governing"),
        passage(SPAN.d1Law, "exclusive jurisdiction", "governing"),
      ],
      abstainReason: "The passages disagree.",
      conflict: "Section 6.1 and the amendment disagree.",
      escalations: [{ code: "conflicting_sources", detail: "c19 against c40" }],
    });
    const input = replaceFinding(workedExample(), "dur-1", () =>
      memoFinding(finding, review("escalate", { reason: "Partner." })),
    );
    const read = await memoOf(input);
    const own = sectionOf(read, 6)
      .filter((line) => /^(Governing|Supporting|Definition|Superseded|Conflicting)\. /.test(line))
      .map((line) => line.split(".")[0]);
    expect(own).toEqual([
      "Governing",
      "Governing",
      "Supporting",
      "Definition",
      "Superseded",
      "Conflicting",
    ]);
    // Equal roles keep the order they arrived in.
    const governing = sectionOf(read, 6).filter((line) => line.startsWith("Governing."));
    expect(governing[0]).toContain("Within ten (10) business days");
    expect(governing[1]).toContain("exclusive jurisdiction");
    expect(bodyText(read)).toContain("Why no status is stated: The passages disagree.");
    expect(bodyText(read)).toContain(
      "Conflict between passages: Section 6.1 and the amendment disagree.",
    );
  });

  it("omits a quotation whose stored check is not_found, counts it, and never prints it", async () => {
    const lost = "This sentence was never in the document";
    const finding = verifiedFinding({
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "deviation",
      evidence: [
        passage(SPAN.d2Deletes, DUR_QUOTES.governing, "governing"),
        passage(SPAN.d1Duration, lost, "superseded", "not_found"),
        passage(SPAN.d1Survival, lost + " either", "supporting", "not_found"),
      ],
      discrepancy: "The time limit was deleted.",
      escalations: [{ code: "quote_not_verified", detail: "2 quotes not found in c19 and c29" }],
    });
    const input = replaceFinding(workedExample(), "dur-1", () =>
      memoFinding(finding, review("accept")),
    );
    const read = await memoOf(input);
    const text = bodyText(read);
    // In the finding's own section, where the reader meets the missing passages.
    const section = sectionOf(read, 6);
    expect(section).toContain("2 quotation(s) could not be verified and are omitted.");
    expect(section.join("\n")).not.toContain(lost);
    expect(text).not.toContain(lost);
    expect(text).toContain(DUR_QUOTES.governing);
    // Provenance counts them too, and still says the shown ones were checked.
    expect(text).toContain(
      "8 quotation(s) are shown. 2 quotation(s) could not be verified and are omitted.",
    );
  });

  it("says nothing about omitted quotations when none were omitted", async () => {
    const text = bodyText(await memoOf(workedExample()));
    expect(text).not.toContain("could not be verified");
  });

  it("notes a quotation that occurs more than once in its paragraph", async () => {
    const input = workedExample();
    input.spanTexts[SPAN.d1Survival] =
      `${input.spanTexts[SPAN.d1Survival]} ${input.spanTexts[SPAN.d1Survival]}`;
    const text = bodyText(await memoOf(input));
    expect(text).toContain(
      `${locationOf(SPAN.d1Survival)}. These words occur 2 times in this paragraph.`,
    );
  });

  it("describes a system escalation in plain words with its detail", async () => {
    const text = bodyText(await memoOf(workedExample()));
    expect(text).toContain("Flagged by the workflow:");
    expect(text).toContain(
      "The playbook says this situation goes to an attorney. Detail: escalateWhen forum-outside-list",
    );
  });

  it("says so when a system escalation has no code it can describe", async () => {
    const input = replaceFinding(workedExample(), "gov-1", (item) => ({
      ...item,
      finding: {
        ...item.finding,
        escalations: [{ code: "something_new" as never, detail: "" }],
      },
    }));
    expect(bodyText(await memoOf(input))).toContain(
      "The workflow raised a flag that this memo has no wording for.",
    );
  });
});

describe("a reviewer's override of the status", () => {
  const WRITTEN = "written by the workflow for the original status, Deviation";
  const NOTE =
    "The reviewer changed the status. The discrepancy, explanation, cited passages and proposed language below that are not marked as edited by the reviewer were written by the workflow for the original status, Deviation, and have not been revised to match.";

  const overridden = (status: string): MemoInput =>
    replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", {
        reason: "I disagree",
        edits: { status },
      }),
    }));

  it.each([
    ["compliant", "Compliant"],
    ["not_applicable", "Not applicable"],
    ["missing", "Missing"],
  ])(
    "marks the workflow's text as written for the original status when it becomes %s",
    async (status, label) => {
      const read = await memoOf(overridden(status));
      const lines = sectionOf(read, 6);
      expect(lines[0]).toBe(
        `6. Duration of confidentiality obligations (DUR-1, high severity): ${label.toLowerCase()}.`,
      );
      expect(lines).toContain(`Status: ${label} (edited by the reviewer).`);
      expect(lines).toContain("Original before edit: Deviation.");
      expect(lines).toContain(NOTE);
      const starting = (prefix: string) => lines.find((line) => line.startsWith(prefix));
      expect(starting("Discrepancy")).toMatch(
        new RegExp(`^Discrepancy \\(${WRITTEN}\\): Amendment No\\. 1 deletes Section 6\\.1`),
      );
      expect(starting("Explanation")).toMatch(
        new RegExp(`^Explanation \\(${WRITTEN}\\): The original two-year term`),
      );
      expect(starting("Cited passages")).toBe(
        `Cited passages (cited by the workflow for the original status, Deviation):`,
      );
      expect(starting("Proposed language")).toMatch(
        new RegExp(
          `^Proposed language \\(approved playbook text, adapted; ${WRITTEN}\\): "The obligations`,
        ),
      );
      // The quotations themselves are the document's words and are still shown with their roles.
      expect(lines).toContain(
        `Governing. "${DUR_QUOTES.governing}"\nLocation: Amendment No. 1 (v1), Section 2, paragraph 3`,
      );
      // The summary says what the reviewer decided, and the section no longer contradicts it silently.
      expect(tableRows(read)[0]![6]![3]).toBe(`${label} (edited)`);
    },
  );

  it("marks a conflict between passages the same way", async () => {
    const input = replaceFinding(overridden("compliant"), "dur-1", (item) => ({
      ...item,
      finding: { ...item.finding, conflict: "Section 6.1 and Section 2 disagree." },
    }));
    expect(sectionOf(await memoOf(input), 6)).toContain(
      `Conflict between passages (${WRITTEN}): Section 6.1 and Section 2 disagree.`,
    );
  });

  it("leaves what the reviewer wrote as the reviewer's, and marks only what the workflow wrote", async () => {
    // pds-1 changes the status, the discrepancy and the language, and keeps the workflow's explanation.
    const lines = sectionOf(await memoOf(workedExample()), 4);
    const written = "written by the workflow for the original status, Compliant";
    expect(lines).toContain("Status: Deviation (edited by the reviewer).");
    expect(
      lines
        .find((line) => line.startsWith("Discrepancy"))!
        .startsWith("Discrepancy (edited by the reviewer): "),
    ).toBe(true);
    expect(
      lines
        .find((line) => line.startsWith("Proposed language"))!
        .startsWith("Proposed language (added by the reviewer; the workflow proposed none): "),
    ).toBe(true);
    expect(lines).toContain(
      `Explanation (${written}): Employees and advisers may receive the information.`,
    );
    expect(lines).toContain(
      `Cited passages (cited by the workflow for the original status, Compliant):`,
    );
    // Of the workflow's text, only the explanation is left, and it is the only labelled line.
    expect(lines.filter((line) => line.includes(`(${written})`))).toHaveLength(1);
  });

  it("marks nothing when the status is as the workflow had it", async () => {
    const read = await memoOf(workedExample());
    // Only pds-1, whose status the reviewer changed, is marked.
    for (let number = 1; number <= 8; number += 1) {
      const marked = sectionOf(read, number).join("\n").includes("original status");
      expect(marked, `section ${number}`).toBe(number === 4);
    }
    const same = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("edit", { reason: "Confirmed.", edits: { status: "deviation" } }),
    }));
    expect(sectionOf(await memoOf(same), 6).join("\n")).not.toContain("original status");
  });

  it("does not mark an accepted or escalated finding, whose status is the workflow's", async () => {
    for (const next of [review("accept"), review("escalate", { reason: "Send on." })]) {
      const read = await memoOf(withReview(workedExample(), "dur-1", next));
      expect(sectionOf(read, 6).join("\n")).not.toContain("original status");
    }
  });
});

describe("what a reviewer's edits are read as", () => {
  const edited = (edits: unknown, decision: "edit" | "accept" = "edit"): MemoInput =>
    replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review(decision, { reason: "x", edits: edits as never }),
    }));

  it("reads a null edited field as no edit at all, not as an edit to empty text", async () => {
    const read = await memoOf(edited({ status: null, discrepancy: null, fallbackLanguage: null }));
    const lines = sectionOf(read, 6);
    const text = lines.join("\n");
    expect(text).not.toContain("None stated.");
    expect(text).not.toContain("The reviewer removed it.");
    expect(text).not.toContain("edited by the reviewer");
    expect(text).not.toContain("Original before edit");
    expect(text).not.toContain("original status");
    // It reads exactly as the same decision with no edits.
    const none = sectionOf(await memoOf(edited(null)), 6);
    expect(lines).toEqual(none);
  });

  it("still reads an empty string as the reviewer removing the proposed language", async () => {
    const text = sectionOf(await memoOf(edited({ fallbackLanguage: "" })), 6).join("\n");
    expect(text).toContain(
      "Proposed language (edited by the reviewer): None. The reviewer removed it.",
    );
  });

  it("reads the other fields of an edit that nulls only one of them", async () => {
    const text = sectionOf(
      await memoOf(edited({ discrepancy: null, fallbackLanguage: "Replacement." })),
      6,
    ).join("\n");
    expect(text).toContain("Discrepancy: Amendment No. 1 deletes Section 6.1");
    expect(text).toContain("Proposed language (edited by the reviewer; the workflow's version was");
    expect(text).toContain('"Replacement."');
  });

  it("does not turn an accepted finding into an edited one", async () => {
    // Edits with no field in them are not edits.
    const read = await memoOf(edited({ status: null, discrepancy: undefined }, "accept"));
    const lines = sectionOf(read, 6);
    expect(lines).toContain("Decision: Accepted by D. Whitfield on 3 November 2026.");
    expect(lines).toContain("Status: Deviation.");
    expect(lines.join("\n")).not.toContain("edited by the reviewer");
  });
});

describe("rejected findings", () => {
  function rejectedInput(): MemoInput {
    return withReview(
      workedExample(),
      "dur-1",
      review("reject", { reason: "The amendment was withdrawn before signature." }),
    );
  }

  it("go in the Considered and rejected appendix with the reviewer's reason", async () => {
    const read = await memoOf(rejectedInput());
    const start = read.paragraphs.findIndex(
      (line) => line === "Appendix A. Considered and rejected",
    );
    const end = read.paragraphs.findIndex((line) => line === "Appendix B. Provenance");
    const appendix = read.paragraphs.slice(start, end);
    expect(appendix).toContain("6. Duration of confidentiality obligations (DUR-1, high severity)");
    expect(appendix).toContain("Rejected by D. Whitfield on 3 November 2026.");
    expect(appendix).toContain("Reviewer's reason: The amendment was withdrawn before signature.");
    // The workflow's proposed status is its conclusion for a rule the reviewer rejected, so the
    // appendix does not repeat it.
    expect(appendix.join("\n")).not.toContain("proposed the status");
    expect(appendix.join("\n")).not.toMatch(/deviation|compliant|missing|undetermined/i);
  });

  it("list nothing of the workflow's conclusion for any status it proposed", async () => {
    for (const [ruleKey, word] of [
      ["pty-1", /compliant/i],
      ["pds-2", /missing/i],
      ["dur-1", /deviation/i],
    ] as const) {
      const read = await memoOf(
        withReview(workedExample(), ruleKey, review("reject", { reason: "No." })),
      );
      const start = read.paragraphs.findIndex(
        (line) => line === "Appendix A. Considered and rejected",
      );
      const end = read.paragraphs.findIndex((line) => line === "Appendix B. Provenance");
      expect(read.paragraphs.slice(start, end).join("\n"), ruleKey).not.toMatch(word);
    }
  });

  it("do not repeat the finding's evidence or conclusion anywhere", async () => {
    const read = await memoOf(rejectedInput());
    const text = bodyText(read);
    for (const secret of [
      DUR_QUOTES.governing,
      DUR_QUOTES.superseded,
      "only time limit on the obligations",
      "original two-year term",
      "6.1 The obligations of each Receiving Party under Section 4",
      "shall continue for three (3) years",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(sectionOf(read, 6)).toEqual([
      "6. Duration of confidentiality obligations (DUR-1, high severity): rejected, no conclusion.",
      "Decision: Rejected by D. Whitfield on 3 November 2026.",
      "This memorandum states no conclusion for this rule. The finding is listed under Considered and rejected.",
    ]);
  });

  it("are not open items, even when the workflow escalated them", async () => {
    const read = await memoOf(
      withReview(workedExample(), "pds-2", review("reject", { reason: "Covered elsewhere." })),
    );
    const open = read.paragraphs
      .slice(indexOfLine(read, "Open items"), indexOfLine(read, "Summary"))
      .join("\n");
    expect(open).not.toContain("PDS-2");
  });

  it("say so when there are none", async () => {
    const read = await memoOf(workedExample());
    const start = read.paragraphs.findIndex(
      (line) => line === "Appendix A. Considered and rejected",
    );
    expect(read.paragraphs[start + 1]).toBe("None. The reviewer rejected no finding.");
  });

  it("say when no reason was recorded", async () => {
    const read = await memoOf(withReview(workedExample(), "dur-1", review("reject")));
    expect(bodyText(read)).toContain("Reviewer's reason: none recorded.");
  });
});

describe("provenance appendix", () => {
  async function lines(input: MemoInput = workedExample()): Promise<string[]> {
    const read = await memoOf(input);
    const start = read.paragraphs.findIndex((line) => line === "Appendix B. Provenance");
    return read.paragraphs.slice(start + 1);
  }

  it("records the run, workflow, playbook and model", async () => {
    const input = workedExample();
    const out = await lines(input);
    expect(out).toContain("Matter: mat_0142.");
    expect(out).toContain("Run: run_0142, started 2 November 2026.");
    expect(out).toContain(
      `Workflow: v2, hash ${input.run.workflowSha256.slice(0, SHORT_HASH_LENGTH)}.`,
    );
    expect(out).toContain(
      `Playbook: parol-nda-recipient 1.0.0 (Parol NDA (Recipient)), hash ${input.playbook.sha256.slice(0, SHORT_HASH_LENGTH)}.`,
    );
    expect(out).toContain(
      "Model: requested anthropic claude-test-model; reported by the provider: claude-test-model-20260101.",
    );
    expect(SHORT_HASH_LENGTH).toBe(12);
  });

  it("says the model was not reported when the provider gave no name", async () => {
    const input = workedExample();
    input.run.modelReported = null;
    expect(await lines(input)).toContain(
      "Model: requested anthropic claude-test-model; reported by the provider: not reported.",
    );
  });

  it("says that a scripted stand-in read the documents, and says it only for a stand-in", async () => {
    // The memorandum is the file that leaves the system, so the statement must be in it.
    for (const provider of ["simulated", "scripted"]) {
      const input = workedExample();
      input.run.modelProvider = provider;
      const out = await lines(input);
      expect(out, provider).toContain(
        "Stand-in reader: The findings in this memorandum were produced by a scripted stand-in program, not a language model. They are not an analysis of these documents by any model.",
      );
      // It sits with the model line, before the hashes.
      const at = out.findIndex((line) => line.startsWith("Stand-in reader:"));
      expect(out[at - 1]?.startsWith("Model:")).toBe(true);
    }
    const real = await lines(workedExample());
    expect(real.some((line) => line.startsWith("Stand-in reader:"))).toBe(false);
  });

  it("prints the manifest hash and each document's hash in full", async () => {
    const input = workedExample();
    const out = (await lines(input)).join("\n");
    expect(out).toContain(`Manifest hash: ${input.run.manifestSha256}`);
    expect(out).toContain(
      `D1: Mutual NDA, version 1, stated date 2 February 2026. File hash: ${input.documents[0]!.fileSha256}`,
    );
    expect(out).toContain(
      `D2: Amendment No. 1, version 1, stated date 15 September 2026. File hash: ${input.documents[1]!.fileSha256}`,
    );
  });

  it("prints a document with no stated date as not stated", async () => {
    const input = workedExample();
    input.documents[1]!.statedDate = null;
    expect((await lines(input)).join("\n")).toContain(
      "D2: Amendment No. 1, version 1, stated date not stated.",
    );
  });

  it("counts the decisions", async () => {
    expect(await lines()).toContain(
      "Findings: 8; decided: 8 (accepted 5, edited 2, rejected 0, escalated 1).",
    );
    let input = withReview(workedExample(), "pty-1", review("reject", { reason: "No." }));
    input = withReview(input, "def-1", review("escalate", { reason: "Ask." }));
    expect(await lines(input)).toContain(
      "Findings: 8; decided: 8 (accepted 3, edited 2, rejected 1, escalated 2).",
    );
  });

  it("says who exported and when, from the input and not the clock", async () => {
    const input = workedExample();
    input.exportedBy = "A. Ruiz";
    input.exportedAt = "2031-01-09T23:59:59.999Z";
    const out = await lines(input);
    expect(out).toContain("Exported by: A. Ruiz on 9 January 2031 (UTC).");
  });

  it("states that each quotation was checked against the stored text at export", async () => {
    const out = (await lines()).join("\n");
    expect(out).toContain(
      "Each quotation in this memorandum was checked against the stored document text at export.",
    );
  });

  it("says the reviewer and associate were one person only when they were", async () => {
    const same = workedExample();
    same.segregationRelaxed = true;
    expect((await lines(same)).join("\n")).toContain(
      "The reviewer and the associate were the same person for this matter",
    );
    expect((await lines()).join("\n")).not.toContain("same person");
  });
});

describe("dates", () => {
  it.each([
    ["2026-11-03T14:05:00.000Z", "3 November 2026"],
    ["2026-11-03", "3 November 2026"],
    ["2026-11-03T23:30:00-05:00", "4 November 2026"],
    ["2026-11-03T00:30:00+02:00", "2 November 2026"],
    ["2026-01-01T00:00:00Z", "1 January 2026"],
    ["2026-12-31T23:59:59Z", "31 December 2026"],
  ])("writes %s as %s in UTC", async (iso, words) => {
    const input = workedExample();
    input.exportedAt = iso;
    const read = await memoOf(input);
    expect(read.paragraphs[3]).toBe(`Date: ${words}`);
    expect(bodyText(read)).toContain(`Exported by: D. Whitfield on ${words} (UTC).`);
  });
});

describe("the file", () => {
  it("is a Word package with the parts Word expects", async () => {
    const read = await memoOf(workedExample());
    const names = Object.keys(read.zip.files);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/header1.xml",
      "word/footer1.xml",
      "docProps/core.xml",
    ]) {
      expect(names).toContain(part);
    }
    const bytes = await buildMemo(workedExample());
    // A zip starts with PK.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("gives the heading styles an outline level, so Word and screen readers can navigate by them", async () => {
    const read = await memoOf(workedExample());
    const styles = await read.zip.file("word/styles.xml")!.async("string");
    const style = (id: string) =>
      new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>.*?</w:style>`).exec(styles)![0];
    expect(style("Heading1")).toContain('<w:outlineLvl w:val="0"/>');
    expect(style("Heading2")).toContain('<w:outlineLvl w:val="1"/>');
  });

  it("numbers the pages in the footer", async () => {
    const read = await memoOf(workedExample());
    const footer = await read.zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
  });

  it("marks the first row of the summary table as a repeating header", async () => {
    const read = await memoOf(workedExample());
    expect(read.documentXml).toMatch(/<w:tblHeader\/>/);
  });
});
