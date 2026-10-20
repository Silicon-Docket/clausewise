// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TOKEN_STORAGE_KEY } from "../src/api/token.js";
import { reviewDetail } from "./fixtures.js";
import { installCommonHooks, memoryStorage, renderApp } from "./support.js";

installCommonHooks();

const TOKEN = "correct-horse-battery";

describe("the access token screen", () => {
  it("is shown instead of the app when the server needs a token and none is held", async () => {
    const { server } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    expect(
      await screen.findByRole("heading", { name: "This server asks for an access token" }),
    ).toBeInTheDocument();
    const field = screen.getByLabelText("Access token");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    // The rest of the app is not there, and has asked the server for nothing.
    expect(screen.queryByRole("heading", { name: "Review a contract" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(server.calls.map((call) => call.path)).toEqual(["/api/config"]);
  });

  it("is not shown when the server needs no token", async () => {
    renderApp("#/");
    expect(await screen.findByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  });

  it("says a wrong token was not accepted, and keeps nothing", async () => {
    const { server, user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    await user.type(await screen.findByLabelText("Access token"), "wrong-token-value");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That token was not accepted. Check it and try again.",
    );
    expect(
      screen.getByRole("heading", { name: "This server asks for an access token" }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    // The token was tried against the server, and only there.
    expect(server.callsTo("GET", "/api/playbooks")[0]?.authorization).toBe(
      "Bearer wrong-token-value",
    );
  });

  it("ties the field to the reason it was refused, so that it is read with the field", async () => {
    const { user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    const field = await screen.findByLabelText("Access token");
    expect(field).toHaveAttribute("aria-invalid", "false");
    await user.type(field, "wrong-token-value");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");

    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(field).toHaveAccessibleDescription(
      expect.stringContaining("That token was not accepted"),
    );
    // The hint stays part of the description as well.
    expect(field).toHaveAccessibleDescription(expect.stringContaining("never stored in a cookie"));
    // The button that was pressed is still where the focus is.
    expect(screen.getByRole("button", { name: "Continue" })).not.toHaveAttribute("aria-disabled");
  });

  it("asks for a token when the box is empty", async () => {
    const { server, user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the access token.");
    expect(server.calls).toHaveLength(1);
  });

  it("opens the app with the right token, keeps it in this tab's session storage and sends it with every request", async () => {
    const { server, user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    await user.type(await screen.findByLabelText("Access token"), `  ${TOKEN}  `);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(document.cookie).toBe("");

    await screen.findByText(/No reviews yet/);
    const api = server.calls.filter(
      (call) => call.path.startsWith("/api/") && call.path !== "/api/config",
    );
    expect(api.length).toBeGreaterThan(1);
    for (const call of api) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    // The config needs no token, so the app can learn that it must ask for one.
    expect(server.callsTo("GET", "/api/config")[0]?.authorization).toBeNull();
  });

  it("never puts the token in an address, a request body or the page", async () => {
    const { server, user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    await user.type(await screen.findByLabelText("Access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/No reviews yet/);
    for (const call of server.calls) {
      expect(call.path + call.search).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("is not asked for again after a reload, while the tab is open", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { server } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    expect(await screen.findByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    // The list of reviews is the first thing the start screen asks for, and it carries the token.
    await screen.findByText(/No reviews yet/);
    expect(server.callsTo("GET", "/api/reviews")[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("is shown again, with a reason, when the server refuses the token that was held", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, "an-old-token-value");
    renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    expect(
      await screen.findByRole("heading", { name: "This server asks for an access token" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The server did not accept the token this page was using. Enter it again."),
    ).toBeInTheDocument();
    // The refused token is forgotten.
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("is shown when the server starts asking for a token in the middle of a session", async () => {
    const { server } = renderApp("#/reviews/rev-1", { reviews: [reviewDetail()] });
    await screen.findByRole("heading", { name: "Summary" });
    // The server is restarted with a token. The page still has the old settings.
    server.state.token = TOKEN;
    server.state.config = { ...server.state.config, authRequired: true };
    window.location.hash = "#/playbooks";
    expect(
      await screen.findByRole("heading", { name: "This server asks for an access token" }),
    ).toBeInTheDocument();
    // Not "refused": this page never held a token.
    expect(
      screen.queryByText(/did not accept the token this page was using/),
    ).not.toBeInTheDocument();
  });

  it("lets the person forget the token, which brings the screen back", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const { user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    await screen.findByRole("heading", { name: "Review a contract" });
    await user.click(screen.getByRole("button", { name: "Forget the access token" }));
    expect(
      await screen.findByRole("heading", { name: "This server asks for an access token" }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("shows the server's message when the check fails for another reason", async () => {
    const { server, user } = renderApp("#/", { config: { authRequired: true }, token: TOKEN });
    server.failNext((call) => call.path === "/api/playbooks", {
      status: 500,
      code: "internal_error",
      message: "The database is not answering.",
    });
    await user.type(await screen.findByLabelText("Access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The database is not answering.");
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe("when the browser blocks storage", () => {
  it("works with the token in memory only", async () => {
    const { server, user } = renderApp("#/", {
      config: { authRequired: true },
      token: TOKEN,
      storage: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    await user.type(await screen.findByLabelText("Access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    await screen.findByText(/No reviews yet/);
    expect(server.callsTo("GET", "/api/reviews")[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("works when storage exists but every write fails", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const { user } = renderApp("#/", {
      config: { authRequired: true },
      token: TOKEN,
      storage: () => storage,
    });
    await user.type(await screen.findByLabelText("Access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Review a contract" })).toBeInTheDocument();
    });
  });
});
