import { describe, expect, it } from "vitest";
import { REFUSALS_PILOT } from "../../src/server/routes/refusals-pilot.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { PILOT_ANCHORS, TIMER_INTENTS } from "../../src/server/pages/pilotfields.js";
import { urls } from "../../src/server/urls.js";
import {
  TIMER_ELSEWHERE,
  TIMER_HEADING,
  TIMER_NONE_YET,
  TIMER_NOTE,
  TIMER_NOT_RUNNING,
  TIMER_OWN_ONLY,
  TIMER_RUNNING_HINT,
  TIMER_RUNNING_SINCE,
  TIMER_START_LABEL,
  TIMER_STOP_LABEL,
  formatDuration,
  timedSentence,
} from "../../src/server/views/pilot.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, parseHtml, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import {
  buildTimer,
  matterPagePilot,
  timerPane,
  violationsAddedByPanels,
} from "./pilot-support.js";
import { IDS } from "./support.js";

/**
 * The timer of a matter (package W2.6b), as a section of the matter page: each state of it, that it
 * is the signed-in person's own and is given to a role that may time a matter only, the words it
 * uses, and that its one button is native, named for what it does and reached by Tab in reading
 * order. The routes that receive the form are in test/routes/pilot.test.ts; the numbers it shows are
 * the person's own closed sessions, which the store sums.
 */

const SINCE = "2026-11-03T14:05:00.000Z";

const RUNNING = buildTimer({ running: { since: SINCE }, closedSeconds: 4521, sessions: 3 });
const STOPPED = buildTimer({ closedSeconds: 4521, sessions: 3 });
const ELSEWHERE = buildTimer({ elsewhere: true });

/** The pane, audited as a pane, and the section in it. */
function sectionOf(html: string): { root: El; section: El } {
  const root = expectAccessible(html, { fragment: true });
  const section = byId(root, PILOT_ANCHORS.timer);
  if (section === undefined) throw new Error("the pane has no timer section");
  return { root, section };
}

const buttonsOf = (root: El): El[] => byTag(root, "button");

describe("the timer section, with no timer running", () => {
  const { section } = sectionOf(timerPane(STOPPED));

  it("is a section of its own, named by a heading, with the note of what the times are used for", () => {
    expect(section.name).toBe("section");
    expect(attr(section, "id")).toBe("time");
    expect(attr(section, "aria-labelledby")).toBe("time-heading");
    expect(readable(byId(section, "time-heading") as El)).toBe("Time on this matter");
    expect(readable(section)).toContain(
      "The pilot measures page uses these times. A timer runs from Start to Stop, so press Stop when you pause.",
    );
  });

  it("says that no timer is running and offers one button, Start timer, in a form to the timer route with the token", () => {
    expect(readable(section)).toContain("No timer is running on this matter.");
    const forms = byTag(section, "form");
    expect(forms).toHaveLength(1);
    const form = forms[0] as El;
    expect(attr(form, "method")).toBe("post");
    expect(attr(form, "action")).toBe(urls.matterTimer(IDS.matter));
    expect(all(form, (el) => el.name === "input" && attr(el, "name") === "_csrf")).toHaveLength(1);
    const buttons = buttonsOf(section);
    expect(buttons.map((b) => readable(b))).toEqual(["Start timer"]);
    expect(attr(buttons[0] as El, "name")).toBe(FIELDS.intent);
    expect(attr(buttons[0] as El, "value")).toBe("start");
    expect(attr(buttons[0] as El, "type")).toBe("submit");
    expect(readable(section)).not.toContain("Stop timer");
    expect(all(section, (el) => hasClass(el, "chip"))).toEqual([]);
  });

  it("adds up the person's closed sessions, says whose they are, and says nothing about a running one", () => {
    const text = readable(section);
    expect(text).toContain("You have 3 stopped sessions on this matter, 1 hour 15 minutes in all.");
    expect(text).toContain(
      "These are your own sessions on this matter. The pilot measures page shows medians over NDAs, never a figure for one person.",
    );
    expect(text).not.toContain("A timer is running since");
  });
});

