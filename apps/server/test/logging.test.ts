import { parseDocx } from "@clausewise/docx";
import { ModelRequestError } from "@clausewise/llm";
import { describe, expect, it } from "vitest";
import { builtinYaml, createHarness, fixtureBytes, oracleFor } from "./support.js";

// Words that only the contract and the people using the server could have put in a log line.
const CONTRACT_WORDS = [
  "Discloser",
  "Recipient",
  "perpetual",
  "indefinitely",
  "Singapore",
  "liquidated damages",
];
const FILE_NAME = "Zeta-merger-indemnity-draft.docx";
const FILE_STEM = "Zeta-merger";
const CLIENT = "Fabrikam Labs LLC, the Recipient";
const TOKEN = "a-long-access-token-0123456789";
const PLAYBOOK_NAME = "House playbook for the Zeta deal";

describe("what the server writes to its log", () => {
  it("holds no document text, file name, client or secret, through uploads, reviews, errors and downloads", async () => {
    const real = await oracleFor("nda-aggressive.docx");
    let failing = false;
    const t = await createHarness({
      generator: {
        ...real,
        generate: (async (request: Parameters<typeof real.generate>[0]) => {
          if (failing) {
            throw new ModelRequestError(
              `401 rejected key for a request that said: ${CONTRACT_WORDS.join(" ")} ${FILE_NAME}`,
              401,
            );
          }
          return real.generate(request);
        }) as typeof real.generate,
      },
      config: { accessToken: TOKEN },
    });

    // The words are in the contract, so that the test cannot pass because it looked for nothing.
    const original = await fixtureBytes("nda-aggressive.docx");
    const text = (await parseDocx(original)).paragraphs.map((p) => p.text).join("\n");
    for (const word of CONTRACT_WORDS) expect(text.toLowerCase()).toContain(word.toLowerCase());

    const auth = { Authorization: `Bearer ${TOKEN}` };
    const json = (body: unknown) => ({
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // An upload, a refused upload that carries contract words, and a refused one by size.
    const form = new FormData();
    form.set("file", new File([original], FILE_NAME));
    const upload = await t.request("/api/documents", { method: "POST", headers: auth, body: form });
    expect(upload.status).toBe(201);
    const { id: documentId } = (await upload.json()) as { id: string };
    const junk = new FormData();
    junk.set("file", new File([`${CONTRACT_WORDS.join(" ")} not a zip`], FILE_NAME));
    expect(
      (await t.request("/api/documents", { method: "POST", headers: auth, body: junk })).status,
    ).toBe(422);

    // A playbook with a name of its own, a review with a client, and decisions.
    const yaml = (await builtinYaml()).replace(
      "name: Mutual NDA (receiving party)",
      `name: ${PLAYBOOK_NAME}`,
    );
    const playbook = await t.request("/api/playbooks", json({ yaml }));
    const { id: playbookId } = (await playbook.json()) as { id: string };
    const started = await t.request(
      "/api/reviews",
      json({ documentId, playbookId, client: CLIENT }),
    );
    const { id: reviewId } = (await started.json()) as { id: string };
    // The harness's own wait sends no token, so the review is followed here.
    const until = async (id: string): Promise<string> => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await t.request(`/api/reviews/${id}`, { headers: auth });
        const body = (await response.json()) as { status: string };
        if (body.status === "done" || body.status === "failed") return body.status;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("The review did not finish.");
    };
    expect(await until(reviewId)).toBe("done");
    await t.request(`/api/reviews/${reviewId}/findings/term`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "accepted",
        editedReplacement: "end three (3) years after disclosure, Singapore",
      }),
    });
    await t.request(`/api/reviews/${reviewId}/report?format=md`, { headers: auth });
    await t.request(`/api/reviews/${reviewId}/report`, { headers: auth });
    await t.request(`/api/documents/${documentId}/file`, { headers: auth });

    // A review that fails on a provider error that quotes the contract.
    failing = true;
    const second = await t.request(
      "/api/reviews",
      json({ documentId, playbookId, client: CLIENT }),
    );
    const { id: secondId } = (await second.json()) as { id: string };
    expect(await until(secondId)).toBe("failed");
    failing = false;

    // Refused and failed requests.
    await t.request("/api/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "text/plain" },
      body: CONTRACT_WORDS.join(" "),
    });
    await t.request(`/api/nothing/${FILE_NAME}?client=${encodeURIComponent(CLIENT)}`, {
      headers: auth,
    });
    await t.request("/api/documents", { headers: { Authorization: "Bearer wrong" } });
    await t.request(`/api/documents/${documentId}`, { method: "DELETE", headers: auth });

    const logged = t.lines.join("\n");
    expect(t.lines.length).toBeGreaterThan(15);
    for (const needle of [
      ...CONTRACT_WORDS,
      FILE_NAME,
      FILE_STEM,
      CLIENT,
      TOKEN,
      PLAYBOOK_NAME,
      "Fabrikam",
      "Zeta",
    ]) {
      expect(logged, needle).not.toContain(needle);
    }
    // The routes appear as patterns, with the ids left out.
    expect(logged).not.toContain(documentId);
    expect(logged).not.toContain(reviewId);
    expect(logged).not.toContain("format=md");
  });

  it("writes one line per request, with the time, id, method, route, status and duration and nothing else", async () => {
    const t = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    t.lines.length = 0;

    const requests: [string, string, number][] = [
      ["GET", "/healthz", 200],
      ["GET", `/api/reviews/${review.id}`, 200],
      ["PATCH", `/api/reviews/${review.id}/findings/term`, 200],
      ["GET", "/api/nothing", 404],
      ["GET", "/api/reviews/not-a-uuid", 404],
    ];
    for (const [method, path, status] of requests) {
      const response = await t.request(path, {
        method,
        ...(method === "PATCH"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision: "accepted" }),
            }
          : {}),
      });
      expect(response.status, path).toBe(status);
    }

    const parsed = t.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(requests.length);
    for (const line of parsed) {
      expect(Object.keys(line).sort()).toEqual([
        "level",
        "method",
        "ms",
        "msg",
        "requestId",
        "route",
        "status",
        "time",
      ]);
      expect(line).toMatchObject({ level: "info", msg: "request" });
      expect(Date.parse(String(line.time))).not.toBeNaN();
      expect(typeof line.ms).toBe("number");
    }
    expect(parsed.map((line) => [line.method, line.route, line.status])).toEqual([
      ["GET", "/healthz", 200],
      ["GET", "/api/reviews/:id", 200],
      ["PATCH", "/api/reviews/:id/findings/:ruleId", 200],
      ["GET", "/api/*", 404],
      ["GET", "/api/reviews/:id", 404],
    ]);
    // The id in the log is the one in the response header.
    const response = await t.request("/healthz");
    const last = JSON.parse(t.lines.at(-1) ?? "{}") as { requestId: string };
    expect(last.requestId).toBe(response.headers.get("x-request-id"));
  });
});
