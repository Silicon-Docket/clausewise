import { describe, expect, it } from "vitest";
import { MEASURE_IDS, PILOT_PHRASES } from "../../src/pilot/index.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { PILOT_ANCHORS, TRAINED_VALUE, trainedField } from "../../src/server/pages/pilotfields.js";
import { REFUSALS_PILOT } from "../../src/server/routes/refusals-pilot.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { PEOPLE, adminView, emptyRecords, pilotPage } from "./pilot-support.js";
import { f1Records } from "../pilot/f1.js";
import { VARIANTS_PILOT } from "./variants-pilot.js";

/**
 * The pilot measures page (package W2.6b) as a document: what it lays out of the view it is given,
 * the forms it holds, and that every control is native, labelled and reached in reading order. The
 * numbers on it are the pure module's (`test/pilot/views.test.ts` pins them against the
 * hand-computed fixture); here the page is shown to say what it is given and no more.
 */

// A zero-width space, written as a code so that the source holds no invisible character.
const ZWSP = String.fromCharCode(0x200b);

const rootOf = (html: string): El => expectAccessible(html);

describe("the page in each scope", () => {
  it("has one h1 and a title that names the scope", () => {
    const pilot = rootOf(pilotPage());
    const synthetic = rootOf(pilotPage({ scope: "synthetic" }));
    expect(readable(byTag(pilot, "h1")[0]!)).toBe("Pilot measures");
    expect(byTag(pilot, "h1")).toHaveLength(1);
    expect(readable(byTag(pilot, "title")[0]!)).toBe("Pilot measures | Parol");
    expect(readable(byTag(synthetic, "title")[0]!)).toBe(
      "Pilot measures (synthetic scope) | Parol",
    );
  });

  it("says first that the pilot scope is empty, with how many matters the database holds", () => {
    const text = readable(byTag(rootOf(pilotPage()), "main")[0]!);
    expect(text).toContain("No pilot data. This database holds no matters");
    expect(text).not.toContain("SYNTHETIC SCOPE");
  });

  it("puts the fixed banner on the synthetic scope and on no other view", () => {
    const banner = (html: string): El | undefined =>
      all(rootOf(html), (el) => hasClass(el, "banner-synthetic"))[0];
    expect(readable(banner(pilotPage({ scope: "synthetic" }))!)).toBe(
      PILOT_PHRASES.syntheticBanner,
    );
    expect(PILOT_PHRASES.syntheticBanner).toContain("SYNTHETIC SCOPE");
    expect(banner(pilotPage())).toBeUndefined();
    expect(banner(pilotPage({ records: f1Records() }))).toBeUndefined();
    // The banner is a note, not an alert: it is read in order and does not interrupt.
    expect(attr(banner(pilotPage({ scope: "synthetic" }))!, "role")).toBe("note");
  });

  it("links the two scopes, marks the one shown and leads the CSV link to it", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const root = rootOf(pilotPage({ scope }));
      const nav = all(root, (el) => el.name === "nav" && attr(el, "aria-label") === "Scope")[0]!;
      const links = byTag(nav, "a");
      expect(links.map((a) => attr(a, "href"))).toEqual([
        urls.pilot("pilot"),
        urls.pilot("synthetic"),
      ]);
      expect(links.map((a) => readable(a))).toEqual([
        "Pilot scope",
        "Synthetic scope, a demonstration",
      ]);
      expect(
        links.filter((a) => attr(a, "aria-current") === "page").map((a) => attr(a, "href")),
      ).toEqual([urls.pilot(scope)]);
      const csv = all(root, (el) => el.name === "a" && readable(el).includes("CSV"));
      expect(csv.map((a) => attr(a, "href"))).toEqual([urls.pilotCsv(scope)]);
    }
  });

  it("ends every table caption with the name of the scope, and gives every column and row a header", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const root = rootOf(pilotPage({ scope, records: f1Records() }));
      const tables = byTag(root, "table");
      expect(tables.length).toBeGreaterThanOrEqual(8);
      for (const table of tables) {
        const caption = readable(byTag(table, "caption")[0]!);
        expect(caption, caption).toMatch(new RegExp(`${scope} scope$`));
        expect(
          byTag(table, "th").filter((th) => attr(th, "scope") === "col").length,
        ).toBeGreaterThan(0);
        for (const row of all(byTag(table, "tbody")[0]!, (el) => el.name === "tr"))
          expect(attr(byTag(row, "th")[0]!, "scope"), caption).toBe("row");
      }
    }
  });
});

