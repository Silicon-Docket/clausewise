import { describe, expect, it } from "vitest";
import { extractFacts, isSupportedFact } from "../../src/stages/checks/facts.js";

const keys = (text: string, expand = false): string[] =>
  extractFacts(text, { expand }).map((f) => f.key);

describe("durations", () => {
  for (const [text, expected] of [
    ["for two (2) years from disclosure", ["dur:month:24"]],
    ["for 2 years", ["dur:month:24"]],
    ["for two years", ["dur:month:24"]],
    ["for thirty-six months", ["dur:month:36"]],
    ["for thirty six months", ["dur:month:36"]],
    ["for 36 months", ["dur:month:36"]],
    ["a three-year term", ["dur:month:36"]],
    ["a 3-year term", ["dur:month:36"]],
    ["on thirty (30) days' written notice", ["dur:day:30"]],
    ["within ten (10) business days", ["dur:bday:10"]],
    ["within 10 working days", ["dur:bday:10"]],
    ["within ten calendar days", ["dur:day:10"]],
    ["after two weeks", ["dur:day:14"]],
    ["one hundred and twenty (120) days", ["dur:day:120"]],
    ["one hundred twenty days", ["dur:day:120"]],
    ["1.5 years", ["dur:month:18"]],
    ["one (1) year", ["dur:month:12"]],
    ["nineteen months", ["dur:month:19"]],
    ["twenty-one days", ["dur:day:21"]],
    // The words may follow the digits as well as precede them.
    ["for 7 (seven) years from disclosure", ["dur:month:84"]],
    ["for 3(three) years", ["dur:month:36"]],
    ["within 10 (ten) business days", ["dur:bday:10"]],
    ["after thirty-six (36) months", ["dur:month:36"]],
    ["after 36 (thirty-six) months", ["dur:month:36"]],
    ["on 30 (thirty) days' notice", ["dur:day:30"]],
  ] as [string, string[]][]) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(keys(text)).toEqual(expected);
    });
  }

  it("treats a year and twelve months, and a week and seven days, as the same length", () => {
    expect(keys("one year")).toEqual(keys("12 months"));
    expect(keys("two weeks")).toEqual(keys("fourteen days"));
  });

  it("keeps both numbers when the word and the digits disagree", () => {
    expect(keys("two (3) years")).toEqual(["dur:month:24", "dur:month:36"]);
  });

  it("keeps both numbers when the digits and the words in brackets disagree, in either order", () => {
    expect(keys("3 (five) years")).toEqual(["dur:month:36", "dur:month:60"]);
  });

  it("reads brackets after a number as a repeat only when they hold a number and close", () => {
    // Anything else in the brackets is not a repeat of the number, and the duration still reads.
    expect(keys("3 (the Term) years")).toEqual([]);
    expect(keys("5 (a) years")).toEqual([]);
    expect(keys("10 (ten of them) days")).toEqual([]);
    expect(keys("7 (seven")).toEqual([]);
  });

  it("reads each duration once and keeps their order", () => {
    expect(keys("2 years, then 30 days, then two (2) years")).toEqual([
      "dur:month:24",
      "dur:day:30",
    ]);
  });

  it("does not read a number that has no unit, a section number or a date", () => {
    expect(keys("Section 6.1 of the Agreement, dated 15 September 2026")).toEqual([]);
    expect(keys("Sections 4, 5 and 8 survive")).toEqual([]);
    expect(keys("one party and no one else")).toEqual([]);
    expect(keys("in 2026 the parties met")).toEqual([]);
  });

  it("does not run two number words together", () => {
    // "five ten" is two numbers and neither is followed by a unit here.
    expect(keys("five ten years")).toEqual(["dur:month:120"]);
    expect(keys("twenty thirty days")).toEqual(["dur:day:30"]);
  });

  it("does not read a bare comma list as one number", () => {
    expect(keys("Section 4, 30 days after notice")).toEqual(["dur:day:30"]);
  });

  it("misses, on purpose, an article form and a range's first number", () => {
    expect(keys("for a year")).toEqual([]);
    expect(keys("three to five years")).toEqual(["dur:month:60"]);
  });
});

