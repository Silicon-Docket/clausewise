import { expect } from "vitest";
import { CSRF_FIELD } from "../../src/server/pages/forms.js";
import { DEMO_BANNER } from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import {
  all,
  attr,
  attributeValues,
  byId,
  byTag,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  type El,
} from "./html.js";
import { IDS, buildIssueRows } from "./support.js";

/** Every URL a form in the fixtures may post to, built from the shared url table. */
export function allowedActions(): Set<string> {
  const m = IDS.matter;
  const docs = [IDS.nda, IDS.amendment, "doc_d3"];
  const versions = [IDS.ndaV1, IDS.amendmentV1, "dv_d1v2", "dv_d3v1"];
  return new Set<string>([
    urls.session(),
    urls.matters(),
    urls.matterSettings(m),
    urls.matterDelete(m),
    urls.matterRetention(m),
    urls.members(m),
    urls.documents(m),
    urls.runs(m),
    urls.memos(m),
    urls.rating(m),
    urls.training(),
    urls.matterTimer(m),
    urls.matterReferenceList(m),
    urls.pilotCalendar(),
    urls.pilotParticipants(),
    urls.missedIssues(m, IDS.run),
    urls.missedIssues(m, IDS.staleRun),
    urls.runResume(m, IDS.run),
    urls.runResume(m, IDS.staleRun),
    urls.runCancel(m, IDS.run),
    urls.runCancel(m, IDS.staleRun),
    ...buildIssueRows().map((row) => urls.review(m, row.findingId)),
    ...buildIssueRows().map((row) => urls.notes(m, row.findingId)),
    ...docs.flatMap((d) => [urls.versions(m, d), urls.operative(m, d), urls.documentRemove(m, d)]),
    ...versions.map((v) => urls.statedDate(m, v)),
  ]);
}

const FORBIDDEN_URL = /^\s*(javascript|data|vbscript):/i;
const FORM_CONTROLS = new Set(["input", "select", "textarea"]);
const NO_LABEL_NEEDED = new Set(["hidden", "submit", "button", "reset", "image"]);

export interface InvariantOptions {
  /** Pages that stand alone have a single h1; fragments (a pane on its own) do not. */
  fragment?: boolean;
  /** Actions forms may post to. Defaults to the fixtures' URLs. */
  actions?: Set<string>;
  /** The token every form must carry. Defaults to the fixtures' token. */
  csrf?: string;
}

/**
 * The properties every page must have, whatever it shows. Throws (through expect) on the first
 * that fails, naming it, so one helper can guard every page variant.
 */
