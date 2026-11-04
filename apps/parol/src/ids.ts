import { randomBytes } from "node:crypto";

/** A short random id with a readable prefix, such as `mat_3f9c1a2b7d4e5f60`. */
export function newId(prefix: string): string {
  if (!/^[a-z]{2,6}$/.test(prefix)) throw new Error(`bad id prefix "${prefix}"`);
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