describe("a business day is its own unit", () => {
  const relied = (text: string) => new Set(keys(text));
  const claim = (text: string) => extractFacts(text)[0]!;

  it("lets a quote in business days support a claim in days, and not the reverse", () => {
    expect(isSupportedFact(claim("10 days"), relied("ten (10) business days"))).toBe(true);
    expect(isSupportedFact(claim("10 business days"), relied("ten (10) days"))).toBe(false);
    expect(isSupportedFact(claim("10 business days"), relied("ten (10) business days"))).toBe(true);
  });

  it("does not equate days and months", () => {
    expect(isSupportedFact(claim("30 days"), relied("one month"))).toBe(false);
  });
});

describe("percentages", () => {
  for (const [text, expected] of [
    ["5%", ["pct:5"]],
    ["5 %", ["pct:5"]],
    ["5 percent", ["pct:5"]],
    ["five (5) percent", ["pct:5"]],
    ["five per cent", ["pct:5"]],
    ["12.5% of the fees", ["pct:12.5"]],
    ["a 10 percentage", ["pct:10"]],
  ] as [string, string[]][]) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(keys(text)).toEqual(expected);
    });
  }
});

describe("dollar amounts", () => {
  for (const [text, expected] of [
    ["$5,000", ["usd:500000"]],
    ["$5000", ["usd:500000"]],
    ["USD 5,000", ["usd:500000"]],
    ["5,000 dollars", ["usd:500000"]],
    ["five thousand dollars", ["usd:500000"]],
    ["five thousand dollars ($5,000)", ["usd:500000"]],
    ["$1.5 million", ["usd:150000000"]],
    ["1.5 million dollars", ["usd:150000000"]],
    ["one million dollars", ["usd:100000000"]],
    ["five hundred thousand dollars", ["usd:50000000"]],
    ["$250k", ["usd:25000000"]],
    ["$2.50", ["usd:250"]],
  ] as [string, string[]][]) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(keys(text)).toEqual(expected);
    });
  }

  it("labels an amount with thousands separators and no locale", () => {
    expect(extractFacts("$1,250,000")[0]!.label).toBe("$1,250,000");
    expect(extractFacts("$2.5 million")[0]!.label).toBe("$2,500,000");
  });

  it("does not take a plain number for an amount", () => {
    expect(keys("5,000 copies")).toEqual([]);
  });
});

describe("jurisdictions", () => {
  for (const [text, expected] of [
    ["the laws of the State of Delaware", ["jur:delaware"]],
    ["governed by New York law and Delaware courts", ["jur:new york", "jur:delaware"]],
    ["courts of England and Wales", ["jur:england and wales"]],
    ["courts of England & Wales", ["jur:england and wales"]],
    ["exclusive forum in Harris County, Texas", ["jur:texas"]],
    ["Hong Kong International Arbitration", ["jur:hong kong"]],
    ["singapore", ["jur:singapore"]],
  ] as [string, string[]][]) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(keys(text)).toEqual(expected);
    });
  }

  it("matches whole words only", () => {
    expect(keys("Texasville and Indiana and Delawarean")).toEqual([]);
  });

  it("reads England and Wales as one place, and as its parts only on text that is relied on", () => {
    expect(keys("England and Wales")).toEqual(["jur:england and wales"]);
    expect(keys("England and Wales", true)).toEqual([
      "jur:england and wales",
      "jur:england",
      "jur:wales",
    ]);
  });

  it("misses an adjective for a place, on purpose", () => {
    expect(keys("English law")).toEqual([]);
  });
});

describe("hostile input", () => {
  it("scans a very long text in bounded time and reads the figures near its start", () => {
    const long = `two (2) years ${"word ".repeat(400_000)} five (5) years`;
    const started = Date.now();
    const found = keys(long);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(found).toEqual(["dur:month:24"]);
  });

  it("is linear on long runs of number words and symbols", () => {
    const started = Date.now();
    keys("one ".repeat(30_000));
    keys("(1) ".repeat(30_000));
    keys("$ ".repeat(30_000));
    keys("hundred and ".repeat(20_000));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
