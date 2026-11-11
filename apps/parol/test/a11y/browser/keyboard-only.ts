/**
 * Whether a browser test file is keyboard only. The flows (`flows.test.ts`) must be what a person
 * does with the keyboard alone: keys pressed, text typed, and nothing clicked, filled in, ticked,
 * chosen from a list by the pointer, hovered or dragged. Playwright has calls for all of those, and
 * a flow that used one would prove nothing about the keyboard. This reads a file as text and names
 * every call of that kind. Comments are not code and are left out first.
 *
 * The one allowed call that is not a key is `setInputFiles`, because a browser's file dialog cannot
 * be driven headless; each use must say so in a comment above it (`fileDialogGaps`).
 */

const MOUSE_CALLS = [
  ".click(",
  ".dblclick(",
  ".fill(",
  ".check(",
  ".uncheck(",
  ".setChecked(",
  ".selectOption(",
  ".hover(",
  ".tap(",
  ".dragTo(",
  ".dragAndDrop(",
  ".focus(",
  ".mouse",
  ".touchscreen",
];

/** The source with `//` and block comments taken out. Naive on purpose: the files are our own. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Every call a pointer or a script would make in a file meant to use the keyboard only, as `line: text`. */
export function mouseCallsIn(source: string): string[] {
  const out: string[] = [];
  withoutComments(source)
    .split("\n")
    .forEach((line, i) => {
      if (MOUSE_CALLS.some((call) => line.includes(call))) out.push(`${i + 1}: ${line.trim()}`);
    });
  return out;
}

/** The lines that call `setInputFiles` with no comment about the file dialog in the three lines above. */
export function fileDialogGaps(source: string): number[] {
  const lines = source.split("\n");
  const gaps: number[] = [];
  lines.forEach((line, i) => {
    if (!line.includes(".setInputFiles(") || line.trim().startsWith("//")) return;
    const above = lines.slice(Math.max(0, i - 3), i).join("\n");
    if (!/file dialog/i.test(above)) gaps.push(i + 1);
  });
  return gaps;
}
