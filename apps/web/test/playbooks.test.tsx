// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VALIDATE_DEBOUNCE_MS } from "../src/screens/Playbooks.js";
import { createFakeServer, type FakeServer } from "./fakeServer.js";
import { playbookDetail } from "./fixtures.js";
import { advance, announced, installCommonHooks, renderApp, useFakeClock } from "./support.js";

installCommonHooks();

const CUSTOM_YAML = "name: My NDA\ncontractTypes: [nda]\nrules: []\n";
const builtIn = (): ReturnType<typeof playbookDetail> => playbookDetail();
const custom = (): ReturnType<typeof playbookDetail> =>
  playbookDetail({
    id: "custom-1",
    source: "custom",
    name: "My NDA",
    ruleCount: 3,
    yaml: CUSTOM_YAML,
    editable: true,
    updatedAt: "2026-10-19T10:00:00.000Z",
  });

const validations = (server: FakeServer): string[] =>
  server
    .callsTo("POST", "/api/playbooks/validate")
    .map((call) => (call.body as { yaml: string }).yaml);

function openScreen(
  server = createFakeServer({ playbooks: [builtIn(), custom()] }),
  userOptions: Parameters<typeof renderApp>[1] extends infer O
    ? O extends { userOptions?: infer U }
      ? U
      : never
    : never = {},
) {
  return renderApp("#/playbooks", { server, userOptions });
}

const editor = (): HTMLTextAreaElement => screen.getByLabelText("Playbook (YAML)");

describe("Playbooks screen: the list", () => {
  it("lists the playbooks, built-in ones marked read-only", async () => {
    openScreen();
    const nav = await screen.findByRole("navigation", { name: "Playbooks" });
    const mutual = await within(nav).findByRole("button", {
      name: /Mutual NDA \(receiving party\)/,
    });
    expect(mutual).toHaveTextContent("Built in, read-only. 10 rules. For nda");
    const mine = within(nav).getByRole("button", { name: /My NDA/ });
    expect(mine).toHaveTextContent("Yours. 3 rules. For nda");
    expect(screen.getByText("Choose a playbook to read it.")).toBeInTheDocument();
  });

  it("shows the server's message when the list can not be loaded", async () => {
    const server = createFakeServer();
    server.failNext((call) => call.path === "/api/playbooks", {
      status: 500,
      code: "internal_error",
      message: "The database is not answering.",
    });
    const { user } = renderApp("#/playbooks", { server });
    expect(await screen.findByText(/The database is not answering\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /Mutual NDA/ })).toBeInTheDocument();
  });
});

describe("Playbooks screen: a built-in playbook", () => {
  it("is shown read-only, with Copy to edit and no Save or Delete", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /Mutual NDA/ }));

    const box = await screen.findByLabelText("Playbook (YAML)");
    expect(box).toHaveAttribute("readonly");
    expect(box).toHaveValue(builtIn().yaml);
    expect(screen.getByText(/Built in and read-only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to edit" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete playbook" })).not.toBeInTheDocument();
    // Nothing to check in a text that can not change.
    expect(validations(server)).toHaveLength(0);
    // Typing into it changes nothing.
    await user.type(box, "extra");
    expect(box).toHaveValue(builtIn().yaml);
  });

  it("is copied into a new playbook that is saved only when asked", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /Mutual NDA/ }));
    await user.click(await screen.findByRole("button", { name: "Copy to edit" }));

    expect(await screen.findByRole("heading", { name: "New playbook" })).toBeInTheDocument();
    expect(editor()).not.toHaveAttribute("readonly");
    expect(editor()).toHaveValue(builtIn().yaml);
    expect(
      screen.getByText(/This is a copy of "Mutual NDA \(receiving party\)"\. Change the name/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /The playbook is valid: Mutual NDA \(receiving party\), 2 rules, for nda\./,
      ),
    ).toBeInTheDocument();
    expect(server.callsTo("POST", "/api/playbooks")).toHaveLength(0);

    const box = editor();
    await user.clear(box);
    fireEvent.change(box, { target: { value: "name: My own NDA\nrules: []\n" } });
    await screen.findByText(/The playbook is valid: My own NDA/);
    await user.click(screen.getByRole("button", { name: "Save as a new playbook" }));

    await waitFor(() => {
      expect(server.callsTo("POST", "/api/playbooks")).toHaveLength(1);
    });
    expect(server.callsTo("POST", "/api/playbooks")[0]?.body).toEqual({
      yaml: "name: My own NDA\nrules: []\n",
    });
    // The new playbook is now a saved one of the user's own, and the list shows it.
    expect(await screen.findByText('Saved "My own NDA".')).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "My own NDA" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My own NDA/ })).toHaveTextContent("Yours");
    expect(screen.getByRole("button", { name: "Delete playbook" })).toBeInTheDocument();
    expect(announced()).toBe("Saved My own NDA.");
  });
});

