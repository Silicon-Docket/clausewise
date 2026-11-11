import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError, z } from "zod";
import { describe, expect, it } from "vitest";
import { UploadError } from "../../src/module-contracts.js";
import { ConflictError, ValidationError } from "../../src/store/errors.js";
import {
  NOTICES,
  NOTICE_MAX_AGE_SECONDS,
  NOTICE_PARAM,
  NOTICE_SIGNATURE_PARAM,
  REFUSAL_FRAGMENTS,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  mergeRefusalFragments,
  noticeFor,
  refusalOf,
  signedNoticePath,
  uploadNotice,
  verifiedNotice,
  withNotice,
  type NoticeCode,
  type RefusalFragment,
} from "../../src/server/routes/notices.js";

/**
 * The notices that cross a redirect. The query string carries a short code and nothing else, and
 * the phrase comes from a closed table in the application, so a request cannot put text of its own
 * on a page.
 */

const CODES: NoticeCode[] = [
  "matter-created",
  "matter-deleted",
  "settings-saved",
  "member-added",
  "document-added",
  "document-added-warnings",
  "document-duplicate",
  "document-near-duplicate",
  "version-added",
  "operative-saved",
  "date-saved",
  "document-removed",
  "review-started",
  "review-resumed",
  "review-cancelled",
  "decision-saved",
  "memo-exported",
];

describe("noticeFor", () => {
  it("turns each code into a phrase of the application, and each phrase is plain text", () => {
    const texts = new Set<string>();
    for (const code of CODES) {
      const notice = noticeFor(code);
      expect(notice, code).not.toBeNull();
      expect(["success", "info", "error"]).toContain(notice!.kind);
      expect(notice!.text).toMatch(/^[A-Z][^<>&"]*\.$/);
      // The house style: no em dash and no en dash.
      expect(notice!.text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
      texts.add(notice!.text);
    }
    // Each code says its own thing.
    expect(texts.size).toBe(CODES.length);
  });

  it("gives nothing for anything that is not a code, whatever it looks like", () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      [],
      "",
      " ",
      "nonsense",
      "SETTINGS-SAVED",
      "settings-saved ",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "<script>alert(1)</script>",
      "a".repeat(10_000),
    ])
      expect(noticeFor(value), String(value).slice(0, 30)).toBeNull();
  });

  it("returns a copy, so a page cannot change the table", () => {
    const a = noticeFor("settings-saved")!;
    a.text = "changed";
    expect(noticeFor("settings-saved")!.text).toBe("The settings were saved.");
  });
});

describe("withNotice", () => {
  it("adds the code to a path, with ? or & as the path needs", () => {
    expect(withNotice("/matters/mat_1", "settings-saved")).toBe(
      `/matters/mat_1?${NOTICE_PARAM}=settings-saved`,
    );
    expect(withNotice("/matters/mat_1/runs/run_1?finding=f_1", "decision-saved")).toBe(
      `/matters/mat_1/runs/run_1?finding=f_1&${NOTICE_PARAM}=decision-saved`,
    );
  });
});

describe("uploadNotice", () => {
  it("says what happened to the file, a duplicate before a near duplicate before any other warning", () => {
    expect(uploadNotice([], "document-added")).toBe("document-added");
    expect(uploadNotice([], "version-added")).toBe("version-added");
    expect(uploadNotice([{ code: "duplicate_document" }], "document-added")).toBe(
      "document-duplicate",
    );
    expect(uploadNotice([{ code: "near_duplicate_version" }], "version-added")).toBe(
      "document-near-duplicate",
    );
    expect(
      uploadNotice(
        [{ code: "instruction_like_text" }, { code: "near_duplicate_version" }],
        "version-added",
      ),
    ).toBe("document-near-duplicate");
    expect(
      uploadNotice(
        [{ code: "near_duplicate_version" }, { code: "duplicate_document" }],
        "version-added",
      ),
    ).toBe("document-duplicate");
    expect(uploadNotice([{ code: "unreviewed_content" }], "document-added")).toBe(
      "document-added-warnings",
    );
    expect(uploadNotice([{ code: "no_reviewable_text" }], "version-added")).toBe(
      "document-added-warnings",
    );
  });
});

