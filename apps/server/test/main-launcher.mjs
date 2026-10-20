// Starts src/main.ts the way `pnpm start` does, from TypeScript source, for the test of the
// process itself. tsx is loaded from this file's place in the project and not from the folder the
// process runs in, and no tsconfig.json is read from there.
import { register } from "tsx/esm/api";

register({ tsconfig: false });
await import("../src/main.ts");
