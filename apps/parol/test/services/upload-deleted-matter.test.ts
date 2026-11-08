import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * An upload is parsed after it was accepted, and the matter can be deleted while that goes on. The
 * answer is that the matter is gone, as for any other request that names it, and not an instruction
 * to upload an NDA first.
 */

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("an upload still being read when its matter is deleted", () => {
  it("as a new document is answered with not found, and nothing is left on disk", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const upload = w.services.matters.addDocument(am, {
      title: "Amendment No. 2",
      kind: "amendment",
      fileName: "amendment-2.txt",
      bytes: text("AMENDMENT NO. 2\n\n1. Section 9 of the Agreement is deleted in its entirety.\n"),
      statedDate: "2026-10-01",
    });
    // The upload has been accepted and is being parsed; the person deletes the matter now.
    await w.services.matters.delete(am);

    const error = await upload.catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "NotFoundError", entity: "matter" });
    expect(w.repo.getMatter(matterId)).toBeUndefined();
    expect(existsSync(join(w.files.root, matterId))).toBe(false);
  });

  it("as a new version is answered with not found, and nothing is left on disk", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const upload = w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "amendment-corrected.txt",
      bytes: text(
        "AMENDMENT NO. 1\n\n1. Section 6.1 of the Agreement is restated, and nothing else.\n",
      ),
      statedDate: "2026-10-01",
    });
    await w.services.matters.delete(am);

    const error = await upload.catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "NotFoundError" });
    expect(existsSync(join(w.files.root, matterId))).toBe(false);
  });
});
