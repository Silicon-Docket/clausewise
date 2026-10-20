import { XMLSerializer } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { applyRedline } from "../src/index.js";
import { createCommentsPart } from "../src/comments.js";
import { trimEdit } from "../src/minimize.js";
import { parseXml, serializeXml } from "../src/ooxml.js";
import { bodyParagraphs, paragraphText } from "../src/paragraphs.js";
import { executeRedline, planRedline } from "../src/redline.js";
import {
  Rng,
  forbiddenCodePoints,
  hasStrictParser,
  strictParse,
  zipParts,
} from "./engine-support.js";
import {
  OUR_AUTHOR,
  applyReference,
  commentCoverage,
  expectedCommentText,
  genDoc,
  genOps,
  genText,
  paragraphsOf,
  parseDom,
  referenceComments,
  referenceEdits,
  viewText,
  type GenOps,
} from "./engine-fuzz-support.js";
import { buildDocx } from "./helpers.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const date = new Date("2026-03-01T12:00:00Z");
const BASE_SEED = 20_260_101;
const CASES_PER_MODE = 1500;
const ZIP_EVERY = 30;

const ser = (node: Node): string => new XMLSerializer().serializeToString(node as never);

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function checkEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

interface CaseStats {
  edits: number;
  editsApplied: number;
  comments: number;
  commentsApplied: number;
}

/** What the contract looked like before the run, taken from the tree the engine is about to change. */
interface Snapshot {
  paragraphs: string[];
  ids: string[];
  /** For each paragraph, the paragraphs that contain it (a text box sits inside its host). */
  hosts: number[][];
}

function snapshot(dom: Document): Snapshot {
  const paras = paragraphsOf(dom);
  return {
    paragraphs: paras.map(ser),
    ids: revisionIds(dom),
    hosts: paras.map((p) => {
      const out: number[] = [];
      for (let n = p.parentNode; n; n = n.parentNode) {
        const at = paras.indexOf(n as Element);
        if (at >= 0) out.push(at);
      }
      return out;
    }),
  };
}

function revisionIds(dom: Document): string[] {
  const ids: string[] = [];
  for (const local of ["ins", "del", "moveFrom", "moveTo", "rPrChange", "commentRangeStart"]) {
    for (const el of Array.from(dom.getElementsByTagNameNS(W, local))) {
      const id = el.getAttributeNS(W, "id");
      check(id !== "" && id !== null, `${local} without an id`);
      ids.push(id!);
    }
  }
  return ids;
}

