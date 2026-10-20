// @vitest-environment jsdom
import type { ReviewDetail } from "@clausewise/api";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeServer, NOTHING_CHECKED_MESSAGE, RESTART_MESSAGE } from "./fakeServer.js";
import {
  COMPLIANT_ROW,
  ERROR_ROW,
  NOT_APPLICABLE_ROW,
  PARAGRAPH,
  appliedFinding,
  commentOnlyFinding,
  missingFinding,
  reviewDetail,
} from "./fixtures.js";
import {
  advance,
  announced,
  installCommonHooks,
  renderApp,
  useFakeClock,
  watchAnnouncer,
} from "./support.js";

installCommonHooks();

const queued = (): ReviewDetail =>
  reviewDetail({
    status: "queued",
    progress: { done: 0, total: 0 },
    open: null,
    model: null,
    counts: null,
    stats: null,
    findings: [],
    results: [],
    startedAt: null,
    finishedAt: null,
  });

describe("Review screen: following a review", () => {
  it("goes from queued to running to done, polling every second", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [queued()] });
    renderApp("#/reviews/rev-1", {
      server,
      userOptions: { advanceTimers: vi.advanceTimersByTime },
    });
    await advance(0);

    // Queued: waiting, no number to show yet.
    expect(screen.getByRole("heading", { name: "Waiting to start" })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for its turn/)).toBeInTheDocument();
    const waiting = screen.getByRole("progressbar", { name: "Rules checked" });
    expect(waiting).not.toHaveAttribute("value");
    const reads = (): number => server.callsTo("GET", "/api/reviews/rev-1").length;
    expect(reads()).toBe(1);

    await advance(999);
    expect(reads()).toBe(1);
    await advance(1);
    expect(reads()).toBe(2);

    // Running: the number of rules checked.
    server.updateReview("rev-1", { status: "running", progress: { done: 3, total: 20 } });
    await advance(1000);
    expect(reads()).toBe(3);
    expect(screen.getByRole("heading", { name: "Review in progress" })).toBeInTheDocument();
    expect(screen.getByText("3 of 20 rules checked")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", { name: "Rules checked" });
    expect(progress).toHaveAttribute("value", "3");
    expect(progress).toHaveAttribute("max", "20");
    expect(announced()).toContain("The review has started.");

    server.updateReview("rev-1", { progress: { done: 12, total: 20 } });
    await advance(1000);
    expect(screen.getByText("12 of 20 rules checked")).toBeInTheDocument();

    // Done: the findings replace the progress, and the polling stops.
    server.updateReview("rev-1", reviewDetail({ id: "rev-1" }));
    await advance(1000);
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(announced()).toBe("The review is finished. 3 findings to look at.");

    const settled = reads();
    await advance(10_000);
    expect(reads()).toBe(settled);
  });

  it("does not read the review again after the screen is closed", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [queued()] });
    const { view } = renderApp("#/reviews/rev-1", { server });
    await advance(0);
    await advance(1000);
    const before = server.callsTo("GET", "/api/reviews/rev-1").length;
    expect(before).toBe(2);
    view.unmount();
    await advance(5000);
    expect(server.callsTo("GET", "/api/reviews/rev-1")).toHaveLength(before);
  });

  it("stops polling when the person moves to another screen", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [queued()] });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    await advance(1000);
    const before = server.callsTo("GET", "/api/reviews/rev-1").length;
    window.location.hash = "#/playbooks";
    await advance(0);
    expect(screen.getByRole("heading", { name: "Playbooks" })).toBeInTheDocument();
    await advance(5000);
    expect(server.callsTo("GET", "/api/reviews/rev-1")).toHaveLength(before);
  });

  it("never has two reads in flight at once", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [queued()] });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    const release = server.hold(
      (call) => call.method === "GET" && call.path === "/api/reviews/rev-1",
    );
    await advance(1000);
    const started = server.callsTo("GET", "/api/reviews/rev-1").length;
    // The read is still waiting: time passing must not start another one.
    await advance(5000);
    expect(server.callsTo("GET", "/api/reviews/rev-1")).toHaveLength(started);
    release();
    await advance(1000);
    expect(server.callsTo("GET", "/api/reviews/rev-1").length).toBeGreaterThan(started);
  });

  it("says so, and keeps trying, when a progress read fails", async () => {
    useFakeClock();
    const server = createFakeServer({
      reviews: [queued()],
    });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    server.failNext((call) => call.method === "GET" && call.path === "/api/reviews/rev-1", {
      status: 500,
      code: "internal_error",
      message: "The database is busy.",
      times: 2,
    });
    await advance(1000);
    const page = within(screen.getByRole("main"));
    expect(
      page.getByText(
        /The latest progress could not be read\. The database is busy\. This page keeps trying\./,
      ),
    ).toBeInTheDocument();
    // Said to a screen reader once, when it started, and not again for the second failed attempt.
    expect(announced()).toBe(
      "The latest progress could not be read. The database is busy. This page keeps trying.",
    );
    const watch = watchAnnouncer();
    await advance(1000);
    expect(watch.changes()).toBe(0);
    watch.stop();

    server.updateReview("rev-1", { status: "running", progress: { done: 1, total: 4 } });
    await advance(2000);
    expect(page.queryByText(/keeps trying/)).not.toBeInTheDocument();
    expect(page.getByText("1 of 4 rules checked")).toBeInTheDocument();
  });

  it("shows an error when the review does not exist", async () => {
    renderApp("#/reviews/nope");
    expect(
      await screen.findByRole("heading", { name: "This review could not be opened" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("There is no such review.");
  });

  it("does not announce that a review finished when an already finished one is opened", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("heading", { name: "Summary" });
    expect(announced()).toBe("");
  });
});

