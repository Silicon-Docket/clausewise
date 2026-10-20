// Run by engine-package.test.ts in a process of its own, so that the peak memory it reports is the
// peak of reading the file and nothing else.
import { DocxError, parseDocx } from "../src/index.js";
import { craftZip, deflateZeros, utf8 } from "./engine-support.js";

const mode = process.argv[2];
const total = Number(process.argv[3]);

const packed = await deflateZeros(total);
const zip = craftZip([
  { name: "[Content_Types].xml", data: utf8("<Types/>") },
  { name: "word/document.xml", packed, ...(mode === "forged" ? { claimedSize: 1000 } : {}) },
]);

const started = performance.now();
let error = "";
try {
  await parseDocx(zip);
} catch (e) {
  error = e instanceof DocxError ? e.message : `unexpected: ${e instanceof Error ? e.name : "?"}`;
}
console.log(
  JSON.stringify({
    error,
    ms: Math.round(performance.now() - started),
    zipBytes: zip.length,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }),
);
