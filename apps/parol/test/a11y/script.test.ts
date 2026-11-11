import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FakeDocument,
  FakeElement,
  SCRIPT_PATH,
  event,
  runScript,
  type Harness,
} from "../pages/fake-dom.js";
import { all, attr, byTag, parseHtml, readable, type El } from "../pages/html.js";
import { matterPage, mattersPage, runPage } from "../pages/render.js";
import { buildMatterView, buildRunSummary, buildRunningMatterView } from "../pages/support.js";
import { variants } from "../pages/variants.js";
import { tabStops } from "./rules.js";

/**
 * What `public/parol.js` may do to a page that is used with the keyboard, and what the page does
 * when the script is not there. The one script adds shortcuts in the issue table, scrolls a quote
 * into view, stops a double submit and refreshes the progress of a review. These tests say what it
 * does not do:
 *
 * - it does not capture a key the page needs: a key it acts on, it acts on only inside the issue
 *   table, with no modifier held and the person not typing; every other key goes to the browser;
 * - it does not trap focus: it moves focus only when the person presses j, k or ? in the table, and
 *   once when a page opens on a chosen finding; never for Tab, never from a timer;
 * - it adds nothing a page needs: the page it leaves after it has loaded is the page it was sent,
 *   it creates and reveals nothing, and the shortcuts are on top of controls that work without it.
 *
 * The script is run against a small stand-in for a browser (`fake-dom.ts`) and read as text. That
 * shows what the script does to a page in that stand-in, not what any browser does with it.
 */

const source = readFileSync(SCRIPT_PATH, "utf8");

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

