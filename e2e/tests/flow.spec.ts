import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { parseDocx } from "../../packages/docx/src/index.js";
import { differingParagraphs, readDocx } from "../docx-reader.js";
import { expect, test } from "../fixtures.js";
import { fixturePath } from "../paths.js";
import {
  REJECTED_KEY_MESSAGE,
  scriptedEdit,
  SLOW_CLIENT_MARKER,
  UNANCHORED_CLIENT_MARKER,
} from "../oracle.js";
import {
  card,
  decide,
  decideMany,
  decisionLine,
  download,
  editWording,
  fixtureBytes,
  GOVERNING_LAW,
  MISSING_CLAUSE,
  NDA_PLAYBOOK,
  NDA_TITLES,
  REDLINE_ROUTE,
  redlineButton,
  reviewIdOf,
  everythingButton,
  RETURN_OR_DESTROY,
  reviewContract,
  SAAS_PLAYBOOK,
  startReview,
  storedReview,
  TERM,
  waitForFindings,
} from "../pages.js";

const NDA = "nda-aggressive.docx";

test.describe("a lawyer reviews a contract and downloads a redline", () => {
  test("happy path: one accepted change becomes one tracked change and one comment", async ({
    page,
  }) => {
    const term = await scriptedEdit(NDA, "term");

    // The first screen says where the contract text will go before anything is sent. The page is
    // served with the headers the design promises.
    const opened = await page.goto("/");
    const pageHeaders = opened?.headers() ?? {};
    expect(pageHeaders["content-security-policy"]).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(pageHeaders["x-frame-options"]).toBe("DENY");
    expect(pageHeaders["x-content-type-options"]).toBe("nosniff");
    expect(pageHeaders["referrer-policy"]).toBe("no-referrer");
    expect(pageHeaders["access-control-allow-origin"]).toBeUndefined();
    await expect(
      page.getByText("Reviews are sent to a scripted test oracle (nothing is sent anywhere)."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Pressing Start sends the text of this contract to a scripted test oracle (nothing is sent anywhere).",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
    await expect(page.getByText("Choose a contract to start.")).toBeVisible();

    // The playbook is offered by the name it has in its file.
    await expect(
      page.getByRole("option", { name: "Mutual NDA (receiving party) (10 rules)" }),
    ).toHaveCount(1);

    // The oracle takes a moment over each rule when the client says so, so that progress can be seen.
    const started = await startReview(page, {
      fixture: NDA,
      playbook: NDA_PLAYBOOK,
      client: `Fabrikam Labs LLC, the Recipient ${SLOW_CLIENT_MARKER}`,
    });
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Rules checked" })).toBeVisible();
    await expect(page.getByText(/^[1-9]\d* of 10 rules checked$/)).toBeVisible({ timeout: 20_000 });
    await waitForFindings(page);
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toHaveCount(
      0,
    );

    // The review says what model it used, who it was for, and what it found.
    await expect(
      page.getByText(
        "Model: oracle (oracle). Reviews are sent to a scripted test oracle (nothing is sent anywhere).",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Acting for: Fabrikam Labs LLC, the Recipient/)).toBeVisible();
    await expect(page.getByText("10 rules checked.")).toBeVisible();
    await expect(page.getByText(/4 high, 4 medium, 2 low/)).toBeVisible();

    // Findings are grouped by severity, the worst first.
    // (The count sits in a span of its own, so the text has no space before it; one is drawn by CSS.)
    await expect(page.getByRole("heading", { level: 2, name: /severity\s?\(\d+\)$/ })).toHaveText([
      /^High severity\s?\(4\)$/,
      /^Medium severity\s?\(4\)$/,
      /^Low severity\s?\(2\)$/,
    ]);
    for (const [severity, titles] of Object.entries(NDA_TITLES)) {
      const group = page.getByRole("region", { name: new RegExp(`^${severity} severity`, "i") });
      await expect(group.getByRole("article")).toHaveCount(titles.length);
      for (const title of titles) {
        await expect(group.getByRole("article", { name: title, exact: true })).toBeVisible();
      }
    }

    // A finding shows the clause it is about and the change as a diff inside the paragraph.
    const finding = card(page, TERM);
    await expect(finding.getByRole("figure", { name: "Clause 3.1, 3. Term" })).toContainText(
      term.quote,
    );
    await expect(finding.getByText("Oracle explanation for term.")).toBeVisible();
    await expect(finding.getByRole("deletion")).toHaveCount(1);
    await expect(finding.getByRole("deletion")).toContainText(term.quote);
    await expect(finding.getByRole("insertion")).toHaveCount(1);
    await expect(finding.getByRole("insertion")).toContainText(term.replacement);

    // Nothing is accepted yet, so there is nothing to download.
    await expect(
      page.getByRole("button", { name: "Download redline (0 accepted)" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Accept at least one suggestion to download a redline."),
    ).toBeVisible();

    // Accept exactly one finding.
    await decide(page, TERM, "Accept");
    await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();
    await expect(finding.getByText("Accepted", { exact: true })).toBeVisible();
    await decisionLine(page, { accepted: 1, rejected: 0, pending: 9 }).waitFor();
    const button = redlineButton(page, 1);
    await expect(button).toBeEnabled();

    const saved = await download(page, button, REDLINE_ROUTE);
    expect(saved.fileName).toBe("nda-aggressive.redlined.docx");
    expect(saved.response.status()).toBe(200);
    const headers = saved.response.headers();
    expect(headers["content-disposition"]).toMatch(
      /^attachment; filename="nda-aggressive\.redlined\.docx"/,
    );
    expect(headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-clausewise-warnings"]).toBeUndefined();
    expect(headers["access-control-allow-origin"]).toBeUndefined();

    // Exactly one deletion and one insertion, with the words the finding showed.
    const redline = await readDocx(saved.bytes);
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions.map((change) => change.text)).toEqual([term.replacement]);
    for (const change of [...redline.deletions, ...redline.insertions]) {
      expect(change.author).toBe("Clausewise");
      expect(Math.abs(Date.now() - Date.parse(change.date))).toBeLessThan(24 * 60 * 60 * 1000);
    }

    // The comment of that finding, and no other, anchored once.
    expect(redline.comments).toHaveLength(1);
    expect(redline.comments[0]?.author).toBe("Clausewise");
    expect(redline.comments[0]?.text).toBe(`[HIGH] ${TERM}\nOracle comment for term.`);
    expect(redline.commentRanges).toEqual({ starts: 1, ends: 1, references: 1 });

    // Every other paragraph reads as it did; the one that changed has the replacement in it; and
    // rejecting every change gives the original back.
    const original = await readDocx(await fixtureBytes(NDA));
    expect(original.deletions).toHaveLength(0);
    expect(redline.rejected).toEqual(original.accepted);
    const changed = differingParagraphs(redline.accepted, original.accepted);
    expect(changed).toHaveLength(1);
    const index = changed[0] ?? -1;
    expect(redline.accepted[index]).toBe(
      original.accepted[index]?.replace(term.quote, term.replacement),
    );
    expect(redline.accepted[index]).toContain("end three (3) years after the date of disclosure");

    // The server stored exactly what the screen shows.
    const stored = await storedReview(page.request, started.id);
    expect(stored.findings.filter((item) => item.decision === "accepted")).toHaveLength(1);
  });

  test("the original file and the report can be downloaded too", async ({ page }) => {
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });

    const original = await download(
      page,
      page.getByRole("button", { name: "Download the original file" }),
      /\/api\/documents\/[^/]+\/file$/,
    );
    expect(original.fileName).toBe(NDA);
    expect(Buffer.from(original.bytes).equals(Buffer.from(await fixtureBytes(NDA)))).toBe(true);

    const report = await download(
      page,
      page.getByRole("button", { name: "Download the report (Markdown)" }),
      /\/api\/reviews\/[^/]+\/report\?format=md$/,
    );
    expect(report.fileName).toBe("nda-aggressive.summary.md");
    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain(TERM);
    expect(text).toContain("Oracle explanation for term.");
  });

  test("an edited wording is what the downloaded file inserts", async ({ page }) => {
    const term = await scriptedEdit(NDA, "term");
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });

    // The editor shows the model's wording, and the diff follows what is typed.
    const finding = card(page, TERM);
    await finding.getByRole("button", { name: "Edit wording" }).click();
    const field = finding.getByRole("textbox", { name: "Your wording" });
    await expect(field).toHaveValue(term.replacement);
    await field.fill("end two (2) years after the date of disclosure");
    await expect(finding.getByRole("insertion")).toContainText(
      "end two (2) years after the date of disclosure",
    );
    // Cancel throws the draft away.
    await finding.getByRole("button", { name: "Cancel" }).click();
    await expect(finding.getByRole("insertion")).toContainText(term.replacement);

    // Spaces and a new line at either end of the text are not part of the contract.
    await editWording(
      page,
      TERM,
      "  end two (2) years after the date of disclosure \n",
      "Save and accept",
    );
    await expect(finding.getByText("Suggested change, with your wording")).toBeVisible();
    await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();

    const saved = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    const redline = await readDocx(saved.bytes);
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions.map((change) => change.text)).toEqual([
      "end two (2) years after the date of disclosure",
    ]);
    const original = await readDocx(await fixtureBytes(NDA));
    expect(redline.rejected).toEqual(original.accepted);
    const [index = -1] = differingParagraphs(redline.accepted, original.accepted);
    expect(redline.accepted[index]).toBe(
      original.accepted[index]?.replace(
        term.quote,
        "end two (2) years after the date of disclosure",
      ),
    );
  });

  test("an empty wording gives a deletion and no insertion", async ({ page }) => {
    const term = await scriptedEdit(NDA, "term");
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });

    await editWording(page, TERM, "", "Save and accept");
    await expect(
      card(page, TERM).getByText("This removes the words and puts nothing in their place."),
    ).toBeVisible();

    const saved = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    const redline = await readDocx(saved.bytes);
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions).toHaveLength(0);
    expect(redline.comments).toHaveLength(1);
    const original = await readDocx(await fixtureBytes(NDA));
    expect(redline.rejected).toEqual(original.accepted);
    const [index = -1] = differingParagraphs(redline.accepted, original.accepted);
    expect(redline.accepted[index]).toBe(original.accepted[index]?.replace(term.quote, ""));
  });

  test("a rejected finding leaves no trace in the file, and everything not rejected can be downloaded", async ({
    page,
  }) => {
    const term = await scriptedEdit(NDA, "term");
    const law = await scriptedEdit(NDA, "governing-law");
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });

    // Reject one finding that has an edit and accept another.
    await decide(page, GOVERNING_LAW, "Reject");
    await expect(
      card(page, GOVERNING_LAW).getByRole("button", { name: "Reject", pressed: true }),
    ).toBeVisible();
    await decide(page, TERM, "Accept");
    await decisionLine(page, { accepted: 1, rejected: 1, pending: 8 }).waitFor();

    const original = await readDocx(await fixtureBytes(NDA));
    const accepted = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    const redline = await readDocx(accepted.bytes);
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions.map((change) => change.text)).toEqual([term.replacement]);
    expect(redline.comments).toHaveLength(1);
    expect(redline.comments[0]?.text).toContain(`[HIGH] ${TERM}`);
    expect(redline.comments.map((comment) => comment.text).join("\n")).not.toContain(GOVERNING_LAW);
    // The rejected finding's paragraph is exactly as it was.
    const [changed = -1, ...others] = differingParagraphs(redline.accepted, original.accepted);
    expect(others).toEqual([]);
    expect(original.accepted[changed]).toContain(term.quote);
    expect(redline.accepted.join("\n")).toContain("governed by the laws of Singapore");

    // "Everything not rejected" takes the eight other findings that have an edit and the one that
    // has only a comment, and none of the rejected one.
    const everything = await download(page, everythingButton(page), REDLINE_ROUTE);
    expect(everything.response.url()).toMatch(/include=all$/);
    const all = await readDocx(everything.bytes);
    expect(all.deletions).toHaveLength(8);
    expect(all.insertions).toHaveLength(8);
    expect(all.deletions.map((change) => change.text)).toContain(term.quote);
    expect(all.deletions.map((change) => change.text)).not.toContain(law.quote);
    expect(all.comments).toHaveLength(9);
    const titles = all.comments.map((comment) => comment.text.split("\n")[0]);
    expect(titles).toContain(`[HIGH] ${TERM}`);
    expect(titles).toContain(`[MEDIUM] ${MISSING_CLAUSE}`);
    expect(titles).not.toContain(`[LOW] ${GOVERNING_LAW}`);
    expect(all.rejected).toEqual(original.accepted);
    expect(all.accepted.join("\n")).toContain("governed by the laws of Singapore");
  });

  test("accepting all findings of a severity counts them on the download button", async ({
    page,
  }) => {
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });

    await decideMany(page, "Accept all high");
    await expect(redlineButton(page, 4)).toBeEnabled();
    await decisionLine(page, { accepted: 4, rejected: 0, pending: 6 }).waitFor();
    for (const title of NDA_TITLES.high) {
      await expect(
        card(page, title).getByRole("button", { name: "Accept", pressed: true }),
      ).toBeVisible();
    }
    for (const title of NDA_TITLES.medium) {
      await expect(
        card(page, title).getByRole("button", { name: "Accept", pressed: false }),
      ).toBeVisible();
    }

    // Rejecting a severity adds nothing to the count, and one change of mind takes one away.
    await decideMany(page, "Reject all low");
    await expect(redlineButton(page, 4)).toBeEnabled();
    await decide(page, "Remedies", "Accept");
    await expect(redlineButton(page, 5)).toBeEnabled();
    await decide(page, "Remedies", "Reset");
    await expect(redlineButton(page, 4)).toBeEnabled();
    await decisionLine(page, { accepted: 4, rejected: 2, pending: 4 }).waitFor();

    // The file holds the four, and only them.
    const saved = await download(page, redlineButton(page, 4), REDLINE_ROUTE);
    const redline = await readDocx(saved.bytes);
    expect(redline.deletions).toHaveLength(4);
    expect(redline.insertions).toHaveLength(4);
    expect(redline.comments.map((comment) => comment.text.split("\n")[0]).sort()).toEqual(
      NDA_TITLES.high.map((title) => `[HIGH] ${title}`).sort(),
    );

    // All of them, and none of them.
    await decideMany(page, "Accept all findings");
    await expect(redlineButton(page, 10)).toBeEnabled();
    await decideMany(page, "Clear all decisions");
    await expect(redlineButton(page, 0)).toBeDisabled();
    await decisionLine(page, { accepted: 0, rejected: 0, pending: 10 }).waitFor();
  });

  test("a finding with only a comment keeps its comment and writes no tracked change", async ({
    page,
  }) => {
    await reviewContract(page, {
      fixture: NDA,
      playbook: NDA_PLAYBOOK,
      client: `Fabrikam Labs LLC, the Recipient ${UNANCHORED_CLIENT_MARKER}`,
    });

    // The model's edit could not be placed, so the finding offers its wording as a comment.
    const commentOnly = card(page, RETURN_OR_DESTROY);
    await expect(commentOnly.getByText("Suggested wording, as a comment only")).toBeVisible();
    await expect(commentOnly.getByText("Within thirty (30) days of any request")).toBeVisible();
    await expect(commentOnly.getByRole("deletion")).toHaveCount(0);
    await expect(commentOnly.getByRole("button", { name: "Edit wording" })).toHaveCount(0);
    // A finding for a clause the contract lacks has no edit to show either.
    const missing = card(page, MISSING_CLAUSE);
    await expect(missing.getByText("No clause in the contract covers this.")).toBeVisible();
    await expect(
      missing.getByText("Oracle suggested clause for compelled-disclosure."),
    ).toBeVisible();

    await decide(page, RETURN_OR_DESTROY, "Accept");
    await decide(page, MISSING_CLAUSE, "Accept");
    const saved = await download(page, redlineButton(page, 2), REDLINE_ROUTE);
    const redline = await readDocx(saved.bytes);

    // Two comments, no tracked change, and the text of the contract is untouched.
    expect(redline.deletions).toHaveLength(0);
    expect(redline.insertions).toHaveLength(0);
    expect(redline.comments).toHaveLength(2);
    const byTitle = new Map(
      redline.comments.map((comment) => [comment.text.split("\n")[0], comment.text]),
    );
    // The comment carries the wording that could not be written as a change.
    expect(byTitle.get(`[LOW] ${RETURN_OR_DESTROY}`)).toBe(
      `[LOW] ${RETURN_OR_DESTROY}\nOracle comment for return-or-destroy.\n\nSuggested wording (could not be applied automatically): Within thirty (30) days of any request`,
    );
    expect(byTitle.get(`[MEDIUM] ${MISSING_CLAUSE}`)).toContain(
      "Suggested clause:\nOracle suggested clause for compelled-disclosure.",
    );
    const original = await readDocx(await fixtureBytes(NDA));
    expect(redline.accepted).toEqual(original.accepted);
    expect(redline.rejected).toEqual(original.accepted);
    expect(redline.commentRanges).toEqual({ starts: 2, ends: 2, references: 2 });
  });
});

