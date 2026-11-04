import { normalizeForAnchor } from "@clausewise/review";
import { clip } from "./text.js";

/**
 * The figures in a piece of text that the consistency check compares: durations, percentages,
 * dollar amounts and jurisdictions. Each comes out as a key that is the same however the figure
 * was written, plus a short label for a detail line.
 *
 * What it normalises:
 *  - number words and digits are the same number: "three", "3", "thirty-six", "36",
 *    "one hundred and twenty", "120", "1,500", "1.5";
 *  - a number followed by the same number in brackets, in words or in digits, is read once:
 *    "three (3) years", "ten (10) business days", "7 (seven) years", "3(three) years". If the two
 *    disagree, both are kept, so a quote that says "two (3) years" or "3 (two) years" supports
 *    either;
 *  - durations are compared by length: 1 year is 12 months and 1 week is 7 days, so "36 months"
 *    and "three (3) years" are the same duration, and "a 3-year term" is read as "3 years";
 *  - "business days" and "working days" are their own unit. A finding that says "10 days" is
 *    supported by "10 days" or by "10 business days", and a finding that says "10 business days"
 *    only by "10 business days";
 *  - a percentage is a number with %, "percent", "per cent" or "percentage"; an amount is a number
 *    after $ or USD, or before "dollars" or "USD", with thousand, million or billion (k, m, bn);
 *  - a jurisdiction is a name on the fixed list below, matched whole-word and case-insensitively,
 *    with "&" read as "and". A quote naming "England and Wales" also supports "England" or "Wales".
 *
 * What it does not handle:
 *  - a month is not converted into days or weeks, and a period is not turned into a date;
 *  - "a year", "an hour" and other article forms; fractions in words ("one and a half years");
 *    ordinals ("the third anniversary"); ranges, where only the number next to the unit is read
 *    ("three to five years" reads as 5 years);
 *  - currencies other than dollars; words for amounts other than numbers ("one million" is read,
 *    "a million" is not);
 *  - adjectives for a place ("English law", "Delaware-based"), places not on the list, and a name
 *    that is also a common word.
 * A miss on the claim side (a figure in the discrepancy or the explanation that is not read) makes
 * the check less strict. A miss on the quote side (a figure in a form that is not read) can make a
 * correct claim fail, because the figure is then in no quote: that is a false alarm, an escalation
 * that names the figure, and not a wrong "verified". The forms above are the ones to add to when one
 * is found in the documents.
 */

export interface Fact {
  /** Equal for equal figures however they were written. */
  key: string;
  /** A short form for a detail line: "3 years", "5%", "$500,000", "Delaware". */
  label: string;
}

/** Text past this is not scanned: a discrepancy of this size is not a discrepancy. */
const SCAN_LIMIT = 100_000;

/**
 * Places a playbook or an NDA is likely to name for governing law or forum. A closed list, so a
 * capitalised word is never taken for a place by guess. Names that are also common first names or
 * words (Georgia, Washington, Victoria, Virginia) are left out on purpose.
 */
export const JURISDICTIONS: readonly string[] = [
  "Delaware",
  "New York",
  "California",
  "Texas",
  "Illinois",
  "Massachusetts",
  "England and Wales",
  "England",
  "Wales",
  "Scotland",
  "Northern Ireland",
  "Ireland",
  "Ontario",
  "British Columbia",
  "Alberta",
  "Quebec",
  "Canada",
  "Singapore",
  "Hong Kong",
  "Florida",
  "Nevada",
  "Colorado",
  "Pennsylvania",
  "New Jersey",
  "Ohio",
  "Michigan",
  "Minnesota",
  "Maryland",
  "Arizona",
  "North Carolina",
  "Oregon",
  "Utah",
  "United Kingdom",
  "Australia",
  "New South Wales",
  "Germany",
  "France",
  "Netherlands",
  "Switzerland",
  "Japan",
  "India",
  "China",
  "Luxembourg",
  "Cayman Islands",
  "British Virgin Islands",
  "Dubai",
];

const NAME_BY_FOLDED = new Map(JURISDICTIONS.map((name) => [name.toLowerCase(), name]));

const JURISDICTION_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...JURISDICTIONS]
    // Longest first, so "England and Wales" is one place and not "England" and "Wales".
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/ /g, "\\s+"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

