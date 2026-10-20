// @vitest-environment jsdom
import type { Finding } from "@clausewise/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../src/api/token.js";
import { REVOKE_AFTER_MS, saveBlob } from "../src/lib/download.js";
import { createFakeServer, MESSAGES, MISMATCH_MESSAGE, type FakeServer } from "./fakeServer.js";
import { appliedFinding, commentOnlyFinding, missingFinding, reviewDetail } from "./fixtures.js";
import { advance, announced, installCommonHooks, renderApp, useFakeClock } from "./support.js";

installCommonHooks();

const TOKEN = "correct-horse-battery";

const accepted = (): Finding[] => [
  appliedFinding({ decision: "accepted" }),
  commentOnlyFinding({ decision: "accepted" }),
  missingFinding(),
];

function open(findings: Finding[] = accepted(), options: { token?: boolean } = {}) {
  if (options.token === true) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
  return renderApp("#/reviews/rev-1", {
    ...(options.token === true ? { config: { authRequired: true }, token: TOKEN } : {}),
    reviews: [reviewDetail({ findings })],
  });
}

const redlineCalls = (server: FakeServer) => server.callsTo("GET", "/api/reviews/rev-1/docx");

/** The redline button, whatever its count says. */
const redlineButton = (): Promise<HTMLElement> =>
  screen.findByRole("button", { name: /^Download redline/ });

describe("download buttons: one way for every case", () => {
  it("are buttons and never links, with or without an access token", async () => {
    for (const token of [false, true]) {
      const { view } = open(accepted(), { token });
      await redlineButton();
      for (const label of [
        "Download redline (2 accepted)",
        "Download with everything not rejected",
        "Download the original file",
        "Download the report (Markdown)",
      ]) {
        expect(screen.getByRole("button", { name: label })).toBeEnabled();
      }
      // No anchor to a file: the addresses carry nothing, and a link could not carry the token or
      // read the notes the server sends with the redline.
      expect(screen.queryAllByRole("link", { name: /Download/ })).toHaveLength(0);
      expect(document.querySelector("a[download], a[href*='/api/']")).toBeNull();
      view.unmount();
      window.sessionStorage.clear();
    }
  });

  it("fetch the redline, save it under the name the server gave, and say so", async () => {
    const { server, saved, user } = open();
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const requests = redlineCalls(server);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.search).toBe("?include=accepted");
    // No token is held, so none is sent; the file is asked for whatever its type.
    expect(requests[0]?.authorization).toBeNull();
    expect(requests[0]?.accept).toBe("*/*");
    expect(saved[0]?.name).toBe("Acme NDA.redlined.docx");
    expect(saved[0]?.blob.type).toContain("wordprocessingml");
    // What the fake put in the file is what the server was asked for: the accepted findings.
    expect(await saved[0]?.blob.text()).toBe("redline:accepted:term|governing-law");
    expect(announced()).toBe("The file was saved as Acme NDA.redlined.docx.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("send the access token with the request when one is held", async () => {
    const { server, saved, user } = open(accepted(), { token: true });
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(redlineCalls(server)[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("send the token even when the settings said none was needed, as soon as one is held", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { server, saved, user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: accepted() })],
    });
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(redlineCalls(server)[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fetch the everything-not-rejected file, which holds the findings nobody rejected", async () => {
    const { server, saved, user } = open([
      appliedFinding({ decision: "accepted", editedReplacement: "two (2) years" }),
      commentOnlyFinding({ decision: "rejected" }),
      missingFinding(),
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Download with everything not rejected" }),
    );
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(redlineCalls(server)[0]?.search).toBe("?include=all");
    // The lawyer's own wording goes with the finding, and the rejected one stays out.
    expect(await saved[0]?.blob.text()).toBe(
      "redline:all:term=two (2) years|return-of-information",
    );
  });

  it("save the original and the report under the names the server gave", async () => {
    const { server, saved, user } = open();
    await user.click(await screen.findByRole("button", { name: "Download the original file" }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.name).toBe("Acme NDA.docx");
    expect(server.callsTo("GET", "/api/documents/doc-1/file")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Download the report (Markdown)" }));
    await waitFor(() => {
      expect(saved).toHaveLength(2);
    });
    expect(saved[1]?.name).toBe("Acme NDA.summary.md");
    expect(server.callsTo("GET", "/api/reviews/rev-1/report")[0]?.search).toBe("?format=md");
  });

  it("make a name from the document's when the server sends none", async () => {
    const { server, saved, user } = open();
    server.state.fileNames = false;
    await user.click(await redlineButton());
    await user.click(screen.getByRole("button", { name: "Download the original file" }));
    await user.click(screen.getByRole("button", { name: "Download the report (Markdown)" }));
    await waitFor(() => {
      expect(saved).toHaveLength(3);
    });
    expect(saved.map((file) => file.name)).toEqual([
      "Acme NDA (redline).docx",
      "Acme NDA.docx",
      "Acme NDA (report).md",
    ]);
  });

  it("prefer the full name in filename* over the ASCII one beside it", async () => {
    const name = `M${String.fromCodePoint(0xfc)}ller Vertrag.docx`;
    const { saved, user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ documentName: name, findings: accepted() })],
    });
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    // The header carried filename="Muller Vertrag.redlined.docx" as well; the real name wins.
    expect(saved[0]?.name).toBe(`M${String.fromCodePoint(0xfc)}ller Vertrag.redlined.docx`);
  });

  it("put nothing about the document in the addresses", async () => {
    const { server, user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ documentName: "Secret Merger Terms.docx", findings: accepted() })],
    });
    await user.click(await redlineButton());
    await user.click(screen.getByRole("button", { name: "Download the original file" }));
    await waitFor(() => {
      expect(server.callsTo("GET", /\/(docx|file)$/)).toHaveLength(2);
    });
    for (const call of server.calls) {
      expect(`${call.path}${call.search}`).not.toMatch(/Secret|Merger/i);
    }
  });
});

