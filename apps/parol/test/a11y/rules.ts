/**
 * Accessibility rules over rendered HTML, for the page tests of Parol.
 *
 * Every rule is a pure function over the element tree that `test/pages/html.ts` reads. A rule
 * returns violations and never throws, so a test can assert `toEqual([])` and a self-test can assert
 * the exact violation for a crafted bad snippet. `expectAccessible` is the one helper a page test
 * calls; `tabStops` and `accessibleName` are the one keyboard and label helper (no other test file
 * may write its own).
 *
 * What these rules can show, and what they cannot. They read the HTML the application writes: which
 * elements take a tab stop, in which order, with which name, and which sentences the page marks as
 * "what to do". They do not run a browser, do not compute colour or contrast, do not apply the
 * stylesheet (so an element hidden by CSS is not known to be hidden), and do not run a screen reader.
 * The accessible name is the part of the accessible-name algorithm this application uses
 * (`aria-labelledby`, `aria-label`, `label`, `value`, `alt`, content, `title`), not the whole
 * algorithm. Nothing here is a claim of conformance to any standard.
 */
import { parseHtml, type El, type Node } from "../pages/html.js";

// ---------------------------------------------------------------------------------------------
// Public types and tables
// ---------------------------------------------------------------------------------------------

export const RULE_IDS = [
  "positive-tabindex",
  "interactive-removed-from-tab-order",
  "focusable-non-native",
  "focusable-unnamed",
  "title-only-name",
  "label-in-name",
  "distinct-button-names",
  "landmark-unnamed",
  "landmark-names-unique",
  "disabled-unexplained",
  "form-without-submit",
  "fragment-link-dangling",
  "skip-link-first",
  "aria-hidden-focusable",
  "error-needs-todo",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface Violation {
  rule: RuleId;
  /** The element, as `<button#id.class>`: tag, then its id, then its first class. */
  where: string;
  /** A fixed sentence about the rule. It names the element's accessible name at most, never page text. */
  detail: string;
}

export interface AuditOptions {
  /** A pane without the frame (no skip link, no `main`). */
  fragment?: boolean | undefined;
}

/**
 * The elements that are not native controls and may still take a tab stop, each with the reason.
 * A box that scrolls needs a stop so that a keyboard user can scroll it. A new entry needs a reason
 * here and a reviewer: `rules.test.ts` pins this list, so adding to it means editing that test too.
 */
export const SCROLL_REGIONS: readonly { why: string; test: (el: El) => boolean }[] = [
  {
    why: "a table's scroll box takes a stop so that the keyboard can scroll the table sideways",
    test: (el) => hasClass(el, "table-scroll"),
  },
  {
    why: "the evidence inspector takes focus when a finding is opened from the issue table",
    test: (el) => has(el, "data-inspector"),
  },
  {
    why: "a long passage scrolls inside its own box, which needs a stop to be scrolled by keyboard",
    test: (el) => el.name === "blockquote" && hasClass(el, "long"),
  },
];

// ---------------------------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------------------------

interface Index {
  root: El;
  /** Every element in document order (the root marker `#root` is not one). */
  elements: El[];
  parents: Map<El, El>;
  ids: Map<string, El>;
  labelsFor: Map<string, El[]>;
}

/** The value of an attribute, matched without regard to case, or "" when absent or bare. */
function str(el: El, name: string): string {
  const found = el.attrs.find((a) => a.name.toLowerCase() === name);
  return found?.value ?? "";
}

function has(el: El, name: string): boolean {
  return el.attrs.some((a) => a.name.toLowerCase() === name);
}

function classNames(el: El): string[] {
  return str(el, "class")
    .split(/\s+/)
    .filter((c) => c !== "");
}

function hasClass(el: El, name: string): boolean {
  return classNames(el).includes(name);
}

const isEl = (node: Node | undefined): node is El => node !== undefined && node.type === "element";

function buildIndex(root: El): Index {
  const ix: Index = {
    root,
    elements: root.name === "#root" ? [] : [root],
    parents: new Map(),
    ids: new Map(),
    labelsFor: new Map(),
  };
  const visit = (parent: El): void => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      ix.parents.set(child, parent);
      ix.elements.push(child);
      const id = str(child, "id");
      if (id !== "" && !ix.ids.has(id)) ix.ids.set(id, child);
      const target = str(child, "for");
      if (child.name === "label" && target !== "") {
        const list = ix.labelsFor.get(target) ?? [];
        list.push(child);
        ix.labelsFor.set(target, list);
      }
      visit(child);
    }
  };
  visit(root);
  if (root.name !== "#root") {
    const id = str(root, "id");
    if (id !== "" && !ix.ids.has(id)) ix.ids.set(id, root);
  }
  return ix;
}