test.describe("playbooks", () => {
  const NAME = "E2E custom NDA";

  // A scenario that fails half way must not leave its playbook in the other scenarios' select.
  test.afterEach(async ({ request }) => {
    const list = (await (await request.get("/api/playbooks")).json()) as {
      playbooks: { id: string; name: string; source: string }[];
    };
    for (const playbook of list.playbooks) {
      if (playbook.source === "custom" && playbook.name === NAME) {
        await request.delete(`/api/playbooks/${playbook.id}`);
      }
    }
  });

  test("a built-in playbook is copied, broken, fixed, saved, used for a review and deleted", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playbooks" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Playbooks" })).toBeVisible();
    const list = page.getByRole("navigation", { name: "Playbooks" });
    await expect(list.getByRole("button")).toHaveCount(2);

    // A built-in playbook can be read and copied, and not changed.
    await list.getByRole("button", { name: /^Mutual NDA \(receiving party\)/ }).click();
    await expect(
      page.getByText("Built in and read-only. To change it, make a copy and edit that."),
    ).toBeVisible();
    const editor = page.getByRole("textbox", { name: "Playbook (YAML)" });
    await expect(editor).not.toBeEditable();
    await expect(page.getByRole("button", { name: "Delete playbook" })).toHaveCount(0);
    const original = await editor.inputValue();
    expect(original).toContain("name: Mutual NDA (receiving party)");

    await page.getByRole("button", { name: "Copy to edit" }).click();
    await expect(
      page.getByText('This is a copy of "Mutual NDA (receiving party)".', { exact: false }),
    ).toBeVisible();
    await expect(editor).toBeEditable();
    await expect(editor).toHaveValue(original);
    await expect(
      page.getByText(/The playbook is valid: Mutual NDA \(receiving party\), 10 rules/),
    ).toBeVisible();

    const renamed = original.replace("name: Mutual NDA (receiving party)", `name: ${NAME}`);
    const save = page.getByRole("button", { name: "Save as a new playbook" });

    // A rule id used twice: the problem is listed as soon as the typing stops, and Save waits.
    await editor.fill(renamed.replace("id: term\n", "id: mutuality\n"));
    await expect(page.getByText("1 problem to fix")).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: /duplicate rule id "mutuality"/ }),
    ).toHaveCount(1);
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Fix the problems above to save.")).toBeVisible();
    await expect(editor).toHaveAttribute("aria-invalid", "true");

    // A mistake in the YAML itself is listed with its place in the text.
    await editor.fill(`${renamed}\n  - [unclosed`);
    await expect(page.getByText("1 problem to fix")).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: /line \d+, column \d+/ }),
    ).toHaveCount(1);
    await expect(save).toHaveAttribute("aria-disabled", "true");

    // Fixed: valid again, and saved.
    await editor.fill(renamed);
    await expect(
      page.getByText(`The playbook is valid: ${NAME}, 10 rules, for nda.`),
    ).toBeVisible();
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && /\/api\/playbooks$/.test(response.url()),
      ),
      save.click(),
    ]);
    expect(created.status()).toBe(201);
    await expect(page.getByText(`Saved "${NAME}".`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: NAME })).toBeVisible();
    await expect(
      list.getByRole("button", { name: new RegExp(`^${NAME} Yours\\. 10 rules`) }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete playbook" })).toBeVisible();

    // A change to the saved playbook is saved in place.
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await editor.fill(`# Checked by the end to end tests.\n${renamed}`);
    const [updated] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PUT"),
      page.getByRole("button", { name: "Save changes" }).click(),
    ]);
    expect(updated.status()).toBe(200);
    await expect(page.getByText("There are no changes to save.")).toBeVisible();
    // The server stored the new text, not just the page.
    const { id: playbookId } = (await created.json()) as { id: string };
    const stored = (await (await request.get(`/api/playbooks/${playbookId}`)).json()) as {
      yaml: string;
    };
    expect(stored.yaml.startsWith("# Checked by the end to end tests.\n")).toBe(true);

    // It is offered on the start screen, among the playbooks that are yours, and a review can use it.
    const started = await startReview(page, {
      fixture: NDA,
      playbook: { label: `${NAME} (10 rules)` },
    });
    await waitForFindings(page);
    await expect(page.getByText(`Playbook: ${NAME}.`, { exact: false })).toBeVisible();
    await expect(page.getByText("10 findings", { exact: true })).toBeVisible();

    // Deleting asks first, and the review that used the playbook keeps its own copy of it.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playbooks" })
      .click();
    await list.getByRole("button", { name: new RegExp(`^${NAME}`) }).click();
    await page.getByRole("button", { name: "Delete playbook" }).click();
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByRole("button", { name: "Delete playbook" })).toBeVisible();
    await page.getByRole("button", { name: "Delete playbook" }).click();
    const [deleted] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "DELETE"),
      page.getByRole("button", { name: "Delete it" }).click(),
    ]);
    expect(deleted.status()).toBe(204);
    await expect(page.getByText(`Deleted "${NAME}".`, { exact: true })).toBeVisible();
    await expect(list.getByRole("button")).toHaveCount(2);
    const left = (await (await request.get("/api/playbooks")).json()) as {
      playbooks: { source: string }[];
    };
    expect(left.playbooks.filter((playbook) => playbook.source === "custom")).toEqual([]);

    await page.goto(`/#/reviews/${started.id}`);
    await expect(page.getByText(`Playbook: ${NAME}.`, { exact: false })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Reviews" })
      .click();
    await expect(page.getByRole("option", { name: new RegExp(NAME) })).toHaveCount(0);
  });
});

