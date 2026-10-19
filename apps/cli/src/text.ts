// Playbook titles and file names are not trusted to stay on one line or to be free of terminal
// control codes, so everything of theirs that reaches the terminal goes through plain().
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export const plain = (value: string): string =>
  value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

export const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

/** Rows of a name and a value, indented, with the values lined up. */
export function aligned(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`.trimEnd());
}
