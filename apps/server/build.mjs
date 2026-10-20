// Packages the server for a container image. Three steps, each a command of this file:
//
//   node build.mjs                  Bundles src/main.ts into dist/main.mjs, with the migration files
//                                   it applies at start (dist/drizzle) and the licence notices of
//                                   the packages inlined in it. `pnpm build` runs this one.
//   node build.mjs prune <folder>   Cuts a `pnpm deploy` folder down to what the bundle still
//                                   loads at run time: PGlite, pg and what those two depend on.
//   node build.mjs check <folder>   Starts the bundle in <folder> the way the image does and
//                                   checks that it answers and stops on SIGTERM.
//
// To run the bundle by hand: `node dist/main.mjs`, with node_modules next to dist (or above it)
// that hold PGlite and pg, and with the web app and playbooks folders set in the environment.
import { spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { cp, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");

// Packages that cannot be inlined. PGlite reads its WebAssembly and data files from the folder
// where its own code lives, and pg looks for an optional native add-on by name when it is used.
// Everything else the bundle needs is in the bundle. The check after the build refuses a result
// that imports any other package, because the image would then fail on its first start.
const EXTERNAL = ["@electric-sql/pglite", "pg"];

// Some of the inlined packages (jszip through readable-stream, for one) are CommonJS and ask for
// Node's own modules with require(), which an ES module does not have. This gives the bundle one.
// The name is chosen so that it cannot clash with a name in the code that is inlined.
const REQUIRE_BANNER = [
  'import { createRequire as __clausewiseCreateRequire } from "node:module";',
  "const require = __clausewiseCreateRequire(import.meta.url);",
].join("\n");

// ---------------------------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------------------------

function isAllowedImport(path) {
  if (path.startsWith("node:") || builtinModules.includes(path)) return true;
  return EXTERNAL.some((name) => path === name || path.startsWith(`${name}/`));
}

// The folder of every package that was inlined, from the file paths the bundler reports. Under
// pnpm a path looks like node_modules/.pnpm/<id>/node_modules/@scope/name/dist/index.js, so the
// last node_modules in it is the one that counts.
function inlinedPackageFolders(inputs) {
  const folders = new Set();
  for (const path of Object.keys(inputs)) {
    const marker = path.lastIndexOf("node_modules/");
    if (marker < 0) continue;
    const parts = path.slice(marker + "node_modules/".length).split("/");
    const nameParts = parts[0].startsWith("@") ? 2 : 1;
    folders.add(join(here, path.slice(0, marker), "node_modules", ...parts.slice(0, nameParts)));
  }
  return [...folders].sort();
}

// The licences of the inlined packages ask for their notice to travel with copies. A package that
// is installed next to the bundle brings its own; the ones inside the bundle are written here.
async function licenceNotices(folders) {
  const entries = [];
  for (const folder of folders) {
    const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    const files = (await readdir(folder)).filter((name) =>
      /^(licen[cs]e|notice)(\.|$)/i.test(name),
    );
    let texts = "";
    for (const name of files.sort()) {
      texts += `${(await readFile(join(folder, name), "utf8")).trim()}\n\n`;
    }
    const licence = typeof manifest.license === "string" ? manifest.license : "not stated";
    if (texts === "") {
      texts = `(No licence file in the package. Its package.json says: ${licence}.)\n\n`;
    }
    const rule = "=".repeat(78);
    entries.push(`${rule}\n${manifest.name} ${manifest.version} (${licence})\n${rule}\n\n${texts}`);
  }
  return (
    "The server bundle (main.mjs) contains the following packages. Their licence notices follow.\n\n" +
    entries.join("")
  );
}

async function bundle() {
  // A bundle from an earlier run must not survive a build that fails or no longer writes it.
  await rm(dist, { recursive: true, force: true });

  const result = await build({
    absWorkingDir: here,
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: EXTERNAL,
    banner: { js: REQUIRE_BANNER },
    metafile: true,
    logLevel: "warning",
  });
  if (result.warnings.length > 0) {
    throw new Error(`The bundle was built with ${result.warnings.length} warning(s). Fix them.`);
  }

  const output = Object.values(result.metafile.outputs).find((entry) => entry.entryPoint);
  const stray = new Set(
    (output?.imports ?? []).map((entry) => entry.path).filter((path) => !isAllowedImport(path)),
  );
  if (stray.size > 0) {
    throw new Error(
      `The bundle imports packages that are not installed next to it: ${[...stray].join(", ")}. Add them to EXTERNAL in build.mjs only if the image installs them.`,
    );
  }

  await writeFile(
    join(dist, "THIRD-PARTY-LICENSES.txt"),
    await licenceNotices(inlinedPackageFolders(result.metafile.inputs)),
  );

  // The server looks for its migrations in a folder called drizzle next to the bundle.
  await cp(join(here, "drizzle"), join(dist, "drizzle"), { recursive: true });
  await stat(join(dist, "drizzle", "meta", "_journal.json"));

  const { size } = await stat(join(dist, "main.mjs"));
  process.stdout.write(`Built dist/main.mjs (${Math.round(size / 1024)} KiB)\n`);
}

// ---------------------------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------------------------

async function removeAll(...paths) {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

// The packages in a folder of the virtual store, with the members of a scope folder listed one
// by one.
async function packagePaths(folder) {
  const paths = [];
  for (const name of await readdir(folder)) {
    if (name.startsWith("@")) {
      for (const member of await readdir(join(folder, name)))
        paths.push(join(folder, name, member));
    } else {
      paths.push(join(folder, name));
    }
  }
  return paths;
}

// `pnpm deploy` leaves every production dependency of the server in <folder>/node_modules, laid
// out the way pnpm does: each package in node_modules/.pnpm/<id>/node_modules/<name>, next to links
// to the packages it depends on. Most of that is now inside the bundle, and the workspace packages
// come with their sources and tests. What the bundle loads at run time is the packages in EXTERNAL
// and whatever they reach through those links, so that is what stays.
async function prune(folder) {
  const modules = join(resolve(folder), "node_modules");
  const store = join(modules, ".pnpm");
  const keep = new Set();

  const visit = async (real) => {
    const inside = relative(store, real);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("A dependency is linked from outside the deployed folder.");
    }
    const id = inside.split(sep)[0];
    if (keep.has(id)) return;
    keep.add(id);
    for (const path of await packagePaths(join(store, id, "node_modules"))) {
      await visit(await realpath(path));
    }
  };
  for (const name of EXTERNAL) await visit(await realpath(join(modules, name)));

  // The virtual store's own lock file and the hoisted links go with it: they describe, and point
  // at, packages that are no longer there.
  for (const entry of await readdir(store)) {
    if (!keep.has(entry)) await removeAll(join(store, entry));
  }
  for (const entry of await readdir(modules)) {
    if (entry === ".pnpm") continue;
    if (entry.startsWith("@")) {
      for (const member of await readdir(join(modules, entry))) {
        if (!EXTERNAL.includes(`${entry}/${member}`)) await removeAll(join(modules, entry, member));
      }
      if ((await readdir(join(modules, entry))).length === 0) await removeAll(join(modules, entry));
    } else if (!EXTERNAL.includes(entry)) {
      await removeAll(join(modules, entry));
    }
  }

  // Both must still load from where the bundle will look for them.
  const needs = createRequire(join(modules, "x.cjs"));
  needs("pg");
  await import(pathToFileURL(needs.resolve("@electric-sql/pglite")).href);

  process.stdout.write(`Kept ${keep.size} packages in ${modules}\n`);
}

// ---------------------------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------------------------

const CHECK_START_MS = 60_000;
const CHECK_STOP_MS = 20_000;

// Starts dist/main.mjs of <folder> with the settings the image makes, on a free port and with a
// data folder of its own, and asks it the questions a health check would. It runs with nothing of
// the caller's environment, so no key or database address of the machine reaches it.
async function check(folder) {
  const app = resolve(folder);
  const data = await mkdtemp(join(tmpdir(), "clausewise-check-"));
  const child = spawn(process.execPath, ["dist/main.mjs"], {
    cwd: app,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      CLAUSEWISE_DATA_DIR: data,
      CLAUSEWISE_PLAYBOOKS_DIR: join(app, "playbooks"),
      CLAUSEWISE_WEB_DIR: join(app, "web"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const fail = (message) => new Error(`${message}\n--- output of the server ---\n${output}`);

  try {
    const url = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(fail("The server did not start in time.")),
        CHECK_START_MS,
      );
      const watch = setInterval(() => {
        const line = output.split("\n").find((l) => l.includes('"Clausewise is running"'));
        if (line === undefined) return;
        clearTimeout(timer);
        clearInterval(watch);
        done(JSON.parse(line).url);
      }, 50);
      void exited.then(({ code }) => {
        clearTimeout(timer);
        clearInterval(watch);
        reject(fail(`The server ended with code ${code} before it was running.`));
      });
    });

    const health = await fetch(`${url}/healthz`);
    if (health.status !== 200 || (await health.text()) !== '{"ok":true}') {
      throw fail('GET /healthz did not answer {"ok":true}.');
    }
    const config = await fetch(`${url}/api/config`);
    const body = await config.json();
    if (config.status !== 200 || typeof body.version !== "string") {
      throw fail("GET /api/config did not answer with a version.");
    }
    const page = await fetch(`${url}/`);
    const policy = page.headers.get("content-security-policy") ?? "";
    if (
      page.status !== 200 ||
      !(page.headers.get("content-type") ?? "").startsWith("text/html") ||
      !policy.includes("default-src 'self'")
    ) {
      throw fail("GET / did not answer with the web app and its content security policy.");
    }
    const playbooks = await fetch(`${url}/api/playbooks`);
    const list = await playbooks.json();
    if (playbooks.status !== 200 || !Array.isArray(list.playbooks) || list.playbooks.length === 0) {
      throw fail("GET /api/playbooks listed no built-in playbook.");
    }

    child.kill("SIGTERM");
    const ended = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done(undefined), CHECK_STOP_MS)),
    ]);
    if (ended === undefined) throw fail("The server did not stop within 20 seconds of SIGTERM.");
    if (ended.code !== 0) throw fail(`The server stopped with code ${ended.code} after SIGTERM.`);
    process.stdout.write(`Checked ${url}: healthz, config, web app, playbooks, stop on SIGTERM\n`);
  } finally {
    child.kill("SIGKILL");
    await removeAll(data);
  }
}

// ---------------------------------------------------------------------------------------------

const [command = "build", argument] = process.argv.slice(2);
const commands = {
  build: () => bundle(),
  prune: () => prune(argument),
  check: () => check(argument),
};

try {
  const run = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (run === undefined || (command !== "build" && !argument)) {
    throw new Error("Usage: node build.mjs [prune <folder> | check <folder>]");
  }
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(1);
}