describe("a signed notice", () => {
  const binding = {
    secret: "a-secret-of-the-tests",
    userId: "usr_a",
    now: new Date("2026-11-04T09:00:00Z"),
  };
  const split = (path: string): { pathname: string; code: string; signature: string } => {
    const url = new URL(path, "http://parol.test");
    return {
      pathname: url.pathname,
      code: url.searchParams.get(NOTICE_PARAM) ?? "",
      signature: url.searchParams.get(NOTICE_SIGNATURE_PARAM) ?? "",
    };
  };

  it("is the path, the code and a signature, and reads back as the phrase of the code", () => {
    const signed = signedNoticePath("/matters/mat_1/memos", "memo-exported", binding);
    expect(signed).toMatch(
      /^\/matters\/mat_1\/memos\?notice=memo-exported&nt=\d+\.[A-Za-z0-9_-]{43}$/,
    );
    expect(verifiedNotice(split(signed), binding)).toEqual(noticeFor("memo-exported"));
    // A path that has a query already keeps it.
    const withQuery = signedNoticePath(
      "/matters/mat_1/runs/run_1?finding=f_1",
      "decision-saved",
      binding,
    );
    expect(withQuery).toContain("?finding=f_1&notice=decision-saved&nt=");
    expect(verifiedNotice(split(withQuery), binding)).toEqual(noticeFor("decision-saved"));
  });

  it("is good for the person, the page and the code it was made for, and for a short time", () => {
    const signed = split(signedNoticePath("/matters/mat_1/memos", "memo-exported", binding));
    const later = (seconds: number): Date => new Date(binding.now.getTime() + seconds * 1000);
    expect(
      verifiedNotice(signed, { ...binding, now: later(NOTICE_MAX_AGE_SECONDS) }),
    ).not.toBeNull();
    expect(
      verifiedNotice(signed, { ...binding, now: later(NOTICE_MAX_AGE_SECONDS + 1) }),
    ).toBeNull();
    // A signature from the future is not one this server made.
    expect(verifiedNotice(signed, { ...binding, now: later(-3600) })).toBeNull();
    expect(verifiedNotice(signed, { ...binding, userId: "usr_b" })).toBeNull();
    expect(verifiedNotice(signed, { ...binding, secret: "another-secret" })).toBeNull();
    expect(verifiedNotice({ ...signed, pathname: "/matters/mat_2/memos" }, binding)).toBeNull();
    expect(verifiedNotice({ ...signed, code: "decision-saved" }, binding)).toBeNull();
  });

  it("gives nothing for a signature that is missing, malformed or not a string", () => {
    const signed = split(signedNoticePath("/matters/mat_1/memos", "memo-exported", binding));
    for (const signature of [
      undefined,
      null,
      42,
      {},
      "",
      "1",
      ".",
      `${signed.signature}x`,
      signed.signature.replace(/^\d+/, "-1"),
      "9".repeat(5_000),
    ])
      expect(
        verifiedNotice({ ...signed, signature }, binding),
        String(signature).slice(0, 20),
      ).toBeNull();
    // A good signature does not make a code that is not in the table into a notice.
    const odd = split(signedNoticePath("/matters/mat_1/memos", "memo-exported", binding));
    expect(verifiedNotice({ ...odd, code: "constructor" }, binding)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The refusal scheme: fragments, their merge, and what a refusal carries
// ---------------------------------------------------------------------------------------------

describe("the fragments", () => {
  const FRAGMENT_NAMES = ["feedback", "pilot", "retention", "training"];
  const routesDir = join(import.meta.dirname, "../../src/server/routes");

  it("are the core and one for each package that adds codes, merged in that order", () => {
    expect(REFUSAL_FRAGMENTS.map((f) => f.name)).toEqual(["core", ...FRAGMENT_NAMES]);
  });

  it("each have a file of their own, which is where their package writes", () => {
    const files = readdirSync(routesDir).filter((name) => /^refusals-[a-z]+\.ts$/.test(name));
    expect(files.sort()).toEqual(FRAGMENT_NAMES.map((name) => `refusals-${name}.ts`));
    for (const name of FRAGMENT_NAMES) {
      const text = readFileSync(join(routesDir, `refusals-${name}.ts`), "utf8");
      // Each is typed as a fragment without losing its codes, which is how a notice code written
      // there becomes a NoticeCode with no edit to notices.ts.
      expect(text, name).toContain("as const satisfies RefusalFragment");
    }
  });

  it("merge without a code defined twice", () => {
    expect(() => mergeRefusalFragments(REFUSAL_FRAGMENTS)).not.toThrow();
  });

  it("have the shape of a fragment, whatever their package has written in them", () => {
    for (const { name, fragment } of REFUSAL_FRAGMENTS) {
      expect(typeof fragment.phrases, name).toBe("object");
      expect(typeof fragment.todo, name).toBe("object");
      for (const text of Object.values(fragment.phrases)) expect(typeof text).toBe("string");
    }
  });

  it("leave the merged tables equal to the merge of the fragments, and the core codes in them", () => {
    const merged = mergeRefusalFragments(REFUSAL_FRAGMENTS);
    expect(REFUSAL_PHRASES).toEqual(merged.phrases);
    expect(REFUSAL_TODO).toEqual(merged.todo);
    expect(REFUSAL_JUMP).toEqual(merged.jump);
    expect(NOTICES).toEqual(merged.notices);
    for (const code of CODES) expect(noticeFor(code), code).toEqual(NOTICES[code]);
    for (const code of ["reason_required", "bad_decision", "nda_exists", "run_model_changed"])
      expect(REFUSAL_PHRASES[code], code).toMatch(/^[A-Z].*\.$/);
    expect(Object.keys(REFUSAL_PHRASES).length).toBeGreaterThanOrEqual(25);
  });

  it("have a phrase for every code that has a todo or a jump, and a todo that occurs in it", () => {
    for (const code of Object.keys(REFUSAL_TODO)) {
      expect(REFUSAL_PHRASES[code], `${code} has a todo and no phrase`).toBeDefined();
      expect(REFUSAL_PHRASES[code], `the todo of ${code} is not in its phrase`).toContain(
        REFUSAL_TODO[code] as string,
      );
    }
    for (const code of Object.keys(REFUSAL_JUMP))
      expect(REFUSAL_PHRASES[code], `${code} has a jump and no phrase`).toBeDefined();
  });

  it("use no dash, em or en, and no markup, in any phrase, todo, label or notice", () => {
    const words = [
      ...Object.values(REFUSAL_PHRASES),
      ...Object.values(REFUSAL_TODO),
      ...Object.values(REFUSAL_JUMP).map((j) => j.label),
      ...Object.values(NOTICES).map((n) => n.text),
    ];
    expect(words.length).toBeGreaterThan(40);
    for (const text of words) {
      expect(text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
      expect(text).not.toMatch(/[<>]/);
    }
  });

  it("are frozen, so a page cannot change the words of a refusal", () => {
    for (const table of [REFUSAL_PHRASES, REFUSAL_TODO, REFUSAL_JUMP, NOTICES])
      expect(Object.isFrozen(table)).toBe(true);
  });
});

describe("mergeRefusalFragments", () => {
  const one: RefusalFragment = {
    phrases: { alpha_code: "Alpha failed. Do alpha.", beta_code: "Beta failed." },
    todo: { alpha_code: "Do alpha." },
    jump: { alpha_code: { href: "#alpha", label: "Go to alpha" } },
    notices: { "alpha-saved": "Alpha was saved.", "alpha-note": { kind: "info", text: "Alpha." } },
  };
  const two: RefusalFragment = {
    phrases: { gamma_code: "Gamma failed. Do gamma." },
    todo: { gamma_code: "Do gamma." },
  };
  const named = (name: string, fragment: RefusalFragment) => ({ name, fragment });

  it("puts the codes of every fragment in one table each", () => {
    const merged = mergeRefusalFragments([named("one", one), named("two", two)]);
    expect(merged.phrases).toEqual({ ...one.phrases, ...two.phrases });
    expect(merged.todo).toEqual({ alpha_code: "Do alpha.", gamma_code: "Do gamma." });
    expect(merged.jump).toEqual({ alpha_code: { href: "#alpha", label: "Go to alpha" } });
    // A notice written as a string is a success notice; one written with a kind keeps its kind.
    expect(merged.notices).toEqual({
      "alpha-saved": { kind: "success", text: "Alpha was saved." },
      "alpha-note": { kind: "info", text: "Alpha." },
    });
    expect(mergeRefusalFragments([])).toEqual({ phrases: {}, todo: {}, jump: {}, notices: {} });
  });

  it("copies what it is given, so a later change to a fragment does not reach the tables", () => {
    const fragment: RefusalFragment = {
      phrases: { copy_code: "Copy." },
      todo: {},
      jump: { copy_code: { href: "#copy", label: "Copy" } },
    };
    const merged = mergeRefusalFragments([named("copy", fragment)]);
    fragment.phrases.copy_code = "Changed.";
    fragment.jump!.copy_code!.label = "Changed";
    expect(merged.phrases.copy_code).toBe("Copy.");
    expect(merged.jump.copy_code?.label).toBe("Copy");
  });

  it("refuses a code that two fragments define, in a phrase, a todo, a jump or a notice, and names both", () => {
    const clash: Record<string, RefusalFragment> = {
      phrase: { phrases: { alpha_code: "Again." }, todo: {} },
      todo: { phrases: {}, todo: { alpha_code: "Do it again." } },
      jump: { phrases: {}, todo: {}, jump: { alpha_code: { href: "#other", label: "Other" } } },
      notice: { phrases: {}, todo: {}, notices: { "alpha-saved": "Again." } },
    };
    for (const [kind, fragment] of Object.entries(clash))
      expect(
        () => mergeRefusalFragments([named("one", one), named("second", fragment)]),
        kind,
      ).toThrow(/defined by both the one fragment and the second fragment/);
    // The same fragment twice is two definitions of every code in it.
    expect(() => mergeRefusalFragments([named("a", one), named("b", one)])).toThrow(/alpha_code/);
  });

  it("refuses a clash with a code of the core fragment, so a package cannot redefine one", () => {
    const [core] = REFUSAL_FRAGMENTS;
    expect(core?.name).toBe("core");
    const phrase = mergeRefusalFragments([core!]).phrases;
    const existing = Object.keys(phrase)[0] as string;
    expect(() =>
      mergeRefusalFragments([
        core!,
        named("package", { phrases: { [existing]: "Redefined." }, todo: {} }),
      ]),
    ).toThrow(/defined by both the core fragment/);
    expect(() =>
      mergeRefusalFragments([
        core!,
        named("package", { phrases: {}, todo: {}, notices: { "settings-saved": "Redefined." } }),
      ]),
    ).toThrow(/defined by both the core fragment/);
  });

  it("refuses a code that could never be produced, an empty todo and a jump that is not a place", () => {
    const bad = (fragment: RefusalFragment) => () =>
      mergeRefusalFragments([named("bad", fragment)]);
    for (const code of [
      "",
      "Upper",
      "1code",
      "has-hyphen",
      "has space",
      "__proto__",
      "a".repeat(65),
    ])
      expect(bad({ phrases: { [code]: "x." }, todo: {} }), code).toThrow(/not a valid code/);
    for (const code of ["", "Upper", "has_underscore", "1code", "a".repeat(65)])
      expect(bad({ phrases: {}, todo: {}, notices: { [code]: "x." } }), code).toThrow(
        /not a valid code/,
      );
    expect(bad({ phrases: { x_code: "X. Do x." }, todo: { x_code: "  " } })).toThrow(/empty/);
    for (const href of ["https://example.org", "/matters", "#", "#A", "javascript:1", ""])
      expect(
        bad({
          phrases: { x_code: "X." },
          todo: {},
          jump: { x_code: { href: href as `#${string}`, label: "Go" } },
        }),
        href,
      ).toThrow(/not a link to a place/);
    expect(
      bad({
        phrases: { x_code: "X." },
        todo: {},
        jump: { x_code: { href: "#x", label: " " } },
      }),
    ).toThrow(/not a link to a place/);
  });

  it("names codes and fragments in its messages and never a phrase", () => {
    try {
      mergeRefusalFragments([
        named("one", { phrases: { x_code: "SECRET SENTENCE." }, todo: {} }),
        named("two", { phrases: { x_code: "ANOTHER SENTENCE." }, todo: {} }),
      ]);
      expect.unreachable("a code defined twice was merged");
    } catch (error) {
      expect((error as Error).message).not.toContain("SENTENCE");
    }
  });
});

describe("refusalOf", () => {
  const synthetic = mergeRefusalFragments([
    ...REFUSAL_FRAGMENTS,
    {
      name: "synthetic",
      fragment: {
        phrases: {
          probe_code: "The probe failed. Do the probe again.",
          bare_code: "The bare one failed.",
          jump_code: "The jump one failed.",
        },
        todo: { probe_code: "Do the probe again." },
        jump: {
          probe_code: { href: "#probe", label: "Go to the probe" },
          jump_code: { href: "#where", label: "Go to where" },
        },
      },
    },
  ]);

  it("carries the todo and the jump of a code that has them", () => {
    const refusal = refusalOf(new ValidationError("probe_code", "x"), synthetic);
    expect(refusal).toStrictEqual({
      status: 400,
      code: "probe_code",
      notice: {
        kind: "error",
        text: "The probe failed. Do the probe again.",
        todo: "Do the probe again.",
        jump: { href: "#probe", label: "Go to the probe" },
      },
    });
  });

  it("carries only what the code has: a todo without a jump, a jump without a todo, or neither", () => {
    const jumpOnly = refusalOf(new ConflictError("jump_code", "x"), synthetic);
    expect(jumpOnly?.status).toBe(409);
    expect(jumpOnly?.notice).toStrictEqual({
      kind: "error",
      text: "The jump one failed.",
      jump: { href: "#where", label: "Go to where" },
    });
    const bare = refusalOf(new ValidationError("bare_code", "x"), synthetic);
    expect(bare?.notice).toStrictEqual({ kind: "error", text: "The bare one failed." });
    expect(Object.keys(bare!.notice)).toEqual(["kind", "text"]);
  });

  it("hands out a copy, so a page cannot change the table of jumps", () => {
    const first = refusalOf(new ValidationError("probe_code", "x"), synthetic);
    first!.notice.jump!.label = "Changed";
    first!.notice.todo = "Changed";
    const second = refusalOf(new ValidationError("probe_code", "x"), synthetic);
    expect(second?.notice.jump?.label).toBe("Go to the probe");
    expect(second?.notice.todo).toBe("Do the probe again.");
  });

  it("takes nothing of what the tables hold for a code with no phrase: the words and the todo of its status", () => {
    const orphan = {
      phrases: {},
      todo: { orphan_code: "Do it." },
      jump: { orphan_code: { href: "#orphan" as const, label: "Go" } },
    };
    const refusal = refusalOf(new ValidationError("orphan_code", "x"), orphan);
    expect(refusal?.notice).toStrictEqual({
      kind: "error",
      text: "That request was not valid. Check the form and try again.",
      todo: "Check the form and try again.",
    });
  });

  it("gives the phrase and the todo of the status to a code it does not know, and a ZodError its own", () => {
    const unknown = refusalOf(new ConflictError("no_such_code", "x"), synthetic);
    expect(unknown?.notice).toStrictEqual({
      kind: "error",
      text: "That conflicts with the current state of the matter. Reload the page and try again.",
      todo: "Reload the page and try again.",
    });
    const parse = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(parse.success).toBe(false);
    const zod = refusalOf((parse as { error: ZodError }).error, synthetic);
    expect(zod?.status).toBe(400);
    expect(zod?.notice).toStrictEqual({
      kind: "error",
      text: "That request was not valid. Check the form and try again.",
      todo: "Check the form and try again.",
    });
  });

  it("keeps the text of an upload error, adds the sentence that says what to do and a way to the documents", () => {
    const refusal = refusalOf(new UploadError("Save it as a regular .docx file."), synthetic);
    expect(refusal?.status).toBe(422);
    expect(refusal?.notice).toStrictEqual({
      kind: "error",
      text: "Save it as a regular .docx file. Fix the file or choose another.",
      todo: "Fix the file or choose another.",
      jump: { href: "#documents", label: "Go to the documents" },
    });
    // The sentence that was added is the todo: it ends the text, so it occurs in it.
    expect(refusal?.notice.text.endsWith(refusal?.notice.todo ?? "?")).toBe(true);
  });

  it("is null for an error that is not the person's to act on", () => {
    for (const error of [new Error("x"), "text", null, undefined, 7, {}])
      expect(refusalOf(error, synthetic)).toBeNull();
  });

  it("answers the codes the application already had with the first sentence they had, then what to do and where", () => {
    const expected: Record<string, Record<string, unknown>> = {
      reason_required: {
        status: 400,
        notice: {
          kind: "error",
          text: "Give a reason. A decision to edit, reject or escalate needs one.",
          todo: "Give a reason.",
          jump: { href: "#decision-reason", label: "Go to the reason" },
        },
      },
      bad_decision: {
        status: 400,
        notice: {
          kind: "error",
          text: "Choose a decision.",
          todo: "Choose a decision.",
          jump: { href: "#decision-accept", label: "Go to the choices" },
        },
      },
      nda_exists: {
        status: 400,
        notice: {
          kind: "error",
          text: "The matter already has an NDA. Upload a new version of it, or remove it first.",
          todo: "Upload a new version of it, or remove it first.",
          jump: { href: "#documents", label: "Go to the documents" },
        },
      },
    };
    for (const [code, found] of Object.entries(expected)) {
      const refusal = refusalOf(new ValidationError(code, "x"));
      expect(refusal, code).toStrictEqual({ ...found, code });
    }
  });
});
