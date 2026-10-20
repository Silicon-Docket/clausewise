/**
 * Checks that run inside the page, for `page.evaluate`. Each function is serialised and sent to
 * the browser, so it uses nothing from outside itself: no imports, no helpers defined elsewhere.
 * The numbers come from computed styles, which is what the person looking at the screen gets.
 */

export type TextKind =
  "body" | "muted" | "heading" | "link" | "button" | "badge" | "diff" | "field" | "placeholder";

export interface TextSample {
  /** The element, as a short description a person can find: tag, id, classes, and its first words. */
  where: string;
  kind: TextKind;
  ratio: number;
  foreground: string;
  background: string;
  fontPx: number;
}

export interface TargetProblem {
  where: string;
  width: number;
  height: number;
  /** Why this is a problem: too small and no exception applies. */
  why: string;
}

export interface AuditResult {
  /** The width of the page's content and of the window, in CSS pixels. */
  scrollWidth: number;
  innerWidth: number;
  /** Elements that stick out of the window on the left or the right and do not scroll themselves. */
  overflowing: string[];
  /** Boxes that cut their own content off at the side: part of what they hold can not be read. */
  clipped: string[];
  /** Every piece of text that was measured. */
  texts: TextSample[];
  /** Text that could not be measured, such as text on a picture. */
  unmeasured: string[];
  targets: number;
  targetProblems: TargetProblem[];
  /** Disabled controls, which WCAG leaves out of both checks. */
  skippedDisabled: number;
}

