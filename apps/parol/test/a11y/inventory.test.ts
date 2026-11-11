import { describe, expect, it } from "vitest";
import type { RouteReport } from "../../src/server/matter-route.js";
import { all, byTag, parseHtml, type El } from "../pages/html.js";
import {
  controlsOf,
  isApiPath,
  staleClassifications,
  submitProblem,
  submitsOf,
  unclassifiedGetRoutes,
  unnamedFields,
} from "./inventory.js";

/**
 * The pure parts of the route-table inventory, on routes and pages made by hand, so that each says
 * what it must: the route nobody classified is found and no other, and a form that cannot be sent
 * from the keyboard, or that has a field with no name, is named with its reason.
 */

const route = (
  method: string,
  path: string,
  kind: RouteReport["kind"] = "principal",
): RouteReport => ({ method, path, kind, action: null, globalAction: null });

describe("the classification of GET routes", () => {
  const crafted = [
    route("GET", "/matters"),
    route("GET", "/healthz", "public"),
    route("GET", "/thing"),
    route("GET", "/api/thing"),
    route("POST", "/other"),
    route("ALL", "/*", "middleware"),
    route("ALL", "/anything", "unmanaged"),
  ];

  it("returns the GET routes in no list and not under /api/, and nothing else", () => {
    expect(unclassifiedGetRoutes(crafted, ["/matters"], ["/healthz"])).toEqual([
      "GET /thing",
      "ALL /anything",
    ]);
  });

  it("returns nothing once each is a page or is not a page", () => {
    expect(
      unclassifiedGetRoutes(crafted, ["/matters", "/thing", "/anything"], ["/healthz"]),
    ).toEqual([]);
    expect(
      unclassifiedGetRoutes(crafted, ["/matters"], ["/healthz", "/thing", "/anything"]),
    ).toEqual([]);
  });

  it("takes the API for what is under /api/ and nothing that only starts like it", () => {
    expect(isApiPath("/api/thing")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/matters/api/x")).toBe(false);
    expect(unclassifiedGetRoutes([route("GET", "/apiary")], [], [])).toEqual(["GET /apiary"]);
  });

  it("finds a classification that outlives its route, and a path in both lists", () => {
    expect(staleClassifications(crafted, ["/matters", "/gone"], ["/healthz", "/matters"])).toEqual([
      "page /gone has no route",
      "/matters is in both lists",
    ]);
    expect(staleClassifications(crafted, ["/matters"], ["/healthz", "/missing"])).toEqual([
      "non-page /missing has no route",
    ]);
    expect(staleClassifications(crafted, ["/matters"], ["/healthz"])).toEqual([]);
  });
});

/** The first form of a snippet, and the snippet. */
const formOf = (html: string): { root: El; form: El } => {
  const root = parseHtml(html);
  const form = byTag(root, "form")[0];
  if (form === undefined) throw new Error("the snippet has no form");
  return { root, form };
};

describe("the controls of a form", () => {
  it("include those tied to it from outside by form=, and leave out those of another form", () => {
    const { root, form } = formOf(
      '<form id="a" method="post" action="/a"><input type="text" name="x" aria-label="X"></form>' +
        '<button type="submit" form="a">Send</button>' +
        '<form id="b" method="post" action="/b"><button type="submit">Other</button></form>',
    );
    expect(controlsOf(root, form).map((el) => el.name)).toEqual(["input", "button"]);
    expect(submitsOf(root, form).map((el) => el.name)).toEqual(["button"]);
  });

  it("count a button as a submit unless it says otherwise", () => {
    const { root, form } = formOf(
      '<form method="post" action="/a"><button>Send</button><button type="button">A</button>' +
        '<button type="reset">B</button><input type="submit" value="Also"><input type="image" alt="Go"></form>',
    );
    expect(submitsOf(root, form).map((el) => el.name)).toEqual(["button", "input", "input"]);
  });
});

describe("the fields of a form that have no name", () => {
  it("are found, and a labelled field, an aria-label, a hidden field and a button are not", () => {
    const { root, form } = formOf(
      '<form method="post" action="/a">' +
        '<label for="one">One</label><input id="one" type="text" name="one">' +
        '<input type="text" name="two" aria-label="Two">' +
        '<input type="hidden" name="_csrf" value="t">' +
        '<input type="text" name="three">' +
        '<select name="four"><option value="a">A</option></select>' +
        '<textarea name="five"></textarea>' +
        '<button type="submit">Send</button></form>',
    );
    expect(unnamedFields(root, form)).toEqual([
      "<input name=three>",
      "<select name=four>",
      "<textarea name=five>",
    ]);
  });
});

describe("whether a form can be sent from the keyboard", () => {
  const problem = (html: string): string | null => {
    const { root, form } = formOf(html);
    return submitProblem(root, form);
  };

  it("accepts a form with a submit that takes a tab stop", () => {
    expect(
      problem(
        '<form method="post" action="/a"><input type="text" name="x" aria-label="X"><button type="submit">Send</button></form>',
      ),
    ).toBeNull();
  });

  it("accepts a submit tied to the form from outside it", () => {
    expect(
      problem(
        '<form id="f" method="post" action="/a"><input type="text" name="x" aria-label="X"></form><button type="submit" form="f">Send</button>',
      ),
    ).toBeNull();
  });

  it("accepts a submit inside a folded section whose heading takes a stop, and not one without a heading", () => {
    expect(
      problem(
        '<details><summary>More</summary><form method="post" action="/a"><button type="submit">Send</button></form></details>',
      ),
    ).toBeNull();
    expect(
      problem(
        '<details><form method="post" action="/a"><button type="submit">Send</button></form></details>',
      ),
    ).toBe("no submit control can be reached with the keyboard");
  });

  it("refuses a form with no submit", () => {
    expect(
      problem('<form method="post" action="/a"><input type="text" name="x" aria-label="X"></form>'),
    ).toBe("it has no submit control");
    expect(
      problem('<form method="post" action="/a"><button type="button">Not a submit</button></form>'),
    ).toBe("it has no submit control");
  });

  it("refuses a submit taken out of the tab order, hidden, or disabled without a reason", () => {
    for (const attrs of ['tabindex="-1"', "hidden", "disabled"])
      expect(
        problem(
          `<form method="post" action="/a"><button type="submit" ${attrs}>Send</button></form>`,
        ),
        attrs,
      ).toBe("no submit control can be reached with the keyboard");
  });

  it("accepts a disabled submit only when each says why, in text", () => {
    const reason = '<p id="why">Add the NDA first.</p>';
    expect(
      problem(
        `${reason}<form method="post" action="/a"><button type="submit" disabled aria-describedby="why">Start</button></form>`,
      ),
    ).toBeNull();
    expect(
      problem(
        '<p id="why"></p><form method="post" action="/a"><button type="submit" disabled aria-describedby="why">Start</button></form>',
      ),
    ).toBe("no submit control can be reached with the keyboard");
    expect(
      problem(
        `${reason}<form method="post" action="/a"><button type="submit" disabled aria-describedby="elsewhere">Start</button></form>`,
      ),
    ).toBe("no submit control can be reached with the keyboard");
  });

  it("accepts a form when one of its submits can be reached and another cannot", () => {
    expect(
      problem(
        '<form method="post" action="/a"><button type="submit" disabled>One</button><button type="submit">Two</button></form>',
      ),
    ).toBeNull();
  });

  it("is checked on a page with several forms, each on its own", () => {
    const root = parseHtml(
      '<form method="post" action="/a"><button type="submit">A</button></form>' +
        '<form method="post" action="/b"><input type="text" name="x" aria-label="X"></form>',
    );
    expect(all(root, (el) => el.name === "form").map((form) => submitProblem(root, form))).toEqual([
      null,
      "it has no submit control",
    ]);
  });
});
