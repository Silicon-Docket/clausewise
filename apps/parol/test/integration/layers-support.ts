import { all, attr, byTag, hasAttr, textOf, type El } from "../pages/html.js";

/**
 * Helpers for layers.test.ts: a stand-in for what a browser sends when a form is submitted, a
 * proxy that records which fields of a view model a page reads, and a small reader for a content
 * security policy. None of it is production code.
 */

// ---------------------------------------------------------------------------------------------
// A browser submitting a form
// ---------------------------------------------------------------------------------------------

export interface SubmitOptions {
  /**
   * Values the person typed or chose, by control name. A radio is picked by giving its value; a
   * text field, a text area or a select takes the value as given.
   */
  set?: Record<string, string>;
  /** The button that was pressed, when it carries a name and a value of its own. */
  submitter?: { name: string; value: string };
}

const isDisabled = (el: El): boolean => hasAttr(el, "disabled");

/** What a text area holds: the parser drops one line feed that directly follows the open tag. */
function textAreaValue(el: El): string {
  const text = textOf(el);
  return text.startsWith("\n") ? text.slice(1) : text;
}

/**
 * The name and value pairs a browser sends for the form, in document order. Disabled controls and
 * unchosen radios are left out, a select sends its chosen option (the first when none is marked),
 * and a text area is sent with CR LF line breaks, as every browser does.
 */
export function formFields(
  form: El,
  options: SubmitOptions = {},
  /** The page the form is in, for the controls that belong to it through their `form` attribute. */
  page?: El,
): [string, string][] {
  const set = options.set ?? {};
  const pairs: [string, string][] = [];
  const isControl = (el: El): boolean =>
    ["input", "select", "textarea", "button"].includes(el.name);
  const own = new Set(all(form, isControl));
  const id = attr(form, "id");
  const joined =
    page === undefined || id === undefined || id === null
      ? []
      : all(page, (el) => isControl(el) && attr(el, "form") === id);
  const controls =
    page === undefined ? [...own] : all(page, (el) => own.has(el) || joined.includes(el));
  for (const control of controls) {
    const name = attr(control, "name");
    if (name === undefined || name === null || name === "" || isDisabled(control)) continue;
    if (control.name === "button") {
      const pressed = options.submitter;
      if (
        pressed !== undefined &&
        pressed.name === name &&
        pressed.value === attr(control, "value")
      )
        pairs.push([name, pressed.value]);
      continue;
    }
    if (control.name === "textarea") {
      const value = Object.hasOwn(set, name) ? set[name]! : textAreaValue(control);
      pairs.push([name, value.replace(/\r\n|\r|\n/g, "\r\n")]);
      continue;
    }
    if (control.name === "select") {
      const options_ = byTag(control, "option");
      const wanted = Object.hasOwn(set, name) ? set[name] : undefined;
      const chosen =
        wanted !== undefined
          ? options_.find((o) => (attr(o, "value") ?? textOf(o)) === wanted)
          : (options_.find((o) => hasAttr(o, "selected")) ?? options_[0]);
      if (chosen === undefined) {
        if (wanted !== undefined) throw new Error(`the select ${name} has no option ${wanted}`);
        continue;
      }
      pairs.push([name, attr(chosen, "value") ?? textOf(chosen)]);
      continue;
    }
    const type = (attr(control, "type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset" || type === "image") continue;
    if (type === "file") continue;
    const value = attr(control, "value") ?? "";
    if (type === "radio") {
      if (set[name] === value) pairs.push([name, value]);
      else if (!Object.hasOwn(set, name) && hasAttr(control, "checked")) pairs.push([name, value]);
      continue;
    }
    if (type === "checkbox") {
      if (hasAttr(control, "checked") || set[name] === value) pairs.push([name, value]);
      continue;
    }
    pairs.push([name, Object.hasOwn(set, name) ? set[name]! : value]);
  }
  return pairs;
}

export function urlEncoded(pairs: [string, string][]): string {
  return new URLSearchParams(pairs).toString();
}

/** The one value posted under a name; throws if there are none or several. */
export function posted(pairs: [string, string][], name: string): string {
  const values = pairs.filter(([n]) => n === name).map(([, v]) => v);
  if (values.length !== 1) throw new Error(`${values.length} values posted for ${name}`);
  return values[0]!;
}

// ---------------------------------------------------------------------------------------------
// Which fields a page reads
// ---------------------------------------------------------------------------------------------

/** Property reads that rendering code and the JSX runtime make on any value, not on a field. */
const NOT_A_FIELD = new Set(["then", "toJSON", "constructor", "$$typeof", "nodeType", "valueOf"]);

/**
 * Optional view fields that a page already reads and whose service is a later package's (the
 * contract commit before phase 1 put the page's read in; the package fills the field). Listed by
 * path. An entry is inert once the service sets the field, because a field that is there is never
 * recorded as missing, so the package that fills it does not have to edit this list.
 */
const AWAITING_SERVICE = new Set(["$.retention"]);

/**
 * Wraps a view model so that every read of a property it does not have is recorded in `missing`
 * with its path. A page that reads a field the service never fills shows up here as `undefined`,
 * which the types would call impossible.
 */
export function watchReads<T extends object>(value: T, missing: Set<string>, path = "$"): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      const found = Reflect.get(target, key, receiver);
      const where = Array.isArray(target) ? `${path}[]` : `${path}.${key}`;
      if (found === undefined) {
        if (!NOT_A_FIELD.has(key) && !(key in target) && !AWAITING_SERVICE.has(where))
          missing.add(where);
        return found;
      }
      if (typeof found === "object" && found !== null) return watchReads(found, missing, where);
      return found;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Content security policy
// ---------------------------------------------------------------------------------------------

export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") directives.set(name, sources);
  }
  return directives;
}

