import { defineConfig } from "drizzle-kit";

// Used only by `pnpm exec drizzle-kit generate`, which reads the schema and writes SQL. It needs
// no database. The server applies the committed files itself at start, so there is no URL here.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
