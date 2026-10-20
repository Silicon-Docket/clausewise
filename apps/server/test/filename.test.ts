import { describe, expect, it } from "vitest";
import { attachmentDisposition, cleanFileName, stemOf } from "../src/filename.js";

describe("cleanFileName", () => {
  const cases: [string, string][] = [
    ["nda.docx", "nda.docx"],
    ["  spaced name.docx  ", "spaced name.docx"],
    ["M\u00fcller \u00dcnterschrift.docx", "M\u00fcller \u00dcnterschrift.docx"],
    ["\u5951\u7d04\u66f8.docx", "\u5951\u7d04\u66f8.docx"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\evil.docx", "evil.docx"],
    ["/absolute/path/to/file.docx", "file.docx"],
    ["a\u0000b\u001fc\u007fd\u0085e.docx", "abcde.docx"],
    ["\u202egnp.docx", "gnp.docx"],
    ["x\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069y.docx", "xy.docx"],
    ["", "contract.docx"],
    [".", "contract.docx"],
    ["...", "contract.docx"],
    [" . . ", "contract.docx"],
    ["dir/", "contract.docx"],
    ["\u0000", "contract.docx"],
  ];
  for (const [input, expected] of cases) {
    it(`turns ${JSON.stringify(input)} into ${JSON.stringify(expected)}`, () => {
      expect(cleanFileName(input)).toBe(expected);
    });
  }

  it("keeps whole characters when it shortens a name", () => {
    const emoji = `${"\u{1F4C4}".repeat(300)}.docx`;
    const cleaned = cleanFileName(emoji);
    expect([...cleaned]).toHaveLength(200);
    expect(cleaned.endsWith(".docx")).toBe(true);
    // No half of a surrogate pair.
    expect(cleaned).toBe(Buffer.from(cleaned, "utf8").toString("utf8"));
    expect(cleanFileName("n".repeat(201))).toHaveLength(200);
    expect(cleanFileName("n".repeat(200))).toHaveLength(200);
  });

  it("does not take a long ending for an extension", () => {
    const name = `${"a".repeat(300)}.${"b".repeat(50)}`;
    expect([...cleanFileName(name)]).toHaveLength(200);
  });
});

describe("attachmentDisposition", () => {
  it("gives an ASCII name for old clients and the real one for the others", () => {
    expect(attachmentDisposition("nda.docx")).toBe(
      `attachment; filename="nda.docx"; filename*=UTF-8''nda.docx`,
    );
    expect(attachmentDisposition("M\u00fcller \u5951\u7d04.docx")).toBe(
      `attachment; filename="Muller __.docx"; filename*=UTF-8''M%C3%BCller%20%E5%A5%91%E7%B4%84.docx`,
    );
  });

  it("cannot be broken out of by quotes, backslashes, semicolons or percent signs", () => {
    const header = attachmentDisposition(`a"b\\c;d%e'f(g)h*.docx`);
    expect(header).toBe(
      `attachment; filename="a_b_c;d_e'f(g)h*.docx"; filename*=UTF-8''a%22b%5Cc%3Bd%25e%27f%28g%29h%2A.docx`,
    );
    // Exactly the two quotes around the fallback name.
    expect(header.split('"')).toHaveLength(3);
  });

  it("falls back to a plain name when nothing ASCII is left", () => {
    expect(attachmentDisposition("\u5951\u7d04\u66f8")).toContain('filename="contract.docx"');
    expect(attachmentDisposition("...")).toContain('filename="contract.docx"');
  });
});

describe("stemOf", () => {
  it("drops the last extension", () => {
    expect(stemOf("nda.docx")).toBe("nda");
    expect(stemOf("a.b.docx")).toBe("a.b");
    expect(stemOf("noextension")).toBe("noextension");
    expect(stemOf(".docx")).toBe(".docx");
  });
});
