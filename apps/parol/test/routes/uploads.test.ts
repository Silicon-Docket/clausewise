import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import type { MatterView } from "../../src/services/views.js";
import { all, attr, hasClass, parseHtml, readable } from "../pages/html.js";
import {
  IDS,
  baseWorld,
  cleanup,
  fingerprint,
  makeSite,
  multipart,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * Uploads, as a hostile or careless person could make them, through the page forms and the JSON
 * API. Every refusal is a status and a fixed message, leaves the matter and the file store exactly
 * as they were, and says nothing of what was uploaded. The file name a browser sends is read for
 * its extension and nowhere else.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NDA = baseWorld.files.find((f) => f.label === "D1")!;
const AMENDMENT = baseWorld.files.find((f) => f.label === "D2")!;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A reviewable text file; `n` makes each one different, so none is a duplicate of another. */
const amendment = (n: number): Uint8Array =>
  text(
    `AMENDMENT NO. ${n + 2} TO MUTUAL NONDISCLOSURE AGREEMENT\n\n1. Section ${n + 10} of the Agreement is deleted in its entirety, and nothing replaces it.\n`,
  );

/** Every file under the store's root, relative to it, sorted. */
function storedFiles(site: Site): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path, `${prefix}${name}/`) : [`${prefix}${name}`];
    });
  return walk(site.w.files.root, "").sort();
}

interface Case {
  site: Site;
  ids: Prepared;
  associate: Browser;
}

async function caseWith(maxUploadBytes: number): Promise<Case> {
  const site = makeSite({ maxUploadBytes });
  // Not exported: an upload to a matter that has results makes them stale, which is not the point here.
  const ids = await prepareMatter(site, { exported: false });
  return { site, ids, associate: await site.as(IDS.associate) };
}

let big: Case;
let small: Case;

beforeAll(async () => {
  // `big` lets a file reach the parsers' own limits; `small` stops it at the door.
  big = await caseWith(10 * 1024 * 1024);
  small = await caseWith(20_000);
});

/** Uploads a new version of the amendment through the page form. */
async function viaPage(c: Case, name: string, bytes: Uint8Array): Promise<Response> {
  const page = await c.associate.page(urls.matter(c.ids.matterId));
  return c.associate.upload(page, urls.versions(c.ids.matterId, c.ids.lastDocumentId), {
    name,
    bytes,
  });
}

/** The same through the JSON API. */
function viaApi(c: Case, name: string, bytes: Uint8Array): Promise<Response> {
  return c.associate.apiUpload(
    `/api/matters/${c.ids.matterId}/documents/${c.ids.lastDocumentId}/versions`,
    {},
    { name, bytes },
  );
}

const apiError = async (r: Response): Promise<{ kind: string; message: string }> =>
  ((await r.json()) as { error: { kind: string; message: string } }).error;

/** A refusal leaves every row and every stored file as it was. */
async function expectUntouched(c: Case, send: () => Promise<Response>): Promise<Response> {
  const rows = fingerprint(c.site);
  const files = storedFiles(c.site);
  const response = await send();
  expect(fingerprint(c.site)).toEqual(rows);
  expect(storedFiles(c.site)).toEqual(files);
  return response;
}

describe("a file that is too large", () => {
  it("is refused at the door when the whole request is past the limit, page and JSON", async () => {
    const bytes = new Uint8Array(200_000).fill(0x61);
    const page = await expectUntouched(small, () => viaPage(small, "huge.txt", bytes));
    expect(page.status).toBe(413);
    const api = await expectUntouched(small, () => viaApi(small, "huge.txt", bytes));
    expect(api.status).toBe(413);
    expect((await apiError(api)).kind).toBe("too_large");
  });

  it("is refused by the route when only the file is past the limit and the request is not", async () => {
    // 30 kB against a limit of 20 kB: the request fits in the room left for form fields, the file does not.
    const bytes = new Uint8Array(30_000).fill(0x61);
    const page = await expectUntouched(small, () => viaPage(small, "large.txt", bytes));
    expect(page.status).toBe(413);
    const api = await expectUntouched(small, () => viaApi(small, "large.txt", bytes));
    expect(api.status).toBe(413);
    expect((await apiError(api)).kind).toBe("too_large");
  });

  it("takes a file just inside the limit", async () => {
    const body = "This is a synthetic paragraph of a contract. ".repeat(400);
    const bytes = text(`AMENDMENT NO. 9 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n1. ${body}\n`).slice(
      0,
      19_000,
    );
    expect((await viaPage(small, "inside.txt", bytes)).status).toBe(303);
  });

  it("is refused by the parser when a text file is past what a contract is, whatever the door allows", async () => {
    const line = "1. Synthetic text of an agreement that never ends. ".repeat(45_000);
    const bytes = text(`AMENDMENT\n\n${line}\n`);
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    const api = await expectUntouched(big, () => viaApi(big, "long.txt", bytes));
    expect(api.status).toBe(422);
    expect(await apiError(api)).toMatchObject({ kind: "upload_rejected" });
    expect((await apiError(await viaApi(big, "long.txt", bytes))).message).toContain("2 MB");
    expect((await expectUntouched(big, () => viaPage(big, "long.txt", bytes))).status).toBe(422);
  });
});