interface Tok {
  kind: "word" | "num" | "sym";
  /** Lower case for a word, stripped of a trailing apostrophe or 's. */
  text: string;
  start: number;
  end: number;
  value: number;
}

// A number with thousands separators is tried first, so "1,500" is one number and "4, 30" is two.
const TOKEN = /\p{L}[\p{L}\p{M}']*|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[$%()]/gu;

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const first = raw.charCodeAt(0);
    if (first >= 0x30 && first <= 0x39) {
      out.push({ kind: "num", text: raw, start, end, value: Number(raw.replace(/,/g, "")) });
    } else if (raw === "$" || raw === "%" || raw === "(" || raw === ")") {
      out.push({ kind: "sym", text: raw, start, end, value: 0 });
    } else {
      out.push({
        kind: "word",
        text: raw.toLowerCase().replace(/'s$/, "").replace(/'+$/, ""),
        start,
        end,
        value: 0,
      });
    }
  }
  return out;
}

const SPACE_OR_HYPHEN = /^[\s-]*$/;
const SPACE_ONLY = /^\s*$/;

const gapBetween = (text: string, a: Tok, b: Tok): string => text.slice(a.end, b.start);

// ---------------------------------------------------------------------------------------------
// Numbers written in words
// ---------------------------------------------------------------------------------------------

const UNIT_WORDS = new Map<string, number>(
  Object.entries({
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  }),
);
const TEEN_WORDS = new Map<string, number>(
  Object.entries({
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  }),
);
const TENS_WORDS = new Map<string, number>(
  Object.entries({
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  }),
);
const SCALE_WORDS = new Map<string, number>(
  Object.entries({ thousand: 1e3, million: 1e6, billion: 1e9 }),
);

type Kind = "start" | "unit" | "teen" | "tens" | "hundred" | "scale";

const kindOfWord = (w: string): Exclude<Kind, "start"> | "zero" | null => {
  if (w === "zero") return "zero";
  if (UNIT_WORDS.has(w)) return "unit";
  if (TEEN_WORDS.has(w)) return "teen";
  if (TENS_WORDS.has(w)) return "tens";
  if (w === "hundred") return "hundred";
  if (SCALE_WORDS.has(w)) return "scale";
  return null;
};

// Which kind of word may follow which. "twenty one" and "one hundred twenty" read as one number;
// "five ten" and "twenty thirty" do not, and are read as two.
const MAY_FOLLOW: Record<Exclude<Kind, "start">, readonly Kind[]> = {
  unit: ["start", "tens", "hundred", "scale"],
  teen: ["start", "hundred", "scale"],
  tens: ["start", "hundred", "scale"],
  hundred: ["start", "unit", "teen"],
  scale: ["start", "unit", "teen", "tens", "hundred"],
};

const valueOfWord = (w: string): number =>
  UNIT_WORDS.get(w) ?? TEEN_WORDS.get(w) ?? TENS_WORDS.get(w) ?? SCALE_WORDS.get(w) ?? 0;

function readNumber(toks: Tok[], i: number, text: string): { value: number; next: number } | null {
  const first = toks[i];
  if (first === undefined) return null;
  if (first.kind === "num") return { value: first.value, next: i + 1 };
  if (first.kind !== "word" || kindOfWord(first.text) === null) return null;

  let total = 0;
  let current = 0;
  let last: Kind = "start";
  let accepted = i;
  for (let j = i; j < toks.length; j++) {
    const tok = toks[j]!;
    if (j > i && !SPACE_OR_HYPHEN.test(gapBetween(text, toks[j - 1]!, tok))) break;
    if (tok.kind !== "word") break;
    let w = tok.text;
    let at = j;
    // "one hundred and twenty": the "and" is part of the number only before another number word.
    if (w === "and" && (last === "hundred" || last === "scale")) {
      const after = toks[j + 1];
      const afterKind = after?.kind === "word" ? kindOfWord(after.text) : null;
      if (
        after === undefined ||
        (afterKind !== "unit" && afterKind !== "teen" && afterKind !== "tens") ||
        !SPACE_OR_HYPHEN.test(gapBetween(text, tok, after))
      ) {
        break;
      }
      w = after.text;
      at = j + 1;
    }
    const kind = kindOfWord(w);
    if (kind === null) break;
    if (kind === "zero") {
      if (last !== "start") break;
      accepted = at + 1;
      last = "unit";
      j = at;
      break;
    }
    if (!MAY_FOLLOW[kind].includes(last)) break;
    const v = valueOfWord(w);
    if (kind === "hundred") current = (current === 0 ? 1 : current) * 100;
    else if (kind === "scale") {
      total += (current === 0 ? 1 : current) * v;
      current = 0;
    } else current += v;
    last = kind;
    accepted = at + 1;
    j = at;
  }
  if (accepted === i && last === "start") return null;
  return { value: total + current, next: accepted };
}

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

