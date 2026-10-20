import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_ENV, TIMEOUT, cleanUpChildren, start } from "./child.js";
import { root, tempDirs } from "./support.js";

cleanUpChildren();

const BIN = join(root, "apps", "cli", "src", "bin.ts");
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** What the kernel does with a shebang line: hands env the rest of the line as one argument. */
async function shebangCommand(): Promise<string[]> {
  const [first = ""] = (await readFile(BIN, "utf8")).split("\n");
  const match = /^#!\/usr\/bin\/env -S (.+)$/.exec(first);
  if (match === null) throw new Error(`unexpected shebang: ${first}`);
  return ["-S", match[1] ?? ""];
}

describe("the executable's shebang", () => {
  const makeDir = tempDirs();

  it("runs node with tsx and does not go through the package manager", async () => {
    const [first] = (await readFile(BIN, "utf8")).split("\n");

    expect(first).toBe("#!/usr/bin/env -S node --import tsx");
  });

  it("starts the command in the project", { timeout: TIMEOUT }, async () => {
    const run = start("/usr/bin/env", [...(await shebangCommand()), BIN, "--version"], BASE_ENV);

    const outcome = await run.done;

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe("0.0.0\n");
  });

  it(
    "does not run a script of the package.json in the folder it is started from",
    {
      timeout: TIMEOUT,
    },
    async () => {
      const dir = await makeDir();
      const marker = join(dir, "PWNED");
      // What a folder of unpacked documents could hold: a script named like the tool, and the shim
      // a package manager would put in .bin.
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

      const run = start("/usr/bin/env", [...(await shebangCommand()), BIN, "--version"], BASE_ENV, {
        cwd: dir,
      });
      await run.done;

      expect(await exists(marker)).toBe(false);
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
