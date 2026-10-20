import { readFile } from "node:fs/promises";
import type { APIRequestContext, Download, Locator, Page, Response } from "@playwright/test";
import type { ReviewDetail } from "../packages/api/src/index.js";
import { expect } from "./fixtures.js";
import { fixturePath } from "./paths.js";

/** How the playbook is picked in the select on the start screen. */
export type PlaybookChoice = { value: string } | { label: string };

export const NDA_PLAYBOOK: PlaybookChoice = { value: "builtin:nda-mutual" };
export const SAAS_PLAYBOOK: PlaybookChoice = { value: "builtin:saas-customer" };

/** The titles of the findings the oracle gives nda-aggressive.docx, by severity. */
export const NDA_TITLES = {
  high: [
    "Obligations bind both parties",
    "Standard exclusions",
    "Duration of confidentiality obligations",
    "No hidden restrictive covenants",
  ],
  medium: [
    "Definition of Confidential Information",
    "Permitted use and disclosure to representatives",
    "Disclosure required by law",
    "Remedies",
  ],
  low: ["Return or destruction of information", "Governing law and venue"],
} as const;

export const TERM = "Duration of confidentiality obligations";
export const GOVERNING_LAW = "Governing law and venue";
export const MISSING_CLAUSE = "Disclosure required by law";
export const RETURN_OR_DESTROY = "Return or destruction of information";

const REVIEW_URL = /#\/reviews\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export async function openStart(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
}

export interface StartOptions {
  fixture: string;
  playbook: PlaybookChoice;
  client?: string;
}

/**
 * Does what a lawyer does on the start screen: opens the app, chooses the file and the playbook,
 * says who they act for, and presses Start. Returns once the app has moved to the review.
 */
export async function startReview(page: Page, options: StartOptions): Promise<{ id: string }> {
  await openStart(page);
  await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(options.fixture));
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.getByRole("combobox", { name: "Playbook" }).selectOption(options.playbook);
  if (options.client !== undefined) {
    await page
      .getByRole("textbox", { name: "Who are you acting for? (optional)" })
      .fill(options.client);
  }
  await page.getByRole("button", { name: "Start review" }).click();
  await page.waitForURL(REVIEW_URL);
  return { id: reviewIdOf(page) };
}

export function reviewIdOf(page: Page): string {
  const id = REVIEW_URL.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`The page is not on a review: ${page.url()}`);
  return id;
}

/** Waits until the review has run and its findings are on the screen. */
export async function waitForFindings(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible({
    timeout: 30_000,
  });
}

/** Starts a review and waits for its findings. */
export async function reviewContract(page: Page, options: StartOptions): Promise<{ id: string }> {
  const started = await startReview(page, options);
  await waitForFindings(page);
  return started;
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

/** The card of one finding, found by the title that is its accessible name. */
export function card(page: Page, title: string): Locator {
  return page.getByRole("article", { name: title, exact: true });
}

const isPatch = (response: Response, pattern: RegExp): boolean =>
  response.request().method() === "PATCH" && pattern.test(new URL(response.url()).pathname);

const ONE_FINDING = /\/api\/reviews\/[^/]+\/findings\/[^/]+$/;
const MANY_FINDINGS = /\/api\/reviews\/[^/]+\/findings$/;

/** Runs an action and waits for the save it causes, which must succeed. */
async function saving(page: Page, pattern: RegExp, action: () => Promise<void>): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => isPatch(candidate, pattern)),
    action(),
  ]);
  expect(response.status()).toBe(200);
}

/** Presses Accept, Reject or Reset on a finding and waits until the server has stored it. */
export async function decide(
  page: Page,
  title: string,
  button: "Accept" | "Reject" | "Reset",
): Promise<void> {
  await saving(page, ONE_FINDING, () =>
    card(page, title).getByRole("button", { name: button, exact: true }).click(),
  );
}

/** Presses one of the buttons that decide many findings at once, such as "Accept all high". */
export async function decideMany(page: Page, name: string): Promise<void> {
  await saving(page, MANY_FINDINGS, () => page.getByRole("button", { name, exact: true }).click());
}

/** Opens the wording editor of a finding, types a replacement, and presses the named button. */
export async function editWording(
  page: Page,
  title: string,
  wording: string,
  save: "Save wording" | "Save and accept",
): Promise<void> {
  const finding = card(page, title);
  await finding.getByRole("button", { name: "Edit wording" }).click();
  const field = finding.getByRole("textbox", { name: "Your wording" });
  await field.fill(wording);
  await saving(page, ONE_FINDING, () => finding.getByRole("button", { name: save }).click());
  // The editor closes once the wording is stored.
  await expect(field).toHaveCount(0);
}

export const redlineButton = (page: Page, accepted: number): Locator =>
  page.getByRole("button", { name: `Download redline (${accepted} accepted)`, exact: true });

export const everythingButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Download with everything not rejected", exact: true });

/** "2 accepted, 1 rejected, 7 not decided." from the summary. */
export function decisionLine(
  page: Page,
  counts: { accepted: number; rejected: number; pending: number },
): Locator {
  return page.getByText(
    `${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.pending} not decided.`,
    { exact: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

export interface SavedFile {
  bytes: Uint8Array;
  /** The name the browser would save the file under. */
  fileName: string;
  /** The server's answer to the request the page made for the file. */
  response: Response;
}

/**
 * Presses a download button and collects what happens: the request the page makes, and the file
 * the browser is handed. `route` is the part of the request address that identifies the request.
 */
export async function download(page: Page, button: Locator, route: RegExp): Promise<SavedFile> {
  const [saved, response] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse((candidate) => route.test(candidate.url())),
    button.click(),
  ]);
  return { bytes: await bytesOf(saved), fileName: saved.suggestedFilename(), response };
}

async function bytesOf(saved: Download): Promise<Uint8Array> {
  const failure = await saved.failure();
  if (failure !== null) throw new Error(`The download failed: ${failure}`);
  return new Uint8Array(await readFile(await saved.path()));
}

export const REDLINE_ROUTE = /\/api\/reviews\/[^/]+\/docx\?include=(?:accepted|all)$/;

export const fixtureBytes = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(fixturePath(name)));

// ---------------------------------------------------------------------------------------------
// The server's own view
// ---------------------------------------------------------------------------------------------

/** The review as the server stores it, for a test to compare with what the screen shows. */
export async function storedReview(
  request: APIRequestContext,
  id: string,
  token?: string,
): Promise<ReviewDetail> {
  const response = await request.get(`/api/reviews/${id}`, {
    ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as ReviewDetail;
}
