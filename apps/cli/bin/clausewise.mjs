#!/usr/bin/env node
// The command runs from TypeScript source for now. tsx is loaded from this file's own place in
// the project, never from the folder the command is started in: "node --import tsx" looks for it
// there, so a node_modules/tsx next to the contracts being reviewed would run in its place. For
// the same reason no tsconfig.json is read from that folder.
import { register } from "tsx/esm/api";

register({ tsconfig: false });
await import("../src/bin.ts");
