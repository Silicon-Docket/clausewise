import { describe, expect, it } from "vitest";
import { ErrorPage, render, renderErrorPage } from "../../src/server/pages/index.js";
import { urls } from "../../src/server/urls.js";
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
        message: "x",
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
});

describe("renderErrorPage, the shell's renderer made from ErrorPage", () => {
  it("is a whole page with the banner, signed out, with no form to carry a token", () => {
    const root = checkInvariants(renderErrorPage(404, "Page not found"));
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Page not found");
    expect(readable(root)).toContain("Error 404");
    expect(forms(root)).toHaveLength(0);
    expect(readable(root)).not.toContain("Signed in as");
  });

  it("says the same thing for the same status, whatever the title is called", () => {
    const a = renderErrorPage(404, "Page not found");
    expect(renderErrorPage(404, "Page not found")).toBe(a);
    expect(a).not.toContain("req_");
  });

  it("gives a server fault the reference and every other status none", () => {
    expect(readable(checkInvariants(renderErrorPage(500, "Something went wrong", ID)))).toContain(
      `Reference: ${ID}`,
    );
    for (const status of [400, 401, 403, 404, 409, 413, 422])
      expect(renderErrorPage(status, "Title"), String(status)).not.toContain("Reference");
  });

  it("has a sentence for each status the shell answers with, and a general one for any other", () => {
    const messages = new Set<string>();
    for (const status of [400, 401, 403, 404, 409, 413, 422, 500]) {
      const root = checkInvariants(renderErrorPage(status, "Title"));
      const text = readable(first(root, (el) => hasClass(el, "error-page")));
      expect(text).toContain(`Error ${status}`);
      messages.add(text);
    }
    expect(messages.size).toBe(8);
    expect(readable(checkInvariants(renderErrorPage(418, "Title")))).toContain(
      "The request could not be completed.",
    );
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
  });
});
