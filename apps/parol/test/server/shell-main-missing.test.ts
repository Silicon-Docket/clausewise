import { describe, expect, it } from "vitest";
import { StartupError, requireModule } from "../../src/main.js";

/**
 * The server is built from modules written apart from this one. If one of them is not there, the
 * start stops with a message that names it. A fault inside a module that is there is not
 * disguised as a missing file.
 */
const notFound = (message: string) =>
  Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });

describe("requireModule", () => {
  it("returns the module when it loads", async () => {
    await expect(requireModule(async () => ({ ok: true }), "services/index")).resolves.toEqual({
      ok: true,
    });
  });

  it("names the module when that module is the one that is missing", async () => {
    const failure = await requireModule(async () => {
      throw notFound("Cannot find module '/app/src/services/index.js' imported from main.ts");
    }, "services/index").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StartupError);
    expect((failure as Error).message).toBe(
      "Parol cannot start: the module services/index is missing.",
    );
  });

  it("also recognises the CommonJS code", async () => {
    const failure = await requireModule(async () => {
      throw Object.assign(new Error("Cannot find module 'boot/register'"), {
        code: "MODULE_NOT_FOUND",
      });
    }, "boot/register").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StartupError);
  });

  it("passes on a missing dependency of the module, which is a different fault", async () => {
    // Its own import is what failed, though the file that asked is named services/index.
    const inner = notFound(
      "Cannot find package 'left-pad' imported from /app/src/services/index.ts",
    );
    const failure = await requireModule(async () => {
      throw inner;
    }, "services/index").catch((error: unknown) => error);
    expect(failure).toBe(inner);
  });

  it("passes on any other error as it is", async () => {
    const inner = new SyntaxError("Unexpected token in services/index");
    const failure = await requireModule(async () => {
      throw inner;
    }, "services/index").catch((error: unknown) => error);
    expect(failure).toBe(inner);
  });
});
