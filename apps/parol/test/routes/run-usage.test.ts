import { afterAll, describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import type { RunSummary } from "../../src/services/views.js";
import { byId, readable } from "../pages/html.js";
import { meteredModel } from "../usage/support.js";
import { IDS, cleanup, makeSite, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * The review page and the JSON of a run carry what its model calls used, and say which model
 * answered. The site is the real application over a scripted model that reports usage as the
 * Anthropic adapter does; nothing leaves the machine.
 */

async function reviewedSite(provider: "anthropic" | "simulated") {
  const model2 = meteredModel({
    model: { info: { provider, model: "model-a" } },
    reporter: {
      usageFor: () => ({
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      modelFor: () => "model-a-20260101",
    },
  });
  const site = makeSite({ model2 });
  const { matterId, am } = newMatter(site.w);
  await uploadCase(site.w, matterId);
  const run = site.w.services.runs.start(am, { workflowLabel: "v2" });
  await site.w.services.runs.idle();
  const browser = await site.as(IDS.associate);
  return { site, matterId, runId: run.id, browser, calls: model2.generator.calls.length };
}

describe("a review by a provider that reports usage", () => {
  it("shows the Usage section and the model that answered on the review page", async () => {
    const { browser, matterId, runId, calls } = await reviewedSite("anthropic");
    const page = await browser.page(urls.run(matterId, runId));
    const text = readable(page.root);
    expect(text).toContain("Answered by model-a-20260101 (requested model-a)");
    expect(text).toContain("Usage");
    expect(text).toContain(`from ${calls} of ${calls} recorded model calls.`);
    expect(text).toContain("Cost: not priced. No price is configured for this model.");
    expect(text).not.toContain("$");
  });

  it("shows the model that answered in the table of reviews of the matter page", async () => {
    const { browser, matterId } = await reviewedSite("anthropic");
    const page = await browser.page(urls.matter(matterId));
    expect(readable(byId(page.root, "runs")!)).toContain(
      "Answered by model-a-20260101 (requested model-a)",
    );
  });

  it("gives the JSON of the run the same figures and the same sentences", async () => {
    const { browser, matterId, runId, calls } = await reviewedSite("anthropic");
    const json = (await (
      await browser.api("GET", `/api/matters/${matterId}/runs/${runId}`)
    ).json()) as RunSummary;
    expect(json.model).toEqual({
      provider: "anthropic",
      requested: "model-a",
      reported: "model-a-20260101",
    });
    expect(json.usage).toMatchObject({
      state: "reported",
      calls,
      callsWithUsage: calls,
      inputTokens: 1000 * calls,
      outputTokens: 100 * calls,
      cost: { state: "not_priced", usd: null },
    });
    const page = await browser.page(urls.run(matterId, runId));
    const shown = readable(page.root);
    for (const line of json.usage?.lines ?? []) expect(shown).toContain(line);
    // The list of runs carries it too.
    const list = (await (await browser.api("GET", `/api/matters/${matterId}/runs`)).json()) as {
      runs?: RunSummary[];
    };
    const listed = Array.isArray(list) ? (list as RunSummary[]) : (list.runs ?? []);
    expect(listed[0]?.usage?.calls).toBe(calls);
  });

  it("is readable by a reviewer as well, and by no one outside the matter", async () => {
    const { site, matterId, runId } = await reviewedSite("anthropic");
    const reviewer = await site.as(IDS.reviewer);
    const seen = await reviewer.page(urls.run(matterId, runId));
    expect(readable(seen.root)).toContain("recorded model calls");
    const outsider = await site.as("usr_test_outsider");
    expect((await outsider.get(urls.run(matterId, runId))).status).toBe(404);
    expect((await outsider.get(`/api/matters/${matterId}/runs/${runId}`)).status).toBe(404);
  });
});

describe("a review by a stand-in reader", () => {
  it("says no model was called and shows no figure, in the page and in the JSON", async () => {
    const { browser, matterId, runId } = await reviewedSite("simulated");
    const page = await browser.page(urls.run(matterId, runId));
    const text = readable(page.root);
    expect(text).toContain("No model was called, so there is no usage to record.");
    expect(text).toContain("Read by a scripted stand-in (simulated, model-a)");
    expect(text).not.toContain("Answered by");
    expect(text).not.toContain("recorded model calls");
    const json = (await (
      await browser.api("GET", `/api/matters/${matterId}/runs/${runId}`)
    ).json()) as RunSummary;
    expect(json.usage).toMatchObject({ state: "stand_in", inputTokens: null, callsWithUsage: 0 });
  });
});