describe("Review screen: reviews that did not finish", () => {
  it("shows the server's message for a failed review", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "failed",
          error: "The server restarted while this review was running. Start it again.",
          findings: [],
          results: [],
          open: null,
          counts: null,
        }),
      ],
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The review did not finish");
    expect(alert).toHaveTextContent(
      "The server restarted while this review was running. Start it again.",
    );
    expect(screen.getByRole("link", { name: "Go back and start it again" })).toHaveAttribute(
      "href",
      "#/",
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("shows the server's message for a cancelled review", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "cancelled",
          error: "You cancelled this review.",
          findings: [],
          results: [],
          open: null,
          counts: null,
        }),
      ],
    });
    expect(await screen.findByText("This review was cancelled")).toBeInTheDocument();
    expect(screen.getByText("You cancelled this review.")).toBeInTheDocument();
  });

  it("explains a cancelled review when the server gave no message", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ status: "cancelled", error: null, findings: [], results: [] })],
    });
    expect(
      await screen.findByText(/stopped before it finished, so there are no findings/),
    ).toBeInTheDocument();
  });
});

describe("Review screen: cancelling", () => {
  it("asks first, then cancels, and shows the cancelled review", async () => {
    const server = createFakeServer({
      reviews: [{ ...queued(), status: "running", progress: { done: 2, total: 10 } }],
    });
    const { user } = renderApp("#/reviews/rev-1", { server });
    await screen.findByText("2 of 10 rules checked");

    await user.click(screen.getByRole("button", { name: "Cancel review" }));
    // Nothing is sent until the question is answered.
    expect(server.callsTo("POST", "/api/reviews/rev-1/cancel")).toHaveLength(0);
    const group = screen.getByRole("group", { name: /Stop this review\?/ });
    await user.click(within(group).getByRole("button", { name: "Keep going" }));
    expect(server.callsTo("POST", "/api/reviews/rev-1/cancel")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel review" }));
    await user.click(screen.getByRole("button", { name: "Stop the review" }));
    expect(await screen.findByText("This review was cancelled")).toBeInTheDocument();
    expect(server.callsTo("POST", "/api/reviews/rev-1/cancel")).toHaveLength(1);
    expect(announced()).toBe("The review was cancelled.");
  });

  it("shows the server's message when the review can not be cancelled any more", async () => {
    const server = createFakeServer({
      reviews: [{ ...queued(), status: "running", progress: { done: 2, total: 10 } }],
    });
    const { user } = renderApp("#/reviews/rev-1", { server });
    await screen.findByText("2 of 10 rules checked");
    server.failNext((call) => call.path.endsWith("/cancel"), {
      status: 409,
      code: "conflict",
      message: "The review has already ended.",
    });
    server.updateReview("rev-1", reviewDetail({ id: "rev-1" }));
    await user.click(screen.getByRole("button", { name: "Cancel review" }));
    await user.click(screen.getByRole("button", { name: "Stop the review" }));
    // The screen reads the review again and shows how it ended.
    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
  });
});

describe("Review screen: the findings", () => {
  it("shows the header, the summary and the findings grouped by severity, high first", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          client: "Fabrikam Labs LLC, the Recipient",
          findings: [missingFinding(), commentOnlyFinding(), appliedFinding()],
        }),
      ],
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Acme NDA.docx" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Playbook: Mutual NDA \(receiving party\)\. Acting for: Fabrikam Labs LLC, the Recipient\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Model: claude-test-model \(anthropic\)\. Reviews are sent to Anthropic API/,
      ),
    ).toBeInTheDocument();

    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent("5 rules checked.");
    expect(summary).toHaveTextContent("3 findings for you to look at: 1 high, 1 medium, 1 low.");
    expect(summary).toHaveTextContent(
      "1 met the playbook, 1 did not apply, 0 could not be checked.",
    );
    expect(summary).toHaveTextContent("0 accepted, 0 rejected, 3 not decided.");

    const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections.filter((t) => /severity/.test(t ?? ""))).toEqual([
      "High severity(1)",
      "Medium severity(1)",
      "Low severity(1)",
    ]);
    // Within each severity section, the cards under its heading.
    const high = screen.getByRole("region", { name: /High severity/ });
    expect(
      within(high).getByRole("article", { name: "Duration of confidentiality obligations" }),
    ).toBeInTheDocument();
    const medium = screen.getByRole("region", { name: /Medium severity/ });
    expect(within(medium).getByRole("article", { name: "Governing law" })).toBeInTheDocument();
    const low = screen.getByRole("region", { name: /Low severity/ });
    expect(
      within(low).getByRole("article", { name: "Return or destruction of information" }),
    ).toBeInTheDocument();
  });

  it("leaves out a severity that has no findings", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings: [appliedFinding()] })] });
    await screen.findByRole("article");
    expect(screen.queryByRole("region", { name: /Medium severity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Low severity/ })).not.toBeInTheDocument();
  });

  it("shows the explanation, the clause with its number, and the suggested edit as a diff in the whole paragraph", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings: [appliedFinding()] })] });
    const card = await screen.findByRole("article", {
      name: "Duration of confidentiality obligations",
    });
    expect(card).toHaveTextContent("The contract departs from the playbook.");
    expect(card).toHaveTextContent("The playbook marks this clause as required.");
    expect(card).toHaveTextContent(
      "The obligations last ten years, and the playbook allows three.",
    );
    expect(card).toHaveTextContent("Clause 4.1, Term");
    expect(within(card).getByText(PARAGRAPH, { selector: "blockquote" })).toBeInTheDocument();

    const diff = card.querySelector(".diff-text");
    expect(diff).not.toBeNull();
    const removed = [...(diff?.querySelectorAll("del") ?? [])].map((el) => el.textContent);
    const added = [...(diff?.querySelectorAll("ins") ?? [])].map((el) => el.textContent);
    expect(removed).toEqual(["Removed: ten", "Removed: 10"]);
    expect(added).toEqual(["Added: three", "Added: 3"]);
    // The words around the edit are the paragraph's own, in place.
    expect(diff?.textContent).toBe(
      "The Recipient shall keep the Confidential Information secret for a period of Removed: tenAdded: three (Removed: 10Added: 3) years after the date of disclosure.",
    );
  });

  it("uses the lawyer's own wording in the diff when there is one", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          findings: [appliedFinding({ editedReplacement: "two (2) years", decision: "accepted" })],
        }),
      ],
    });
    const card = await screen.findByRole("article");
    expect(card).toHaveTextContent("Suggested change, with your wording");
    const added = [...card.querySelectorAll(".diff-text ins")].map((el) => el.textContent);
    expect(added).toEqual(["Added: two", "Added: 2"]);
    // The model's wording is not shown while the lawyer's own is in place.
    expect(card.querySelector(".diff-text")).not.toHaveTextContent("three");
  });

  it("shows a missing clause with its suggested wording and no diff", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings: [missingFinding()] })] });
    const card = await screen.findByRole("article");
    expect(card).toHaveTextContent("The contract has no clause for this.");
    expect(card).toHaveTextContent("No clause in the contract covers this.");
    expect(card).toHaveTextContent(
      "On request, the Recipient shall return or destroy the Confidential Information.",
    );
    expect(card.querySelector(".diff")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit wording" })).not.toBeInTheDocument();
  });

  it("shows a finding that could only be a comment, with the reason, and no way to edit it", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings: [commentOnlyFinding()] })] });
    const card = await screen.findByRole("article", { name: "Governing law" });
    expect(card).toHaveTextContent("Suggested wording, as a comment only");
    expect(card).toHaveTextContent(
      "The words to replace occur twice in the clause, so no single change could be made.",
    );
    expect(card).toHaveTextContent("a distant place");
    expect(card).toHaveTextContent("England and Wales");
    expect(card).toHaveTextContent("No tracked change is written for this one.");
    expect(card.querySelector(".diff")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit wording" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("keeps the comment for the Word file out of the way until it is opened", async () => {
    const { user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [appliedFinding()] })],
    });
    const card = await screen.findByRole("article");
    const details = card.querySelector("details.finding-comment") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(within(card).getByText("Comment that goes into the Word file"));
    expect(details.open).toBe(true);
    expect(card).toHaveTextContent("Ten years is longer than our standard of three. Shorten it.");
  });

  it("cuts a very long clause and offers the rest", async () => {
    const long = "word ".repeat(400).trim();
    const finding = missingFinding({
      status: "deviation",
      clauses: [{ id: "c1", number: "7", heading: null, text: long }],
    });
    const { user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [finding] })],
    });
    const card = await screen.findByRole("article");
    const quote = card.querySelector("blockquote") as HTMLElement;
    expect(quote.textContent?.endsWith("...")).toBe(true);
    expect(quote.textContent?.length).toBeLessThan(long.length);
    const more = within(card).getByRole("button", { name: "Show the whole clause" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(quote.textContent).toBe(long);
    expect(within(card).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("Review screen: other rules and warnings", () => {
  it("shows rules that could not be checked, in words, outside the collapsed list", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          counts: { compliant: 1, deviation: 2, missing: 1, not_applicable: 1, error: 1 },
          results: [COMPLIANT_ROW, NOT_APPLICABLE_ROW, ERROR_ROW],
        }),
      ],
    });
    const region = await screen.findByRole("region", { name: "Rules that could not be checked" });
    expect(region).toHaveTextContent("Residual knowledge");
    expect(region).toHaveTextContent("The model did not answer for this rule. Check it by hand.");
    expect(region).toHaveTextContent("A missing finding for them is not a pass");
    // The collapsed list holds the others, and not this one.
    const quiet = document.querySelector("details.quiet-rules") as HTMLDetailsElement;
    expect(quiet.open).toBe(false);
    expect(within(quiet).queryByText("Residual knowledge")).not.toBeInTheDocument();
    expect(within(quiet).getByText("Standard exclusions")).toBeInTheDocument();
    expect(within(quiet).getByText("No hidden restrictive covenants")).toBeInTheDocument();
  });

  it("lists the rules with nothing to change under a collapsed heading with their count", async () => {
    const { user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    const summary = await screen.findByText("Rules with nothing to change (2)");
    const quiet = document.querySelector("details.quiet-rules") as HTMLDetailsElement;
    expect(quiet.open).toBe(false);
    await user.click(summary);
    expect(quiet.open).toBe(true);
    expect(quiet).toHaveTextContent("Meets the playbook. Clauses 3, 3.1");
    expect(quiet).toHaveTextContent("All four exclusions are present.");
    expect(quiet).toHaveTextContent("Does not apply to this contract");
  });

  it("shows the warnings and the parts the model did not see", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          warnings: ["Counsel's tracked insertions were read as accepted text."],
          notShown: {
            trackedInsertions: 2,
            trackedDeletions: 0,
            comments: 1,
            footnotes: 0,
            endnotes: 0,
            headerFooterParts: 3,
            hiddenRuns: 0,
            images: 0,
          },
        }),
      ],
    });
    await screen.findByRole("heading", { name: "Summary" });
    expect(screen.getByText("Read these first")).toBeInTheDocument();
    expect(
      screen.getByText("Counsel's tracked insertions were read as accepted text."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /did not read these parts of the file: 2 tracked insertions, 1 comment, 3 headers or footers\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not mention parts not shown when there are none", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("heading", { name: "Summary" });
    expect(screen.queryByText("Not shown to the model")).not.toBeInTheDocument();
    expect(screen.queryByText("Read these first")).not.toBeInTheDocument();
  });

  it("says plainly when there are no findings", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          findings: [],
          counts: { compliant: 2, deviation: 0, missing: 0, not_applicable: 0, error: 0 },
        }),
      ],
    });
    expect(
      await screen.findByText("No findings. Nothing in this contract departs from the playbook."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download redline/ })).not.toBeInTheDocument();
  });

  it("does not call it clean when some rules could not be checked", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [], results: [ERROR_ROW] })],
    });
    expect(
      await screen.findByText("No findings, but some rules could not be checked."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Rules that could not be checked" }),
      ).toBeInTheDocument();
    });
  });
});

