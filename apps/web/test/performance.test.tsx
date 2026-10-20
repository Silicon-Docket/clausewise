// @vitest-environment jsdom
import type { Finding, Severity } from "@clausewise/api";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingCard } from "../src/components/FindingCard.js";
import { AnnouncerProvider } from "../src/hooks/useAnnounce.js";
import { useReview } from "../src/hooks/useReview.js";
import { createServices, ServicesProvider } from "../src/services.js";
import { createFakeServer, type FakeServer } from "./fakeServer.js";
import { ORIGINAL, REPLACEMENT, appliedFinding, reviewDetail } from "./fixtures.js";
import { advance, installCommonHooks, renderApp, useFakeClock } from "./support.js";

// A card draws the lawyer's wording once each time it is drawn, so the calls to that function are
// a count of how often each card was drawn. The real function still does the work.
const counts = vi.hoisted(() => ({
  cards: new Map<string, number>(),
  screens: { reviewScreen: 0 },
}));

vi.mock("../src/lib/findings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/findings.js")>();
  return {
    ...actual,
    effectiveReplacement: (finding: Finding) => {
      counts.cards.set(finding.ruleId, (counts.cards.get(finding.ruleId) ?? 0) + 1);
      return actual.effectiveReplacement(finding);
    },
  };
});

// The review screen asks for its title each time it is drawn, so this counts its draws.
vi.mock("../src/hooks/useDocumentTitle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useDocumentTitle.js")>();
  return {
    useDocumentTitle: (title: string) => {
      if (title === "Big contract.docx") counts.screens.reviewScreen += 1;
      actual.useDocumentTitle(title);
    },
  };
});

installCommonHooks();
afterEach(() => {
  counts.cards.clear();
  counts.screens.reviewScreen = 0;
});

const SEVERITIES: Severity[] = ["high", "medium", "low"];
const TOTAL = 60;

/** A finding with a long clause, as a long contract has: several thousand characters. */
function bigFinding(index: number): Finding {
  const lead = `Clause ${index}. ${"The parties agree to the usual terms of this agreement. ".repeat(80)}`;
  const paragraph = `${lead}${ORIGINAL} after the date of disclosure.`;
  const start = lead.length;
  return appliedFinding({
    ruleId: `rule-${index}`,
    title: `Finding ${index}`,
    severity: SEVERITIES[index % 3] as Severity,
    clauses: [{ id: `c${index}`, number: `${index}`, heading: null, text: paragraph }],
    edit: {
      kind: "applied",
      original: ORIGINAL,
      replacement: REPLACEMENT,
      paragraphText: paragraph,
      start,
      end: start + ORIGINAL.length,
    },
  });
}

const bigFindings = (): Finding[] => Array.from({ length: TOTAL }, (_, index) => bigFinding(index));
const ruleIds = (): string[] => bigFindings().map((finding) => finding.ruleId);

const snapshot = (): Map<string, number> => new Map(counts.cards);
/** How many times each card was drawn since `before`. */
function drawnSince(before: Map<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  for (const id of ruleIds()) result.set(id, (counts.cards.get(id) ?? 0) - (before.get(id) ?? 0));
  return result;
}
const drawn = (since: Map<string, number>): string[] =>
  [...since].filter(([, times]) => times > 0).map(([id]) => id);

describe("a review with sixty findings and long clauses", () => {
  const open = (extra: Partial<Parameters<typeof reviewDetail>[0]> = {}) =>
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({ documentName: "Big contract.docx", findings: bigFindings(), ...extra }),
      ],
    });

  it("draws each card once to begin with", async () => {
    open();
    await screen.findAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(TOTAL);
    const first = drawnSince(new Map());
    // The count is how the next tests see a card being drawn; it must see every card.
    expect([...first.values()].every((times) => times >= 1)).toBe(true);
    expect([...first.values()].every((times) => times <= 2)).toBe(true);
  });

  it("draws only the card that was decided on, when one decision is saved", async () => {
    const { user } = open();
    await screen.findAllByRole("article");
    const before = snapshot();

    await user.click(
      within(screen.getByRole("article", { name: "Finding 7" })).getByRole("button", {
        name: "Accept",
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent("1 accepted");
    });
    await waitFor(() => {
      expect(screen.getByRole("article", { name: "Finding 7" })).toHaveAttribute(
        "aria-busy",
        "false",
      );
    });
    // The screen above was drawn again a number of times; fifty-nine cards did not move.
    expect(drawn(drawnSince(before))).toEqual(["rule-7"]);
  });

  it("draws no card for the lawyer's wording being typed into another", async () => {
    const { user } = open();
    await screen.findAllByRole("article");
    await user.click(
      within(screen.getByRole("article", { name: "Finding 3" })).getByRole("button", {
        name: "Edit wording",
      }),
    );
    const before = snapshot();
    await user.type(screen.getByRole("textbox", { name: "Your wording" }), " and more");
    expect(drawn(drawnSince(before))).toEqual([]);
  });

  it("draws a card at most twice more for a change to all of them, and not again for the read after it", async () => {
    const { user } = open();
    await screen.findAllByRole("article");
    const before = snapshot();

    await user.click(screen.getByRole("button", { name: "Accept all medium" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent("20 accepted");
    });
    await waitFor(() => {
      expect(
        screen.getAllByRole("article").every((a) => a.getAttribute("aria-busy") === "false"),
      ).toBe(true);
    });
    const since = drawnSince(before);
    // Every card is busy while the change is saved, which is one draw on and one draw off. The
    // server's answer is read again afterwards; it is the same for the cards it did not touch, and
    // for the ones it did, which the screen had already changed in the same way.
    for (const [id, times] of since) {
      expect(times, id).toBeLessThanOrEqual(2);
    }
    // Draws for the medium ones cannot be fewer than the others', and no card was drawn more.
    expect(Math.max(...since.values())).toBeLessThanOrEqual(2);
  });
});