export function auditPage(): AuditResult {
  interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  const parse = (value: string): Rgba | null => {
    const text = value.trim();
    if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const legacy =
      /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(text);
    if (legacy !== null) {
      const alpha =
        legacy[4] === undefined
          ? 1
          : legacy[5] === "%"
            ? Number(legacy[4]) / 100
            : Number(legacy[4]);
      return { r: Number(legacy[1]), g: Number(legacy[2]), b: Number(legacy[3]), a: alpha };
    }
    const modern =
      /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(text);
    if (modern !== null) {
      const alpha =
        modern[4] === undefined
          ? 1
          : modern[5] === "%"
            ? Number(modern[4]) / 100
            : Number(modern[4]);
      return {
        r: Number(modern[1]) * 255,
        g: Number(modern[2]) * 255,
        b: Number(modern[3]) * 255,
        a: alpha,
      };
    }
    return null;
  };

  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };

  const luminance = (c: Rgba): number => {
    const channel = (value: number): number => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };

  const contrast = (a: Rgba, b: Rgba): number => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const describe = (el: Element): string => {
    const id = el.id === "" ? "" : `#${el.id}`;
    const classes =
      typeof el.className === "string" && el.className.trim() !== ""
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const words = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${classes} "${words}"`;
  };

  const rgb = (c: Rgba): string =>
    `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

  // The canvas is dark only when the page says it supports a dark scheme and the person prefers one.
  const declared = getComputedStyle(document.documentElement).colorScheme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = declared.includes("dark") && (prefersDark || !declared.includes("light"));
  const canvas: Rgba = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };

  /** The colour behind an element: its ancestors' backgrounds laid over each other, top last. */
  const backgroundOf = (el: Element): Rgba | string => {
    const layers: Rgba[] = [];
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return `a background image on ${describe(node)}`;
      const color = parse(style.backgroundColor);
      if (color === null) return `a background colour that is not understood on ${describe(node)}`;
      if (color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let result = canvas;
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (layer !== undefined) result = over(layer, result);
    }
    return result;
  };

  /** How see-through the element is as a whole, from its own opacity and its ancestors'. */
  const opacityOf = (el: Element): number => {
    let opacity = 1;
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  };

  const isShown = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility !== "visible") return false;
    const rect = el.getBoundingClientRect();
    // The visually hidden class is one pixel square; a person sees nothing there.
    return rect.width >= 2 && rect.height >= 2;
  };

  const kindOf = (el: Element): TextKind => {
    if (el.closest("del, ins")) return "diff";
    if (el.closest("a")) return "link";
    if (el.closest("button, .button, .link-button")) return "button";
    if (el.closest(".severity, .decision, .status, .count, .severity-heading")) return "badge";
    if (
      el.closest(
        ".muted, .hint, .meta, .lead, .empty, .site-footer, .diff-note, .diff-legend, .progress-text, .field-label",
      )
    ) {
      return "muted";
    }
    if (/^h[1-6]$/i.test(el.tagName)) return "heading";
    return "body";
  };

  const texts: TextSample[] = [];
  const unmeasured: string[] = [];
  let skippedDisabled = 0;

  const measure = (el: Element, foreground: string, kind: TextKind): void => {
    const color = parse(foreground);
    const background = backgroundOf(el);
    if (color === null || typeof background === "string") {
      unmeasured.push(typeof background === "string" ? background : `${describe(el)}: colour`);
      return;
    }
    const opacity = opacityOf(el);
    const effective = over({ ...color, a: color.a * opacity }, background);
    texts.push({
      where: describe(el),
      kind,
      ratio: contrast(effective, background),
      foreground: rgb(effective),
      background: rgb(background),
      fontPx: Number.parseFloat(getComputedStyle(el).fontSize),
    });
  };

  for (const el of document.body.querySelectorAll("*")) {
    if (/^(script|style|noscript|option|optgroup|svg|path|progress)$/i.test(el.tagName)) continue;
    if (el.closest("svg")) continue;
    if (!isShown(el)) continue;

    const control = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const field =
      (el instanceof HTMLInputElement &&
        !["hidden", "file", "checkbox", "radio"].includes(el.type)) ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;
    // An inactive control, disabled or marked aria-disabled, has no contrast to keep (WCAG 1.4.3).
    const inactive = el.closest(':disabled, [aria-disabled="true"]') !== null;
    const ownText = [...el.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ""),
    );
    if (inactive) {
      if (ownText || field) skippedDisabled += 1;
      continue;
    }
    if (field) {
      measure(el, getComputedStyle(el).color, "field");
      if (
        control &&
        (el as HTMLInputElement).placeholder !== "" &&
        (el as HTMLInputElement).value === ""
      ) {
        measure(el, getComputedStyle(el, "::placeholder").color, "placeholder");
      }
      continue;
    }
    if (!ownText) continue;
    measure(el, getComputedStyle(el).color, kindOf(el));
  }

  // Targets -------------------------------------------------------------------------------------

  interface Target {
    el: Element;
    rect: DOMRect;
  }
  const targets: Target[] = [];
  const selector =
    'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, label.button';
  for (const el of document.body.querySelectorAll(selector)) {
    if (!isShown(el)) continue;
    if (el.closest(':disabled, [aria-disabled="true"]') !== null) continue;
    targets.push({ el, rect: el.getBoundingClientRect() });
  }

  const MIN = 24;
  const circle = (r: DOMRect): { x: number; y: number } => ({
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  });
  // The nearest edge of a box to a point, which is how far a circle around the point reaches it.
  const distanceToBox = (point: { x: number; y: number }, r: DOMRect): number => {
    const dx = Math.max(r.left - point.x, 0, point.x - r.right);
    const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
    return Math.hypot(dx, dy);
  };

  const targetProblems: TargetProblem[] = [];
  for (const target of targets) {
    const { el, rect } = target;
    if (rect.width >= MIN - 0.5 && rect.height >= MIN - 0.5) continue;
    const tag = el.tagName.toLowerCase();

    // A link inside a sentence is as big as the line it is in.
    if (tag === "a" && getComputedStyle(el).display === "inline") {
      const block = el.parentElement;
      const around = (block?.textContent ?? "").replace(/\s+/g, " ").trim();
      const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (around.length > own.length) continue;
    }

    // A small target is allowed when no other target is within reach of a 24 pixel circle around it.
    const middle = circle(rect);
    const radius = MIN / 2;
    const crowded = targets.some((other) => {
      if (other.el === el || other.el.contains(el) || el.contains(other.el)) return false;
      const otherSmall = other.rect.width < MIN - 0.5 || other.rect.height < MIN - 0.5;
      if (!otherSmall) return distanceToBox(middle, other.rect) < radius;
      const centre = circle(other.rect);
      return Math.hypot(centre.x - middle.x, centre.y - middle.y) < MIN;
    });
    // A button gets no exception: the plain rule is easier to keep.
    if (!crowded && tag !== "button") continue;

    targetProblems.push({
      where: describe(el),
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      why:
        tag === "button"
          ? "a button is smaller than 24 by 24 CSS pixels"
          : "smaller than 24 by 24 CSS pixels with another target within 24 pixels",
    });
  }

  // Overflow ------------------------------------------------------------------------------------

  const overflowing: string[] = [];
  const width = window.innerWidth;
  for (const el of document.body.querySelectorAll("*")) {
    if (overflowing.length >= 8) break;
    if (!isShown(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.right <= width + 0.5 && rect.left >= -0.5) continue;
    if (el.classList.contains("skip-link")) continue;
    // Something inside a box that scrolls on its own is reached by scrolling that box.
    let scrolls = false;
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
        scrolls = true;
        break;
      }
    }
    if (!scrolls)
      overflowing.push(`${describe(el)} (${Math.round(rect.left)} to ${Math.round(rect.right)})`);
  }

  const clipped: string[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (clipped.length >= 8) break;
    if (!isShown(el)) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
    if (el.scrollWidth > el.clientWidth + 1 && /\S/.test(el.textContent ?? "")) {
      clipped.push(`${describe(el)} (${el.scrollWidth} wide in ${el.clientWidth})`);
    }
  }

  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowing,
    clipped,
    texts,
    unmeasured,
    targets: targets.length,
    targetProblems,
    skippedDisabled,
  };
}

export interface CoverProblem {
  where: string;
  coveredBy: string;
}

/**
 * Scrolls to each control and asks the browser what is at its middle: if it is not the control
 * itself, something sits on top of it (a header that sticks, a message, a dialog).
 */
export function coveredControls(): CoverProblem[] {
  const problems: CoverProblem[] = [];
  const selector =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, label.button';
  const name = (el: Element): string =>
    `${el.tagName.toLowerCase()} "${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;
  for (const el of document.body.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility !== "visible") continue;
    if (rect.width < 2 || rect.height < 2) continue;
    if ((el as HTMLButtonElement).disabled === true) continue;
    if (el.classList.contains("skip-link")) continue;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const after = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      after.left + after.width / 2,
      after.top + after.height / 2,
    );
    // A label is reached through its control and the other way round.
    const same =
      hit !== null &&
      (el === hit ||
        el.contains(hit) ||
        hit.contains(el) ||
        (el as HTMLLabelElement).control === hit);
    if (!same) problems.push({ where: name(el), coveredBy: hit === null ? "nothing" : name(hit) });
  }
  return problems;
}
