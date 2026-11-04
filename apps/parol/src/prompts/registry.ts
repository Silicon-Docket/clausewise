import { z } from "zod";
import { canonicalJson, hashOf } from "../canonical.js";
import type { PromptDefinition } from "../contracts.js";
import type { GetPrompt, RegisteredPrompt, RenderPrompt } from "../module-contracts.js";
import { ANALYZE_P1 } from "./analyze-p1.js";
import { EXTRACT_P1 } from "./extract-p1.js";
import { flatten, renderingFingerprint } from "./render.js";
import { SUPPORT_P1 } from "./support-p1.js";
import type { PromptSource } from "./types.js";

/**
 * Prompts are data. A prompt's identity is the hash of everything that reaches the model through
 * it: its id and stage, the system text, the user template, the name of the schema and the schema
 * the answer is parsed with (as JSON Schema, so a changed field description is a changed prompt),
 * the fixed prose the stage code adds around the template (`fragments`), and the wording of the
 * helpers that write the rule, the document list and the clauses into the template
 * (`renderingFingerprint`). A workflow version pins prompt ids, and the store refuses to register
 * an id under a second hash, so editing a registered prompt in place is caught there; a changed
 * prompt is a new id.
 */
export function promptSha256(
  source: PromptSource,
  rendering: string = renderingFingerprint(),
): string {
  const { id, stage, system, userTemplate, schemaName } = source.definition;
  return hashOf({
    id,
    stage,
    system,
    userTemplate,
    schemaName,
    schema: z.toJSONSchema(source.schema),
    fragments: source.fragments ?? {},
    rendering,
  });
}

const SOURCES: readonly PromptSource[] = [ANALYZE_P1, EXTRACT_P1, SUPPORT_P1];

function register(source: PromptSource): RegisteredPrompt {
  return Object.freeze({
    definition: Object.freeze({ ...source.definition }),
    schema: source.schema,
    sha256: promptSha256(source),
  });
}

const REGISTRY: ReadonlyMap<string, RegisteredPrompt> = new Map(
  SOURCES.map((source) => [source.definition.id, register(source)] as const),
);

const FRAGMENTS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map(
  SOURCES.map((source) => [source.definition.id, Object.freeze({ ...source.fragments })] as const),
);

if (REGISTRY.size !== SOURCES.length) {
  throw new Error("the prompt registry holds two prompts with one id");
}

const SHORT = 60;

/** Throws for an unknown id. The id is the caller's, so it is shown, but only the first part of it. */
export const getPrompt: GetPrompt = (id) => {
  const found = REGISTRY.get(id);
  if (found === undefined) {
    throw new Error(`unknown prompt id "${id.length > SHORT ? `${id.slice(0, SHORT)}...` : id}"`);
  }
  return found;
};

/** Every registered prompt, by id. */
export function listPrompts(): RegisteredPrompt[] {
  return [...REGISTRY.values()].sort((a, b) =>
    a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0,
  );
}

/**
 * What the store's `upsertPromptVersion` takes for a registered prompt. `template` holds every text
 * that reaches the model through the prompt (system text, user template, schema name, the fixed
 * prose the stages add), as canonical JSON, so the stored row can be read without the code that
 * wrote it; `schemaJson` is the JSON Schema of the answer; `sha256` is the registry's own hash,
 * which also covers the wording of the shared rendering helpers and is therefore not the hash of
 * `template`. Registering the same prompt twice is a no-op in the store; registering an edited
 * prompt under the same id is refused there, which is how an in-place edit is caught.
 */
export function promptRecord(id: string): {
  id: string;
  stage: PromptDefinition["stage"];
  template: string;
  schemaJson: string;
  sha256: string;
} {
  const prompt = getPrompt(id);
  const { system, userTemplate, schemaName, stage } = prompt.definition;
  return {
    id,
    stage,
    template: canonicalJson({
      system,
      userTemplate,
      schemaName,
      fragments: FRAGMENTS.get(id) ?? {},
    }),
    schemaJson: JSON.stringify(z.toJSONSchema(prompt.schema)),
    sha256: prompt.sha256,
  };
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/**
 * The template is one pass over `{{name}}` placeholders, so a value that itself contains
 * `{{other}}` (a document line, say) is inserted as text and never expanded, and a replacement
 * function keeps `$&` and similar in a value from being read as a pattern. Messages name
 * variables, never their values.
 *
 * A placeholder that fills lines of its own (the contract block, the rule) takes its value as it
 * is. One in the middle of a line ("Proposed discrepancy: {{discrepancy}}") takes its value on
 * that line: line breaks and invisible characters in it become single spaces, so a value that is
 * model output or came from a document cannot start a line of its own and pose as a section of
 * the prompt that sits outside the contract fence.
 */
function fill(label: string, template: string, vars: Record<string, string>): string {
  const named = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) named.add(match[1]!);

  const rest = template.replace(PLACEHOLDER, "");
  if (rest.includes("{{") || rest.includes("}}")) {
    throw new Error(`${label}: the template has a malformed placeholder`);
  }

  const missing = [...named].filter((name) => !Object.hasOwn(vars, name));
  const unexpected = Object.keys(vars).filter((name) => !named.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [
      ...(missing.length > 0 ? [`missing variables: ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0
        ? [`variables the template does not use: ${unexpected.join(", ")}`]
        : []),
    ];
    throw new Error(`${label}: ${parts.join("; ")}`);
  }

  return template.replace(PLACEHOLDER, (whole, name: string, offset: number) => {
    const value = vars[name]!;
    const before = offset === 0 ? "\n" : template[offset - 1];
    const after = template[offset + whole.length] ?? "\n";
    const alone = before === "\n" && after === "\n";
    return alone ? value : flatten(value, Number.POSITIVE_INFINITY);
  });
}

export const renderPrompt: RenderPrompt = (definition: PromptDefinition, vars) =>
  fill(`prompt ${definition.id}`, definition.userTemplate, vars);

/**
 * One named piece of the fixed prose of a registered prompt, with its placeholders filled. The
 * stages use this for the sentences they add around the template, so that those sentences are
 * hashed with the prompt. Throws for an unknown prompt or name, and as `renderPrompt` does for a
 * variable that is missing or not used.
 */
export function getFragment(
  promptId: string,
  name: string,
  vars: Record<string, string> = {},
): string {
  getPrompt(promptId);
  const fragments = FRAGMENTS.get(promptId)!;
  const template = Object.hasOwn(fragments, name) ? fragments[name] : undefined;
  if (template === undefined) {
    throw new Error(`prompt ${promptId}: no fragment named ${name.slice(0, SHORT)}`);
  }
  return fill(`prompt ${promptId} fragment ${name}`, template, vars);
}
