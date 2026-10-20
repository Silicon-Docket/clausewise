// @vitest-environment jsdom
import type { Finding } from "@clausewise/api";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "./fakeServer.js";
import { appliedFinding, commentOnlyFinding, missingFinding, reviewDetail } from "./fixtures.js";
import { announced, installCommonHooks, renderApp } from "./support.js";

installCommonHooks();

const patches = (server: FakeServer): Array<{ path: string; body: unknown }> =>
  server.calls
    .filter((call) => call.method === "PATCH")
    .map((call) => ({ path: call.path, body: call.body }));

const stored = (server: FakeServer, ruleId: string): Finding | undefined =>
  server.state.reviews.get("rev-1")?.findings.find((f) => f.ruleId === ruleId);

function open(findings: Finding[] = [appliedFinding(), commentOnlyFinding(), missingFinding()]) {
  const app = renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings })] });
  return app;
}

const cardOf = async (name: string): Promise<HTMLElement> => screen.findByRole("article", { name });

describe("deciding on a finding", () => {
  it("accepts: sends the decision, shows it at once, and keeps what the server answers", async () => {
    const { server, user } = open();
    const card = await cardOf("Duration of confidentiality obligations");
    const accept = within(card).getByRole("button", { name: "Accept" });
    expect(accept).toHaveAttribute("aria-pressed", "false");

    await user.click(accept);
    await waitFor(() => {
      expect(within(card).getByRole("button", { name: "Accept" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(patches(server)).toEqual([
      { path: "/api/reviews/rev-1/findings/term", body: { decision: "accepted" } },
    ]);
    expect(card).toHaveTextContent("Accepted");
    expect(stored(server, "term")?.decision).toBe("accepted");
    expect(announced()).toBe(
      "Duration of confidentiality obligations: accepted. 1 accepted in all.",
    );
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
      "1 accepted, 0 rejected, 2 not decided.",
    );
  });

  it("rejects", async () => {
    const { server, user } = open();
    const card = await cardOf("Governing law");
    await user.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(within(card).getByRole("button", { name: "Reject" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(patches(server)).toEqual([
      { path: "/api/reviews/rev-1/findings/governing-law", body: { decision: "rejected" } },
    ]);
    expect(card).toHaveTextContent("Rejected");
  });

  it("accepts a finding that is comment-only, and a missing clause, with only the decision", async () => {
    const { server, user } = open();
    await user.click(within(await cardOf("Governing law")).getByRole("button", { name: "Accept" }));
    await user.click(
      within(await cardOf("Return or destruction of information")).getByRole("button", {
        name: "Accept",
      }),
    );
    await waitFor(() => {
      expect(patches(server)).toHaveLength(2);
    });
    expect(patches(server).map((p) => p.body)).toEqual([
      { decision: "accepted" },
      { decision: "accepted" },
    ]);
  });

  it("takes a decision back when the same button is pressed again", async () => {
    const { server, user } = open([appliedFinding({ decision: "accepted" })]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(card).toHaveTextContent("Not decided");
    });
    expect(patches(server)[0]?.body).toEqual({ decision: "pending" });
  });

  it("shows pending state while the server works and does not let the same finding be changed meanwhile", async () => {
    const { server, user } = open();
    const release = server.hold((call) => call.method === "PATCH");
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Accept" }));

    // Shown at once, before the server has answered.
    expect(within(card).getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(within(card).getByText("Saving...")).toBeInTheDocument();
    // Unavailable, said in words for a screen reader, but not disabled: see the next test.
    for (const button of [
      within(card).getByRole("button", { name: "Accept" }),
      within(card).getByRole("button", { name: "Reject" }),
      screen.getByRole("button", { name: "Accept all findings" }),
    ]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }
    // Pressing them while the change is on its way sends nothing more.
    await user.click(within(card).getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Accept all findings" }));

    release();
    await waitFor(() => {
      expect(card).toHaveAttribute("aria-busy", "false");
    });
    expect(patches(server)).toHaveLength(1);
    expect(server.callsTo("PATCH", /\/findings$/)).toHaveLength(0);
    expect(within(card).getByRole("button", { name: "Reject" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("leaves the focus on the button that was pressed, while it saves and after", async () => {
    const { server, user } = open();
    const release = server.hold((call) => call.method === "PATCH");
    const card = await cardOf("Duration of confidentiality obligations");
    const accept = within(card).getByRole("button", { name: "Accept" });
    accept.focus();
    await user.keyboard("{Enter}");

    // A disabled button gives up the focus in a browser; this one is still a button that takes it.
    expect(accept).not.toBeDisabled();
    expect(accept).toHaveFocus();
    release();
    await waitFor(() => {
      expect(card).toHaveAttribute("aria-busy", "false");
    });
    expect(within(card).getByRole("button", { name: "Accept" })).toBe(accept);
    expect(accept).toHaveFocus();
    expect(accept).toHaveAttribute("aria-pressed", "true");
  });
});

describe("rolling a decision back", () => {
  it("puts the finding back and shows the server's reason when a decision is refused", async () => {
    const { server, user } = open();
    server.failNext((call) => call.method === "PATCH", {
      status: 500,
      code: "internal_error",
      message: "The database is busy. Try again in a moment.",
    });
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Accept" }));

    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent(
      "That change was not saved, and the finding is back as it was.",
    );
    expect(alert).toHaveTextContent("The database is busy. Try again in a moment.");
    expect(within(card).getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(card).toHaveTextContent("Not decided");
    expect(stored(server, "term")?.decision).toBe("pending");
    // The alert above is read out by itself; the polite region does not say it a second time.
    expect(announced()).toBe("");
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
      "0 accepted, 0 rejected, 3 not decided.",
    );
    // The buttons work again.
    expect(within(card).getByRole("button", { name: "Accept" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("clears the message when the next try works", async () => {
    const { server, user } = open();
    server.failNext((call) => call.method === "PATCH", {
      status: 500,
      code: "internal_error",
      message: "The database is busy.",
    });
    const card = await cardOf("Governing law");
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByRole("alert");
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(within(card).getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("restores the previous decision, not just 'not decided'", async () => {
    const { server, user } = open([appliedFinding({ decision: "accepted" })]);
    server.failNext((call) => call.method === "PATCH", {
      status: 409,
      code: "conflict",
      message: "This review is being changed somewhere else.",
    });
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Reject" }));
    await within(card).findByRole("alert");
    expect(within(card).getByRole("button", { name: "Accept" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(card).getByRole("button", { name: "Reject" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("rolls back a bulk change and shows the reason", async () => {
    const { server, user } = open();
    server.failNext((call) => call.method === "PATCH" && call.path.endsWith("/findings"), {
      status: 500,
      code: "internal_error",
      message: "The database is busy.",
    });
    await user.click(await screen.findByRole("button", { name: "Accept all findings" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "That change was not saved, and the findings are back as they were.",
    );
    expect(alert).toHaveTextContent("The database is busy.");
    for (const name of [
      "Duration of confidentiality obligations",
      "Governing law",
      "Return or destruction of information",
    ]) {
      expect(within(await cardOf(name)).getByRole("button", { name: "Accept" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
      "0 accepted, 0 rejected, 3 not decided.",
    );
  });
});

describe("editing the wording", () => {
  it("opens a box with the model's wording and shows how the paragraph will read as the text changes", async () => {
    const { user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));

    const box = within(card).getByRole("textbox", { name: "Your wording" });
    expect(box).toHaveValue("three (3) years");
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute("maxlength", "20000");
    expect(within(card).getByText(/Leave the box empty to remove them/)).toBeInTheDocument();

    await user.clear(box);
    await user.type(box, "two (2) years");
    const preview = card.querySelector(".wording-editor .diff-text");
    expect([...(preview?.querySelectorAll("ins") ?? [])].map((el) => el.textContent)).toEqual([
      "Added: two",
      "Added: 2",
    ]);
  });

  it("saves the wording: sends editedReplacement only, and the diff updates", async () => {
    const { server, user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    await user.clear(box);
    await user.type(box, "two (2) years");
    await user.click(within(card).getByRole("button", { name: "Save wording" }));

    await waitFor(() => {
      expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    });
    expect(patches(server)).toEqual([
      { path: "/api/reviews/rev-1/findings/term", body: { editedReplacement: "two (2) years" } },
    ]);
    expect(stored(server, "term")?.editedReplacement).toBe("two (2) years");
    expect(stored(server, "term")?.decision).toBe("pending");
    expect([...card.querySelectorAll(".diff-text ins")].map((el) => el.textContent)).toEqual([
      "Added: two",
      "Added: 2",
    ]);
    expect(card).toHaveTextContent("with your wording");
    // Focus goes back to the button that opened the box.
    expect(within(card).getByRole("button", { name: "Edit wording" })).toHaveFocus();
  });

  it("saves and accepts in one request", async () => {
    const { server, user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    await user.clear(box);
    await user.type(box, "two (2) years");
    await user.click(within(card).getByRole("button", { name: "Save and accept" }));
    await waitFor(() => {
      expect(card).toHaveTextContent("Accepted");
    });
    expect(patches(server)).toEqual([
      {
        path: "/api/reviews/rev-1/findings/term",
        body: { editedReplacement: "two (2) years", decision: "accepted" },
      },
    ]);
  });

  it("allows an empty wording, which removes the words", async () => {
    const { server, user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    await user.clear(within(card).getByRole("textbox", { name: "Your wording" }));
    expect(card.querySelector(".wording-editor")).toHaveTextContent(
      "This removes the words and puts nothing in their place.",
    );
    await user.click(within(card).getByRole("button", { name: "Save wording" }));
    await waitFor(() => {
      expect(patches(server)).toHaveLength(1);
    });
    expect(patches(server)[0]?.body).toEqual({ editedReplacement: "" });
  });

  it("clears the stored wording when the text is put back to the model's", async () => {
    const { server, user } = open([appliedFinding({ editedReplacement: "two (2) years" })]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    expect(box).toHaveValue("two (2) years");
    await user.clear(box);
    await user.type(box, "three (3) years");
    await user.click(within(card).getByRole("button", { name: "Save wording" }));
    await waitFor(() => {
      expect(patches(server)).toHaveLength(1);
    });
    expect(patches(server)[0]?.body).toEqual({ editedReplacement: null });
  });

  it("sends nothing when the text was not changed", async () => {
    const { server, user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    await user.click(within(card).getByRole("button", { name: "Save wording" }));
    await waitFor(() => {
      expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    });
    expect(patches(server)).toHaveLength(0);
  });

  it("cancels without sending anything, also with the Escape key", async () => {
    const { server, user } = open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    await user.type(within(card).getByRole("textbox", { name: "Your wording" }), " extra");
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    // The box opens with what is stored, not with the abandoned text.
    expect(within(card).getByRole("textbox", { name: "Your wording" })).toHaveValue(
      "three (3) years",
    );
    await user.keyboard("{Escape}");
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(patches(server)).toHaveLength(0);
  });

  it("keeps the box open with the typed text and shows the reason when saving fails", async () => {
    const { server, user } = open([appliedFinding()]);
    server.failNext((call) => call.method === "PATCH", {
      status: 400,
      code: "bad_request",
      message: "The wording is longer than 20,000 characters.",
    });
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    await user.clear(box);
    await user.type(box, "two (2) years");
    await user.click(within(card).getByRole("button", { name: "Save wording" }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "The wording is longer than 20,000 characters.",
    );
    expect(within(card).getByRole("textbox", { name: "Your wording" })).toHaveValue(
      "two (2) years",
    );
    expect(stored(server, "term")?.editedReplacement).toBeNull();
    // The shown wording went back to the stored one.
    expect(card).not.toHaveTextContent("with your wording");
  });
});

describe("resetting", () => {
  it("puts back the decision and the model's wording for an applied edit", async () => {
    const { server, user } = open([
      appliedFinding({ decision: "accepted", editedReplacement: "two (2) years" }),
    ]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(card).toHaveTextContent("Not decided");
    });
    expect(patches(server)).toEqual([
      {
        path: "/api/reviews/rev-1/findings/term",
        body: { decision: "pending", editedReplacement: null },
      },
    ]);
    expect(card).not.toHaveTextContent("with your wording");
    expect(within(card).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("sends only the decision for a finding that has no edit to reset", async () => {
    const { server, user } = open([commentOnlyFinding({ decision: "rejected" })]);
    const card = await cardOf("Governing law");
    await user.click(within(card).getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(patches(server)).toHaveLength(1);
    });
    expect(patches(server)[0]?.body).toEqual({ decision: "pending" });
  });

  it("is offered when only the wording was changed", async () => {
    open([appliedFinding({ editedReplacement: "two (2) years" })]);
    const card = await cardOf("Duration of confidentiality obligations");
    expect(within(card).getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("is not offered for a finding nobody has touched", async () => {
    open([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    expect(within(card).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });
});

describe("changing many at once", () => {
  it("accepts all findings with one request that names no severity", async () => {
    const { server, user } = open();
    await user.click(await screen.findByRole("button", { name: "Accept all findings" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
        "3 accepted, 0 rejected, 0 not decided.",
      );
    });
    expect(patches(server)).toEqual([
      { path: "/api/reviews/rev-1/findings", body: { decision: "accepted" } },
    ]);
    for (const card of screen.getAllByRole("article")) {
      expect(card).toHaveTextContent("Accepted");
    }
    expect(announced()).toBe("3 findings accepted.");
  });

  it("rejects all findings", async () => {
    const { server, user } = open();
    await user.click(await screen.findByRole("button", { name: "Reject all findings" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
        "0 accepted, 3 rejected, 0 not decided.",
      );
    });
    expect(patches(server)[0]?.body).toEqual({ decision: "rejected" });
  });

  it("accepts all of one severity and leaves the others alone", async () => {
    const { server, user } = open();
    await user.click(await screen.findByRole("button", { name: "Accept all medium" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
        "1 accepted, 0 rejected, 2 not decided.",
      );
    });
    expect(patches(server)).toEqual([
      {
        path: "/api/reviews/rev-1/findings",
        body: { decision: "accepted", severities: ["medium"] },
      },
    ]);
    expect(
      within(await cardOf("Governing law")).getByRole("button", { name: "Accept" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(await cardOf("Duration of confidentiality obligations")).getByRole("button", {
        name: "Accept",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("rejects all of one severity", async () => {
    const { server, user } = open();
    await user.click(await screen.findByRole("button", { name: "Reject all low" }));
    await waitFor(() => {
      expect(patches(server)).toHaveLength(1);
    });
    expect(patches(server)[0]?.body).toEqual({ decision: "rejected", severities: ["low"] });
  });

  it("shows the change at once, and holds every button until it is saved", async () => {
    const { server, user } = open();
    const release = server.hold((call) => call.method === "PATCH");
    await user.click(await screen.findByRole("button", { name: "Accept all findings" }));
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent("3 accepted");
    expect(screen.getByRole("button", { name: "Reject all findings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Accept all high" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    for (const card of screen.getAllByRole("article")) {
      expect(within(card).getByRole("button", { name: "Reject" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    release();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reject all findings" })).not.toHaveAttribute(
        "aria-disabled",
      );
    });
  });

  it("clears all decisions, when there are any", async () => {
    const { server, user } = open([appliedFinding({ decision: "accepted" }), commentOnlyFinding()]);
    await user.click(await screen.findByRole("button", { name: "Clear all decisions" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Clear all decisions" })).not.toBeInTheDocument();
    });
    expect(patches(server)[0]?.body).toEqual({ decision: "pending" });
  });

  it("takes the server's word for what changed, by reading the review again", async () => {
    const { server, user } = open();
    await cardOf("Governing law");
    const release = server.hold(
      (call) => call.method === "GET" && call.path === "/api/reviews/rev-1",
    );
    await user.click(screen.getByRole("button", { name: "Accept all findings" }));
    await waitFor(() => {
      expect(server.callsTo("PATCH", "/api/reviews/rev-1/findings")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(server.callsTo("GET", "/api/reviews/rev-1")).toHaveLength(2);
    });
    // Meanwhile the server's own state says one finding was not accepted after all.
    const review = server.state.reviews.get("rev-1")!;
    server.state.reviews.set("rev-1", {
      ...review,
      findings: review.findings.map((f) =>
        f.ruleId === "governing-law" ? { ...f, decision: "rejected" as const } : f,
      ),
    });
    release();
    await waitFor(() => {
      expect(
        within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
          name: "Reject",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent(
      "2 accepted, 1 rejected, 0 not decided.",
    );
  });
});
