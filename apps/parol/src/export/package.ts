import JSZip from "jszip";

/** The earliest date a zip entry can carry. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1);

/**
 * Makes the file a pure function of the memo's content. The docx library stamps the core
 * properties and every zip entry with the clock, so two exports of one memo would differ and the
 * file hash stored with a memo would say nothing. Here both take the export date the caller gave.
 */
export async function pinTimestamps(bytes: Uint8Array, at: Date): Promise<Uint8Array> {
  const stamp = new Date(Math.max(at.getTime(), ZIP_EPOCH));
  const w3c = stamp.toISOString().replace(/\.\d{3}Z$/, "Z");
  const source = await JSZip.loadAsync(bytes);
  const target = new JSZip();
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name];
    if (entry === undefined) continue;
    if (entry.dir) {
      target.file(name, "", { dir: true, date: stamp, createFolders: false });
      continue;
    }
    if (name === "docProps/core.xml") {
      const xml = (await entry.async("string"))
        .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${w3c}$2`)
        .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${w3c}$2`);
      target.file(name, xml, { date: stamp, createFolders: false });
      continue;
    }
    target.file(name, await entry.async("uint8array"), { date: stamp, createFolders: false });
  }
  return target.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
}
