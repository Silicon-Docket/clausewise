import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
} from "docx";
import {
  BASIS_LABEL,
  DECISION_LABEL,
  MEMO_PAGE_BANNER,
  MEMO_TITLE,
  SEVERITIES_IN_ORDER,
  SEVERITY_LABEL,
  SHORT_HASH_LENGTH,
  STATUS_LABEL,
} from "./labels.js";
import { STAND_IN_MEMO_TEXT, isStandInProvider } from "../stand-in.js";
import type { FindingView, MemoPlan, OpenReason } from "./plan.js";
import { splitLines } from "./sanitize.js";

/**
 * Turns a checked plan into a Word file. Every string from a document, a model or a person goes
 * into a `TextRun` as text, one run per line, and nowhere else: there is no field, no hyperlink and
 * no markup built from it, so nothing in it can be read as an instruction by Word.
 */

const FONT = "Calibri";
const MONO = "Consolas";
const INK = "1F2937";
const MUTED = "4B5563";
const ACCENT = "8A1C1C";
const RULE = "9CA3AF";
const HEAD_FILL = "E5E7EB";

const BODY_SIZE = 22;
const SMALL_SIZE = 19;

/** US Letter with one inch margins: 12240 less 2880 twentieths of a point. */
const PAGE = { width: 12240, height: 15840 };
const CONTENT_WIDTH = 9360;
const SUMMARY_COLUMNS = [600, 3960, 1100, 1800, 1900] as const;

type RunStyle = Omit<IRunOptions, "text" | "children" | "break">;

function runs(text: string, style: RunStyle = {}): TextRun[] {
  return splitLines(text).map(
    (line, at) => new TextRun({ ...style, text: line, ...(at > 0 ? { break: 1 } : {}) }),
  );
}

const bold = (text: string): TextRun => new TextRun({ text, bold: true });

function para(children: TextRun[], extra: { style?: string; keepNext?: boolean } = {}): Paragraph {
  return new Paragraph({
    children,
    ...(extra.style !== undefined ? { style: extra.style } : {}),
    ...(extra.keepNext === true ? { keepNext: true } : {}),
  });
}

const text = (body: string): Paragraph => para(runs(body));

const labelled = (label: string, body: string): Paragraph =>
  para([bold(`${label} `), ...runs(body)]);

const note = (body: string): Paragraph => para(runs(body), { style: "Note" });

const bullet = (children: TextRun[]): Paragraph =>
  new Paragraph({ children, numbering: { reference: "bullets", level: 0 } });

const heading1 = (body: string): Paragraph =>
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(body) });

const heading2 = (body: string): Paragraph =>
  new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: runs(body) });

const mono = (body: string): TextRun => new TextRun({ text: body, font: MONO, size: SMALL_SIZE });

function statusWords(view: FindingView): string {
  if (view.decision === "reject") return "rejected, no conclusion";
  const label = STATUS_LABEL[view.status].toLowerCase();
  return view.decision === "escalate" ? `${label}, open item` : label;
}

function headingText(view: FindingView): string {
  return `${view.number}. ${view.title} (${view.ruleId}, ${view.severity} severity): ${statusWords(view)}.`;
}

/**
 * What to say of text the workflow wrote when the reviewer has set a different status from the one
 * it wrote it for: the discrepancy, the explanation, the cited passages and the proposed language
 * all argue the original status, and a section that printed them unmarked under the reviewer's
 * status would contradict its own heading. Null when the status is the workflow's.
 */
const writtenForOriginal = (view: FindingView): string | null => {
  if (!view.statusEdited) return null;
  // When the playbook settled the status before the reviewer changed it, the workflow wrote its
  // text for the status it stated, which is not the one it was settled to.
  return view.modelStatus !== null
    ? `written by the workflow for the status it stated, ${STATUS_LABEL[view.modelStatus]}`
    : `written by the workflow for the original status, ${STATUS_LABEL[view.proposedStatus]}`;
};

/** A label for text the workflow wrote, marked when the reviewer's status is not the one it argues. */
function workflowLabel(view: FindingView, label: string): string {
  const written = writtenForOriginal(view);
  return written === null ? `${label}:` : `${label} (${written}):`;
}

const decidedLine = (view: FindingView): string =>
  `${DECISION_LABEL[view.decision]} by ${view.reviewerName} on ${view.decidedOn}.`;