/** The kinds of fetch a page can make, each with the directive that governs it. */
export type Fetch =
  | { directive: "script-src"; url: string }
  | { directive: "style-src"; url: string }
  | { directive: "img-src"; url: string }
  | { directive: "font-src"; url: string }
  | { directive: "connect-src"; url: string }
  | { directive: "form-action"; url: string }
  | { directive: "frame-src" | "object-src" | "media-src" | "child-src"; url: string }
  | { directive: "base-uri"; url: string };

/** What the markup of a page loads, posts to or runs. Inline script and style are `inline`. */
export interface PageUse {
  fetches: Fetch[];
  inline: string[];
}

const EVENT_ATTRIBUTE = /^on[a-z]+$/i;

export function usesOf(root: El): PageUse {
  const fetches: Fetch[] = [];
  const inline: string[] = [];
  for (const el of all(root)) {
    for (const a of el.attrs) {
      if (a.name === "style") inline.push(`style attribute on <${el.name}>`);
      if (EVENT_ATTRIBUTE.test(a.name)) inline.push(`${a.name} on <${el.name}>`);
    }
    const url = attr(el, "src") ?? attr(el, "href") ?? "";
    switch (el.name) {
      case "script":
        if (hasAttr(el, "src")) fetches.push({ directive: "script-src", url: attr(el, "src")! });
        else inline.push("inline script");
        break;
      case "style":
        inline.push("style element");
        break;
      case "link": {
        const rel = (attr(el, "rel") ?? "").toLowerCase();
        if (rel.split(/\s+/).includes("stylesheet"))
          fetches.push({ directive: "style-src", url: attr(el, "href") ?? "" });
        else if (rel !== "") fetches.push({ directive: "img-src", url: attr(el, "href") ?? "" });
        break;
      }
      case "img":
      case "image":
        fetches.push({ directive: "img-src", url });
        break;
      case "iframe":
      case "frame":
        fetches.push({ directive: "frame-src", url });
        break;
      case "object":
      case "embed":
        fetches.push({ directive: "object-src", url: attr(el, "data") ?? url });
        break;
      case "audio":
      case "video":
      case "source":
      case "track":
        fetches.push({ directive: "media-src", url });
        break;
      case "base":
        fetches.push({ directive: "base-uri", url: attr(el, "href") ?? "" });
        break;
      case "form":
        fetches.push({ directive: "form-action", url: attr(el, "action") ?? "" });
        break;
      default:
        break;
    }
  }
  return { fetches, inline };
}

/** Whether a policy lets a page make this fetch. Only `'self'` and `'none'` are understood. */
export function allowed(policy: Map<string, string[]>, use: Fetch): boolean {
  const own = policy.get(use.directive);
  const fallback = ["frame-src", "object-src", "media-src", "child-src"].includes(use.directive)
    ? (policy.get("child-src") ?? policy.get("default-src"))
    : policy.get("default-src");
  // form-action and base-uri do not fall back to default-src.
  const sources =
    use.directive === "form-action" || use.directive === "base-uri" ? own : (own ?? fallback);
  if (sources === undefined) return true;
  if (sources.length === 0 || (sources.length === 1 && sources[0] === "'none'")) return false;
  const sameOriginPath =
    use.url.startsWith("/") && !use.url.startsWith("//") && !use.url.includes("\\");
  return sources.some((source) => source === "'self'" && sameOriginPath);
}

/** The directives of a policy that name at least one source, which grant something. */
export function grantingDirectives(policy: Map<string, string[]>): string[] {
  return [...policy]
    .filter(([name, sources]) => sources.some((s) => s !== "'none'") && name !== "frame-ancestors")
    .map(([name]) => name);
}