test.describe("what is kept", () => {
  test("decisions survive a reload and a different browser, and deleting the contract removes it all", async ({
    page,
    browser,
    request,
    server,
  }) => {
    const stored = join(server.dataDir, "documents");
    const before = (await readdir(stored)).sort();

    const { id } = await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    const added = (await readdir(stored)).filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);

    await editWording(
      page,
      TERM,
      "end two (2) years after the date of disclosure",
      "Save and accept",
    );
    await decide(page, GOVERNING_LAW, "Reject");
    await decide(page, MISSING_CLAUSE, "Accept");
    await decisionLine(page, { accepted: 2, rejected: 1, pending: 7 }).waitFor();

    const sameDecisions = async (where: typeof page): Promise<void> => {
      await waitForFindings(where);
      await decisionLine(where, { accepted: 2, rejected: 1, pending: 7 }).waitFor();
      await expect(
        card(where, TERM).getByRole("button", { name: "Accept", pressed: true }),
      ).toBeVisible();
      await expect(
        card(where, TERM).getByText("Suggested change, with your wording"),
      ).toBeVisible();
      await expect(card(where, TERM).getByRole("insertion")).toContainText(
        "end two (2) years after the date of disclosure",
      );
      await expect(
        card(where, GOVERNING_LAW).getByRole("button", { name: "Reject", pressed: true }),
      ).toBeVisible();
      await expect(
        card(where, MISSING_CLAUSE).getByRole("button", { name: "Accept", pressed: true }),
      ).toBeVisible();
      await expect(
        card(where, "Remedies").getByRole("button", { name: "Accept", pressed: false }),
      ).toBeVisible();
      await expect(redlineButton(where, 2)).toBeEnabled();
    };

    // The same page, loaded again.
    await page.reload();
    await sameDecisions(page);

    // And a browser that has never seen this review, so the decisions can only have come from the server.
    const other = await browser.newContext({ baseURL: server.url, locale: "en-US" });
    try {
      const second = await other.newPage();
      await second.goto(`/#/reviews/${id}`);
      await sameDecisions(second);
    } finally {
      await other.close();
    }
    const kept = await storedReview(request, id);
    expect(kept.findings.map((finding) => [finding.ruleId, finding.decision])).toContainEqual([
      "term",
      "accepted",
    ]);
    expect(kept.findings.find((finding) => finding.ruleId === "term")?.editedReplacement).toBe(
      "end two (2) years after the date of disclosure",
    );

    // Deleting asks first.
    await page.goto("/");
    const recent = page.getByRole("region", { name: "Recent reviews" }).getByRole("link");
    await expect(recent.first()).toBeVisible();
    const listed = await recent.count();
    await page.goto(`/#/reviews/${id}`);
    await waitForFindings(page);
    await page.getByRole("button", { name: "Delete the contract and its reviews" }).click();
    await expect(
      page.getByText(/Delete "nda-aggressive.docx" and every review of it from this server\?/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(
      page.getByRole("button", { name: "Delete the contract and its reviews" }),
    ).toBeVisible();
    expect(await readdir(stored)).toEqual(expect.arrayContaining(added));

    await page.getByRole("button", { name: "Delete the contract and its reviews" }).click();
    const [deleted] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "DELETE"),
      page.getByRole("button", { name: "Delete everything" }).click(),
    ]);
    expect(deleted.status()).toBe(204);
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Recent reviews" }).getByRole("link"),
    ).toHaveCount(listed - 1);

    // The review is gone for the page, for the server, and from the disk.
    await page.goto(`/#/reviews/${id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "This review could not be opened" }),
    ).toBeVisible();
    expect((await request.get(`/api/reviews/${id}`)).status()).toBe(404);
    expect((await readdir(stored)).sort()).toEqual(before);
  });
});

test.describe("when the model rejects the key", () => {
  test.use({ serverName: "rejected-key" });

  test("the failed review says why in plain words and keeps the provider's text to itself", async ({
    page,
  }) => {
    await page.goto("/");
    // The start screen cannot know that the key is wrong: it is a model like any other.
    await expect(
      page.getByText("Reviews are sent to a scripted test oracle", { exact: false }).first(),
    ).toBeVisible();

    await startReview(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    const failure = page.getByRole("alert").filter({ hasText: "The review did not finish" });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText(REJECTED_KEY_MESSAGE);
    await expect(failure).toContainText("it may be wrong, expired or revoked");
    await expect(page.getByText("invalid x-api-key")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Download redline/ })).toHaveCount(0);

    // The way back lists the review as failed.
    await failure.getByRole("link", { name: "Go back and start it again" }).click();
    await expect(
      page
        .getByRole("region", { name: "Recent reviews" })
        .getByText("Failed", { exact: true })
        .first(),
    ).toBeVisible();
  });
});

test.describe("when no model is set up", () => {
  test.use({ serverName: "unconfigured" });

  test("the start screen shows the problem and Start stays disabled", async ({ page, request }) => {
    await page.goto("/");
    const problem = page.getByRole("alert").filter({ hasText: "The model is not set up" });
    await expect(problem).toBeVisible();
    await expect(problem).toContainText(
      "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. Set it to your Anthropic API key.",
    );
    await expect(problem).toContainText(
      "Fix this in the settings of the server that runs Clausewise",
    );
    // No model line, and no promise about where the text goes, because it goes nowhere.
    await expect(page.getByText(/^Model: /)).toHaveCount(0);
    await expect(page.getByText(/Pressing Start sends/)).toHaveCount(0);

    // Even with a contract chosen there is nothing to start.
    await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(NDA));
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
    await expect(
      page.getByText("The model is not set up, so reviews cannot start yet."),
    ).toBeVisible();

    // The server gives the same answer to anyone who asks it to start anyway.
    const refused = await request.post("/api/reviews", {
      data: {
        documentId: "00000000-0000-4000-8000-000000000000",
        playbookId: "builtin:nda-mutual",
      },
    });
    expect(refused.status()).toBe(503);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_configured");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
  });
});

test.describe("a second contract and playbook", () => {
  const SAAS = "saas-vendor-friendly.docx";
  const LIABILITY = "Limitation of liability";

  test("one accepted edit gives a file that opens", async ({ page }) => {
    const liability = await scriptedEdit(SAAS, "liability-cap");
    await reviewContract(page, { fixture: SAAS, playbook: SAAS_PLAYBOOK });
    await expect(
      page.getByText("Playbook: SaaS subscription agreement (customer).", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("12 rules checked.")).toBeVisible();
    await expect(page.getByText(/5 high, 4 medium, 1 low/)).toBeVisible();
    await expect(
      page.getByText(/2 met the playbook, 0 did not apply, 0 could not be checked/),
    ).toBeVisible();

    // The rules with nothing to change are folded away, and can be read.
    const quiet = page.getByText("Rules with nothing to change (2)");
    await expect(quiet).toBeVisible();
    await quiet.click();
    await expect(page.getByText("Uptime commitment and service credits")).toBeVisible();

    await decide(page, LIABILITY, "Accept");
    const saved = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    expect(saved.fileName).toBe("saas-vendor-friendly.redlined.docx");

    // The download opens with the same library that reads contracts for review: the same number
    // of paragraphs, one of them changed, and that one as the finding said.
    const before = await parseDocx(await fixtureBytes(SAAS));
    const after = await parseDocx(saved.bytes);
    expect(after.paragraphs).toHaveLength(before.paragraphs.length);
    const changed = after.paragraphs.filter(
      (paragraph, index) => paragraph.text !== before.paragraphs[index]?.text,
    );
    expect(changed).toHaveLength(1);
    const paragraph = changed[0];
    expect(paragraph?.text).toBe(
      before.paragraphs[paragraph?.index ?? -1]?.text.replace(
        liability.quote,
        liability.replacement,
      ),
    );

    // One deletion and one insertion. The writer may leave out the words that the old and the new
    // wording share at either end, so each is checked against the scripted edit, not equal to it.
    const redline = await readDocx(saved.bytes);
    expect(redline.deletions).toHaveLength(1);
    expect(redline.insertions).toHaveLength(1);
    expect(liability.quote).toContain(redline.deletions[0]?.text ?? "\0");
    expect(liability.replacement).toContain(redline.insertions[0]?.text ?? "\0");
    expect(redline.comments).toHaveLength(1);
    expect(redline.comments[0]?.text).toContain(`[HIGH] ${LIABILITY}`);
    const original = await readDocx(await fixtureBytes(SAAS));
    expect(redline.rejected).toEqual(original.accepted);
  });

  const run = promisify(execFile);
  const hasLibreOffice = spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0;

  test("LibreOffice converts the download and shows its change and its comment", async ({
    page,
  }, testInfo) => {
    test.skip(
      !hasLibreOffice,
      "LibreOffice (soffice) is not installed here, so the download could not be converted. The same counts are checked with the independent reader in the other scenarios.",
    );
    await reviewContract(page, { fixture: SAAS, playbook: SAAS_PLAYBOOK });
    await decide(page, LIABILITY, "Accept");
    const saved = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    const written = await readDocx(saved.bytes);
    // Counted by the reader first, so that a file with nothing in it cannot pass for a good one.
    expect(written.deletions).toHaveLength(1);
    expect(written.insertions).toHaveLength(1);
    expect(written.comments).toHaveLength(1);

    const dir = testInfo.outputPath("libreoffice");
    await mkdir(join(dir, "profile"), { recursive: true });
    const input = join(dir, "redline.docx");
    await writeFile(input, saved.bytes);
    // A profile folder of its own, so that this run neither uses nor disturbs the user's LibreOffice.
    await run(
      "soffice",
      [
        `-env:UserInstallation=file://${join(dir, "profile")}`,
        "--headless",
        "--convert-to",
        "odt",
        "--outdir",
        dir,
        input,
      ],
      { timeout: 150_000 },
    );
    const odt = await JSZip.loadAsync(await readFile(join(dir, "redline.odt")));
    const content = (await odt.file("content.xml")?.async("string")) ?? "";
    // One deletion and one insertion are two changed regions in LibreOffice's own format.
    expect(content.match(/<text:changed-region[ >]/g)?.length ?? 0).toBe(2);
    expect(content.match(/<office:annotation[ >]/g)?.length ?? 0).toBe(1);
  });
});

