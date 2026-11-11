import { expect } from "vitest";
import { urls } from "../../src/server/urls.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { accessibleName, tabStops } from "../a11y/rules.js";
import { all, attr, byTag, hasAttr, parseHtml, readable, textOf, type El } from "../pages/html.js";

/**
 * A browser for the walk-through of the training exercise (package W2.8): cookies, forms posted
 * with the token, and a reader of pages that follows only what the page itself offers. Nothing here
 * builds a URL or a form body that the page did not give: a link is found by its words on the page
 * it is on, and a form is read from the page and filled in only in fields it has.
 *
 * Every link followed and every form submitted is also checked for the keyboard: the element must
 * be a Tab stop by the rules of test/a11y/rules.ts (a link with an address, a submit button, a
 * field or a summary, not disabled, not removed from the tab order, not inside a closed
 * disclosure), and every field that is filled in must have a name that a screen reader reads.
 */

export interface Fetched {
  response: Response;
  html: string;
  root: El;
  /** The words of the page between the tags, white space collapsed. */
  text: string;
  path: string;
}

/** One thing the walk did with a page, for the keyboard check at the end. */
export interface Used {
  kind: "link" | "button" | "field";
  /** The words of the link or button, or the label of the field. */
  what: string;
  path: string;
  /** Whether Tab reaches it. */
  stop: boolean;
  /** Whether it has a name a screen reader reads. */
  named: boolean;
  disabled: boolean;
  removedFromOrder: boolean;
}

export class Walker {
  private readonly jar = new Map<string, string>();
  /** Every page this walker fetched, in order, so that a test can search them all. */
  readonly pages: Fetched[] = [];
  readonly used: Used[] = [];
  /** Fields posted that the form on the page did not have (see `submit`), by name. */
  readonly unoffered: string[] = [];

  constructor(
    private readonly base: string,
    readonly name: string,
  ) {}

