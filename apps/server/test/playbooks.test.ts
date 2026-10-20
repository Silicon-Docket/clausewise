import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApiError,
  PlaybookDetail,
  PlaybookListResponse,
  PlaybookSummary,
  PlaybookValidateResponse,
} from "@clausewise/api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinYaml,
  createHarness,
  oracleFor,
  playbooksDir,
  tempDir,
  type Harness,
} from "./support.js";

describe("playbooks", () => {
  let t: Harness;
  let yaml: string;
  beforeAll(async () => {
    t = await createHarness({ generator: await oracleFor("nda-aggressive.docx"), scope: "file" });
    yaml = await builtinYaml();
  });

  const renamed = (name: string): string =>
    yaml.replace("name: Mutual NDA (receiving party)", `name: ${name}`);

  describe("the built-in ones", () => {
    it("lists the files of the playbooks folder, read-only", async () => {
      const list = await t.json<PlaybookListResponse>("/api/playbooks");
      const builtin = list.body.playbooks.filter((p) => p.source === "builtin");
      expect(builtin.map((p) => p.id)).toEqual(["builtin:nda-mutual", "builtin:saas-customer"]);
      expect(builtin[0]).toEqual({
        id: "builtin:nda-mutual",
        source: "builtin",
        name: "Mutual NDA (receiving party)",
        contractTypes: ["nda"],
        ruleCount: 10,
        updatedAt: null,
      });
      expect(builtin[1]?.ruleCount).toBe(12);
    });

    it("shows one with its YAML as it is in the file, and says it cannot be edited", async () => {
      const detail = await t.json<PlaybookDetail>("/api/playbooks/builtin:nda-mutual");
      expect(detail.status).toBe(200);
      expect(detail.body.editable).toBe(false);
      expect(detail.body.yaml).toBe(await readFile(join(playbooksDir, "nda-mutual.yaml"), "utf8"));
    });

    it("answers 404 for one that is not in the folder, however the name is spelled", async () => {
      for (const id of [
        "builtin:nope",
        "builtin:../package",
        "builtin:",
        "builtin:nda-mutual.yaml",
        "nda-mutual",
      ]) {
        const response = await t.request(`/api/playbooks/${encodeURIComponent(id)}`);
        expect(response.status, id).toBe(404);
      }
    });

    it("refuses to change or delete one, whatever is sent", async () => {
      const put = await t.send<ApiError>("PUT", "/api/playbooks/builtin:nda-mutual", { yaml });
      expect(put.status).toBe(403);
      expect(put.body.error.code).toBe("forbidden");
      expect(put.body.error.message).toContain("Copy it to edit your own");
      const del = await t.send<ApiError>("DELETE", "/api/playbooks/builtin:nda-mutual");
      expect(del.status).toBe(403);
      expect((await t.json<PlaybookDetail>("/api/playbooks/builtin:nda-mutual")).status).toBe(200);
    });

    it("leaves out a file that is not a valid playbook and names it in the log, not the rest", async () => {
      const dir = await tempDir("clausewise-playbooks-");
      await writeFile(join(dir, "good.yaml"), yaml);
      await writeFile(join(dir, "broken.yaml"), "name: [unclosed");
      await writeFile(join(dir, "notes.txt"), "not a playbook");
      await writeFile(join(dir, "bad name.yaml"), yaml);
      const u = await createHarness({
        generator: await oracleFor("nda-aggressive.docx"),
        config: { playbooksDir: dir },
      });
      const list = await u.json<PlaybookListResponse>("/api/playbooks");
      expect(list.body.playbooks.map((p) => p.id)).toEqual(["builtin:good"]);
      expect(u.lines.join("\n")).toContain("broken.yaml");
    });
  });

  describe("custom ones", () => {
    it("creates, shows, updates, lists and deletes one", async () => {
      const created = await t.send<PlaybookDetail>("POST", "/api/playbooks", {
        yaml: renamed("Our NDA"),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        source: "custom",
        name: "Our NDA",
        contractTypes: ["nda"],
        ruleCount: 10,
        editable: true,
        yaml: renamed("Our NDA"),
      });
      expect(created.body.id).toMatch(/^pb[0-9a-f]+$/);
      expect(created.body.updatedAt).toBe("2026-03-01T09:00:00.000Z");

      const shown = await t.json<PlaybookDetail>(`/api/playbooks/${created.body.id}`);
      expect(shown.body).toEqual(created.body);

      t.clock.advance(60_000);
      const updated = await t.send<PlaybookDetail>("PUT", `/api/playbooks/${created.body.id}`, {
        yaml: renamed("Our NDA, second edition"),
      });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe("Our NDA, second edition");
      expect(updated.body.updatedAt).toBe("2026-03-01T09:01:00.000Z");

      const list = await t.json<PlaybookListResponse>("/api/playbooks");
      const custom = list.body.playbooks.filter((p) => p.source === "custom");
      expect(custom).toEqual([
        expect.objectContaining<Partial<PlaybookSummary>>({
          id: created.body.id,
          name: "Our NDA, second edition",
          updatedAt: "2026-03-01T09:01:00.000Z",
        }),
      ]);
      // Built-in ones come first.
      expect(list.body.playbooks.map((p) => p.source)).toEqual(["builtin", "builtin", "custom"]);

      expect((await t.send("DELETE", `/api/playbooks/${created.body.id}`)).status).toBe(204);
      expect((await t.json(`/api/playbooks/${created.body.id}`)).status).toBe(404);
      expect((await t.send("DELETE", `/api/playbooks/${created.body.id}`)).status).toBe(404);
      expect((await t.send("PUT", `/api/playbooks/${created.body.id}`, { yaml })).status).toBe(404);
    });

    it("refuses a playbook that is not valid, saying every problem, and keeps the one it had", async () => {
      const bad = yaml
        .replace("severity: high", "severity: urgent")
        .replace("id: mutuality", "id: Mutuality!");
      const refused = await t.send<ApiError>("POST", "/api/playbooks", { yaml: bad });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("bad_request");
      expect(refused.body.error.message).toContain("The playbook is invalid");
      expect(refused.body.error.message).toContain("rules[0].id");
      expect(refused.body.error.message).toContain("severity");

      const created = await t.send<PlaybookDetail>("POST", "/api/playbooks", { yaml });
      const keep = await t.send("PUT", `/api/playbooks/${created.body.id}`, {
        yaml: "name: [broken",
      });
      expect(keep.status).toBe(400);
      expect((keep.body as ApiError).error.message).toContain("not valid YAML");
      expect((await t.json<PlaybookDetail>(`/api/playbooks/${created.body.id}`)).body.yaml).toBe(
        yaml,
      );
      await t.send("DELETE", `/api/playbooks/${created.body.id}`);
    });

    it("refuses a request without YAML, with other fields, or with a character the database cannot keep", async () => {
      for (const body of [
        {},
        { yaml: 5 },
        { yaml: "name: x", extra: true },
        { yaml: `${yaml}\u0000` },
      ]) {
        const response = await t.send<ApiError>("POST", "/api/playbooks", body);
        expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
        expect(response.body.error.code).toBe("bad_request");
      }
    });

    it("can be used for a review straight away", async () => {
      const created = await t.send<PlaybookDetail>("POST", "/api/playbooks", {
        yaml: renamed("Used at once"),
      });
      const document = await t.uploadFixture("nda-aggressive.docx");
      const started = await t.startReview(document.id, created.body.id);
      expect(started.status).toBe(202);
      expect(started.body.playbookName).toBe("Used at once");
      const done = await t.waitFor(started.body.id);
      expect(done.status).toBe("done");
    });
  });

  describe("checking a playbook as it is typed", () => {
    it("says what a valid playbook holds", async () => {
      const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
        yaml,
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        ok: true,
        name: "Mutual NDA (receiving party)",
        ruleCount: 10,
        contractTypes: ["nda"],
      });
    });

    it("lists every problem of one that is not", async () => {
      const bad = [
        "name: Broken",
        "contractTypes: []",
        "perspective: We act for the buyer.",
        "rules:",
        "  - id: first",
        "    title: One",
        "    severity: sometimes",
        "    standard: A standard.",
        "  - id: Second Rule",
        "    title: Two",
        "    severity: high",
      ].join("\n");
      const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
        yaml: bad,
      });
      expect(result.status).toBe(200);
      if (result.body.ok) throw new Error("expected problems");
      expect(result.body.problems).toHaveLength(4);
      const text = result.body.problems.join("\n");
      expect(text).toContain("contractTypes");
      expect(text).toContain("rules[0].severity");
      expect(text).toContain("rules[1].id");
      expect(text).toContain("rules[1].standard");
    });

    it("finds a rule id used twice", async () => {
      const twice = yaml.replace("id: governing-law", "id: term");
      const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
        yaml: twice,
      });
      expect(result.body.ok).toBe(false);
      if (!result.body.ok)
        expect(result.body.problems.join("\n")).toContain('duplicate rule id "term"');
    });

    it("reports a YAML syntax error and a document that is not a playbook at all", async () => {
      for (const text of ["name: [unclosed", "just some words", "- a\n- list", ""]) {
        const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
          yaml: text,
        });
        expect(result.status, text).toBe(200);
        expect(result.body.ok, text).toBe(false);
        if (!result.body.ok) expect(result.body.problems.length).toBeGreaterThan(0);
      }
    });

    it("refuses an alias bomb quickly, without expanding it", async () => {
      const names = "bcdefghijklm".split("");
      const lines = ["a: &a [x, x, x, x, x, x, x, x, x]"];
      let previous = "a";
      for (const name of names) {
        lines.push(`${name}: &${name} [${Array<string>(9).fill(`*${previous}`).join(", ")}]`);
        previous = name;
      }
      const started = Date.now();
      const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
        yaml: lines.join("\n"),
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) expect(result.body.problems.join(" ")).toContain("alias");
      const saved = await t.send<ApiError>("POST", "/api/playbooks", { yaml: lines.join("\n") });
      expect(saved.status).toBe(400);
    });
  });

  describe("YAML that says more than data", () => {
    it("refuses a custom tag, however it is written, and saves nothing", async () => {
      const tagged = [
        yaml.replace("name: Mutual NDA (receiving party)", 'name: !!js/function "function(){}"'),
        yaml.replace("severity: high", "severity: !custom high"),
        yaml.replace("required: true", "required: !!binary dHJ1ZQ=="),
      ];
      const customBefore = (
        await t.json<PlaybookListResponse>("/api/playbooks")
      ).body.playbooks.filter((p) => p.source === "custom");
      for (const text of tagged) {
        const result = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
          yaml: text,
        });
        expect(result.body.ok).toBe(false);
        if (!result.body.ok) expect(result.body.problems.join(" ")).toContain("tag");
        const saved = await t.send<ApiError>("POST", "/api/playbooks", { yaml: text });
        expect(saved.status).toBe(400);
        expect(saved.body.error.message).toContain("tag");
      }
      const list = await t.json<PlaybookListResponse>("/api/playbooks");
      expect(list.body.playbooks.filter((p) => p.source === "custom")).toEqual(customBefore);
    });
  });

  describe("size limits", () => {
    const filler = (bytes: number): string => `description: ${"x".repeat(bytes)}\n`;

    it("takes a playbook just under 256 KB and refuses one over it", async () => {
      const room = 256 * 1024 - Buffer.byteLength(yaml, "utf8") - "description: \n".length;
      const fits = `${yaml}${filler(room - 100)}`.replace(/^description: .*\n/m, "");
      expect(Buffer.byteLength(fits, "utf8")).toBeLessThanOrEqual(256 * 1024);
      const ok = await t.send<PlaybookValidateResponse>("POST", "/api/playbooks/validate", {
        yaml: fits,
      });
      expect(ok.status).toBe(200);

      const tooBig = `${yaml}\n# ${"x".repeat(256 * 1024)}\n`;
      for (const [method, path] of [
        ["POST", "/api/playbooks/validate"],
        ["POST", "/api/playbooks"],
      ] as const) {
        const response = await t.send<ApiError>(method, path, { yaml: tooBig });
        expect(response.status, path).toBe(413);
        expect(response.body.error.code).toBe("payload_too_large");
        expect(response.body.error.message).toContain("256 KB");
      }
    });

    it("refuses a request body over 300 KB before reading it as JSON, and other JSON over 1 MB", async () => {
      const response = await t.send<ApiError>("POST", "/api/playbooks/validate", {
        yaml: "x".repeat(300 * 1024),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(response.body.error.message).toContain("300 KB");

      const big = await t.send<ApiError>("POST", "/api/reviews", {
        documentId: "x".repeat(1024 * 1024 + 10),
        playbookId: "x",
      });
      expect(big.status).toBe(413);
      expect(big.body.error.message).toContain("1 MB");
    });
  });
});