interface Modifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const MODIFIER_SETS: Modifiers[] = [
  {},
  { shiftKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { ctrlKey: true, shiftKey: true },
];

const NAMED_KEYS = [
  "Tab",
  "Enter",
  " ",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ContextMenu",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

const CHARACTERS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."?/.,;:'\"[]{}\\|-_=+`~!@#$%^&*()<>",
];

const ALL_KEYS = [...NAMED_KEYS, ...CHARACTERS];

/** Keys a person needs on a page whatever it is: to move, to choose, to scroll, to leave. */
const NEEDED = [
  "Tab",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Escape",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

interface Pressed {
  target: string;
  key: string;
  modifiers: string;
  prevented: boolean;
  stopped: boolean;
}

const nameOf = (m: Modifiers): string =>
  Object.entries(m)
    .filter(([, on]) => on === true)
    .map(([name]) => name.replace("Key", ""))
    .join("+") || "no modifier";

/** The review page with the table, the inspector and a finding chosen, and the elements keys go to. */
function reviewTargets(): { name: string; make: (h: Harness) => FakeElement }[] {
  const first = (selector: string) => (h: Harness) => {
    const found = h.doc.querySelector(selector);
    if (found === null) throw new Error(`the review page has no ${selector}`);
    return found;
  };
  const typingInTable =
    (tag: string, editable = false) =>
    (h: Harness) => {
      const field = new FakeElement(h.doc, null, tag);
      field.isContentEditable = editable;
      field.parent = h.doc.querySelector('[data-zone="issues"]');
      return field;
    };
  return [
    { name: "the issue table's box", make: first('[data-zone="issues"]') },
    { name: "a row link", make: first("[data-row-link]") },
    { name: "the evidence inspector", make: first("[data-inspector]") },
    { name: "the key list's summary", make: first("[data-keys-help] summary") },
    {
      name: "a link outside the table",
      make: (h) => {
        const found = h.doc
          .querySelectorAll("a")
          .find((a) => a.closest('[data-zone="issues"]') === null);
        if (found === undefined) throw new Error("no link outside the table");
        return found;
      },
    },
    { name: "a radio button", make: first('input[type="radio"]') },
    { name: "a text area", make: first("textarea") },
    { name: "a select", make: first("select") },
    { name: "a button", make: first("button") },
    { name: "the page", make: (h) => h.doc.body },
    { name: "an input inside the table", make: typingInTable("input") },
    { name: "a text area inside the table", make: typingInTable("textarea") },
    { name: "a select inside the table", make: typingInTable("select") },
    { name: "an editable element inside the table", make: typingInTable("div", true) },
  ];
}

/** Every key, with every set of modifiers, at every target; what the script did with each. */
function pressEverything(): Pressed[] {
  const out: Pressed[] = [];
  for (const target of reviewTargets()) {
    // A fresh page for each target, so that what one key did cannot change what the next finds.
    const h = runScript(runPage());
    const at = target.make(h);
    for (const key of ALL_KEYS) {
      for (const modifiers of MODIFIER_SETS) {
        const e = event("keydown", at, { key, ...modifiers });
        at.dispatch(e);
        out.push({
          target: target.name,
          key,
          modifiers: nameOf(modifiers),
          prevented: e.defaultPrevented,
          stopped: e.stopped,
        });
      }
    }
  }
  return out;
}

/**
 * The script's own account of when it acts, written out: in the issue table, outside a field the
 * person types into, with no control, command or alt key held, j and k move, ? lists the keys, and
 * Enter on the table's own box opens the chosen row. (Enter on a link is the browser's.)
 */
function mayBePrevented(p: Pressed): boolean {
  const inTable = [
    "the issue table's box",
    "a row link",
    // Fields inside the table's box are typed into, so no key is taken from them.
  ].includes(p.target);
  const held = /ctrl|meta|alt/.test(p.modifiers);
  if (!inTable || held) return false;
  if (["j", "k", "?"].includes(p.key)) return true;
  return p.key === "Enter" && p.target === "the issue table's box";
}

describe("a key the page needs is never taken from it", () => {
  // Made when first asked for, so a script that fails to run fails the tests that need it and not the whole file.
  let made: Pressed[] | undefined;
  const everything = (): Pressed[] => (made ??= pressEverything());

  it("is tried in many combinations: every key, six sets of modifiers, fourteen places", () => {
    expect(everything().length).toBe(
      ALL_KEYS.length * MODIFIER_SETS.length * reviewTargets().length,
    );
    expect(everything().length).toBeGreaterThan(8000);
  });

  it("is prevented in exactly the cases the script documents, and in no others", () => {
    const wrong = everything().filter((p) => p.prevented !== mayBePrevented(p));
    expect(wrong.map((p) => `${p.key} (${p.modifiers}) at ${p.target}`)).toEqual([]);
    // And the documented cases did happen, so that the check above is not an empty one.
    const happened = new Set(
      everything()
        .filter((p) => p.prevented)
        .map((p) => p.key),
    );
    expect([...happened].sort()).toEqual(["?", "Enter", "j", "k"]);
  });

  it("never takes Tab, the arrows, space, the paging keys, Backspace, Escape or a function key, anywhere", () => {
    const taken = everything().filter((p) => NEEDED.includes(p.key) && p.prevented);
    expect(taken.map((p) => `${p.key} (${p.modifiers}) at ${p.target}`)).toEqual([]);
  });

  it("never takes a key that has a control, command or alt key held", () => {
    const taken = everything().filter((p) => /ctrl|meta|alt/.test(p.modifiers) && p.prevented);
    expect(taken).toEqual([]);
  });

  it("never takes a key from a field the person types into, or from the evidence inspector and its form", () => {
    const places = [
      "the evidence inspector",
      "a radio button",
      "a text area",
      "a select",
      "a button",
      "a link outside the table",
      "the key list's summary",
      "the page",
      "an input inside the table",
      "a text area inside the table",
      "a select inside the table",
      "an editable element inside the table",
    ];
    expect(everything().filter((p) => places.includes(p.target) && p.prevented)).toEqual([]);
  });

  it("never stops an event from reaching the page", () => {
    expect(everything().filter((p) => p.stopped)).toEqual([]);
    expect(source).not.toMatch(/stopPropagation|stopImmediatePropagation|cancelBubble|returnValue/);
  });

  it("calls preventDefault in one place, the key handler, after the checks that let a key through", () => {
    const calls = [...source.matchAll(/preventDefault\(\)/g)];
    expect(calls).toHaveLength(3);
    const handler = source.slice(source.indexOf('doc.addEventListener("keydown"'));
    const end = handler.indexOf("\n    });");
    const body = handler.slice(0, end);
    expect([...body.matchAll(/preventDefault\(\)/g)]).toHaveLength(3);
    // Every call comes after the modifier check, the typing check and the check for the table.
    const firstCall = body.indexOf("preventDefault()");
    for (const guard of [
      "event.ctrlKey || event.metaKey || event.altKey",
      "typingIn(at)",
      "closest('[data-zone=\"issues\"]')",
    ])
      expect(body.indexOf(guard), guard).toBeLessThan(firstCall);
  });

  it("does not add a handler to Tab", () => {
    expect(source).not.toMatch(/["']Tab["']/);
    expect(source).not.toMatch(/keyCode|which\b|charCode/);
  });
});

// ---------------------------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------------------------

/** How many times anything on the page was given focus. */
const focusCalls = (h: Harness): number =>
  h.doc.root.descendants().reduce((total, el) => total + el.calls.focus, 0);

describe("the script cannot trap focus", () => {
  it("does not move focus for Tab or Shift+Tab, from any place", () => {
    for (const target of reviewTargets()) {
      // A finding is chosen, so the inspector holds its decision form: the radio buttons and the rest.
      const h = runScript(runPage());
      const before = focusCalls(h);
      const at = target.make(h);
      for (const shiftKey of [false, true]) {
        const e = event("keydown", at, { key: "Tab", shiftKey });
        at.dispatch(e);
        expect(e.defaultPrevented, target.name).toBe(false);
      }
      expect(focusCalls(h), target.name).toBe(before);
    }
  });

  it("moves focus only for j, k and ? in the table, and by one control each time", () => {
    const moved = new Set<string>();
    for (const key of ALL_KEYS) {
      const h = runScript(runPage({ selected: null }));
      const box = h.doc.querySelector('[data-zone="issues"]')!;
      const before = focusCalls(h);
      box.dispatch(event("keydown", box, { key }));
      const delta = focusCalls(h) - before;
      expect(delta, key).toBeLessThanOrEqual(1);
      if (delta > 0) moved.add(key);
    }
    expect([...moved].sort()).toEqual(["?", "j", "k"]);
  });

  it("does not move focus when the key list is closed, and leaves the person where they are", () => {
    const h = runScript(runPage({ selected: null }));
    const box = h.doc.querySelector('[data-zone="issues"]')!;
    const help = h.doc.querySelector("[data-keys-help]")!;
    box.dispatch(event("keydown", box, { key: "?" }));
    expect(help.open).toBe(true);
    const summary = help.querySelector("summary")!;
    expect(h.doc.activeElement).toBe(summary);
    const before = focusCalls(h);
    // Escape closes the list wherever it is pressed, and takes nothing from the page.
    for (const at of [summary, box, h.doc.body]) {
      help.open = true;
      const e = event("keydown", at, { key: "Escape" });
      at.dispatch(e);
      expect(help.open).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(focusCalls(h)).toBe(before);
    expect(h.doc.activeElement).toBe(summary);
  });

  it("puts focus on the inspector once, when the page opens on a chosen finding, and on nothing else", () => {
    const h = runScript(runPage());
    expect(focusCalls(h)).toBe(1);
    expect(h.doc.activeElement).toBe(h.doc.querySelector("[data-inspector]"));
    for (const html of [runPage({ selected: null }), matterPage(buildMatterView()), mattersPage()])
      expect(focusCalls(runScript(html))).toBe(0);
  });

  it("leaves focus alone when the address names a place on the page or the person is already somewhere", () => {
    // The skip link and the jump links of a notice lead to a place on the page; the script must not take over.
    expect(focusCalls(runScript(runPage(), { hash: "#decision" }))).toBe(0);
    const typing = runScript(runPage(), {
      before: (doc) => {
        const field = doc.querySelector("textarea")!;
        doc.activeElement = field;
      },
    });
    expect(focusCalls(typing)).toBe(0);
    expect(typing.doc.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("never moves focus for a timer: the progress of a review is followed for ten minutes without it", async () => {
    const running = () => runScript(matterPage(buildRunningMatterView()));
    const h = running();
    const answer = (body: unknown) =>
      h.respondWith(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) }));
    answer({
      status: "analyzing",
      label: "Analyzing",
      progress: { stage: "analyze", done: 2, total: 8 },
    });
    await h.advance(60_000);
    h.respondWith(() => Promise.reject(new Error("offline")));
    await h.advance(60_000);
    answer({ status: "succeeded", finished: true });
    await h.advance(60_000);
    expect(h.fetchCalls.length).toBeGreaterThan(5);
    expect(focusCalls(h)).toBe(0);
    expect(h.doc.activeElement).toBe(h.doc.body);
    // The same while someone types: the script says the review is done, in place, and leaves them there.
    const typing = running();
    const field = new FakeElement(typing.doc, null, "input");
    field.parent = typing.doc.body;
    typing.doc.activeElement = field;
    typing.respondWith(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: "succeeded", finished: true }),
      }),
    );
    await typing.advance(60_000);
    expect(focusCalls(typing)).toBe(0);
    expect(typing.doc.activeElement).toBe(field);
  });

  it("holds no way to keep focus: no blur, no tabindex, no autofocus, no dialog, no timer that repeats", () => {
    expect(source).not.toMatch(/\.blur\(|setInterval|requestAnimationFrame|requestIdleCallback/);
    expect(source).not.toMatch(/tabindex|tabIndex|autofocus|inert|aria-modal|showModal|\.show\(/);
    expect(source).not.toMatch(/focusin|focusout|"focus"|"blur"|activeElement\s*=[^=]/);
    // Three calls to focus() exist, one for each thing it does: a row, the key list, the inspector.
    const calls = [...source.matchAll(/\.focus\(/g)];
    expect(calls).toHaveLength(3);
    expect(source).toMatch(/link\.focus\(\);/);
    expect(source).toMatch(/summary\.focus\(\);/);
    expect(source).toMatch(/pane\.focus\(\{ preventScroll: true \}\);/);
  });

  it("is on pages that have no dialog, no modal and no autofocus, so there is nothing to be held in", () => {
    const found: string[] = [];
    for (const [name, make] of variants) {
      const root = parseHtml(make());
      for (const el of all(root)) {
        const role = attr(el, "role");
        if (
          el.name === "dialog" ||
          attr(el, "aria-modal") !== undefined ||
          attr(el, "autofocus") !== undefined ||
          role === "dialog" ||
          role === "alertdialog"
        )
          found.push(`${name}: <${el.name}>`);
      }
    }
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Everything works without the script
// ---------------------------------------------------------------------------------------------

/** The page as the script sees it: structure, attributes, classes and the state a script can set. */
function snapshot(el: FakeElement): string {
  if (el.tagName === "#text") return el.textContent;
  const state = [
    el
      .attributeEntries()
      .map(([name, value]) => `${name}=${value}`)
      .join(" "),
    [...el.classes].sort().join("."),
    `disabled=${el.disabled}`,
    `open=${el.open}`,
    `value=${String(el.value)}`,
    `max=${String(el.max)}`,
    `hidden=${el.hidden}`,
  ].join(" ");
  return `<${el.tagName} ${state}>${el.children.map(snapshot).join("")}</${el.tagName}>`;
}

describe("the page is the same with the script and without it", () => {
  const pages: [string, string][] = [
    ["the review, a finding chosen", runPage()],
    ["the review, nothing chosen", runPage({ selected: null })],
    ["the review, filtered", runPage({ filter: "open", selected: null })],
    [
      "the review, running",
      runPage({
        run: buildRunSummary({
          status: "analyzing",
          progress: { stage: "analyze", done: 1, total: 8 },
          finishedAt: null,
        }),
        issues: [],
        selected: null,
      }),
    ],
    ["the matter", matterPage(buildMatterView())],
    ["the matter, a review running", matterPage(buildRunningMatterView())],
    ["the matters", mattersPage()],
  ];

  it.each(pages)("is unchanged by loading the script: %s", (_name, html) => {
    const without = new FakeDocument(html);
    const withScript = runScript(html).doc;
    expect(snapshot(withScript.root)).toBe(snapshot(without.root));
  });

  it("is changed only by what the person does or by the review going on: a row marked, the key list opened, a button waiting, a number", async () => {
    // The few things the script writes, each seen to be written, so that the check above is not empty.
    const h = runScript(runPage({ selected: null }));
    const before = snapshot(h.doc.root);
    const box = h.doc.querySelector('[data-zone="issues"]')!;
    box.dispatch(event("keydown", box, { key: "j" }));
    box.dispatch(event("keydown", box, { key: "?" }));
    expect(snapshot(h.doc.root)).not.toBe(before);
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(1);
    expect(h.doc.querySelector("[data-keys-help]")!.open).toBe(true);
  });

  it("writes only a mark on a row, the state of the key list, the state of a button, a progress text and a bar", () => {
    const written = new Set(
      [...source.matchAll(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(
        (m) => m[1] as string,
      ),
    );
    expect([...written].sort()).toEqual(["disabled", "max", "open", "textContent", "value"]);
    const attributes = [...source.matchAll(/(?:set|remove)Attribute\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(attributes)).toEqual(new Set(["data-busy"]));
    const classes = [...source.matchAll(/classList\.(\w+)\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(new Set(classes)).toEqual(new Set(["toggle is-current"]));
  });

  it("creates no element, removes none, and shows nothing that was hidden", () => {
    expect(source).not.toMatch(
      /createElement|createTextNode|createDocumentFragment|appendChild|insertBefore|insertAdjacent|\.append\(|\.prepend\(|\.before\(|\.after\(|replaceChild|replaceWith|removeChild|\.remove\(|cloneNode|importNode/,
    );
    expect(source).not.toMatch(
      /\.hidden\s*=[^=]|["']hidden["']|\.style\b|className|\.innerText|setProperty|\.dataset/,
    );
  });

  it("never sends a form or follows a link by itself, and reloads only for a review that has ended", () => {
    expect(source).not.toMatch(
      /\.submit\(|requestSubmit|location\.(href|assign|replace)|location\s*=|window\.open|\.open\(|history\.(push|replace)State/,
    );
    expect([...source.matchAll(/location\.reload\(\)/g)]).toHaveLength(1);
    // The one click it makes is a key's doing; the one in the key handler is on a link.
    expect([...source.matchAll(/\.click\(\)/g)]).toHaveLength(1);
  });

  it("lets a form go: the submit handler does not prevent it, stop it or send it twice, and gives the buttons back", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const disabledNow = (): FakeElement[] =>
      h.doc.querySelectorAll("button").filter((button) => button.disabled);
    // The page itself sends some buttons disabled: Export memo with its reason, say.
    const sentDisabled = disabledNow();
    const forms = h.doc.querySelectorAll("form");
    expect(forms.length).toBeGreaterThan(3);
    for (const form of forms) {
      const e = event("submit", form);
      form.dispatch(e);
      expect(e.defaultPrevented, form.getAttribute("action") ?? "").toBe(false);
      expect(e.stopped).toBe(false);
    }
    await h.advance(1);
    expect(disabledNow().length).toBeGreaterThan(sentDisabled.length);
    // After the wait every button is back, so a download or a refused request leaves the page usable.
    await h.advance(20_000);
    expect(disabledNow()).toEqual(sentDisabled);
    expect(h.doc.querySelectorAll("[data-busy]")).toEqual([]);
  });
});

describe("every control the script adds a shortcut to works without it", () => {
  const withHook = (selector: string) =>
    variants.flatMap(([name, make]) => {
      const root = parseHtml(make());
      return all(root, (el) => matchesHook(el, selector)).map((el) => ({ name, root, el }));
    });
  const matchesHook = (el: El, selector: string): boolean => {
    const name = selector.replace(/\[.*$/, "");
    const attrName = /\[([\w-]+)/.exec(selector)?.[1];
    return (
      (name === "" || el.name === name) &&
      attrName !== undefined &&
      attr(el, attrName) !== undefined
    );
  };

  it("makes a row link a link that goes to the finding, with a stop of its own", () => {
    const rows = withHook("[data-row-link]");
    expect(rows.length).toBeGreaterThan(8);
    for (const { name, root, el } of rows) {
      expect(el.name, name).toBe("a");
      expect(attr(el, "href") ?? "", name).toMatch(
        /^\/matters\/[^/]+\/runs\/[^/]+\?(?:filter=\w+&)?finding=/,
      );
      expect(tabStops(root).includes(el), `${name}: a row link takes a tab stop`).toBe(true);
    }
  });

  it("makes the table a box that takes a stop, so a keyboard user can scroll it", () => {
    const boxes = withHook("[data-zone]").filter(({ el }) => attr(el, "data-zone") === "issues");
    expect(boxes.length).toBeGreaterThan(5);
    for (const { name, root, el } of boxes) {
      expect(attr(el, "tabindex"), name).toBe("0");
      expect(tabStops(root).includes(el), name).toBe(true);
    }
  });

  it("makes the key list a disclosure that opens by Enter or Space on a heading that takes a stop", () => {
    const lists = withHook("[data-keys-help]");
    expect(lists.length).toBeGreaterThan(5);
    for (const { name, root, el } of lists) {
      expect(el.name, name).toBe("details");
      const summary = el.children.find((c) => c.type === "element" && c.name === "summary") as El;
      expect(summary, name).toBeDefined();
      expect(tabStops(root).includes(summary), name).toBe(true);
    }
  });

  it("gives the inspector a stop and a name, so it is reached without the key that opens a row", () => {
    const panes = withHook("[data-inspector]");
    expect(panes.length).toBeGreaterThan(5);
    for (const { name, root, el } of panes) {
      expect(el.name, name).toBe("aside");
      expect(attr(el, "aria-label") ?? "", name).not.toBe("");
      expect(tabStops(root).includes(el), name).toBe(true);
    }
  });

  it("shows the progress of a review in words and a bar the server wrote, and says how to see it move without the script", () => {
    const boxes = withHook("[data-status-url]");
    expect(boxes.length).toBeGreaterThan(2);
    for (const { name, root, el } of boxes) {
      const stage = all(el, (child) => attr(child, "data-role") === "stage");
      expect(stage, name).toHaveLength(1);
      expect(
        all(el, (child) => child.name === "progress"),
        name,
      ).toHaveLength(1);
      // A page whose script is blocked still tells the person that a reload shows more.
      const text = all(root, (e) => e.name === "main")
        .map(readable)
        .join(" ");
      expect(text.toLowerCase(), `${name}: how to see progress without the script`).toContain(
        "reload",
      );
    }
  });

  it("carries one script, from the site, deferred, and no handler written into a page", () => {
    const bad: string[] = [];
    for (const [name, make] of variants) {
      const root = parseHtml(make());
      const scripts = byTag(root, "script");
      for (const script of scripts)
        if (attr(script, "src") !== "/assets/parol.js" || attr(script, "defer") === undefined)
          bad.push(`${name}: a script that is not the site's, deferred`);
      for (const el of all(root))
        for (const a of el.attrs)
          if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value ?? ""))
            bad.push(`${name}: <${el.name} ${a.name}>`);
      if (byTag(root, "noscript").length > 0) bad.push(`${name}: a noscript element`);
    }
    expect(bad).toEqual([]);
  });
});
