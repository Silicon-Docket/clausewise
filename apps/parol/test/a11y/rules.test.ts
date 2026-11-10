import { describe, expect, it } from "vitest";
import { Layout, render } from "../../src/server/pages/index.js";
import { attr, byId, parseHtml, type El } from "../pages/html.js";
import { buildChrome } from "../pages/support.js";
import {
  RULE_CASES,
  RULE_IDS,
  SCROLL_REGIONS,
  accessibleName,
  auditPage,
  expectAccessible,
  formatViolations,
  tabStops,
  type AuditOptions,
  type RuleId,
} from "./rules.js";

const FRAGMENT: AuditOptions = { fragment: true };

/** The en dash and the em dash, spelled by code point so that this file holds neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const audit = (html: string, options: AuditOptions = FRAGMENT) =>
  auditPage(parseHtml(html), options);

/** The distinct rules reported for a snippet, in the order of RULE_IDS. */
const rulesOf = (html: string, options: AuditOptions = FRAGMENT): RuleId[] => {
  const seen = new Set(audit(html, options).map((v) => v.rule));
  return RULE_IDS.filter((id) => seen.has(id));
};

/** The ids of the tab stops (or the tag when an element has no id). */
const stopIds = (html: string, groupRadios?: boolean): string[] =>
  tabStops(parseHtml(html), groupRadios === undefined ? {} : { groupRadios }).map(
    (el) => (attr(el, "id") as string | undefined) ?? el.name,
  );

const nameOf = (html: string, id: string): string => {
  const root = parseHtml(html);
  return accessibleName(root, byId(root, id) as El);
};

