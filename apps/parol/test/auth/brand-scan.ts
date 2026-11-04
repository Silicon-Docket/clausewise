import ts from "typescript";

/**
 * Finds the places in a source file that make an `AuthorizedMatter` other than by calling
 * `authorizeMatter` or `authorizeMatterDelete`.
 *
 * The type is branded with a symbol that only src/auth/types.ts can name, so ordinary code cannot
 * build one and still compile. What can get around that is a cast, a generic helper that casts for
 * you, a value that arrives as `any`, or an object written with the shape of one. This scan reads
 * the syntax tree (not the text, so a comment that mentions a cast is not a finding) and reports
 * each of those. It sees only the words `AuthorizedMatter`; a cast through a type alias, a spread,
 * `Object.assign` or an `any` value is found by the type-aware half, brand-types.ts.
 */

export interface BrandFinding {
  line: number;
  rule: string;
}

const NAME = "AuthorizedMatter";
/** Calls that return `any` from outside the type system. */
const LAUNDERERS = /^(?:JSON\.parse|Object\.assign|Object\.create|structuredClone)$/;

function mentionsBrand(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(n)) {
      const name = n.typeName;
      const last = ts.isIdentifier(name) ? name.text : name.right.text;
      if (last === NAME) found = true;
    } else if (ts.isImportTypeNode(n) && n.qualifier !== undefined) {
      const text = n.qualifier.getText();
      if (text === NAME || text.endsWith(`.${NAME}`)) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current))
    current = current.expression;
  return current;
}

function calleeName(call: ts.CallExpression): string {
  return call.expression.getText();
}

const propertyNames = (literal: ts.ObjectLiteralExpression): Set<string> =>
  new Set(
    literal.properties.flatMap((p) =>
      p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        ? [p.name.text]
        : [],
    ),
  );

export function findBrandForgeries(fileName: string, text: string): BrandFinding[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const findings: BrandFinding[] = [];
  const report = (node: ts.Node, rule: string): void => {
    findings.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, rule });
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && mentionsBrand(node.type))
      report(node, "cast to AuthorizedMatter");
    if (ts.isSatisfiesExpression(node) && mentionsBrand(node.type))
      report(node, "satisfies AuthorizedMatter");
    if (
      ts.isCallExpression(node) &&
      node.typeArguments !== undefined &&
      node.typeArguments.some(mentionsBrand)
    )
      report(node, "generic call that returns AuthorizedMatter");
    if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      mentionsBrand(node.type) &&
      node.initializer !== undefined
    ) {
      const init = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(init))
        report(node, "AuthorizedMatter built from an object literal");
      else if (ts.isCallExpression(init) && LAUNDERERS.test(calleeName(init)))
        report(node, "AuthorizedMatter taken from untyped data");
    }
    if (
      ts.isComputedPropertyName(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "authorized"
    )
      report(node, "property keyed by the authorized brand");
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword)
      report(node, "a second unique symbol, which could stand in for the brand");
    if (ts.isObjectLiteralExpression(node)) {
      const names = propertyNames(node);
      if (names.has("matterId") && names.has("principal") && names.has("role"))
        report(node, "object with the shape of an AuthorizedMatter");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