describe("Review screen: deleting the contract", () => {
  it("is offered once the review has ended, however it ended, and not while it runs", async () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      const { view } = renderApp("#/reviews/rev-1", {
        reviews: [reviewDetail({ status, findings: [], results: [], open: null })],
      });
      expect(
        await screen.findByRole("button", { name: "Delete the contract and its reviews" }),
      ).toBeInTheDocument();
      view.unmount();
    }
    for (const status of ["queued", "running"] as const) {
      const { view } = renderApp("#/reviews/rev-1", {
        reviews: [{ ...queued(), status }],
      });
      await screen.findByRole("progressbar");
      expect(
        screen.queryByRole("button", { name: "Delete the contract and its reviews" }),
      ).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("asks first, then deletes the document and goes back to the start", async () => {
    const { server, user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await user.click(
      await screen.findByRole("button", { name: "Delete the contract and its reviews" }),
    );
    const group = screen.getByRole("group", { name: /Delete "Acme NDA\.docx" and every review/ });
    expect(group).toHaveTextContent("This can not be undone.");
    expect(server.callsTo("DELETE", /^\/api\/documents\//)).toHaveLength(0);

    await user.click(within(group).getByRole("button", { name: "Keep it" }));
    expect(server.callsTo("DELETE", /^\/api\/documents\//)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Delete the contract and its reviews" }));
    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
    });
    expect(server.callsTo("DELETE", "/api/documents/doc-1")).toHaveLength(1);
    expect(server.state.reviews.size).toBe(0);
    expect(await screen.findByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    expect(announced()).toBe("Acme NDA.docx was deleted from the server.");
  });

  it("shows the server's message when the delete fails, and stays on the review", async () => {
    const { server, user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    server.failNext((call) => call.method === "DELETE", {
      status: 500,
      code: "internal_error",
      message: "The stored file could not be removed.",
    });
    await user.click(
      await screen.findByRole("button", { name: "Delete the contract and its reviews" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The contract was not deleted");
    expect(alert).toHaveTextContent("The stored file could not be removed.");
    expect(window.location.hash).toBe("#/reviews/rev-1");
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete the contract and its reviews" }),
    ).toBeEnabled();
  });
});

describe("Review screen: what a screen reader is told while a review runs", () => {
  const running = (done: number): ReviewDetail => ({
    ...queued(),
    status: "running",
    progress: { done, total: 20 },
  });

  it("says nothing when a poll finds the same progress, however many polls there are", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [running(3)] });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    const watch = watchAnnouncer();

    await advance(30_000);

    expect(server.callsTo("GET", "/api/reviews/rev-1").length).toBeGreaterThan(25);
    expect(watch.changes()).toBe(0);
    expect(announced()).toBe("");
    watch.stop();
  });

  it("says the newest figure, once, when it has changed and the last was a while ago", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [running(3)] });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    const watch = watchAnnouncer();

    // Several changes within the first seconds: nothing yet.
    server.updateReview("rev-1", { progress: { done: 4, total: 20 } });
    await advance(1000);
    server.updateReview("rev-1", { progress: { done: 5, total: 20 } });
    await advance(1000);
    server.updateReview("rev-1", { progress: { done: 6, total: 20 } });
    await advance(2000);
    expect(watch.changes()).toBe(0);

    // Five seconds after the screen first saw the review, the newest figure is said, once.
    await advance(1000);
    expect(announced()).toBe("6 of 20 rules checked.");
    expect(watch.changes()).toBeGreaterThan(0);
    expect(watch.changes()).toBe(0);

    // Then quiet again while it stays at 6.
    await advance(10_000);
    expect(watch.changes()).toBe(0);

    // A change after a quiet spell is said at once.
    server.updateReview("rev-1", { progress: { done: 7, total: 20 } });
    await advance(1000);
    expect(announced()).toBe("7 of 20 rules checked.");
    watch.stop();
  });

  it("does not say a figure that is the same, when only the total behind it is learned later", async () => {
    useFakeClock();
    const server = createFakeServer({
      reviews: [{ ...queued(), status: "running", progress: { done: 0, total: 0 } }],
    });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    const watch = watchAnnouncer();
    server.updateReview("rev-1", { progress: { done: 0, total: 20 } });
    await advance(10_000);
    expect(screen.getByText("0 of 20 rules checked")).toBeInTheDocument();
    expect(watch.changes()).toBe(0);
    watch.stop();
  });

  it("does not say progress for a review that is only waiting", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [queued()] });
    renderApp("#/reviews/rev-1", { server });
    await advance(0);
    const watch = watchAnnouncer();
    await advance(10_000);
    expect(watch.changes()).toBe(0);
    watch.stop();
  });

  it("puts the focus on the review's heading when the progress panel that held it goes away", async () => {
    const server = createFakeServer({ reviews: [running(2)] });
    const { user } = renderApp("#/reviews/rev-1", { server });
    await screen.findByText("2 of 20 rules checked");
    await user.click(screen.getByRole("button", { name: "Cancel review" }));
    expect(screen.getByRole("button", { name: "Keep going" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Stop the review" }));
    await screen.findByText("This review was cancelled");
    expect(screen.getByRole("heading", { level: 1, name: "Acme NDA.docx" })).toHaveFocus();
  });

  it("leaves the focus alone when the person has moved it elsewhere before the review ends", async () => {
    useFakeClock();
    const server = createFakeServer({ reviews: [running(2)] });
    renderApp("#/reviews/rev-1", {
      server,
      userOptions: { advanceTimers: vi.advanceTimersByTime },
    });
    await advance(0);
    const link = screen.getByRole("link", { name: "All reviews" });
    link.focus();
    server.updateReview("rev-1", reviewDetail({ id: "rev-1" }));
    await advance(1000);
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(link).toHaveFocus();
  });

  it("shows a failed review's message with its line breaks, as the server wrote it", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "failed",
          error: NOTHING_CHECKED_MESSAGE,
          findings: [],
          results: [],
          open: null,
          counts: null,
        }),
      ],
    });
    const alert = await screen.findByRole("alert");
    const message = within(alert).getByText(/No rule could be checked/);
    // The text is the server's, all of it, and the lines stay lines.
    expect(message.textContent).toBe(NOTHING_CHECKED_MESSAGE);
    expect(message).toHaveClass("message-text");
    expect(message.textContent?.split("\n")).toHaveLength(3);
  });

  it("shows the restart message of a review the server lost when it stopped", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "failed",
          error: RESTART_MESSAGE,
          findings: [],
          results: [],
          open: null,
          counts: null,
        }),
      ],
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(RESTART_MESSAGE);
  });
});