describe("the rule table", () => {
  it("lists each rule once, in kebab case", () => {
    expect(RULE_IDS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    for (const id of RULE_IDS) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("has a failing and a passing example for every rule and for nothing else", () => {
    expect(Object.keys(RULE_CASES).sort()).toEqual([...RULE_IDS].sort());
  });

  for (const id of RULE_IDS) {
    describe(id, () => {
      const example = RULE_CASES[id];
      const options: AuditOptions = { fragment: example.fragment !== false };

      it("reports its failing example, and only this rule", () => {
        const violations = audit(example.bad, options);
        expect(violations.length).toBeGreaterThan(0);
        expect([...new Set(violations.map((v) => v.rule))]).toEqual([id]);
      });

      it("reports nothing for its passing example", () => {
        expect(audit(example.good, options)).toEqual([]);
      });

      it("gives each violation a place and a sentence", () => {
        for (const v of audit(example.bad, options)) {
          expect(v.where).toMatch(/^<[#a-z0-9.-]+>$/);
          expect(v.detail.length).toBeGreaterThan(10);
          expect(v.detail).not.toMatch(DASHES);
        }
      });
    });
  }

  it("reports in the order of the table, and in document order within a rule", () => {
    const html =
      '<button type="button" tabindex="3">B</button>' +
      '<button type="button" tabindex="-1">C</button>' +
      '<button type="button" tabindex="2">D</button>';
    const found = audit(html).map((v) => `${v.rule} ${v.detail.match(/tabindex=-?\d+/)?.[0]}`);
    expect(found).toEqual([
      "positive-tabindex tabindex=3",
      "positive-tabindex tabindex=2",
      "interactive-removed-from-tab-order tabindex=-1",
    ]);
  });
});

describe("tabindex rules", () => {
  it("positive-tabindex reports any value above 0, and only those", () => {
    expect(rulesOf('<button type="button" tabindex="1">Go</button>')).toEqual([
      "positive-tabindex",
    ]);
    expect(rulesOf('<button type="button" tabindex="0">Go</button>')).toEqual([]);
    expect(rulesOf('<div tabindex="1">x</div>')).toEqual([
      "positive-tabindex",
      "focusable-non-native",
    ]);
  });

  it("interactive-removed-from-tab-order reports a link and a summary as well as a button", () => {
    expect(rulesOf('<a href="/x" tabindex="-1">Go</a>')).toEqual([
      "interactive-removed-from-tab-order",
    ]);
    expect(rulesOf('<details><summary tabindex="-1">More</summary><p>x</p></details>')).toEqual([
      "interactive-removed-from-tab-order",
    ]);
  });

  it("interactive-removed-from-tab-order leaves a page target that is not a control alone", () => {
    expect(rulesOf('<main id="main" tabindex="-1"><h1>Title</h1></main>')).toEqual([]);
    expect(rulesOf('<input type="hidden" name="a" value="b" tabindex="-1">')).toEqual([]);
  });

  it("focusable-non-native reports a span and a link without href", () => {
    expect(rulesOf('<span tabindex="0">Go</span>')).toEqual(["focusable-non-native"]);
    expect(rulesOf('<a tabindex="0">Go</a>')).toEqual(["focusable-non-native"]);
  });

  it("focusable-non-native accepts exactly the known scroll regions", () => {
    expect(
      rulesOf(
        '<aside data-inspector="" aria-label="Evidence inspector" tabindex="0"><p>x</p></aside>',
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        '<blockquote class="doc-text long" role="region" aria-label="Text of section 4" tabindex="0">Long</blockquote>',
      ),
    ).toEqual([]);
    expect(rulesOf('<blockquote class="doc-text" tabindex="0">Short</blockquote>')).toEqual([
      "focusable-non-native",
    ]);
  });

  it("does not ask for a stop on a short passage", () => {
    expect(rulesOf('<blockquote class="doc-text"><p>Short</p></blockquote>')).toEqual([]);
  });
});

describe("names", () => {
  it("focusable-unnamed reports a scroll region that has no label, even one full of text", () => {
    expect(rulesOf('<div class="table-scroll" tabindex="0"><p>Rows</p></div>')).toEqual([
      "focusable-unnamed",
    ]);
    expect(
      rulesOf('<blockquote class="doc-text long" tabindex="0">Long text</blockquote>'),
    ).toEqual(["focusable-unnamed"]);
  });

  it("focusable-unnamed reports a radio with no label and accepts one with a label", () => {
    expect(rulesOf('<input type="radio" name="v" value="1">')).toEqual(["focusable-unnamed"]);
    expect(
      rulesOf(
        '<input type="radio" id="r1" name="v" value="1"><label for="r1" class="sr-only">Make version 1 operative</label>',
      ),
    ).toEqual([]);
  });

  it("focusable-unnamed looks inside a closed details, where a control is not a tab stop yet", () => {
    expect(
      rulesOf('<details><summary>More</summary><button type="button"></button></details>'),
    ).toEqual(["focusable-unnamed"]);
  });

  it("focusable-unnamed leaves a disabled control to disabled-unexplained", () => {
    expect(rulesOf('<button type="button" disabled></button>')).toEqual(["disabled-unexplained"]);
  });

  it("accepts a name from an implicit label, aria-labelledby, a value, or screen-reader text", () => {
    expect(rulesOf('<label>Name <input type="text" name="n"></label>')).toEqual([]);
    expect(
      rulesOf(
        '<span id="n">Save note</span><button type="button" aria-labelledby="n">Save</button>',
      ),
    ).toEqual([]);
    expect(rulesOf('<input type="submit" value="Send">')).toEqual([]);
    expect(rulesOf('<a href="/x"><span class="sr-only">Open matter</span></a>')).toEqual([]);
    expect(rulesOf('<button type="button" aria-label="">Go</button>')).toEqual([]);
  });

  it("does not take a name from a shape that is hidden from assistive technology", () => {
    expect(rulesOf('<a href="/x"><span class="shape" aria-hidden="true"></span></a>')).toEqual([
      "focusable-unnamed",
    ]);
    expect(rulesOf('<input type="submit">')).toEqual(["focusable-unnamed"]);
  });

  it("title-only-name reports a title that is the only name", () => {
    expect(rulesOf('<a href="/x" title="Home"></a>')).toEqual(["title-only-name"]);
    expect(rulesOf('<input type="text" id="t" title="Name">')).toEqual(["title-only-name"]);
  });
});

describe("label-in-name", () => {
  it("leaves out screen-reader-only text from what is visible", () => {
    expect(
      rulesOf(
        '<button type="button" aria-label="Save the date">Save<span class="sr-only"> date</span></button>',
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        '<button type="button" aria-label="Save date">Go<span class="sr-only"> save date</span></button>',
      ),
    ).toEqual(["label-in-name"]);
  });

  it("ignores case, spacing and punctuation", () => {
    expect(
      rulesOf('<button type="button" aria-label="save  date for D1">Save date:</button>'),
    ).toEqual([]);
  });

  it("ignores visible text that has no letter or digit in it", () => {
    expect(rulesOf('<button type="button" aria-label="Close">&#215;</button>')).toEqual([]);
  });

  it("checks a link and a submit input, and a name that aria-labelledby gives", () => {
    expect(rulesOf('<a href="/x" aria-label="Open the NDA">Open</a>')).toEqual([]);
    expect(rulesOf('<a href="/x" aria-label="Show the NDA">Open</a>')).toEqual(["label-in-name"]);
    expect(rulesOf('<input type="submit" value="Send now" aria-label="Deliver">')).toEqual([
      "label-in-name",
    ]);
    expect(
      rulesOf(
        '<span id="n">Delete</span><button type="button" aria-label="Save date" aria-labelledby="n">Save date</button>',
      ),
    ).toEqual(["label-in-name"]);
  });
});

describe("distinct-button-names", () => {
  it("tells two buttons of one form apart by their own name and value", () => {
    const form = (a: string, b: string): string =>
      `<form method="post" action="/r"><button type="submit" name="d" value="${a}">Accept</button>` +
      `<button type="submit" name="d" value="${b}">Accept</button></form>`;
    expect(rulesOf(form("a", "b"))).toEqual(["distinct-button-names"]);
    expect(rulesOf(form("a", "a"))).toEqual([]);
  });

  it("tells two submit inputs of the same value apart by the action of their forms", () => {
    const html =
      '<form method="post" action="/documents/a/remove"><input type="submit" value="Remove"></form>' +
      '<form method="post" action="/documents/b/remove"><input type="submit" value="Remove"></form>';
    const found = audit(html).filter((v) => v.rule === "distinct-button-names");
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('2 buttons named "remove"');
    expect(rulesOf(html)).toEqual(["distinct-button-names"]);
    // The same two inputs in two forms to one action do the same thing and may share the name.
    expect(
      rulesOf(
        '<form method="post" action="/r"><input type="submit" value="Remove"></form>' +
          '<form method="post" action="/r"><input type="submit" value="Remove"></form>',
      ),
    ).toEqual([]);
  });

  it("lets two forms to one action share a name", () => {
    expect(
      rulesOf(
        '<form method="post" action="/a"><button type="submit">Go</button></form>' +
          '<form method="post" action="/a"><button type="submit">Go</button></form>',
      ),
    ).toEqual([]);
  });

  it("follows the form attribute to the form a button belongs to", () => {
    expect(
      rulesOf(
        '<form id="f1" method="post" action="/a"></form><form id="f2" method="post" action="/b"></form>' +
          '<button type="submit" form="f1">Save date</button><button type="submit" form="f2">Save date</button>',
      ),
    ).toEqual(["distinct-button-names"]);
  });

  it("compares names without regard to case or spacing, and reports a name once", () => {
    const html =
      '<form method="post" action="/a"><button type="submit">Upload  new version</button></form>' +
      '<form method="post" action="/b"><button type="submit">UPLOAD NEW VERSION</button></form>' +
      '<form method="post" action="/c"><button type="submit">Upload new version</button></form>';
    expect(audit(html).filter((v) => v.rule === "distinct-button-names")).toHaveLength(1);
  });

  it("does not count a disabled button, which cannot act", () => {
    expect(
      rulesOf(
        '<p id="w">Not yet.</p><form method="post" action="/a"><button type="submit">Go</button></form>' +
          '<form method="post" action="/b"><button type="submit" disabled aria-describedby="w">Go</button></form>',
      ),
    ).toEqual([]);
  });
});

describe("landmarks", () => {
  it("landmark-unnamed covers nav, aside, role=region and a section named by a heading", () => {
    expect(rulesOf("<aside><p>x</p></aside>")).toEqual(["landmark-unnamed"]);
    expect(rulesOf('<div role="region"><p>x</p></div>')).toEqual(["landmark-unnamed"]);
    expect(rulesOf('<section aria-labelledby="gone"><p>x</p></section>')).toEqual([
      "landmark-unnamed",
    ]);
    expect(rulesOf('<section aria-labelledby="h"><h2 id="h"></h2></section>')).toEqual([
      "landmark-unnamed",
    ]);
  });

  it("landmark-unnamed does not read a name from the content of a landmark", () => {
    expect(rulesOf('<nav><a href="/a">A long and descriptive link</a></nav>')).toEqual([
      "landmark-unnamed",
    ]);
  });

  it("accepts a named region, a plain section, and a name given by title or by a heading", () => {
    expect(rulesOf('<div role="region" aria-label="Rows"><p>x</p></div>')).toEqual([]);
    expect(rulesOf("<section><h2>Plain</h2></section>")).toEqual([]);
    expect(rulesOf('<nav title="Pages"><a href="/a">A</a></nav>')).toEqual([]);
    expect(rulesOf('<section aria-labelledby="h"><h2 id="h">Evidence</h2></section>')).toEqual([]);
  });

  it("landmark-names-unique compares a scroll box with a section by name", () => {
    expect(
      rulesOf(
        '<section aria-labelledby="h"><h2 id="h">Exported memos</h2>' +
          '<div role="region" aria-label="exported memos"><p>x</p></div></section>',
      ),
    ).toEqual(["landmark-names-unique"]);
  });
});

describe("disabled-unexplained", () => {
  it("wants a description that exists and says something", () => {
    expect(
      rulesOf('<button type="button" disabled aria-describedby="nowhere">Go</button>'),
    ).toEqual(["disabled-unexplained"]);
    expect(
      rulesOf('<p id="why"></p><button type="button" disabled aria-describedby="why">Go</button>'),
    ).toEqual(["disabled-unexplained"]);
    expect(rulesOf('<input type="submit" value="Go" disabled>')).toEqual(["disabled-unexplained"]);
  });

  it("accepts any one of several described-by targets that says something", () => {
    expect(
      rulesOf(
        '<p id="a"></p><p id="b">Decide every finding first.</p><button type="button" disabled aria-describedby="a b">Go</button>',
      ),
    ).toEqual([]);
  });

  it("says nothing about an enabled button", () => {
    expect(rulesOf('<button type="button">Go</button>')).toEqual([]);
  });
});

describe("form-without-submit", () => {
  it("accepts a submit control tied to the form by the form attribute", () => {
    expect(
      rulesOf(
        '<form id="f" method="post" action="/x"></form><button type="submit" form="f">Go</button>',
      ),
    ).toEqual([]);
  });

  it("does not count a submit control that belongs to another form", () => {
    expect(
      rulesOf(
        '<form id="a" method="post" action="/a"><button type="submit" form="b">Go</button></form>' +
          '<form id="b" method="post" action="/b"><button type="submit">Send</button></form>',
      ),
    ).toEqual(["form-without-submit"]);
  });

  it("does not count a submit control whose form attribute names an element that is not a form", () => {
    // Outside the form: it belongs to no form at all.
    expect(
      rulesOf(
        '<form method="post" action="/x"><input type="text" name="a" aria-label="A"></form>' +
          '<div id="d"></div><button type="submit" form="d">Go</button>',
      ),
    ).toEqual(["form-without-submit"]);
    // Inside the form: the attribute wins over the place, and a div is no form, so it belongs to none.
    expect(
      rulesOf(
        '<div id="d"></div><form method="post" action="/x"><input type="text" name="a" aria-label="A">' +
          '<button type="submit" form="d">Go</button></form>',
      ),
    ).toEqual(["form-without-submit"]);
    // An id that no element has is no form either.
    expect(
      rulesOf(
        '<form method="post" action="/x"><button type="submit" form="missing">Go</button></form>',
      ),
    ).toEqual(["form-without-submit"]);
  });

  it("does not count a button that is only a button, but counts one with no type", () => {
    expect(
      rulesOf('<form method="post" action="/x"><button type="button">Go</button></form>'),
    ).toEqual(["form-without-submit"]);
    expect(rulesOf('<form method="post" action="/x"><button>Go</button></form>')).toEqual([]);
    expect(
      rulesOf('<form method="post" action="/x"><input type="image" alt="Go" src="/go.png"></form>'),
    ).toEqual([]);
  });
});

describe("fragment-link-dangling", () => {
  it("reports an empty fragment and accepts other links", () => {
    expect(rulesOf('<a href="#">Top</a>')).toEqual(["fragment-link-dangling"]);
    expect(rulesOf('<a href="/page#x">Other page</a>')).toEqual([]);
    expect(rulesOf('<a href="https://example.test/#x">Elsewhere</a>')).toEqual([]);
  });
});

describe("skip-link-first", () => {
  const page = (body: string): string =>
    `<!doctype html><html lang="en"><head><title>Example | Parol</title></head><body>${body}</body></html>`;
  const skip = '<a class="skip-link" href="#main">Skip to main content</a>';
  const nav = '<nav aria-label="Primary"><a href="/matters">Matters</a></nav>';
  const main = '<main id="main" tabindex="-1"><h1>Example</h1></main>';
  const whole: AuditOptions = {};

  it("passes for the skip link first and a main that takes focus", () => {
    expect(rulesOf(page(skip + nav + main), whole)).toEqual([]);
  });

  it("is not applied to a fragment", () => {
    expect(rulesOf(page(nav + main), FRAGMENT)).toEqual([]);
    expect(rulesOf(page(nav + main), whole)).toEqual(["skip-link-first"]);
  });

  it("reports a main that cannot take focus, a missing main, or a skip link that is not first", () => {
    expect(rulesOf(page(skip + nav + '<main id="main"><h1>Example</h1></main>'), whole)).toEqual([
      "skip-link-first",
    ]);
    // The skip link then leads nowhere, which is reported as well.
    expect(rulesOf(page(skip + nav + "<h1>Example</h1>"), whole)).toEqual([
      "fragment-link-dangling",
      "skip-link-first",
    ]);
    expect(rulesOf(page(nav + skip + main), whole)).toEqual(["skip-link-first"]);
  });

  it("reports a skip link that leads somewhere other than #main", () => {
    expect(
      rulesOf(
        page(
          '<a class="skip-link" href="#content">Skip</a><main id="content" tabindex="-1"><h1>Example</h1></main>',
        ),
        whole,
      ),
    ).toContain("skip-link-first");
  });

  it("reports a page with no tab stop at all", () => {
    expect(rulesOf(page(main), whole)).toEqual(["skip-link-first"]);
  });
});

describe("aria-hidden-focusable", () => {
  it("reports an outer hidden element once, however deep its stop and however many hidden levels", () => {
    const found = audit(
      '<div aria-hidden="true"><div aria-hidden="true"><a href="/x">Hidden</a></div></div>',
    );
    expect(found.filter((v) => v.rule === "aria-hidden-focusable")).toHaveLength(1);
  });

  it("reports a stop that is itself hidden", () => {
    expect(rulesOf('<a href="/x" aria-hidden="true">Hidden</a>')).toEqual([
      "aria-hidden-focusable",
    ]);
  });

  it("does not report what Tab cannot reach", () => {
    expect(
      rulesOf(
        '<p id="w">Not yet.</p><div aria-hidden="true"><button type="button" disabled aria-describedby="w">Go</button></div>',
      ),
    ).toEqual([]);
  });
});

describe("error-needs-todo", () => {
  it("wants a marked sentence in an error notice and none in other notices", () => {
    expect(
      rulesOf('<div class="notice notice-error" role="alert"><p>Problem. Fix it.</p></div>'),
    ).toEqual(["error-needs-todo"]);
    expect(
      rulesOf(
        '<div class="notice notice-error" role="alert"><p>Problem. <span class="todo">Fix it.</span></p></div>',
      ),
    ).toEqual([]);
    expect(rulesOf('<div class="notice notice-success" role="status"><p>Done.</p></div>')).toEqual(
      [],
    );
  });

  it("does not take an empty marker for a sentence", () => {
    expect(
      rulesOf(
        '<div class="notice notice-error" role="alert"><p>Problem.<span class="todo"></span></p></div>',
      ),
    ).toEqual(["error-needs-todo"]);
  });

  it("wants an error page to have a way on, a link or a button", () => {
    const body = '<p>It broke. <span class="todo">Try again.</span></p>';
    expect(rulesOf(`<div class="error-page" role="alert">${body}</div>`)).toEqual([
      "error-needs-todo",
    ]);
    expect(
      rulesOf(
        `<div class="error-page" role="alert">${body}<button type="button">Retry</button></div>`,
      ),
    ).toEqual([]);
  });
});

describe("tabStops", () => {
  it("lists the controls Tab reaches, in document order", () => {
    expect(
      stopIds(
        '<a id="a" href="/x">A</a><button id="b" type="button">B</button>' +
          '<input id="i" type="text" aria-label="I"><input id="h" type="hidden" name="h" value="1">' +
          '<select id="s" aria-label="S"></select><textarea id="t" aria-label="T"></textarea>' +
          '<div id="d" tabindex="0"></div><span id="n" tabindex="-1"></span>' +
          '<button id="x" type="button" disabled>X</button><a id="nohref">no link</a>',
      ),
    ).toEqual(["a", "b", "i", "s", "t", "d"]);
  });

  it("skips what a closed details hides, except its summary, and shows what an open one holds", () => {
    expect(
      stopIds(
        '<details><summary id="sc">S</summary><button id="inside" type="button">In</button>' +
          '<details><summary id="nested">N</summary></details></details>' +
          '<details open=""><summary id="so">S</summary><button id="open-inside" type="button">In</button></details>',
      ),
    ).toEqual(["sc", "so", "open-inside"]);
  });

  it("takes only the first summary of a details", () => {
    expect(
      stopIds('<details><summary id="one">One</summary><summary id="two">Two</summary></details>'),
    ).toEqual(["one"]);
  });

  it("skips what is hidden or inert, and what a disabled fieldset disables outside its first legend", () => {
    expect(stopIds('<div hidden=""><button id="h" type="button">H</button></div>')).toEqual([]);
    expect(stopIds('<div inert=""><button id="h" type="button">H</button></div>')).toEqual([]);
    expect(
      stopIds(
        '<fieldset disabled=""><legend><input id="in-legend" type="checkbox" aria-label="L"></legend>' +
          '<input id="in-set" type="text" aria-label="I"></fieldset>',
      ),
    ).toEqual(["in-legend"]);
  });

  it("skips a control that is itself hidden or inert, as well as one inside a hidden or inert box", () => {
    expect(stopIds('<button id="b" type="button" hidden>B</button>')).toEqual([]);
    expect(stopIds('<button id="b" type="button" hidden="">B</button>')).toEqual([]);
    expect(stopIds('<button id="b" type="button" inert>B</button>')).toEqual([]);
    expect(stopIds('<button id="b" type="button" inert="">B</button>')).toEqual([]);
    // The next control is not affected by the one before it.
    expect(
      stopIds(
        '<button id="b" type="button" hidden>B</button><button id="c" type="button">C</button>',
      ),
    ).toEqual(["c"]);
  });

  it("reads tabindex as a number: a bad value is ignored, a negative one removes the stop", () => {
    expect(stopIds('<div id="d" tabindex="abc"></div>')).toEqual([]);
    expect(stopIds('<button id="b" type="button" tabindex="abc">B</button>')).toEqual(["b"]);
    expect(stopIds('<button id="b" type="button" tabindex="-1">B</button>')).toEqual([]);
    expect(stopIds('<div id="d" tabindex="0"></div>')).toEqual(["d"]);
  });

  describe("radio groups", () => {
    const radio = (id: string, name: string, extra = ""): string =>
      `<input type="radio" id="${id}" name="${name}" value="${id}" aria-label="${id}"${extra}>`;

    it("are one stop: the first radio, or the checked one", () => {
      expect(stopIds(radio("a", "g") + radio("b", "g") + radio("c", "g"))).toEqual(["a"]);
      expect(stopIds(radio("a", "g") + radio("b", "g", " checked") + radio("c", "g"))).toEqual([
        "b",
      ]);
    });

    it("keep the last of several checked radios as the stop, as a browser does", () => {
      expect(stopIds(radio("a", "g", " checked") + radio("b", "g", " checked"))).toEqual(["b"]);
      expect(
        stopIds(
          radio("a", "g", " checked") +
            radio("b", "g") +
            radio("c", "g", " checked") +
            radio("d", "g"),
        ),
      ).toEqual(["c"]);
      // The rule is per group: another group keeps its own last checked radio.
      expect(
        stopIds(
          radio("a", "g", " checked") +
            radio("b", "g", " checked") +
            radio("c", "h", " checked") +
            radio("d", "h", " checked"),
        ),
      ).toEqual(["b", "d"]);
    });

    it("are every radio when grouping is turned off", () => {
      expect(stopIds(radio("a", "g") + radio("b", "g"), false)).toEqual(["a", "b"]);
    });

    it("are separate groups by name and by form, and an unnamed radio is alone", () => {
      expect(stopIds(radio("a", "g") + radio("b", "h") + radio("c", "h"))).toEqual(["a", "b"]);
      expect(
        stopIds(
          `<form id="f1" method="post" action="/a">${radio("a", "g")}${radio("b", "g")}</form>` +
            `<form id="f2" method="post" action="/b">${radio("c", "g")}</form>`,
        ),
      ).toEqual(["a", "c"]);
      expect(stopIds(radio("a", "") + radio("b", ""))).toEqual(["a", "b"]);
    });

    it("belong to the form their form attribute names", () => {
      expect(
        stopIds(
          '<form id="f1" method="post" action="/a"></form>' +
            radio("a", "g", ' form="f1"') +
            radio("b", "g"),
        ),
      ).toEqual(["a", "b"]);
    });

    it("pass over a disabled radio when choosing the stop of a group", () => {
      expect(stopIds(radio("a", "g", " disabled") + radio("b", "g"))).toEqual(["b"]);
    });
  });
});

describe("accessibleName", () => {
  const all =
    '<span id="by">By reference</span><label for="c">By label</label>' +
    '<input id="c" type="text" aria-labelledby="by" aria-label="By aria" title="By title">';

  it("takes aria-labelledby, then aria-label, then the label, then the title", () => {
    expect(nameOf(all, "c")).toBe("By reference");
    expect(nameOf(all.replace(' aria-labelledby="by"', ""), "c")).toBe("By aria");
    expect(
      nameOf(all.replace(' aria-labelledby="by"', "").replace(' aria-label="By aria"', ""), "c"),
    ).toBe("By label");
    expect(nameOf('<input id="c" type="text" title="By title">', "c")).toBe("By title");
    expect(nameOf('<input id="c" type="text">', "c")).toBe("");
  });

  it("puts a label before the content of a button, and the content before the title", () => {
    expect(
      nameOf(
        '<label for="c">By label</label><button id="c" type="button">By content</button>',
        "c",
      ),
    ).toBe("By label");
    expect(nameOf('<button id="c" type="button" title="By title">By content</button>', "c")).toBe(
      "By content",
    );
  });

  it("joins several referenced elements, and reads a referenced element's own aria-label", () => {
    expect(
      nameOf(
        '<span id="a">First</span><span id="b" aria-label="Second">ignored</span>' +
          '<button id="c" type="button" aria-labelledby="a missing b">x</button>',
        "c",
      ),
    ).toBe("First Second");
  });

  it("counts screen-reader-only text, drops text hidden from assistive technology, and collapses space", () => {
    expect(
      nameOf(
        '<a id="c" href="/x">Open  <span class="sr-only">the\n matter</span><span aria-hidden="true">GONE</span></a>',
        "c",
      ),
    ).toBe("Open the matter");
  });

  it("reads the value of a submit button, the alt of an image, and the alt inside a link", () => {
    expect(nameOf('<input id="c" type="submit" value="Send">', "c")).toBe("Send");
    expect(nameOf('<input id="c" type="image" alt="Search" src="/s.png">', "c")).toBe("Search");
    expect(nameOf('<a id="c" href="/x"><img alt="Home" src="/h.png"></a>', "c")).toBe("Home");
  });

  it("reads an implicit label, without the text of the controls inside it", () => {
    expect(nameOf('<label>Colour <select id="c"><option>Red</option></select></label>', "c")).toBe(
      "Colour",
    );
  });

  it("does not take an implicit label whose for points at another element, and gives that name to the other", () => {
    // The wrapped control is not what the label is for, so it has no name of its own...
    expect(
      nameOf(
        '<label for="other">Colour <input id="c" type="text"></label><input id="other" type="text">',
        "c",
      ),
    ).toBe("");
    // ...and the control the label points at gets the text, without the wrapped control's.
    expect(
      nameOf(
        '<label for="other">Colour <input id="c" type="text"></label><input id="other" type="text">',
        "other",
      ),
    ).toBe("Colour");
    // A for that points at nothing names nothing either.
    expect(nameOf('<label for="missing">Colour <input id="c" type="text"></label>', "c")).toBe("");
    // A for that points at the wrapped control itself is a label for it.
    expect(nameOf('<label for="c">Colour <input id="c" type="text"></label>', "c")).toBe("Colour");
  });

  it("reports a control wrapped in a label that is for another element as unnamed", () => {
    expect(
      rulesOf(
        '<label for="other">Colour <input id="c" type="text"></label><input id="other" type="text">',
      ),
    ).toEqual(["focusable-unnamed"]);
  });

  it("names a landmark only from its labels, never from its content", () => {
    expect(nameOf('<nav id="c"><a href="/x">Matters</a></nav>', "c")).toBe("");
    expect(nameOf('<nav id="c" aria-label="Primary"><a href="/x">Matters</a></nav>', "c")).toBe(
      "Primary",
    );
    expect(nameOf('<h2 id="h">Notes</h2><section id="c" aria-labelledby="h"></section>', "c")).toBe(
      "Notes",
    );
  });
});

describe("SCROLL_REGIONS", () => {
  const sample = (html: string): El => (parseHtml(html).children[0] as El) ?? ({} as El);

  it("is the reviewed list: a table box, the inspector and a long passage, each with a reason", () => {
    expect(SCROLL_REGIONS).toHaveLength(3);
    for (const region of SCROLL_REGIONS) expect(region.why.length).toBeGreaterThan(30);
    expect(new Set(SCROLL_REGIONS.map((r) => r.why)).size).toBe(SCROLL_REGIONS.length);
    const matches = (html: string): boolean[] => SCROLL_REGIONS.map((r) => r.test(sample(html)));
    expect(matches('<div class="table-scroll"></div>')).toEqual([true, false, false]);
    expect(matches('<aside data-inspector=""></aside>')).toEqual([false, true, false]);
    expect(matches('<blockquote class="doc-text long"></blockquote>')).toEqual([
      false,
      false,
      true,
    ]);
    expect(matches('<div class="long"></div>')).toEqual([false, false, false]);
    expect(matches('<blockquote class="doc-text"></blockquote>')).toEqual([false, false, false]);
  });
});

describe("expectAccessible", () => {
  const clean = '<button type="button">Go</button>';
  const dirty = '<button type="button"></button>';

  it("returns the parsed tree, from a string or from a tree", () => {
    const root = expectAccessible(clean, FRAGMENT);
    expect(root.name).toBe("#root");
    expect(expectAccessible(root, FRAGMENT)).toBe(root);
  });

  it("fails with every violation, by rule and place", () => {
    const html = dirty + '<button type="button" tabindex="2">Go</button>';
    let message = "";
    try {
      expectAccessible(html, FRAGMENT);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^1 accessibility problem:|^2 accessibility problems:/);
    expect(message).toContain("2 accessibility problems:");
    expect(message).toContain("positive-tabindex <button>");
    expect(message).toContain("focusable-unnamed <button>");
    expect(message).toBe(`2 accessibility problems:\n${formatViolations(audit(html))}`);
  });

  it("says 'problem' for one", () => {
    expect(() => expectAccessible(dirty, FRAGMENT)).toThrow(/^1 accessibility problem:/);
  });

  it("applies the frame rules unless told the input is a fragment", () => {
    expect(() => expectAccessible(clean)).toThrow(/skip-link-first/);
    expect(() => expectAccessible(clean, { fragment: false })).toThrow(/skip-link-first/);
    expect(() => expectAccessible(clean, FRAGMENT)).not.toThrow();
  });

  it("passes on its own parse errors, which carry no page text", () => {
    expect(() => expectAccessible("<p>a < b</p>", FRAGMENT)).toThrow(/strict HTML/);
  });

  it("accepts the page the application writes for an empty layout", () => {
    const page = render(Layout({ title: "Example", chrome: buildChrome(), children: "Body" }));
    expectAccessible(page);
    expectAccessible(
      render(
        Layout({ title: "Example", chrome: buildChrome({ userName: null }), children: "Body" }),
      ),
    );
  });
});
