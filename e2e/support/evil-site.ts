import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A second web site on another port of this machine, standing in for any page the lawyer might
 * have open in another tab. It serves the pages it is given and nothing else, with none of the
 * protections Clausewise has, so a page here is as free as a page on the internet is.
 */
export interface OtherSite {
  /** The address of the site, such as `http://127.0.0.1:41234`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startOtherSite(pages: Record<string, string>): Promise<OtherSite> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const body = pages[path];
    if (body === undefined) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not here");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * What the other site's page tries against the Clausewise server at `target`. Every attempt is
 * wrapped, because a refused request is the expected outcome and must not stop the next try. The
 * page records what it could see in `window.results` and sets `window.finished` when it is done.
 *
 * The attempts are those a hostile page can make without the lawyer doing anything: requests
 * without a preflight (a multipart or plain text POST in no-cors mode, with and without
 * credentials), requests that need one (DELETE, PATCH with JSON), reading an answer, and a form
 * that submits itself. `documentId` and `reviewId` name things that exist, so that a request that
 * got through would have something to change.
 */
export function attackPage(args: {
  target: string;
  documentId: string;
  reviewId: string;
  docxBase64: string;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A page on another site</title></head>
<body>
<h1>Nothing to see here</h1>
<iframe name="sink-one" title="sink one" width="300" height="100"></iframe>
<iframe name="sink-two" title="sink two" width="300" height="100"></iframe>
<iframe id="framed" title="framed" src="${args.target}/" width="600" height="300"></iframe>
<script>
(function () {
  var TARGET = ${JSON.stringify(args.target)};
  var DOCUMENT_ID = ${JSON.stringify(args.documentId)};
  var REVIEW_ID = ${JSON.stringify(args.reviewId)};
  var BYTES = Uint8Array.from(atob(${JSON.stringify(args.docxBase64)}), function (c) { return c.charCodeAt(0); });
  window.results = {};
  window.finished = false;

  function note(name, run) {
    return Promise.resolve().then(run).then(
      function (value) { window.results[name] = { outcome: "returned", value: value }; },
      function (error) { window.results[name] = { outcome: "threw", error: String(error && error.name || error) }; }
    );
  }
  function upload(extra) {
    var form = new FormData();
    form.append("file", new File([BYTES], "stolen.docx"));
    return fetch(TARGET + "/api/documents", Object.assign({ method: "POST", body: form }, extra));
  }

  note("no-cors multipart upload", function () {
    return upload({ mode: "no-cors" }).then(function (r) { return r.type; });
  })
  .then(function () { return note("no-cors multipart upload with credentials", function () {
    return upload({ mode: "no-cors", credentials: "include" }).then(function (r) { return r.type; });
  }); })
  .then(function () { return note("no-cors text/plain review", function () {
    return fetch(TARGET + "/api/reviews", {
      method: "POST", mode: "no-cors", credentials: "include",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ documentId: DOCUMENT_ID, playbookId: "builtin:nda-mutual" })
    }).then(function (r) { return r.type; });
  }); })
  .then(function () { return note("no-cors form-encoded review", function () {
    return fetch(TARGET + "/api/reviews", {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "documentId=" + DOCUMENT_ID + "&playbookId=builtin:nda-mutual"
    }).then(function (r) { return r.type; });
  }); })
  .then(function () { return note("read the review list", function () {
    return fetch(TARGET + "/api/reviews").then(function (r) { return r.text(); });
  }); })
  .then(function () { return note("read the configuration", function () {
    return fetch(TARGET + "/api/config", { credentials: "include" }).then(function (r) { return r.text(); });
  }); })
  .then(function () { return note("read in no-cors mode", function () {
    return fetch(TARGET + "/api/documents", { mode: "no-cors" }).then(function (r) {
      return r.text().then(function (text) { return { type: r.type, status: r.status, length: text.length }; });
    });
  }); })
  .then(function () { return note("delete the document", function () {
    return fetch(TARGET + "/api/documents/" + DOCUMENT_ID, { method: "DELETE" }).then(function (r) { return r.status; });
  }); })
  .then(function () { return note("accept a finding", function () {
    return fetch(TARGET + "/api/reviews/" + REVIEW_ID + "/findings/term", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accepted" })
    }).then(function (r) { return r.status; });
  }); })
  .then(function () { return note("accept everything", function () {
    return fetch(TARGET + "/api/reviews/" + REVIEW_ID + "/findings", {
      method: "PATCH", mode: "no-cors", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ decision: "accepted" })
    }).then(function (r) { return r.type; });
  }); })
  .then(function () { return note("a form that posts the file", function () {
    var form = document.createElement("form");
    form.method = "POST"; form.action = TARGET + "/api/documents";
    form.enctype = "multipart/form-data"; form.target = "sink-one";
    var input = document.createElement("input");
    input.type = "file"; input.name = "file";
    var transfer = new DataTransfer();
    transfer.items.add(new File([BYTES], "stolen-by-form.docx"));
    input.files = transfer.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    return "submitted";
  }); })
  .then(function () { return note("a form with a plain text body", function () {
    var form = document.createElement("form");
    form.method = "POST"; form.action = TARGET + "/api/reviews";
    form.enctype = "text/plain"; form.target = "sink-two";
    var input = document.createElement("input");
    input.type = "hidden"; input.name = '{"documentId":"' + DOCUMENT_ID + '","playbookId":"builtin:nda-mutual","x":"'; input.value = '"}';
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    return "submitted";
  }); })
  .then(function () { return new Promise(function (resolve) { setTimeout(resolve, 800); }); })
  .then(function () { window.finished = true; });
})();
</script>
</body></html>`;
}
