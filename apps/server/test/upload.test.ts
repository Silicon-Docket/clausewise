import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { ApiError, DocumentSummary } from "@clausewise/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { documents } from "../src/db/schema.js";
import { silentLogger } from "../src/log.js";
import { startServer } from "../src/start.js";
import {
  createHarness,
  endlessBody,
  fixtureBytes,
  later,
  oracleFor,
  storedZip,
  tempDir,
  testConfig,
  type Harness,
} from "./support.js";

async function stored(t: Harness): Promise<string[]> {
  return (await readdir(join(t.dataDir, "documents"))).sort();
}

async function rows(t: Harness) {
  return t.database.db.select().from(documents);
}

/** A POST with a body that arrives as a stream, which Node's fetch wants to be told is one-way. */
function streamed(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): RequestInit & { duplex: "half" } {
  return { method: "POST", headers, body, duplex: "half" };
}

function multipart(name: string, bytes: Uint8Array<ArrayBuffer>, field = "file"): FormData {
  const form = new FormData();
  form.set(field, new File([bytes], name));
  return form;
}

describe("uploading a contract", () => {
  let t: Harness;
  let docx: Uint8Array<ArrayBuffer>;
  beforeAll(async () => {
    t = await createHarness({ generator: await oracleFor("nda-aggressive.docx"), scope: "file" });
    docx = await fixtureBytes("nda-aggressive.docx");
  });

  describe("what is stored", () => {
    it("keeps the file under a random name, with private permissions, and the name only as data", async () => {
      const before = await stored(t);
      const response = await t.upload("Acme merger - indemnity draft.docx", docx);
      expect(response.status).toBe(201);
      const summary = (await response.json()) as DocumentSummary;
      expect(summary).toMatchObject({
        fileName: "Acme merger - indemnity draft.docx",
        size: docx.byteLength,
        reviewCount: 0,
      });
      expect(summary.paragraphs).toBeGreaterThan(10);
      expect(Date.parse(summary.createdAt)).not.toBeNaN();

      const [row] = await t.database.db
        .select()
        .from(documents)
        .where(eq(documents.id, summary.id));
      expect(row?.sha256).toBe(createHash("sha256").update(docx).digest("hex"));
      expect(row?.size).toBe(docx.byteLength);

      const after = await stored(t);
      const added = after.filter((name) => !before.includes(name));
      expect(added).toEqual([row?.storageKey]);
      // The folder holds only whole files with the random name: no temporary file is left over.
      expect(after.every((name) => /^[0-9a-f-]{36}$/.test(name))).toBe(true);
      expect(added[0]).not.toContain("Acme");

      const path = join(t.dataDir, "documents", added[0] ?? "");
      expect(Buffer.compare(await readFile(path), docx)).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(t.dataDir, "documents"))).mode & 0o777).toBe(0o700);
    });

    it("lists documents newest first and counts their reviews", async () => {
      const a = await t.uploadFixture("nda-aggressive.docx");
      t.clock.advance(60_000);
      const b = await t.uploadFixture("nda-aggressive.docx");
      const list = await t.json<{ documents: DocumentSummary[] }>("/api/documents");
      const ids = list.body.documents.map((d) => d.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    });
  });

  describe("the name shown for the file", () => {
    const cases: [string, string, string][] = [
      ["a path", "../../etc/passwd.docx", "passwd.docx"],
      ["a windows path", "C:\\Users\\me\\Documents\\nda.docx", "nda.docx"],
      ["mixed separators", "a/b\\c/../d.docx", "d.docx"],
      ["control characters", "nda\u0000\u0007\n\r.docx", "nda.docx"],
      ["a bidi override", "nda\u202Excod.docx", "ndaxcod.docx"],
      ["bidi isolates and marks", "\u2066a\u2069\u200Fb\u061C.docx", "ab.docx"],
      ["line separators", "a\u2028b\u2029c.docx", "abc.docx"],
      ["nothing left", "\u0000\u0001", "contract.docx"],
      ["only dots", "..", "contract.docx"],
      ["a folder", "some/folder/", "contract.docx"],
      ["spaces", "   ", "contract.docx"],
    ];
    for (const [label, sent, expected] of cases) {
      it(`cleans ${label}`, async () => {
        const response = await t.upload(sent, docx);
        expect(response.status).toBe(201);
        expect(((await response.json()) as DocumentSummary).fileName).toBe(expected);
      });
    }

    it("keeps at most 200 characters and the extension", async () => {
      const response = await t.upload(`${"x".repeat(400)}.docx`, docx);
      const { fileName } = (await response.json()) as DocumentSummary;
      expect([...fileName]).toHaveLength(200);
      expect(fileName.endsWith(".docx")).toBe(true);
      const long = await t.upload("y".repeat(400), docx);
      expect([...((await long.json()) as DocumentSummary).fileName]).toHaveLength(200);
    });

    it("builds a download header from the cleaned name that cannot be turned against the browser", async () => {
      const upload = await t.upload('M\u00fcller "NDA"; filename=evil.exe %41\u202E.docx', docx);
      const { id, fileName } = (await upload.json()) as DocumentSummary;
      expect(fileName).toBe('M\u00fcller "NDA"; filename=evil.exe %41.docx');
      const file = await t.request(`/api/documents/${id}/file`);
      const header = file.headers.get("content-disposition") ?? "";
      expect(header).toBe(
        `attachment; filename="Muller _NDA_; filename=evil.exe _41.docx"; filename*=UTF-8''M%C3%BCller%20%22NDA%22%3B%20filename%3Devil.exe%20%2541.docx`,
      );
      expect(header).not.toMatch(/[\r\n]/);
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(file.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("what is refused as not a Word document", () => {
    const notWord: [string, Uint8Array<ArrayBuffer>, RegExp][] = [
      [
        "plain text",
        new TextEncoder().encode("This is not a contract.") as Uint8Array<ArrayBuffer>,
        /not a valid zip/,
      ],
      ["an empty file", new Uint8Array(0), /not a valid zip/],
      [
        "a pdf",
        new TextEncoder().encode("%PDF-1.7\n1 0 obj\n") as Uint8Array<ArrayBuffer>,
        /not a valid zip/,
      ],
      [
        "an old Word file or a password protected one",
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
        /old-format Word document or it is password protected/,
      ],
      ["a zip that is not a Word document", storedZip({ "hello.txt": "hello" }), /./],
    ];
    for (const [label, bytes, message] of notWord) {
      it(`answers 422 with the Word engine's words for ${label}`, async () => {
        const filesBefore = await stored(t);
        const rowsBefore = (await rows(t)).length;
        const response = await t.upload("contract.docx", bytes);
        expect(response.status).toBe(422);
        const body = (await response.json()) as ApiError;
        expect(body.error.code).toBe("invalid_document");
        expect(body.error.message).toMatch(message);
        // Nothing was kept of it.
        expect(await stored(t)).toEqual(filesBefore);
        expect((await rows(t)).length).toBe(rowsBefore);
      });
    }

    it("answers 422 for a Word file cut short and for one with something in front of it", async () => {
      const cut = await t.upload("cut.docx", docx.slice(0, Math.floor(docx.byteLength / 2)));
      expect(cut.status).toBe(422);
      expect(((await cut.json()) as ApiError).error.code).toBe("invalid_document");

      const prefixed = new Uint8Array(docx.byteLength + 16);
      prefixed.set(docx, 16);
      const response = await t.upload("prefixed.docx", prefixed);
      expect(response.status).toBe(422);
      expect(((await response.json()) as ApiError).error.message).toContain("not a valid zip");
    });

    it("does not repeat anything from the file in the message", async () => {
      const response = await t.upload(
        "contract.docx",
        new TextEncoder().encode(
          "CONFIDENTIAL indemnity term of the Zeta merger",
        ) as Uint8Array<ArrayBuffer>,
      );
      const text = await response.text();
      expect(response.status).toBe(422);
      expect(text).not.toContain("Zeta");
      expect(text).not.toContain("CONFIDENTIAL");
    });
  });

  describe("what is refused as a bad request", () => {
    it("needs a form field called file that holds a file", async () => {
      const wrongName = await t.request("/api/documents", {
        method: "POST",
        body: multipart("a.docx", docx, "upload"),
      });
      expect(wrongName.status).toBe(400);
      const form = new FormData();
      form.set("file", "just text, not a file");
      const text = await t.request("/api/documents", { method: "POST", body: form });
      expect(text.status).toBe(400);
      expect(((await text.json()) as ApiError).error.code).toBe("bad_request");
    });

    it("answers 400 for a body that is not a well formed form", async () => {
      const response = await t.request("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=xyz" },
        body: '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.docx"\r\n\r\nno end to this part',
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe("bad_request");
    });

    it("takes the first file when several are sent", async () => {
      const form = new FormData();
      form.append("file", new File([docx], "first.docx"));
      form.append("file", new File([new Uint8Array([1, 2, 3])], "second.docx"));
      const response = await t.request("/api/documents", { method: "POST", body: form });
      expect(response.status).toBe(201);
      expect(((await response.json()) as DocumentSummary).fileName).toBe("first.docx");
    });
  });

  describe("the size cap", () => {
    const CAP = 256 * 1024;
    let small: Harness;
    beforeAll(async () => {
      small = await createHarness({
        generator: await oracleFor("nda-aggressive.docx"),
        config: { maxUploadBytes: CAP },
        scope: "file",
      });
    });

    it("refuses at once when the declared length is over the cap, without reading the body", async () => {
      const body = endlessBody();
      const response = await small.request(
        "/api/documents",
        streamed(body.stream, {
          "Content-Type": "multipart/form-data; boundary=xyz",
          "Content-Length": String(CAP * 100),
        }),
      );
      expect(response.status).toBe(413);
      expect(((await response.json()) as ApiError).error.code).toBe("payload_too_large");
      // A stream fills its own queue with one chunk before anything reads it. Nothing more was taken.
      expect(body.pulled()).toBeLessThanOrEqual(64 * 1024);
    });

    it("stops reading a body that never ends once it passes the cap, and asks for the connection to be closed", async () => {
      const body = endlessBody();
      const response = await small.request(
        "/api/documents",
        streamed(body.stream, { "Content-Type": "multipart/form-data; boundary=xyz" }),
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      const error = ((await response.json()) as ApiError).error;
      expect(error.code).toBe("payload_too_large");
      expect(error.message).toContain("CLAUSEWISE_MAX_UPLOAD_MB");
      expect(error.message).toContain("256 KB");
      // What was taken from the stream is the cap plus the room the form needs and a few chunks
      // that the stream machinery reads ahead, and nothing like the endless rest.
      expect(body.pulled()).toBeGreaterThan(CAP);
      expect(body.pulled()).toBeLessThan(CAP + 64 * 1024 + 4 * 64 * 1024);
      const settled = body.pulled();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(body.pulled()).toBe(settled);
    });

    it("counts the bytes it receives and not the length the client declared", async () => {
      const body = endlessBody();
      const response = await small.request(
        "/api/documents",
        streamed(body.stream, {
          "Content-Type": "multipart/form-data; boundary=xyz",
          "Content-Length": "100",
        }),
      );
      expect(response.status).toBe(413);
      expect(body.pulled()).toBeLessThan(CAP + 64 * 1024 + 4 * 64 * 1024);
    });

    it("refuses a file one byte over the cap and takes one that fits", async () => {
      const filesBefore = await stored(small);
      const over = await small.upload("big.docx", new Uint8Array(CAP + 1));
      expect(over.status).toBe(413);
      // Under the cap it is the content that is judged: this is not a Word file.
      const exact = await small.upload("big.docx", new Uint8Array(CAP));
      expect(exact.status).toBe(422);
      expect(await stored(small)).toEqual(filesBefore);
    });

    it("stops a real connection from sending more than the cap and a little more", async () => {
      const dataDir = await tempDir();
      const server = await startServer({
        config: testConfig(dataDir, { maxUploadBytes: CAP }),
        generator: await oracleFor("nda-aggressive.docx"),
        log: silentLogger,
        database: { kind: "memory" },
      });
      later(() => server.close());

      const outcome = await new Promise<{
        sent: number;
        status: number | undefined;
        closed: string;
      }>((resolve) => {
        let sent = 0;
        let status: number | undefined;
        let finished = false;
        const done = (closed: string): void => {
          if (finished) return;
          finished = true;
          resolve({ sent, status, closed });
        };
        const request = httpRequest(
          `${server.url}/api/documents`,
          {
            method: "POST",
            headers: { "Content-Type": "multipart/form-data; boundary=xyz" },
          },
          (response) => {
            status = response.statusCode;
            response.resume();
            response.on("end", () => done("response"));
          },
        );
        request.on("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        // Up to 512 MB, written for as long as the server lets it.
        const write = (): void => {
          for (let i = 0; i < 8192 && !finished; i += 1) {
            sent += chunk.length;
            if (!request.write(chunk)) {
              request.once("drain", write);
              return;
            }
          }
          request.end();
        };
        write();
      });
      // The connection was cut or answered long before 512 MB had gone out. What was sent is the
      // cap plus whatever the sockets could hold, which is far less than the 32 MB allowed here.
      expect(outcome.sent).toBeLessThan(32 * 1024 * 1024);
      expect(
        outcome.status === 413 || outcome.closed === "ECONNRESET" || outcome.closed === "EPIPE",
      ).toBe(true);
    });
  });
});
