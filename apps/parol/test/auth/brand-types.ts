import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The type-aware half of the AuthorizedMatter forgery scan.
 *
 * `brand-scan.ts` reads syntax, so it sees only the words `AuthorizedMatter`. A cast through a type
 * alias (`type AM = AuthorizedMatter`), a renamed import, `ReturnType<typeof authorizeMatter>`, a
 * spread of a real one with another matter's id, `Object.assign`, a helper `pick<T>(x): T`, and a
 * value that arrives as `any` all make an `AuthorizedMatter` without the words appearing at the
 * place it happens, and they compile, because the brand is a type-level guard and TypeScript copies
 * a unique-symbol property through a spread. So this half asks the compiler: it finds the brand
 * property (the one that only `AuthorizedMatter` declares) and reports every place where a value
 * that carries it comes from something other than `authorizeMatter` or `authorizeMatterDelete`.
 *
 * The places it reports, each with its reason:
 * - an assertion (`as`, `<T>x`) to any type that carries the brand, however it is spelled;
 * - an object literal whose type carries the brand (a spread of one);
 * - a value of type `any` where a type that carries the brand is expected, in an argument, an
 *   initializer, a return, an assignment, a property or a destructuring;
 * - a call that produces one out of its type arguments (a generic helper, `Object.assign`) rather
 *   than passing an existing one through;
 * - a declaration that makes one with no value (`declare`, or `!:`).
 *
 * A value that is only passed along (a parameter, a list or map of them, `Promise.resolve(am)`,
 * `array.find(...)`) is not reported.
 */

export interface TypedBrandFinding {
  /** Path relative to the source root, with forward slashes. */
  file: string;
  line: number;
  rule: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAROL_ROOT = join(HERE, "..", "..");
export const SRC_ROOT = join(PAROL_ROOT, "src");

const BRAND_FILE = join(SRC_ROOT, "auth", "types.ts");
const BRAND_NAME = "AuthorizedMatter";
const BRAND_PROPERTY = /^__@authorized@\d+$/;

/** Compiler options of the application, read once. */
let cachedOptions: ts.CompilerOptions | undefined;
export function parolCompilerOptions(): ts.CompilerOptions {
  if (cachedOptions !== undefined) return cachedOptions;
  const config = ts.readConfigFile(join(PAROL_ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PAROL_ROOT);
  cachedOptions = { ...parsed.options, noEmit: true };
  return cachedOptions;
}

/** Source files read from disk are shared between programs, so a second program is cheap. */
const diskFiles = new Map<string, ts.SourceFile | undefined>();

/**
 * A program over `rootNames`. `overlay` supplies files that exist only here (the snippets the scan's
 * own tests feed it), by absolute path; they may import the real modules by relative path.
 */
export function createParolProgram(
  rootNames: readonly string[],
  overlay: ReadonlyMap<string, string> = new Map(),
): ts.Program {
  const options = parolCompilerOptions();
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => overlay.has(name) || fileExists(name);
  host.readFile = (name) => overlay.get(name) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = overlay.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    if (!diskFiles.has(name)) diskFiles.set(name, getSourceFile(name, languageVersion, ...rest));
    return diskFiles.get(name);
  };
  return ts.createProgram({ rootNames: [...rootNames], options, host });
}

export interface ScanOptions {
  /** Files (relative to the source root) that may make the brand: its declaration and its maker. */
  allowed: ReadonlySet<string>;
}

interface Brand {
  /** The interface symbol of `AuthorizedMatter`. */
  symbol: ts.Symbol;
  /** The escaped name of its unique-symbol property. */
  property: ts.__String;
}

function findBrand(program: ts.Program, checker: ts.TypeChecker): Brand {
  const file = program.getSourceFile(BRAND_FILE);
  if (file === undefined) throw new Error("the brand declaration is not in the program");
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== BRAND_NAME) continue;
    const symbol = checker.getSymbolAtLocation(statement.name);
    if (symbol === undefined) break;
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const property = checker
      .getPropertiesOfType(declared)
      .find((p) => BRAND_PROPERTY.test(String(p.escapedName)));
    if (property !== undefined) return { symbol, property: property.escapedName };
  }
  throw new Error("AuthorizedMatter has no brand property: the scan would see nothing");
}

