import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { parseHtml, type El, type Node } from "./html.js";

/**
 * Just enough of a browser to run public/parol.js against a page the application really rendered:
 * elements built from the page's HTML, the handful of selectors the script uses, event listeners
 * with bubbling to the document, timers that a test advances by hand, and a scripted fetch.
 */
export const SCRIPT_PATH = join(import.meta.dirname, "../../public/parol.js");

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: unknown;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  persisted?: boolean;
  shiftKey?: boolean;
  defaultPrevented: boolean;
  /** True once a listener stopped the event from reaching the listeners that come after it. */
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export function event(type: string, target: unknown, extra: Partial<FakeEvent> = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    stopImmediatePropagation() {
      e.stopped = true;
    },
    ...extra,
  };
  return e;
}

class Listeners {
  private map = new Map<string, Listener[]>();
  add(type: string, fn: Listener): void {
    this.map.set(type, [...(this.map.get(type) ?? []), fn]);
  }
  get(type: string): Listener[] {
    return this.map.get(type) ?? [];
  }
}

export class FakeElement {
  tagName: string;
  private attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private text: string | null = null;
  readonly listeners = new Listeners();
  readonly classes = new Set<string>();
  readonly calls = { focus: 0, click: 0, scroll: [] as unknown[] };
  disabled = false;
  open = false;
  value: unknown = "";
  max: unknown = "";
  isContentEditable = false;
  hidden = false;
  private doc: FakeDocument;
  /** Every property the script writes that the fake does not model, for assertions. */
  readonly written: Record<string, unknown> = {};

  constructor(doc: FakeDocument, node: El | null, tag = "div") {
    this.doc = doc;
    this.tagName = (node?.name ?? tag).toUpperCase();
    if (node !== null) {
      for (const a of node.attrs) this.attrs.set(a.name, a.value ?? "");
      const cls = this.attrs.get("class");
      if (cls) for (const c of cls.split(/\s+/)) if (c) this.classes.add(c);
      if (this.attrs.has("disabled")) this.disabled = true;
      if (this.attrs.has("open")) this.open = true;
      if (this.attrs.has("value")) this.value = this.attrs.get("value");
    }
  }

  get type(): string {
    return this.attrs.get("type") ?? (this.tagName === "BUTTON" ? "submit" : "text");
  }

  get classList() {
    const el = this;
    return {
      toggle(name: string, force?: boolean): boolean {
        const on = force ?? !el.classes.has(name);
        if (on) el.classes.add(name);
        else el.classes.delete(name);
        return on;
      },
      contains: (name: string): boolean => this.classes.has(name),
    };
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  /** Every attribute as set now, in name order, for a test that compares two states of a page. */
  attributeEntries(): [string, string][] {
    return [...this.attrs.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  get textContent(): string {
    if (this.text !== null) return this.text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    // Assigning text replaces the children, as it does in a browser, and never parses markup.
    this.children = [];
    this.text = String(value);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.add(type, fn);
  }
  focus(): void {
    this.calls.focus += 1;
    this.doc.activeElement = this;
  }
  click(): void {
    this.calls.click += 1;
  }
  scrollIntoView(options?: unknown): void {
    this.calls.scroll.push(options);
  }

  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      if (matches(el, selector)) return el;
    }
    return null;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.trim().split(/\s+/);
    const found = this.descendants().filter((el) => {
      if (!matches(el, parts[parts.length - 1] as string)) return false;
      // Descendant combinators: each earlier part must match some ancestor, in order.
      let at: FakeElement | null = el.parent;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        while (at !== null && !matches(at, parts[i] as string)) at = at.parent;
        if (at === null) return false;
        at = at.parent;
      }
      return true;
    });
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** The form controls of a form, including those tied to it by the form attribute. */
  get elements(): FakeElement[] {
    const id = this.attrs.get("id");
    return this.doc.root
      .descendants()
      .filter((el) => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName))
      .filter((el) =>
        el.getAttribute("form") !== null
          ? el.getAttribute("form") === id
          : el.closest("form") === this,
      );
  }

  /** Delivers an event to this element's listeners and then up to the document, as bubbling does. */
  dispatch(e: FakeEvent): void {
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      for (const fn of el.listeners.get(e.type)) fn(e);
      if (e.stopped) return;
    }
    for (const fn of this.doc.listeners.get(e.type)) fn(e);
  }
}