describe("a file of the wrong type", () => {
  const names = [
    "contract.pdf",
    "contract.exe",
    "contract",
    "contract.doc",
    "contract.docx.exe",
    "contract.txt.pdf",
    "contract.",
    ".hidden",
  ];
  for (const name of names) {
    it(`refuses ${JSON.stringify(name)} with 422 and a fixed message`, async () => {
      const api = await expectUntouched(big, () => viaApi(big, name, amendment(1)));
      expect(api.status).toBe(422);
      expect(await apiError(api)).toEqual({
        kind: "upload_rejected",
        message: "Only .docx and .txt files can be uploaded.",
      });
      expect((await expectUntouched(big, () => viaPage(big, name, amendment(1)))).status).toBe(422);
    });
  }

  it("does not trust the extension to mean what it says: text named .docx is not a Word file", async () => {
    const api = await expectUntouched(big, () => viaApi(big, "contract.docx", amendment(2)));
    expect(api.status).toBe(422);
    expect((await apiError(api)).message).toContain("could not be read as a Word document");
    expect(
      (await expectUntouched(big, () => viaPage(big, "contract.docx", amendment(2)))).status,
    ).toBe(422);
  });

  it("refuses a Word file with nothing in it, random bytes named .docx and a zip that is not a Word file", async () => {
    const zip = new JSZip().file("hello.txt", "not a document");
    const notWord = await zip.generateAsync({ type: "uint8array" });
    const random = new Uint8Array(4_000).map((_, i) => (i * 131 + 17) % 251);
    for (const bytes of [new Uint8Array(0), random, notWord]) {
      const api = await expectUntouched(big, () => viaApi(big, "contract.docx", bytes));
      expect(api.status).toBe(422);
    }
  });
});