export function checkInvariants(html: string, options: InvariantOptions = {}): El {
  const root = parseHtml(html);
  const actions = options.actions ?? allowedActions();

  if (options.fragment !== true) {
    expect(html.startsWith("<!doctype html>"), "starts with the doctype").toBe(true);
    const htmlEl = byTag(root, "html");
    expect(htmlEl).toHaveLength(1);
    expect(attr(htmlEl[0] as El, "lang")).toBe("en");
    const titles = byTag(root, "title");
    expect(titles).toHaveLength(1);
    expect(readable(titles[0] as El).length).toBeGreaterThan(5);
    expect(readable(titles[0] as El)).toMatch(/ \| Parol$/);

    // The banner is permanent and exact.
    const banners = all(root, (el) => hasClass(el, "demo-banner"));
    expect(banners).toHaveLength(1);
    expect(readable(banners[0] as El)).toBe(DEMO_BANNER);

    // Landmarks, skip link, one h1.
    expect(byTag(root, "main")).toHaveLength(1);
    expect(byTag(root, "header").length).toBeGreaterThanOrEqual(1);
    expect(byTag(root, "footer")).toHaveLength(1);
    expect(
      all(root, (el) => el.name === "nav" && hasAttr(el, "aria-label")).length,
    ).toBeGreaterThan(0);
    const skip = all(root, (el) => hasClass(el, "skip-link"));
    expect(skip).toHaveLength(1);
    expect(attr(skip[0] as El, "href")).toBe("#main");
    expect(attr(byTag(root, "main")[0] as El, "id")).toBe("main");
    expect(byTag(root, "h1")).toHaveLength(1);

    // The one stylesheet and the one script, from the shared asset URLs.
    const links = byTag(root, "link");
    expect(links.map((l) => attr(l, "href"))).toEqual([urls.asset("parol.css")]);
    const scripts = byTag(root, "script");
    expect(scripts).toHaveLength(1);
    expect(attr(scripts[0] as El, "src")).toBe(urls.asset("parol.js"));
    expect(hasAttr(scripts[0] as El, "defer")).toBe(true);
  }

  // Nothing the content security policy forbids.
  for (const script of byTag(root, "script")) {
    expect(hasAttr(script, "src"), "no inline script").toBe(true);
    expect(script.children, "script has no body").toHaveLength(0);
  }
  expect(byTag(root, "style"), "no style element").toHaveLength(0);
  walkAttrs(root, (el, name, value) => {
    expect(name === "style", `style attribute on <${el.name}>`).toBe(false);
    expect(/^on/i.test(name), `event handler ${name} on <${el.name}>`).toBe(false);
    if (["href", "src", "action", "formaction", "xlink:href"].includes(name)) {
      expect(FORBIDDEN_URL.test(value ?? ""), `${name} on <${el.name}> is a script URL`).toBe(
        false,
      );
    }
    expect(name === "target" && value === "_blank", "no new-window links").toBe(false);
  });
  for (const f of ["iframe", "object", "embed", "base"]) {
    expect(byTag(root, f), `no <${f}>`).toHaveLength(0);
  }

  // Ids are unique, and every reference to one resolves.
  const ids = attributeValues(root)
    .filter((a) => a.name === "id")
    .map((a) => a.value);
  expect(new Set(ids).size, "ids are unique").toBe(ids.length);
  for (const a of attributeValues(root)) {
    if (a.name === "for" || a.name === "form") {
      expect(byId(root, a.value), `${a.name}="${a.value}" resolves`).toBeDefined();
    }
    if (
      a.name === "aria-describedby" ||
      a.name === "aria-labelledby" ||
      a.name === "aria-controls"
    ) {
      for (const id of a.value.split(/\s+/)) {
        expect(byId(root, id), `${a.name} target ${id} exists`).toBeDefined();
      }
    }
  }

  // Forms: post, to a known URL, with the token. Controls tied to a form by id are checked too.
  for (const form of byTag(root, "form")) {
    expect(attr(form, "method")).toBe("post");
    const action = attr(form, "action") ?? "";
    expect(actions.has(action), `form action ${action} is in urls.ts`).toBe(true);
    const token = all(form, (el) => el.name === "input" && attr(el, "name") === CSRF_FIELD);
    expect(token, `form to ${action} has a csrf field`).toHaveLength(1);
    expect(attr(token[0] as El, "type")).toBe("hidden");
    expect(attr(token[0] as El, "value")).toBe(options.csrf ?? IDS.csrf);
    if (all(form, (el) => el.name === "input" && attr(el, "type") === "file").length > 0) {
      expect(attr(form, "enctype")).toBe("multipart/form-data");
    }
  }

  // Every control has a label.
  for (const control of all(root, (el) => FORM_CONTROLS.has(el.name))) {
    const type = attr(control, "type") ?? "text";
    if (control.name === "input" && NO_LABEL_NEEDED.has(type)) continue;
    const id = attr(control, "id");
    const named =
      hasAttr(control, "aria-label") ||
      hasAttr(control, "aria-labelledby") ||
      (id !== undefined &&
        id !== null &&
        all(root, (el) => el.name === "label" && attr(el, "for") === id).length > 0);
    expect(named, `<${control.name} name=${attr(control, "name")}> has a label`).toBe(true);
  }
  for (const label of byTag(root, "label")) {
    expect(readable(label).length, "a label has text").toBeGreaterThan(0);
  }

  // Buttons and links say something.
  for (const button of byTag(root, "button")) {
    expect(readable(button).length > 0 || hasAttr(button, "aria-label"), "button has text").toBe(
      true,
    );
  }
  for (const link of all(root, (el) => el.name === "a" && hasAttr(el, "href"))) {
    expect(readable(link).length > 0 || hasAttr(link, "aria-label"), "link has text").toBe(true);
  }

  // Tables: a caption, and a scope on every header.
  for (const table of byTag(root, "table")) {
    expect(byTag(table, "caption"), "table has a caption").toHaveLength(1);
    expect(byTag(table, "thead").length).toBe(1);
  }
  for (const th of byTag(root, "th")) {
    expect(["col", "row"], "th has a scope").toContain(attr(th, "scope"));
  }
  for (const region of all(root, (el) => hasClass(el, "table-scroll"))) {
    expect(attr(region, "tabindex"), "a scroll box can take focus").toBe("0");
    expect(hasAttr(region, "aria-label")).toBe(true);
    expect(attr(region, "role")).toBe("region");
  }

  // Chips carry words, and a shape that is hidden from assistive technology.
  for (const chip of all(root, (el) => hasClass(el, "chip"))) {
    expect(readable(chip).length, "a chip has text").toBeGreaterThan(0);
  }
  for (const shape of all(root, (el) => hasClass(el, "shape"))) {
    expect(attr(shape, "aria-hidden")).toBe("true");
    expect(readable(shape)).toBe("");
  }

  // Heading levels never skip downward.
  const levels = all(root, (el) => /^h[1-6]$/.test(el.name)).map((h) => Number(h.name[1]));
  let previous = options.fragment === true ? (levels[0] ?? 1) : 0;
  for (const level of levels) {
    expect(level, `heading level ${level} after ${previous}`).toBeLessThanOrEqual(previous + 1);
    previous = level;
  }

  // No em or en dash anywhere in what the application wrote.
  expect(html).not.toMatch(/[\u2013\u2014]/);
  return root;
}

function walkAttrs(root: El, visit: (el: El, name: string, value: string | null) => void): void {
  for (const el of all(root)) for (const a of el.attrs) visit(el, a.name, a.value);
}