type DurationUnit = "year" | "month" | "week" | "day" | "business_day";

const PLAIN_UNITS: ReadonlyMap<string, DurationUnit> = new Map([
  ["year", "year"],
  ["years", "year"],
  ["month", "month"],
  ["months", "month"],
  ["week", "week"],
  ["weeks", "week"],
  ["day", "day"],
  ["days", "day"],
]);

function readUnit(toks: Tok[], j: number, text: string): DurationUnit | null {
  const tok = toks[j];
  if (tok === undefined || tok.kind !== "word") return null;
  const next = toks[j + 1];
  const joined =
    next !== undefined && next.kind === "word" && SPACE_ONLY.test(gapBetween(text, tok, next));
  if ((tok.text === "business" || tok.text === "working") && joined) {
    return next.text === "day" || next.text === "days" ? "business_day" : null;
  }
  if (tok.text === "calendar" && joined) return PLAIN_UNITS.get(next.text) ?? null;
  return PLAIN_UNITS.get(tok.text) ?? null;
}

// Rounded so that 1.1 years does not become 13.200000000000001 months.
const round = (value: number): number => Math.round(value * 1000) / 1000;

const plain = (value: number): string => String(round(value));

// Thousands separators and at most two decimals, written by hand so that no locale is involved.
const withCommas = (value: number): string => {
  const [whole = "0", fraction] = round(value)
    .toFixed(Number.isInteger(round(value)) ? 0 : 2)
    .split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};

function durationFact(value: number, unit: DurationUnit): Fact {
  const words = unit === "business_day" ? "business day" : unit;
  const label = `${plain(value)} ${words}${value === 1 ? "" : "s"}`;
  switch (unit) {
    case "year":
      return { key: `dur:month:${plain(value * 12)}`, label };
    case "month":
      return { key: `dur:month:${plain(value)}`, label };
    case "week":
      return { key: `dur:day:${plain(value * 7)}`, label };
    case "day":
      return { key: `dur:day:${plain(value)}`, label };
    case "business_day":
      return { key: `dur:bday:${plain(value)}`, label };
  }
}

const moneyFact = (amount: number): Fact => ({
  key: `usd:${Math.round(amount * 100)}`,
  label: `$${withCommas(amount)}`,
});

const percentFact = (value: number): Fact => ({
  key: `pct:${plain(value)}`,
  label: `${plain(value)}%`,
});

const SHORT_SCALES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1e3],
  ["k", 1e3],
  ["million", 1e6],
  ["m", 1e6],
  ["mm", 1e6],
  ["mn", 1e6],
  ["billion", 1e9],
  ["bn", 1e9],
]);

const DOLLAR_WORDS = new Set(["dollar", "dollars", "usd"]);

function pushUnique(out: Fact[], seen: Set<string>, fact: Fact): void {
  if (seen.has(fact.key)) return;
  seen.add(fact.key);
  out.push(fact);
}