describe("Playbooks screen: live validation", () => {
  it("waits until typing stops, then checks the final text once", async () => {
    useFakeClock();
    const { server, user } = openScreen(undefined, { advanceTimers: vi.advanceTimersByTime });
    await advance(0);
    await user.click(screen.getByRole("button", { name: /My NDA/ }));
    await advance(0);
    // The text that was opened is checked straight away.
    await advance(0);
    expect(validations(server)).toEqual([CUSTOM_YAML]);

    await user.type(editor(), "# a");
    await advance(VALIDATE_DEBOUNCE_MS - 1);
    expect(validations(server)).toHaveLength(1);
    expect(
      screen.getByText("Checking the playbook...", { selector: "p.muted" }),
    ).toBeInTheDocument();
    await user.type(editor(), "b");
    await advance(VALIDATE_DEBOUNCE_MS - 1);
    expect(validations(server)).toHaveLength(1);
    await advance(1);
    expect(validations(server)).toEqual([CUSTOM_YAML, `${CUSTOM_YAML}# ab`]);
    expect(screen.getByText(/The playbook is valid: My NDA/)).toBeInTheDocument();
  });

  it("lists every problem the server finds, and does not allow saving", async () => {
    const server = createFakeServer({ playbooks: [builtIn(), custom()] });
    server.state.validate = () => ({
      ok: false,
      problems: [
        "rules[0].severity: must be high, medium or low.",
        "rules[1].id: duplicate id term.",
        "The playbook needs a name.",
      ],
    });
    const { user } = openScreen(server);
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    fireEvent.change(await screen.findByLabelText("Playbook (YAML)"), {
      target: { value: "rules: 5" },
    });

    expect(await screen.findByText("3 problems to fix")).toBeInTheDocument();
    const problems = document.querySelector(".validation-problems") as HTMLElement;
    expect(
      within(problems)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "rules[0].severity: must be high, medium or low.",
      "rules[1].id: duplicate id term.",
      "The playbook needs a name.",
    ]);
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Fix the problems above to save.")).toBeInTheDocument();
  });

  it("says 1 problem for one", async () => {
    const server = createFakeServer({ playbooks: [builtIn(), custom()] });
    server.state.validate = () => ({ ok: false, problems: ["The playbook needs a name."] });
    const { user } = openScreen(server);
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    expect(await screen.findByText("1 problem to fix")).toBeInTheDocument();
  });

  it("drops an answer for text that has changed since, so a slow answer can not overwrite a newer one", async () => {
    const server = createFakeServer({ playbooks: [builtIn(), custom()] });
    const { user } = openScreen(server);
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid: My NDA/);

    // The check of the first edit is slow and says the text is fine.
    const releaseSlow = server.hold(
      (call) =>
        call.path === "/api/playbooks/validate" &&
        (call.body as { yaml: string }).yaml.endsWith("first"),
    );
    fireEvent.change(editor(), { target: { value: "name: first" } });
    await waitFor(
      () => {
        expect(validations(server).filter((y) => y.endsWith("first"))).toHaveLength(1);
      },
      { timeout: 2000 },
    );
    // The second edit is checked quickly and has problems.
    server.state.validate = (yaml) =>
      yaml.endsWith("second")
        ? { ok: false, problems: ["Second text is wrong."] }
        : { ok: true, name: "first", ruleCount: 1, contractTypes: [] };
    fireEvent.change(editor(), { target: { value: "name: second" } });
    expect(
      await screen.findByText("Second text is wrong.", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    releaseSlow();
    // Let the slow answer arrive. It is for text that is no longer in the box.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("Second text is wrong.")).toBeInTheDocument();
    expect(screen.queryByText(/The playbook is valid: first/)).not.toBeInTheDocument();
  });

  it("does not ask the server about an empty playbook", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    const before = validations(server).length;
    fireEvent.change(editor(), { target: { value: "   \n" } });
    expect(
      await screen.findByText("The playbook is empty. Type or paste its YAML."),
    ).toBeInTheDocument();
    expect(validations(server)).toHaveLength(before);
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("does not send a playbook larger than the server accepts", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    const before = validations(server).length;
    fireEvent.change(editor(), { target: { value: "name: big\n" + "# padding\n".repeat(30_000) } });
    expect(await screen.findByText(/The playbook is larger than 256 KB/)).toBeInTheDocument();
    expect(validations(server)).toHaveLength(before);
  });

  it("says so when the check itself fails, and does not allow saving", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    server.failNext((call) => call.path === "/api/playbooks/validate", {
      status: 500,
      code: "internal_error",
      message: "The checker is down.",
    });
    fireEvent.change(editor(), { target: { value: "name: changed" } });
    expect(
      await screen.findByText(/The playbook could not be checked\. The checker is down\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByText("The playbook could not be checked, so it can not be saved yet."),
    ).toBeInTheDocument();
  });
});

