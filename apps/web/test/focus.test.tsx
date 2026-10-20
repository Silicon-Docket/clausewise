// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeServer, type FakeServer } from "./fakeServer.js";
import {
  appliedFinding,
  commentOnlyFinding,
  missingFinding,
  playbookDetail,
  reviewDetail,
} from "./fixtures.js";
import { announced, installCommonHooks, renderApp } from "./support.js";

installCommonHooks();

/**
 * Where the focus is after an action, for someone who uses the keyboard or a screen reader. A
 * button that disappears or is disabled takes the focus with it, and the person then starts again
 * from the top of the page; every case here is one where the focus has to be put somewhere.
 * (jsdom keeps the focus on an element that is disabled or removed under it in some cases, so the
 * tests also check that the pressed button stays a button that can take the focus.)
 */

const cardOf = (name: string): Promise<HTMLElement> => screen.findByRole("article", { name });

function openReview(findings = [appliedFinding(), commentOnlyFinding(), missingFinding()]) {
  return renderApp("#/reviews/rev-1", { reviews: [reviewDetail({ findings })] });
}

describe("focus in a finding's card", () => {
  it("moves to Accept when Reset takes itself away", async () => {
    const { user } = openReview([appliedFinding({ decision: "accepted" })]);
    const card = await cardOf("Duration of confidentiality obligations");
    const reset = within(card).getByRole("button", { name: "Reset" });
    reset.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(within(card).queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    });
    expect(within(card).getByRole("button", { name: "Accept" })).toHaveFocus();
  });

  it("puts the finding and its Reset button back when a reset is refused, and says why", async () => {
    const { server, user } = openReview([appliedFinding({ decision: "accepted" })]);
    const card = await cardOf("Duration of confidentiality obligations");
    server.failNext((call) => call.method === "PATCH", {
      status: 500,
      code: "internal_error",
      message: "The database is busy.",
    });
    await user.click(within(card).getByRole("button", { name: "Reset" }));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("The database is busy.");
    expect(within(card).getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Accepted");
  });

  it("describes each button by the finding's title, so that a list of buttons says which is which", async () => {
    openReview([appliedFinding({ decision: "accepted" }), commentOnlyFinding()]);
    for (const title of ["Duration of confidentiality obligations", "Governing law"]) {
      const card = await cardOf(title);
      for (const name of ["Accept", "Reject"]) {
        expect(within(card).getByRole("button", { name })).toHaveAccessibleDescription(title);
      }
    }
    const first = await cardOf("Duration of confidentiality obligations");
    expect(within(first).getByRole("button", { name: "Edit wording" })).toHaveAccessibleDescription(
      "Duration of confidentiality obligations",
    );
    expect(within(first).getByRole("button", { name: "Reset" })).toHaveAccessibleDescription(
      "Duration of confidentiality obligations",
    );
  });

  it("tells a screen reader which buttons are on, with aria-pressed, on Accept and Reject only", async () => {
    const { user } = openReview([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    const accept = within(card).getByRole("button", { name: "Accept" });
    const reject = within(card).getByRole("button", { name: "Reject" });
    expect(accept).toHaveAttribute("aria-pressed", "false");
    expect(reject).toHaveAttribute("aria-pressed", "false");
    await user.click(reject);
    await waitFor(() => {
      expect(reject).toHaveAttribute("aria-pressed", "true");
    });
    expect(accept).toHaveAttribute("aria-pressed", "false");
    // The others are actions, not switches.
    for (const name of ["Edit wording", "Reset"]) {
      expect(within(card).getByRole("button", { name })).not.toHaveAttribute("aria-pressed");
    }
    for (const name of ["Accept all findings", "Reject all findings"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-pressed");
    }
  });

  it("keeps the focus on the save button when saving the wording is refused, and ties the box to the reason", async () => {
    const { server, user } = openReview([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    expect(box).not.toHaveAttribute("aria-invalid");
    server.failNext((call) => call.method === "PATCH", {
      status: 400,
      code: "bad_request",
      message: "The wording is at most 20000 characters.",
    });
    // A wording that differs from the model's, so that there is something to send.
    await user.type(box, " or less");
    const save = within(card).getByRole("button", { name: "Save wording" });
    save.focus();
    await user.keyboard("{Enter}");

    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("The wording is at most 20000 characters.");
    // The box stays open with the person's text, and says what is wrong with it.
    expect(box).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(box).toHaveAccessibleDescription(expect.stringContaining("at most 20000 characters"));
    expect(save).toHaveFocus();
    expect(save).not.toHaveAttribute("aria-disabled");
  });

  it("closes the box with Escape and gives the focus back to the button that opened it", async () => {
    const { user } = openReview([appliedFinding()]);
    const card = await cardOf("Duration of confidentiality obligations");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    expect(within(card).getByRole("textbox", { name: "Your wording" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Edit wording" })).toHaveFocus();
  });
});

describe("focus around the bulk buttons", () => {
  it("moves to Accept all when Clear all decisions has nothing left to clear", async () => {
    const { user } = openReview([appliedFinding({ decision: "accepted" }), commentOnlyFinding()]);
    const clear = await screen.findByRole("button", { name: "Clear all decisions" });
    clear.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Clear all decisions" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Accept all findings" })).toHaveFocus();
  });

  it("keeps the focus on the bulk button that was pressed while it saves", async () => {
    const { server, user } = openReview();
    const release = server.hold((call) => call.method === "PATCH");
    const button = await screen.findByRole("button", { name: "Accept all high" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    release();
    await waitFor(() => {
      expect(button).not.toHaveAttribute("aria-disabled");
    });
    expect(button).toHaveFocus();
  });
});

describe("focus when something is deleted", () => {
  it("lands on the heading of the start screen after the contract is deleted", async () => {
    const { user } = openReview();
    await user.click(
      await screen.findByRole("button", { name: "Delete the contract and its reviews" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    const heading = await screen.findByRole("heading", { name: "Review a contract" });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it("stays on the delete button, still a button that takes the focus, while and after it fails", async () => {
    const { server, user } = openReview();
    const release = server.hold((call) => call.method === "DELETE");
    server.failNext((call) => call.method === "DELETE", {
      status: 500,
      code: "internal_error",
      message: "The stored file could not be removed.",
    });
    await user.click(
      await screen.findByRole("button", { name: "Delete the contract and its reviews" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete everything" }));
    const button = screen.getByRole("button", { name: "Delete the contract and its reviews" });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();

    release();
    await screen.findByRole("alert");
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("lands on the heading of the playbooks screen after a playbook is deleted", async () => {
    const server = createFakeServer({
      playbooks: [
        playbookDetail(),
        playbookDetail({
          id: "custom-1",
          source: "custom",
          name: "My NDA",
          yaml: "name: My NDA\n",
          editable: true,
        }),
      ],
    });
    const { user } = renderApp("#/playbooks", { server });
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await user.click(await screen.findByRole("button", { name: "Delete playbook" }));
    await user.click(screen.getByRole("button", { name: "Delete it" }));
    await screen.findByText('Deleted "My NDA".');
    expect(screen.getByRole("heading", { level: 1, name: "Playbooks" })).toHaveFocus();
  });
});

describe("focus in the playbook editor", () => {
  const mine = () =>
    playbookDetail({
      id: "custom-1",
      source: "custom",
      name: "My NDA",
      yaml: "name: My NDA\nrules: []\n",
      editable: true,
    });
  const open = (server: FakeServer = createFakeServer({ playbooks: [playbookDetail(), mine()] })) =>
    renderApp("#/playbooks", { server });

  it("stays on Save changes after saving, when there is nothing left to save", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), {
      target: { value: "name: My NDA 2\nrules: []\n" },
    });
    await screen.findByText(/The playbook is valid: My NDA 2/);
    const save = screen.getByRole("button", { name: "Save changes" });
    save.focus();
    await user.keyboard("{Enter}");
    await screen.findByText('Saved "My NDA 2".');
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).not.toBeDisabled();
    expect(save).toHaveFocus();
  });

  it("opens a copy with the focus on its heading, so that Tab goes to the text", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Mutual NDA/ }));
    await user.click(await screen.findByRole("button", { name: "Copy to edit" }));
    const heading = await screen.findByRole("heading", { name: "New playbook" });
    expect(heading).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Playbook (YAML)")).toHaveFocus();
  });

  it("moves to the saved playbook's heading when a copy is saved as a new playbook", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Mutual NDA/ }));
    await user.click(await screen.findByRole("button", { name: "Copy to edit" }));
    await screen.findByText(/The playbook is valid/);
    await user.click(screen.getByRole("button", { name: "Save as a new playbook" }));
    await screen.findByText(/Saved "Mutual NDA/);
    const heading = await screen.findByRole("heading", { level: 2, name: /Mutual NDA/ });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it("puts the question about unsaved changes where the focus is, on the safe answer, and says it", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), {
      target: { value: "name: half written" },
    });
    await user.click(screen.getByRole("button", { name: /Mutual NDA/ }));

    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    expect(announced()).toBe(
      "You have changes that are not saved. Opening another playbook throws them away.",
    );

    // Keeping them puts the person back in the text.
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Playbook (YAML)")).toHaveFocus();
  });

  it("takes the focus to the new playbook's heading when the changes are discarded", async () => {
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), { target: { value: "name: x" } });
    await user.click(screen.getByRole("button", { name: /Mutual NDA/ }));
    await user.click(screen.getByRole("button", { name: "Discard and open" }));
    const heading = await screen.findByRole("heading", { name: "Mutual NDA (receiving party)" });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it("leaves the focus in the list when a playbook is opened from it", async () => {
    const { user } = open();
    const item = await screen.findByRole("button", { name: /My NDA/ });
    await user.click(item);
    await screen.findByRole("heading", { name: "My NDA" });
    expect(item).toHaveFocus();
  });
});

describe("what the playbook editor says out loud", () => {
  it("says nothing when the editor opens, and then a short sentence for each change, not the list", async () => {
    const server = createFakeServer({
      playbooks: [
        playbookDetail(),
        playbookDetail({
          id: "custom-1",
          source: "custom",
          name: "My NDA",
          yaml: "name: My NDA\n",
          editable: true,
        }),
      ],
    });
    const { user } = renderApp("#/playbooks", { server });
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    const live = (): string =>
      [...document.querySelectorAll("main [aria-live]")].map((el) => el.textContent).join("|");
    // Opening it is silent: the result is on the screen.
    expect(live()).toBe("");

    server.state.validate = () => ({ ok: false, problems: ["First thing.", "Second thing."] });
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), { target: { value: "bad 1" } });
    await screen.findByText("2 problems to fix");
    expect(live()).toBe("Playbook check: 2 problems.");
    // Not the problems themselves, which are read when the text box is described.
    expect(live()).not.toContain("First thing");
    expect(screen.getByLabelText("Playbook (YAML)")).toHaveAccessibleDescription(
      expect.stringContaining("First thing."),
    );

    // Typing on, with the same two problems, does not make it say the same sentence again.
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), { target: { value: "bad 12" } });
    await screen.findByText("2 problems to fix");
    expect(live()).toBe("Playbook check: 2 problems.");

    server.state.validate = (yaml) => ({
      ok: true,
      name: yaml.slice(0, 10),
      ruleCount: 1,
      contractTypes: [],
    });
    fireEvent.change(screen.getByLabelText("Playbook (YAML)"), {
      target: { value: "name: fixed" },
    });
    await screen.findByText(/The playbook is valid: name: fixe/);
    expect(live()).toBe("Playbook check: no problems.");
  });
});
