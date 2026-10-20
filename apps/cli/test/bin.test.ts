import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE_ENV, LAUNCHER, TIMEOUT, cleanUpChildren, start } from "./child.js";
import { root, tempDirs } from "./support.js";

cleanUpChildren();

const SOURCE = join(root, "apps", "cli", "src", "bin.ts");
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const zodEntry = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("zod/package.json")), "index.js"),
).href;

/** The tsx of the project, started from another folder the way a global shim would. */
const PROJECT_TSX = join(root, "node_modules", ".bin", "tsx");

describe("the executable", () => {
  it("is the launcher that package.json names, a file the shell can run", async () => {
    const manifest = JSON.parse(await readFile(join(root, "apps", "cli", "package.json"), "utf8"));

    expect(join(root, "apps", "cli", manifest.bin.clausewise)).toBe(LAUNCHER);
    expect((await stat(LAUNCHER)).mode & 0o111).not.toBe(0);
    expect((await readFile(LAUNCHER, "utf8")).split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("is not the source file, which carries no shebang of its own", async () => {
    expect(await readFile(SOURCE, "utf8")).not.toMatch(/^#!/);
  });

  it("starts the command in the project", { timeout: TIMEOUT }, async () => {
    const outcome = await start(LAUNCHER, ["--version"], BASE_ENV).done;

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe("0.0.0\n");
    expect(outcome.stderr).toBe("");
  });
});

describe("a folder the command is started from", () => {
  const makeDir = tempDirs();

  it(
    "cannot supply the tsx that runs the command",
    {
      timeout: TIMEOUT,
    },
    async () => {
      const dir = await makeDir();
      const marker = join(dir, "TSX-PLANTED");
      // What a folder of unpacked documents could hold: a package of the name the loader is
      // looked up under, which runs as soon as it is imported.
      await mkdir(join(dir, "node_modules", "tsx"), { recursive: true });
      await writeFile(
        join(dir, "node_modules", "tsx", "package.json"),
        JSON.stringify({ name: "tsx", type: "module", exports: { ".": "./index.js" } }),
      );
      await writeFile(
        join(dir, "node_modules", "tsx", "index.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      );

      // The way the command used to be started, which is how the plant is shown to work at all.
      await start(process.execPath, ["--import", "tsx", SOURCE, "--version"], BASE_ENV, {
        cwd: dir,
      }).done;
      expect(await exists(marker), "control: the plant runs under --import tsx").toBe(true);
      await rm(marker);

      const outcome = await start(LAUNCHER, ["--version"], BASE_ENV, { cwd: dir }).done;

      expect(await exists(marker)).toBe(false);
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toBe("0.0.0\n");
    },
  );

  it(
    "cannot redirect the imports of the command with a tsconfig.json",
    {
      timeout: TIMEOUT,
    },
    async () => {
      const dir = await makeDir();
      const marker = join(dir, "TSCONFIG-PLANTED");
      // A module that runs, then hands on the real one, so that nothing looks wrong afterwards.
      await writeFile(
        join(dir, "stand-in.mjs"),
        `import { writeFileSync } from "node:fs";\n` +
          `export * from ${JSON.stringify(zodEntry)};\n` +
          `writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      );
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { zod: ["./stand-in.mjs"] } },
          include: [`${root}/**/*`],
        }),
      );

      await start(PROJECT_TSX, [SOURCE, "--version"], BASE_ENV, { cwd: dir }).done;
      expect(await exists(marker), "control: the plant runs under a plain tsx").toBe(true);
      await rm(marker);

      const outcome = await start(LAUNCHER, ["--version"], BASE_ENV, { cwd: dir }).done;

      expect(await exists(marker)).toBe(false);
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toBe("0.0.0\n");
    },
  );

  it(
    "cannot run a script of its package.json or a tsx shim of its own",
    {
      timeout: TIMEOUT,
    },
    async () => {
      const dir = await makeDir();
      const marker = join(dir, "PWNED");
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { tsx: `node -e "require('fs').writeFileSync('PWNED','x')"` },
        }),
      );
      await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
      await writeFile(join(dir, "node_modules", ".bin", "tsx"), `#!/bin/sh\ntouch "${marker}"\n`, {
        mode: 0o755,
      });

      const outcome = await start(LAUNCHER, ["--version"], BASE_ENV, { cwd: dir }).done;

      expect(await exists(marker)).toBe(false);
      expect(outcome.stdout).toBe("0.0.0\n");
    },
  );
});

describe("pnpm clausewise", () => {
  it("still runs the command", { timeout: TIMEOUT }, async () => {
    const outcome = await start("pnpm", ["clausewise", "--version"], BASE_ENV).done;

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/^0\.0\.0$/m);
  });
});
