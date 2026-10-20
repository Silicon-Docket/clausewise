// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Two rules of the style sheets that the end to end tests found missing in a real browser (jsdom
 * does not read style sheets, so nothing else here would notice): the grey of a placeholder, and a
 * header that wraps. Each one is read from the files, so a change that drops it fails here before a
 * browser is needed.
 */

const styles = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const read = (name: string): string => readFileSync(join(styles, name), "utf8");

type Tokens = Record<string, string>;

function declarations(block: string): Tokens {
  const found: Tokens = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found[match[1] ?? ""] = (match[2] ?? "").trim();
  }
  return found;
}

/** The custom properties of the light theme and, laid over them, those of the dark one. */
function themes(): { light: Tokens; dark: Tokens } {
  const css = read("tokens.css");
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  expect(darkStart).toBeGreaterThan(0);
  const light = declarations(css.slice(0, darkStart));
  return { light, dark: { ...light, ...declarations(css.slice(darkStart)) } };
}

function luminance(hex: string): number {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `a rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("the placeholder of a text box", () => {
  it("is drawn in the muted text colour at full strength, not in the browser's own grey", () => {
    const body = rule(read("components.css"), ".input::placeholder");
    expect(body).toMatch(/color:\s*var\(--ink-muted\)/);
    // Firefox fades a placeholder unless told not to, and a faded one is under the line again.
    expect(body).toMatch(/opacity:\s*1\s*;/);
  });

  it("has 4.5 to 1 against the surface of a text box in both themes", () => {
    const { light, dark } = themes();
    for (const [name, theme] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ink = theme["--ink-muted"] ?? "";
      const surface = theme["--surface"] ?? "";
      expect(contrast(ink, surface), `${name}: ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    // The text box itself is on the surface colour.
    expect(rule(read("components.css"), ".input")).toMatch(/background:\s*var\(--surface\)/);
  });
});

describe("the header", () => {
  it("lets its links wrap, so that they fit a window of 320 pixels at a text size of 200 percent", () => {
    const body = rule(read("base.css"), ".site-nav");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });
});
