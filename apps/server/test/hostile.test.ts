import type {
  ApiError,
  PlaybookDetail,
  PlaybookValidateResponse,
  ReviewDetail,
} from "@clausewise/api";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinYaml, createHarness, fixtureBytes, oracleFor, type Harness } from "./support.js";

// Requests written the way a hostile or broken client would write them. None of them may crash the
// server, reach the database as anything but a parameter, or leave the answer to a plain 500.

const NDA = "nda-aggressive.docx";
const JSON_HEADERS = { "Content-Type": "application/json" };

let t: Harness;
let review: ReviewDetail;
let yaml: string;
beforeAll(async () => {
  t = await createHarness({ generator: await oracleFor(NDA), scope: "file" });
  review = (await t.reviewedFixture(NDA)).review;
  yaml = await builtinYaml();
});

async function post(path: string, body: string, method = "POST") {
  const response = await t.request(path, { method, headers: JSON_HEADERS, body });
  const text = await response.text();
  return { response, text, error: (text === "" ? undefined : JSON.parse(text)) as ApiError };
}

describe("JSON bodies that are not what the route asks for", () => {
  // The body is read and judged before the review is looked for, so the id need not exist.
  const SOME = "00000000-0000-4000-8000-0000000000aa";
  const routes = (): [string, string, string][] => [
    ["POST", "/api/reviews", "a review"],
    ["PATCH", `/api/reviews/${SOME}/findings/term`, "a decision"],
    ["PATCH", `/api/reviews/${SOME}/findings`, "a bulk decision"],
    ["POST", "/api/playbooks", "a new playbook"],
    ["PUT", "/api/playbooks/anything", "a changed playbook"],
    ["POST", "/api/playbooks/validate", "a playbook to check"],
  ];
  const bodies: [string, string][] = [
    ["an array", "[]"],
    ["an array of objects", '[{"decision":"accepted"}]'],
    ["null", "null"],
    ["a number", "1"],
    ["a string", '"decision"'],
    ["true", "true"],
    ["nothing", ""],
    ["a prototype key", '{"__proto__":{"polluted":true},"decision":"accepted"}'],
    ["a constructor key", '{"constructor":{"prototype":{"polluted":true}}}'],
    ["a number too large to be one", '{"decision":1e999,"yaml":1e999,"documentId":1e999}'],
    ["an integer beyond 2^53", '{"decision":123456789012345678901234567890,"yaml":-0}'],
    [
      "a wrong type for each field",
      '{"decision":[],"yaml":{},"ruleIds":"term","documentId":false}',
    ],
    ["a list that holds objects", '{"decision":"accepted","ruleIds":[{"a":1}],"severities":[[]]}'],
    ["lists nested a hundred thousand deep", `{"ruleIds":${"[".repeat(100_000)}`],
    [
      "lists nested a hundred thousand deep and closed",
      `${"[".repeat(100_000)}${"]".repeat(100_000)}`,
    ],
    ["text that is not JSON", "{decision: accepted}"],
    ["JSON with a trailing comma", '{"decision":"accepted",}'],
    ["a NUL in a name", '{"decision\\u0000":"accepted"}'],
  ];

  for (const [method, path, what] of routes()) {
    it(`answers ${what} with 400 and no more than that, for every kind of wrong body`, async () => {
      for (const [name, body] of bodies) {
        const { response, error } = await post(path, body, method);
        expect([name, response.status]).toEqual([name, 400]);
        expect(error.error.code).toBe("bad_request");
        // In a sentence, and not at the length of what was sent.
        expect(error.error.message.length).toBeLessThan(600);
      }
      // Nothing was polluted, and the server answers.
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect((await t.request("/healthz")).status).toBe(200);
    });
  }

  it("does not repeat a long key the client sent, in full, in its answer", async () => {
    const key = "k".repeat(100_000);
    const { response, error } = await post(
      `/api/reviews/${review.id}/findings/term`,
      JSON.stringify({ decision: "accepted", [key]: 1 }),
      "PATCH",
    );
    expect(response.status).toBe(400);
    expect(error.error.message.length).toBeLessThan(600);
  });

  it("takes a key called __proto__ as an unknown key and does not read it as a prototype", async () => {
    const decided = await post(
      `/api/reviews/${review.id}/findings/term`,
      '{"__proto__":{"decision":"accepted"}}',
      "PATCH",
    );
    expect(decided.response.status).toBe(400);
    // It did not set a decision through the prototype either.
    const detail = await t.json<ReviewDetail>(`/api/reviews/${review.id}`);
    expect(t.finding(detail.body, "term").decision).toBe("pending");
  });
});

describe("a playbook name that the database cannot hold", () => {
  // YAML can write a NUL character as an escape, and Postgres cannot store one in text. The check
  // for a raw NUL in the body does not see it, because the body only holds a backslash and a zero.
  const withName = (name: string): string =>
    yaml.replace("name: Mutual NDA (receiving party)", `name: ${name}`);

  it("is told apart when the playbook is checked, saved and used, and is not a server error", async () => {
    const bad = withName('"Playbook \\0 with a NUL"');

    const checked = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
      yaml: bad,
    });
    expect(checked.status).toBe(200);
    expect(checked.body.ok).toBe(false);
    if (!checked.body.ok) expect(checked.body.problems.join(" ")).toContain("NUL");

    const saved = await t.send<ApiError>("POST", "/api/playbooks", { yaml: bad });
    expect(saved.status).toBe(400);
    expect(saved.body.error.code).toBe("bad_request");

    // A saved playbook cannot be changed into one either.
    const good = await t.send<PlaybookDetail>("POST", "/api/playbooks", { yaml });
    expect(good.status).toBe(201);
    const changed = await t.send<ApiError>("PUT", `/api/playbooks/${good.body.id}`, { yaml: bad });
    expect(changed.status).toBe(400);
  });

  it("does not stop a name with an ordinary escape in it", async () => {
    const fine = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
      yaml: withName('"Tab\\there"'),
    });
    expect(fine.body.ok).toBe(true);
  });
});

describe("an upload that is not what it says", () => {
  it("does not take memory in proportion to a file name of tens of millions of characters", async () => {
    // The name is cut before it is looked at: the answer holds the first part and the extension.
    const huge = `${"n".repeat(2_000_000)}.docx`;
    const response = await t.upload(huge, await fixtureBytes(NDA));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { fileName: string };
    expect(body.fileName.length).toBe(200);
    expect(body.fileName.endsWith(".docx")).toBe(true);
  });

  it("answers a form with no boundary, or one that is not usable, with 400", async () => {
    for (const type of [
      "multipart/form-data",
      "multipart/form-data; boundary=",
      `multipart/form-data; boundary=${"b".repeat(5000)}`,
      'multipart/form-data; boundary="unterminated',
    ]) {
      const response = await t.request("/api/documents", {
        method: "POST",
        headers: { "Content-Type": type },
        body: "--x\r\nContent-Disposition: form-data; name=file\r\n\r\ndata\r\n--x--\r\n",
      });
      expect([type.slice(0, 40), response.status]).toEqual([type.slice(0, 40), 400]);
    }
  });
});