const OPEN_WORDS: Record<OpenReason, (view: FindingView) => string> = {
  escalated_by_reviewer: (view) =>
    `Escalated by ${view.reviewerName} on ${view.decidedOn}, and left open for a decision elsewhere.`,
  accepted_with_system_flags: (view) =>
    `Accepted by ${view.reviewerName} on ${view.decidedOn}, but the workflow's escalation stands.`,
  edited_with_system_flags: (view) =>
    `Edited by ${view.reviewerName} on ${view.decidedOn}, but the edit leaves the status and discrepancy as the workflow stated them, and the workflow's escalation stands.`,
  no_status_stated: (view) =>
    `${decidedLine(view)} The decision leaves the rule without a stated status.`,
};

function flagBullets(view: FindingView): Paragraph[] {
  if (view.flags.length === 0) {
    return view.systemEscalated
      ? [bullet(runs("The workflow could not stand behind this finding."))]
      : [];
  }
  return view.flags.map((flag) =>
    bullet(runs(flag.detail === "" ? flag.plain : `${flag.plain} Detail: ${flag.detail}`)),
  );
}

/**
 * What the upload said about the files: Word content the review did not read, tracked changes it
 * read as accepted, and paragraphs that read like an instruction to software. It comes before the
 * open items because a reader of the file alone cannot otherwise tell that the review did not see
 * all of it, and the sentence under Provenance about quotations says nothing of that.
 */
function documentWarnings(plan: MemoPlan): Paragraph[] {
  if (plan.documentWarnings.length === 0) return [];
  return [
    heading1("Document warnings"),
    text(
      "The upload of these documents raised the warnings below. Read the source files for each before relying on this memorandum.",
    ),
    ...plan.documentWarnings.map((warning) => bullet(runs(warning.text))),
  ];
}

function openItems(plan: MemoPlan): Paragraph[] {
  const out: Paragraph[] = [heading1("Open items")];
  // The list below is about findings only, so it points at the warnings: "None" read alone would
  // say more than the memorandum can stand behind.
  const pointer =
    plan.documentWarnings.length > 0
      ? [text("The upload raised document warnings, which are listed above.")]
      : [];
  if (plan.open.length === 0) {
    out.push(
      text(
        "None. No finding was escalated by the reviewer, and no accepted finding is still escalated by the workflow.",
      ),
      ...pointer,
    );
    return out;
  }
  out.push(
    text(
      "These findings need an attorney's attention before anyone relies on this memorandum. Each is also set out in full under Findings.",
    ),
    ...pointer,
  );
  for (const view of plan.open) {
    out.push(
      para([bold(`${view.number}. ${view.title} (${view.ruleId}, ${view.severity} severity)`)], {
        keepNext: true,
      }),
    );
    if (view.openReason !== null) out.push(bullet(runs(OPEN_WORDS[view.openReason](view))));
    out.push(...flagBullets(view));
    out.push(
      bullet(
        runs(
          view.reason === null
            ? "Reviewer's reason: none recorded."
            : `Reviewer's reason: ${view.reason}`,
        ),
      ),
    );
  }
  return out;
}

function cell(width: number, children: TextRun[], options: { header?: boolean } = {}): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    ...(options.header === true
      ? { shading: { type: ShadingType.CLEAR, fill: HEAD_FILL, color: "auto" } }
      : {}),
    children: [new Paragraph({ spacing: { after: 0 }, children })],
  });
}

function summaryStatus(view: FindingView): string {
  if (view.decision === "reject") return "No conclusion";
  return `${STATUS_LABEL[view.status]}${view.statusEdited ? " (edited)" : ""}`;
}

function summaryTable(plan: MemoPlan): Table {
  const small: RunStyle = { size: SMALL_SIZE };
  const head = ["No.", "Rule", "Severity", "Status", "Decision"].map((label, at) =>
    cell(SUMMARY_COLUMNS[at] ?? 1000, [new TextRun({ text: label, bold: true, ...small })], {
      header: true,
    }),
  );
  const rows = plan.findings.map(
    (view) =>
      new TableRow({
        cantSplit: true,
        children: [
          cell(SUMMARY_COLUMNS[0], runs(String(view.number), small)),
          cell(SUMMARY_COLUMNS[1], [
            new TextRun({ text: view.ruleId, bold: true, ...small }),
            new TextRun({ text: " ", ...small }),
            ...runs(view.title, small),
          ]),
          cell(SUMMARY_COLUMNS[2], runs(SEVERITY_LABEL[view.severity] ?? view.severity, small)),
          cell(SUMMARY_COLUMNS[3], runs(summaryStatus(view), small)),
          cell(
            SUMMARY_COLUMNS[4],
            runs(
              `${DECISION_LABEL[view.decision]}${view.openReason !== null ? " (open item)" : ""}`,
              small,
            ),
          ),
        ],
      }),
  );
  const line = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [...SUMMARY_COLUMNS],
    layout: TableLayoutType.FIXED,
    borders: {
      top: line,
      bottom: line,
      left: line,
      right: line,
      insideHorizontal: line,
      insideVertical: line,
    },
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: head }), ...rows],
  });
}