describe("the timer section, with a timer running", () => {
  const { section } = sectionOf(timerPane(RUNNING));

  it("says since when it runs, in a chip with a shape and the word and in the sentence, not by colour", () => {
    const chips = all(section, (el) => hasClass(el, "chip"));
    expect(chips.map((c) => readable(c))).toEqual(["Running"]);
    expect(all(chips[0] as El, (el) => hasClass(el, "shape"))).toHaveLength(1);
    expect(readable(section)).toContain("A timer is running since 3 November 2026, 14:05 UTC.");
    const time = byTag(section, "time");
    expect(time.map((t) => attr(t, "datetime"))).toEqual([SINCE]);
  });

  it("offers one button, Stop timer, and none to start another", () => {
    const buttons = buttonsOf(section);
    expect(buttons.map((b) => readable(b))).toEqual(["Stop timer"]);
    expect(attr(buttons[0] as El, "name")).toBe(FIELDS.intent);
    expect(attr(buttons[0] as El, "value")).toBe("stop");
    expect(byTag(section, "form")).toHaveLength(1);
    expect(attr(byTag(section, "form")[0] as El, "action")).toBe(urls.matterTimer(IDS.matter));
    expect(readable(section)).not.toContain("Start timer");
    expect(readable(section)).not.toContain("No timer is running");
  });

  it("says what a running timer counts, and still totals only the closed sessions", () => {
    const text = readable(section);
    expect(text).toContain(
      "It counts every second from Start to Stop, including time away from the screen, and is added to your total when you stop it.",
    );
    expect(text).toContain("You have 3 stopped sessions on this matter, 1 hour 15 minutes in all.");
  });

  it("shows when the timer began and does not read a clock: the same view gives the same page", () => {
    expect(timerPane(RUNNING)).toBe(timerPane(RUNNING));
    // The elapsed time is not on the page; only the closed total and the start are.
    expect(readable(sectionOf(timerPane(RUNNING)).section)).not.toMatch(/\bago\b|elapsed/i);
  });
});

describe("the timer section, with a timer running on another matter", () => {
  const { section } = sectionOf(timerPane(ELSEWHERE));

  it("offers no button and no form, and says to stop the other timer first, naming no matter", () => {
    expect(buttonsOf(section)).toEqual([]);
    expect(byTag(section, "form")).toEqual([]);
    expect(byTag(section, "a")).toEqual([]);
    const text = readable(section);
    expect(text).toContain(
      "You have a timer running on another matter. Stop it there first, then start one here.",
    );
    expect(text).not.toContain("No timer is running");
    expect(readable(all(section, (el) => hasClass(el, "chip"))[0] as El)).toBe("Running elsewhere");
  });

  it("says that nothing has been timed yet when no session was stopped here", () => {
    expect(readable(section)).toContain("You have not stopped a timer on this matter yet.");
  });

  it("shows the running state of this matter when both would hold, so a Stop button is never withheld", () => {
    const { section: both } = sectionOf(
      timerPane(buildTimer({ running: { since: SINCE }, elsewhere: true })),
    );
    expect(buttonsOf(both).map((b) => readable(b))).toEqual(["Stop timer"]);
  });
});

describe("who is given the section", () => {
  it("leaves it out for a role that may not time a matter, and when the service gave no view", () => {
    expect(timerPane(buildTimer({ allowed: false, running: { since: SINCE }, sessions: 2 }))).toBe(
      "",
    );
    expect(timerPane(undefined)).toBe("");
  });

  it("is on the matter page of an associate and of a reviewing attorney, and not on a viewer's", () => {
    for (const role of ["associate", "reviewer"] as const) {
      const root = checkInvariants(matterPagePilot(role, { timer: STOPPED }));
      expect(byId(root, "time"), role).toBeDefined();
    }
    const viewer = checkInvariants(
      matterPagePilot("viewer", { timer: buildTimer({ allowed: false }) }),
    );
    expect(byId(viewer, "time")).toBeUndefined();
    expect(readable(viewer)).not.toContain("Start timer");
    // A page the service gave no timer for has none either.
    expect(byId(checkInvariants(matterPagePilot("associate")), "time")).toBeUndefined();
  });

  it("is placed after the memos and before the people, so Tab reaches it in the order of the page", () => {
    const root = checkInvariants(matterPagePilot("associate", { timer: STOPPED }));
    const order = all(root, (el) => el.name === "section").map((s) => attr(s, "id"));
    expect(order.indexOf("time")).toBeGreaterThan(order.indexOf("memos"));
    expect(order.indexOf("time")).toBeLessThan(order.indexOf("people"));
  });
});