/** Everything that must hold of the output, read straight from its XML. */
function verifyOutput(
  gen: ReturnType<typeof genDoc>,
  ops: GenOps,
  refs: ReturnType<typeof referenceEdits>,
  commentRefs: boolean[],
  outDocXml: string,
  out: Document,
  commentsXml: string | undefined,
  before: Snapshot,
): void {
  forbiddenCodePoints(outDocXml).forEach((cp) => check(false, `document.xml holds U+${cp}`));
  const paras = paragraphsOf(out);
  checkEqual(paras.length, gen.paragraphs.length, "paragraph count changed");

  const touched = new Set<number>();
  ops.edits.forEach((e, i) => {
    const m = /^p:(\d+)$/.exec(e.paragraphId);
    if (refs[i]?.applied && m) touched.add(Number(m[1]));
  });
  ops.comments.forEach((c, i) => {
    const m = /^p:(\d+)$/.exec(c.paragraphId);
    if (commentRefs[i] && m) touched.add(Number(m[1]));
  });
  // A paragraph holding a text box is also changed by an edit inside the box.
  const dirty = new Set<number>();
  for (const index of touched) {
    dirty.add(index);
    for (const outer of before.hosts[index] ?? []) dirty.add(outer);
  }

  gen.paragraphs.forEach((gp, i) => {
    const original = genText(gp);
    const p = paras[i]!;
    checkEqual(viewText(p, "rejected"), original, `reject-all text of paragraph ${i}`);
    const mine = refs
      .map((r, k) => ({ r, k }))
      .filter(({ r, k }) => r.applied && ops.edits[k]!.paragraphId === `p:${i}`)
      .map(({ r }) => r);
    checkEqual(
      viewText(p, "accepted"),
      applyReference(original, mine),
      `accept-all text of paragraph ${i}`,
    );
    if (!dirty.has(i)) {
      check(ser(p) === before.paragraphs[i], `untouched paragraph ${i} changed`);
    }
  });

  // Revision and comment ids we add are unique and never reuse an id the contract already had.
  const originalIds = before.ids;
  const outIds = revisionIds(out);
  const remaining = [...outIds];
  for (const id of originalIds) {
    const at = remaining.indexOf(id);
    check(at >= 0, `existing id ${id} disappeared`);
    remaining.splice(at, 1);
  }
  check(
    new Set(remaining).size === remaining.length,
    `duplicate revision ids ${remaining.join(",")}`,
  );
  check(!remaining.some((id) => originalIds.includes(id)), "a new id repeats an existing one");
  for (const local of ["ins", "del"]) {
    for (const el of Array.from(out.getElementsByTagNameNS(W, local))) {
      if ((el.parentNode as Element | null)?.localName === "rPr") continue;
      check(el.getAttributeNS(W, "author") !== "", `${local} without an author`);
      check(el.getAttributeNS(W, "date") !== "", `${local} without a date`);
    }
  }

  // Every comment that was applied is anchored once and carries the right text range.
  const commentDoc = commentsXml ? parseDom(commentsXml) : undefined;
  const byToken = new Map<string, string>();
  for (const c of Array.from(commentDoc?.getElementsByTagNameNS(W, "comment") ?? [])) {
    const text = c.textContent ?? "";
    const token = /c\d+-\d+-\d+/.exec(text)?.[0];
    if (token) byToken.set(token, c.getAttributeNS(W, "id") ?? "");
  }
  let expectedComments = 0;
  ops.comments.forEach((c, i) => {
    if (!commentRefs[i]) return;
    expectedComments++;
    const id = byToken.get(c.token);
    check(id !== undefined && id !== "", `comment ${c.token} is missing from comments.xml`);
    const index = Number(/^p:(\d+)$/.exec(c.paragraphId)![1]);
    const p = paras[index]!;
    const count = (local: string): number =>
      Array.from(p.getElementsByTagNameNS(W, local)).filter(
        (el) => el.getAttributeNS(W, "id") === id,
      ).length;
    checkEqual(
      [count("commentRangeStart"), count("commentRangeEnd"), count("commentReference")],
      [1, 1, 1],
      `markers of ${c.token}`,
    );
    const gp = gen.paragraphs[index]!;
    const covered = commentCoverage(p, id!);
    const start = c.start ?? 0;
    const end = c.end ?? genText(gp).length;
    checkEqual(covered, expectedCommentText(gp, start, end), `text covered by ${c.token}`);
  });
  const written = Array.from(commentDoc?.getElementsByTagNameNS(W, "comment") ?? []).length;
  checkEqual(written, expectedComments, "number of comments written");
}

/** Packages written through the zip path, parsed by libxml2 in one go at the end of a run. */
const strictBatch: Record<string, Uint8Array> = {};

