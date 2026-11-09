import type { BlobStore } from "@clausewise/service";
import {
  normalizeEndpoint,
  storageRequest,
  unexpected,
  type StorageClientOptions,
} from "./rest.js";

// Azure's own rule for container names, checked before anything is sent.
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * One Blob Storage container as a BlobStore, signed in with the app's managed identity. The keys
 * the service uses ("<review id>/contract.docx") become blob names with their slashes kept.
 */
export function azureBlobStore(options: StorageClientOptions & { container: string }): BlobStore {
  const endpoint = normalizeEndpoint(options.endpoint, "The blob endpoint");
  if (!CONTAINER.test(options.container)) {
    throw new Error("The container name is not a valid Azure Blob Storage container name.");
  }
  const client = { ...options, endpoint };
  const blobUrl = (key: string) =>
    new URL(`${endpoint}${options.container}/${key.split("/").map(encodeURIComponent).join("/")}`);

  return {
    async put(key, data) {
      const operation = "Storing a file";
      const response = await storageRequest(client, operation, blobUrl(key), {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "content-type": "application/octet-stream",
        },
        body: data,
      });
      if (response.status !== 201) throw await unexpected(operation, response);
      await response.body?.cancel().catch(() => undefined);
    },

    async get(key) {
      const operation = "Reading a file";
      const response = await storageRequest(client, operation, blobUrl(key), { method: "GET" });
      // Only a missing blob means "no such file". A missing container is a broken deployment,
      // and is reported as one.
      if (response.status === 404 && response.headers.get("x-ms-error-code") === "BlobNotFound") {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (response.status !== 200) throw await unexpected(operation, response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
