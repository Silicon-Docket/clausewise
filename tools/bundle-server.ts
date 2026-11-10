// Builds what the server image runs, into one folder that the image copies whole:
//
//   server.mjs                    chooses web (the default), worker or migrate
//   apps/web/dist/main.mjs        the web app, with apps/web/public beside it
//   apps/worker/dist/worker.mjs   the worker
//   apps/worker/dist/migrate.mjs  the migrate job
//   playbooks/                    the playbooks
//   THIRD_PARTY_NOTICES.txt       the licence of every package the bundles include
//
// Each bundle sits at the same depth as its source, so the paths the code finds relative to
// itself (the page's files, the playbooks) resolve as they do from the source. The browser's
// MSAL file is served as it ships, from where the web app looks for it.
//
// Usage: pnpm bundle:server [folder]   (default dist/server)
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.argv[2] ?? "dist/server");

// Licences that let the bundles be published under Apache-2.0 with a notice. Anything else stops
// the build until someone has looked at it.
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "(MIT AND Zlib)",
  "(MIT OR GPL-3.0-or-later)",
  "Unlicense",
]);

const ENTRIES = [
  { in: "apps/web/src/main.ts", out: "apps/web/dist/main" },
  { in: "apps/worker/src/main.ts", out: "apps/worker/dist/worker" },
  { in: "apps/worker/src/migrate-main.ts", out: "apps/worker/dist/migrate" },
];

const DISPATCH = `// Chooses what this image runs: web (the default), worker or migrate.
const entries = {
  web: "./apps/web/dist/main.mjs",
  worker: "./apps/worker/dist/worker.mjs",
  migrate: "./apps/worker/dist/migrate.mjs",
};
const name = process.argv[2] ?? "web";
if (!Object.hasOwn(entries, name)) {
  process.stderr.write("Give one command: web, worker or migrate.\\n");
  process.exit(64);
}
await import(entries[name]);
`;

interface Package {
  name: string;
  version: string;
  license: string;
  dir: string;
}

async function packageAt(dir: string): Promise<Package> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    license?: string;
  };
  return {
    name: manifest.name ?? relative(root, dir),
    version: manifest.version ?? "unknown",
    license: manifest.license ?? "none stated",
    dir,
  };
}

// The package an input file belongs to: the folder after its last node_modules.
function packageDir(input: string): string | undefined {
  const parts = input.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return undefined;
  const scoped = parts[at + 1]?.startsWith("@") === true;
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}

async function licenceText(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir)).filter((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  if (names.length === 0) return undefined;
  const texts = await Promise.all(names.sort().map((name) => readFile(join(dir, name), "utf8")));
  return texts.join("\n").trim();
}

await rm(out, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ENTRIES,
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Bundled CommonJS packages call require for Node's own modules, which an ES module lacks.
  banner: {
    js: "import { createRequire as __clausewiseRequire } from 'node:module';\nconst require = __clausewiseRequire(import.meta.url);",
  },
  // pg loads its native driver only if asked to, and it is never asked.
  external: ["pg-native"],
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const dirs = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const dir = packageDir(input);
  if (dir !== undefined) dirs.add(resolve(root, dir));
}
const msal = dirname(
  createRequire(join(root, "apps/web/package.json")).resolve("@azure/msal-browser/package.json"),
);
dirs.add(msal);

const packages = (await Promise.all([...dirs].map(packageAt))).sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const refused = packages.filter((pkg) => !PERMISSIVE.has(pkg.license));
if (refused.length > 0) {
  throw new Error(
    `Licences not yet reviewed for the image: ${refused.map((pkg) => `${pkg.name}@${pkg.version} (${pkg.license})`).join(", ")}.`,
  );
}

const notices = [
  "Clausewise is licensed under the Apache License 2.0; see LICENSE and NOTICE.",
  "This image also contains the following packages, under their own licences.",
];
for (const pkg of packages) {
  const text = await licenceText(pkg.dir);
  notices.push(
    "-".repeat(78),
    `${pkg.name} ${pkg.version} (${pkg.license})`,
    "",
    text ?? `The package ships no licence file. Its package.json states: ${pkg.license}.`,
  );
}

const msalOut = join(out, "apps/web/node_modules/@azure/msal-browser");
await mkdir(join(msalOut, "lib"), { recursive: true });
await Promise.all([
  cp(join(msal, "package.json"), join(msalOut, "package.json")),
  cp(join(msal, "LICENSE"), join(msalOut, "LICENSE")),
  cp(join(msal, "lib/msal-browser.min.js"), join(msalOut, "lib/msal-browser.min.js")),
  cp(join(root, "apps/web/public"), join(out, "apps/web/public"), { recursive: true }),
  cp(join(root, "playbooks"), join(out, "playbooks"), { recursive: true }),
  cp(join(root, "LICENSE"), join(out, "LICENSE")),
  cp(join(root, "NOTICE"), join(out, "NOTICE")),
  writeFile(join(out, "server.mjs"), DISPATCH),
  writeFile(join(out, "THIRD_PARTY_NOTICES.txt"), `${notices.join("\n")}\n`),
]);

process.stderr.write(
  `Bundled ${ENTRIES.length} entry points and ${packages.length} packages into ${relative(root, out) || "."}.\n`,
);