function numericFacts(text: string, out: Fact[], seen: Set<string>): void {
  const toks = tokenize(text);
  let i = 0;
  while (i < toks.length) {
    const read = readNumber(toks, i, text);
    if (read === null) {
      i++;
      continue;
    }
    let j = read.next;
    const values = [read.value];
    // "three (3) years" and "3 (three) years": what is in the brackets repeats the number and is
    // read as the same number. Brackets that hold anything else are not a repeat and are left.
    const open = toks[j];
    if (open?.text === "(" && SPACE_ONLY.test(gapBetween(text, toks[j - 1]!, open))) {
      const repeat = readNumber(toks, j + 1, text);
      if (repeat !== null && toks[repeat.next]?.text === ")") {
        if (repeat.value !== read.value) values.push(repeat.value);
        j = repeat.next + 1;
      }
    }

    const before = toks[i - 1];
    const after = toks[j];
    const adjacentBefore =
      before !== undefined && SPACE_ONLY.test(gapBetween(text, before, toks[i]!));
    const adjacentAfter =
      after !== undefined && SPACE_ONLY.test(gapBetween(text, toks[j - 1]!, after));

    // Money first: "$5,000", "USD 5,000", "5,000 dollars", "$1.5 million", "five hundred dollars".
    const dollarSign = adjacentBefore && before?.text === "$";
    const usdBefore = adjacentBefore && before?.kind === "word" && before.text === "usd";
    let amount = values[0]!;
    let k = j;
    const scale =
      after?.kind === "word" && adjacentAfter ? SHORT_SCALES.get(after.text) : undefined;
    // A scale word after digits ("1.5 million"); a number written in words took its own.
    const scaled = toks[i]!.kind === "num" && scale !== undefined;
    if (scaled) {
      amount *= scale;
      k = j + 1;
    }
    const dollarWord = toks[k];
    const dollarsAfter =
      dollarWord?.kind === "word" &&
      DOLLAR_WORDS.has(dollarWord.text) &&
      SPACE_ONLY.test(gapBetween(text, toks[k - 1]!, dollarWord));
    if (dollarSign || usdBefore || dollarsAfter) {
      pushUnique(out, seen, moneyFact(amount));
      i = Math.max(k + (dollarsAfter ? 1 : 0), i + 1);
      continue;
    }

    const percent =
      (after?.text === "%" && adjacentAfter) ||
      (after?.kind === "word" &&
        (after.text === "percent" || after.text === "percentage") &&
        SPACE_OR_HYPHEN.test(gapBetween(text, toks[j - 1]!, after))) ||
      (after?.text === "per" &&
        toks[j + 1]?.text === "cent" &&
        SPACE_ONLY.test(gapBetween(text, toks[j - 1]!, after)));
    if (percent) {
      for (const value of values) pushUnique(out, seen, percentFact(value));
      i = Math.max(j + 1, i + 1);
      continue;
    }

    if (after !== undefined && SPACE_OR_HYPHEN.test(gapBetween(text, toks[j - 1]!, after))) {
      const unit = readUnit(toks, j, text);
      if (unit !== null) {
        for (const value of values) pushUnique(out, seen, durationFact(value, unit));
      }
    }
    i = Math.max(j, i + 1);
  }
}

function jurisdictionFacts(text: string, out: Fact[], seen: Set<string>, expand: boolean): void {
  for (const match of text.replace(/\s*&\s*/g, " and ").matchAll(JURISDICTION_PATTERN)) {
    const name = NAME_BY_FOLDED.get(match[1]!.replace(/\s+/g, " ").toLowerCase());
    if (name === undefined) continue;
    pushUnique(out, seen, { key: `jur:${name.toLowerCase()}`, label: name });
    if (expand && name === "England and Wales") {
      pushUnique(out, seen, { key: "jur:england", label: "England" });
      pushUnique(out, seen, { key: "jur:wales", label: "Wales" });
    }
  }
}

/**
 * The figures in `text`, first occurrence of each. `expand` adds the parts of a combined name
 * (England and Wales), and is used on the text that is relied on and not on the text that is
 * checked.
 */
export function extractFacts(text: string, options: { expand?: boolean } = {}): Fact[] {
  const view = normalizeForAnchor(clip(text, SCAN_LIMIT));
  const out: Fact[] = [];
  const seen = new Set<string>();
  numericFacts(view, out, seen);
  jurisdictionFacts(view, out, seen, options.expand === true);
  return out;
}

/** Whether a fact is a jurisdiction and not a duration, percentage or amount. */
export const isPlaceFact = (fact: Fact): boolean => fact.key.startsWith("jur:");

/**
 * Whether a claimed figure is among those relied on. "10 days" is also met by "10 business days",
 * because a finding that says days is not made false by a quote that says business days; the
 * reverse is not true.
 */
export function isSupportedFact(fact: Fact, relied: ReadonlySet<string>): boolean {
  if (relied.has(fact.key)) return true;
  return fact.key.startsWith("dur:day:") && relied.has(`dur:bday:${fact.key.slice(8)}`);
}
