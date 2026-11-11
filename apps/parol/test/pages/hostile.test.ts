import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import {
  ErrorPage,
  FindingPane,
  MatterPage,
  MattersPage,
  MemosPage,
  RunPage,
  SignInPage,
  render,
  type Chrome,
} from "../../src/server/pages/index.js";
import type {
  FindingView,
  IssueRow,
  MatterView,
  ReviewHistoryItem,
} from "../../src/services/views.js";
import { checkInvariants } from "./invariants.js";
import {
  all,
  attr,
  attributeValues,
  byTag,
  classes,
  hasClass,
  parseHtml,
  readable,
  signature,
  textOf,
  withClass,
} from "./html.js";
import {
  HOSTILE,
  IDS,
  buildChrome,
  buildConflictFinding,
  buildDocuments,
  buildEvidence,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMatterView,
  buildMemo,
  buildPlaybooks,
  buildRunSummary,
  buildUsers,
  buildWarnings,
} from "./support.js";

/**
 * Text from a document, a model or a person is data. The same page is rendered twice, once with
 * plain words in every free-text field and once with a hostile string in every one of them. If the
 * hostile text were ever written as markup, the second page would have a tag or an attribute the
 * first lacks, or would not parse at all under the strict reader.
 */

type T = (label: string) => string;
const plain: T = () => "plain words";

/** Payloads that must show as text and nothing else. The invisible-character cases are separate. */
const MARKUP_PAYLOADS = Object.entries(HOSTILE).filter(
  ([name]) => !["bidi", "zeroWidth"].includes(name),
);

// ---------------------------------------------------------------------------------------------
// The same view models, filled with one string
// ---------------------------------------------------------------------------------------------

function textFinding(t: T): FindingView {
  const ev = (
    id: string,
    role: "governing" | "supporting" | "superseded" | "conflicting",
    quoteCheck: "verified" | "not_found" | "ambiguous",
  ) => {
    const quote = t(`quote ${id}`);
    return buildEvidence({
      id,
      spanId: `s_${id}`,
      location: t(`location ${id}`),
      quote,
      role,
      spanText: `${t(`before ${id}`)} ${quote} ${t(`after ${id}`)}`,
      quoteCheck,
      ...(quoteCheck === "verified" ? {} : { offsets: null }),
    });
  };
  const base = buildFindingView();
  const review = (validity: "current" | "stale"): ReviewHistoryItem => ({
    decision: "edit",
    reviewerName: t("reviewer"),
    at: "2026-11-03T15:30:00Z",
    reason: t("reason"),
    validity,
    edits: {
      discrepancy: t("edited discrepancy"),
      fallbackLanguage: t("edited fallback"),
      evidenceRoles: [{ evidenceId: "ev_g", role: "governing" }],
    },
  });
  return {
    ...base,
    issue: {
      ...base.issue,
      ruleTitle: t("rule title"),
      escalations: [
        { code: "quote_not_verified", detail: t("escalation detail") },
        { code: "conflicting_sources", detail: t("escalation detail 2") },
      ],
    },
    rule: {
      standard: t("standard"),
      fallback: t("fallback"),
      unacceptable: t("unacceptable"),
      fallbackLanguage: t("approved wording"),
      playbook: { slug: t("slug"), version: t("version") },
    },
    discrepancy: t("discrepancy"),
    explanation: t("explanation"),
    fallbackLanguage: t("fallback language"),
    conflict: t("conflict"),
    abstainReason: t("abstain"),
    evidence: [
      ev("ev_g", "governing", "verified"),
      ev("ev_s", "superseded", "verified"),
      ev("ev_n", "supporting", "not_found"),
      ev("ev_a", "supporting", "ambiguous"),
      ev("ev_c1", "conflicting", "verified"),
      ev("ev_c2", "conflicting", "verified"),
    ],
    checks: [
      { id: "quote_exists", kind: "deterministic", outcome: "fail", detail: t("check detail") },
      { id: "support", kind: "model", outcome: "pass", detail: t("check detail 2") },
    ],
    reviews: [review("current"), review("stale")],
  };
}

