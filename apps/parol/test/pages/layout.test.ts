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
import { RUN_STATUSES } from "../../src/contracts.js";
import { urls } from "../../src/server/urls.js";
import { attr, byTag, first, hasClass, parseHtml, readable, withClass, all } from "./html.js";
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
