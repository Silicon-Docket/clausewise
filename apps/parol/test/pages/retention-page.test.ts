import { describe, expect, it } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import {
  FORM_RETAIN_DEFAULT_DAYS,
  FORM_RETAIN_MAX_DAYS,
} from "../../src/server/views/retention.js";
import { DEFAULT_RETAIN_DAYS, MAX_RETAIN_DAYS } from "../../src/store/index.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, formsTo, hasAttr, hasClass, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { mattersPage } from "./render.js";
import {
  PAST,
  buildRetention,
  retentionListPage,
  retentionMatterPage,
} from "./retention-support.js";
import { IDS, buildMatterSummary } from "./support.js";
import { VARIANTS_RETENTION } from "./variants-retention.js";

/**
 * The retention section of the matter page and the retention field and chip of the list of matters
 * (package W2.7, slice B). A page of fixed sentences, a date and a count of days from today (never a
 * measurement), so these tests read the HTML a view makes, state by state, and hold it to the rules
 * every page has (`checkInvariants`) and to the keyboard and label rules of test/a11y/rules.ts. The
 * routes that receive the forms are in test/routes/retention.test.ts.
 */

const read = (html: string): { html: string; root: El } => ({ html, root: checkInvariants(html) });

const sectionOf = (root: El): El => {
  const found = byId(root, "retention");
  if (found === undefined) throw new Error("the page has no retention section");
  return found;
};

describe("the retention section, for an associate, before the date", () => {
  const { html, root } = read(retentionMatterPage("associate"));
  const section = sectionOf(root);

  it("is a section of its own with a heading that says what it is about", () => {
    expect(section.name).toBe("section");
    expect(attr(section, "aria-labelledby")).toBe("retention-heading");
    const heading = byId(section, "retention-heading") as El;
    expect(readable(heading)).toBe("How long this matter is kept");
  });

  it("says until when the matter is kept, how many days that is from today, and that nothing deletes it by itself", () => {
    const text = readable(section);
    expect(text).toContain(
      "This matter is kept until 3 December 2026, 09:00 UTC, 30 days from today.",
    );
    expect(text).toContain(
      "From that time it is deleted, with its documents, findings, decisions and memos, when the operator runs the retention command.",
    );
    expect(text).toContain("Nothing deletes it by itself.");
    expect(text).not.toContain("Past its date");
    expect(all(section, (el) => hasClass(el, "chip"))).toEqual([]);
  });

  it("says one day in the singular", () => {
    const { root: one } = read(retentionMatterPage("associate", buildRetention({ daysLeft: 1 })));
    expect(readable(sectionOf(one))).toContain("3 December 2026, 09:00 UTC, 1 day from today.");
  });

  it("offers a form to the retention route, with the token, one labelled number field and one button", () => {
    const form = formsTo(section, urls.matterRetention(IDS.matter))[0] as El;
    expect(attr(form, "method")).toBe("post");
    expect(all(form, (el) => attr(el, "name") === "_csrf")).toHaveLength(1);
    const field = all(form, (el) => attr(el, "name") === FIELDS.retainDays);
    expect(field).toHaveLength(1);
    const input = field[0] as El;
    expect(input.name).toBe("input");
    expect(attr(input, "type")).toBe("number");
    expect(attr(input, "inputmode")).toBe("numeric");
    expect(attr(input, "min")).toBe("1");
    expect(attr(input, "max")).toBe("90");
    expect(hasAttr(input, "required")).toBe(true);
    expect(hasAttr(input, "disabled")).toBe(false);
    // No default is offered: how long to keep it from now is the person's to type.
    expect(attr(input, "value")).toBeUndefined();
    expect(accessibleName(section, input)).toBe("Keep for how many more days, counting from today");
    const hint = byId(section, attr(input, "aria-describedby") as string) as El;
    expect(readable(hint)).toBe(
      "A whole number from 1 to 90. The new date replaces the old one, whether it is earlier or later.",
    );
    const buttons = all(form, (el) => el.name === "button");
    expect(buttons.map((b) => [attr(b, "type"), readable(b)])).toEqual([
      ["submit", "Change retention date"],
    ]);
    expect(all(form, (el) => el.name === "script")).toEqual([]);
    expect(html).not.toContain(" onclick=");
  });

  it("takes its ceiling from the view, so the page and the store cannot say two numbers", () => {
    const { root: other } = read(retentionMatterPage("associate", buildRetention({ maxDays: 45 })));
    const input = all(sectionOf(other), (el) => attr(el, "name") === FIELDS.retainDays)[0] as El;
    expect(attr(input, "max")).toBe("45");
    expect(readable(sectionOf(other))).toContain("A whole number from 1 to 45.");
  });
});