describe("the measures", () => {
  const measuresTable = (html: string): El =>
    byTag(rootOf(html), "table").find((t) =>
      readable(byTag(t, "caption")[0]!).startsWith("Pilot measures,"),
    )!;

  it("has a row for every measure of document 8, with the denominator in words and in numbers", () => {
    const table = measuresTable(pilotPage({ scope: "pilot", records: f1Records() }));
    const rows = all(byTag(table, "tbody")[0]!, (el) => el.name === "tr");
    const headers = rows.map((row) => readable(byTag(row, "th")[0]!));
    for (const id of MEASURE_IDS) {
      const words = PILOT_PHRASES.measures[id];
      const row = rows[headers.findIndex((h) => h.startsWith(words.title))];
      expect(row, id).toBeDefined();
      const cells = byTag(row!, "td").map((td) => readable(td));
      // The denominator sentence is the module's, whole.
      if (id !== "active_time") expect(cells[3], id).toBe(words.denominator);
    }
    // A measure with a value shows it with its numerator and its denominator in text.
    const completion = rows[headers.findIndex((h) => h.startsWith("Completion"))]!;
    expect(
      byTag(completion, "td")
        .map((td) => readable(td))
        .slice(0, 3),
    ).toEqual(["1 of 3 (33.3%)", "1", "3"]);
  });

  it("shows a measure with no data as the words No data in a chip, and says why", () => {
    const html = pilotPage();
    const table = measuresTable(html);
    const chips = all(table, (el) => hasClass(el, "chip"));
    expect(chips.length).toBeGreaterThanOrEqual(10);
    for (const chip of chips) {
      expect(readable(chip)).toBe("No data");
      // The shape is decoration; the words carry the meaning.
      expect(
        all(chip, (el) => hasClass(el, "shape")).every((s) => attr(s, "aria-hidden") === "true"),
      ).toBe(true);
    }
    // The reason is the module's sentence, in the Note column of the row (the active time row has
    // none: it is by phase, in its own table). This database has no calendar, so that is the reason.
    const rows = all(byTag(table, "tbody")[0]!, (el) => el.name === "tr");
    const notes = rows.map((row) => readable(byTag(row, "td")[4]!));
    expect(notes.filter((note) => note === PILOT_PHRASES.noData.no_calendar).length).toBe(
      rows.length - 1,
    );
  });

  it("states what each count of the population means, beside the count", () => {
    const root = rootOf(pilotPage({ scope: "synthetic", records: f1Records() }));
    const table = byTag(root, "table").find((t) =>
      readable(byTag(t, "caption")[0]!).startsWith("Population of the measures"),
    )!;
    const rows = all(byTag(table, "tbody")[0]!, (el) => el.name === "tr");
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const row of rows) {
      expect(readable(byTag(row, "th")[0]!).length).toBeGreaterThan(10);
      expect(readable(byTag(row, "td")[0]!)).toMatch(/^\d+$/);
    }
  });

  it("lists every line of the method, as the module has it", () => {
    const root = rootOf(pilotPage());
    const items = byTag(byId(root, "method")!, "li").map((li) => readable(li));
    expect(items).toEqual([...PILOT_PHRASES.method]);
  });

  it("warns of matters that will leave the measures before the pilot ends, when there are some", () => {
    const warned = rootOf(pilotPage({ scope: "pilot", records: f1Records() }));
    const status = all(warned, (el) => attr(el, "role") === "status").map((el) => readable(el));
    expect(
      status.some((t) => t.includes("will reach their retention date before the end of the pilot")),
    ).toBe(true);
    const none = rootOf(pilotPage());
    expect(all(none, (el) => attr(el, "role") === "status")).toHaveLength(0);
  });
});

