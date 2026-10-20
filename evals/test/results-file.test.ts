import { readFile, readdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertWritable, writeFileAtomically } from "../src/results-file.js";
import { makeTempDir, removeDir } from "./support.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

describe("writing the results", () => {
  it("writes the whole file and leaves no temporary file", async () => {
    await writeFileAtomically(`${dir}/deep/er/a.json`, "{}\n", { replace: false });
    expect(await readFile(`${dir}/deep/er/a.json`, "utf8")).toBe("{}\n");
    expect(await readdir(`${dir}/deep/er`)).toEqual(["a.json"]);
  });

  it("never replaces a file that appeared in the meantime", async () => {
    await writeFile(`${dir}/b.json`, "mine");
    await expect(
      writeFileAtomically(`${dir}/b.json`, "{}", { replace: false }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(`${dir}/b.json`, "utf8")).toBe("mine");
    expect(await readdir(dir)).not.toContain(`b.json.${process.pid}.tmp`);
  });

  it("replaces a checkpoint when asked to", async () => {
    await writeFileAtomically(`${dir}/c.partial`, "one", { replace: true });
    await writeFileAtomically(`${dir}/c.partial`, "two", { replace: true });
    expect(await readFile(`${dir}/c.partial`, "utf8")).toBe("two");
  });

  it("accepts a path whose directory does not exist yet, and refuses one under a file", async () => {
    await expect(assertWritable(`${dir}/new/dir/file.json`)).resolves.toBeUndefined();
    await expect(readdir(`${dir}/new`)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(`${dir}/plain`, "x");
    await expect(assertWritable(`${dir}/plain/file.json`)).rejects.toThrow("is not a directory");
  });
});
