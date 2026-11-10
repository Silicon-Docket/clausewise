import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CSRF_FIELD,
  DEMO_BANNER,
  FIELDS,
  Layout,
  NoticeBox,
  csrfField,
  render,
  runStatusPayload,
} from "../../src/server/pages/index.js";
import { GLOBAL_ACTIONS, type GlobalAction } from "../../src/auth/actions.js";
import { GLOBAL_ROLES, RUN_STATUSES, type GlobalRole } from "../../src/contracts.js";
import { TodoText } from "../../src/server/pages/components.js";
import {
  NAV_ITEMS,
  PrimaryNav,
  isFragmentHref,
  navItemsFor,
  type NavItem,
  type Notice,
} from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import {
  attr,
  byTag,
  classes,
  first,
  hasClass,
  parseHtml,
  readable,
  withClass,
  all,
} from "./html.js";
import { buildChrome, buildRunSummary, IDS } from "./support.js";

describe("DEMO_BANNER", () => {
  it("is the exact sentence the governance document requires", () => {
    expect(DEMO_BANNER).toBe("DEMO: synthetic documents, demo identity, not for client work");
  });

  it("is on a page that has nothing else on it", () => {
    const html = render(Layout({ title: "Empty", chrome: buildChrome({ userName: null }) }));
    expect(readable(first(parseHtml(html), (el) => hasClass(el, "demo-banner")))).toBe(DEMO_BANNER);
  });
});

describe("csrfField", () => {
  it("is a hidden input named _csrf carrying the token", () => {
    const html = render(csrfField("tok"));
    const input = first(parseHtml(html), (el) => el.name === "input");
    expect(attr(input, "type")).toBe("hidden");
    expect(attr(input, "name")).toBe("_csrf");
    expect(attr(input, "name")).toBe(CSRF_FIELD);
    expect(attr(input, "value")).toBe("tok");
  });

  it("escapes a token that is not what it should be", () => {
    const html = render(csrfField('"><script>1</script>'));
    expect(html).not.toContain("<script>");
    expect(
      attr(
        first(parseHtml(html), (el) => el.name === "input"),
        "value",
      ),
    ).toBe('"><script>1</script>');
  });
});

describe("Layout", () => {
  const page = (chrome = buildChrome(), title = "A page") =>
    parseHtml(render(Layout({ title, chrome, children: "body text" })));

  it("shows who is signed in and a sign-out form that posts to the session URL", () => {
    const root = page();
    expect(readable(withClass(root, "whoami")[0]!)).toContain("Signed in as A. Ruiz");
    const form = first(root, (el) => el.name === "form");
    expect(attr(form, "action")).toBe(urls.session());
    expect(attr(form, "method")).toBe("post");
    const intent = all(form, (el) => el.name === "input" && attr(el, "name") === FIELDS.intent)[0]!;
    expect(attr(intent, "value")).toBe("sign-out");
    expect(attr(all(form, (el) => attr(el, "name") === CSRF_FIELD)[0]!, "value")).toBe(IDS.csrf);
  });

  it("shows no sign-out form to someone who has not signed in", () => {
    const root = page(buildChrome({ userName: null }));
    expect(byTag(root, "form")).toHaveLength(0);
    expect(withClass(root, "whoami")).toHaveLength(0);
  });

  it("puts the title in the tab and the content in main", () => {
    const root = page(buildChrome(), "Matters");
    expect(readable(first(root, (el) => el.name === "title"))).toBe("Matters | Parol");
    expect(readable(first(root, (el) => el.name === "main"))).toBe("body text");
  });

  it("uses the wide layout only when asked", () => {
    const wide = parseHtml(render(Layout({ title: "t", chrome: buildChrome(), wide: true })));
    expect(
      hasClass(
        first(wide, (el) => el.name === "main"),
        "page-wide",
      ),
    ).toBe(true);
    expect(
      hasClass(
        first(page(), (el) => el.name === "main"),
        "page-wide",
      ),
    ).toBe(false);
  });

  it("shows a notice once, as an alert for an error and a status otherwise", () => {
    const error = page(buildChrome({ notice: { kind: "error", text: "It failed." } }));
    const box = withClass(error, "notice")[0]!;
    expect(attr(box, "role")).toBe("alert");
    expect(hasClass(box, "notice-error")).toBe(true);
    for (const kind of ["success", "info"] as const) {
      const root = page(buildChrome({ notice: { kind, text: "Done." } }));
      expect(attr(withClass(root, "notice")[0]!, "role")).toBe("status");
    }
    expect(withClass(page(), "notice")).toHaveLength(0);
  });

  it("renders NoticeBox on its own", () => {
    const html = render(NoticeBox({ notice: { kind: "info", text: "Hello" } }));
    // The label comes first, so the kind of notice is in words as well as colour.
    expect(readable(parseHtml(html))).toBe("Note Hello");
  });
});

