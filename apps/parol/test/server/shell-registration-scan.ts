import { relative } from "node:path";
import ts from "typescript";
import { SRC_ROOT } from "../auth/brand-types.js";

/**
 * Finds the places in the source that register a route on a Hono application directly (`app.get`,
 * `app.post`, `app.on`, ...) and not through `defineRoute` or `defineMatterRoute`.
 *
 * The route-coverage tests look at the application they are given, so they only see routes that
 * something has added to it. This reads the source instead, so a route registered in a module the
 * tests were never pointed at is still found, and the rule does not depend on what the next phase
 * names its files. It asks the compiler which method is meant, so `c.get("key")` on a context or
 * `map.get(key)` is not mistaken for a route.
 */

const VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "on",
  "options",
]);
const HONO_CLASSES: ReadonlySet<string> = new Set(["Hono", "HonoBase"]);

export interface RegistrationFinding {
  file: string;
  line: number;
  method: string;
}

export function findDirectRouteRegistrations(
  program: ts.Program,
  allowed: ReadonlySet<string>,
): RegistrationFinding[] {
  const checker = program.getTypeChecker();
  const findings: RegistrationFinding[] = [];
  for (const source of program.getSourceFiles()) {
    const file = relative(SRC_ROOT, source.fileName).split("\\").join("/");
    if (file.startsWith("..") || allowed.has(file)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        VERBS.has(node.expression.name.text)
      ) {
        const symbol = checker.getSymbolAtLocation(node.expression.name);
        const declaredOnHono = (symbol?.declarations ?? []).some(
          (d) =>
            ts.isClassLike(d.parent) &&
            d.parent.name !== undefined &&
            HONO_CLASSES.has(d.parent.name.text),
        );
        if (declaredOnHono)
          findings.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            method: node.expression.name.text,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
