/**
 * The pure parts of the route-table inventory (`routes.test.ts`): which routes a person has decided
 * are pages, which controls a form holds, and whether its submit can be reached with the keyboard.
 * Nothing here sends a request or reads the application: it works on a list of routes and on parsed
 * HTML, so a test can hand it a crafted list or a crafted page and know exactly what it must say.
 */
import type { RouteReport } from "../../src/server/matter-route.js";
import { all, ancestorsOf, attr, hasAttr, readable, type El } from "../pages/html.js";
import { accessibleName, tabStops } from "./rules.js";

// ---------------------------------------------------------------------------------------------
// Classifying the routes
// ---------------------------------------------------------------------------------------------

/**
 * The GET routes that are pages: the one place a person decides a route is a page. Each is requested
 * as every kind of person, on every matter that fits (`routes.test.ts`), and each has a whole-page
 * fixture (`pages.test.ts`). A GET route that is in neither this list nor `NON_PAGE_GET` fails the
 * inventory with what to do.
 */
export const PAGE_GETS = [
  "/",
  "/matters",
  "/matters/:matterId",
  "/matters/:matterId/runs/:runId",
  "/matters/:matterId/findings/:findingId",
  "/matters/:matterId/memos",
  "/quickstart",
  "/help",
  "/evaluations",
  "/pilot",
  "/audit",
  "/training/key",
] as const;

export type PageGet = (typeof PAGE_GETS)[number];

/** The GET routes that are not pages, each with what it answers instead. Anything under /api/ is JSON. */
export const NON_PAGE_GET: Readonly<Record<string, string>> = {
  "/healthz": "a liveness answer in plain text",
  "/assets/:name": "the public files: the stylesheet and the script",
  "/matters/:matterId/runs/:runId/status":
    "JSON that the script polls for the progress of a review",
  "/matters/:matterId/memos/:memoId/file": "a download of the memo as a Word file",
  "/pilot/measures.csv": "a download of the pilot measures as CSV",
};

/** A route a browser can ask for with GET: the method itself, or `ALL`, and not the shell's middleware. */
const answersGet = (route: RouteReport): boolean =>
  (route.method === "GET" || route.method === "ALL") && route.kind !== "middleware";

/** The JSON API, whose routes are never pages (`routes.test.ts` checks that none answers with one). */
export const isApiPath = (path: string): boolean => path.startsWith("/api/");

/**
 * Every route that answers GET and that nobody has classified, as `METHOD /path`: not a page of
 * `pages`, not in `nonPage`, and not under `/api/`. A route that is found here is either a new page
 * (add it to `pages`, where it is audited in every role that can reach it) or something that is not
 * a page (add it to `nonPage` with the reason).
 */
export function unclassifiedGetRoutes(
  routes: readonly RouteReport[],
  pages: readonly string[],
  nonPage: readonly string[],
): string[] {
  return routes
    .filter(answersGet)
    .filter(
      (route) =>
        !isApiPath(route.path) && !pages.includes(route.path) && !nonPage.includes(route.path),
    )
    .map((route) => `${route.method} ${route.path}`);
}

/**
 * The entries of `pages` and `nonPage` that no GET route has, and the paths that are in both. A
 * classification that outlives its route would let a new route of the same path through, and a path
 * in both lists is a decision nobody made.
 */
export function staleClassifications(
  routes: readonly RouteReport[],
  pages: readonly string[],
  nonPage: readonly string[],
): string[] {
  const held = new Set(routes.filter(answersGet).map((route) => route.path));
  return [
    ...pages.filter((path) => !held.has(path)).map((path) => `page ${path} has no route`),
    ...nonPage.filter((path) => !held.has(path)).map((path) => `non-page ${path} has no route`),
    ...pages.filter((path) => nonPage.includes(path)).map((path) => `${path} is in both lists`),
  ];
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

const CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);

const inputKind = (el: El): string => (attr(el, "type") ?? "text").trim().toLowerCase();

/** The form a control belongs to: the one its `form` attribute names, else the nearest ancestor form. */
function ownerOf(root: El, control: El): El | null {
  const named = attr(control, "form");
  if (named !== undefined && named !== null && named !== "") {
    return all(root, (el) => el.name === "form" && attr(el, "id") === named)[0] ?? null;
  }
  return (
    ancestorsOf(root, control)
      .reverse()
      .find((el) => el.name === "form") ?? null
  );
}

/** Every control of a form, including those tied to it from outside by `form="id"`. */
export function controlsOf(root: El, form: El): El[] {
  return all(root, (el) => CONTROL_TAGS.has(el.name)).filter((el) => ownerOf(root, el) === form);
}

/** The controls that submit the form: a button that is not `type="button"` or `reset`, and `input type=submit`. */
export function submitsOf(root: El, form: El): El[] {
  return controlsOf(root, form).filter((el) => {
    if (el.name === "button") {
      return !["button", "reset"].includes((attr(el, "type") ?? "submit").trim().toLowerCase());
    }
    return el.name === "input" && ["submit", "image"].includes(inputKind(el));
  });
}

/** The fields a person fills in or chooses: every control but the hidden ones and the buttons. */
export function fieldsOf(root: El, form: El): El[] {
  return controlsOf(root, form).filter(
    (el) =>
      el.name !== "button" &&
      !(
        el.name === "input" &&
        ["hidden", "submit", "button", "reset", "image"].includes(inputKind(el))
      ),
  );
}

/** The fields of a form that have no accessible name. */
export function unnamedFields(root: El, form: El): string[] {
  return fieldsOf(root, form)
    .filter((el) => accessibleName(root, el) === "")
    .map((el) => `<${el.name}${attr(el, "name") ? ` name=${attr(el, "name")}` : ""}>`);
}

/**
 * Whether a form can be sent by someone who uses only the keyboard, and if not, why. Some submit
 * control must take a tab stop, or sit inside a folded section whose heading takes one (Enter or
 * Space on the heading opens it). A form whose every submit is disabled passes only when each says
 * why (`aria-describedby` to text), as the start of a review does while a document is missing: it
 * cannot be sent, and the page says what to do first.
 */
export function submitProblem(root: El, form: El): string | null {
  const submits = submitsOf(root, form);
  if (submits.length === 0) return "it has no submit control";
  const stops = new Set(tabStops(root));
  const reachable = (submit: El): boolean => {
    if (stops.has(submit)) return true;
    // Inside a closed disclosure: reachable when its summary is, and the control is not disabled.
    if (hasAttr(submit, "disabled") || hasAttr(submit, "hidden")) return false;
    const folded = ancestorsOf(root, submit).filter(
      (el) => el.name === "details" && !hasAttr(el, "open"),
    );
    if (folded.length === 0) return false;
    return folded.every((details) => {
      const summary = details.children.find((c) => c.type === "element" && c.name === "summary");
      return summary !== undefined && stops.has(summary as El);
    });
  };
  if (submits.some(reachable)) return null;
  const explained = (submit: El): boolean => {
    const ids = (attr(submit, "aria-describedby") ?? "").split(/\s+/).filter((id) => id !== "");
    return (
      hasAttr(submit, "disabled") &&
      ids.length > 0 &&
      ids.every((id) => {
        const target = all(root, (el) => attr(el, "id") === id)[0];
        return target !== undefined && readable(target) !== "";
      })
    );
  };
  if (submits.every(explained)) return null;
  return "no submit control can be reached with the keyboard";
}
