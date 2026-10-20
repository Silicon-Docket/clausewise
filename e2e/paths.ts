import { join } from "node:path";

/** The repository root. Everything the end to end run reads from the repository starts here. */
export const REPO_ROOT = join(import.meta.dirname, "..");

/** The built web app, which the servers under test serve. */
export const WEB_DIR = join(REPO_ROOT, "apps", "web", "dist");

/** The playbooks that ship with the repository, which are the built-in ones. */
export const PLAYBOOKS_DIR = join(REPO_ROOT, "playbooks");

export const fixturePath = (name: string): string => join(REPO_ROOT, "fixtures", name);
