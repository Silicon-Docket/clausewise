import type { ReviewRecord, ReviewRecords } from "@clausewise/service";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * What every ReviewRecords store must do, so the in-memory store and PostgreSQL can stand in for
 * each other. `fresh` returns an empty store.
 */
export function recordsContract(name: string, fresh: () => Promise<ReviewRecords>): void {
  describe(`${name} keeps the ReviewRecords contract`, () => {
    let records: ReviewRecords;
    beforeEach(async () => {
      records = await fresh();
    });

    const record = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
      id: "review-1",
      owner: "alice",
      playbookId: "nda-mutual",
      fileName: "nda.docx",
      client: undefined,
      author: "Clausewise",
      status: "awaiting_upload",
      createdAt: "2026-11-09T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      ...overrides,
    });

    it("gives back what was created, with no field added or lost", async () => {
      await records.create(record({ client: "Fabrikam Labs LLC" }));
      expect(await records.get("review-1")).toEqual(record({ client: "Fabrikam Labs LLC" }));
      expect(await records.get("no-such-review")).toBeUndefined();
    });

    it("refuses a second review with the same id", async () => {
      await records.create(record());
      await expect(records.create(record())).rejects.toBeDefined();
    });

    it("moves a review on only from the states it names", async () => {
      await records.create(record());
      expect(
        await records.transition("review-1", ["queued"], {
          status: "running",
          updatedAt: "2026-11-09T10:01:00.000Z",
        }),
      ).toBeUndefined();
      const queued = await records.transition("review-1", ["awaiting_upload"], {
        status: "queued",
        updatedAt: "2026-11-09T10:01:00.000Z",
      });
      expect(queued).toEqual(record({ status: "queued", updatedAt: "2026-11-09T10:01:00.000Z" }));
      expect(await records.get("review-1")).toEqual(queued);
    });

    it("keeps the results of a finished review", async () => {
      await records.create(record({ status: "running" }));
      const done = await records.transition("review-1", ["running"], {
        status: "done",
        open: { high: 4, medium: 4, low: 2 },
        unchecked: 0,
        updatedAt: "2026-11-09T10:05:00.000Z",
      });
      expect(done).toEqual(
        record({
          status: "done",
          open: { high: 4, medium: 4, low: 2 },
          unchecked: 0,
          updatedAt: "2026-11-09T10:05:00.000Z",
        }),
      );
    });

    it("keeps why a failed review failed", async () => {
      await records.create(record({ status: "running" }));
      await records.transition("review-1", ["running"], {
        status: "failed",
        error: "No rule could be checked, so nothing was reviewed.",
        updatedAt: "2026-11-09T10:05:00.000Z",
      });
      expect((await records.get("review-1"))?.error).toBe(
        "No rule could be checked, so nothing was reviewed.",
      );
    });

    it("hands a queued review to one worker, and a stale one to the next", async () => {
      await records.create(record({ status: "queued" }));
      const claimed = await records.claim(
        "review-1",
        "2026-11-09T10:01:00.000Z",
        "2026-11-09T09:31:00.000Z",
      );
      expect(claimed?.status).toBe("running");
      expect(claimed?.updatedAt).toBe("2026-11-09T10:01:00.000Z");
      expect(
        await records.claim("review-1", "2026-11-09T10:02:00.000Z", "2026-11-09T09:32:00.000Z"),
      ).toBeUndefined();
      // Once the first worker has not touched it for longer than the lease, it can be taken over.
      expect(
        (await records.claim("review-1", "2026-11-09T10:40:00.000Z", "2026-11-09T10:10:00.000Z"))
          ?.updatedAt,
      ).toBe("2026-11-09T10:40:00.000Z");
    });

    it("never hands a review that is waiting for its contract, done or failed to a worker", async () => {
      for (const status of ["awaiting_upload", "done", "failed"] as const) {
        await records.create(record({ id: status, status }));
        expect(
          await records.claim(status, "2026-11-09T10:01:00.000Z", "2026-11-09T12:00:00.000Z"),
        ).toBeUndefined();
      }
    });

    it("lets exactly one of two simultaneous claims win", async () => {
      await records.create(record({ status: "queued" }));
      const claims = await Promise.all(
        [1, 2].map(() =>
          records.claim("review-1", "2026-11-09T10:01:00.000Z", "2026-11-09T09:31:00.000Z"),
        ),
      );
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    });
  });
}