function textMatterView(t: T): MatterView {
  const docs = buildDocuments().map((d) => ({
    ...d,
    title: t("document title"),
    versions: d.versions.map((v) => ({ ...v, uploadedByName: t("uploader") })),
  }));
  const failed = buildRunSummary({
    id: "r_failed",
    status: "failed",
    workflowLabel: t("workflow"),
    playbook: { slug: t("slug"), version: t("version") },
    model: { provider: t("provider"), requested: t("requested"), reported: t("reported") },
    startedByName: t("starter"),
    current: false,
  });
  const active = buildRunSummary({
    status: "analyzing",
    finishedAt: null,
    progress: { stage: "analyze", done: 1, total: 2 },
    startedByName: t("starter"),
    workflowLabel: t("workflow"),
  });
  return buildMatterView({
    matter: buildMatterSummary({
      name: t("matter name"),
      clientLegalName: t("client"),
      status: "stale",
    }),
    members: [
      { userId: "u_a", displayName: t("member a"), role: "associate" },
      { userId: "u_b", displayName: t("member b"), role: "reviewer" },
    ],
    documents: docs,
    warnings: [
      {
        code: "instruction_like_text",
        documentLabel: "D1",
        spanLabel: "D1-p22",
        detail: t("warning detail"),
      },
      {
        code: "unreviewed_content",
        documentLabel: "D2",
        spanLabel: null,
        detail: t("warning detail"),
      },
    ],
    playbooks: [
      { ...buildPlaybooks()[0]!, name: t("playbook name"), version: t("playbook version") },
    ],
    start: { ready: false, reasons: [t("reason one"), t("reason two")] },
    activeRun: active,
    currentRun: null,
    runs: [active, failed],
    staleReason: t("stale reason"),
    destination: t("destination"),
    memos: [buildMemo({ fileName: t("file name"), exportedByName: t("exporter") })],
  });
}

const textChrome = (t: T): Chrome =>
  buildChrome({
    userName: t("user"),
    csrfToken: t("token"),
    notice: { kind: "error", text: t("notice") },
  });

function textIssues(t: T): IssueRow[] {
  return buildIssueRows().map((row, index) => ({
    ...row,
    ruleTitle: t(`rule ${index}`),
    ruleKey: t(`key ${index}`),
    escalations: row.escalations.map((e) => ({ ...e, detail: t("escalation") })),
  }));
}

interface Case {
  name: string;
  render: (t: T) => string;
}

const cases: Case[] = [
  {
    name: "FindingPane (every branch of a passage)",
    render: (t) =>
      render(FindingPane({ chrome: textChrome(t), matterId: IDS.matter, finding: textFinding(t) })),
  },
  {
    name: "MatterPage (stale, running, failed, warnings, memos)",
    render: (t) =>
      render(
        MatterPage({
          chrome: textChrome(t),
          view: textMatterView(t),
          users: buildUsers().map((u) => ({ ...u, displayName: t("user option") })),
          canDelete: true,
        }),
      ),
  },
  {
    name: "MattersPage",
    render: (t) =>
      render(
        MattersPage({
          chrome: textChrome(t),
          matters: [
            buildMatterSummary({
              name: t("matter"),
              clientLegalName: t("client"),
              synthetic: false,
            }),
          ],
          playbooks: [{ ...buildPlaybooks()[0]!, name: t("playbook"), version: t("version") }],
          users: buildUsers().map((u) => ({ ...u, displayName: t("user option") })),
        }),
      ),
  },
  {
    name: "RunPage with a selected finding",
    render: (t) =>
      render(
        RunPage({
          chrome: textChrome(t),
          matter: buildMatterSummary({ name: t("matter") }),
          run: buildRunSummary({
            workflowLabel: t("workflow"),
            startedByName: t("starter"),
            playbook: { slug: t("slug"), version: t("version") },
          }),
          issues: textIssues(t),
          selected: textFinding(t),
          warnings: [
            {
              code: "instruction_like_text",
              documentLabel: "D1",
              spanLabel: "D1-p22",
              detail: t("warning"),
            },
          ],
          documents: buildDocuments().map((d) => ({ label: d.label, title: t("document") })),
        }),
      ),
  },
  {
    name: "MemosPage",
    render: (t) =>
      render(
        MemosPage({
          chrome: textChrome(t),
          matter: buildMatterSummary({ name: t("matter") }),
          memos: [buildMemo({ fileName: t("file"), exportedByName: t("exporter") })],
          canExport: true,
          exportBlockedReason: t("blocked"),
        }),
      ),
  },
  {
    name: "ErrorPage",
    render: (t) =>
      render(
        ErrorPage({
          chrome: textChrome(t),
          status: 400,
          title: t("title"),
          message: t("message"),
          todo: t("todo"),
          backLabel: t("back"),
        }),
      ),
  },
  {
    name: "SignInPage",
    render: (t) =>
      render(
        SignInPage({
          chrome: textChrome(t),
          users: buildUsers().map((u) => ({ ...u, displayName: t("name") })),
        }),
      ),
  },
];