/** One compound selector: tag, #id is not used, .class, [attr], [attr="value"], in any mix. */
function matches(el: FakeElement, selector: string): boolean {
  const re = /^([a-zA-Z0-9]*)((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
  const m = re.exec(selector);
  if (m === null) throw new Error(`fake DOM does not support selector ${selector}`);
  const tag = m[1] ?? "";
  if (tag !== "" && el.tagName !== tag.toUpperCase()) return false;
  for (const part of (m[2] ?? "").match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? []) {
    if (part.startsWith(".")) {
      if (!el.classes.has(part.slice(1))) return false;
    } else {
      const [name, value] = part.slice(1, -1).split(/=(.*)/s);
      if (!el.hasAttribute(name as string)) return false;
      if (value !== undefined && el.getAttribute(name as string) !== value.slice(1, -1))
        return false;
    }
  }
  return true;
}

export class FakeDocument {
  readonly listeners = new Listeners();
  readonly root: FakeElement;
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  activeElement: FakeElement | null = null;
  hidden = false;
  readyState = "complete";

  constructor(html: string) {
    const tree = parseHtml(html);
    this.root = new FakeElement(this, null, "#root");
    const build = (node: Node, parent: FakeElement): void => {
      if (node.type === "text") {
        // Text is read back through the parent, which is all the script needs.
        const holder = new FakeElement(this, null, "#text");
        holder.textContent = node.text;
        holder.parent = parent;
        parent.children.push(holder);
        return;
      }
      const el = new FakeElement(this, node);
      el.parent = parent;
      parent.children.push(el);
      for (const child of node.children) build(child, el);
    };
    for (const child of tree.children) build(child, this.root);
    this.documentElement = this.root.querySelector("html") ?? this.root;
    this.body = this.root.querySelector("body") ?? this.root;
    this.activeElement = this.body;
  }

  querySelector(selector: string): FakeElement | null {
    return this.root.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.root.querySelectorAll(selector);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.add(type, fn);
  }
}

export interface Timer {
  at: number;
  fn: () => void;
}

export interface FetchCall {
  url: string;
  init: Record<string, unknown>;
}

export interface Harness {
  doc: FakeDocument;
  fetchCalls: FetchCall[];
  reloads: number;
  storage: Map<string, string>;
  timers: Timer[];
  windowListeners: Listeners;
  now: number;
  reducedMotion: boolean;
  /** Runs timers due within `ms` of fake time, and lets promises settle between them. */
  advance(ms: number): Promise<void>;
  /** The next fetch answers with this. */
  respondWith(next: () => Promise<{ ok: boolean; json(): Promise<unknown> }>): void;
  pageshow(persisted: boolean): void;
}

export interface HarnessOptions {
  reducedMotion?: boolean;
  noFetch?: boolean;
  storageBlocked?: boolean;
  /** The fragment of the address as `location.hash` has it: "" for none, "#decision" for one. */
  hash?: string;
  /** Runs on the document before the script does: to put focus somewhere, say. */
  before?: (doc: FakeDocument) => void;
}

export function runScript(html: string, options: HarnessOptions = {}): Harness {
  const doc = new FakeDocument(html);
  options.before?.(doc);
  const windowListeners = new Listeners();
  const h: Harness = {
    doc,
    fetchCalls: [],
    reloads: 0,
    storage: new Map(),
    timers: [],
    windowListeners,
    now: 1_000_000,
    reducedMotion: options.reducedMotion ?? false,
    async advance(ms) {
      const until = h.now + ms;
      for (;;) {
        const due = h.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        h.timers.splice(h.timers.indexOf(due), 1);
        h.now = Math.max(h.now, due.at);
        due.fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      h.now = until;
    },
    respondWith(next) {
      responder = next;
    },
    pageshow(persisted) {
      for (const fn of windowListeners.get("pageshow")) fn(event("pageshow", null, { persisted }));
    },
  };
  let responder: () => Promise<{ ok: boolean; json(): Promise<unknown> }> = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

  const sandbox: Record<string, unknown> = {
    document: doc,
    setTimeout(fn: () => void, delay: number) {
      h.timers.push({ at: h.now + delay, fn });
      return h.timers.length;
    },
    matchMedia: () => ({ matches: h.reducedMotion }),
    addEventListener: (type: string, fn: Listener) => windowListeners.add(type, fn),
    sessionStorage: options.storageBlocked
      ? {
          getItem() {
            throw new Error("blocked");
          },
          setItem() {
            throw new Error("blocked");
          },
        }
      : {
          getItem: (k: string) => h.storage.get(k) ?? null,
          setItem: (k: string, v: string) => void h.storage.set(k, v),
        },
    location: {
      hash: options.hash ?? "",
      reload() {
        h.reloads += 1;
      },
    },
    Date: { now: () => h.now },
    Number,
    String,
    Array,
    Math,
    Error,
    Promise,
  };
  if (!options.noFetch) {
    sandbox.fetch = (url: string, init: Record<string, unknown>) => {
      h.fetchCalls.push({ url, init });
      return responder();
    };
  }
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(SCRIPT_PATH, "utf8"), sandbox, { filename: "parol.js" });
  return h;
}