describe("the two forms", () => {
  it("posts the date to the calendar address, with the session's token, a label and a button", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    const form = all(
      root,
      (el) => el.name === "form" && attr(el, "action") === urls.pilotCalendar(),
    )[0]!;
    expect(attr(form, "method")).toBe("post");
    expect(all(form, (el) => el.name === "input" && attr(el, "name") === "_csrf")).toHaveLength(1);
    const input = byId(root, PILOT_ANCHORS.startDate)!;
    expect(attr(input, "name")).toBe(FIELDS.startDate);
    expect(attr(input, "type")).toBe("date");
    expect(attr(input, "value")).toBe("2026-01-05");
    const label = all(
      root,
      (el) => el.name === "label" && attr(el, "for") === PILOT_ANCHORS.startDate,
    )[0]!;
    expect(readable(label)).toBe("First day of the pilot");
    expect(byTag(form, "button").map((b) => readable(b))).toEqual(["Save the start date"]);
  });

  it("gives the date field the first and the last start date the store takes, as its min and max", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    const input = byId(root, PILOT_ANCHORS.startDate)!;
    expect(attr(input, "min")).toBe("1000-01-01");
    expect(attr(input, "max")).toBe("9999-11-26");
    expect(hasAttr(input, "required")).toBe(true);
    const hint = byId(root, `${PILOT_ANCHORS.startDate}-hint`)!;
    expect(readable(hint)).toContain("The date is from 1000-01-01 to 9999-11-26");
    // The limits are the view's, not the page's own.
    const other = rootOf(
      pilotPage({ admin: adminView({ startDateRange: { min: "2000-01-01", max: "2100-01-01" } }) }),
    );
    expect(attr(byId(other, PILOT_ANCHORS.startDate)!, "min")).toBe("2000-01-01");
    expect(attr(byId(other, PILOT_ANCHORS.startDate)!, "max")).toBe("2100-01-01");
  });

  it("says a stored start date cannot be used, keeps the form to mend it, and leaves the field empty", () => {
    const html = pilotPage({
      unusableStartDate: "0026-01-05",
      admin: adminView({
        calendar: {
          startDate: "0026-01-05",
          endDate: null,
          usable: false,
          setAt: "2026-01-02T09:00:00.000Z",
          timesSet: 1,
        },
      }),
    });
    const root = rootOf(html);
    const calendar = readable(byId(root, "calendar")!);
    expect(calendar).toContain("The start date that is stored, 0026-01-05, cannot be used");
    expect(calendar).not.toContain("The pilot starts on");
    expect(calendar).not.toContain("No pilot calendar is set");
    expect(
      all(root, (el) => el.name === "form" && attr(el, "action") === urls.pilotCalendar()),
    ).toHaveLength(1);
    expect(attr(byId(root, PILOT_ANCHORS.startDate)!, "value") ?? "").toBe("");
  });

  it("shows what was typed when the date was refused, in place of the date in force", () => {
    const root = rootOf(pilotPage({ admin: adminView(), draft: { startDate: "2026-02-30" } }));
    expect(attr(byId(root, PILOT_ANCHORS.startDate)!, "value")).toBe("2026-02-30");
  });

  it("posts one box for each person to the roster address, each with a label, ticked as the roster has it", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    const form = all(
      root,
      (el) => el.name === "form" && attr(el, "action") === urls.pilotParticipants(),
    )[0]!;
    expect(all(form, (el) => el.name === "input" && attr(el, "name") === "_csrf")).toHaveLength(1);
    const boxes = all(form, (el) => el.name === "input" && attr(el, "type") === "checkbox");
    expect(boxes.map((b) => attr(b, "name"))).toEqual(PEOPLE.map((p) => trainedField(p.userId)));
    for (const box of boxes) {
      expect(attr(box, "value")).toBe(TRAINED_VALUE);
      const label = all(
        root,
        (el) => el.name === "label" && attr(el, "for") === attr(box, "id"),
      )[0];
      expect(label, attr(box, "name") ?? "").toBeDefined();
    }
    expect(boxes.filter((b) => hasAttr(b, "checked")).map((b) => attr(b, "name"))).toEqual(
      PEOPLE.filter((p) => p.trained).map((p) => trainedField(p.userId)),
    );
    expect(byTag(form, "legend").map((l) => readable(l))).toEqual([
      "People who completed the training",
    ]);
    expect(byTag(form, "button").map((b) => readable(b))).toEqual(["Save who was trained"]);
    // The hint is a hint: it says only that the training matter's steps are all there.
    expect(readable(form)).toContain("A. Ruiz (completed steps 3 to 7 of the training matter)");
    expect(readable(form)).not.toContain("D. Whitfield (completed");
  });

  it("shows what was ticked when the roster was refused, in place of the roster in force", () => {
    const root = rootOf(pilotPage({ admin: adminView(), draft: { trained: ["u_okafor"] } }));
    const ticked = all(
      root,
      (el) => el.name === "input" && attr(el, "type") === "checkbox" && hasAttr(el, "checked"),
    );
    expect(ticked.map((b) => attr(b, "name"))).toEqual([trainedField("u_okafor")]);
  });

  it("holds no form for a role that may not change the pilot, and still says what the roster holds", () => {
    const root = rootOf(pilotPage({ readOnly: true, admin: adminView() }));
    expect(byTag(root, "form").map((f) => attr(f, "action"))).toEqual([urls.session()]);
    expect(readable(byId(root, PILOT_ANCHORS.participants)!)).toContain(
      "2 of 4 people are recorded as trained.",
    );
  });

  it("escapes a name and shows the invisible characters in it", () => {
    const html = pilotPage({
      admin: adminView({
        participants: [
          {
            userId: "u_x",
            name: `<img src=x>${ZWSP}Zed`,
            trained: false,
            completedTraining: false,
          },
        ],
      }),
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain(ZWSP);
  });
});

