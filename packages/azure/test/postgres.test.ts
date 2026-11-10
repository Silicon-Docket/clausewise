import { memoryRecords } from "@clausewise/service/memory";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, postgresRecords } from "../src/index.js";
import { recordsContract } from "./records-contract.js";

// The in-memory store is held to the same contract, so the two are known to be interchangeable.
recordsContract("the in-memory store", async () => memoryRecords());

// These need a PostgreSQL server: set CLAUSEWISE_TEST_POSTGRES_URL to a database owned by
// clausewise_migrate, with login roles clausewise_web and clausewise_worker (see
// packages/azure/README.md). Without it they are skipped.
const url = process.env.CLAUSEWISE_TEST_POSTGRES_URL;

// pg takes the user from the connection string and ignores a separate user setting, so each
// role gets its own URL.
function pool(user: string): pg.Pool {
  const connection = new URL(url ?? "");
  connection.username = user;
  return new pg.Pool({ connectionString: connection.toString(), max: 4 });
}

describe.skipIf(url === undefined)("PostgreSQL", () => {
  let admin: pg.Pool;
  let web: pg.Pool;
  let worker: pg.Pool;

  beforeAll(async () => {
    admin = pool("clausewise_migrate");
    web = pool("clausewise_web");
    worker = pool("clausewise_worker");
    await admin.query("DROP TABLE IF EXISTS reviews, clausewise_migrations");
    await migrate(admin, {
      appRoles: [
        { name: "clausewise_web", privileges: ["SELECT", "INSERT", "UPDATE"] },
        { name: "clausewise_worker", privileges: ["SELECT", "UPDATE"] },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all([admin?.end(), web?.end(), worker?.end()]);
  });

  recordsContract("PostgreSQL", async () => {
    await admin.query("TRUNCATE reviews");
    return postgresRecords(web);
  });

  it("applies each migration once, however often it runs", async () => {
    expect(await migrate(admin)).toEqual([]);
    const versions = await admin.query("SELECT version FROM clausewise_migrations ORDER BY 1");
    expect(versions.rows).toEqual([{ version: 1 }]);
  });

  it("lets two migrate jobs started together finish without a clash", async () => {
    const both = await Promise.all([migrate(admin), migrate(admin)]);
    expect(both).toEqual([[], []]);
  });

  it("gives the worker no way to create a review", async () => {
    const records = postgresRecords(worker);
    await expect(
      records.create({
        id: "forged",
        owner: "mallory",
        playbookId: "nda-mutual",
        fileName: "nda.docx",
        client: undefined,
        author: "Clausewise",
        status: "queued",
        createdAt: "2026-11-09T10:00:00.000Z",
        updatedAt: "2026-11-09T10:00:00.000Z",
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["web", "DELETE FROM reviews"],
    ["worker", "DELETE FROM reviews"],
    ["web", "DROP TABLE reviews"],
    ["web", "CREATE TABLE elsewhere (id int)"],
  ])("refuses the %s role %j", async (role, sql) => {
    await expect((role === "web" ? web : worker).query(sql)).rejects.toThrow(
      /permission denied|must be owner/,
    );
  });

  it("refuses a patch field that has no column, instead of dropping it", async () => {
    await admin.query("TRUNCATE reviews");
    const records = postgresRecords(web);
    await expect(
      records.transition("review-1", ["queued"], {
        updatedAt: "2026-11-09T10:00:00.000Z",
        fileName: "other.docx",
      }),
    ).rejects.toThrow(/fileName cannot be changed/);
  });

  it("refuses a status outside the five a review can have", async () => {
    await expect(
      admin.query(
        `INSERT INTO reviews (id, owner, playbook_id, file_name, author, status, created_at, updated_at)
         VALUES ('x', 'a', 'p', 'f.docx', 'Clausewise', 'paused', now(), now())`,
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("refuses privileges other than SELECT, INSERT and UPDATE", async () => {
    await expect(
      migrate(admin, {
        appRoles: [{ name: "clausewise_web", privileges: ["DELETE" as "SELECT"] }],
      }),
    ).rejects.toThrow(/SELECT, INSERT or UPDATE/);
  });

  it("asks Azure to create Entra principals only when told to, and rolls back if it cannot", async () => {
    // Plain PostgreSQL has no pgaadauth_create_principal, which is how this shows the call is made.
    await expect(
      migrate(admin, {
        createEntraPrincipals: true,
        appRoles: [{ name: "clausewise-id-new", privileges: ["SELECT"] }],
      }),
    ).rejects.toThrow(/pgaadauth_create_principal/);
    // The failed run left nothing behind.
    expect(await migrate(admin)).toEqual([]);
  });
});
