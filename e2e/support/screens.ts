import type { APIRequestContext, Page, PlaywrightWorkerArgs, Route } from "@playwright/test";
import type { ReviewDetail } from "../../packages/api/src/index.js";
import { expect } from "../fixtures.js";
import { SLOW_CLIENT_MARKER, UNANCHORED_CLIENT_MARKER } from "../oracle.js";
import { card } from "../pages.js";
import { fixturePath } from "../paths.js";
import type { RunState } from "../state.js";
import {
  NDA_PLAYBOOK_ID,
  SAAS_PLAYBOOK_ID,
  createReview,
  finishedReview,
  removeDocument,
  uploadFixture,
  waitForEnd,
} from "./api.js";

/**
 * Every screen of the app in each state it can be in, ready to be looked at. A scenario that
 * measures the look of the app (layout, colour, size) walks this list, so that no state is
 * forgotten and every scenario sees the same ones. The states are built through the API and by
 * clicking, and a few that no scripted model produces are made by changing what the server's
 * answer says on the way to the page, which is as honest as it can be about a screen's looks.
 */
export interface Screen {
  name: string;
  /**
   * Opens the screen and waits until it shows. Returns a function that undoes what the opening set
   * up in the page (a changed answer, for instance), or nothing.
   */
  open(page: Page): Promise<(() => Promise<void>) | void>;
  /** Worth a picture for a person to look at. */
  picture?: boolean;
}

export interface ScreenSet {
  screens: Screen[];
  /** The id of the finished review that most screens show. */
  reviewId: string;
  dispose(): Promise<void>;
}

/** Changes the answer the page gets when it reads one review, and nothing else. */
async function reshape(
  page: Page,
  id: string,
  change: (detail: ReviewDetail) => ReviewDetail,
): Promise<() => Promise<void>> {
  const matches = (url: URL): boolean => url.pathname === `/api/reviews/${id}`;
  const handler = async (route: Route): Promise<void> => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const detail = (await response.json()) as ReviewDetail;
    await route.fulfill({ response, json: change(detail) });
  };
  await page.route(matches, handler);
  return () => page.unroute(matches, handler);
}

/**
 * Opens an address and makes sure the page has read it afresh. Going to the address the page is
 * already at, with only a hash, changes nothing in the browser, and the app would not ask the
 * server again, so the state this scenario set up would never reach the screen.
 */
async function visit(page: Page, url: string): Promise<void> {
  const same = page.url() === url;
  await page.goto(url);
  if (same) await page.reload();
}

