import { describe, expect, it } from "vitest";
import { GUIDANCE, GUIDANCE_BY_STATUS, GUIDANCE_KEYS } from "../../src/server/guidance.js";
import { ErrorPage, render, renderErrorPage } from "../../src/server/pages/index.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, first, forms, hasClass, readable } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { buildChrome } from "./support.js";

const ID = "req_0123456789abcdef";

describe("ErrorPage and the request id of a server fault", () => {
  const page = (requestId: string | undefined): string =>
    render(
      ErrorPage({
        chrome: buildChrome(),
        status: 500,
        title: "Something went wrong",
        message: "It broke. Try again.",
        todo: "Try again.",
        requestId,
      }),
    );

  it("prints the id so that the person can quote it", () => {
    const root = checkInvariants(page(ID));
    expect(readable(first(root, (el) => hasClass(el, "technical")))).toBe(`Reference: ${ID}`);
  });

  it.each([
    "req_short",
    "req_0123456789abcdeg",
    ` ${ID}`,
    `${ID}\n`,
    "<b>req_0123456789abcdef</b>",
    "req_0123456789abcdef0",
    "",
  ])("prints nothing that does not have the shape of an id the shell makes: %j", (bad) => {
    const root = checkInvariants(page(bad));
    expect(all(root, (el) => hasClass(el, "technical"))).toHaveLength(0);
    expect(readable(root)).not.toContain("Reference");
  });

  it("prints no reference when there is no id", () => {
    expect(readable(checkInvariants(page(undefined)))).not.toContain("Reference");
  });

  it("sets the part that says what to do in bold, and leaves the visible words as they were", () => {
    const root = checkInvariants(page(undefined));
    const todo = all(root, (el) => hasClass(el, "todo"));
    expect(todo.map(readable)).toEqual(["Try again."]);
    expect(readable(first(root, (el) => hasClass(el, "error-page")))).toContain(
      "It broke. Try again.",
    );
  });

  it("still shows the advice when it does not occur in the sentence, instead of losing it", () => {
    const html = render(
      ErrorPage({
        chrome: buildChrome(),
        status: 400,
        title: "Title",
        message: "It broke.",
        todo: "Try again.",
      }),
    );
    const root = checkInvariants(html);
    expect(readable(first(root, (el) => hasClass(el, "error-page")))).toContain(
      "It broke. Try again.",
    );
    expect(all(root, (el) => hasClass(el, "todo")).map(readable)).toEqual(["Try again."]);
  });
});

