import { describe, expect, it } from "vitest";
import {
  NOTICE_MAX_AGE_SECONDS,
  NOTICE_PARAM,
  NOTICE_SIGNATURE_PARAM,
  noticeFor,
  signedNoticePath,
  uploadNotice,
  verifiedNotice,
  withNotice,
  type NoticeCode,
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