export async function buildScreens(
  playwright: PlaywrightWorkerArgs["playwright"],
  state: RunState,
): Promise<ScreenSet> {
  const main = await playwright.request.newContext({ baseURL: state.main.url });
  const rejectedKey = await playwright.request.newContext({ baseURL: state["rejected-key"].url });
  const created: Array<{ api: APIRequestContext; id: string }> = [];

  // A finished review with a finding of every kind, a decision of each kind, and a wording to edit.
  const nda = await finishedReview(main, {
    fixture: "nda-aggressive.docx",
    playbookId: NDA_PLAYBOOK_ID,
    client: `Fabrikam Labs LLC, the Recipient ${UNANCHORED_CLIENT_MARKER}`,
  });
  created.push({ api: main, id: nda.document.id });
  for (const [ruleId, decision] of [
    ["term", "accepted"],
    ["remedies", "rejected"],
    ["governing-law", "accepted"],
  ] as const) {
    const patched = await main.patch(`/api/reviews/${nda.review.id}/findings/${ruleId}`, {
      data: { decision },
    });
    expect(patched.status()).toBe(200);
  }

  // A review with rules that need no change.
  const saas = await finishedReview(main, {
    fixture: "saas-vendor-friendly.docx",
    playbookId: SAAS_PLAYBOOK_ID,
  });
  created.push({ api: main, id: saas.document.id });

  // A review that was cancelled while it ran.
  const slow = await uploadFixture(main, "nda-aggressive.docx");
  created.push({ api: main, id: slow.id });
  const started = await createReview(main, {
    documentId: slow.id,
    playbookId: NDA_PLAYBOOK_ID,
    client: `Fabrikam Labs LLC ${SLOW_CLIENT_MARKER}`,
  });
  expect((await main.post(`/api/reviews/${started.id}/cancel`)).status()).toBe(200);
  const cancelled = await waitForEnd(main, started.id);
  expect(cancelled.status).toBe("cancelled");

  // A review the model's provider refused.
  const failed = await finishedReview(rejectedKey, {
    fixture: "nda-aggressive.docx",
    playbookId: NDA_PLAYBOOK_ID,
  });
  created.push({ api: rejectedKey, id: failed.document.id });
  expect(failed.review.status).toBe("failed");

  const reviewUrl = (id: string): string => `${state.main.url}/#/reviews/${id}`;
  const heading = (page: Page, name: string | RegExp, level = 1) =>
    expect(page.getByRole("heading", { level, name })).toBeVisible();
  const findings = async (page: Page, id: string): Promise<void> => {
    await visit(page, reviewUrl(id));
    await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();
  };

  const screens: Screen[] = [
    {
      name: "start",
      picture: true,
      async open(page) {
        await visit(page, `${state.main.url}/`);
        await heading(page, "Review a contract");
        await expect(
          page.getByRole("region", { name: "Recent reviews" }).getByRole("link").first(),
        ).toBeVisible();
      },
    },
    {
      name: "start with a file chosen",
      async open(page) {
        await visit(page, `${state.main.url}/`);
        await heading(page, "Review a contract");
        await page
          .getByLabel("Choose a Word file")
          .setInputFiles(fixturePath("nda-aggressive.docx"));
        await page
          .getByRole("textbox", { name: "Who are you acting for? (optional)" })
          .fill("Fabrikam Labs LLC, the Recipient");
        await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
      },
    },
    {
      name: "start with a file that is refused",
      async open(page) {
        await visit(page, `${state.main.url}/`);
        await heading(page, "Review a contract");
        await page.getByLabel("Choose a Word file").setInputFiles({
          name: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("not a contract"),
        });
        await expect(page.getByRole("alert")).toContainText("not a Word .docx file");
      },
    },
    {
      name: "start with no model",
      async open(page) {
        await visit(page, `${state.unconfigured.url}/`);
        await expect(
          page.getByRole("alert").filter({ hasText: "The model is not set up" }),
        ).toBeVisible();
      },
    },
    {
      name: "review waiting",
      async open(page) {
        const undo = await reshape(page, nda.review.id, (detail) => ({
          ...detail,
          status: "queued",
          progress: { done: 0, total: 0 },
          startedAt: null,
          finishedAt: null,
          open: null,
          findings: [],
          results: [],
          counts: null,
          stats: null,
        }));
        await visit(page, reviewUrl(nda.review.id));
        await expect(
          page.getByRole("heading", { level: 2, name: "Waiting to start" }),
        ).toBeVisible();
        return undo;
      },
    },
    {
      name: "review running",
      async open(page) {
        const undo = await reshape(page, nda.review.id, (detail) => ({
          ...detail,
          status: "running",
          progress: { done: 3, total: 10 },
          finishedAt: null,
          open: null,
          findings: [],
          results: [],
          counts: null,
          stats: null,
        }));
        await visit(page, reviewUrl(nda.review.id));
        await expect(page.getByText("3 of 10 rules checked")).toBeVisible();
        return undo;
      },
    },
    {
      name: "review finished",
      picture: true,
      async open(page) {
        await findings(page, nda.review.id);
        await expect(
          card(page, "Duration of confidentiality obligations").getByRole("insertion"),
        ).toBeVisible();
      },
    },
    {
      name: "review with the wording editor open",
      picture: true,
      async open(page) {
        await findings(page, nda.review.id);
        const term = card(page, "Duration of confidentiality obligations");
        await term.getByRole("button", { name: "Edit wording" }).click();
        await term
          .getByRole("textbox", { name: "Your wording" })
          .fill("end two (2) years after the date of disclosure");
        await expect(term.getByRole("insertion")).toContainText("end two (2) years");
      },
    },
    {
      name: "review with the question before a delete",
      async open(page) {
        await findings(page, nda.review.id);
        await page.getByRole("button", { name: "Delete the contract and its reviews" }).click();
        await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible();
      },
    },
    {
      name: "review with notes from the server",
      async open(page) {
        const undo = await reshape(page, nda.review.id, (detail) => ({
          ...detail,
          warnings: [
            "Two rules could only be checked in part, because the contract is long. Read the clauses yourself.",
          ],
          notShown: {
            trackedInsertions: 2,
            trackedDeletions: 1,
            comments: 3,
            footnotes: 0,
            endnotes: 0,
            headerFooterParts: 1,
            hiddenRuns: 0,
            images: 1,
          },
        }));
        await visit(page, reviewUrl(nda.review.id));
        await expect(page.getByText("Read these first")).toBeVisible();
        await expect(page.getByText("Not shown to the model")).toBeVisible();
        return undo;
      },
    },
    {
      name: "review after a download with notes",
      async open(page) {
        const matches = (url: URL): boolean => /\/api\/reviews\/[^/]+\/docx$/.test(url.pathname);
        const handler = async (route: Route): Promise<void> => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            headers: {
              ...response.headers(),
              "x-clausewise-warnings": encodeURIComponent(
                JSON.stringify([
                  "One change could not be written as a tracked change and became a comment.",
                ]),
              ),
            },
          });
        };
        await page.route(matches, handler);
        await findings(page, nda.review.id);
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: /^Download redline \(\d+ accepted\)$/ }).click();
        await download;
        await expect(page.getByText(/Saved, with 1 note to read/)).toBeVisible();
        return () => page.unroute(matches, handler);
      },
    },
    {
      name: "review with rules that need no change",
      async open(page) {
        await findings(page, saas.review.id);
        await page.getByText(/^Rules with nothing to change/).click();
        await expect(page.getByText("Uptime commitment and service credits")).toBeVisible();
      },
    },
    {
      name: "review cancelled",
      async open(page) {
        await visit(page, reviewUrl(cancelled.id));
        await expect(page.getByText("This review was cancelled")).toBeVisible();
      },
    },
    {
      name: "review failed",
      async open(page) {
        await visit(page, `${state["rejected-key"].url}/#/reviews/${failed.review.id}`);
        await expect(
          page.getByRole("alert").filter({ hasText: "The review did not finish" }),
        ).toBeVisible();
      },
    },
    {
      name: "review that is not there",
      async open(page) {
        await visit(page, reviewUrl("00000000-0000-4000-8000-000000000000"));
        await heading(page, "This review could not be opened");
      },
    },
    {
      name: "playbooks",
      async open(page) {
        await visit(page, `${state.main.url}/#/playbooks`);
        await heading(page, "Playbooks");
      },
    },
    {
      name: "playbook copy with a mistake in it",
      picture: true,
      async open(page) {
        await visit(page, `${state.main.url}/#/playbooks`);
        await heading(page, "Playbooks");
        await page
          .getByRole("navigation", { name: "Playbooks" })
          .getByRole("button", { name: /^Mutual NDA/ })
          .click();
        await page.getByRole("button", { name: "Copy to edit" }).click();
        await page
          .getByRole("textbox", { name: "Playbook (YAML)" })
          .fill("name: x\nrules:\n  - [unclosed");
        await expect(page.getByText(/problem to fix|problems to fix/)).toBeVisible();
      },
    },
    {
      name: "address that is not a screen",
      async open(page) {
        await visit(page, `${state.main.url}/#/nowhere`);
        await heading(page, "There is nothing at this address");
      },
    },
    {
      name: "access token asked for, after a token was refused",
      async open(page) {
        await visit(page, `${state.token.url}/`);
        await heading(page, "This server asks for an access token");
        await page.evaluate(() =>
          sessionStorage.setItem("clausewise.access-token", "a-token-the-server-does-not-know"),
        );
        await page.reload();
        await expect(
          page.getByText("The server did not accept the token this page was using."),
        ).toBeVisible();
      },
    },
    {
      name: "access token asked for, after a wrong one was typed",
      async open(page) {
        await visit(page, `${state.token.url}/`);
        await heading(page, "This server asks for an access token");
        await page.getByLabel("Access token").fill("wrong-wrong-wrong-wrong");
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("alert")).toContainText("That token was not accepted");
      },
    },
  ];

  return {
    screens,
    reviewId: nda.review.id,
    async dispose() {
      for (const { api, id } of created) await removeDocument(api, id);
      await main.dispose();
      await rejectedKey.dispose();
    },
  };
}
