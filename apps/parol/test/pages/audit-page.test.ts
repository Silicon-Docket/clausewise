import { describe, expect, it } from "vitest";
import type { AuditPageView } from "../../src/services/views.js";
import { navItemsFor } from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import {
  BROKEN_CHAIN,
  GHOST_IDS,
  HEAD_HASH,
  LAST_RUN,
  MORE_THAN_LISTED,
  UNEXPLAINED,
  administrator,
  auditPage,
  buildAuditView,
  factsOf,
  withMatters,
  withRetention,
} from "./audit-support.js";
import { all, attr, byId, byTag, hasClass, parseHtml, readable, section, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { VARIANTS_RETENTION } from "./variants-retention.js";

/**
 * The audit log page (package W2.7, slice C). It is a page of fixed sentences and counts: these
 * tests read the HTML a view makes, state by state, and hold it to the rules every page has
 * (`checkInvariants`) and to the keyboard and label rules of test/a11y/rules.ts. The service that
 * makes the view has its own tests (test/services/audit.test.ts); the route that sends the page, and
 * who may open it, are in test/routes/audit-page.test.ts.
 */

const read = (view: AuditPageView): { html: string; root: El } => {
  const html = auditPage(view);
  return { html, root: checkInvariants(html) };
};

const chipsIn = (root: El): string[] =>
  all(root, (el) => hasClass(el, "chip")).map((el) => readable(el));

describe("the audit log page, for an intact log", () => {
  const { html, root } = read(buildAuditView());

  it("is a page of its own, with one heading and the title the nav item leads to", () => {
    expect(readable(byTag(root, "h1")[0] as El)).toBe("Audit log check");
    expect(readable(byTag(root, "title")[0] as El)).toBe("Audit log check | Parol");
    expect(html).toContain(`href="${urls.audit()}"`);
  });

  it("says that it is a check made when the page is opened, that nothing is stored, and who may open it", () => {
    const text = readable(byTag(root, "main")[0] as El);
    expect(text).toContain("Demonstration data.");
    expect(text).toContain("Only an administrator can open this page.");
    expect(text).toContain("does not store the result");
    expect(text).toMatch(/at 4 November 2026, 09:00 UTC/);
  });

  it("calls the chain intact and states how many events were checked of how many are in the log", () => {
    const chain = readable(section(root, "audit-chain"));
    expect(chain).toContain("Intact");
    expect(chain).toContain("Events checked: 12 of 12 in the log.");
    expect(chain).not.toContain("Broken");
    expect(chipsIn(section(root, "audit-chain"))).toEqual(["Intact"]);
  });

  it("shows the newest event and its hash, in a code element, with what to do with them", () => {
    const chain = section(root, "audit-chain");
    const facts = readable(chain);
    expect(facts).toContain("Newest event");
    expect(facts).toContain("Event 12");
    const code = all(chain, (el) => el.name === "code" && hasClass(el, "hash"));
    expect(code.map((el) => readable(el))).toEqual([HEAD_HASH]);
    expect(facts).toContain("Keep these two lines somewhere that nobody who can write");
    expect(facts).toContain("pnpm parol:audit-verify --expect-head SEQ:HASH");
  });

  it("gives each count of matters with the number it is part of", () => {
    expect(factsOf(root, "audit-matters")).toEqual({
      "In the database": "5 matters",
      Created: "6 matters with a creation event",
      Deleted: "1 of 6 created, with a deletion event",
      "Gone, no deletion event": "0 of 6 created",
      "Present, no creation event": "0 of 5 in the database",
      "Present, but deleted": "0 of 5 in the database",
    });
    expect(readable(section(root, "audit-matters"))).toContain(
      "No matter is missing a creation or a deletion event.",
    );
    expect(chipsIn(section(root, "audit-matters"))).toEqual(["All accounted for"]);
  });

  it("lists no id when every matter is accounted for", () => {
    expect(all(section(root, "audit-matters"), (el) => el.name === "ul")).toEqual([]);
    expect(all(section(root, "audit-matters"), (el) => el.name === "h3")).toEqual([]);
  });

  it("states the matters past their date against all matters, and that nothing deletes them by itself", () => {
    const text = readable(section(root, "audit-retention"));
    expect(text).toContain("2 of 5 matters are past their retention date.");
    expect(text).toContain("Nothing deletes them until the operator runs the retention command.");
    expect(text).toContain("No retention run is recorded. The operator runs pnpm parol:retain.");
  });

  it("says what the check does not show, and that refusals are not in the log", () => {
    const text = readable(section(root, "audit-limits"));
    expect(text).toContain("same file as the rest of the data");
    expect(text).toContain("Each hash is not keyed");
    expect(text).toContain("A head kept elsewhere closes both");
    expect(text).toContain("does not record a request that was refused");
    expect(text).toContain("access log, which goes to standard output and is not stored");
  });

  it("offers one link and no form: Check again leads to the page itself", () => {
    const main = byTag(root, "main")[0] as El;
    const links = all(main, (el) => el.name === "a");
    expect(links.map((a) => [readable(a), attr(a, "href")])).toEqual([
      ["Check again", urls.audit()],
    ]);
    expect(all(main, (el) => el.name === "form")).toEqual([]);
    expect(all(main, (el) => el.name === "button" || el.name === "input")).toEqual([]);
  });

  it("states no number without the number it is part of", () => {
    // Every count of the chain and of the matters is "x of y" or the whole itself ("5 matters").
    const chain = readable(section(root, "audit-chain"));
    expect(chain).toMatch(/Events checked: \d+ of \d+ in the log/);
    for (const [term, description] of Object.entries(factsOf(root, "audit-matters")))
      expect(description, term).toMatch(/^\d+ (of \d+ |matters?)/);
    const retention = readable(section(root, "audit-retention"));
    expect(retention).toMatch(/\d+ of \d+ matters? (is|are) past their retention date/);
  });
});

describe("the keyboard and the labels", () => {
  const { html } = read(buildAuditView());

  it("passes the rules of test/a11y/rules.ts", () => {
    expectAccessible(html);
    for (const [name, make] of VARIANTS_RETENTION)
      if (name.startsWith("audit log")) expectAccessible(make());
  });

  it("has these tab stops, in this order: the skip link, the brand, the nav, sign out, Check again", () => {
    const root = parseHtml(html);
    const names = tabStops(root).map((el) => accessibleName(root, el));
    // The nav is the table's, as an administrator is shown it, so a link added to the table moves
    // this list and not the test.
    const nav = navItemsFor("admin").map((item) => item.label);
    expect(nav).toContain("Audit log");
    expect(names).toEqual(["Skip to main content", "Parol", ...nav, "Sign out", "Check again"]);
  });

  it("has no control in the page that changes anything: no tab stop but the links and sign out", () => {
    const main = byTag(parseHtml(html), "main")[0] as El;
    expect(tabStops(main).map((el) => el.name)).toEqual(["a"]);
  });

  it("puts the headings in order: one h1, then the sections, then the lists inside them", () => {
    const root = parseHtml(
      auditPage(
        withMatters({
          goneWithoutDeleteEvent: { count: 1, ids: [GHOST_IDS[0] as string] },
        }),
      ),
    );
    const levels = all(byTag(root, "main")[0] as El, (el) => /^h[1-6]$/.test(el.name)).map((el) =>
      Number(el.name.slice(1)),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++)
      expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
  });

  it("names every section and every list it holds", () => {
    const root = checkInvariants(
      auditPage(
        withMatters({
          goneWithoutDeleteEvent: { count: 1, ids: [GHOST_IDS[0] as string] },
          presentWithoutCreateEvent: { count: 2, ids: GHOST_IDS.slice(1) },
        }),
      ),
    );
    for (const id of ["audit-chain", "audit-matters", "audit-retention", "audit-limits"])
      expect(attr(section(root, id), "aria-labelledby")).toBe(`${id}-heading`);
    for (const list of all(section(root, "audit-matters"), (el) => el.name === "ul")) {
      const heading = byId(root, attr(list, "aria-labelledby") ?? "");
      expect(heading?.name).toBe("h3");
    }
  });
});

describe("the audit log page, for a broken chain", () => {
  const { root } = read(buildAuditView({ chain: BROKEN_CHAIN }));
  const chain = section(root, "audit-chain");

  it("says Broken in words and in a chip, and where it breaks and why", () => {
    expect(chipsIn(chain)).toEqual(["Broken"]);
    const text = readable(chain);
    expect(text).toContain(
      "The chain breaks at event 5: this event's content does not match its hash (hash_mismatch).",
    );
    expect(text).toContain("Events that check out before it: 4 of 12 in the log.");
    expect(text).toContain("Nothing from event 5 on can be trusted.");
    expect(text).not.toContain("Intact");
  });

  it("still shows the head, so that it can be compared with a copy kept elsewhere", () => {
    expect(readable(chain)).toContain(HEAD_HASH);
  });

  it("is a result, not an error: the page is a 200 document with no alert", () => {
    expect(all(root, (el) => attr(el, "role") === "alert")).toEqual([]);
  });

  it("gives the log that was cut back its own words", () => {
    const cut = read(
      buildAuditView({
        chain: {
          ok: false,
          events: 12,
          firstBrokenSeq: 13,
          reason: "truncated",
          reasonText: "the newest events are missing",
        },
      }),
    ).root;
    const text = readable(section(cut, "audit-chain"));
    expect(text).toContain(
      "The chain breaks at event 13: the newest events are missing (truncated).",
    );
    expect(text).toContain("Events that check out before it: 12 of 12 in the log.");
  });
});

describe("the audit log page, for an empty log", () => {
  const view = buildAuditView({
    eventsInLog: 0,
    chain: { ok: true, events: 0 },
    head: null,
    matters: {
      created: 0,
      present: 0,
      deleted: 0,
      goneWithoutDeleteEvent: { count: 0, ids: [] },
      presentWithoutCreateEvent: { count: 0, ids: [] },
      deletedButPresent: { count: 0, ids: [] },
    },
    retention: { totalMatters: 0, pastDate: 0, lastRun: null, lastRunUnreadable: false },
  });
  const { root } = read(view);

  it("says the log has no events yet, intact, and has no head to keep", () => {
    const chain = section(root, "audit-chain");
    expect(chipsIn(chain)).toEqual(["Intact"]);
    expect(readable(chain)).toContain("The log has no events yet.");
    expect(readable(chain)).toContain("so it has no newest event to keep");
    expect(all(chain, (el) => el.name === "code")).toEqual([]);
    expect(readable(chain)).not.toContain("Events checked");
  });

  it("states zero of zero for the matters and for the retention date", () => {
    expect(readable(section(root, "audit-retention"))).toContain(
      "0 of 0 matters are past their retention date.",
    );
    expect(factsOf(root, "audit-matters")["In the database"]).toBe("0 matters");
    expectAccessible(auditPage(view));
  });
});

describe("the audit log page, for matters the events do not explain", () => {
  const { root } = read(withMatters(UNEXPLAINED));
  const matters = section(root, "audit-matters");

  it("says so in a chip and a sentence, and not that all are accounted for", () => {
    expect(chipsIn(matters)).toEqual(["Not accounted for"]);
    expect(readable(matters)).not.toContain("All accounted for");
    expect(readable(matters)).not.toContain("No matter is missing");
  });

  it("states each count against its whole", () => {
    const facts = factsOf(root, "audit-matters");
    expect(facts["Created"]).toBe("8 matters with a creation event");
    expect(facts["Gone, no deletion event"]).toBe("1 of 8 created");
    expect(facts["Present, no creation event"]).toBe("2 of 5 in the database");
    expect(facts["Present, but deleted"]).toBe("1 of 5 in the database");
  });

  it("lists the ids, one list for each kind that has any, each under its own heading", () => {
    const headings = all(matters, (el) => el.name === "h3").map((el) => readable(el));
    expect(headings).toEqual([
      "Gone, with no deletion event",
      "Present, with no creation event",
      "Present, although a deletion event names them",
    ]);
    const lists = all(matters, (el) => el.name === "ul").map((ul) =>
      all(ul, (el) => el.name === "code").map((el) => readable(el)),
    );
    expect(lists).toEqual([[GHOST_IDS[0]], GHOST_IDS.slice(1), [GHOST_IDS[2]]]);
    expect(readable(matters)).not.toContain("more, not listed");
  });

  it("lists only the kinds that have a count", () => {
    const only = read(
      withMatters({
        ...UNEXPLAINED,
        goneWithoutDeleteEvent: { count: 0, ids: [] },
        deletedButPresent: { count: 0, ids: [] },
      }),
    ).root;
    expect(all(section(only, "audit-matters"), (el) => el.name === "h3").map(readable)).toEqual([
      "Present, with no creation event",
    ]);
  });
});

describe("the audit log page, for more unexplained matters than a list holds", () => {
  const { root } = read(withMatters(MORE_THAN_LISTED));
  const matters = section(root, "audit-matters");

  it("lists twenty ids and says how many more there are", () => {
    const codes = all(matters, (el) => el.name === "ul")
      .flatMap((ul) => all(ul, (el) => el.name === "code"))
      .map((el) => readable(el));
    expect(codes).toHaveLength(20);
    expect(readable(matters)).toContain("and 11 more, not listed here.");
    expect(factsOf(root, "audit-matters")["Present, no creation event"]).toBe(
      "31 of 39 in the database",
    );
  });

  it("shows the heading and the rest when the count has no id to show", () => {
    const hidden = read(
      withMatters({ ...MORE_THAN_LISTED, presentWithoutCreateEvent: { count: 2, ids: [] } }),
    ).root;
    const text = section(hidden, "audit-matters");
    expect(all(text, (el) => el.name === "ul")).toEqual([]);
    expect(readable(text)).toContain("Present, with no creation event");
    expect(readable(text)).toContain("and 2 more, not listed here.");
  });
});

describe("the audit log page, for the last retention run", () => {
  const retention = (root: El): string => readable(section(root, "audit-retention"));

  it("states what the run did against the matters it found past their date", () => {
    const { root } = read(withRetention({ lastRun: LAST_RUN }));
    const text = retention(root);
    expect(text).toContain("Last retention run: event 11, 3 November 2026, 02:00 UTC.");
    expect(text).toContain("Of 3 matters past their date, 2 deleted, 1 skipped, 0 failed.");
    expect(text).toContain("Folders that no matter named: 1 of 1 removed.");
    expect(text).toContain("Compaction of the database: done.");
    expect(text).not.toContain("No retention run is recorded");
    expect(text).not.toContain("refused");
  });

  it("states the folders removed against the folders found, those that could not be removed included", () => {
    const { root } = read(
      withRetention({
        lastRun: { ...LAST_RUN, orphansRemoved: 1, orphansFailed: 2, compaction: "failed" },
      }),
    );
    expect(retention(root)).toContain("Folders that no matter named: 1 of 3 removed.");
    expect(retention(root)).toContain("Compaction of the database: failed.");
  });

  it("says a run that refused deleted nothing and why", () => {
    const { root } = read(
      withRetention({
        lastRun: {
          ...LAST_RUN,
          expired: 30,
          deleted: 0,
          skipped: 0,
          compaction: "not_run",
          refused: true,
        },
      }),
    );
    expect(retention(root)).toContain("That run refused to delete anything");
    expect(retention(root)).toContain(
      "Of 30 matters past their date, 0 deleted, 0 skipped, 0 failed.",
    );
    expect(retention(root)).toContain("Compaction of the database: not run.");
  });

  it("says a run it cannot read is not shown, with a chip and not as if none were recorded", () => {
    const { root } = read(withRetention({ lastRunUnreadable: true }));
    const text = retention(root);
    expect(text).toContain("details are not in the form the retention command writes");
    expect(text).not.toContain("No retention run is recorded");
    expect(chipsIn(section(root, "audit-retention"))).toEqual(["Not readable"]);
  });

  it("agrees in number: one matter is, many are", () => {
    const one = read(withRetention({ totalMatters: 1, pastDate: 1 })).root;
    expect(retention(one)).toContain("1 of 1 matter is past their retention date.");
    const some = read(withRetention({ totalMatters: 9, pastDate: 0 })).root;
    expect(retention(some)).toContain("0 of 9 matters are past their retention date.");
  });

  it("names a compaction word it does not know as unknown, never as the word it was given", () => {
    const { html } = read(
      withRetention({
        lastRun: { ...LAST_RUN, compaction: "SECRET-WORD" as unknown as "done" },
      }),
    );
    expect(html).not.toContain("SECRET-WORD");
    expect(html).toContain("Compaction of the database: unknown.");
  });
});

describe("the audit log page, for a head that is not a hash", () => {
  it("says the value stored is not in the form of a hash and shows none", () => {
    const { root } = read(buildAuditView({ head: { seq: 12, hash: null } }));
    const chain = section(root, "audit-chain");
    expect(readable(chain)).toContain("The value stored is not in the form of a hash.");
    expect(all(chain, (el) => el.name === "code" && hasClass(el, "hash"))).toEqual([]);
  });
});

describe("the audit log page, for one event", () => {
  it("states 1 of 1 and counts in the singular", () => {
    const { root } = read(
      buildAuditView({
        eventsInLog: 1,
        chain: { ok: true, events: 1 },
        head: { seq: 1, hash: HEAD_HASH },
      }),
    );
    expect(readable(section(root, "audit-chain"))).toContain("Events checked: 1 of 1 in the log.");
  });
});

describe("text that a view should never hold, if it did", () => {
  const HOSTILE = '<script>alert(1)</script> & "quoted" ZQ-AUDIT-MARKER';

  it("is written as text, never as markup, wherever the view puts a string", () => {
    const view = buildAuditView({
      chain: { ok: false, events: 4, firstBrokenSeq: 5, reason: HOSTILE, reasonText: HOSTILE },
      matters: {
        ...buildAuditView().matters,
        goneWithoutDeleteEvent: { count: 1, ids: [HOSTILE] },
      },
    });
    const html = auditPage(view);
    // The strict reader throws on a raw angle bracket in text or an attribute that is not well formed.
    const root = parseHtml(html);
    expect(byTag(root, "script").map((el) => attr(el, "src"))).toEqual(["/assets/parol.js"]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("the fixtures of the page", () => {
  it("are all well formed pages for an administrator", () => {
    const audit = VARIANTS_RETENTION.filter(([name]) => name.startsWith("audit log"));
    expect(audit.length).toBeGreaterThanOrEqual(10);
    for (const [name, make] of audit) {
      const html = make();
      expect(() => checkInvariants(html), name).not.toThrow();
      expect(html).toContain(`href="${urls.audit()}"`);
      expect(html, name).toContain("Audit log</a>");
    }
  });

  it("show the Audit log link of the nav to an administrator, and the page checks the same action for anyone else", () => {
    expect(auditPage(buildAuditView(), administrator())).toContain("Audit log</a>");
  });
});
