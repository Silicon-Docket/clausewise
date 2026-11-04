/**
 * A strict HTML reader for page tests. It accepts only what Hono's renderer writes (double-quoted
 * or bare attributes, well-nested elements, text without a raw `<`) and throws on anything else, so
 * a page that let text become markup fails here: the stray `<` or the broken attribute cannot be
 * read as the page's own structure.
 */
export interface Attr {
  name: string;
  value: string | null;
}

export interface El {
  type: "element";
  name: string;
  attrs: Attr[];
  children: Node[];
}
export interface Text {
  type: "text";
  text: string;
}
export type Node = El | Text;

const VOID = new Set(["meta", "link", "input", "br", "hr", "img", "col", "area", "base", "wbr"]);
const NAME = /[A-Za-z][A-Za-z0-9-]*/y;

export function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return String.fromCodePoint(code);
  });
}

export function parseHtml(html: string): El {
  const root: El = { type: "element", name: "#root", attrs: [], children: [] };
  const stack: El[] = [root];
  let i = 0;
  const top = (): El => stack[stack.length - 1] as El;
  const fail = (why: string): never => {
    throw new Error(`strict HTML: ${why} at offset ${i}`);
  };

  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      const raw = html.slice(i, end);
      // Text runs up to the next "<", so a "<" cannot be inside it; a ">" would be unescaped text.
      if (raw.includes(">")) fail("raw angle bracket in text");
      top().children.push({ type: "text", text: decode(raw) });
      i = end;
      continue;
    }
    if (html.startsWith("<!--", i)) fail("comment");
    if (html.startsWith("<!", i)) {
      const end = html.indexOf(">", i);
      if (end === -1) fail("unterminated doctype");
      if (!/^<!doctype html>$/i.test(html.slice(i, end + 1))) fail("unexpected declaration");
      i = end + 1;
      continue;
    }
    if (html[i + 1] === "/") {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(html);
      if (m === null) return fail("bad end tag");
      const name = m[0].toLowerCase();
      let j = NAME.lastIndex;
      if (html[j] !== ">") fail("end tag with extra content");
      j += 1;
      const open = stack.pop();
      if (open === undefined || open.name !== name) fail(`mismatched end tag ${name}`);
      i = j;
      continue;
    }
    NAME.lastIndex = i + 1;
    const m = NAME.exec(html);
    if (m === null) return fail("bad start tag");
    const name = m[0].toLowerCase();
    const el: El = { type: "element", name, attrs: [], children: [] };
    let j = NAME.lastIndex;
    for (;;) {
      while (html[j] === " ") j += 1;
      if (html[j] === ">") {
        j += 1;
        break;
      }
      if (html[j] === "/" && html[j + 1] === ">") {
        j += 2;
        break;
      }
      NAME.lastIndex = j;
      const a = NAME.exec(html);
      if (a === null) return fail(`bad attribute in <${name}>`);
      j = NAME.lastIndex;
      if (html[j] === "=") {
        if (html[j + 1] !== '"') fail("attribute value not double quoted");
        const close = html.indexOf('"', j + 2);
        if (close === -1) fail("unterminated attribute value");
        const raw = html.slice(j + 2, close);
        if (raw.includes("<") || raw.includes(">")) fail("raw angle bracket in an attribute value");
        el.attrs.push({ name: a[0], value: decode(raw) });
        j = close + 1;
        if (html[j] !== " " && html[j] !== ">" && html[j] !== "/") fail("attribute run together");
      } else {
        el.attrs.push({ name: a[0], value: null });
      }
    }
    top().children.push(el);
    i = j;
    if (VOID.has(name)) continue;
    if (name === "script" || name === "style") {
      const close = html.indexOf(`</${name}>`, i);
      if (close === -1) fail(`unterminated ${name}`);
      const body = html.slice(i, close);
      if (body !== "") el.children.push({ type: "text", text: body });
      i = close + name.length + 3;
      continue;
    }
    stack.push(el);
  }
  if (stack.length !== 1) fail("unclosed element");
  return root;
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export function walk(node: Node, visit: (el: El) => void): void {
  if (node.type !== "element") return;
  if (node.name !== "#root") visit(node);
  for (const child of node.children) walk(child, visit);
}

export function all(root: El, predicate: (el: El) => boolean = () => true): El[] {
  const found: El[] = [];
  walk(root, (el) => {
    if (predicate(el)) found.push(el);
  });
  return found;
}

export const byTag = (root: El, name: string): El[] => all(root, (el) => el.name === name);

export function attr(el: El, name: string): string | null | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export const hasAttr = (el: El, name: string): boolean => el.attrs.some((a) => a.name === name);

export function classes(el: El): string[] {
  return (attr(el, "class") ?? "").split(/\s+/).filter((c) => c !== "");
}

export const hasClass = (el: El, name: string): boolean => classes(el).includes(name);

export function textOf(node: Node): string {
  if (node.type === "text") return node.text;
  return node.children.map(textOf).join("");
}

/** Visible text with runs of white space collapsed, the way a reader sees it. */
export const readable = (node: Node): string => textOf(node).replace(/\s+/g, " ").trim();

export function byId(root: El, id: string): El | undefined {
  return all(root, (el) => attr(el, "id") === id)[0];
}

export function ancestorsOf(root: El, target: El): El[] {
  const path: El[] = [];
  const search = (node: El): boolean => {
    if (node === target) return true;
    for (const child of node.children) {
      if (child.type === "element") {
        path.push(child);
        if (search(child)) return true;
        path.pop();
      }
    }
    return false;
  };
  return search(root) ? path.slice(0, -1) : [];
}

/** Tag names and attribute names in document order, ignoring every text and every value. */
export function signature(root: El): string {
  const out: string[] = [];
  walk(root, (el) => out.push(`${el.name}[${el.attrs.map((a) => a.name).join(",")}]`));
  return out.join(" ");
}

/** Every attribute value in the document, for scanning. */
export function attributeValues(root: El): { el: string; name: string; value: string }[] {
  const out: { el: string; name: string; value: string }[] = [];
  walk(root, (el) => {
    for (const a of el.attrs)
      if (a.value !== null) out.push({ el: el.name, name: a.name, value: a.value });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conveniences for assertions
// ---------------------------------------------------------------------------------------------

export function first(root: El, predicate: (el: El) => boolean, what = "element"): El {
  const found = all(root, predicate)[0];
  if (found === undefined) throw new Error(`no ${what} found`);
  return found;
}

export const forms = (root: El): El[] => byTag(root, "form");

export const formsTo = (root: El, action: string): El[] =>
  forms(root).filter((f) => attr(f, "action") === action);

export const controls = (root: El, name: string): El[] =>
  all(root, (el) => ["input", "select", "textarea"].includes(el.name) && attr(el, "name") === name);

export const withClass = (root: El, name: string): El[] => all(root, (el) => hasClass(el, name));

export const section = (root: El, id: string): El =>
  first(root, (el) => attr(el, "id") === id, `#${id}`);

export const buttonsNamed = (root: El, text: string): El[] =>
  byTag(root, "button").filter((b) => readable(b) === text);

/** The text of every element with the class, collapsed. */
export const textsOf = (root: El, className: string): string[] =>
  withClass(root, className).map((el) => readable(el));
