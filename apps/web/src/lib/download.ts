/**
 * Hands a file the app fetched itself to the browser as a download. This is the path taken when an
 * access token is needed: a plain link cannot carry the Authorization header, so the file is
 * fetched with it and saved from memory. The object URL is revoked once the browser has had time
 * to start the download.
 */

/** How long the object URL stays valid. Browsers read the blob when the click is handled. */
export const REVOKE_AFTER_MS = 10_000;

export type SaveFile = (blob: Blob, fileName: string) => void;

export const saveBlob: SaveFile = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, REVOKE_AFTER_MS);
  }
};