describe("download buttons: when they can be used", () => {
  it("is disabled, with the reason shown, while nothing is accepted", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    const primary = await screen.findByRole("button", { name: "Download redline (0 accepted)" });
    expect(primary).toBeDisabled();
    const reason = screen.getByText("Accept at least one suggestion to download a redline.");
    expect(reason).toBeVisible();
    expect(primary).toHaveAccessibleDescription(
      "Accept at least one suggestion to download a redline.",
    );
    // Everything that is not rejected is still on offer.
    expect(
      screen.getByRole("button", { name: "Download with everything not rejected" }),
    ).toBeEnabled();
  });

  it("is enabled as soon as one finding is accepted, and the count follows the decisions", async () => {
    const { user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("button", { name: "Download redline (0 accepted)" });

    await user.click(
      within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
        name: "Accept",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Download redline (1 accepted)" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Accept at least one suggestion to download a redline."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Accept all findings" }));
    expect(
      await screen.findByRole("button", { name: "Download redline (3 accepted)" }),
    ).toBeEnabled();

    await user.click(
      within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
        name: "Reject",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Download redline (2 accepted)" }),
    ).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Reject all findings" }));
    expect(
      await screen.findByRole("button", { name: "Download redline (0 accepted)" }),
    ).toBeDisabled();
    // Nothing is left that is not rejected.
    expect(
      screen.getByRole("button", { name: "Download with everything not rejected" }),
    ).toBeDisabled();
  });

  it("waits while a change is being saved, so that the file always holds what the screen shows", async () => {
    const { server, user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("button", { name: "Download redline (0 accepted)" });
    const release = server.hold((call) => call.method === "PATCH");
    await user.click(
      within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
        name: "Accept",
      }),
    );

    const primary = screen.getByRole("button", { name: "Download redline (1 accepted)" });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAccessibleDescription(
      "Your last change is still being saved. Download when it is.",
    );
    expect(
      screen.getByRole("button", { name: "Download with everything not rejected" }),
    ).toBeDisabled();

    release();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Download redline (1 accepted)" })).toBeEnabled();
    });
  });

  it("shows pending state while the file is on its way, keeps the focus, and does not ask twice", async () => {
    const { server, saved, user } = open();
    const release = server.hold((call) => call.path.endsWith("/docx"));
    const button = await redlineButton();
    await user.click(button);

    const busy = await screen.findByRole("button", { name: "Preparing the file..." });
    // The same button, still focusable: it is unavailable, not disabled.
    expect(busy).toBe(button);
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveFocus();
    await user.click(busy);
    release();
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(redlineCalls(server)).toHaveLength(1);
    const again = await screen.findByRole("button", { name: "Download redline (2 accepted)" });
    expect(again).not.toHaveAttribute("aria-disabled");
    expect(again).toHaveFocus();
  });
});