test.describe("a server with an access token", () => {
  test.use({ serverName: "token" });

  test("asks for the token, refuses a wrong one, and sends the right one with every request", async ({
    page,
    request,
    server,
  }) => {
    const token = server.accessToken ?? "";
    expect(token).not.toBe("");

    // Without the token the API says no, and the page asks for it.
    const bare = await request.get("/api/reviews");
    expect(bare.status()).toBe(401);
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    expect((await request.get("/healthz")).status()).toBe(200);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "This server asks for an access token" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    const field = page.getByLabel("Access token");
    await field.fill("not-the-token-not-the-token");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "That token was not accepted. Check it and try again.",
    );

    await field.fill(token);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();

    // The token is not in a cookie, and not in storage that outlives the tab.
    expect(await page.context().cookies()).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);

    // The download is a request like the others, and carries it.
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    await decide(page, TERM, "Accept");
    const requested = page.waitForRequest((candidate) => REDLINE_ROUTE.test(candidate.url()));
    const saved = await download(page, redlineButton(page, 1), REDLINE_ROUTE);
    expect((await requested).headers().authorization).toBe(`Bearer ${token}`);
    expect(saved.fileName).toBe("nda-aggressive.redlined.docx");
    expect((await readDocx(saved.bytes)).insertions).toHaveLength(1);

    // Forgetting the token puts the gate back.
    await page.getByRole("button", { name: "Forget the access token" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "This server asks for an access token" }),
    ).toBeVisible();
  });
});

test.describe("a review that is stopped", () => {
  test("cancelling a running review ends it without findings", async ({ page }) => {
    await startReview(page, {
      fixture: NDA,
      playbook: NDA_PLAYBOOK,
      client: `Fabrikam Labs LLC, the Recipient ${SLOW_CLIENT_MARKER}`,
    });
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel review" }).click();
    await expect(
      page.getByText("Stop this review? What has been checked so far is thrown away."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Keep going" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toBeVisible();

    await page.getByRole("button", { name: "Cancel review" }).click();
    await page.getByRole("button", { name: "Stop the review" }).click();
    await expect(page.getByText("This review was cancelled")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toHaveCount(0);
    expect(reviewIdOf(page)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