describe("what a picture of the page shows", () => {
  // The words are written out here, whole, so that a change of the module's constant is a change
  // of this test too: a banner that quietly lost a word would no longer say what it must.
  const BANNER =
    "SYNTHETIC SCOPE: these figures count what demonstration identities did to synthetic matters. They are not pilot data, not adoption, not accuracy and not time saved.";

  it("puts the exact banner words on the synthetic scope, whatever it holds", () => {
    for (const records of [emptyRecords(), f1Records()]) {
      const banner = all(rootOf(pilotPage({ scope: "synthetic", records })), (el) =>
        hasClass(el, "banner-synthetic"),
      );
      expect(banner).toHaveLength(1);
      expect(readable(banner[0]!)).toBe(BANNER);
    }
  });

  it("marks the synthetic scope in the title, the banner, the link and every caption, and the pilot scope in none of them", () => {
    const synthetic = rootOf(pilotPage({ scope: "synthetic", records: f1Records() }));
    const pilot = rootOf(pilotPage({ scope: "pilot", records: f1Records() }));
    expect(readable(byTag(synthetic, "title")[0]!)).toBe(
      "Pilot measures (synthetic scope) | Parol",
    );
    expect(readable(byTag(pilot, "title")[0]!)).toBe("Pilot measures | Parol");
    for (const table of byTag(synthetic, "table"))
      expect(readable(byTag(table, "caption")[0]!)).toMatch(/synthetic scope$/);
    for (const table of byTag(pilot, "table"))
      expect(readable(byTag(table, "caption")[0]!)).not.toMatch(/synthetic/i);
    expect(all(pilot, (el) => hasClass(el, "banner-synthetic"))).toEqual([]);
  });

  it("opens the pilot scope with the sentence that it is empty here, before the calendar, the roster and any table", () => {
    const html = pilotPage({ admin: adminView() });
    const text = readable(rootOf(html));
    const empty = text.indexOf("No pilot data.");
    expect(empty).toBeGreaterThan(-1);
    expect(empty).toBeLessThan(text.indexOf("Pilot calendar"));
    expect(empty).toBeLessThan(text.indexOf("People who were trained"));
    expect(empty).toBeLessThan(text.indexOf("Pilot measures, pilot scope"));
    // It is the first thing after the heading and the scope links: the scope section holds it.
    const scope = byId(rootOf(html), "scope")!;
    expect(readable(scope)).toContain(
      "No pilot data. This database holds no matters, so the pilot scope is empty and every measure below reads no data.",
    );
    const mainText = readable(byTag(rootOf(html), "main")[0]!);
    expect(
      mainText.startsWith(
        "Pilot measuresWhich scope is shownPilot scopeSynthetic scope, a demonstrationNo pilot data.",
      ),
    ).toBe(true);
  });

  it("counts the matters of a database that holds only demonstration matters, and says every one is excluded", () => {
    const only = f1Records();
    const synthetic = {
      ...only,
      matters: only.matters.map((m) => ({ ...m, synthetic: true })),
    };
    const text = readable(
      byId(rootOf(pilotPage({ scope: "pilot", records: synthetic })), "scope")!,
    );
    expect(text).toMatch(
      /No pilot data\. This database holds \d+ matters and every one is synthetic or was made by a demonstration identity/,
    );
  });

  it("states in the population table that a training matter is in neither scope, and how many there are", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const root = rootOf(pilotPage({ scope, records: f1Records() }));
      const table = byTag(root, "table").find((t) =>
        readable(byTag(t, "caption")[0]!).startsWith("Population of the measures"),
      )!;
      const row = all(table, (el) => el.name === "tr").find((tr) =>
        readable(tr).startsWith("Training matters, made by the training exercise."),
      )!;
      expect(readable(byTag(row, "th")[0]!)).toBe(
        "Training matters, made by the training exercise. They are in neither scope.",
      );
      expect(readable(byTag(row, "td")[0]!)).toBe("1");
    }
  });

  it("gives every median its sample size, its minimum and its maximum, and computes no difference, mean or saving", () => {
    const root = rootOf(pilotPage({ scope: "pilot", records: f1Records() }));
    const time = byTag(root, "table").find((t) =>
      readable(byTag(t, "caption")[0]!).startsWith("Active time"),
    )!;
    expect(
      byTag(time, "th")
        .filter((th) => attr(th, "scope") === "col")
        .map((th) => readable(th)),
    ).toEqual([
      "Phase and series",
      "Timed NDAs (n)",
      "Median (minutes)",
      "Minimum (minutes)",
      "Maximum (minutes)",
    ]);
    const assisted = all(time, (el) => el.name === "tr").find(
      (tr) => readable(byTag(tr, "th")[0]!) === "Assisted use (weeks 3 to 5), Associate",
    )!;
    expect(byTag(assisted, "td").map((td) => readable(td))).toEqual(["2", "35.0", "25.0", "45.0"]);
    const satisfaction = byTag(root, "table")
      .flatMap((t) => all(t, (el) => el.name === "tr"))
      .find((tr) => readable(byTag(tr, "th")[0]!).startsWith("Satisfaction"))!;
    expect(readable(byTag(satisfaction, "td")[0]!)).toBe("4.5 (n = 2, minimum 4, maximum 5)");
    // No table names a mean, an average, a saving or a difference: the set of rows is closed.
    for (const table of byTag(root, "table"))
      for (const th of byTag(table, "th"))
        expect(readable(th)).not.toMatch(
          /\b(mean|average|saving|savings|difference|annualised)\b/i,
        );
  });

  it("shows no figure for a person: a name or an id appears in the roster form and in no table", () => {
    const html = pilotPage({ scope: "pilot", records: f1Records(), admin: adminView() });
    const root = rootOf(html);
    for (const table of byTag(root, "table")) {
      const text = readable(table);
      for (const person of PEOPLE) {
        expect(text, person.name).not.toContain(person.name);
        expect(text, person.userId).not.toContain(person.userId);
      }
      for (const th of byTag(table, "th"))
        if (attr(th, "scope") === "col")
          expect(readable(th)).not.toMatch(/\b(person|people|participant|user|who|name)\b/i);
    }
    // The names are in the roster, to be ticked, and in the file's address nowhere.
    const roster = readable(byId(root, PILOT_ANCHORS.participants)!);
    for (const person of PEOPLE) expect(roster).toContain(person.name);
    expect(all(root, (el) => el.name === "a").flatMap((a) => attr(a, "href") ?? "")).not.toContain(
      PEOPLE[0]!.userId,
    );
    for (const link of all(root, (el) => el.name === "a" && hasAttr(el, "href")))
      for (const person of PEOPLE) expect(attr(link, "href")).not.toContain(person.userId);
  });

  it("says in the method lines what the page does not do: judge the acceptance criteria, or share a figure for a person", () => {
    const method = readable(byId(rootOf(pilotPage()), "method")!);
    expect(method).toContain("No figure is given for a person.");
    expect(method).toContain("This page does not judge the acceptance criteria");
    expect(method).toContain("computes no mean, no difference between phases and no saving");
  });
});