describe("when the server has notes about a file", () => {
  const NOTES = [
    "The wording for Duration of confidentiality obligations could not be written as a tracked change, so it is a comment instead.",
    "A comment on Governing law was moved to the whole paragraph.",
  ];

  it("shows them in a status that stays, says the file was still saved, and names the file", async () => {
    const { server, saved, user } = open();
    server.state.redline.warnings = NOTES;
    await redlineButton();
    // The box that will hold the notice is in the page before there is anything to say, which is
    // what makes a screen reader read what is put into it.
    const box = document.querySelector<HTMLElement>(".download-notes");
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute("role", "status");

    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    // The file is saved, notes or not.
    expect(saved[0]?.name).toBe("Acme NDA.redlined.docx");

    const notice = await within(box as HTMLElement).findByText(
      /"Acme NDA\.redlined\.docx" was still saved\. The server noted these things while building it:/,
    );
    const body = notice.closest(".notice") as HTMLElement;
    expect(body).toHaveTextContent("Saved, with 2 notes to read");
    for (const note of NOTES) expect(within(body).getByText(note)).toBeInTheDocument();
    expect(within(body).getAllByRole("listitem")).toHaveLength(2);

    // A status, not an alert: nothing cuts in, and the page is not locked behind it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The notice speaks for itself; the polite announcer does not say the same thing again.
    expect(announced()).toBe("");
  });

  it("use the singular for one note", async () => {
    const { server, user } = open();
    server.state.redline.warnings = [NOTES[1] as string];
    await user.click(await redlineButton());
    expect(await screen.findByText("Saved, with 1 note to read")).toBeInTheDocument();
    expect(
      screen.getByText(/was still saved\. The server noted this while building it:/),
    ).toBeInTheDocument();
  });

  it("stay until they are dismissed, through other changes and other downloads", async () => {
    const { server, saved, user } = open();
    server.state.redline.warnings = NOTES;
    await user.click(await redlineButton());
    await screen.findByText("Saved, with 2 notes to read");

    // Another decision, another file: the notice is still there.
    await user.click(
      within(
        screen.getByRole("article", { name: "Return or destruction of information" }),
      ).getByRole("button", { name: "Accept" }),
    );
    await user.click(screen.getByRole("button", { name: "Download the original file" }));
    await waitFor(() => {
      expect(saved).toHaveLength(2);
    });
    expect(screen.getByText("Saved, with 2 notes to read")).toBeInTheDocument();
  });

  it("go when dismissed, and the focus goes to the summary heading, not to the top of the page", async () => {
    const { server, user } = open();
    server.state.redline.warnings = NOTES;
    await user.click(await redlineButton());
    await screen.findByText("Saved, with 2 notes to read");

    const dismiss = screen.getByRole("button", {
      name: "Dismiss the notes about Acme NDA.redlined.docx",
    });
    await user.click(dismiss);
    expect(screen.queryByText("Saved, with 2 notes to read")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Summary" })).toHaveFocus();
    // The box stays in the page for the next notice.
    expect(document.querySelector(".download-notes")).not.toBeNull();
  });

  it("are replaced by the notes of the next redline, and go when that one has none", async () => {
    const { server, user } = open();
    server.state.redline.warnings = NOTES;
    await user.click(await redlineButton());
    await screen.findByText("Saved, with 2 notes to read");

    server.state.redline.warnings = [NOTES[0] as string];
    await user.click(
      await screen.findByRole("button", { name: "Download with everything not rejected" }),
    );
    await screen.findByText("Saved, with 1 note to read");
    expect(screen.queryByText("Saved, with 2 notes to read")).not.toBeInTheDocument();

    server.state.redline.warnings = [];
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(screen.queryByText(/Saved, with/)).not.toBeInTheDocument();
    });
    expect(announced()).toBe("The file was saved as Acme NDA.redlined.docx.");
  });

  it("are shown, as one note that says so, when the header can not be read", async () => {
    const server = createFakeServer({ reviews: [reviewDetail({ findings: accepted() })] });
    const wrapped = {
      ...server,
      // A header that is not valid percent-encoding, as a proxy or a bug might leave it.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await server.fetch(input, init);
        if (!String(input).includes("/docx")) return response;
        const headers = new Headers(response.headers);
        headers.set("X-Clausewise-Warnings", "%E0%A4%A");
        return new Response(response.body, { status: response.status, headers });
      }) as typeof globalThis.fetch,
    };
    const { saved, user } = renderApp("#/reviews/rev-1", { server: wrapped });
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(
      await screen.findByText(/The server added notes about this file, but they could not be read/),
    ).toBeInTheDocument();
  });

  it("are not made up when the server has none", async () => {
    const { saved, user } = open();
    await user.click(await redlineButton());
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(screen.queryByText(/Saved, with/)).not.toBeInTheDocument();
    expect(document.querySelector(".download-notes")?.textContent).toBe("");
  });
});