function summary(plan: MemoPlan): (Paragraph | Table)[] {
  const parts = SEVERITIES_IN_ORDER.map(
    (severity) => `${plan.severityCounts[severity]} ${severity}`,
  );
  return [
    heading1("Summary"),
    text(
      `${plan.findings.length} rule(s) reviewed against the ${plan.playbookName} playbook, version ${plan.playbookVersion}, in playbook order: ${parts.join(", ")} severity.`,
    ),
    summaryTable(plan),
  ];
}

function passageParagraphs(view: FindingView): Paragraph[] {
  return view.evidence.map((passage) => {
    const where =
      passage.occurrences > 1
        ? `${passage.location}. These words occur ${passage.occurrences} times in this paragraph.`
        : passage.location;
    return new Paragraph({
      style: "Passage",
      children: [
        bold(`${passage.roleLabel}. `),
        ...(passage.roleWorkflowLabel === null
          ? []
          : runs(
              `(role changed by the reviewer; the workflow labelled it ${passage.roleWorkflowLabel}) `,
            )),
        ...runs(`"${passage.quote}"`),
        new TextRun({
          text: `Location: ${where}`,
          break: 1,
          size: SMALL_SIZE,
          color: MUTED,
        }),
      ],
    });
  });
}

function languageParagraphs(view: FindingView): Paragraph[] {
  const basis = BASIS_LABEL[view.basis];
  const written = writtenForOriginal(view);
  const how = !view.languageEdited
    ? written === null
      ? basis
      : `${basis}; ${written}`
    : view.languageOriginal === null
      ? "added by the reviewer; the workflow proposed none"
      : `edited by the reviewer; the workflow's version was ${basis}`;
  if (view.language !== null) {
    const out = [labelled(`Proposed language (${how}):`, `"${view.language}"`)];
    if (view.languageEdited) {
      out.push(
        note(
          view.languageOriginal === null
            ? "Original before edit: none proposed."
            : `Original before edit: "${view.languageOriginal}"`,
        ),
      );
    }
    return out;
  }
  if (view.status === "compliant" || view.status === "not_applicable") {
    return view.languageEdited && view.languageOriginal !== null
      ? [
          labelled("Proposed language (edited by the reviewer):", "None."),
          note(`Original before edit: "${view.languageOriginal}"`),
        ]
      : [];
  }
  const out = [
    labelled(
      view.languageEdited ? "Proposed language (edited by the reviewer):" : "Proposed language:",
      view.languageEdited ? "None. The reviewer removed it." : "None offered.",
    ),
  ];
  if (view.languageEdited && view.languageOriginal !== null) {
    out.push(note(`Original before edit: "${view.languageOriginal}"`));
  }
  return out;
}

