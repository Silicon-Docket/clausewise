// Raw .docx files built from XML, so that a test can contain any construct Word can write.
import JSZip from "jszip";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { reviewContract, type ReviewReport } from "@clausewise/review";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { checkIntegrity, type IntegrityResult } from "../src/integrity.js";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const ROOT = new URL("../..", import.meta.url).pathname;

export const doc = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;

export async function buildDocx(
  documentXml: string,
  extra: Record<string, string> = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );
  zip.file("word/document.xml", documentXml);
  for (const [path, content] of Object.entries(extra)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export const run = (text: string, rPr = ""): string =>
  `<w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const para = (inner: string, pPr = ""): string =>
  `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
export const text = (t: string, pPr = ""): string => para(run(t), pPr);

export async function editedReview(
  docx: Uint8Array,
  edit: { clauseId: string; quote: string; replacement: string },
  ruleId = "mutuality",
): Promise<{ report: ReviewReport; redlined: Uint8Array }> {
  const playbook = await loadPlaybookFile(`${ROOT}playbooks/nda-mutual.yaml`);
  const generator = createScriptedGenerator((request) => {
    const id = /^Rule ID: (.+)$/m.exec(
      request.prompt.slice(request.prompt.lastIndexOf("</contract>")),
    )?.[1];
    if (id === ruleId) {
      return {
        status: "deviation",
        clauseIds: [edit.clauseId],
        explanation: "e",
        comment: "c",
        edit,
        suggestedClause: null,
      };
    }
    return {
      status: "compliant",
      clauseIds: [],
      explanation: "",
      comment: "",
      edit: null,
      suggestedClause: null,
    };
  });
  return reviewContract({ docx, playbook, fileName: "lab.docx" }, generator);
}

export async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return await zip.file("word/document.xml")!.async("string");
}

export async function mutate(
  bytes: Uint8Array,
  change: (xml: string) => string,
  part = "word/document.xml",
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file(part)!.async("string");
  const changed = change(xml);
  if (changed === xml) throw new Error(`mutation did not change ${part}`);
  zip.file(part, changed);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function check(
  original: Uint8Array,
  redlined: Uint8Array,
  report: ReviewReport,
): Promise<IntegrityResult> {
  return checkIntegrity({ original, redlined, report });
}
