import { expect, test as base } from "../fixtures.js";
import { listDocuments, removeDocument } from "./api.js";

export { expect };

/**
 * The scenarios of the browser specs, with one more guarantee: whatever a test uploaded to the
 * shared server it used is deleted again when the test ends, whichever way it ended. The servers
 * are shared by every test of the run, and other files count the contracts on them, so a test that
 * leaves its documents behind changes what the next one sees. Reviews and decisions go with their
 * document.
 */
export const test = base.extend<{ tidy: void }>({
  tidy: [
    async ({ request, server }, use) => {
      const token = server.accessToken;
      const before = new Set((await listDocuments(request, token)).map((document) => document.id));
      await use();
      for (const document of await listDocuments(request, token)) {
        if (!before.has(document.id)) await removeDocument(request, document.id, token);
      }
    },
    { auto: true },
  ],
});
