import JSZip from "jszip";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runCanaryScan, type CanaryHooks } from "../src/parol/exposure/canary.js";
import {
  checkAnswers,
  checkBody,
  checkLog,
  checkPrompts,
  needlesOf,
  ownPages,
  requireTokensIn,
} from "../src/parol/exposure/canary-controls.js";
import { createScanner, plantedDocx, type Scanner } from "../src/parol/exposure/scan.js";
import type { Dataset } from "../src/parol/dataset.js";
import {
  CANARY_SHAPE,
  completeDataset,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * The real-data controls of the canary scan. A scan over a channel that was emptied by a fault of
 * the harness gives zero, as a scan over a channel that holds no leak does, so each channel is
 * shown here to be checked for holding the case's own data, with the fault planted in a copy of the
 * application that exists for the test. The scan has to stop with `ExposureControlFailure` (exit
 * code 2) and not return a clean count.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type BeforeRoutes = NonNullable<CanaryHooks["beforeRoutes"]>;
type WrapMemo = NonNullable<CanaryHooks["wrapMemoBuilder"]>;

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const scan = (hooks?: CanaryHooks) =>
  runCanaryScan({
    dataset,
    root: ROOT,
    playbook,
    signal: never(),
    ...(hooks === undefined ? {} : { hooks }),
  });

async function failureOf(hooks: CanaryHooks): Promise<Error> {
  const failure = await scan(hooks).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(failure, "the scan should have stopped").toBeInstanceOf(Error);
  const error = failure as Error;
  // Nothing printed holds a canary string, an id, or a dash.
  expect(error.message).not.toMatch(CANARY_SHAPE);
  expect(error.message).not.toMatch(ID_SHAPE);
  return error;
}

const controlFailure = (error: Error) =>
  expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });

/** Replaces the body of every answer to a GET that matches, keeping its status and type. */
const replaceBodies =
  (applies: (path: string, type: string) => boolean, body: string | Uint8Array): BeforeRoutes =>
  (app) => {
    app.use("*", async (c, next) => {
      await next();
      if (c.req.method !== "GET" || c.res.status !== 200) return;
      if (!applies(c.req.path, c.res.headers.get("content-type") ?? "")) return;
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(body as BodyInit, { status: 200, headers });
    });
  };

/** The model, with the request changed on its way to the capture and so in the record of it. */
function changing(
  inner: ObjectGenerator,
  change: (request: GenerateObjectRequest<unknown>) => GenerateObjectRequest<unknown>,
): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    generate: ((request: GenerateObjectRequest<unknown>) =>
      inner.generate(change(request))) as ObjectGenerator["generate"],
  };
}

describe("the pages", () => {
  it("stop the scan when the bodies of the JSON routes are empty, whatever the count would be", async () => {
    const error = await failureOf({
      beforeRoutes: replaceBodies((path) => path.startsWith("/api/matters"), ""),
    });
    controlFailure(error);
    expect(error.message).toMatch(/empty body \((associate|reviewer|viewer) GET \/api\/matters/);
  });

  it("stop the scan when a JSON route answers with something that is not JSON", async () => {
    const error = await failureOf({
      beforeRoutes: replaceBodies(
        (path, type) => path.startsWith("/api/matters") && type.includes("json"),
        "<html>Service unavailable</html>",
      ),
    });
    controlFailure(error);
    expect(error.message).toMatch(/does not parse \(/);
  });

  it("stop the scan when every page of the matter answers 200 with a page that holds none of its data", async () => {
    const error = await failureOf({
      beforeRoutes: replaceBodies(
        (path, type) => path.startsWith("/matters/") && type.includes("html"),
        "<html><body><p>Nothing to see here.</p></body></html>",
      ),
    });
    controlFailure(error);
    expect(error.message).toMatch(/did not hold the case's own names or clause text/);
    expect(error.message).toContain("GET /matters/:matterId");
  });

  it("stop the scan when the finding pages lost the clauses, though the matter page is whole", async () => {
    const error = await failureOf({
      beforeRoutes: (app) => {
        app.use("/matters/*", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || !c.req.path.includes("/findings/")) return;
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response("<html><body>A finding.</body></html>", { status: 200, headers });
        });
      },
    });
    controlFailure(error);
    expect(error.message).toContain("GET /matters/:matterId/findings/:findingId");
  });

  it("do not turn a leak into a control failure: a damaged body that holds a canary string is counted", async () => {
    const leaked = "tail";
    const result = await scan({
      beforeRoutes: (app) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || c.res.status !== 200) return;
          if (!(c.res.headers.get("content-type") ?? "").includes("json")) return;
          const body = await c.res.text();
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          // Not JSON any more: the application's body, then a line of text with a canary string.
          c.res = new Response(
            `${body}\n${leaked} ${dataset.keys.canary!.matters[0]!.strings[0]!}`,
            {
              status: 200,
              headers,
            },
          );
        });
      },
    });
    expect(result.canaryHits).toBeGreaterThan(0);
  });
});