describe("a Word file that is a zip bomb", () => {
  it("is refused without being unpacked into memory, and with a fixed message", async () => {
    // Twenty megabytes of one letter deflate to a few kilobytes: small on the wire, large unpacked.
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"a".repeat(20 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
    const zip = new JSZip()
      .file(
        "[Content_Types].xml",
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      )
      .file(
        "_rels/.rels",
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      )
      .file("word/document.xml", xml);
    const bomb = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bomb.length).toBeLessThan(200_000);

    const started = Date.now();
    const api = await expectUntouched(big, () => viaApi(big, "bomb.docx", bomb));
    expect(api.status).toBe(422);
    expect(await apiError(api)).toEqual({
      kind: "upload_rejected",
      message: "This file is too large or too complex to review.",
    });
    expect((await expectUntouched(big, () => viaPage(big, "bomb.docx", bomb))).status).toBe(422);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("a file with a hostile name", () => {
  const accepted = [
    "../../../etc/passwd.txt",
    "..\\..\\windows\\system32\\evil.txt",
    "C:\\Users\\victim\\evil.txt",
    "/absolute/path/evil.txt",
    "<script>alert(1)</script>.txt",
    "evil\u0007\u001b[31m.txt",
    "evil\nSet-Cookie: x=y.txt",
    '"; filename="other.exe.txt',
    "\u202Etxt.exe.txt",
    "%2e%2e%2f%2e%2e%2fevil.txt",
    "con.txt",
    `${"a".repeat(240)}.txt`,
  ];

  it("reads the extension and stores the file under a name of the store's own", async () => {
    const before = new Set(storedFiles(big.site));
    let n = 100;
    for (const name of accepted) {
      n += 1;
      const response = await viaPage(big, name, amendment(n));
      expect(response.status, JSON.stringify(name)).toBe(303);
    }
    const added = storedFiles(big.site).filter((path) => !before.has(path));
    expect(added).toHaveLength(accepted.length);
    // Names made by the store: a folder per matter, then a random name. Nothing of the upload.
    for (const path of added) expect(path).toMatch(/^mat_[0-9a-f]{16}\/f_[0-9a-f]{32}$/);
    // And no file was written outside the store, in the folder of the tests or above it.
    expect(storedFiles(big.site).some((path) => /passwd|evil|\.\./.test(path))).toBe(false);
  });

  it("shows the name nowhere: not in a page, not in the data, not in the log", async () => {
    const view = (await (
      await big.associate.api("GET", `/api/matters/${big.ids.matterId}`)
    ).json()) as MatterView;
    const json = JSON.stringify(view);
    const page = await (await big.associate.get(urls.matter(big.ids.matterId))).text();
    const everything = `${json}\n${page}\n${big.site.logs.join("\n")}\n${big.site.w.logs.join("\n")}`;
    for (const marker of [
      "passwd",
      "system32",
      "victim",
      "alert(1)",
      "Set-Cookie",
      "other.exe",
      "%2e%2e",
    ])
      expect(everything, marker).not.toContain(marker);
  });

  it("refuses a name that is past a thousand characters, as a type it cannot read", async () => {
    const api = await expectUntouched(big, () =>
      viaApi(big, `${"a".repeat(1_200)}.txt`, amendment(300)),
    );
    expect(api.status).toBe(422);
    expect((await apiError(api)).message).toBe("Only .docx and .txt files can be uploaded.");
  });

  it("judges a hostile name by its last extension and refuses the ones that are not .docx or .txt", async () => {
    const expected: [string, number][] = [
      ["../../evil.sh", 422],
      ["evil.txt/", 422],
      ["evil.txt\u0000.exe", 422],
      ["evil.exe\n.txt", 201],
      ["evil.txt ", 201],
    ];
    let n = 320;
    for (const [name, status] of expected) {
      n += 1;
      expect((await viaApi(big, name, amendment(n))).status, JSON.stringify(name)).toBe(status);
    }
  });
});

describe("a file that is the same as one already there", () => {
  it("stores nothing a second time, and tells the person which it matched (page)", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const before = fingerprint(c.site);
    const files = storedFiles(c.site);
    const response = await viaPage(c, "amendment-again.txt", AMENDMENT.bytes);
    expect(response.status).toBe(303);
    const landed = await c.associate.page(response.headers.get("location")!);
    expect(landed.html).toContain("That file is the same as one already in the matter");
    // Nothing was stored again: the same files, and the same rows apart from the audit trail.
    expect(storedFiles(c.site)).toEqual(files);
    const after = fingerprint(c.site);
    expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 });
  });

  it("answers with the duplicate warning in the upload result (JSON), and 200 because nothing was created", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const response = await viaApi(c, "amendment-again.txt", AMENDMENT.bytes);
    // Not 201: no document, version or file was made, so a script need not read the warnings to
    // learn that it got nothing new.
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      documentId: string;
      versionId: string;
      warnings: { code: string; detail: string }[];
    };
    expect(result.versionId).toBe(c.ids.versionId);
    expect(result.warnings.map((w) => w.code)).toEqual(["duplicate_document"]);
    expect(result.warnings[0]!.detail).toBe("same file as D2 v1, not stored again");
  });

  it("answers 200 for a duplicate of a document or of a version, and 201 only for a file that was stored", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const rows = fingerprint(c.site);
    const files = storedFiles(c.site);
    const asDocument = await c.associate.apiUpload(
      `/api/matters/${c.ids.matterId}/documents`,
      { title: "Amendment No. 1 again", kind: "amendment" },
      { name: "amendment.txt", bytes: AMENDMENT.bytes },
    );
    expect(asDocument.status).toBe(200);
    expect(((await asDocument.json()) as { versionId: string }).versionId).toBe(c.ids.versionId);
    const asVersion = await viaApi(c, "amendment.txt", AMENDMENT.bytes);
    expect(asVersion.status).toBe(200);
    expect(((await asVersion.json()) as { versionId: string }).versionId).toBe(c.ids.versionId);
    expect({ ...fingerprint(c.site), audit: 0 }).toEqual({ ...rows, audit: 0 });
    expect(storedFiles(c.site)).toEqual(files);

    // A file that is stored is still 201.
    const stored = await viaApi(c, "amendment-corrected.txt", amendment(500));
    expect(stored.status).toBe(201);
    expect(fingerprint(c.site).versions).toBe(rows.versions! + 1);
  });

  it("warns that a file has the same text as an earlier version saved as a different file", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    // The same words with Windows line endings: a different file, the same paragraphs.
    const crlf = text(new TextDecoder().decode(AMENDMENT.bytes).replace(/\n/g, "\r\n"));
    const response = await viaApi(c, "amendment.txt", crlf);
    expect(response.status).toBe(201);
    const result = (await response.json()) as { warnings: { code: string }[] };
    expect(result.warnings.map((w) => w.code)).toContain("near_duplicate_version");

    const page = await viaPage(
      c,
      "amendment-2.txt",
      text(new TextDecoder().decode(AMENDMENT.bytes).replace(/\n/g, "\n \n")),
    );
    expect(page.status).toBe(303);
  });

  it("shows the near-duplicate notice on the page the upload lands on", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const crlf = text(new TextDecoder().decode(AMENDMENT.bytes).replace(/\n/g, "\r\n"));
    const response = await viaPage(c, "amendment.txt", crlf);
    const landed = await c.associate.page(response.headers.get("location")!);
    expect(landed.html).toContain("Its text is the same as an earlier version");
  });
});