async function runCase(caseId: number, minimize: boolean, throughZip: boolean): Promise<CaseStats> {
  const seed = BASE_SEED + caseId * 7919;
  const rng = new Rng(seed);
  const gen = genDoc(rng);
  const ops = genOps(rng, gen.paragraphs, caseId);
  const xml = documentXml(gen.bodyXml);
  const label = `seed=${seed} case=${caseId} minimize=${minimize}`;
  try {
    const doc = parseXml(xml, "word/document.xml");
    const listed = bodyParagraphs(doc);
    checkEqual(listed.length, gen.paragraphs.length, "listed paragraph count");
    listed.forEach((p, i) => {
      checkEqual(paragraphText(p), genText(gen.paragraphs[i]!), `text view of paragraph ${i}`);
    });
    paragraphsOf(doc).forEach((p, i) => {
      checkEqual(
        viewText(p, "accepted"),
        genText(gen.paragraphs[i]!),
        `oracle view of paragraph ${i}`,
      );
    });
    const before = snapshot(doc);

    const refs = referenceEdits(gen.paragraphs, ops.edits, minimize ? trimEdit : undefined);
    const commentRefs = referenceComments(gen.paragraphs, ops.comments);

    const plan = planRedline(doc, { edits: ops.edits, comments: ops.comments }, { minimize, date });
    const commentsPart = createCommentsPart();
    const { addedComments } = executeRedline(doc, plan, commentsPart, { minimize, date });
    checkEqual(
      plan.edits.map((o) => o.applied),
      refs.map((r) => r.applied),
      "which edits were applied",
    );
    checkEqual(
      plan.comments.map((o) => o.applied),
      commentRefs,
      "which comments were applied",
    );
    const outDocXml = serializeXml(doc);
    const commentsXml = addedComments ? serializeXml(commentsPart.doc) : undefined;
    // Reading the serialised text back costs more than everything else, so most cases check the
    // tree they just built and every fifth one also checks the round trip through the writer.
    const out = caseId % 5 === 0 ? parseDom(outDocXml) : (doc as Document);
    verifyOutput(gen, ops, refs, commentRefs, outDocXml, out, commentsXml, before);

    if (throughZip) {
      const buf = await buildDocx(gen.bodyXml);
      const result = await applyRedline(
        buf,
        { edits: ops.edits, comments: ops.comments },
        { minimize, date },
      );
      checkEqual(
        result.edits.map((o) => o.applied),
        refs.map((r) => r.applied),
        "zip: which edits were applied",
      );
      if (result.buffer !== buf) {
        const parts = await zipParts(result.buffer);
        const docBytes = new TextDecoder().decode(parts["word/document.xml"]!);
        check(
          docBytes.replace(/^<\?xml[^>]*\?>/, "") === outDocXml.replace(/^<\?xml[^>]*\?>/, ""),
          "zip and dom paths disagree",
        );
        for (const [name, bytes] of Object.entries(parts)) {
          if (/\.(xml|rels)$/.test(name)) strictBatch[`${label} ${name}`] = bytes;
        }
      }
    }
    return {
      edits: ops.edits.length,
      editsApplied: plan.edits.filter((o) => o.applied).length,
      comments: ops.comments.length,
      commentsApplied: plan.comments.filter((o) => o.applied).length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label}\n${message}\nedits: ${JSON.stringify(ops.edits)}\ncomments: ${JSON.stringify(ops.comments)}\nbody: ${gen.bodyXml}`,
    );
  }
}

describe("applyRedline against an independent oracle, on hostile run structure", () => {
  for (const minimize of [false, true]) {
    it(
      `${CASES_PER_MODE} seeded cases never throw, undo cleanly and match the reference (minimize ${minimize})`,
      { timeout: 120_000 },
      async () => {
        const totals: CaseStats = { edits: 0, editsApplied: 0, comments: 0, commentsApplied: 0 };
        for (let i = 0; i < CASES_PER_MODE; i++) {
          const caseId = i + (minimize ? CASES_PER_MODE : 0);
          const stats = await runCase(caseId, minimize, i % ZIP_EVERY === 0);
          totals.edits += stats.edits;
          totals.editsApplied += stats.editsApplied;
          totals.comments += stats.comments;
          totals.commentsApplied += stats.commentsApplied;
        }
        if (hasStrictParser) {
          for (const [name, error] of Object.entries(strictParse(strictBatch))) {
            expect(error, `${name} is not well-formed`).toBeNull();
          }
        }
        for (const key of Object.keys(strictBatch)) delete strictBatch[key];
        // The generator must reach the interesting cases, not just refuse everything.
        expect(totals.edits).toBeGreaterThan(CASES_PER_MODE);
        expect(totals.editsApplied / totals.edits).toBeGreaterThan(0.15);
        expect(totals.commentsApplied).toBeGreaterThan(CASES_PER_MODE / 4);
      },
    );
  }

  it("is deterministic for a seed, so a failure can be replayed", async () => {
    const a = genDoc(new Rng(BASE_SEED));
    const b = genDoc(new Rng(BASE_SEED));
    expect(a.bodyXml).toBe(b.bodyXml);
    expect(OUR_AUTHOR).toBe("Clausewise");
  });
});
