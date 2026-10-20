// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { docxFile, reviewDetail } from "./fixtures.js";
import {
  createFakeServer,
  MESSAGES,
  tooLargeMessage,
  tooManyReviewsMessage,
} from "./fakeServer.js";
import { announced, installCommonHooks, renderApp } from "./support.js";

installCommonHooks();

const contract = (name = "Acme NDA.docx"): File => docxFile(name);

describe("Start screen: the model line", () => {
  it("says where the contract text goes, and again next to the Start button", async () => {
    renderApp("#/");
    expect(
      await screen.findByText(/Reviews are sent to Anthropic API \(api\.anthropic\.com\)\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Model: claude-test-model \(anthropic\)/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pressing Start sends the text of this contract to Anthropic API (api.anthropic.com).",
      ),
    ).toBeInTheDocument();
  });

  it("shows a sentence from the server as it is and does not say it twice", async () => {
    renderApp("#/", {
      config: {
        model: {
          configured: true,
          provider: "openai-compatible",
          model: "local",
          disclosure: "Nothing leaves this machine.",
        },
      },
    });
    expect(
      await screen.findByText(/Model: local \(openai-compatible\)\. Nothing leaves this machine\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reviews are sent to Nothing/)).not.toBeInTheDocument();
  });

  it("shows the problem in plain words and disables Start when the model is not set up", async () => {
    renderApp("#/", {
      config: {
        model: {
          configured: false,
          problem: "ANTHROPIC_API_KEY is not set. Set it in the server's environment.",
        },
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The model is not set up");
    expect(alert).toHaveTextContent("ANTHROPIC_API_KEY is not set.");
    expect(alert).toHaveTextContent("restart it");
    const start = screen.getByRole("button", { name: "Start review" });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription(
      "The model is not set up, so reviews cannot start yet.",
    );
  });
});

describe("Start screen: choosing a file", () => {
  it("refuses a file that is not a .docx before anything is uploaded", async () => {
    const { server, user } = renderApp("#/", { userOptions: { applyAccept: false } });
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, new File(["%PDF"], "contract.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not a Word .docx file");
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();
    expect(server.callsTo("POST", "/api/documents")).toHaveLength(0);
  });

  it("explains the old .doc format", async () => {
    const { user } = renderApp("#/", { userOptions: { applyAccept: false } });
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, new File(["x"], "old.doc"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save As");
  });

  it("refuses an empty file and one over the server's limit, with the sizes", async () => {
    const { user } = renderApp("#/", {
      config: { maxUploadBytes: 1024 },
      userOptions: { applyAccept: false },
    });
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, new File([], "empty.docx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That file is empty.");
    await user.upload(input, new File(["x".repeat(2048)], "big.docx"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "2 KB, and the largest this server accepts is 1 KB",
      );
    });
  });

  it("takes a file dropped on the zone, and checks it like one that was chosen", async () => {
    const { view } = renderApp("#/");
    await screen.findByLabelText("Choose a Word file");
    const zone = view.container.querySelector(".dropzone") as HTMLElement;

    fireEvent.dragOver(zone);
    expect(zone).toHaveClass("dropzone-active");
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass("dropzone-active");

    fireEvent.drop(zone, { dataTransfer: { files: [new File(["%PDF"], "contract.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not a Word .docx file");
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();

    fireEvent.drop(zone, { dataTransfer: { files: [contract("Dropped NDA.docx")] } });
    expect(await screen.findByText("Dropped NDA.docx")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();
  });

  it("shows the chosen file and lets it be removed", async () => {
    const { user } = renderApp("#/");
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, contract());
    expect(await screen.findByText("Acme NDA.docx")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("Acme NDA.docx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();
  });

  it("explains why Start is disabled until a contract is chosen", async () => {
    renderApp("#/");
    const start = await screen.findByRole("button", { name: "Start review" });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription("Choose a contract to start.");
  });
});

describe("Start screen: starting a review", () => {
  it("uploads the file, then creates the review with the playbook and client, then opens it", async () => {
    const { server, user } = renderApp("#/");
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, contract());

    await user.selectOptions(screen.getByLabelText("Playbook"), "builtin:saas-customer");
    await user.type(
      screen.getByLabelText("Who are you acting for? (optional)"),
      "  Fabrikam Labs LLC, the Recipient ",
    );
    await user.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/reviews\/rev-\d+$/);
    });

    const uploads = server.callsTo("POST", "/api/documents");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.upload).toEqual({ name: "Acme NDA.docx", size: contract().size });
    // The browser sets the multipart boundary, so the client must not set a content type.
    expect(uploads[0]?.contentType).toBeNull();

    const created = server.callsTo("POST", "/api/reviews");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({
      documentId: "doc-1",
      playbookId: "builtin:saas-customer",
      client: "Fabrikam Labs LLC, the Recipient",
    });
    expect(created[0]?.contentType).toBe("application/json");
    // Upload first, review second.
    expect(server.calls.indexOf(uploads[0]!)).toBeLessThan(server.calls.indexOf(created[0]!));
  });

  it("sends no client field when the box is empty or only spaces", async () => {
    const { server, user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    await user.type(screen.getByLabelText("Who are you acting for? (optional)"), "   ");
    await user.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => {
      expect(server.callsTo("POST", "/api/reviews")).toHaveLength(1);
    });
    expect(server.callsTo("POST", "/api/reviews")[0]?.body).toEqual({
      documentId: "doc-1",
      playbookId: "builtin:nda-mutual",
    });
  });

  it("shows the server's message when the upload is refused, and does not start a review", async () => {
    const { server, user } = renderApp("#/");
    server.failNext((call) => call.path === "/api/documents", {
      status: 422,
      code: "invalid_document",
      message: "This file is password protected, so it cannot be read.",
    });
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    await user.click(screen.getByRole("button", { name: "Start review" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The review did not start");
    expect(alert).toHaveTextContent("This file is password protected, so it cannot be read.");
    expect(server.callsTo("POST", "/api/reviews")).toHaveLength(0);
    expect(window.location.hash).toBe("#/");
    expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();
    // The alert is read out by itself; the polite region does not say it a second time.
    expect(announced()).not.toContain("password protected");
  });

  it("brings the focus back to Start after a refusal when locking the fields took it away", async () => {
    const { server, user } = renderApp("#/");
    const release = server.hold((call) => call.path === "/api/documents");
    server.failNext((call) => call.path === "/api/documents", {
      status: 422,
      code: "invalid_document",
      message: "This file is password protected, so it cannot be read.",
    });
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    // Enter in a field submits the form, and the fields are locked while the file goes up.
    await user.click(screen.getByLabelText("Who are you acting for? (optional)"));
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Uploading the contract..." });
    // A browser drops the focus from a field that is disabled under it; jsdom keeps it there. This
    // makes the page see what the browser would show: the focus is on the body.
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => document.body,
    });
    try {
      release();
      await screen.findByRole("alert");
    } finally {
      Reflect.deleteProperty(document, "activeElement");
    }
    expect(screen.getByRole("button", { name: "Start review" })).toHaveFocus();
  });

  it("shows the server's message when the review is refused, and does not upload the file twice on retry", async () => {
    const { server, user } = renderApp("#/");
    server.failNext((call) => call.method === "POST" && call.path === "/api/reviews", {
      status: 503,
      code: "model_not_configured",
      message: "ANTHROPIC_API_KEY is not set.",
    });
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    await user.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ANTHROPIC_API_KEY is not set.");

    await user.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/reviews\//);
    });
    expect(server.callsTo("POST", "/api/documents")).toHaveLength(1);
    expect(server.callsTo("POST", "/api/reviews")).toHaveLength(2);
  });

  it("uploads again when the stored copy is gone", async () => {
    const { server, user } = renderApp("#/");
    server.failNext((call) => call.method === "POST" && call.path === "/api/reviews", {
      status: 404,
      code: "not_found",
      message: MESSAGES.noDocument,
    });
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    await user.click(screen.getByRole("button", { name: "Start review" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/reviews\//);
    });
    expect(server.callsTo("POST", "/api/documents")).toHaveLength(2);
  });

  it("shows pending text and ignores a second press while the upload is on its way", async () => {
    const { server, user } = renderApp("#/");
    const release = server.hold((call) => call.path === "/api/documents");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    const start = screen.getByRole("button", { name: "Start review" });
    await user.click(start);
    const busy = await screen.findByRole("button", { name: "Uploading the contract..." });
    // The button that was pressed keeps the focus: it is unavailable, not disabled.
    expect(busy).toBe(start);
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(busy);
    release();
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/reviews\//);
    });
    expect(server.callsTo("POST", "/api/documents")).toHaveLength(1);
  });

  it("lists the playbooks in groups and says which are the user's own", async () => {
    const server = createFakeServer();
    server.state.playbooks.set("custom-1", {
      ...server.state.playbooks.get("builtin:nda-mutual")!,
      id: "custom-1",
      source: "custom",
      name: "My NDA",
      editable: true,
    });
    renderApp("#/", { server });
    const select = await screen.findByLabelText("Playbook");
    await waitFor(() => {
      expect(within(select).getAllByRole("option")).toHaveLength(3);
    });
    expect(within(select).getByRole("group", { name: "Built in" })).toBeInTheDocument();
    expect(within(select).getByRole("group", { name: "Yours" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "My NDA (10 rules)" })).toBeInTheDocument();
  });

  it("limits the client field to the length the server accepts", async () => {
    renderApp("#/");
    expect(await screen.findByLabelText("Who are you acting for? (optional)")).toHaveAttribute(
      "maxlength",
      "300",
    );
  });
});

describe("Start screen: recent reviews", () => {
  it("lists reviews newest first as links, with the status in words", async () => {
    renderApp("#/", {
      reviews: [
        reviewDetail({ id: "rev-a", documentName: "Alpha.docx" }),
        reviewDetail({
          id: "rev-b",
          documentName: "Beta.docx",
          status: "running",
          progress: { done: 3, total: 10 },
          open: null,
        }),
        reviewDetail({
          id: "rev-c",
          documentName: "Gamma.docx",
          status: "failed",
          error: "The model refused.",
          open: null,
        }),
      ],
    });
    const alpha = await screen.findByRole("link", { name: "Alpha.docx" });
    expect(alpha).toHaveAttribute("href", "#/reviews/rev-a");
    expect(screen.getByRole("link", { name: "Beta.docx" })).toHaveAttribute(
      "href",
      "#/reviews/rev-b",
    );
    expect(screen.getByText("In progress, 3 of 10 rules")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/Open: 1 high, 1 medium, 1 low\./)).toBeInTheDocument();
  });

  it("says so when there are none", async () => {
    renderApp("#/");
    expect(await screen.findByText(/No reviews yet/)).toBeInTheDocument();
  });

  it("shows the server's message when the list can not be loaded, with a way to try again", async () => {
    const server = createFakeServer();
    server.failNext((call) => call.method === "GET" && call.path === "/api/reviews", {
      status: 500,
      code: "internal_error",
      message: "The database is not answering.",
    });
    const { user } = renderApp("#/", { server });
    expect(await screen.findByText(/The database is not answering\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No reviews yet/)).toBeInTheDocument();
  });
});

describe("Start screen: what the server says when it refuses", () => {
  it("shows the advice of a 413 when a file passes the page's check but not the server's", async () => {
    const { server, user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    // The server's limit is lower than the one the page was told at load.
    server.state.config = { ...server.state.config, maxUploadBytes: 1024 * 1024 };
    const big = docxFile("Big.docx", "x".repeat(1024 * 1024 + 1));
    await user.upload(screen.getByLabelText("Choose a different file"), big);
    await user.click(screen.getByRole("button", { name: "Start review" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(tooLargeMessage(1024 * 1024));
    expect(alert).toHaveTextContent("raise CLAUSEWISE_MAX_UPLOAD_MB");
    expect(server.callsTo("POST", "/api/reviews")).toHaveLength(0);
  });

  it("shows the advice of a 429 for a full queue, and for a document that keeps too many reviews", async () => {
    const { server, user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    server.state.queueFull = true;
    await user.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(MESSAGES.queueFull);

    server.state.queueFull = false;
    server.state.maxReviewsPerDocument = 0;
    await user.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(tooManyReviewsMessage(0));
    });
    // The file went up once, whatever happened to the review.
    expect(server.callsTo("POST", "/api/documents")).toHaveLength(1);
  });

  it("shows a 503 as the server wrote it, with the model's problem in it", async () => {
    const { server, user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    // The key was removed and the server restarted while the page was open.
    server.state.config = {
      ...server.state.config,
      model: { configured: false, problem: "ANTHROPIC_API_KEY is not set." },
    };
    await user.click(screen.getByRole("button", { name: "Start review" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`${MESSAGES.modelNotSet} ANTHROPIC_API_KEY is not set.`);
    expect(server.callsTo("POST", "/api/reviews")).toHaveLength(1);
    expect(server.state.reviews.size).toBe(0);
  });

  it("shows a 422 in the document engine's words when the file is not a Word file after all", async () => {
    const { server, user } = renderApp("#/");
    await user.upload(
      await screen.findByLabelText("Choose a Word file"),
      new File(["not a zip"], "scan.docx"),
    );
    await user.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(MESSAGES.notZip);
    expect(server.callsTo("POST", "/api/reviews")).toHaveLength(0);
  });
});

describe("Start screen: the keyboard and the screen reader", () => {
  it("names the drop zone, whose file chooser is a tab stop with a visible button for a label", async () => {
    const { view } = renderApp("#/");
    const input = await screen.findByLabelText("Choose a Word file");
    const zone = view.container.querySelector(".dropzone") as HTMLElement;
    // A drop zone is for the mouse; the keyboard goes through the file input inside it.
    expect(screen.getByRole("group", { name: "Contract" })).toBe(zone);
    expect(zone).toContainElement(input);
    expect(input).not.toBeDisabled();
    expect(input).not.toHaveAttribute("tabindex");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", expect.stringContaining(".docx"));
  });

  it("opens the file chooser on Enter as well as Space, from the keyboard alone", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    const { user } = renderApp("#/");
    const input = await screen.findByLabelText("Choose a Word file");
    input.focus();

    // Enter is turned into the click that opens the chooser, once, and nothing else happens: the
    // form is not submitted by it.
    const entered = fireEvent.keyDown(input, { key: "Enter" });
    expect(entered).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toBe(input);

    // Other keys are left to the browser, Space included, which opens it by itself.
    click.mockClear();
    await user.keyboard(" ");
    await user.keyboard("a");
    expect(click).not.toHaveBeenCalled();
  });

  it("reaches the file chooser by Tab, before the playbook", async () => {
    const { user } = renderApp("#/");
    const input = await screen.findByLabelText("Choose a Word file");
    for (let step = 0; step < 8 && document.activeElement !== input; step++) await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Playbook"));
  });

  it("says out loud which file was chosen", async () => {
    const { user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    expect(announced()).toBe(`Acme NDA.docx chosen, ${contract().size} bytes.`);
  });

  it("ties the problem with a file to the file chooser", async () => {
    const { user } = renderApp("#/", { userOptions: { applyAccept: false } });
    const input = await screen.findByLabelText("Choose a Word file");
    expect(input).not.toHaveAttribute("aria-describedby");
    await user.upload(input, new File(["x"], "old.doc"));
    const alert = await screen.findByRole("alert");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(alert.textContent ?? "");
  });

  it("puts the focus back on the file chooser when the file is removed", async () => {
    const { user } = renderApp("#/");
    await user.upload(await screen.findByLabelText("Choose a Word file"), contract());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByLabelText("Choose a Word file")).toHaveFocus();
  });
});