describe("every fixture of this package", () => {
  const named = (prefix: string) => VARIANTS_PILOT.filter(([name]) => name.startsWith(prefix));

  it("covers each state the package's pages have", () => {
    const names = VARIANTS_PILOT.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const wanted of [
      "pilot measures, pilot scope, no data, no calendar",
      "pilot measures, synthetic scope, every row with a value",
      "pilot measures, date refused, what was typed kept",
      "pilot measures, the stored start date cannot be used, the form to mend it",
      "pilot measures, roster refused, what was ticked kept",
      "matter page, timer not running, associate",
      "matter page, timer running, associate",
      "matter page, timer running on another matter, associate",
      "matter page, training matter, a timer left running by an earlier build, only the Stop",
      "pane, timer left running on a training matter",
      "matter page, reference list saved",
      "matter page, reference list closed by a review",
      "matter page, reference list, no playbook chosen",
      "matter page, viewer: neither the timer nor the reference list",
      "pane, timer running",
      "pane, reference list open",
    ])
      expect(names, wanted).toContain(wanted);
  });

  it("passes the accessibility rules on every page of the measures and on every pane", () => {
    for (const [name, make, options] of [...named("pilot measures"), ...named("pane,")])
      expect(
        () => expectAccessible(make(), { fragment: options?.fragment === true }),
        name,
      ).not.toThrow();
  });

  it("passes the page rules on every one, matter pages included", () => {
    for (const [name, make, options] of VARIANTS_PILOT)
      expect(() => checkInvariants(make(), options), name).not.toThrow();
  });
});