describe("the retention section, for an associate, after the date", () => {
  const { root } = read(retentionMatterPage("associate", PAST));
  const section = sectionOf(root);

  it("says that the matter is past its date, in a chip with a shape and in words", () => {
    const chips = all(section, (el) => hasClass(el, "chip"));
    expect(chips.map((chip) => readable(chip))).toEqual(["Past its date"]);
    expect(hasClass(chips[0] as El, "tone-warn")).toBe(true);
    expect(all(chips[0] as El, (el) => hasClass(el, "shape-triangle"))).toHaveLength(1);
    const text = readable(section);
    expect(text).toContain("This matter is past its retention date (3 November 2026).");
    expect(text).toContain("It became deletable at 3 November 2026, 12:00 UTC.");
    expect(text).toContain(
      "It is still here because nothing deletes a matter by itself; it goes when the operator runs the retention command.",
    );
    expect(text).toContain("Change the date below if it should be kept.");
    expect(text).not.toContain("days from today");
  });

  it("still offers the form that changes the date", () => {
    expect(formsTo(section, urls.matterRetention(IDS.matter))).toHaveLength(1);
  });
});

describe("the retention section, for those who may not change the date", () => {
  for (const role of ["reviewer", "viewer"] as const) {
    it(`shows a ${role} the date and no form, and says who can change it`, () => {
      const { root } = read(retentionMatterPage(role));
      const section = sectionOf(root);
      expect(readable(section)).toContain("This matter is kept until 3 December 2026");
      expect(readable(section)).toContain("Only an associate on the matter can change this date.");
      expect(all(section, (el) => el.name === "form")).toEqual([]);
      expect(all(section, (el) => ["input", "button"].includes(el.name))).toEqual([]);
    });
  }

  it("tells a reviewer of a matter past its date whom to ask", () => {
    const { root } = read(retentionMatterPage("reviewer", PAST));
    const text = readable(sectionOf(root));
    expect(text).toContain("Past its date");
    expect(text).toContain(
      "Ask an associate on the matter to change the date if it should be kept.",
    );
    expect(text).not.toContain("Change the date below");
  });
});

describe("the time the page names is the time the job deletes from", () => {
  // The date is created time plus whole days, so it falls partway through its calendar day, and the
  // job deletes from that instant. A page that named only the day would say "until 3 December" about
  // a matter that goes in the afternoon of 3 December.
  const INSTANT = "2026-12-03T14:05:37.123Z";

  it("names the instant in UTC and says 'from that time', not 'after that date'", () => {
    const { root } = read(
      retentionMatterPage("associate", buildRetention({ retainUntil: INSTANT, daysLeft: 30 })),
    );
    const text = readable(sectionOf(root));
    expect(text).toContain(
      "This matter is kept until 3 December 2026, 14:05 UTC, 30 days from today.",
    );
    expect(text).toContain("From that time it is deleted");
    expect(text).not.toContain("After that date");
  });

  it("names the instant of a matter that is past it, so the chip and the sentence agree on the day", () => {
    const { root } = read(
      retentionMatterPage(
        "associate",
        buildRetention({ retainUntil: INSTANT, daysLeft: 0, pastDate: true }),
      ),
    );
    expect(readable(sectionOf(root))).toContain(
      "This matter is past its retention date (3 December 2026). It became deletable at 3 December 2026, 14:05 UTC.",
    );
  });

  it("names a minute that is never later than the instant, so nothing goes before the time it names", () => {
    // The minute is cut, not rounded: 14:05:37 is shown as 14:05, never as 14:06.
    const { root } = read(
      retentionMatterPage("associate", buildRetention({ retainUntil: "2026-12-03T14:05:59.999Z" })),
    );
    const text = readable(sectionOf(root));
    expect(text).toContain("3 December 2026, 14:05 UTC");
    expect(text).not.toContain("14:06");
  });
});

describe("a view without a retention date", () => {
  it("has no section, so a page built from a view that did not fill it is unchanged", () => {
    const { root } = read(retentionMatterPage("associate", null));
    expect(byId(root, "retention")).toBeUndefined();
    expect(formsTo(root, urls.matterRetention(IDS.matter))).toEqual([]);
  });
});

describe("where the section is on the page", () => {
  it("comes after the people and before the delete section, so going down the page passes it once", () => {
    const { root } = read(retentionMatterPage("associate"));
    const ids = all(byTag(root, "main")[0] as El, (el) => el.name === "section").map((s) =>
      attr(s, "id"),
    );
    const at = (id: string): number => ids.indexOf(id);
    expect(at("retention")).toBeGreaterThan(-1);
    expect(at("people")).toBeGreaterThan(-1);
    expect(at("delete")).toBeGreaterThan(-1);
    expect(at("people")).toBeLessThan(at("retention"));
    expect(at("retention")).toBeLessThan(at("delete"));
    expect(ids.filter((id) => id === "retention")).toHaveLength(1);
  });
});