function findingSection(view: FindingView): Paragraph[] {
  const out: Paragraph[] = [heading2(headingText(view))];
  out.push(labelled("Decision:", decidedLine(view)));

  // A rejected finding states no conclusion, so nothing it said is repeated here.
  if (view.decision === "reject") {
    out.push(
      text(
        "This memorandum states no conclusion for this rule. The finding is listed under Considered and rejected.",
      ),
    );
    return out;
  }

  if (view.openReason !== null) {
    out.push(labelled("Open item:", "This finding is listed under Open items at the top."));
  }
  out.push(
    labelled(
      "Status:",
      `${STATUS_LABEL[view.status]}${view.statusEdited ? " (edited by the reviewer)." : "."}`,
    ),
  );
  if (view.modelStatus !== null) {
    out.push(
      note(
        `Status settled by the playbook: the workflow stated ${STATUS_LABEL[view.modelStatus]}${view.settlementReason === null ? "" : `; ${view.settlementReason}`}. The discrepancy, explanation, cited passages and proposed language below were written for the status the workflow stated and have not been revised to match.`,
      ),
    );
  }
  if (view.statusEdited) {
    out.push(note(`Original before edit: ${STATUS_LABEL[view.proposedStatus]}.`));
    out.push(
      note(
        `The reviewer changed the status. The discrepancy, explanation, cited passages and proposed language below that are not marked as edited by the reviewer were ${writtenForOriginal(view)}, and have not been revised to match.`,
      ),
    );
  }

  const hasDiscrepancy = view.discrepancy.trim() !== "";
  if (hasDiscrepancy || view.discrepancyEdited) {
    out.push(
      labelled(
        view.discrepancyEdited
          ? "Discrepancy (edited by the reviewer):"
          : workflowLabel(view, "Discrepancy"),
        hasDiscrepancy ? view.discrepancy : "None stated.",
      ),
    );
    if (view.discrepancyEdited) {
      out.push(
        note(
          view.discrepancyOriginal.trim() === ""
            ? "Original before edit: none stated."
            : `Original before edit: ${view.discrepancyOriginal}`,
        ),
      );
    }
  }
  if (view.status === "undetermined" && view.abstainReason !== null) {
    out.push(labelled("Why no status is stated:", view.abstainReason));
  }
  if (view.explanation.trim() !== "") {
    out.push(labelled(workflowLabel(view, "Explanation"), view.explanation));
  }
  if (view.conflict !== null) {
    out.push(labelled(workflowLabel(view, "Conflict between passages"), view.conflict));
  }

  if (view.evidence.length > 0) {
    out.push(
      para(
        [
          bold(
            view.statusEdited
              ? `Cited passages (cited by the workflow for the ${view.modelStatus !== null ? `status it stated, ${STATUS_LABEL[view.modelStatus]}` : `original status, ${STATUS_LABEL[view.proposedStatus]}`}):`
              : "Cited passages:",
          ),
        ],
        { keepNext: true },
      ),
    );
    out.push(...passageParagraphs(view));
  } else if (view.omittedQuotes === 0) {
    out.push(labelled("Cited passages:", "None."));
  }
  if (view.omittedQuotes > 0) {
    out.push(note(`${view.omittedQuotes} quotation(s) could not be verified and are omitted.`));
  }

  out.push(...languageParagraphs(view));
  if (view.reason !== null) out.push(labelled("Reviewer note:", view.reason));

  const flags = flagBullets(view);
  if (flags.length > 0) {
    out.push(para([bold("Flagged by the workflow:")], { keepNext: true }), ...flags);
  } else {
    out.push(note("Flagged by the workflow: nothing."));
  }
  return out;
}

function findings(plan: MemoPlan): Paragraph[] {
  return [heading1("Findings"), ...plan.findings.flatMap(findingSection)];
}

function rejectedAppendix(plan: MemoPlan): Paragraph[] {
  const out: Paragraph[] = [heading1("Appendix A. Considered and rejected")];
  if (plan.rejected.length === 0) {
    out.push(text("None. The reviewer rejected no finding."));
    return out;
  }
  out.push(
    text(
      "The reviewer rejected these findings. They are listed so that a later reader can see what was considered. This memorandum states no conclusion for these rules.",
    ),
  );
  for (const view of plan.rejected) {
    out.push(
      para([bold(`${view.number}. ${view.title} (${view.ruleId}, ${view.severity} severity)`)], {
        keepNext: true,
      }),
      bullet(runs(`Rejected by ${view.reviewerName} on ${view.decidedOn}.`)),
      bullet(
        runs(
          view.reason === null
            ? "Reviewer's reason: none recorded."
            : `Reviewer's reason: ${view.reason}`,
        ),
      ),
    );
  }
  return out;
}