describe("a notice that says what to do and where", () => {
  const box = (notice: Notice) => parseHtml(render(NoticeBox({ notice })));
  const WORDS = "The form was refused. Give a reason.";

  it("sets the sentence that says what to do in bold, and the words read the same", () => {
    const root = box({ kind: "error", text: WORDS, todo: "Give a reason." });
    const spans = withClass(root, "todo");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("span");
    expect(readable(spans[0]!)).toBe("Give a reason.");
    // The sentence is where it was; nothing was added or taken away.
    expect(readable(root)).toBe(`Problem ${WORDS}`);
    expect(attr(withClass(root, "notice")[0]!, "role")).toBe("alert");
  });

  it("marks the first occurrence only, and the sentence in the middle of a text too", () => {
    const text = "Check it. Check it again. Then stop.";
    const root = box({ kind: "info", text, todo: "Check it." });
    expect(withClass(root, "todo")).toHaveLength(1);
    expect(readable(root)).toBe(`Note ${text}`);
    const middle = box({ kind: "error", text: "Before. Do this. After.", todo: "Do this." });
    expect(readable(withClass(middle, "todo")[0]!)).toBe("Do this.");
    expect(readable(middle)).toBe("Problem Before. Do this. After.");
  });

  it("adds a sentence that is not in the text after it, so the advice is never lost", () => {
    const root = box({ kind: "error", text: "It failed.", todo: "Try again." });
    expect(readable(withClass(root, "todo")[0]!)).toBe("Try again.");
    expect(readable(root)).toBe("Problem It failed. Try again.");
  });

  it("marks nothing for a notice with no todo, and for an empty one", () => {
    expect(withClass(box({ kind: "error", text: WORDS }), "todo")).toHaveLength(0);
    const empty = box({ kind: "error", text: WORDS, todo: "" });
    expect(withClass(empty, "todo")).toHaveLength(0);
    expect(readable(empty)).toBe(`Problem ${WORDS}`);
  });

  it("escapes the text and the sentence like any other text", () => {
    const html = render(
      NoticeBox({
        notice: { kind: "error", text: 'A <b>bold</b> & "quoted" claim.', todo: "<b>bold</b>" },
      }),
    );
    expect(html).not.toContain("<b>");
    const root = parseHtml(html);
    expect(readable(withClass(root, "todo")[0]!)).toBe("<b>bold</b>");
  });

  it("shows a link to a place on the page after the text, with the words it was given", () => {
    const root = box({
      kind: "error",
      text: WORDS,
      todo: "Give a reason.",
      jump: { href: "#decision-reason", label: "Go to the reason" },
    });
    const links = withClass(root, "notice-jump");
    expect(links).toHaveLength(1);
    expect(links[0]?.name).toBe("a");
    expect(attr(links[0]!, "href")).toBe("#decision-reason");
    expect(readable(links[0]!)).toBe("Go to the reason");
    // After the text, in the same paragraph, apart from it by a space.
    expect(readable(root)).toBe(`Problem ${WORDS} Go to the reason`);
    expect(byTag(root, "p")).toHaveLength(1);
  });

  it("shows no link for a notice with none, and keeps the old notice exactly as it was", () => {
    expect(withClass(box({ kind: "info", text: "Hello" }), "notice-jump")).toHaveLength(0);
    expect(render(NoticeBox({ notice: { kind: "info", text: "Hello" } }))).not.toContain("<a");
  });

  it("never shows a link that leads away from the page, whatever the notice was given", () => {
    for (const href of [
      "https://example.org/",
      "//example.org",
      "javascript:alert(1)",
      "/matters",
      "#",
      "#Main",
      "#a b",
      '#a"onclick="x',
      "",
    ]) {
      const html = render(
        NoticeBox({
          notice: {
            kind: "error",
            text: WORDS,
            jump: { href: href as `#${string}`, label: "Go" },
          },
        }),
      );
      expect(html, href).not.toContain("<a");
      expect(html, href).not.toContain("notice-jump");
      expect(readable(parseHtml(html)), href).toBe(`Problem ${WORDS}`);
    }
  });

  it("escapes the words of the link", () => {
    const html = render(
      NoticeBox({
        notice: {
          kind: "error",
          text: WORDS,
          jump: { href: "#reason", label: "<script>1</script>" },
        },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(readable(withClass(parseHtml(html), "notice-jump")[0]!)).toBe("<script>1</script>");
  });

  it("is on the page in the main region, with the sentence and the link in the alert", () => {
    const root = parseHtml(
      render(
        Layout({
          title: "t",
          chrome: buildChrome({
            notice: {
              kind: "error",
              text: WORDS,
              todo: "Give a reason.",
              jump: { href: "#decision-reason", label: "Go to the reason" },
            },
          }),
        }),
      ),
    );
    const alert = withClass(root, "notice")[0]!;
    expect(attr(alert, "role")).toBe("alert");
    expect(withClass(alert, "todo")).toHaveLength(1);
    expect(withClass(alert, "notice-jump")).toHaveLength(1);
    expect(first(root, (el) => el.name === "main").children.length).toBeGreaterThan(0);
  });
});

describe("the stylesheet for a notice", () => {
  const css = readFileSync(join(import.meta.dirname, "../../public/parol.css"), "utf8");

  it("sets the sentence that says what to do in bold and gives the jump link room", () => {
    expect(/\.todo\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("font-weight: 600");
    expect(/\.notice-jump\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("margin-left: 0.5rem");
  });

  it("has a rule for every class a notice with a sentence and a link uses", () => {
    const html = render(
      NoticeBox({
        notice: {
          kind: "error",
          text: "It failed. Fix it.",
          todo: "Fix it.",
          jump: { href: "#fix", label: "Go to the fix" },
        },
      }),
    );
    const used = new Set<string>();
    for (const el of all(parseHtml(html))) for (const name of classes(el)) used.add(name);
    expect([...used]).toEqual(
      expect.arrayContaining(["notice", "notice-error", "todo", "notice-jump"]),
    );
    // Chips carry their own classes (shape, tone); the notice's own classes are the ones checked.
    for (const name of ["notice", "notice-error", "todo", "notice-jump"])
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])\\s*\\{`));
  });
});

describe("isFragmentHref", () => {
  it("accepts a place on the page written as # and an id, and nothing else", () => {
    for (const ok of ["#a", "#documents", "#decision-reason", "#a1-b2", "#issue-table"])
      expect(isFragmentHref(ok), ok).toBe(true);
    for (const refused of [
      "",
      "#",
      "#1",
      "#-a",
      "#A",
      "#a_b",
      "#a b",
      "# a",
      "##a",
      "a#b",
      "/#a",
      "https://example.org/#a",
      "javascript:alert(1)",
      "#a\n",
      null,
      undefined,
      42,
      {},
    ])
      expect(isFragmentHref(refused), String(refused)).toBe(false);
  });
});

describe("TodoText", () => {
  const html = (text: string, todo: string): string => render(TodoText({ text, todo }));

  it("wraps the first occurrence of the sentence and changes no word", () => {
    expect(html("It failed. Try again. Try again.", "Try again.")).toBe(
      'It failed. <span class="todo">Try again.</span> Try again.',
    );
    expect(html("Try again.", "Try again.")).toBe('<span class="todo">Try again.</span>');
  });

  it("adds the sentence after the text when it is not in it", () => {
    expect(html("It failed.", "Try again.")).toBe(
      'It failed. <span class="todo">Try again.</span>',
    );
  });

  it("wraps nothing for an empty sentence", () => {
    expect(html("It failed.", "")).toBe("It failed.");
  });

  it("escapes both", () => {
    expect(html("A & B <i>", "& B")).toBe('A <span class="todo">&amp; B</span> &lt;i&gt;');
  });
});

describe("the primary navigation", () => {
  const links = (root: ReturnType<typeof parseHtml>): string[] =>
    all(
      first(root, (el) => el.name === "nav"),
      (el) => el.name === "a",
    ).map((a) => readable(a));
  // Three kinds of link, for the roles of the hand-written table of who may open what.
  const SYNTHETIC: NavItem[] = [
    { label: "Everyone", href: "/everyone" },
    { label: "Evaluations", href: "/evaluations", global: "evaluation.read" },
    { label: "Audit log", href: "/audit", global: "audit.read" },
  ];
  const SEES: Record<GlobalRole, string[]> = {
    member: ["Everyone"],
    legal_engineer: ["Everyone", "Evaluations"],
    admin: ["Everyone", "Evaluations", "Audit log"],
  };

  it("holds Matters, for everyone, until the lead adds more", () => {
    expect(NAV_ITEMS.find((item) => item.label === "Matters")).toEqual({
      label: "Matters",
      href: urls.matters(),
    });
    expect(NAV_ITEMS[0]?.global).toBeUndefined();
    // Every gated item names a real global action, and every href is one of our own paths.
    for (const item of NAV_ITEMS) {
      if (item.global !== undefined) expect(Object.keys(GLOBAL_ACTIONS)).toContain(item.global);
      expect(item.href, item.label).toMatch(/^\/[a-z0-9/_-]*$/);
    }
  });

  it("shows the links of the table to each role, in the order of the table", () => {
    for (const role of GLOBAL_ROLES) {
      const root = parseHtml(render(PrimaryNav({ globalRole: role, items: SYNTHETIC })));
      expect(links(root), role).toEqual(SEES[role]);
    }
  });

  it("shows only the links for everyone to a page that has no role, as a visitor's has none", () => {
    expect(links(parseHtml(render(PrimaryNav({ items: SYNTHETIC }))))).toEqual(["Everyone"]);
    expect(navItemsFor(undefined, SYNTHETIC).map((item) => item.label)).toEqual(["Everyone"]);
  });

  it("shows nothing gated to a role the table does not know", () => {
    expect(navItemsFor("owner" as GlobalRole, SYNTHETIC).map((item) => item.label)).toEqual([
      "Everyone",
    ]);
  });

  it("decides by the table of global actions, so an action and its link cannot disagree", () => {
    for (const action of Object.keys(GLOBAL_ACTIONS) as GlobalAction[])
      for (const role of GLOBAL_ROLES) {
        const shown = navItemsFor(role, [{ label: "x", href: "/x", global: action }]).length === 1;
        expect(shown, `${role} ${action}`).toBe(
          (GLOBAL_ACTIONS[action] as readonly GlobalRole[]).includes(role),
        );
      }
  });

  it("is what the page frame shows, for the role of the page's chrome", () => {
    const items = NAV_ITEMS as NavItem[];
    const original = [...items];
    try {
      items.push(...SYNTHETIC);
      for (const role of GLOBAL_ROLES) {
        const root = parseHtml(
          render(Layout({ title: "t", chrome: buildChrome({ globalRole: role }) })),
        );
        expect(links(root), role).toEqual(["Matters", ...SEES[role]]);
      }
      const visitor = parseHtml(
        render(Layout({ title: "t", chrome: buildChrome({ userName: null }) })),
      );
      expect(links(visitor)).toEqual(["Matters", "Everyone"]);
    } finally {
      items.splice(0, items.length, ...original);
    }
    expect(NAV_ITEMS).toEqual(original);
  });

  it("keeps the markup of the navigation: a labelled nav with a list of links", () => {
    const root = parseHtml(render(Layout({ title: "t", chrome: buildChrome() })));
    const nav = first(root, (el) => el.name === "nav");
    expect(attr(nav, "aria-label")).toBe("Primary");
    expect(
      hasClass(
        first(nav, (el) => el.name === "ul"),
        "nav-list",
      ),
    ).toBe(true);
    expect(
      attr(
        first(nav, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.matters());
  });
});

describe("render", () => {
  it("refuses a page that would have to wait", () => {
    expect(() => render({ toString: () => Promise.resolve("late") })).toThrow(
      "rendered asynchronously",
    );
  });

  it("returns the string for a synchronous page", () => {
    expect(render({ toString: () => "<p>x</p>" })).toBe("<p>x</p>");
  });
});

describe("FIELDS", () => {
  it("name every field once, apart from the user id the session and member forms share", () => {
    const names = Object.entries(FIELDS).map(([key, value]) => [key, value as string] as const);
    const byValue = new Map<string, string[]>();
    for (const [key, value] of names) byValue.set(value, [...(byValue.get(value) ?? []), key]);
    const shared = [...byValue.entries()].filter(([, keys]) => keys.length > 1);
    expect(shared).toEqual([["userId", ["userId", "memberUserId"]]]);
    expect(Object.values(FIELDS)).not.toContain(CSRF_FIELD);
  });
});

describe("runStatusPayload", () => {
  it("carries the status, the plain-word stage, whether it is over, and the progress", () => {
    const running = buildRunSummary({
      status: "analyzing",
      progress: { stage: "analyze", done: 3, total: 8 },
      finishedAt: null,
    });
    expect(runStatusPayload(running)).toEqual({
      status: "analyzing",
      label: "Analyzing rules",
      finished: false,
      progress: { stage: "analyze", done: 3, total: 8 },
    });
  });

  it("uses the status words before there is any progress", () => {
    const queued = buildRunSummary({ status: "queued", progress: null });
    expect(runStatusPayload(queued)).toEqual({
      status: "queued",
      label: "Queued",
      finished: false,
      progress: null,
    });
  });

  it("says finished for every status a run does not come back from", () => {
    for (const status of RUN_STATUSES) {
      const payload = runStatusPayload(buildRunSummary({ status, progress: null }));
      expect(payload.finished, status).toBe(
        ["succeeded", "failed", "cancelled", "superseded"].includes(status),
      );
    }
  });

  it("is plain data that survives JSON", () => {
    const payload = runStatusPayload(
      buildRunSummary({ status: "verifying", progress: { stage: "verify", done: 1, total: 8 } }),
    );
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(Object.keys(payload).sort()).toEqual(["finished", "label", "progress", "status"]);
  });
});
