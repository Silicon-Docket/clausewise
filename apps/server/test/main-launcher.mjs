// Starts src/main.ts the way `pnpm start` does, from TypeScript source, for the test of the
// process itself. tsx is loaded from this file's place in the project and not from the folder the
// process runs in, and no tsconfig.json is read from there.
import { register } from "tsx/esm/api";

// Two ways to make the process fail, for the test of what it does with an error nobody caught. The
// error says words of a contract, which must not reach the output.
process.on("SIGUSR2", () => {
  Promise.reject(new Error("the Recipient shall pay a penalty of one million dollars"));
});
process.on("SIGHUP", () => {
  setTimeout(() => {
    throw new Error("the Recipient shall pay a penalty of one million dollars");
  });
});

register({ tsconfig: false });
await import("../src/main.ts");