/**
 * The screen only shows the cards when a review is done, and a review that is done is not polled.
 * The cards and the polling are tested together here all the same, on the hook the screen uses and
 * the card the screen uses, because the promise is about them: whatever the server lists, a poll
 * that learns nothing must not draw a card.
 */
function Cards(props: { reviewId: string }) {
  const review = useReview(props.reviewId);
  if (review.load.status !== "ready") return null;
  return (
    <div>
      {review.load.detail.findings.map((finding) => (
        <FindingCard
          key={finding.ruleId}
          finding={finding}
          busy={review.bulkBusy || review.rowBusy.has(finding.ruleId)}
          error={review.rowErrors[finding.ruleId] ?? null}
          onDecide={review.decide}
          onSaveEdit={review.saveEdit}
          onReset={review.reset}
        />
      ))}
    </div>
  );
}

function renderCards(server: FakeServer) {
  const services = createServices({ fetch: server.fetch });
  return render(
    <ServicesProvider services={services}>
      <AnnouncerProvider>
        <Cards reviewId="rev-1" />
      </AnnouncerProvider>
    </ServicesProvider>,
  );
}

describe("polling a review that lists sixty findings", () => {
  afterEach(() => {
    cleanup();
  });

  const running = () =>
    reviewDetail({
      status: "running",
      progress: { done: 3, total: 20 },
      documentName: "Big contract.docx",
      findings: bigFindings(),
    });

  it("draws no card for a poll that learned nothing, however many there are", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [running()] });
    renderCards(server);
    await advance(0);
    expect(screen.getAllByRole("article")).toHaveLength(TOTAL);
    const before = snapshot();
    const reads = server.callsTo("GET", "/api/reviews/rev-1").length;

    await advance(5000);

    // The server was asked again five times, and answered with new objects each time.
    expect(server.callsTo("GET", "/api/reviews/rev-1").length).toBe(reads + 5);
    expect(drawn(drawnSince(before))).toEqual([]);
  });

  it("draws only the card whose finding the server changed", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [running()] });
    renderCards(server);
    await advance(0);
    const before = snapshot();

    const review = server.state.reviews.get("rev-1");
    const findings = (review?.findings ?? []).map((finding) =>
      finding.ruleId === "rule-11" ? { ...finding, decision: "rejected" as const } : finding,
    );
    server.updateReview("rev-1", { findings });
    await advance(1000);

    expect(drawn(drawnSince(before))).toEqual(["rule-11"]);
    expect(screen.getByRole("article", { name: "Finding 11" })).toHaveTextContent("Rejected");
  });

  it("draws the screen itself no more often than something on it changed", async () => {
    useFakeClock();
    const server = createFakeServer({
      reviews: [{ ...running(), findings: [], results: [], documentName: "Big contract.docx" }],
    });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    // React calls a component once more after an update before it knows that the next, equal state
    // changes nothing. One poll goes by before counting, and then no call is wanted at all.
    await advance(1000);
    const before = counts.screens.reviewScreen;
    expect(before).toBeGreaterThan(0);

    await advance(4000);
    expect(server.callsTo("GET", "/api/reviews/rev-1").length).toBeGreaterThanOrEqual(5);
    expect(counts.screens.reviewScreen).toBe(before);

    // A poll that does bring news does draw it.
    server.updateReview("rev-1", { progress: { done: 9, total: 20 } });
    await advance(1000);
    expect(counts.screens.reviewScreen).toBeGreaterThan(before);
    expect(screen.getByText("9 of 20 rules checked")).toBeInTheDocument();
  });
});