describe("hostile text is only ever text", () => {
  for (const c of cases) {
    describe(c.name, () => {
      const benign = c.render(plain);
      const benignSignature = signature(parseHtml(benign));

      for (const [name, payload] of MARKUP_PAYLOADS) {
        it(`${name}: same tags and attributes as with plain words`, () => {
          const html = c.render(() => payload);
          // The strict reader throws if the text broke out of its element or its attribute.
          expect(signature(parseHtml(html))).toBe(benignSignature);
        });

        it(`${name}: shown as text, never as the raw string`, () => {
          const html = c.render(() => payload);
          const root = parseHtml(html);
          const text = textOf(root);
          const hasMarkupChars = /[<>"']/.test(payload);
          if (hasMarkupChars) expect(html.includes(payload), "raw payload in the HTML").toBe(false);
          // It is on the page, decoded, so it was shown and not dropped.
          expect(
            text.includes(payload) || attributeValues(root).some((a) => a.value.includes(payload)),
          ).toBe(true);
        });
      }
    });
  }
});

// The shared invariants expect the fixtures' own URLs and token, which hostile text replaces, so
// the properties that matter here are checked directly.
describe("hostile text and the page invariants", () => {
  it("a hostile token and user name still leave every form with its field", () => {
    const html = cases[1]!.render(() => HOSTILE.attributeBreak!);
    const root = parseHtml(html);
    for (const form of byTag(root, "form")) {
      const token = all(form, (el) => el.name === "input" && attr(el, "name") === "_csrf");
      expect(token).toHaveLength(1);
      expect(attr(token[0]!, "value")).toBe(HOSTILE.attributeBreak);
    }
  });

  it("no hostile string becomes a script, a style, an event handler or a script URL", () => {
    for (const c of cases) {
      for (const [, payload] of MARKUP_PAYLOADS) {
        const root = parseHtml(c.render(() => payload));
        for (const script of byTag(root, "script"))
          expect(attr(script, "src")).toBe("/assets/parol.js");
        expect(byTag(root, "style")).toHaveLength(0);
        for (const el of all(root)) {
          for (const a of el.attrs) {
            expect(a.name.startsWith("on"), `${a.name} on <${el.name}>`).toBe(false);
            expect(a.name).not.toBe("style");
            if (["href", "src", "action", "formaction"].includes(a.name)) {
              expect(/^\s*(javascript|data|vbscript):/i.test(a.value ?? "")).toBe(false);
            }
          }
        }
        expect(byTag(root, "img")).toHaveLength(0);
        expect(byTag(root, "svg")).toHaveLength(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------------------------

describe("direction controls and zero-width characters are made visible", () => {
  const finding = (payload: string) =>
    render(
      FindingPane({
        chrome: buildChrome(),
        matterId: IDS.matter,
        finding: textFinding(() => payload),
      }),
    );
  // The edit fields are the one place the raw characters must stay: they hold the text a reviewer
  // edits and posts back, so changing it there would change the finding.
  const outsideTextareas = (html: string): string =>
    html.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/g, "");

  it("prints each bidi control as a marker and lets none through", () => {
    const html = finding(HOSTILE.bidi!);
    for (const raw of ["\u202e", "\u202c", "\u2066", "\u2069"]) {
      expect(outsideTextareas(html).includes(raw), `raw U+${raw.charCodeAt(0).toString(16)}`).toBe(
        false,
      );
    }
    const text = readable(parseHtml(html));
    for (const marker of ["[U+202E]", "[U+202C]", "[U+2066]", "[U+2069]"])
      expect(text).toContain(marker);
  });

  it("prints zero-width characters as markers, so a split word is visible", () => {
    const html = finding(HOSTILE.zeroWidth!);
    for (const raw of ["\u200b", "\u200d", "\ufeff"]) {
      expect(outsideTextareas(html).includes(raw), `raw U+${raw.charCodeAt(0).toString(16)}`).toBe(
        false,
      );
    }
    const text = readable(parseHtml(html));
    expect(text).toContain("con[U+200B]fi[U+200D]dential[U+FEFF]");
  });

  it("keeps the exact text in the edit fields, so an edit posts back what was shown", () => {
    const root = parseHtml(finding(HOSTILE.bidi!));
    const field = all(
      root,
      (el) => el.name === "textarea" && attr(el, "name") === "discrepancy",
    )[0]!;
    expect(textOf(field)).toBe(`\n${HOSTILE.bidi}`);
  });

  it("explains each marker on hover", () => {
    const root = parseHtml(finding(HOSTILE.bidi!));
    const marker = withClass(root, "invisible").find((m) => readable(m) === "[U+202E]")!;
    expect(attr(marker, "title")).toBe("Invisible character: right-to-left override");
  });

  it("does the same inside the highlighted quote", () => {
    const quote = "pay\u202e100";
    const f = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_b",
          spanId: "s",
          location: "Mutual NDA (v1), Section 1, paragraph 1",
          quote,
          role: "governing",
          spanText: `You shall ${quote} now.`,
        }),
      ],
    });
    const html = render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding: f }));
    expect(html.includes("\u202e")).toBe(false);
    const mark = byTag(parseHtml(html), "mark")[0]!;
    expect(readable(mark)).toBe("pay[U+202E]100");
  });
});