describe("the memo", () => {
  const memoWith =
    (edit: (zip: JSZip) => Promise<void> | void): WrapMemo =>
    (real) =>
    async (input) => {
      const zip = await JSZip.loadAsync(await real(input));
      await edit(zip);
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    };

  it("stops the scan when the memo is a few bytes that are not a Word file", async () => {
    const error = await failureOf({
      wrapMemoBuilder: () => async () => new Uint8Array([1, 2, 3, 4]),
    });
    controlFailure(error);
  });

  it("stops the scan when the memo is a Word package with an empty document part", async () => {
    const error = await failureOf({
      wrapMemoBuilder: memoWith((zip) => {
        zip.file("word/document.xml", '<w:document xmlns:w="urn:w"><w:body></w:body></w:document>');
      }),
    });
    controlFailure(error);
    expect(error.message).toMatch(/exported memo has an empty document part/);
  });

  it("stops the scan when the memo is a Word package that holds nothing of the case", async () => {
    const error = await failureOf({
      wrapMemoBuilder: () => async () =>
        plantedDocx({ document: ["A memorandum that says nothing about any matter."] }),
    });
    controlFailure(error);
    expect(error.message).toMatch(/does not hold the case's matter name and client/);
  });

  it("stops the scan when the memo has the case's names but quotes none of the passages the key names", async () => {
    const error = await failureOf({
      wrapMemoBuilder: memoWith(async (zip) => {
        const xml = await zip.file("word/document.xml")!.async("string");
        const names = ["PAROL-D10 review (exposure scan)", "Corrimar Tidal Analytics, Inc."];
        zip.file(
          "word/document.xml",
          `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${names.join(" ")}</w:t></w:r></w:p></w:body></w:document>`,
        );
        expect(xml.length).toBeGreaterThan(0);
      }),
    });
    controlFailure(error);
    expect(error.message).toMatch(/quotes none of the passages/);
  });

  it("stops the scan, and does not call it clean, when the memo is a package cut in two", async () => {
    const error = await failureOf({
      wrapMemoBuilder: (real) => async (input) => {
        const bytes = await real(input);
        return bytes.slice(0, Math.floor(bytes.length / 2));
      },
    });
    controlFailure(error);
    expect(error.message).toMatch(/could not be read, so no count can be trusted/);
  });

  it("stops the scan when one entry of the memo cannot be inflated", async () => {
    const error = await failureOf({
      wrapMemoBuilder: (real) => async (input) => {
        const bytes = Uint8Array.from(await real(input));
        const view = new DataView(bytes.buffer);
        let offset = 0;
        // The first byte of the compressed data of word/styles.xml: a block type that does not exist.
        while (offset + 30 < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
          const nameLength = view.getUint16(offset + 26, true);
          const extraLength = view.getUint16(offset + 28, true);
          const name = Buffer.from(
            bytes.subarray(offset + 30, offset + 30 + nameLength),
          ).toString();
          const data = offset + 30 + nameLength + extraLength;
          if (name === "word/styles.xml") bytes[data] = 0x07;
          offset = data + view.getUint32(offset + 18, true);
        }
        return bytes;
      },
    });
    controlFailure(error);
    expect(error.message).toMatch(/could not be read, so no count can be trusted/);
  });
});

describe("a memo that is compressed as the application's is", () => {
  const planted = () => dataset.keys.canary!.matters[0]!.strings[0]!;

  it("is counted when it carries a canary string split across two runs, in a DEFLATE package", async () => {
    const result = await scan({
      wrapMemoBuilder: (real) => async (input) => {
        const zip = await JSZip.loadAsync(await real(input));
        const xml = await zip.file("word/document.xml")!.async("string");
        const half = Math.floor(planted().length / 2);
        const paragraph =
          `<w:p><w:r><w:t>${planted().slice(0, half)}</w:t></w:r>` +
          `<w:r><w:t>${planted().slice(half)}</w:t></w:r></w:p>`;
        zip.file("word/document.xml", xml.replace("</w:body>", `${paragraph}</w:body>`));
        return zip.generateAsync({
          type: "uint8array",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
      },
    });
    expect(result.hits.filter((hit) => hit.kind === "memo" && hit.token === "canary")).toHaveLength(
      1,
    );
    const downloads = result.hits.filter(
      (hit) => hit.kind === "http_body" && hit.token === "canary",
    );
    expect(downloads).toHaveLength(6);
    expect(downloads.every((hit) => hit.label.includes("/memos/:memoId/file"))).toBe(true);
  });

  it("is where a scanner that never inflates is stopped, before any count", async () => {
    const real = createScanner();
    const neverInflates: Scanner = {
      async scan(target) {
        if (typeof target.content === "string") return real.scan(target);
        const zip = await JSZip.loadAsync(target.content);
        const parts = Object.values(zip.files)
          .filter((entry) => !entry.dir)
          .map((entry) =>
            Buffer.from(
              (entry as unknown as { _data: { compressedContent: Uint8Array } })._data
                .compressedContent,
            ).toString("latin1"),
          );
        return real.scan({ ...target, content: parts.join("\n") });
      },
    };
    const failure = await scan({ scanner: neverInflates }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect((failure as Error).message).toMatch(/Word file/);
  });
});

describe("the prompts", () => {
  it("stop the scan when a prompt lost the clauses of the case, though the model was still shown them", async () => {
    // What the capture records is not what the oracle answers from, so the review still succeeds.
    const shown = new WeakMap<object, GenerateObjectRequest<unknown>>();
    const strip = (text: string): string =>
      text.replace(/<contract>[\s\S]*<\/contract>/, "<contract>\n</contract>");
    const error = await failureOf({
      beforeCapture: (inner) =>
        changing(inner, (request) => {
          const changed = {
            ...request,
            prompt: strip(request.prompt),
            ...(request.sharedPrefix === undefined
              ? {}
              : { sharedPrefix: strip(request.sharedPrefix) }),
          };
          shown.set(changed, request);
          return changed;
        }),
      model: (inner) => changing(inner, (request) => shown.get(request) ?? request),
    });
    controlFailure(error);
    expect(error.message).toMatch(/of \d+ prompts held none of the case's own clause text/);
  });
});

describe("the tables", () => {
  it("stop the scan when the store has a table that is neither read nor listed as holding no matter data", async () => {
    const error = await failureOf({
      afterReview: (site) => {
        // Keyed by a finding and not by a matter: the old check on the columns would not have seen it.
        site.repo.db.exec("CREATE TABLE finding_notes (finding_id TEXT NOT NULL, note TEXT)");
      },
    });
    expect(error).toMatchObject({ name: "ExposureSuiteUnavailable" });
    expect(error.message).toContain("finding_notes");
  });

  it("stop the scan for a table with no key at all, such as a shared cache", async () => {
    const error = await failureOf({
      afterReview: (site) => {
        site.repo.db.exec("CREATE TABLE answer_cache (key TEXT, value TEXT)");
      },
    });
    expect(error.message).toContain("answer_cache");
  });

  it("stop the scan when a table listed as holding no matter data gets a matter column", async () => {
    const error = await failureOf({
      afterReview: (site) => {
        site.repo.db.exec("ALTER TABLE eval_runs ADD COLUMN matter_id TEXT");
      },
    });
    expect(error).toMatchObject({ name: "ExposureSuiteUnavailable" });
    expect(error.message).toContain("eval_runs");
  });
});

describe("the controls themselves", () => {
  const needles = needlesOf([
    "A clause of the case that is long enough to be told from other text.",
  ]);

  it("take the first words of a clause that is long enough, and no others", () => {
    expect(
      needlesOf([
        "Short.",
        "  A   clause\nof the case that is long enough to be told from other text. ",
      ]),
    ).toEqual(["a clause of the case that is l"]);
  });

  it("accept a prompt that holds the clause and names a rule, and refuse one without either", () => {
    const clause = "A clause of the case that is long enough to be told from other text.";
    const requests = [
      { text: `<contract>\n[c1] 1.1\n${clause}\n</contract>`, schemaName: "locate_passages" },
      {
        text: `Rule ID: dur-1\n<contract>\n[c3] 2.2\n${clause}\n</contract>`,
        schemaName: "analyze_rule",
      },
      { text: `Cited: ${clause}`, schemaName: "check_support" },
    ];
    expect(() =>
      checkPrompts({ caseKey: "K", requests, needles, ruleKeys: ["dur-1"] }),
    ).not.toThrow();
    expect(() =>
      checkPrompts({
        caseKey: "K",
        requests: [{ text: "", schemaName: undefined }],
        needles,
        ruleKeys: [],
      }),
    ).toThrow(/held none of the case's own clause text/);
    expect(() => checkPrompts({ caseKey: "K", requests, needles, ruleKeys: ["gov-1"] })).toThrow(
      /named no rule of the playbook/,
    );
    expect(() => checkPrompts({ caseKey: "K", requests, needles: [], ruleKeys: [] })).toThrow(
      /no clause long enough/,
    );
    // The wording of the clause in the system prompt or the rule is not the clause shown to the model.
    const outside = [
      { text: `${clause}\nRule ID: dur-1\n<contract>\n</contract>`, schemaName: "analyze_rule" },
    ];
    expect(() =>
      checkPrompts({ caseKey: "K", requests: outside, needles, ruleKeys: ["dur-1"] }),
    ).toThrow(/held none of the case's own clause text/);
  });

  it("accept answers that parse, and refuse ones that are missing, empty or not JSON", () => {
    expect(() =>
      checkAnswers({ caseKey: "K", requests: 2, responses: ['{"a":1}', '{"b":[]}'], failures: 0 }),
    ).not.toThrow();
    expect(() =>
      checkAnswers({ caseKey: "K", requests: 3, responses: ['{"a":1}'], failures: 2 }),
    ).not.toThrow();
    for (const responses of [
      ['{"a":1}'],
      ['{"a":1}', ""],
      ['{"a":1}', "{}"],
      ['{"a":1}', "nope"],
      ['{"a":1}', undefined],
    ])
      expect(() => checkAnswers({ caseKey: "K", requests: 2, responses, failures: 0 })).toThrow(
        /No count can be trusted/,
      );
  });

  it("accept a log that says something, and refuse one that is empty", () => {
    expect(() => checkLog("K", ["run started"])).not.toThrow();
    expect(() => checkLog("K", [])).toThrow(/log is empty/);
    expect(() => checkLog("K", ["", "  "])).toThrow(/log is empty/);
  });

  it("accept a body of a page that loaded, and refuse an empty one, bad JSON and a Word file that is not one", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(() =>
      checkBody({ label: "L", contentType: "application/json", bytes: bytes("{}") }),
    ).not.toThrow();
    expect(() =>
      checkBody({ label: "L", contentType: "text/html", bytes: bytes("<p>x</p>") }),
    ).not.toThrow();
    expect(() => checkBody({ label: "L", contentType: "text/html", bytes: bytes("") })).toThrow(
      /empty body/,
    );
    expect(() =>
      checkBody({ label: "L", contentType: "application/json; charset=UTF-8", bytes: bytes("{") }),
    ).toThrow(/does not parse/);
    const word = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(() =>
      checkBody({ label: "L", contentType: word, bytes: bytes("not a package") }),
    ).toThrow(/not a package/);
    expect(() =>
      checkBody({
        label: "L",
        contentType: word,
        bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]),
      }),
    ).not.toThrow();
  });

  it("collect what the pages of a member hold, and refuse a member whose pages hold none of it", () => {
    const pages = () => ownPages({ caseKey: "K", names: ["Matter name", "Client, Inc."], needles });
    const good = pages();
    good.note("GET /matters/:matterId", "<h1>Matter &amp; name</h1>");
    expect(() => good.require("a member")).toThrow(/did not hold/);

    const whole = pages();
    whole.note("GET /matters/:matterId", "<h1>Matter name</h1><p>Client, Inc.</p>");
    whole.note(
      "GET /api/matters/:matterId",
      JSON.stringify({ name: "Matter name", client: "Client, Inc." }),
    );
    whole.note("GET /matters/:matterId/findings/:findingId", "<p>none</p>");
    whole.note(
      "GET /matters/:matterId/findings/:findingId",
      "<p>A clause of the <mark>case</mark> that is long enough to be told from other text.</p>",
    );
    whole.note(
      "GET /api/matters/:matterId/findings/:findingId",
      JSON.stringify({
        quote: "A clause of the case that is long enough to be told from other text.",
      }),
    );
    expect(() => whole.require("a member")).not.toThrow();

    // One names page without the names is enough to refuse.
    whole.note("GET /matters/:matterId", "<h1>Matter name</h1>");
    expect(() => whole.require("a member")).toThrow(/GET \/matters\/:matterId/);
  });

  it("require every string and every id in the rows of a matter, one by one", async () => {
    const scanner = createScanner();
    const tokens = {
      canary: ["CANARY-TESTMATTER-0123456789ab"],
      ids: ["mat_00000000deadbeef", "ver_00000000feedface:p17"],
    };
    const rows = JSON.stringify([
      { id: "mat_00000000deadbeef", note: "canary-testmatter-0123456789ab" },
      { id: "ver_00000000feedface:p17" },
    ]);
    await expect(
      requireTokensIn({ scanner, what: "The rows", content: rows, tokens }),
    ).resolves.toBeUndefined();
    for (const content of [
      rows.replace("mat_00000000deadbeef", "mat_00000000deadbee0"),
      rows.replace("canary-testmatter-0123456789ab", "x"),
      rows.replace("ver_00000000feedface:p17", ""),
    ])
      await expect(
        requireTokensIn({ scanner, what: "The rows", content, tokens }),
      ).rejects.toMatchObject({
        name: "ExposureControlFailure",
        exitCode: 2,
      });
  });
});
