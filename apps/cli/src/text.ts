// Playbook titles, file names, model errors and environment values are not trusted to stay on one
// line or to be free of terminal control codes. An escape sequence needs its escape character, so
// removing every control character defuses it, and the format characters go too because a
// right-to-left override makes a file name read as something else.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT = /\p{Cf}/gu;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of prose from an untrusted source: no control codes, no line breaks, no runs of space. */
export const plain = (value: string): string =>
  value.replace(CONTROL, " ").replace(FORMAT, "").replace(/\s+/g, " ").trim();

function escapeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : `\\u{${code.toString(16).padStart(4, "0")}}`;
}

/**
 * A file name or path for the terminal. Unlike plain() it keeps every ordinary character, so the
 * name can still be matched against the folder, and shows each control or format character as an
 * escape such as \x1b instead of acting on it.
 */
export const visible = (value: string): string => value.replace(UNSAFE, escapeChar);

/** Text that may span lines, such as a whole error message: visible() with the line breaks kept. */
export const safeBlock = (value: string): string =>
  value.replace(UNSAFE, (char) => (char === "\n" ? char : escapeChar(char)));

export const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

/** Rows of a name and a value, indented, with the values lined up. */
export function aligned(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`.trimEnd());
}