// ---------------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------------

describe("a very long quote", () => {
  const long = `${"word ".repeat(19_999)}ends.`;

  it("is as long as the brief says", () => {
    expect(long.length).toBe(100_000);
  });

  it("is shown in full, highlighted, as text, in reasonable time", () => {
    const f = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_long",
          spanId: "s",
          location: "Mutual NDA (v1), Section 1, paragraph 1",
          quote: long,
          role: "governing",
          spanText: `<script>1</script>${long}</p>`,
        }),
      ],
    });
    const started = Date.now();
    const html = render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding: f }));
    const root = checkInvariants(html, { fragment: true });
    expect(Date.now() - started).toBeLessThan(5000);
    const mark = byTag(root, "mark")[0]!;
    expect(textOf(mark)).toBe(long);
    expect(html.includes("<script>1")).toBe(false);
    // Long text gets a scroll box that a keyboard can reach.
    const block = withClass(root, "doc-text")[0]!;
    expect(hasClass(block, "long")).toBe(true);
    expect(attr(block, "tabindex")).toBe("0");
  });

  it("is shown in full, struck through, when it was not found", () => {
    const f = buildFindingView({
      evidence: [
        buildEvidence({
          id: "ev_long",
          spanId: "s",
          location: "Mutual NDA (v1), Section 1, paragraph 1",
          quote: long,
          role: "supporting",
          spanText: "short paragraph",
          quoteCheck: "not_found",
          offsets: null,
        }),
      ],
    });
    const root = checkInvariants(
      render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding: f })),
      { fragment: true },
    );
    expect(textOf(withClass(root, "unverified-quote")[0]!)).toBe(long);
  });

  it("keeps a 100000 character name and title as text", () => {
    const name = "N".repeat(100_000);
    const root = parseHtml(
      render(
        MattersPage({
          chrome: buildChrome(),
          matters: [buildMatterSummary({ name })],
          playbooks: [],
          users: [],
        }),
      ),
    );
    expect(textOf(byTag(root, "a").find((a) => attr(a, "href") === urls.matter(IDS.matter))!)).toBe(
      name,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Ids and codes that are not what they should be
// ---------------------------------------------------------------------------------------------

describe("ids from the database", () => {
  const evil = `x"><script>1</script> y&z`;

  it("are percent-encoded in every link and form action, and never break out of an attribute", () => {
    const view = buildMatterView({
      matter: buildMatterSummary({ id: evil }),
      documents: buildDocuments().map((d) => ({
        ...d,
        documentId: `${evil}-${d.label}`,
        versions: d.versions.map((v) => ({ ...v, versionId: `${evil}-${v.versionId}` })),
      })),
      runs: [buildRunSummary({ id: evil })],
      currentRun: buildRunSummary({ id: evil }),
      memos: [buildMemo({ memoId: evil, runId: evil })],
    });
    const html = render(
      MatterPage({ chrome: buildChrome(), view, users: buildUsers(), canDelete: true }),
    );
    const root = parseHtml(html);
    expect(html.includes("<script>1")).toBe(false);
    const urlAttrs = attributeValues(root).filter((a) => ["href", "action"].includes(a.name));
    expect(urlAttrs.length).toBeGreaterThan(10);
    for (const a of urlAttrs.filter((u) => u.value.startsWith("/matters/"))) {
      expect(a.value, `${a.name} on <${a.el}>`).not.toMatch(/["<> ]/);
      expect(a.value).toContain(encodeURIComponent(evil).slice(0, 12));
    }
    // Ids used as ids are reduced to safe characters.
    for (const a of attributeValues(root).filter((v) => v.name === "id")) {
      expect(a.value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("keep the same structure as plain ids", () => {
    const withId = (id: string) =>
      render(
        FindingPane({
          chrome: buildChrome(),
          matterId: id,
          finding: {
            ...buildFindingView(),
            issue: { ...buildFindingView().issue, findingId: id },
            evidence: buildFindingView().evidence.map((e, i) => ({
              ...e,
              evidenceId: `${id}-${i}`,
            })),
          },
        }),
      );
    expect(signature(parseHtml(withId(evil)))).toBe(signature(parseHtml(withId("m_plain"))));
  });
});

describe("codes the page does not know", () => {
  const evil = `"><script>1</script>`;

  it("get a fixed phrase and never reach a class name", () => {
    const f = buildFindingView();
    const finding: FindingView = {
      ...f,
      issue: {
        ...f.issue,
        severity: evil as never,
        status: evil as never,
        category: evil as never,
        escalations: [{ code: evil as never, detail: "d" }],
        review: {
          decision: evil as never,
          reviewerName: "n",
          at: "2026-11-03T15:30:00Z",
          validity: "current",
        },
      },
      fallbackBasis: evil as never,
      evidence: f.evidence.map((e) => ({
        ...e,
        role: evil as never,
        quoteCheck: evil as never,
        supportCheck: evil as never,
      })),
      checks: [{ id: evil, kind: evil as never, outcome: evil as never, detail: "d" }],
      reviews: [
        {
          decision: evil as never,
          reviewerName: "n",
          at: "bad date",
          reason: null,
          validity: "current",
          edits: {
            status: evil as never,
            evidenceRoles: [{ evidenceId: "ev_x", role: evil as never }],
          },
        },
      ],
    };
    const html = render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding }));
    const root = parseHtml(html);
    expect(html.includes(evil)).toBe(false);
    expect(textOf(root)).not.toContain(evil);
    for (const el of all(root)) {
      for (const c of classes(el)) expect(c, `class on <${el.name}>`).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    const text = readable(root);
    expect(text).toContain("Unknown severity");
    expect(text).toContain("Unknown status");
    expect(text).toContain("Flag with no wording");
    expect(text).toContain("unknown date");
  });

  it("do not read properties of the label tables", () => {
    const f = buildFindingView();
    const finding: FindingView = {
      ...f,
      issue: {
        ...f.issue,
        status: "constructor" as never,
        escalations: [{ code: "__proto__" as never, detail: "d" }],
      },
    };
    const text = readable(
      parseHtml(render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding }))),
    );
    expect(text).toContain("Unknown status");
    expect(text).toContain("Flag with no wording");
    expect(text).not.toContain("function");
    expect(text).not.toContain("[object");
  });

  it("do not break the issue table or the matter page", () => {
    const rows = buildIssueRows();
    rows[0] = {
      ...rows[0]!,
      severity: evil as never,
      status: evil as never,
      validity: evil as never,
    };
    const run = render(
      RunPage({
        chrome: buildChrome(),
        matter: buildMatterSummary(),
        run: buildRunSummary({ status: evil as never }),
        issues: rows,
        selected: null,
      }),
    );
    expect(() => parseHtml(run)).not.toThrow();
    expect(run.includes(evil)).toBe(false);
    const matter = render(
      MatterPage({
        chrome: buildChrome(),
        view: buildMatterView({
          matter: buildMatterSummary({ status: evil as never, role: evil as never }),
          runs: [buildRunSummary({ status: evil as never, errorKind: evil })],
        }),
        canDelete: false,
      }),
    );
    expect(() => parseHtml(matter)).not.toThrow();
    expect(matter.includes(evil)).toBe(false);
  });

  it("show an unreadable date as a fixed phrase", () => {
    const html = render(
      MatterPage({
        chrome: buildChrome(),
        view: buildMatterView({
          memos: [buildMemo({ exportedAt: evil })],
          documents: buildDocuments().map((d) => ({
            ...d,
            versions: d.versions.map((v) => ({ ...v, statedDate: evil, uploadedAt: evil })),
          })),
        }),
        canDelete: false,
        users: [],
      }),
    );
    const root = parseHtml(html);
    expect(html.includes(evil)).toBe(false);
    expect(readable(root)).toContain("unknown date");
    // A date input only ever gets a plain date, so a bad one leaves it empty.
    const dates = all(
      root,
      (el) => el.name === "input" && attr(el, "type") === "date" && attr(el, "form") !== undefined,
    );
    expect(dates).toHaveLength(2);
    for (const d of dates) expect(attr(d, "value")).toBe("");
    // A time element is only written for a date that was read, and never holds the bad value.
    for (const t of all(root, (el) => el.name === "time")) {
      expect(attr(t, "datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(buildWarnings()).toHaveLength(1);
    expect(buildConflictFinding().evidence).toHaveLength(2);
  });
});
