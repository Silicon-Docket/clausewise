import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { checkInvariants } from "./invariants.js";
import {
  attr,
  all,
  byTag,
  controls,
  first,
  forms,
  formsTo,
  hasClass,
  readable,
  withClass,
} from "./html.js";
import { errorPage, mattersPage, signInPage } from "./render.js";
import { buildChrome, buildMatterSummary, buildUsers, IDS } from "./support.js";

describe("MattersPage", () => {
  it("lists each matter with a link to it, its status and the signed-in user's role", () => {
    const html = mattersPage([
      buildMatterSummary(),
      buildMatterSummary({
        id: "m_two",
        name: "Second matter",
        status: "stale",
        role: "viewer",
        playbook: null,
      }),
    ]);
    const root = checkInvariants(html);
    const table = byTag(root, "table")[0]!;
    const rows = byTag(table, "tbody")[0]!.children.filter((c) => c.type === "element");
    expect(rows).toHaveLength(2);
    const link = first(
      table,
      (el) => el.name === "a" && readable(el) === "Lanternfish / Corvane NDA",
    );
    expect(attr(link, "href")).toBe(urls.matter(IDS.matter));
    expect(readable(table)).toContain("In review");
    expect(readable(table)).toContain("Out of date");
    expect(readable(table)).toContain("Associate");
    expect(readable(table)).toContain("Viewer");
    expect(readable(table)).toContain("None chosen");
    expect(readable(table)).toContain("parol-nda-recipient 1.0.0");
    expect(readable(table)).toContain("29 November 2026");
  });

  it("says so when there are no matters, and still offers the new-matter form", () => {
    const root = checkInvariants(mattersPage([]));
    expect(readable(root)).toContain("You have no matters yet");
    expect(byTag(root, "table")).toHaveLength(0);
    expect(forms(root).some((f) => attr(f, "action") === urls.matters())).toBe(true);
  });

  it("warns when a matter is not marked synthetic", () => {
    const root = checkInvariants(mattersPage([buildMatterSummary({ synthetic: false })]));
    expect(readable(root)).toContain("Not marked synthetic");
  });

  describe("the new-matter form", () => {
    const root = checkInvariants(mattersPage([]));
    const form = formsTo(root, urls.matters())[0]!;

    it("posts the four fields the matter service needs", () => {
      for (const name of [
        FIELDS.name,
        FIELDS.clientLegalName,
        FIELDS.reviewerUserId,
        FIELDS.playbookVersionId,
      ]) {
        expect(controls(form, name), name).toHaveLength(1);
      }
      expect(attr(controls(form, FIELDS.name)[0]!, "required")).toBe("");
      expect(attr(controls(form, FIELDS.clientLegalName)[0]!, "required")).toBe("");
    });

    it("explains that the client name must be exact", () => {
      expect(readable(form)).toContain("exact legal name");
    });

    it("offers every demo identity as a reviewer, and an empty choice", () => {
      const select = controls(form, FIELDS.reviewerUserId)[0]!;
      const options = byTag(select, "option");
      expect(options.map((o) => attr(o, "value"))).toEqual([
        "",
        ...buildUsers().map((u) => u.userId),
      ]);
      expect(readable(options[3]!)).toBe("P. Okafor (Legal engineer)");
    });

    it("offers each approved playbook version with its date and rule count", () => {
      const select = controls(form, FIELDS.playbookVersionId)[0]!;
      const options = byTag(select, "option");
      expect(options).toHaveLength(2);
      expect(attr(options[1]!, "value")).toBe(IDS.playbookVersion);
      expect(readable(options[1]!)).toBe(
        "Parol NDA (Recipient) 1.0.0, approved 28 October 2026, 8 rules",
      );
    });
  });
});

describe("SignInPage", () => {
  it("shows one button per identity, each posting its own user id", () => {
    const root = checkInvariants(signInPage());
    const form = formsTo(root, urls.session())[0]!;
    const buttons = all(form, (el) => el.name === "button" && attr(el, "name") === FIELDS.userId);
    expect(buttons.map((b) => attr(b, "value"))).toEqual(buildUsers().map((u) => u.userId));
    expect(readable(buttons[1]!)).toContain("D. Whitfield");
    expect(readable(buttons[2]!)).toContain("Legal engineer");
    expect(controls(form, FIELDS.intent)[0]!.attrs.find((a) => a.name === "value")?.value).toBe(
      "sign-in",
    );
  });

  it("says plainly that it is not authentication", () => {
    const root = checkInvariants(signInPage());
    expect(readable(root)).toContain("It is not authentication");
  });

  it("says what it means to be sent back here, and that what was typed was not saved", () => {
    for (const users of [buildUsers(), []]) {
      const text = readable(checkInvariants(signInPage(users))).replace(/\s+/g, " ");
      expect(text).toContain(
        "If Parol sent you back to this page, your session ended: sessions are limited in time, and a server started without a fixed cookie secret signs everyone out whenever it restarts. Choose a person to start again. Anything you were typing was not saved.",
      );
    }
  });

  it("has no sign-out form, because nobody is signed in", () => {
    const root = checkInvariants(signInPage());
    const intents = all(root, (el) => el.name === "input" && attr(el, "name") === FIELDS.intent);
    expect(intents.map((i) => attr(i, "value"))).toEqual(["sign-in"]);
    expect(readable(root)).not.toContain("Signed in as");
  });

  it("handles an empty identity list", () => {
    const root = checkInvariants(signInPage([]));
    expect(readable(root)).toContain("No demo identities");
    expect(forms(root)).toHaveLength(0);
  });
});

describe("ErrorPage", () => {
  it("shows the status, a title and a way back", () => {
    const root = checkInvariants(errorPage());
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Page not found");
    expect(readable(root)).toContain("Error 404");
    const back = first(root, (el) => el.name === "a" && readable(el) === "Back to your matters");
    expect(attr(back, "href")).toBe(urls.matters());
    expect(withClass(root, "error-page").length).toBe(1);
    expect(attr(withClass(root, "error-page")[0]!, "role")).toBe("alert");
  });

  it("works before anyone has signed in", () => {
    const root = checkInvariants(errorPage(buildChrome({ userName: null })));
    expect(forms(root)).toHaveLength(0);
    expect(
      hasClass(
        first(root, (el) => el.name === "main"),
        "page",
      ),
    ).toBe(true);
  });
});