describe("the new-matter form", () => {
  const { root } = read(mattersPage([]));
  const form = formsTo(root, urls.matters())[0] as El;
  const field = all(form, (el) => attr(el, "name") === FIELDS.retainDays);

  it("has one number field for the days, with the default, the range and a label", () => {
    expect(field).toHaveLength(1);
    const input = field[0] as El;
    expect(attr(input, "id")).toBe("new-matter-retain");
    expect(attr(input, "type")).toBe("number");
    expect(attr(input, "inputmode")).toBe("numeric");
    expect(attr(input, "min")).toBe("1");
    expect(attr(input, "max")).toBe("90");
    expect(attr(input, "value")).toBe("30");
    expect(hasAttr(input, "required")).toBe(true);
    expect(accessibleName(form, input)).toBe("Keep for (days)");
    const hint = byId(form, attr(input, "aria-describedby") as string) as El;
    expect(readable(hint)).toBe(
      "After this many days the matter can be deleted by the retention command. You can change it later on the matter's page.",
    );
  });

  it("puts the field in a place the refusal can jump to, before the button", () => {
    const place = byId(form, "retention") as El;
    expect(place).toBeDefined();
    expect(all(place, (el) => attr(el, "name") === FIELDS.retainDays)).toHaveLength(1);
    const controls = all(form, (el) => ["input", "select", "button"].includes(el.name));
    const input = field[0] as El;
    const button = controls.find((el) => el.name === "button") as El;
    expect(controls.indexOf(input)).toBeLessThan(controls.indexOf(button));
  });

  it("states the same numbers as the store, which the page cannot import", () => {
    expect(FORM_RETAIN_DEFAULT_DAYS).toBe(DEFAULT_RETAIN_DAYS);
    expect(FORM_RETAIN_MAX_DAYS).toBe(MAX_RETAIN_DAYS);
    // And the service puts the store's own numbers in the view of a matter.
    expect(buildRetention().defaultDays).toBe(DEFAULT_RETAIN_DAYS);
    expect(buildRetention().maxDays).toBe(MAX_RETAIN_DAYS);
  });
});

describe("the chip in the list of matters", () => {
  const { root } = read(retentionListPage());
  const rows = all(byTag(root, "tbody")[0] as El, (el) => el.name === "tr");

  it("marks a matter past its date with a chip that has a shape and a word, beside the date", () => {
    const cell = all(rows[0] as El, (el) => el.name === "td").find((td) =>
      readable(td).includes("3 November 2026"),
    ) as El;
    expect(readable(cell)).toBe("3 November 2026 Past");
    const chip = all(cell, (el) => hasClass(el, "chip"))[0] as El;
    expect(hasClass(chip, "tone-warn")).toBe(true);
    expect(all(chip, (el) => hasClass(el, "shape-triangle"))).toHaveLength(1);
  });

  it("marks no other matter, and none whose view did not say", () => {
    expect(all(rows[1] as El, (el) => hasClass(el, "chip") && readable(el) === "Past")).toEqual([]);
    const plain = read(mattersPage([buildMatterSummary()])).root;
    expect(all(plain, (el) => hasClass(el, "chip") && readable(el) === "Past")).toEqual([]);
  });
});

describe("the keyboard and the labels", () => {
  it("reaches the field and then the button of the section, in that order, and nothing else in it", () => {
    const { root } = read(retentionMatterPage("associate"));
    const section = sectionOf(root);
    const inside = new Set(all(section, () => true));
    const stops = tabStops(root).filter((el) => inside.has(el));
    expect(stops.map((el) => [el.name, attr(el, "name") ?? readable(el)])).toEqual([
      ["input", FIELDS.retainDays],
      ["button", "Change retention date"],
    ]);
    for (const stop of stops) {
      expect(hasAttr(stop, "disabled")).toBe(false);
      expect(attr(stop, "tabindex")).toBeUndefined();
    }
  });

  it("reaches the field of the new-matter form before its button", () => {
    const { root } = read(mattersPage([]));
    const form = formsTo(root, urls.matters())[0] as El;
    const inside = new Set(all(form, () => true));
    const names = tabStops(root)
      .filter((el) => inside.has(el))
      .map((el) => attr(el, "name") ?? readable(el));
    expect(names.indexOf(FIELDS.retainDays)).toBeGreaterThan(-1);
    expect(names.indexOf(FIELDS.retainDays)).toBeLessThan(names.indexOf("Create matter"));
  });

  it("passes the rules of test/a11y/rules.ts in every pane the package adds, in every state", () => {
    // The panes are audited alone (a pane has no frame). The whole matter page and the whole list
    // still carry the faults of the pages before this package (the sweep of the last phase fixes
    // them), so they are held to the rules every page has (`checkInvariants`) and not to these.
    const panes = VARIANTS_RETENTION.filter(([name]) => name.startsWith("pane, "));
    expect(panes.map(([name]) => name)).toEqual([
      "pane, retention kept, associate",
      "pane, retention past, associate",
      "pane, retention kept, viewer",
      "pane, retention past, reviewer",
      "pane, new-matter form",
    ]);
    for (const [, make] of panes) expectAccessible(make(), { fragment: true });
    for (const [name, make] of VARIANTS_RETENTION)
      if (name.startsWith("matter, retention") || name.startsWith("matters, "))
        checkInvariants(make());
  });
});
