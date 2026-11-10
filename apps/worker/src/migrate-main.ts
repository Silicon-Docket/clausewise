import { SettingsError } from "@clausewise/azure";
import { runMigrate } from "./migrate.js";

try {
  const applied = await runMigrate({ env: process.env });
  process.stderr.write(
    applied.length === 0
      ? "The database was already up to date. Roles and grants are in place.\n"
      : `Applied migrations ${applied.join(", ")}. Roles and grants are in place.\n`,
  );
} catch (error) {
  // Only settings errors are written in full: a database error can quote a statement.
  process.stderr.write(
    error instanceof SettingsError
      ? `${error.message}\n`
      : `The migration failed (${error instanceof Error ? error.name : "unknown"}).\n`,
  );
  process.exit(1);
}