export function findTypedBrandForgeries(
  program: ts.Program,
  options: ScanOptions,
): TypedBrandFinding[] {
  const checker = program.getTypeChecker();
  const brand = findBrand(program, checker);
  const findings: TypedBrandFinding[] = [];

  const hasBrandProperty = (type: ts.Type): boolean =>
    checker.getPropertiesOfType(type).some((p) => p.escapedName === brand.property);

  const isReference = (type: ts.Type): type is ts.TypeReference =>
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;

  /**
   * Whether a value of this type is, or wraps, an `AuthorizedMatter`: the type itself, a member of a
   * union or intersection, or a type argument (a promise, array or map of them). With `deep`, also a
   * property of a plain object type, so a record that holds one counts.
   */
  function carries(type: ts.Type, deep: boolean, depth = 0, seen = new Set<ts.Type>()): boolean {
    if (depth > 4 || seen.has(type)) return false;
    seen.add(type);
    if (type.isUnionOrIntersection())
      return type.types.some((t) => carries(t, deep, depth + 1, seen));
    if (hasBrandProperty(type)) return true;
    if (
      isReference(type) &&
      checker.getTypeArguments(type).some((t) => carries(t, deep, depth + 1, seen))
    )
      return true;
    if (deep && (type.flags & ts.TypeFlags.Object) !== 0 && type.getCallSignatures().length === 0)
      return checker
        .getPropertiesOfType(type)
        .some((p) => carries(checker.getTypeOfSymbol(p), deep, depth + 1, seen));
    return false;
  }

  /** The leaves a result type is made of, looking through unions and type arguments. */
  function leaves(type: ts.Type, depth = 0): ts.Type[] {
    if (depth > 4) return [];
    if (type.isUnion()) return type.types.flatMap((t) => leaves(t, depth + 1));
    if (isReference(type)) {
      const inner = checker.getTypeArguments(type);
      if (inner.some((t) => carries(t, false))) return inner.flatMap((t) => leaves(t, depth + 1));
    }
    return [type];
  }

  /** Whether the signature, as declared, returns a bare type parameter (`T`, `T & U`, `S | undefined`). */
  const returnsTypeParameter = (declaration: ts.SignatureDeclaration): boolean => {
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (signature === undefined) return false;
    const bare = (type: ts.Type, depth = 0): boolean =>
      depth < 3 &&
      ((type.flags & ts.TypeFlags.TypeParameter) !== 0 ||
        (type.isUnionOrIntersection() && type.types.some((t) => bare(t, depth + 1))));
    return bare(checker.getReturnTypeOfSignature(signature));
  };

  const declaredReturnCarries = (declaration: ts.SignatureDeclaration): boolean => {
    const signature = checker.getSignatureFromDeclaration(declaration);
    return signature !== undefined && carries(checker.getReturnTypeOfSignature(signature), false);
  };

  for (const source of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(source) ||
      program.isSourceFileFromExternalLibrary(source)
    )
      continue;
    const name = relative(SRC_ROOT, source.fileName).split("\\").join("/");
    if (name.startsWith("..") || options.allowed.has(name)) continue;

    const report = (node: ts.Node, rule: string): void => {
      findings.push({
        file: name,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        rule,
      });
    };

    const visit = (node: ts.Node): void => {
      // An assertion to a type that carries the brand, spelled any way at all.
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        !ts.isConstTypeReference(node.type) &&
        carries(checker.getTypeFromTypeNode(node.type), true)
      )
        report(node, "assertion to a type that carries AuthorizedMatter");

      // A spread of a real one gives an object that still has the brand property.
      if (ts.isObjectLiteralExpression(node) && carries(checker.getTypeAtLocation(node), false))
        report(node, "object literal that carries the AuthorizedMatter brand");

      // Something untyped where an AuthorizedMatter is wanted.
      if (ts.isExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        if ((type.flags & ts.TypeFlags.Any) !== 0) {
          const wanted = checker.getContextualType(node);
          if (wanted !== undefined && carries(wanted, true))
            report(node, "untyped value used as an AuthorizedMatter");
        }
      }

      // A call that produces one out of a type parameter (`pick<T>(x): T`, `Object.assign`) rather
      // than passing an existing one through. Containers (`new Map<string, AuthorizedMatter>()`,
      // `Promise.resolve(am)`) do not return a bare type parameter and are not reported.
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const result = checker.getTypeAtLocation(node);
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (
          carries(result, false) &&
          declaration !== undefined &&
          !ts.isJSDocSignature(declaration) &&
          returnsTypeParameter(declaration)
        ) {
          const inputs: ts.Type[] = (node.arguments ?? []).map((a) => checker.getTypeAtLocation(a));
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
            inputs.push(checker.getTypeAtLocation(node.expression.expression));
          // Passing one along is the same value: the result is the declared type itself, not a
          // copy with fields changed (an intersection, an object type of its own).
          const passesOneAlong = inputs.some((t) => carries(t, false));
          const unchanged = leaves(result)
            .filter((t) => hasBrandProperty(t))
            .every((t) => t.symbol === brand.symbol);
          if (!passesOneAlong || !unchanged)
            report(node, "call that makes an AuthorizedMatter out of a type parameter");
        }
      }

      // A value with no source: `declare const am: AuthorizedMatter`, `let am!: AuthorizedMatter`.
      if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        const ambient =
          ts.isVariableDeclaration(node) &&
          (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0;
        if (
          (ambient || node.exclamationToken !== undefined) &&
          carries(checker.getTypeAtLocation(node.name), true)
        )
          report(node, "an AuthorizedMatter declared without a value");
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.body === undefined &&
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0 &&
        declaredReturnCarries(node)
      )
        report(node, "a declared function that returns an AuthorizedMatter with no body");

      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
