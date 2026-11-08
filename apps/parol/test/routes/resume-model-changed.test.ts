import { ModelRequestError } from "@clausewise/llm";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { createServices } from "../../src/services/index.js";
import { urls } from "../../src/server/urls.js";
import type { RunSummary } from "../../src/services/views.js";
import { urlEncoded } from "../integration/layers-support.js";
import { byId, readable } from "../pages/html.js";
import {
  Browser,
  IDS,
  cleanup,
  controlledModel,
  csrfOf,
  makeSite,
  newMatter,
  uploadCase,
} from "./support.js";

afterAll(cleanup);

/**
 * A failed run was started on one provider and model. The server now runs on another: the run
 * cannot be resumed (what it recorded would no longer be true of it), and the way on is a new
 * review. The page must say so instead of offering a button that can only fail.
 */

async function failedRunOnAnotherModel() {
  const site = makeSite({
    model: {
      before: (call) => {
        if (call.kind === "extract") throw new ModelRequestError("no key", 401);
      },
    },
  });
  const { matterId, am } = newMatter(site.w);
  await uploadCase(site.w, matterId);
  const run = site.w.services.runs.start(am, { workflowLabel: "v2" });
  await site.w.services.runs.idle();
  expect(site.w.services.runs.get(am, run.id)).toMatchObject({ status: "failed" });

  // The same database and files, under another model.
  const other = controlledModel({ info: { provider: "simulated", model: "another-model" } });
  const services = createServices({ ...site.w.deps, generator: other.generator });
  const deps = { ...site.deps, services };
  const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
  registerRoutes(app, deps);
  const browser = new Browser(app);
  await browser.signIn(IDS.associate);
  return { site, matterId, runId: run.id, browser, services, am };
}

describe("a failed run on a model that is no longer the one in use", () => {
  it("is not resumable in the run summary, and a run on the same model is", async () => {
    const { site, am, runId, services } = await failedRunOnAnotherModel();
    expect(services.runs.get(am, runId)).toMatchObject({
      status: "failed",
      current: true,
      resumable: false,
    });
    expect(site.w.services.runs.get(am, runId)).toMatchObject({ current: true, resumable: true });
  });

  it("offers no Resume on the matter page, and says a new review is the way on", async () => {
    const { browser, matterId, runId } = await failedRunOnAnotherModel();
    const page = await browser.page(urls.matter(matterId));
    expect(browser.hasForm(page, urls.runResume(matterId, runId))).toBe(false);
    expect(readable(byId(page.root, "runs")!)).toContain("start a new review");
    const runPage = await browser.page(urls.run(matterId, runId));
    expect(runPage.html).toContain("different provider or model");
    expect(runPage.html).not.toContain("Go to the matter to resume it");
  });

  it("says why when a stale form posts the resume anyway, with the service's own words", async () => {
    const { browser, matterId, runId } = await failedRunOnAnotherModel();
    const page = await browser.page(urls.matter(matterId));
    const refused = await browser.send("POST", urls.runResume(matterId, runId), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded([["_csrf", csrfOf(page)]]),
    });
    expect(refused.status).toBe(409);
    const html = await refused.text();
    expect(html).toContain("different provider or model");
    expect(html).toContain("Start a new review instead");
    expect(html).not.toContain("Reload the page and try again");

    const api = await browser.api("POST", `/api/matters/${matterId}/runs/${runId}/resume`);
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
      "run_model_changed",
    );
  });

  it("keeps the Resume button for a failed run on the model in use", async () => {
    const { site, matterId, runId } = await failedRunOnAnotherModel();
    const browser = await site.as(IDS.associate);
    const page = await browser.page(urls.matter(matterId));
    expect(browser.hasForm(page, urls.runResume(matterId, runId))).toBe(true);
    const summary = (await (
      await browser.get(`/api/matters/${matterId}/runs/${runId}`)
    ).json()) as RunSummary;
    expect(summary.resumable).toBe(true);
  });
});
