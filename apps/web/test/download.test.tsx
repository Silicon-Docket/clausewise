// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../src/api/token.js";
import { REVOKE_AFTER_MS, saveBlob } from "../src/lib/download.js";
import { appliedFinding, commentOnlyFinding, missingFinding, reviewDetail } from "./fixtures.js";
import { advance, announced, installCommonHooks, renderApp, useFakeClock } from "./support.js";

installCommonHooks();

const TOKEN = "correct-horse-battery";

describe("download buttons without an access token", () => {
  it("are plain links to the server's addresses, with the count of accepted findings", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          findings: [
            appliedFinding({ decision: "accepted" }),
            commentOnlyFinding({ decision: "accepted" }),
            missingFinding(),
          ],
        }),
      ],
    });
    const primary = await screen.findByRole("link", { name: "Download redline (2 accepted)" });
    expect(primary).toHaveAttribute("href", "/api/reviews/rev-1/docx?include=accepted");
    expect(primary).toHaveAttribute("download");

    const everything = screen.getByRole("link", { name: "Download with everything not rejected" });
    expect(everything).toHaveAttribute("href", "/api/reviews/rev-1/docx?include=all");

    expect(screen.getByRole("link", { name: "Download the original file" })).toHaveAttribute(
      "href",
      "/api/documents/doc-1/file",
    );
    expect(screen.getByRole("link", { name: "Download the report (Markdown)" })).toHaveAttribute(
      "href",
      "/api/reviews/rev-1/report?format=md",
    );
  });

  it("puts nothing about the document in the addresses", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ documentName: "Secret Merger Terms.docx" })],
    });
    await screen.findByRole("heading", { name: "Summary" });
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/Secret|Merger/i);
    }
  });

  it("is disabled, with the reason shown, while nothing is accepted", async () => {
    renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    const primary = await screen.findByRole("button", { name: "Download redline (0 accepted)" });
    expect(primary).toBeDisabled();
    const reason = screen.getByText("Accept at least one suggestion to download a redline.");
    expect(reason).toBeVisible();
    expect(primary).toHaveAccessibleDescription(
      "Accept at least one suggestion to download a redline.",
    );
    expect(screen.queryByRole("link", { name: /Download redline/ })).not.toBeInTheDocument();
    // Everything that is not rejected is still on offer.
    expect(
      screen.getByRole("link", { name: "Download with everything not rejected" }),
    ).toBeInTheDocument();
  });

  it("turns into a link as soon as one finding is accepted, and the count follows the decisions", async () => {
    const { user } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("button", { name: "Download redline (0 accepted)" });

    await user.click(
      within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
        name: "Accept",
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Download redline (1 accepted)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Accept at least one suggestion to download a redline."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Accept all findings" }));
    expect(
      await screen.findByRole("link", { name: "Download redline (3 accepted)" }),
    ).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("article", { name: "Governing law" })).getByRole("button", {
        name: "Reject",
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Download redline (2 accepted)" }),
    ).toBeInTheDocument();

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
    expect(
      await screen.findByRole("link", { name: "Download redline (1 accepted)" }),
    ).toBeInTheDocument();
  });
});

describe("download buttons when an access token is needed", () => {
  function openWithToken() {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    return renderApp("#/reviews/rev-1", {
      config: { authRequired: true },
      token: TOKEN,
      reviews: [
        reviewDetail({
          findings: [appliedFinding({ decision: "accepted" }), commentOnlyFinding()],
        }),
      ],
    });
  }

  it("fetch the file with the token and hand it over as a download, under the name the server gave", async () => {
    const { server, saved, user } = openWithToken();
    // A button, not a link: a link could not carry the Authorization header.
    const button = await screen.findByRole("button", { name: "Download redline (1 accepted)" });
    expect(screen.queryByRole("link", { name: /Download redline/ })).not.toBeInTheDocument();

    await user.click(button);
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const requests = server.callsTo("GET", "/api/reviews/rev-1/docx");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.search).toBe("?include=accepted");
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(saved[0]?.name).toBe("Acme NDA (redline).docx");
    expect(await saved[0]?.blob.text()).toBe("redline:accepted");
    expect(announced()).toContain("the file was saved");
  });

  it("fetches the everything-not-rejected file and the other files the same way", async () => {
    const { server, saved, user } = openWithToken();
    await user.click(
      await screen.findByRole("button", { name: "Download with everything not rejected" }),
    );
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(await saved[0]?.blob.text()).toBe("redline:all");
    expect(server.callsTo("GET", "/api/reviews/rev-1/docx")[0]?.search).toBe("?include=all");

    await user.click(screen.getByRole("button", { name: "Download the original file" }));
    await waitFor(() => {
      expect(saved).toHaveLength(2);
    });
    expect(saved[1]?.name).toBe("original.docx");
    expect(server.callsTo("GET", "/api/documents/doc-1/file")[0]?.authorization).toBe(
      `Bearer ${TOKEN}`,
    );

    await user.click(screen.getByRole("button", { name: "Download the report (Markdown)" }));
    await waitFor(() => {
      expect(saved).toHaveLength(3);
    });
    // The server sent no name for the report, so the screen makes one from the document's name.
    expect(saved[2]?.name).toBe("Acme NDA (report).md");
  });

  it("shows pending state while the file is on its way and does not ask for it twice", async () => {
    const { server, saved, user } = openWithToken();
    const release = server.hold((call) => call.path.endsWith("/docx"));
    await user.click(await screen.findByRole("button", { name: "Download redline (1 accepted)" }));
    const busy = await screen.findByRole("button", { name: "Preparing the file..." });
    expect(busy).toBeDisabled();
    await user.click(busy);
    release();
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(server.callsTo("GET", "/api/reviews/rev-1/docx")).toHaveLength(1);
    expect(
      await screen.findByRole("button", { name: "Download redline (1 accepted)" }),
    ).toBeEnabled();
  });

  it("shows the server's message when the file can not be made, and saves nothing", async () => {
    const { server, saved, user } = openWithToken();
    server.failNext((call) => call.path.endsWith("/docx"), {
      status: 409,
      code: "conflict",
      message: "The review is not finished.",
    });
    await user.click(await screen.findByRole("button", { name: "Download redline (1 accepted)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The file could not be downloaded. The review is not finished.",
    );
    expect(saved).toHaveLength(0);
    expect(announced()).toContain("The review is not finished.");
  });

  it("uses a fetch for the file as soon as a token is held, even if the settings said none was needed", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { saved, user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [appliedFinding({ decision: "accepted" })] })],
    });
    await user.click(await screen.findByRole("button", { name: "Download redline (1 accepted)" }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
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
