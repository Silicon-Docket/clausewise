import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { FakeElement, SCRIPT_PATH, event, runScript } from "./fake-dom.js";
import { findingPage, matterPage, mattersPage, runPage } from "./render.js";
import {
  buildChrome,
  buildIssueRows,
  buildMatterView,
  buildRunSummary,
  buildRunningMatterView,
} from "./support.js";

const source = readFileSync(SCRIPT_PATH, "utf8");
/** A key press goes to the element that has focus, as it does in a browser, unless a test names one. */
const key = (h: ReturnType<typeof runScript>, k: string, extra = {}, target?: FakeElement) => {
  const at = target ?? h.doc.activeElement ?? h.doc.body;
  at.dispatch(event("keydown", at, { key: k, ...extra }));
};
/** Puts focus on the issue table's own box, which is where a keyboard user arrives by tabbing. */
const focusTable = (h: ReturnType<typeof runScript>): FakeElement => {
  const box = h.doc.querySelector('[data-zone="issues"]')!;
  box.focus();
  return box;
};

describe("parol.js as a file", () => {
  it("is one file under 250 lines, with no dependency", () => {
    expect(source.split("\n").length).toBeLessThan(250);
    expect(source).not.toMatch(/\b(import|require)\b\s*[("'{]/);
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("is syntactically valid and runs in strict mode inside one function", () => {
    expect(() => new vm.Script(source)).not.toThrow();
    expect(source).toContain('"use strict"');
    expect(source).toMatch(/\(function \(\) \{[\s\S]*\}\)\(\);\s*$/);
  });

  it("never writes server data as markup, evaluates strings or touches cookies", () => {
    for (const banned of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "createContextualFragment",
      "eval(",
      "new Function",
      "Function(",
      "document.cookie",
      "localStorage",
      "XMLHttpRequest",
      "importScripts",
      "WebSocket",
      "postMessage",
      "srcdoc",
    ]) {
      expect(source.includes(banned), banned).toBe(false);
    }
    // Timers get functions, never strings.
    for (const call of source.matchAll(/setTimeout\(\s*([^,)]*)/g)) {
      expect(call[1]).not.toMatch(/^["'`]/);
    }
    expect(source).toContain("textContent");
  });

  it("has no em or en dash", () => {
    expect(source).not.toMatch(/[\u2013\u2014]/);
  });

  it("makes one kind of request, to the address the page names, after checking it is local", () => {
    const fetches = [...source.matchAll(/\.fetch\(/g)];
    expect(fetches).toHaveLength(1);
    expect(source).toContain("sameOriginPath(url)");
  });
});

/**
 * What the script may listen to. Everything a page needs works without it, and what it adds can be
 * done with the keyboard alone: it registers no event that only a mouse, a finger or a pen can
 * cause, so no shortcut or behaviour exists for a pointer that a keyboard cannot reach.
 */
describe("parol.js and the keyboard", () => {
  const registered = (): string[] =>
    [...source.matchAll(/addEventListener\(\s*([^,)]*)/g)].map((m) => (m[1] as string).trim());
  const MOUSE_ONLY =
    /^(click|dblclick|auxclick|mousedown|mouseup|mouseover|mouseout|mouseenter|mouseleave|mousemove|contextmenu|wheel|pointer\w*|touch\w*|drag\w*|drop)$/;

  it("names every event it listens to as a plain word, so the check below cannot be got round", () => {
    const names = registered();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name, name).toMatch(/^"[a-zA-Z]+"$/);
  });

  it("listens to no event that only a mouse, a finger or a pen can cause", () => {
    for (const name of registered().map((n) => n.replaceAll('"', "")))
      expect(MOUSE_ONLY.test(name), name).toBe(false);
    // The same for a handler set as a property: onclick, onmousedown and the like.
    expect(source).not.toMatch(
      /\.on(click|dblclick|mouse\w*|pointer\w*|touch\w*|contextmenu|wheel|drag\w*)\s*=/,
    );
    // The one kind of key it listens for, and what else it hears, is pinned so that a new listener
    // is a decision made here and not an accident.
    expect(
      registered()
        .map((n) => n.replaceAll('"', ""))
        .sort(),
    ).toEqual(["DOMContentLoaded", "keydown", "pageshow", "submit"]);
  });

  it("calls click() only on a link it moved to with a key, never to answer a pointer", () => {
    const clicks = [...source.matchAll(/\.click\(\)/g)];
    expect(clicks).toHaveLength(1);
    const at = source.indexOf(".click()");
    const before = source.slice(0, at);
    // It is inside the keydown handler, after the check for the Enter key.
    expect(before.lastIndexOf('addEventListener("keydown"')).toBeGreaterThan(
      before.lastIndexOf('addEventListener("submit"'),
    );
    expect(before.slice(before.lastIndexOf('addEventListener("keydown"'))).toContain(
      'key === "Enter"',
    );
  });

  it("lets a key through to the page when a modifier is held or the person is typing", () => {
    const handler = source.slice(source.indexOf('addEventListener("keydown"'));
    const body = handler.slice(0, handler.indexOf("\n    });"));
    // The modifiers are checked first, before the key is read.
    const modifiers = body.indexOf("event.ctrlKey || event.metaKey || event.altKey");
    expect(modifiers).toBeGreaterThan(-1);
    expect(modifiers).toBeLessThan(body.indexOf("event.key"));
    // Typing is checked before any letter key is acted on, and the keys act only inside the table.
    const typing = body.indexOf("typingIn(at)");
    expect(typing).toBeGreaterThan(-1);
    expect(typing).toBeLessThan(body.indexOf('key === "j"'));
    expect(body.indexOf("closest('[data-zone=\"issues\"]')")).toBeLessThan(
      body.indexOf('key === "j"'),
    );
    // And what typingIn counts as typing is every kind of text entry there is.
    const typingIn = source.slice(
      source.indexOf("function typingIn"),
      source.indexOf("function prefersReducedMotion"),
    );
    for (const tag of ["input", "textarea", "select"]) expect(typingIn).toContain(`"${tag}"`);
    expect(typingIn).toContain("isContentEditable");
  });

  it.each([
    ["an input", "input", false],
    ["a text area", "textarea", false],
    ["a select", "select", false],
    ["an element that can be edited", "div", true],
  ] as const)("does not take a letter typed into %s inside the table", (_name, tag, editable) => {
    const h = runScript(runPage({ selected: null }));
    const field = new FakeElement(h.doc, null, tag);
    field.isContentEditable = editable;
    field.parent = h.doc.querySelector('[data-zone="issues"]');
    for (const letter of ["j", "k", "?", "Enter"]) key(h, letter, {}, field);
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(0);
    expect(h.doc.querySelector("[data-keys-help]")!.open).toBe(false);
  });

  it("names, in the list of keys, every key it acts on, and says where they work", () => {
    const acted = [...source.matchAll(/key === "([^"]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(acted)].sort()).toEqual(["?", "Enter", "Escape", "j", "k"]);
    const h = runScript(runPage());
    const help = h.doc.querySelector("[data-keys-help]")!;
    const text = (help.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("These keys work while focus is in the issue table.");
    for (const name of ["j", "k", "Enter", "?", "Escape"]) expect(text, name).toContain(name);
  });
});

describe("keyboard", () => {
  const rows = () => buildIssueRows();

  it("moves down and up the rows with j and k, focusing each row's link", () => {
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    expect(links).toHaveLength(8);
    focusTable(h);
    key(h, "j");
    expect(links[0]!.calls.focus).toBe(1);
    expect(h.doc.activeElement).toBe(links[0]);
    key(h, "j");
    expect(h.doc.activeElement).toBe(links[1]);
    key(h, "k");
    expect(h.doc.activeElement).toBe(links[0]);
    key(h, "k");
    expect(h.doc.activeElement).toBe(links[0]);
    expect(rows()).toHaveLength(8);
  });

  it("moves from the row that has focus when Tab put it there, not from the last row it moved to", () => {
    // Found in a real browser: Tab to the first row, then j did nothing visible (it went to row 0),
    // and Tab to the fourth row, then j jumped back to the first. Positions are compared as numbers
    // because a failed comparison of two fake elements prints a circular structure and hangs.
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    const at = (): number => links.findIndex((link) => link === h.doc.activeElement);
    links[0]!.focus();
    key(h, "j");
    expect(at()).toBe(1);
    links[3]!.focus();
    key(h, "j");
    expect(at()).toBe(4);
    links[5]!.focus();
    key(h, "k");
    expect(at()).toBe(4);
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(1);
  });

  it("starts from the selected row", () => {
    const h = runScript(runPage());
    const links = h.doc.querySelectorAll("[data-row-link]");
    expect(links[0]!.getAttribute("aria-current")).toBe("true");
    focusTable(h);
    key(h, "j");
    expect(h.doc.activeElement).toBe(links[1]);
  });

  it("starts at the last row with k when nothing is chosen, and stops at the ends", () => {
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    focusTable(h);
    key(h, "k");
    expect(h.doc.activeElement).toBe(links[7]);
    key(h, "j");
    expect(h.doc.activeElement).toBe(links[7]);
  });

  it("marks the row it is on", () => {
    const h = runScript(runPage({ selected: null }));
    focusTable(h);
    key(h, "j");
    key(h, "j");
    const current = h.doc.querySelectorAll("tr.is-current");
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(h.doc.querySelectorAll("[data-row-link]")[1]!.closest("tr"));
  });

  it("opens the row with Enter when focus is on the table's box, and leaves a focused link alone", () => {
    const h = runScript(runPage({ selected: null }));
    const links = h.doc.querySelectorAll("[data-row-link]");
    const box = focusTable(h);
    key(h, "Enter");
    expect(links[0]!.calls.click).toBe(0);
    key(h, "j");
    // Focus is on the first link now. Go back to the box, as the back link does.
    box.focus();
    key(h, "Enter");
    expect(links[0]!.calls.click).toBe(1);
    // With the link itself focused the browser follows it, so the script must not click twice.
    const e = event("keydown", links[0], { key: "Enter" });
    links[0]!.dispatch(e);
    expect(links[0]!.calls.click).toBe(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores keys typed into a form field, and keys with a modifier", () => {
    const h = runScript(matterPage(buildMatterView()));
    expect(h.doc.querySelectorAll("[data-row-link]")).toHaveLength(0);
    const h2 = runScript(runPage({ selected: null }));
    // A field inside the table's box, so only the check for typing can stop the key.
    const field = new FakeElement(h2.doc, null, "textarea");
    field.parent = h2.doc.querySelector('[data-zone="issues"]');
    key(h2, "j", {}, field);
    expect(h2.doc.querySelectorAll("tr.is-current")).toHaveLength(0);
    const box = focusTable(h2);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      key(h2, "j", mod);
    }
    expect(h2.doc.querySelectorAll("tr.is-current")).toHaveLength(0);
    const handled = event("keydown", box, { key: "j", defaultPrevented: true });
    box.dispatch(handled);
    expect(h2.doc.querySelectorAll("tr.is-current")).toHaveLength(0);
  });

  it("shows the key list with ? in the table and hides it with Escape", () => {
    const h = runScript(runPage());
    const help = h.doc.querySelector("[data-keys-help]")!;
    expect(help.open).toBe(false);
    const box = focusTable(h);
    key(h, "?");
    expect(help.open).toBe(true);
    expect(h.doc.activeElement).toBe(help.querySelector("summary"));
    key(h, "Escape");
    expect(help.open).toBe(false);
    key(h, "?", {}, box);
    expect(help.open).toBe(true);
    key(h, "Escape", {}, box);
    expect(help.open).toBe(false);
  });

  it("does nothing on a page without a table or a key list", () => {
    const h = runScript(mattersPage());
    expect(() => {
      key(h, "j");
      key(h, "?");
      key(h, "Enter");
    }).not.toThrow();
  });
});

describe("scrolling the quote into view", () => {
  it("centres the highlighted quote, smoothly unless motion is reduced", () => {
    const h = runScript(runPage());
    const mark = h.doc.querySelector("mark[data-quote]")!;
    expect(mark.calls.scroll).toEqual([{ block: "center", behavior: "smooth" }]);
    const reduced = runScript(runPage(), { reducedMotion: true });
    expect(reduced.doc.querySelector("mark[data-quote]")!.calls.scroll).toEqual([
      { block: "center", behavior: "auto" },
    ]);
  });

  it("brings the chosen row into view", () => {
    const h = runScript(runPage());
    expect(h.doc.querySelector("tr.is-selected")!.calls.scroll).toEqual([{ block: "nearest" }]);
  });

  it("does nothing when nothing is chosen", () => {
    const h = runScript(runPage({ selected: null }));
    expect(h.doc.querySelectorAll("mark")).toHaveLength(0);
  });

  it("leaves a page that opens on a refusal where it begins, so the refusal is seen", () => {
    // Found in a real browser: the refused decision page was scrolled to its quote, which put the
    // alert behind the banner at the top of the window.
    const refusal = buildChrome({
      notice: {
        kind: "error",
        text: "Give a reason. A decision to edit, reject or escalate needs one.",
      },
    });
    const h = runScript(findingPage(undefined, refusal));
    expect(h.doc.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(h.doc.querySelector("mark[data-quote]")!.calls.scroll).toEqual([]);
    // The same page with no refusal still shows its quote.
    const plain = runScript(findingPage());
    expect(plain.doc.querySelector("mark[data-quote]")!.calls.scroll).toHaveLength(1);
  });
});

describe("buttons after a submit", () => {
  const submit = (_h: ReturnType<typeof runScript>, form: FakeElement) =>
    form.dispatch(event("submit", form));

  it("disables a form's submit buttons once it has been sent, not before", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const form = h.doc
      .querySelectorAll("form")
      .find((f) => f.getAttribute("action")?.endsWith("/runs"))!;
    const buttons = form.elements.filter((el) => el.type === "submit");
    expect(buttons.length).toBeGreaterThan(0);
    submit(h, form);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    await h.advance(0);
    expect(buttons.every((b) => b.disabled && b.hasAttribute("data-busy"))).toBe(true);
  });

  it("leaves other forms' buttons alone", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const forms = h.doc.querySelectorAll("form");
    const run = forms.find((f) => f.getAttribute("action")?.endsWith("/runs"))!;
    const other = forms.find((f) => f.getAttribute("action")?.endsWith("/settings"))!;
    submit(h, run);
    await h.advance(0);
    expect(other.elements.filter((el) => el.type === "submit").every((b) => !b.disabled)).toBe(
      true,
    );
  });

  it("includes a button tied to the form by the form attribute", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const dateForm = h.doc
      .querySelectorAll("form")
      .find((f) => f.getAttribute("action")?.includes("/stated-date"))!;
    const tied = dateForm.elements.filter((el) => el.tagName === "BUTTON");
    expect(tied).toHaveLength(1);
    submit(h, dateForm);
    await h.advance(0);
    expect(tied[0]!.disabled).toBe(true);
  });

  it("gives the buttons back if the page stays (a download), or comes back from the cache", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const form = h.doc
      .querySelectorAll("form")
      .find((f) => f.getAttribute("action")?.endsWith("/runs"))!;
    const buttons = form.elements.filter((el) => el.type === "submit");
    submit(h, form);
    await h.advance(1000);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await h.advance(15000);
    expect(buttons.every((b) => !b.disabled && !b.hasAttribute("data-busy"))).toBe(true);
    submit(h, form);
    await h.advance(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    h.pageshow(false);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    h.pageshow(true);
    expect(buttons.every((b) => !b.disabled && !b.hasAttribute("data-busy"))).toBe(true);
  });

  it("ignores a submit that is not from a form", async () => {
    const h = runScript(matterPage(buildMatterView()));
    const stray = new FakeElement(h.doc, null, "div");
    stray.parent = h.doc.body;
    expect(() => stray.dispatch(event("submit", stray))).not.toThrow();
  });
});

describe("progress polling", () => {
  const running = () => runScript(matterPage(buildRunningMatterView()));
  const answer = (h: ReturnType<typeof runScript>, body: unknown, ok = true) =>
    h.respondWith(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
  const text = (h: ReturnType<typeof runScript>, role: string) =>
    h.doc.querySelector(`[data-role="${role}"]`)!.textContent;

  it("asks for the page's status URL every two seconds, as JSON, with the session", async () => {
    const h = running();
    answer(h, {
      status: "analyzing",
      label: "Analyzing rules",
      progress: { stage: "analyze", done: 4, total: 8 },
    });
    await h.advance(1999);
    expect(h.fetchCalls).toHaveLength(0);
    await h.advance(1);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]!.url).toBe("/matters/m_lanternfish01/runs/r_0142/status");
    expect(h.fetchCalls[0]!.init).toMatchObject({
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    await h.advance(2000);
    expect(h.fetchCalls).toHaveLength(2);
  });

  it("updates the numbers and the bar from the answer", async () => {
    const h = running();
    answer(h, {
      status: "analyzing",
      label: "Analyzing rules",
      progress: { stage: "analyze", done: 6, total: 8 },
    });
    await h.advance(2000);
    expect(text(h, "done")).toBe("6");
    expect(text(h, "total")).toBe("8");
    const bar = h.doc.querySelector('[data-role="bar"]')!;
    expect(bar.value).toBe(6);
    expect(bar.max).toBe(8);
    expect(text(h, "stage")).toBe("Analyzing rules");
  });

  it("never lets a number be zero-width or non-finite", async () => {
    const h = running();
    answer(h, { status: "analyzing", progress: { stage: "analyze", done: 0, total: 0 } });
    await h.advance(2000);
    expect(h.doc.querySelector('[data-role="bar"]')!.max).toBe(1);
    answer(h, { status: "analyzing", progress: { stage: "analyze", done: "x", total: null } });
    await h.advance(2000);
    expect(text(h, "done")).toBe("0");
  });

  it("writes a label from the server as text, never as markup", async () => {
    const h = running();
    const hostile = '<img src=x onerror="window.pwned=1"><script>1</script>';
    answer(h, { status: "analyzing", label: hostile, progress: null });
    await h.advance(2000);
    const stage = h.doc.querySelector('[data-role="stage"]')!;
    expect(stage.textContent).toBe(hostile);
    expect(stage.children).toHaveLength(0);
    expect(h.doc.querySelectorAll("img")).toHaveLength(0);
  });

  it("reloads the page when the run has finished", async () => {
    const h = running();
    answer(h, { status: "succeeded", finished: true, progress: null });
    await h.advance(2000);
    expect(h.reloads).toBe(1);
    await h.advance(10000);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("treats a terminal status as finished even without the flag", async () => {
    for (const status of ["succeeded", "failed", "cancelled", "superseded"]) {
      const h = running();
      answer(h, { status });
      await h.advance(2000);
      expect(h.reloads, status).toBe(1);
    }
  });

  it("does not reload under someone who is typing, and says the run is done", async () => {
    const h = running();
    const field = new FakeElement(h.doc, null, "input");
    field.parent = h.doc.body;
    h.doc.activeElement = field;
    answer(h, { status: "succeeded", finished: true });
    await h.advance(2000);
    expect(h.reloads).toBe(0);
    expect(text(h, "stage")).toBe("Finished. Reload the page to see the results.");
    await h.advance(10000);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("reloads at most three times a minute, so a disagreeing server cannot loop", async () => {
    const h = running();
    h.storage.set("parol-reload", `3:${h.now - 1000}`);
    answer(h, { status: "succeeded", finished: true });
    await h.advance(2000);
    expect(h.reloads).toBe(0);
    expect(text(h, "stage")).toBe("Finished. Reload the page to see the results.");
    const later = running();
    later.storage.set("parol-reload", `3:${later.now - 61000}`);
    answer(later, { status: "succeeded", finished: true });
    await later.advance(2000);
    expect(later.reloads).toBe(1);
  });

  it("still works when session storage is blocked", async () => {
    const h = runScript(matterPage(buildRunningMatterView()), { storageBlocked: true });
    answer(h, { status: "succeeded", finished: true });
    await h.advance(2000);
    expect(h.reloads).toBe(1);
  });

  it("ignores failures: a bad status, a network error, bad JSON and a wrong shape all keep it trying", async () => {
    const h = running();
    h.respondWith(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    await h.advance(2000);
    h.respondWith(() => Promise.reject(new Error("offline")));
    await h.advance(2000);
    h.respondWith(() =>
      Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("bad")) }),
    );
    await h.advance(2000);
    h.respondWith(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ unexpected: true }) }),
    );
    await h.advance(2000);
    expect(h.fetchCalls).toHaveLength(4);
    answer(h, { status: "analyzing", progress: { stage: "analyze", done: 7, total: 8 } });
    await h.advance(2000);
    expect(text(h, "done")).toBe("7");
    expect(h.reloads).toBe(0);
  });

  it("gives up after five failures in a row, and a good answer resets the count", async () => {
    const h = running();
    h.respondWith(() => Promise.reject(new Error("offline")));
    await h.advance(2000 * 4);
    expect(h.fetchCalls).toHaveLength(4);
    answer(h, { status: "analyzing", progress: null });
    await h.advance(2000);
    h.respondWith(() => Promise.reject(new Error("offline")));
    await h.advance(2000 * 4);
    expect(h.fetchCalls).toHaveLength(9);
    await h.advance(2000);
    expect(h.fetchCalls).toHaveLength(10);
    await h.advance(60000);
    expect(h.fetchCalls).toHaveLength(10);
  });

  it("does not ask while the tab is hidden, and carries on when it is shown", async () => {
    const h = running();
    answer(h, { status: "analyzing", progress: null });
    h.doc.hidden = true;
    await h.advance(6000);
    expect(h.fetchCalls).toHaveLength(0);
    h.doc.hidden = false;
    await h.advance(2000);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("does not start on a page with no running review", async () => {
    for (const html of [matterPage(buildMatterView()), mattersPage(), runPage()]) {
      const h = runScript(html);
      await h.advance(20000);
      expect(h.fetchCalls).toHaveLength(0);
    }
  });

  it("also runs on the issue table page while a review runs", async () => {
    const run = buildRunSummary({
      status: "analyzing",
      progress: { stage: "analyze", done: 1, total: 8 },
      finishedAt: null,
    });
    const h = runScript(runPage({ run, issues: [], selected: null }));
    answer(h, { status: "analyzing", progress: { stage: "analyze", done: 2, total: 8 } });
    await h.advance(2000);
    expect(h.fetchCalls[0]!.url).toBe("/matters/m_lanternfish01/runs/r_0142/status");
    expect(text(h, "done")).toBe("2");
  });

  it("will not send a request anywhere but a path on this site", async () => {
    const base = matterPage(buildRunningMatterView());
    for (const bad of [
      "//evil.example/status",
      "https://evil.example/status",
      "http://evil.example/",
      "javascript:alert(1)",
      "\\\\evil.example",
      "/ok\\evil",
      "status",
      "",
    ]) {
      const html = base.replace(
        /data-status-url="[^"]*"/,
        `data-status-url="${bad.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
      );
      const h = runScript(html);
      await h.advance(10000);
      expect(h.fetchCalls, bad).toHaveLength(0);
    }
  });

  it("does nothing when fetch is missing", async () => {
    const h = runScript(matterPage(buildRunningMatterView()), { noFetch: true });
    await h.advance(10000);
    expect(h.fetchCalls).toHaveLength(0);
  });
});