describe("keyboard and labels", () => {
  const states: [string, string][] = [
    ["no timer running", timerPane(STOPPED)],
    ["a timer running", timerPane(RUNNING)],
    ["a timer running elsewhere", timerPane(ELSEWHERE)],
    ["nothing timed yet", timerPane(buildTimer())],
  ];

  for (const [name, html] of states)
    it(`passes the accessibility rules as a pane: ${name}`, () => {
      expectAccessible(html, { fragment: true });
    });

  it("gives the button one tab stop in each state that has a button, named for what it does", () => {
    const stops = (html: string): string[] => {
      const root = expectAccessible(html, { fragment: true });
      return tabStops(root).map((el) => accessibleName(root, el));
    };
    expect(stops(timerPane(STOPPED))).toEqual(["Start timer"]);
    expect(stops(timerPane(RUNNING))).toEqual(["Stop timer"]);
    expect(stops(timerPane(ELSEWHERE))).toEqual([]);
  });

  it("is a native submit button: operated by Enter and Space, with no script and no tabindex", () => {
    const root = expectAccessible(timerPane(RUNNING), { fragment: true });
    const button = buttonsOf(root)[0] as El;
    expect(button.name).toBe("button");
    expect(hasAttr(button, "tabindex")).toBe(false);
    expect(hasAttr(button, "disabled")).toBe(false);
    expect(byTag(root, "script")).toEqual([]);
    expect(all(root, (el) => hasAttr(el, "data-zone"))).toEqual([]);
  });

  it("adds no problem to the matter page: the page rules hold, and the accessibility rules find nothing the page did not have without it", () => {
    for (const role of ["associate", "reviewer"] as const)
      for (const timer of [STOPPED, RUNNING, ELSEWHERE]) {
        checkInvariants(matterPagePilot(role, { timer }));
        expect(violationsAddedByPanels(role, { timer }), `${role}`).toEqual([]);
      }
  });

  it("puts the timer button after the table of reviews and before the people form on the matter page", () => {
    const root = parseHtml(matterPagePilot("associate", { timer: STOPPED }));
    const names = tabStops(root).map((el) => accessibleName(root, el));
    const at = names.indexOf("Start timer");
    expect(at).toBeGreaterThan(-1);
    expect(names.slice(0, at)).toContain("Open the issue table");
    // The people form comes after it, and nothing of the page's own is moved: the order of the
    // other stops is what it was without the panel.
    expect(names.slice(at + 1)).toContain("Add a person");
    const bare = parseHtml(matterPagePilot("associate"));
    const without = tabStops(bare).map((el) => accessibleName(bare, el));
    expect(names.filter((name) => name !== "Start timer")).toEqual(without);
  });
});

describe("the words", () => {
  it("are fixed: the heading, the note, the two buttons and the two states", () => {
    expect(TIMER_HEADING).toBe("Time on this matter");
    expect(TIMER_NOTE).toBe(
      "The pilot measures page uses these times. A timer runs from Start to Stop, so press Stop when you pause.",
    );
    expect(TIMER_START_LABEL).toBe("Start timer");
    expect(TIMER_STOP_LABEL).toBe("Stop timer");
    expect(TIMER_NOT_RUNNING).toBe("No timer is running on this matter.");
    expect(TIMER_ELSEWHERE).toBe(
      "You have a timer running on another matter. Stop it there first, then start one here.",
    );
    expect(TIMER_RUNNING_SINCE).toBe("A timer is running since");
    expect(TIMER_NONE_YET).toBe("You have not stopped a timer on this matter yet.");
    expect(TIMER_OWN_ONLY).toContain("never a figure for one person");
    expect(TIMER_RUNNING_HINT).toContain("added to your total when you stop it");
  });

  it("post the two values the route reads, and the refusals name the buttons by these words", () => {
    expect(TIMER_INTENTS).toEqual({ start: "start", stop: "stop" });
    // The sentence that tells a person what to press is the label of the button.
    expect(REFUSALS_PILOT.todo.no_open_timer).toContain(TIMER_START_LABEL);
    expect(REFUSALS_PILOT.phrases.timer_open).toContain("Stop it before starting another one.");
    expect(REFUSALS_PILOT.jump.no_open_timer.href).toBe(`#${PILOT_ANCHORS.timer}`);
    expect(TIMER_ELSEWHERE).toContain("Stop it there first");
  });

  it("state no figure of their own, no rate and no claim of time saved", () => {
    const all_ = [
      TIMER_HEADING,
      TIMER_NOTE,
      TIMER_NOT_RUNNING,
      TIMER_ELSEWHERE,
      TIMER_NONE_YET,
      TIMER_OWN_ONLY,
      TIMER_RUNNING_HINT,
      timedSentence(2, 90),
    ].join(" ");
    expect(all_).not.toMatch(/saved|faster|average|mean\b|%|adoption|accura/i);
  });
});

describe("the length of time in words", () => {
  const cases: [number, string][] = [
    [0, "0 seconds"],
    [1, "1 second"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [61, "1 minute 1 second"],
    [125, "2 minutes 5 seconds"],
    [3599, "59 minutes 59 seconds"],
    [3600, "1 hour"],
    [3659, "1 hour"],
    [3660, "1 hour 1 minute"],
    [4521, "1 hour 15 minutes"],
    [7200, "2 hours"],
    [90061, "25 hours 1 minute"],
  ];
  for (const [seconds, words] of cases)
    it(`reads ${seconds} seconds as ${words}`, () => {
      expect(formatDuration(seconds)).toBe(words);
    });

  it("never shows a sign, a decimal or a non-number", () => {
    expect(formatDuration(-5)).toBe("0 seconds");
    expect(formatDuration(59.9)).toBe("59 seconds");
    expect(formatDuration(Number.NaN)).toBe("0 seconds");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0 seconds");
  });

  it("says one session in the singular, and nothing timed when there is none", () => {
    expect(timedSentence(1, 61)).toBe(
      "You have 1 stopped session on this matter, 1 minute 1 second in all.",
    );
    expect(timedSentence(0, 0)).toBe("You have not stopped a timer on this matter yet.");
  });
});