/** Truncated, so a failure message stays one line. */
function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function where(el: El): string {
  const id = str(el, "id");
  const cls = classNames(el)[0];
  return `<${el.name}${id === "" ? "" : `#${id}`}${cls === undefined ? "" : `.${cls}`}>`;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Letters and digits in lower case, so that case, spacing and punctuation do not matter. */
const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const inputType = (el: El): string =>
  (has(el, "type") ? str(el, "type") : "text").trim().toLowerCase();

// ---------------------------------------------------------------------------------------------
// Focus: what takes a tab stop
// ---------------------------------------------------------------------------------------------

function tabindexOf(el: El): number | null {
  const raw = str(el, "tabindex");
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** `summary` takes a stop only as the first summary of its `details`. */
function isDisclosureSummary(ix: Index, el: El): boolean {
  if (el.name !== "summary") return false;
  const parent = ix.parents.get(el);
  if (parent === undefined || parent.name !== "details") return false;
  return parent.children.find((c) => isEl(c) && c.name === "summary") === el;
}

/** A control the browser makes focusable without a `tabindex`. */
function isNative(ix: Index, el: El): boolean {
  switch (el.name) {
    case "a":
      return has(el, "href");
    case "button":
    case "select":
    case "textarea":
      return true;
    case "input":
      return inputType(el) !== "hidden";
    case "summary":
      return isDisclosureSummary(ix, el);
    default:
      return false;
  }
}

const DISABLEABLE = new Set(["button", "input", "select", "textarea"]);

/** Disabled by its own attribute, or by a disabled `fieldset` it sits in (outside the first legend). */
function isDisabled(ix: Index, el: El): boolean {
  if (!DISABLEABLE.has(el.name)) return false;
  if (has(el, "disabled")) return true;
  let child = el;
  for (let node = ix.parents.get(el); node !== undefined; node = ix.parents.get(node)) {
    if (node.name === "fieldset" && has(node, "disabled")) {
      const legend = node.children.find((c) => isEl(c) && c.name === "legend");
      if (legend !== child) return true;
    }
    child = node;
  }
  return false;
}

/** Not removed from the page by `hidden`, `inert` or the closed state of a `details`. */
function isRendered(ix: Index, el: El): boolean {
  if (has(el, "hidden") || has(el, "inert")) return false;
  let child = el;
  for (let node = ix.parents.get(el); node !== undefined; node = ix.parents.get(node)) {
    if (has(node, "hidden") || has(node, "inert")) return false;
    if (node.name === "details" && !has(node, "open") && !isDisclosureSummary(ix, child)) {
      return false;
    }
    child = node;
  }
  return true;
}

function isTabStop(ix: Index, el: El): boolean {
  if (el.name === "input" && inputType(el) === "hidden") return false;
  if (isDisabled(ix, el) || !isRendered(ix, el)) return false;
  const tabindex = tabindexOf(el);
  if (tabindex !== null) return tabindex >= 0;
  return isNative(ix, el);
}

/** The form a control belongs to: the one its `form` attribute names, else the nearest ancestor form. */
function formOwner(ix: Index, el: El): El | null {
  const named = str(el, "form");
  if (named !== "") {
    const target = ix.ids.get(named);
    return target !== undefined && target.name === "form" ? target : null;
  }
  for (let node = ix.parents.get(el); node !== undefined; node = ix.parents.get(node)) {
    if (node.name === "form") return node;
  }
  return null;
}

const isRadio = (el: El): boolean => el.name === "input" && inputType(el) === "radio";

/** A browser tabs into a radio group once: at the checked radio, else at the first. */
function oneRadioPerGroup(ix: Index, stops: El[]): El[] {
  const chosen = new Set<El>();
  const groups = new Map<El | null, Map<string, El[]>>();
  for (const el of stops) {
    if (!isRadio(el)) continue;
    const name = str(el, "name");
    if (name === "") {
      chosen.add(el);
      continue;
    }
    const owner = formOwner(ix, el);
    const byName = groups.get(owner) ?? new Map<string, El[]>();
    groups.set(owner, byName);
    byName.set(name, [...(byName.get(name) ?? []), el]);
  }
  for (const byName of groups.values()) {
    for (const group of byName.values()) {
      // If several are marked checked, a browser keeps the last one.
      const checked = group.filter((r) => has(r, "checked"));
      const pick = checked.length > 0 ? checked[checked.length - 1] : group[0];
      if (pick !== undefined) chosen.add(pick);
    }
  }
  return stops.filter((el) => !isRadio(el) || chosen.has(el));
}

function stopsOf(ix: Index, groupRadios: boolean): El[] {
  const stops = ix.elements.filter((el) => isTabStop(ix, el));
  return groupRadios ? oneRadioPerGroup(ix, stops) : stops;
}

/**
 * The elements that Tab reaches, in document order. That is: `a[href]`, `button`, `input` that is not
 * hidden, `select`, `textarea`, the first `summary` of a `details`, and anything with `tabindex` 0 or
 * more; minus anything disabled, hidden or inert, minus a negative `tabindex`, and minus anything
 * inside a closed `details` other than its summary. A radio group is one stop (the checked radio, else
 * the first) unless `groupRadios` is false. A positive `tabindex` is not simulated (a browser visits
 * those first): the rule `positive-tabindex` reports it instead.
 */
export function tabStops(root: El, options: { groupRadios?: boolean | undefined } = {}): El[] {
  return stopsOf(buildIndex(root), options.groupRadios !== false);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Elements whose name may come from their content. A landmark's or a scroll box's may not. */
const NAME_FROM_CONTENT = new Set([
  "a",
  "button",
  "summary",
  "option",
  "label",
  "legend",
  "caption",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const FORM_CONTROLS = new Set([
  "input",
  "select",
  "textarea",
  "button",
  "meter",
  "progress",
  "output",
]);

function textInto(node: Node, skip: (el: El) => boolean, withAlt: boolean, parts: string[]): void {
  if (node.type === "text") {
    parts.push(node.text);
    return;
  }
  if (node.name === "script" || node.name === "style" || has(node, "hidden") || skip(node)) return;
  if (node.name === "img") {
    if (withAlt) parts.push(` ${str(node, "alt")} `);
    return;
  }
  const block = BLOCKS.has(node.name);
  if (block) parts.push(" ");
  for (const child of node.children) textInto(child, skip, withAlt, parts);
  if (block) parts.push(" ");
}

/** Text a screen reader would read from the content: `aria-hidden` parts are left out, `sr-only` parts are in. */
function contentText(el: El, skipControls = false): string {
  const parts: string[] = [];
  const skip = (e: El): boolean =>
    str(e, "aria-hidden") === "true" || (skipControls && FORM_CONTROLS.has(e.name));
  for (const child of el.children) textInto(child, skip, true, parts);
  return collapse(parts.join(""));
}

/** Text a sighted person reads from the content: `sr-only` parts are out, `aria-hidden` parts are in. */
function visibleText(el: El): string {
  const parts: string[] = [];
  for (const child of el.children) textInto(child, (e) => hasClass(e, "sr-only"), false, parts);
  return collapse(parts.join(""));
}

/** What an element that is named or described by another contributes. */
function referencedText(el: El): string {
  const label = collapse(str(el, "aria-label"));
  return label !== "" ? label : contentText(el);
}

type NameSource =
  "aria-labelledby" | "aria-label" | "label" | "value" | "alt" | "content" | "title" | "none";

interface Named {
  name: string;
  source: NameSource;
}

const LABELABLE = (el: El): boolean =>
  FORM_CONTROLS.has(el.name) && !(el.name === "input" && inputType(el) === "hidden");

function labelsOf(ix: Index, el: El): El[] {
  const labels: El[] = [];
  const id = str(el, "id");
  if (id !== "") labels.push(...(ix.labelsFor.get(id) ?? []));
  for (let node = ix.parents.get(el); node !== undefined; node = ix.parents.get(node)) {
    if (node.name === "label") {
      if (!has(node, "for") && !labels.includes(node)) labels.push(node);
      break;
    }
  }
  return labels;
}

function nameInfo(ix: Index, el: El): Named {
  const by = str(el, "aria-labelledby")
    .split(/\s+/)
    .map((id) => ix.ids.get(id))
    .filter(isEl)
    .map(referencedText)
    .join(" ");
  if (collapse(by) !== "") return { name: collapse(by), source: "aria-labelledby" };

  const label = collapse(str(el, "aria-label"));
  if (label !== "") return { name: label, source: "aria-label" };

  if (LABELABLE(el)) {
    const text = collapse(
      labelsOf(ix, el)
        .map((l) => contentText(l, true))
        .join(" "),
    );
    if (text !== "") return { name: text, source: "label" };
    if (el.name === "input") {
      const type = inputType(el);
      if (["submit", "button", "reset"].includes(type) && collapse(str(el, "value")) !== "") {
        return { name: collapse(str(el, "value")), source: "value" };
      }
      if (type === "image" && collapse(str(el, "alt")) !== "") {
        return { name: collapse(str(el, "alt")), source: "alt" };
      }
    }
  }

  if (NAME_FROM_CONTENT.has(el.name)) {
    const text = contentText(el);
    if (text !== "") return { name: text, source: "content" };
  }

  const title = collapse(str(el, "title"));
  if (title !== "") return { name: title, source: "title" };
  return { name: "", source: "none" };
}

/**
 * The accessible name of an element, in this order: the text of the elements `aria-labelledby` names,
 * `aria-label`, the text of its `label` (and `value` for a submit button, `alt` for an image input),
 * its content (text hidden from assistive technology is left out, `sr-only` text counts) for the
 * elements that are named from content (links, buttons, summaries, headings, cells), and last
 * `title`. A landmark or a scroll box is never named from its content. "" when there is no name.
 */
export function accessibleName(root: El, el: El): string {
  return nameInfo(buildIndex(root), el).name;
}

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

interface Context {
  ix: Index;
  options: AuditOptions;
  report: (el: El, detail: string) => void;
}

const isScrollRegion = (el: El): boolean => SCROLL_REGIONS.some((r) => r.test(el));

const BUTTON_INPUTS = ["submit", "button", "reset"];
const isButtonLike = (el: El): boolean =>
  el.name === "button" || (el.name === "input" && BUTTON_INPUTS.includes(inputType(el)));

/** What the keyboard can focus and activate or read, for the rules about names. */
function namedTargets(ix: Index): El[] {
  return ix.elements.filter((el) => {
    if (isDisabled(ix, el)) return false;
    if (isNative(ix, el)) return true;
    const tabindex = tabindexOf(el);
    return tabindex !== null && tabindex >= 0 && isScrollRegion(el);
  });
}

function landmarks(ix: Index): El[] {
  return ix.elements.filter(
    (el) =>
      el.name === "nav" ||
      el.name === "aside" ||
      str(el, "role") === "region" ||
      (el.name === "section" && has(el, "aria-labelledby")),
  );
}

const RULES: Record<RuleId, (c: Context) => void> = {
  "positive-tabindex"({ ix, report }) {
    for (const el of ix.elements) {
      const tabindex = tabindexOf(el);
      if (tabindex !== null && tabindex > 0) {
        report(el, `tabindex=${tabindex} moves this element out of the order of the page`);
      }
    }
  },

  "interactive-removed-from-tab-order"({ ix, report }) {
    for (const el of ix.elements) {
      const tabindex = tabindexOf(el);
      if (tabindex !== null && tabindex < 0 && isNative(ix, el)) {
        report(el, `a control with tabindex=${tabindex} cannot be reached with Tab`);
      }
    }
  },

  "focusable-non-native"({ ix, report }) {
    for (const el of ix.elements) {
      const tabindex = tabindexOf(el);
      if (tabindex === null || tabindex < 0 || isNative(ix, el)) continue;
      if (el.name === "input" && inputType(el) === "hidden") continue;
      if (!isScrollRegion(el)) {
        report(
          el,
          "an element that is not a control takes a tab stop and is not a known scroll region",
        );
      }
    }
  },

  "focusable-unnamed"({ ix, report }) {
    for (const el of namedTargets(ix)) {
      if (nameInfo(ix, el).name === "") report(el, "a tab stop with no accessible name");
    }
  },

  "title-only-name"({ ix, report }) {
    for (const el of namedTargets(ix)) {
      const named = nameInfo(ix, el);
      if (named.source === "title") {
        report(
          el,
          `named only by its title ("${short(named.name)}"), which a keyboard user may never see`,
        );
      }
    }
  },

  "label-in-name"({ ix, report }) {
    for (const el of ix.elements) {
      const hasVisibleLabel =
        el.name === "a" || el.name === "button" || el.name === "summary" || isButtonLike(el);
      if (!hasVisibleLabel || !isNative(ix, el)) continue;
      const named = nameInfo(ix, el);
      if (named.source !== "aria-label" && named.source !== "aria-labelledby") continue;
      const visible = el.name === "input" ? collapse(str(el, "value")) : visibleText(el);
      const wanted = norm(visible);
      if (wanted !== "" && !norm(named.name).includes(wanted)) {
        report(
          el,
          `the visible text "${short(visible)}" is not part of the accessible name "${short(named.name)}"`,
        );
      }
    }
  },

  "distinct-button-names"({ ix, report }) {
    const byName = new Map<string, Map<string, El>>();
    for (const el of ix.elements) {
      const submitInput = el.name === "input" && inputType(el) === "submit";
      if (el.name !== "button" && !submitInput) continue;
      if (isDisabled(ix, el)) continue;
      const name = norm(nameInfo(ix, el).name);
      if (name === "") continue;
      const owner = formOwner(ix, el);
      const action = `${owner === null ? "" : str(owner, "action")}|${str(el, "name")}=${str(el, "value")}`;
      const actions = byName.get(name) ?? new Map<string, El>();
      byName.set(name, actions);
      if (!actions.has(action)) actions.set(action, el);
    }
    for (const [name, actions] of byName) {
      const second = [...actions.values()][1];
      if (second !== undefined) {
        report(
          second,
          `${actions.size} buttons named "${short(name)}" do different things; give each its own name`,
        );
      }
    }
  },

  "landmark-unnamed"({ ix, report }) {
    for (const el of landmarks(ix)) {
      if (nameInfo(ix, el).name === "") report(el, `a ${el.name} landmark needs a name`);
    }
  },

  "landmark-names-unique"({ ix, report }) {
    const byName = new Map<string, El[]>();
    for (const el of landmarks(ix)) {
      const name = norm(nameInfo(ix, el).name);
      if (name !== "") byName.set(name, [...(byName.get(name) ?? []), el]);
    }
    for (const [name, list] of byName) {
      const second = list[1];
      if (second !== undefined) {
        report(second, `${list.length} landmarks on the page are called "${short(name)}"`);
      }
    }
  },

  "disabled-unexplained"({ ix, report }) {
    for (const el of ix.elements) {
      if (!isButtonLike(el) || !has(el, "disabled")) continue;
      const explained = str(el, "aria-describedby")
        .split(/\s+/)
        .map((id) => ix.ids.get(id))
        .filter(isEl)
        .some((target) => referencedText(target) !== "");
      if (!explained)
        report(
          el,
          "a disabled button must point, with aria-describedby, at the sentence that says why",
        );
    }
  },

  "form-without-submit"({ ix, report }) {
    const withSubmit = new Set<El>();
    for (const el of ix.elements) {
      const type = inputType(el);
      const submits =
        (el.name === "button" &&
          !["button", "reset"].includes(str(el, "type").trim().toLowerCase())) ||
        (el.name === "input" && (type === "submit" || type === "image"));
      if (!submits) continue;
      const owner = formOwner(ix, el);
      if (owner !== null) withSubmit.add(owner);
    }
    for (const el of ix.elements) {
      if (el.name === "form" && !withSubmit.has(el)) report(el, "a form with no submit button");
    }
  },

  "fragment-link-dangling"({ ix, report }) {
    for (const el of ix.elements) {
      if (el.name !== "a") continue;
      const href = str(el, "href");
      if (!href.startsWith("#")) continue;
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // An undecodable fragment is looked up as written.
      }
      if (!ix.ids.has(id)) report(el, `no element has the id "${short(id)}"`);
    }
  },

  "skip-link-first"({ ix, options, report }) {
    if (options.fragment === true) return;
    const first = stopsOf(ix, true)[0];
    const skip =
      first !== undefined &&
      first.name === "a" &&
      hasClass(first, "skip-link") &&
      str(first, "href") === "#main";
    if (!skip)
      report(first ?? ix.root, "the first tab stop of a page must be the skip link to #main");
    const main = ix.ids.get("main");
    if (main === undefined)
      report(ix.root, "the page has no element with the id main for the skip link to reach");
    else if (tabindexOf(main) !== -1)
      report(main, "main must have tabindex=-1 so that the skip link moves focus into it");
  },

  "aria-hidden-focusable"({ ix, report }) {
    const stops = stopsOf(ix, false);
    const hidden = (el: El): boolean => str(el, "aria-hidden") === "true";
    const outermost = ix.elements.filter((el) => {
      if (!hidden(el)) return false;
      for (let node = ix.parents.get(el); node !== undefined; node = ix.parents.get(node)) {
        if (hidden(node)) return false;
      }
      return true;
    });
    for (const el of outermost) {
      if (stops.some((stop) => under(ix, stop, el))) {
        report(el, "hidden from assistive technology, yet it holds a tab stop");
      }
    }
  },

  "error-needs-todo"({ ix, report }) {
    const marked = (el: El): boolean =>
      ix.elements.some(
        (x) => x !== el && hasClass(x, "todo") && contentText(x) !== "" && under(ix, x, el),
      );
    for (const el of ix.elements) {
      if (hasClass(el, "error-page")) {
        if (!marked(el))
          report(el, "an error page must mark the sentence that says what to do (class todo)");
        const way = ix.elements.some(
          (x) =>
            x !== el &&
            under(ix, x, el) &&
            (x.name === "button" || (x.name === "a" && has(x, "href"))),
        );
        if (!way) report(el, "an error page needs a link or a button to go on");
      }
      if (hasClass(el, "notice-error") && !marked(el)) {
        report(el, "an error notice must mark the sentence that says what to do (class todo)");
      }
    }
  },
};

/** True when `el` is `ancestor` or sits inside it. */
function under(ix: Index, el: El, ancestor: El): boolean {
  for (let node: El | undefined = el; node !== undefined; node = ix.parents.get(node)) {
    if (node === ancestor) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Auditing
// ---------------------------------------------------------------------------------------------

/** Every violation, rule by rule in `RULE_IDS` order and in document order within a rule. */
export function auditPage(root: El, options: AuditOptions = {}): Violation[] {
  const ix = buildIndex(root);
  const found: Violation[] = [];
  for (const rule of RULE_IDS) {
    RULES[rule]({
      ix,
      options,
      report: (el, detail) => found.push({ rule, where: where(el), detail }),
    });
  }
  return found;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.rule} ${v.where}: ${v.detail}`).join("\n");
}

/**
 * Parses a page (or a pane, with `fragment`), audits it and fails with the list of violations. Returns
 * the parsed tree so a test can go on to query it.
 */
export function expectAccessible(html: string | El, options: AuditOptions = {}): El {
  const root = typeof html === "string" ? parseHtml(html) : html;
  const violations = auditPage(root, options);
  if (violations.length > 0) {
    const count =
      violations.length === 1
        ? "1 accessibility problem"
        : `${violations.length} accessibility problems`;
    throw new Error(`${count}:\n${formatViolations(violations)}`);
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// The failing and the passing example of every rule (checked by rules.test.ts)
// ---------------------------------------------------------------------------------------------

export interface RuleCase {
  /** A snippet that breaks this rule and no other. */
  bad: string;
  /** The same snippet repaired: no rule reports anything. */
  good: string;
  /** False for a whole page; true (the default) for a snippet. */
  fragment?: boolean;
}

const PAGE = (body: string): string =>
  `<!doctype html><html lang="en"><head><title>Example | Parol</title></head><body>${body}</body></html>`;

export const RULE_CASES: Record<RuleId, RuleCase> = {
  "positive-tabindex": {
    bad: '<button type="button" tabindex="2">Go</button>',
    good: '<button type="button">Go</button>',
  },
  "interactive-removed-from-tab-order": {
    bad: '<button type="button" tabindex="-1">Go</button>',
    good: '<button type="button">Go</button>',
  },
  "focusable-non-native": {
    bad: '<div tabindex="0"><p>Scrolls</p></div>',
    good: '<div class="table-scroll" role="region" aria-label="Rows" tabindex="0"><p>Scrolls</p></div>',
  },
  "focusable-unnamed": {
    bad: '<button type="button"></button>',
    good: '<button type="button">Go</button>',
  },
  "title-only-name": {
    bad: '<button type="button" title="Close"></button>',
    good: '<button type="button" title="Close the panel">Close</button>',
  },
  "label-in-name": {
    bad: '<button type="button" aria-label="Save stated date of version 2">Save date</button>',
    good: '<button type="button" aria-label="Save date of version 2">Save date</button>',
  },
  "distinct-button-names": {
    bad:
      '<form method="post" action="/documents/a/versions"><button type="submit">Upload new version</button></form>' +
      '<form method="post" action="/documents/b/versions"><button type="submit">Upload new version</button></form>',
    good:
      '<form method="post" action="/documents/a/versions"><button type="submit" aria-label="Upload new version of D1">Upload new version</button></form>' +
      '<form method="post" action="/documents/b/versions"><button type="submit" aria-label="Upload new version of D2">Upload new version</button></form>',
  },
  "landmark-unnamed": {
    bad: '<nav><ul><li><a href="/matters">Matters</a></li></ul></nav>',
    good: '<nav aria-label="Primary"><ul><li><a href="/matters">Matters</a></li></ul></nav>',
  },
  "landmark-names-unique": {
    bad:
      '<nav aria-label="Pages"><a href="/a">A</a></nav>' +
      '<nav aria-label="Pages"><a href="/b">B</a></nav>',
    good:
      '<nav aria-label="Pages"><a href="/a">A</a></nav>' +
      '<nav aria-label="Sections"><a href="/b">B</a></nav>',
  },
  "disabled-unexplained": {
    bad: '<button type="button" disabled>Export memo</button>',
    good:
      '<p id="why">Decide every finding first.</p>' +
      '<button type="button" disabled aria-describedby="why">Export memo</button>',
  },
  "form-without-submit": {
    bad: '<form method="post" action="/notes"><label for="note">Note</label><input type="text" id="note" name="note"></form>',
    good:
      '<form method="post" action="/notes"><label for="note">Note</label><input type="text" id="note" name="note">' +
      '<button type="submit">Save note</button></form>',
  },
  "fragment-link-dangling": {
    bad: '<a href="#decision">Go to the decision</a>',
    good: '<a href="#decision">Go to the decision</a><h2 id="decision">Decision</h2>',
  },
  "skip-link-first": {
    fragment: false,
    bad: PAGE(
      '<nav aria-label="Primary"><a href="/matters">Matters</a></nav><main id="main" tabindex="-1"><h1>Example</h1></main>',
    ),
    good: PAGE(
      '<a class="skip-link" href="#main">Skip to main content</a>' +
        '<nav aria-label="Primary"><a href="/matters">Matters</a></nav><main id="main" tabindex="-1"><h1>Example</h1></main>',
    ),
  },
  "aria-hidden-focusable": {
    bad: '<div aria-hidden="true"><button type="button">Hidden</button></div>',
    good:
      '<div aria-hidden="true"><span class="shape"></span></div>' +
      '<button type="button">Visible</button>',
  },
  "error-needs-todo": {
    bad: '<div class="error-page" role="alert"><p>It broke.</p><a class="button" href="/matters">Back</a></div>',
    good:
      '<div class="error-page" role="alert"><p>It broke. <span class="todo">Go back and try again.</span></p>' +
      '<a class="button" href="/matters">Back</a></div>',
  },
};