function provenance(plan: MemoPlan): Paragraph[] {
  const p = plan.provenance;
  const decided =
    plan.counts.accepted + plan.counts.edited + plan.counts.rejected + plan.counts.escalated;
  const out: Paragraph[] = [
    heading1("Appendix B. Provenance"),
    labelled("Matter:", `${p.matterId}.`),
    labelled("Run:", `${p.runId}, started ${p.startedOn}.`),
    labelled("Workflow:", `${p.workflowLabel}, hash ${p.workflowShortHash}.`),
    labelled(
      "Playbook:",
      `${p.playbookSlug} ${p.playbookVersion} (${p.playbookName}), hash ${p.playbookShortHash}.`,
    ),
    labelled(
      "Model:",
      `requested ${p.modelProvider} ${p.modelRequested}; reported by the provider: ${p.modelReported ?? "not reported"}.`,
    ),
    ...(p.usageText === null ? [] : [labelled("Usage:", p.usageText)]),
    // A program that stands in for a model must say so in the memorandum itself, because the file
    // is what leaves the system and the page that said it does not travel with it.
    ...(isStandInProvider(p.modelProvider)
      ? [labelled("Stand-in reader:", STAND_IN_MEMO_TEXT)]
      : []),
    para([bold("Manifest hash: "), mono(p.manifestSha256)]),
    para([bold("Documents:")], { keepNext: true }),
  ];
  for (const doc of p.documents) {
    out.push(
      new Paragraph({
        numbering: { reference: "bullets", level: 0 },
        children: [
          ...runs(
            `${doc.label}: ${doc.title}, version ${doc.versionNo}, stated date ${doc.statedDate ?? "not stated"}. File hash: `,
          ),
          mono(doc.fileSha256),
        ],
      }),
    );
  }
  out.push(
    labelled(
      "Findings:",
      `${plan.findings.length}; decided: ${decided} (accepted ${plan.counts.accepted}, edited ${plan.counts.edited}, rejected ${plan.counts.rejected}, escalated ${plan.counts.escalated}).`,
    ),
    labelled("Exported by:", `${p.exportedBy} on ${p.exportedOn} (UTC).`),
    text(
      `Each quotation in this memorandum was checked against the stored document text at export. ${p.quotationsShown} quotation(s) are shown.${
        p.quotationsOmitted > 0
          ? ` ${p.quotationsOmitted} quotation(s) could not be verified and are omitted.`
          : ""
      }`,
    ),
    note(
      `Short hashes are the first ${SHORT_HASH_LENGTH} hexadecimal digits of the SHA-256 value. Dates are in UTC.`,
    ),
  );
  if (p.segregationRelaxed) {
    out.push(
      text(
        "The reviewer and the associate were the same person for this matter, because segregation of duties was relaxed for a single-person demonstration.",
      ),
    );
  }
  return out;
}

function headerBlock(plan: MemoPlan): Paragraph[] {
  return [
    new Paragraph({ heading: HeadingLevel.TITLE, children: runs(MEMO_TITLE) }),
    labelled(
      "Re:",
      `${plan.matterName}, ${plan.documentList}, review against ${plan.playbookName} playbook ${plan.playbookVersion}`,
    ),
    labelled("Client:", plan.clientLegalName),
    labelled("Date:", plan.exportedOn),
  ];
}

export async function renderMemo(plan: MemoPlan): Promise<Uint8Array> {
  const document = new Document({
    creator: "Parol",
    lastModifiedBy: "Parol",
    title: MEMO_TITLE,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE, color: INK, language: { value: "en-US" } },
          paragraph: { spacing: { after: 120, line: 264 } },
        },
        title: {
          run: { font: FONT, size: 30, bold: true, color: ACCENT },
          paragraph: {
            spacing: { after: 240 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACCENT, space: 4 } },
          },
        },
        heading1: {
          run: { font: FONT, size: 28, bold: true, color: INK },
          paragraph: { spacing: { before: 360, after: 120 }, keepNext: true, outlineLevel: 0 },
        },
        heading2: {
          run: { font: FONT, size: 24, bold: true, color: INK },
          paragraph: { spacing: { before: 280, after: 100 }, keepNext: true, outlineLevel: 1 },
        },
      },
      paragraphStyles: [
        {
          id: "Note",
          name: "Note",
          basedOn: "Normal",
          run: { size: SMALL_SIZE, italics: true, color: MUTED },
          paragraph: { spacing: { after: 100 } },
        },
        {
          id: "Passage",
          name: "Passage",
          basedOn: "Normal",
          paragraph: {
            indent: { left: 360 },
            spacing: { after: 140 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: RULE, space: 8 } },
          },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 540, hanging: 270 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: PAGE,
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: MEMO_PAGE_BANNER, size: 16, color: MUTED })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
                    size: 16,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...headerBlock(plan),
          ...documentWarnings(plan),
          ...openItems(plan),
          ...summary(plan),
          ...findings(plan),
          ...rejectedAppendix(plan),
          ...provenance(plan),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
