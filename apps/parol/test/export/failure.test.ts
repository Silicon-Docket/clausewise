import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoGateError, buildMemo } from "../../src/export/memo.js";
import { MemoError } from "../../src/module-contracts.js";
import { replaceFinding, review, workedExample } from "./support.js";

const state = vi.hoisted(() => ({ fail: false }));

// A library that echoes its input in an error is the case that matters: the message below holds
// what stands in for document text, and it must not reach the caller.
vi.mock("docx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("docx")>();
  return {
    ...actual,
    Packer: {
      toBuffer: (document: Parameters<typeof actual.Packer.toBuffer>[0]) => {
        if (state.fail) {
          const error = new RangeError("could not write: Lanternfish clause 6.1 is deleted");
          throw error;
        }
        return actual.Packer.toBuffer(document);
      },
    },
  };
});

beforeEach(() => {
  state.fail = false;
});

describe("only a MemoError ever escapes", () => {
  it("turns a failure while writing the file into a MemoError that names no text", async () => {
    state.fail = true;
    const error = await buildMemo(workedExample()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoGateError);
    expect(error).toBeInstanceOf(MemoError);
    expect((error as MemoGateError).gate).toBe("write_failed");
    expect((error as Error).message).toBe("The memo file could not be written (RangeError).");
    expect((error as Error).message).not.toContain("Lanternfish");
    expect((error as Error).cause).toBeUndefined();
  });

  it("works again once the failure is gone", async () => {
    await expect(buildMemo(workedExample())).resolves.toBeInstanceOf(Uint8Array);
  });

  it("turns input that is not shaped as the contract says into a MemoError", async () => {
    const error = await buildMemo({ ...workedExample(), matter: undefined as never }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MemoGateError);
    expect((error as MemoGateError).gate).toBe("invalid_input");
    expect((error as Error).message).toBe("The memo input is malformed (TypeError).");
  });

  it("treats input with no findings member as an empty list of findings", async () => {
    const error = await buildMemo({} as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoGateError);
    expect((error as MemoGateError).gate).toBe("no_findings");
  });
});

describe("who decided and who exported", () => {
  it("refuses a decision that does not say who made it", async () => {
    const input = replaceFinding(workedExample(), "dur-1", (item) => ({
      ...item,
      review: review("accept", { reviewerName: " \u0000 " }),
    }));
    await expect(buildMemo(input)).rejects.toThrow(
      "The decision on rule dur-1 has no reviewer name.",
    );
  });

  it("refuses an export that does not say who exported it", async () => {
    await expect(buildMemo({ ...workedExample(), exportedBy: "" })).rejects.toThrow(
      "The memo does not say who exported it.",
    );
  });
});