describe("renderErrorPage, the shell's renderer made from ErrorPage", () => {
  it("is a whole page with the banner, signed out, with no form to carry a token", () => {
    const root = checkInvariants(renderErrorPage(404, "Page not found"));
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Page not found");
    expect(readable(root)).toContain("Error 404");
    expect(forms(root)).toHaveLength(0);
    expect(readable(root)).not.toContain("Signed in as");
  });

  it("says the same thing for the same status and key, whatever the title is called", () => {
    const a = renderErrorPage(404, "Page not found");
    expect(renderErrorPage(404, "Page not found")).toBe(a);
    expect(renderErrorPage(404, "Page not found", undefined, "not_found")).toBe(a);
    expect(a).not.toContain("req_");
  });

  it("gives a server fault the reference and every other status none", () => {
    expect(readable(checkInvariants(renderErrorPage(500, "Something went wrong", ID)))).toContain(
      `Reference: ${ID}`,
    );
    for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 431])
      expect(renderErrorPage(status, "Title"), String(status)).not.toContain("Reference");
  });

  it("has a sentence for each status the shell answers with, and a general one for any other", () => {
    const messages = new Set<string>();
    const statuses = Object.keys(GUIDANCE_BY_STATUS).map(Number);
    expect(statuses).toEqual([400, 401, 403, 404, 408, 409, 413, 422, 431, 500]);
    for (const status of statuses) {
      const root = checkInvariants(renderErrorPage(status, "Title"));
      const text = readable(first(root, (el) => hasClass(el, "error-page")));
      expect(text).toContain(`Error ${status}`);
      expect(text).toContain(GUIDANCE[GUIDANCE_BY_STATUS[status]!].text);
      messages.add(text);
    }
    expect(messages.size).toBe(10);
    const other = readable(checkInvariants(renderErrorPage(418, "Title")));
    expect(other).toContain("The request could not be completed.");
    expect(other).toContain(GUIDANCE.other.text);
  });

  it("marks the sentence that says what to do on every page, and it is the one in the table", () => {
    for (const key of GUIDANCE_KEYS) {
      // The status is the one the key is sent with; a key wins over the status either way.
      const status = key === "server" ? 500 : key === "sign_in" ? 401 : 403;
      const root = checkInvariants(renderErrorPage(status, "Title", undefined, key));
      const marked = all(root, (el) => hasClass(el, "todo")).map(readable);
      expect(marked, key).toEqual([GUIDANCE[key].todo]);
      expect(readable(first(root, (el) => hasClass(el, "error-page"))), key).toContain(
        GUIDANCE[key].text,
      );
    }
  });

  it("reads differently for each cause of a 403, and tells the person what to do", () => {
    const textOf = (key: "csrf" | "host" | "role" | "global_role"): string =>
      readable(
        first(checkInvariants(renderErrorPage(403, "You may not do that", undefined, key)), (el) =>
          hasClass(el, "error-page"),
        ),
      );
    const causes = (["csrf", "host", "role", "global_role"] as const).map(textOf);
    expect(new Set(causes).size).toBe(4);
    // Without a key the status gives the role sentence, the most common cause.
    expect(readable(checkInvariants(renderErrorPage(403, "T")))).toContain(GUIDANCE.role.text);
    expect(causes[0]).toContain("Reload the page and send the form again.");
    expect(causes[1]).toContain("Open Parol at http://localhost");
    expect(causes[2]).toContain("Your role on this matter does not allow that.");
    expect(causes[3]).toContain(
      "This page is for the legal engineer or an administrator. Ask one of them, or go back to your matters.",
    );
    // None of the new sentences is the old, wrong one for a form that expired or a foreign address.
    expect(causes[0]).not.toContain("Your role");
    expect(causes[1]).not.toContain("Your role");
    expect(causes[3]).not.toContain("on this matter");
  });

  it("takes a key from the shell and ignores anything that is not one", () => {
    const base = renderErrorPage(409, "Title");
    for (const bad of ["", "toString", "__proto__", "constructor", "hasOwnProperty", "ROLE"])
      expect(renderErrorPage(409, "Title", undefined, bad as never), bad).toBe(base);
    // A key wins over the status that came with it.
    expect(renderErrorPage(409, "Title", undefined, "csrf")).not.toBe(base);
  });

  it("sends a visitor who must sign in to the sign-in page, and everyone else to their matters", () => {
    const href = (status: number): string | null | undefined =>
      attr(
        first(checkInvariants(renderErrorPage(status, "T")), (el) => hasClass(el, "button")),
        "href",
      );
    expect(href(401)).toBe(urls.home());
    expect(href(404)).toBe(urls.matters());
    expect(href(500)).toBe(urls.matters());
    expect(href(403)).toBe(urls.matters());
  });
});

describe("the error pages and the keyboard", () => {
  const cases: [string, string][] = GUIDANCE_KEYS.map((key) => {
    const status = Number(
      Object.entries(GUIDANCE_BY_STATUS).find(([, k]) => k === key)?.[0] ??
        (key === "csrf" || key === "host" || key === "global_role" ? 403 : 418),
    );
    return [key, renderErrorPage(status, "Title", status === 500 ? ID : undefined, key)];
  });

  it.each(cases)(
    "%s: passes the rules, with a sentence marked and a way to go on",
    (_key, html) => {
      const root = expectAccessible(html);
      const stops = tabStops(root);
      // The skip link comes first, and the last stop is the way to go on.
      expect(attr(stops[0]!, "href")).toBe("#main");
      expect(hasClass(stops[0]!, "skip-link")).toBe(true);
      const last = stops.at(-1)!;
      expect(last.name).toBe("a");
      expect(hasClass(last, "button")).toBe(true);
      expect(["Back to your matters", "Go to sign in"]).toContain(readable(last));
    },
  );

  it("covers every key", () => {
    expect(cases.map(([key]) => key)).toEqual([...GUIDANCE_KEYS]);
  });
});
