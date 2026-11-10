import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real bundle step, as the image build does, into folders of its own.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);
const bundle = (out: string, version?: string) =>
  run(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "tools/bundle-server.ts"), out], {
    cwd: ROOT,
    env: { ...process.env, CLAUSEWISE_VERSION: version },
  });

interface Component {
  "bom-ref": string;
  group?: string;
  name: string;
  version: string;
  purl: string;
  licenses: ({ license: { id: string } } | { expression: string })[];
}
interface Sbom {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  metadata: { component: { "bom-ref": string; name: string; version: string } };
  components: Component[];
  dependencies: { ref: string; dependsOn?: string[] }[];
}

let dir: string;
let sbom: Sbom;
let sbomText: string;
let notices: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clausewise-bundle-"));
  await bundle(join(dir, "first"), "1.2.3");
  sbomText = await readFile(join(dir, "first/sbom.cdx.json"), "utf8");
  sbom = JSON.parse(sbomText) as Sbom;
  notices = await readFile(join(dir, "first/THIRD_PARTY_NOTICES.txt"), "utf8");
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the server bundle's SBOM", () => {
  it("is CycloneDX 1.6 and names the release it describes", () => {
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.6");
    expect(sbom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sbom.metadata.component).toMatchObject({
      name: "clausewise-server",
      version: "1.2.3",
    });
  });

  it("lists exactly the packages the licence notice lists", () => {
    // Each package in the notice is headed "<name> <version> (<licence>)" under a rule.
    const listed = [...notices.matchAll(/^-{78}\n(\S+) (\S+) \(/gm)].map(([, n, v]) => `${n}@${v}`);
    const named = sbom.components.map(
      (c) => `${c.group === undefined ? "" : `${c.group}/`}${c.name}@${c.version}`,
    );
    expect(listed.length).toBeGreaterThan(20);
    expect(new Set(named)).toEqual(new Set(listed));
    expect(named).toHaveLength(new Set(named).size);
    // Bundled, and copied as it ships.
    expect(named).toContain(listed.find((p) => p.startsWith("pg@")));
    expect(named.some((p) => p.startsWith("@azure/msal-browser@"))).toBe(true);
  });

  it("gives each package an npm purl and its licence", () => {
    for (const c of sbom.components) {
      const name = c.group === undefined ? c.name : `${c.group.replace("@", "%40")}/${c.name}`;
      expect(c.purl).toBe(`pkg:npm/${name}@${c.version}`);
      expect(c["bom-ref"]).toBe(c.purl);
      expect(c.licenses).toHaveLength(1);
    }
    const expressions = sbom.components.flatMap((c) =>
      c.licenses.flatMap((l) => ("expression" in l ? [l.expression] : [])),
    );
    expect(expressions.every((e) => /\s/.test(e))).toBe(true);
  });

  it("says the server depends on every package", () => {
    const root = sbom.dependencies.find((d) => d.ref === "clausewise-server");
    expect(new Set(root?.dependsOn)).toEqual(new Set(sbom.components.map((c) => c["bom-ref"])));
  });

  it("is the same file when built again from the same source and version", async () => {
    await bundle(join(dir, "second"), "1.2.3");
    expect(await readFile(join(dir, "second/sbom.cdx.json"), "utf8")).toBe(sbomText);
  }, 120_000);

  it("refuses a version that is not one, before bundling anything", async () => {
    await expect(bundle(join(dir, "third"), "1.2.3; rm -rf /")).rejects.toMatchObject({
      stderr: expect.stringContaining("CLAUSEWISE_VERSION must be a version"),
    });
  });
});
