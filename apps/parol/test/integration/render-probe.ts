import { renderErrorPage } from "../../src/server/pages/index.js";

/**
 * Prints a page. layers.test.ts runs this the way the root `parol` script runs the server, to show
 * that a page renders under that command: tsx takes its JSX settings from the tsconfig it is told
 * of, and from the working directory when it is told of none, and the repository root has none.
 */
process.stdout.write(renderErrorPage(404, "Page not found"));