describe("Playbooks screen: saving and deleting", () => {
  it("saves changes to the user's own playbook with a PUT of the text", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    const save = await screen.findByRole("button", { name: "Save changes" });
    await screen.findByText(/The playbook is valid/);
    // Nothing has changed yet.
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("There are no changes to save.");

    fireEvent.change(editor(), { target: { value: "name: My NDA, second edition\nrules: []\n" } });
    await screen.findByText(/The playbook is valid: My NDA, second edition/);
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(save);

    await waitFor(() => {
      expect(server.callsTo("PUT", "/api/playbooks/custom-1")).toHaveLength(1);
    });
    expect(server.callsTo("PUT", "/api/playbooks/custom-1")[0]?.body).toEqual({
      yaml: "name: My NDA, second edition\nrules: []\n",
    });
    expect(await screen.findByText('Saved "My NDA, second edition".')).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "My NDA, second edition" }),
    ).toBeInTheDocument();
    // Saved: nothing left to save.
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      await screen.findByRole("button", { name: /My NDA, second edition/ }),
    ).toBeInTheDocument();
  });

  it("shows the server's message when saving fails, and keeps the text", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    fireEvent.change(editor(), { target: { value: "name: changed" } });
    await screen.findByText(/The playbook is valid: changed/);
    server.failNext((call) => call.method === "PUT", {
      status: 400,
      code: "bad_request",
      message: "A playbook with the name changed already exists.",
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The playbook was not saved");
    expect(alert).toHaveTextContent("A playbook with the name changed already exists.");
    expect(editor()).toHaveValue("name: changed");
    expect(screen.getByRole("button", { name: "Save changes" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("asks before it deletes, and deletes only when told to", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await user.click(await screen.findByRole("button", { name: "Delete playbook" }));

    const group = screen.getByRole("group", { name: /Delete "My NDA"\?/ });
    expect(group).toHaveTextContent("Reviews that already used it keep their own copy.");
    expect(server.callsTo("DELETE", "/api/playbooks/custom-1")).toHaveLength(0);
    // The safe answer has the focus.
    expect(within(group).getByRole("button", { name: "Keep it" })).toHaveFocus();

    await user.click(within(group).getByRole("button", { name: "Keep it" }));
    expect(server.callsTo("DELETE", "/api/playbooks/custom-1")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Delete playbook" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Delete playbook" }));
    await user.click(screen.getByRole("button", { name: "Delete it" }));
    await waitFor(() => {
      expect(server.callsTo("DELETE", "/api/playbooks/custom-1")).toHaveLength(1);
    });
    expect(await screen.findByText('Deleted "My NDA".')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /My NDA/ })).not.toBeInTheDocument();
    });
    expect(screen.getByText("Choose a playbook to read it.")).toBeInTheDocument();
    expect(announced()).toBe("Deleted My NDA.");
  });

  it("shows the server's message when deleting fails", async () => {
    const { server, user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    server.failNext((call) => call.method === "DELETE", {
      status: 500,
      code: "internal_error",
      message: "The database is busy.",
    });
    await user.click(await screen.findByRole("button", { name: "Delete playbook" }));
    await user.click(screen.getByRole("button", { name: "Delete it" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The playbook was not deleted");
    expect(alert).toHaveTextContent("The database is busy.");
    expect(screen.getByRole("button", { name: /My NDA/ })).toBeInTheDocument();
  });
});

describe("Playbooks screen: unsaved changes", () => {
  it("asks before another playbook is opened over them", async () => {
    const { user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    fireEvent.change(editor(), { target: { value: "name: half written" } });

    await user.click(screen.getByRole("button", { name: /Mutual NDA/ }));
    expect(screen.getByText("You have changes that are not saved")).toBeInTheDocument();
    // Still on the first one, text intact.
    expect(editor()).toHaveValue("name: half written");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("You have changes that are not saved")).not.toBeInTheDocument();
    expect(editor()).toHaveValue("name: half written");

    await user.click(screen.getByRole("button", { name: /Mutual NDA/ }));
    await user.click(screen.getByRole("button", { name: "Discard and open" }));
    expect(
      await screen.findByRole("heading", { name: "Mutual NDA (receiving party)" }),
    ).toBeInTheDocument();
    expect(editor()).toHaveAttribute("readonly");
  });

  it("does not ask when nothing was changed", async () => {
    const { user } = openScreen();
    await user.click(await screen.findByRole("button", { name: /My NDA/ }));
    await screen.findByText(/The playbook is valid/);
    await user.click(screen.getByRole("button", { name: /Mutual NDA/ }));
    expect(screen.queryByText("You have changes that are not saved")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Mutual NDA (receiving party)" }),
    ).toBeInTheDocument();
  });
});