describe("an upload that is not an upload", () => {
  const url = (c: Case): string =>
    `/api/matters/${c.ids.matterId}/documents/${c.ids.lastDocumentId}/versions`;

  it("refuses a request without the file, with something that is not a file in its place, or in the wrong field", async () => {
    const c = big;
    for (const body of [
      multipart([]),
      multipart([["file", "just text"]]),
      multipart([], { name: "a.txt", bytes: amendment(400), field: "upload" }),
    ]) {
      const response = await expectUntouched(c, async () =>
        c.associate.send("POST", url(c), {
          headers: { "x-csrf-token": await c.associate.apiToken() },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect((await apiError(response)).kind).toBe("invalid_request");
    }
  });

  it("refuses a url-encoded or JSON body where a multipart one is needed", async () => {
    const c = big;
    for (const [type, body] of [
      ["application/x-www-form-urlencoded", `file=${encodeURIComponent("text")}`],
      ["application/json", JSON.stringify({ file: "text" })],
    ] as const) {
      const response = await expectUntouched(c, async () =>
        c.associate.send("POST", url(c), {
          headers: { "content-type": type, "x-csrf-token": await c.associate.apiToken() },
          body,
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("refuses a second NDA, and an amendment before the NDA", async () => {
    const c = big;
    const token = await c.associate.apiToken();
    const second = await expectUntouched(c, () =>
      c.associate.send("POST", urls.documents(c.ids.matterId), {
        body: multipart(
          [
            ["_csrf", token],
            [FIELDS.title, "Another NDA"],
            [FIELDS.kind, "nda"],
          ],
          { name: "nda.docx", bytes: NDA.bytes },
        ),
      }),
    );
    expect(second.status).toBe(409);

    // A matter with no documents takes the NDA first.
    const empty = c.site.w.services.matters.create(c.site.w.associate, {
      name: "Empty",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const early = await expectUntouched(c, async () =>
      c.associate.apiUpload(
        `/api/matters/${empty.id}/documents`,
        { title: "Amendment No. 1", kind: "amendment" },
        { name: "amendment.txt", bytes: AMENDMENT.bytes },
      ),
    );
    expect(early.status).toBe(400);
  });
});

describe("what the page says when an uploaded version has been added", () => {
  const noticeOn = async (c: Case, response: Response): Promise<string> => {
    const landed = await c.associate.page(response.headers.get("location")!);
    return all(landed.root, (el) => hasClass(el, "notice"))
      .map(readable)
      .join(" ");
  };
  const versionsOf = async (c: Case): Promise<[number, boolean][]> => {
    const view = (await (
      await c.associate.api("GET", `/api/matters/${c.ids.matterId}`)
    ).json()) as MatterView;
    return view.documents
      .find((d) => d.documentId === c.ids.lastDocumentId)!
      .versions.map((v) => [v.versionNo, v.operative]);
  };

  it("says that a changed version is the operative one at once, because it is", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const response = await viaPage(c, "amendment-corrected.txt", amendment(600));
    expect(response.status).toBe(303);
    // The service made the new version operative and the review stale before any click.
    expect(await versionsOf(c)).toEqual([
      [1, false],
      [2, true],
    ]);
    const view = (await (
      await c.associate.api("GET", `/api/matters/${c.ids.matterId}`)
    ).json()) as MatterView;
    expect(view.matter.status).toBe("stale");

    const notice = await noticeOn(c, response);
    expect(notice).toContain("The new version was added and is now the operative one.");
    // It must not hand the person a choice they no longer have.
    expect(notice).not.toMatch(/choose/i);
  });

  it("does not say the new version governs when it was held back as a copy of the same text", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const crlf = text(new TextDecoder().decode(AMENDMENT.bytes).replace(/\n/g, "\r\n"));
    const response = await viaPage(c, "amendment-resaved.txt", crlf);
    expect(await versionsOf(c)).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(await noticeOn(c, response)).not.toContain("is now the operative one");
  });
});

describe("a refused upload form says why, on the matter's page", () => {
  /** The problem notices of the page a refused form is answered with. */
  async function refusedWith(
    response: Response,
    status: number,
  ): Promise<{ notices: string[]; html: string; actions: string[] }> {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    const root = parseHtml(html);
    return {
      html,
      notices: all(root, (el) => hasClass(el, "notice-error")).map(readable),
      actions: all(root, (el) => el.name === "form").map((f) => attr(f, "action") ?? ""),
    };
  }

  it("gives the advice of the parser for a file it could not read, as the JSON API does", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const api = await apiError(await viaApi(c, "contract.docx", amendment(700)));
    const rows = fingerprint(c.site);
    const files = storedFiles(c.site);
    const { notices, actions } = await refusedWith(
      await viaPage(c, "contract.docx", amendment(700)),
      422,
    );
    expect(notices).toEqual([`Problem ${api.message}`]);
    expect(notices[0]).toContain("could not be read as a Word document");
    // The matter's page again, with its forms, so the person can try another file.
    expect(actions).toContain(urls.versions(c.ids.matterId, c.ids.lastDocumentId));
    expect(fingerprint(c.site)).toEqual(rows);
    expect(storedFiles(c.site)).toEqual(files);
  });

  it("says which kinds of file can be uploaded, for a file of the wrong type", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const { notices } = await refusedWith(await viaPage(c, "contract.pdf", amendment(701)), 422);
    expect(notices).toEqual(["Problem Only .docx and .txt files can be uploaded."]);
  });

  it("says that a file is needed, and that a second NDA is not wanted, on the add-document form", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const page = await c.associate.page(urls.matter(c.ids.matterId));
    const none = await c.associate.upload(page, urls.documents(c.ids.matterId), undefined, {
      set: { [FIELDS.title]: "Amendment No. 2", [FIELDS.kind]: "amendment" },
    });
    expect((await refusedWith(none, 400)).notices).toEqual(["Problem Choose a file to upload."]);

    // The form offers no second NDA, so this one is posted by hand.
    const second = await c.associate.send("POST", urls.documents(c.ids.matterId), {
      body: multipart(
        [
          ["_csrf", await c.associate.apiToken()],
          [FIELDS.title, "Another NDA"],
          [FIELDS.kind, "nda"],
        ],
        { name: "nda.docx", bytes: NDA.bytes },
      ),
    });
    expect((await refusedWith(second, 409)).notices).toEqual([
      "Problem The matter already has an NDA.",
    ]);
  });

  it("prints nothing the request carried, whatever the file was called or the title said", async () => {
    const c = await caseWith(10 * 1024 * 1024);
    const page = await c.associate.page(urls.matter(c.ids.matterId));
    const title = "Title-with-a-marker-9f3a";
    const name = "name-with-a-marker-9f3a.pdf";
    const { html } = await refusedWith(
      await c.associate.upload(
        page,
        urls.documents(c.ids.matterId),
        { name, bytes: amendment(702) },
        { set: { [FIELDS.title]: title, [FIELDS.kind]: "amendment" } },
      ),
      422,
    );
    expect(html).not.toContain("9f3a");
  });

  it("leaves a file that is too large to the shell, which answers 413 and nothing else", async () => {
    const bytes = new Uint8Array(30_000).fill(0x61);
    const response = await viaPage(small, "large.txt", bytes);
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain("notice-error");
  });
});