describe("keyboard and structure", () => {
  const variants = {
    "pilot scope, no data": () => pilotPage({ admin: adminView() }),
    "synthetic scope with values": () =>
      pilotPage({ scope: "synthetic", records: f1Records(), admin: adminView() }),
    "read only": () => pilotPage({ readOnly: true, admin: adminView() }),
  };

  for (const [name, make] of Object.entries(variants))
    it(`passes the page rules and the accessibility rules: ${name}`, () => {
      checkInvariants(make());
      expectAccessible(make());
    });

  it("reaches every control by Tab, in reading order: scope, date, roster, then the tables and the file", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    const stops = tabStops(root);
    const key = (el: El): string =>
      attr(el, "name") ?? attr(el, "href") ?? attr(el, "aria-label") ?? el.name;
    const order = stops.map(key);
    const at = (name: string): number => order.indexOf(name);
    expect(at(urls.pilot("pilot"))).toBeGreaterThan(-1);
    expect(at(urls.pilot("pilot"))).toBeLessThan(at(urls.pilot("synthetic")));
    expect(at(urls.pilot("synthetic"))).toBeLessThan(at(FIELDS.startDate));
    expect(at(FIELDS.startDate)).toBeLessThan(at(trainedField(PEOPLE[0]!.userId)));
    expect(at(trainedField(PEOPLE.at(-1)!.userId))).toBeLessThan(at(urls.pilotCsv("pilot")));
    // No positive tabindex anywhere, and every stop has an accessible name (the rules check both).
    expect(all(root, (el) => Number(attr(el, "tabindex") ?? 0) > 0)).toHaveLength(0);
    // The tables scroll in boxes that can be focused, each with a name.
    const regions = all(root, (el) => attr(el, "role") === "region");
    expect(regions.length).toBeGreaterThanOrEqual(8);
    for (const region of regions)
      expect(attr(region, "aria-label")?.length ?? 0).toBeGreaterThan(5);
  });

  it("has a skip link, one main region and the section ids that the refusals lead to", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    expect(byTag(root, "main")).toHaveLength(1);
    for (const id of [
      "scope",
      "calendar",
      PILOT_ANCHORS.participants,
      "measures",
      "breakdowns",
      "population",
      "method",
      "download",
    ])
      expect(byId(root, id), id).toBeDefined();
    expect(byId(root, PILOT_ANCHORS.startDate)).toBeDefined();
  });

  it("holds every place a refusal of its two forms leads to, so a link of the refused page never dangles", () => {
    const root = rootOf(pilotPage({ admin: adminView() }));
    const codes = ["bad_calendar_date", "unknown_user", "duplicate_user", "too_many_participants"];
    for (const code of codes) {
      const jump = REFUSALS_PILOT.jump[code as keyof typeof REFUSALS_PILOT.jump];
      expect(jump.href.startsWith("#"), code).toBe(true);
      expect(byId(root, jump.href.slice(1)), code).toBeDefined();
    }
    // The date's link leads to the input itself, the roster's to the group of boxes.
    expect(REFUSALS_PILOT.jump.bad_calendar_date.href).toBe(`#${PILOT_ANCHORS.startDate}`);
    expect(REFUSALS_PILOT.jump.unknown_user.href).toBe(`#${PILOT_ANCHORS.participants}`);
  });

  it("is the same page for the same view: no clock, no random value", () => {
    expect(pilotPage({ records: emptyRecords() })).toBe(pilotPage({ records: emptyRecords() }));
  });
});