describe("when a download fails", () => {
  it("shows the server's message when the file can not be made, and saves nothing", async () => {
    const { server, saved, user } = open();
    server.failNext((call) => call.path.endsWith("/docx"), {
      status: 409,
      code: "conflict",
      message: MESSAGES.redlineNotFinished,
    });
    await user.click(await redlineButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      `The file could not be downloaded. ${MESSAGES.redlineNotFinished}`,
    );
    expect(saved).toHaveLength(0);
    // The alert is read out by itself; the polite region stays quiet.
    expect(announced()).toBe("");
  });

  it("shows the redline writer's message when the stored file is not the one that was reviewed", async () => {
    const { server, saved, user } = open();
    server.state.redline.mismatch = MISMATCH_MESSAGE;
    await user.click(await redlineButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(MISMATCH_MESSAGE);
    expect(alert).toHaveTextContent("Check that this is the file that was reviewed");
    expect(saved).toHaveLength(0);
    expect(screen.queryByText(/Saved, with/)).not.toBeInTheDocument();
  });

  it("keeps the button where it was and works again on the next try", async () => {
    const { server, saved, user } = open();
    server.failNext((call) => call.path.endsWith("/docx"), {
      status: 500,
      code: "internal_error",
      message: "Something went wrong inside Clausewise. The details are in the server log.",
    });
    const button = await redlineButton();
    await user.click(button);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /^Download redline/ })).toBe(button);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute("aria-disabled");

    await user.click(button);
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows that the server could not be reached", async () => {
    const server = createFakeServer({ reviews: [reviewDetail({ findings: accepted() })] });
    const wrapped = {
      ...server,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/docx")) throw new TypeError("fetch failed");
        return server.fetch(input, init);
      }) as typeof globalThis.fetch,
    };
    const { saved, user } = renderApp("#/reviews/rev-1", { server: wrapped });
    await user.click(await redlineButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Clausewise server could not be reached.",
    );
    expect(saved).toHaveLength(0);
  });

  it("shows a refused token as the token screen, because the server said no", async () => {
    const { server, user } = open(accepted(), { token: true });
    await redlineButton();
    server.state.token = "a-different-token-1234";
    await user.click(await redlineButton());
    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
  });
});

describe("saveBlob", () => {
  function stubUrls() {
    const create = vi.fn(() => "blob:test-url");
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: create,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revoke,
    });
    return { create, revoke };
  }

  it("downloads from an object URL under the given name, and revokes the URL afterwards", async () => {
    useFakeClock();
    const { create, revoke } = stubUrls();
    const clicked: Array<{ href: string; download: string; inDocument: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        href: this.href,
        download: this.download,
        inDocument: document.body.contains(this),
      });
    });

    const blob = new Blob(["bytes"]);
    saveBlob(blob, "Acme NDA (redline).docx");

    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([
      { href: "blob:test-url", download: "Acme NDA (redline).docx", inDocument: true },
    ]);
    // The link is not left behind in the page.
    expect(document.querySelector("a[download]")).toBeNull();
    // Not yet: the browser needs time to start reading.
    expect(revoke).not.toHaveBeenCalled();
    await advance(REVOKE_AFTER_MS);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test-url");
  });

  it("revokes the URL even when the click throws", async () => {
    useFakeClock();
    const { revoke } = stubUrls();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveBlob(new Blob(["x"]), "a.docx")).toThrow("blocked");
    expect(document.querySelector("a[download]")).toBeNull();
    await advance(REVOKE_AFTER_MS);
    expect(revoke).toHaveBeenCalledWith("blob:test-url");
  });
});

describe("a click that the browser sends to an unavailable button", () => {
  it("does nothing, because aria-disabled stops nothing by itself", async () => {
    const { server, user } = open();
    const release = server.hold((call) => call.path.endsWith("/docx"));
    const button = await redlineButton();
    await user.click(button);
    await screen.findByRole("button", { name: "Preparing the file..." });
    fireEvent.click(button);
    release();
    await waitFor(() => {
      expect(redlineCalls(server)).toHaveLength(1);
    });
  });
});