  private async raw(
    method: string,
    path: string,
    init: { form?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    const cookie = [...this.jar].map(([key, value]) => `${key}=${value}`).join("; ");
    if (cookie !== "") headers["cookie"] = cookie;
    let body: string | undefined;
    if (init.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const at = pair.indexOf("=");
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const gone = value === "" || attributes.some((a) => /^max-age=0$/i.test(a));
      if (gone) this.jar.delete(key);
      else this.jar.set(key, value);
    }
    return response;
  }

  /** The token of the session, from the session route the pages' own script reads. */
  private async token(): Promise<string> {
    const response = await this.raw("GET", "/api/session");
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  async signIn(userId: string): Promise<void> {
    const response = await this.raw("POST", urls.session(), {
      form: {
        _csrf: await this.token(),
        [FIELDS.intent]: "sign-in",
        [FIELDS.userId]: userId,
      },
    });
    expect(response.status, `${this.name} signs in`).toBe(303);
  }

  /** A page, fetched and read. `follow` lets a redirect be followed once, to the page it leads to. */
  async get(path: string, options: { follow?: boolean } = {}): Promise<Fetched> {
    let response = await this.raw("GET", path);
    let where = path;
    if (options.follow === true && response.status === 303) {
      where = response.headers.get("location") ?? path;
      response = await this.raw("GET", where);
    }
    return this.read(response, where);
  }

  private async read(response: Response, path: string): Promise<Fetched> {
    const html = await response.text();
    const isPage = (response.headers.get("content-type") ?? "").startsWith("text/html");
    const root = isPage ? parseHtml(html) : parseHtml("<p></p>");
    const fetched: Fetched = { response, html, root, text: readable(root), path };
    if (isPage) this.pages.push(fetched);
    return fetched;
  }

  /** The bytes of a file the page links to (the memo). */
  async file(path: string): Promise<Uint8Array> {
    const response = await this.raw("GET", path);
    expect(response.status, `${this.name} downloads ${path}`).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  // -------------------------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------------------------

  /** The link on the page with exactly these words, and a note that the walk used it. */
  link(page: Fetched, words: string): El {
    const found = all(
      page.root,
      (el) => el.name === "a" && hasAttr(el, "href") && readable(el) === words,
    );
    expect(found.length, `${this.name}: a link "${words}" on ${page.path}`).toBeGreaterThan(0);
    const el = found[0] as El;
    this.note(page, el, "link", words);
    return el;
  }

  /** Follows a link by its words: the address is read from the page. */
  async follow(page: Fetched, words: string): Promise<Fetched> {
    const href = attr(this.link(page, words), "href") as string;
    return this.get(href, { follow: true });
  }

  private note(page: Fetched, el: El, kind: Used["kind"], what: string): void {
    const stops = tabStops(page.root, { groupRadios: false });
    this.used.push({
      kind,
      what,
      path: page.path,
      stop: stops.includes(el),
      named: accessibleName(page.root, el).trim() !== "",
      disabled: hasAttr(el, "disabled") || attr(el, "aria-disabled") === "true",
      removedFromOrder: attr(el, "tabindex") === "-1",
    });
  }

  // -------------------------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------------------------

  /** The forms of the page whose action satisfies the test. */
  formsWhere(page: Fetched, test: (action: string) => boolean): El[] {
    return byTag(page.root, "form").filter((form) => test(attr(form, "action") ?? ""));
  }

  /** The one form of the page that posts to this action. */
  formTo(page: Fetched, action: string): El {
    const found = this.formsWhere(page, (a) => a === action);
    expect(found, `${this.name}: one form to ${action} on ${page.path}`).toHaveLength(1);
    return found[0] as El;
  }

  /** The controls that belong to a form: inside it, or tied to it with the `form` attribute. */
  controlsOf(page: Fetched, form: El): El[] {
    const id = attr(form, "id");
    const inside = new Set(all(form));
    return all(
      page.root,
      (el) =>
        ["input", "select", "textarea", "button"].includes(el.name) &&
        (inside.has(el) || (id !== undefined && id !== null && attr(el, "form") === id)),
    );
  }

  /** What the browser would send for a form as the page gives it, before the person types anything. */
  defaults(page: Fetched, form: El): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of this.controlsOf(page, form)) {
      const name = attr(el, "name");
      if (name === undefined || name === null || hasAttr(el, "disabled")) continue;
      if (el.name === "input") {
        const type = attr(el, "type") ?? "text";
        if (type === "submit" || type === "button") continue;
        if (type === "radio" || type === "checkbox") {
          if (hasAttr(el, "checked")) out[name] = attr(el, "value") ?? "on";
          continue;
        }
        out[name] = attr(el, "value") ?? "";
      } else if (el.name === "textarea") {
        out[name] = textOf(el).replace(/^\n/, "");
      } else if (el.name === "select") {
        const options = byTag(el, "option");
        const chosen = options.find((o) => hasAttr(o, "selected")) ?? options[0];
        if (chosen !== undefined) out[name] = attr(chosen, "value") ?? readable(chosen);
      }
    }
    return out;
  }

  /** The submit button of a form with these words. */
  button(page: Fetched, form: El, words: string): El {
    const found = this.controlsOf(page, form).filter(
      (el) => el.name === "button" && attr(el, "type") !== "button" && readable(el) === words,
    );
    expect(found.length, `${this.name}: a button "${words}" in the form on ${page.path}`).toBe(1);
    return found[0] as El;
  }

  /**
   * Fills the fields named in `set`, each of which must be a control of the form (a radio by its
   * value, a select by one of its options), presses the button with these words and returns the
   * answer. The token is the form's own hidden field. Any field the page's form carries that the
   * person did not touch is sent as the page had it, as a browser does.
   */
  async submit(
    page: Fetched,
    form: El,
    buttonWords: string,
    set: Record<string, string> = {},
    later: Record<string, string> = {},
  ): Promise<Response> {
    const controls = this.controlsOf(page, form);
    const body = this.defaults(page, form);
    // Fields a package that is not in this build adds to the page (the reason code of a rejection,
    // package W2.6a). A form that has the control is filled in like any other field. A form that
    // does not is sent the value all the same, so that the walk is the same before and after that
    // package lands, and the name is recorded so that a test can say which fields were not offered.
    for (const [name, value] of Object.entries(later)) {
      if (controls.some((el) => attr(el, "name") === name)) set = { ...set, [name]: value };
      else {
        body[name] = value;
        this.unoffered.push(name);
      }
    }
    for (const [name, value] of Object.entries(set)) {
      const named = controls.filter((el) => attr(el, "name") === name);
      expect(
        named.length,
        `${this.name}: the form on ${page.path} has a field "${name}"`,
      ).toBeGreaterThan(0);
      const type = attr(named[0] as El, "type");
      let control: El | undefined;
      if (type === "radio") {
        control = named.find((el) => attr(el, "value") === value);
      } else if ((named[0] as El).name === "select") {
        const option = byTag(named[0] as El, "option").find((o) => attr(o, "value") === value);
        expect(option, `${this.name}: option "${value}" of "${name}"`).toBeDefined();
        control = named[0];
      } else {
        control = named[0];
      }
      expect(
        control,
        `${this.name}: the control "${name}" = "${value}" on ${page.path}`,
      ).toBeDefined();
      this.note(page, control as El, "field", name);
      body[name] = value;
    }
    this.note(page, this.button(page, form, buttonWords), "button", buttonWords);
    const action = attr(form, "action") as string;
    return this.raw("POST", action, { form: body });
  }

  /** A post to an address read from a form, for a person who is not allowed: the token is the form's own. */
  async post(path: string, fields: Record<string, string>): Promise<Response> {
    return this.raw("POST", path, { form: { ...fields, _csrf: await this.token() } });
  }
}

/** What the walk used, as a list the keyboard check can count. */
export function unreachable(used: readonly Used[]): string[] {
  return used
    .filter((u) => !u.stop || !u.named || u.disabled || u.removedFromOrder)
    .map(
      (u) =>
        `${u.kind} "${u.what}" on ${u.path}: ${[
          u.stop ? "" : "not a Tab stop",
          u.named ? "" : "no name",
          u.disabled ? "disabled" : "",
          u.removedFromOrder ? "tabindex -1" : "",
        ]
          .filter(Boolean)
          .join(", ")}`,
    );
}
