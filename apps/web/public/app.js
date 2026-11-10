// The Clausewise page. Plain JavaScript with no build step, loaded under a content security policy
// that allows no inline script. Every text from the API or from a token goes in through
// textContent, never as HTML.
"use strict";

const element = (id) => document.getElementById(id);
const say = (text) => {
  element("status").textContent = text;
};

/** Signs in with Entra ID when the server asks for it, and returns a way to get a token. */
async function signIn(config) {
  if (!config.signIn) return async () => undefined;

  const scopes = [`${config.clientId}/access_as_user`];
  const app = await msal.createStandardPublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: `${location.origin}/`,
    },
    // Tokens are gone when the tab closes, which suits a tool for confidential documents.
    cache: { cacheLocation: "sessionStorage" },
  });
  const returned = await app.handleRedirectPromise();
  if (returned !== null) app.setActiveAccount(returned.account);
  const account = app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;

  element("sign-in").addEventListener("click", () => void app.loginRedirect({ scopes }));
  if (account === null) {
    element("sign-in").hidden = false;
    say("Sign in with your firm's Microsoft account.");
    return undefined;
  }
  app.setActiveAccount(account);
  element("account").textContent = account.name ?? account.username;
  element("sign-out").hidden = false;
  element("sign-out").addEventListener(
    "click",
    () => void app.logoutRedirect({ account, postLogoutRedirectUri: `${location.origin}/` }),
  );

  return async () => {
    try {
      return (await app.acquireTokenSilent({ scopes, account })).accessToken;
    } catch (error) {
      // An expired session or new consent needs the user, so the page goes to Entra ID and back.
      if (error instanceof msal.InteractionRequiredAuthError) {
        await app.acquireTokenRedirect({ scopes, account });
      }
      throw error;
    }
  };
}

function client(getToken) {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    const token = await getToken();
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    }
    return response;
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function review(api, form) {
  const file = element("contract").files[0];
  const clientName = element("client").value.trim();
  const created = await api("/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playbookId: element("playbook").value,
      fileName: file.name,
      ...(clientName === "" ? {} : { client: clientName }),
    }),
  });
  const { id } = await created.json();
  say("Uploading the contract.");
  await api(`/api/reviews/${id}/contract`, { method: "PUT", body: file });
  await api(`/api/reviews/${id}/start`, { method: "POST" });

  for (;;) {
    const record = await (await api(`/api/reviews/${id}`)).json();
    if (record.status === "failed") throw new Error(record.error ?? "The review failed.");
    if (record.status === "done") return record;
    say(record.status === "running" ? "Reviewing the contract." : "Waiting for a reviewer.");
    await pause(2000);
  }
}

function showResults(api, record) {
  const { open } = record;
  element("open").textContent =
    `Open items: ${open.high} high, ${open.medium} medium, ${open.low} low.` +
    (record.unchecked > 0 ? ` ${record.unchecked} rules could not be checked.` : "");
  for (const button of element("results").querySelectorAll("button[data-kind]")) {
    button.onclick = async () => {
      const response = await api(`/api/reviews/${record.id}/results/${button.dataset.kind}`);
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = name?.[1] ?? "result";
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }
  element("results").hidden = false;
}

async function main() {
  const config = await (await fetch("/api/config")).json();
  const getToken = await signIn(config);
  if (getToken === undefined) return;
  const api = client(getToken);

  const { playbooks } = await (await api("/api/playbooks")).json();
  const select = element("playbook");
  for (const playbook of playbooks) {
    const option = document.createElement("option");
    option.value = playbook.id;
    option.textContent = `${playbook.name} (${playbook.rules} rules)`;
    select.append(option);
  }
  element("review").hidden = false;
  say("Choose a playbook and a contract.");

  element("review-form").addEventListener("submit", (event) => {
    event.preventDefault();
    element("results").hidden = true;
    review(api, event.target)
      .then((record) => {
        say("The review is done.");
        showResults(api, record);
      })
      .catch((error) => say(error.message));
  });
}

main().catch((error) => say(`Something went wrong: ${error.message}`));
