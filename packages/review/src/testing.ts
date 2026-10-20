import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { RuleCheck } from "./types.js";

/** What the oracle says about one rule. Only the status is required. */
export interface OracleRule {
  status: RuleCheck["status"];
  /** Numbers as written in the contract, such as "3.1". Default: none. */
  clauseNumbers?: string[];
  /** Default: an empty string. */
  explanation?: string;
  /** Default: an empty string. */
  comment?: string;
  /** The clause is named by its number. The edit is dropped in a window that lacks that clause. */
  edit?: { clauseNumber: string; quote: string; replacement: string } | null;
  /** Default: null. */
  suggestedClause?: string | null;
}

const CONTRACT_OPEN = "<contract>\n";
const CONTRACT_CLOSE = "</contract>";
const HEADER = /^\[(c\d+)\](?: (.*))?$/;
const RULE_ID = /^Rule ID: (.+)$/m;

const ABSENT: RuleCheck = {
  status: "not_applicable",
  clauseIds: [],
  explanation: "None of the clauses this rule refers to are in this part of the contract.",
  comment: "",
  edit: null,
  suggestedClause: null,
};

interface ContractBlock {
  /** The id of the first clause that has each number in the contract block. */
  byNumber: Map<string, string>;
  /** The first clause with a number, else the first clause. */
  first: string | undefined;
}

// Reads the header lines of the contract block, where a clause is "[c12] 3.1 (section: ...)".
function readBlock(prompt: string, close: number): ContractBlock {
  const open = prompt.indexOf(CONTRACT_OPEN);
  const byNumber = new Map<string, string>();
  let firstAny: string | undefined;
  if (open === -1 || open > close) return { byNumber, first: undefined };
  const contract = prompt.slice(open + CONTRACT_OPEN.length, close);
  // Clauses are separated by a blank line and each starts with its header, so a line inside a
  // paragraph cannot be mistaken for one.
  for (const block of contract.split("\n\n")) {
    const header = HEADER.exec(block.split("\n", 1)[0] ?? "");
    const id = header?.[1];
    const rest = header?.[2];
    if (id === undefined) continue;
    firstAny ??= id;
    if (rest === undefined || rest.startsWith("(section:")) continue;
    const number = rest.split(" ", 1)[0];
    if (number !== undefined && number !== "" && !byNumber.has(number)) byNumber.set(number, id);
  }
  return { byNumber, first: byNumber.values().next().value ?? firstAny };
}

function answerFor(rule: OracleRule, block: ContractBlock): RuleCheck {
  const { byNumber } = block;
  const named = rule.clauseNumbers ?? [];
  const found = named.flatMap((number) => {
    const id = byNumber.get(number);
    return id === undefined ? [] : [id];
  });
  if (named.length > 0 && found.length === 0) return ABSENT;
  // Meeting a standard is a claim about a clause, so a competent model points at one. A script that
  // does not say which gets the first clause of the window, as the pipeline rejects a compliant
  // answer that names none.
  const clauseIds =
    found.length === 0 && rule.status === "compliant" && block.first !== undefined
      ? [block.first]
      : found;

  const edit = rule.edit ?? null;
  const editClauseId = edit === null ? undefined : byNumber.get(edit.clauseNumber);
  return {
    status: rule.status,
    clauseIds: [...new Set(clauseIds)],
    explanation: rule.explanation ?? "",
    comment: rule.comment ?? "",
    edit:
      edit === null || editClauseId === undefined
        ? null
        : { clauseId: editClauseId, quote: edit.quote, replacement: edit.replacement },
    suggestedClause: rule.suggestedClause ?? null,
  };
}

/**
 * A model stand-in that answers each playbook rule from a script, the way a competent model would.
 * The script is keyed by rule id, which the oracle reads from the "Rule ID: <id>" line of the rule
 * block; it throws for an id it has no script for. Clause numbers in a script become clause ids by
 * reading the header lines of the contract block it was sent, such as "[c12] 3.1 (section: 3.
 * Term)", and the first clause with a number is the one meant. When a script names clauses and none
 * of them is in the window it was sent, the answer is not_applicable, as a real model would say
 * about a part of the contract that does not cover the topic, so a review in several windows finds
 * the clause in one and merges the rest. A script that names no clauses is answered in every window,
 * and a compliant one points at the first clause of the window, because meeting a standard is a
 * claim about a clause. The script is otherwise passed through unchecked, so a test can give the
 * pipeline an answer a model should not give, but the schema in the request still validates it.
 */
export function createOracleGenerator(
  rules: Record<string, OracleRule>,
  options: { cachesSharedPrefix?: boolean } = {},
): ObjectGenerator & { readonly calls: GenerateObjectRequest<unknown>[] } {
  return createScriptedGenerator(
    (request) => {
      // The contract is untrusted and may hold a line that looks like a rule header, so only
      // what follows the closing tag is read. Contract text cannot hold the tag itself.
      const close = request.prompt.lastIndexOf(CONTRACT_CLOSE);
      if (close === -1) throw new Error("the prompt has no contract block");
      const id = RULE_ID.exec(request.prompt.slice(close))?.[1];
      if (id === undefined) throw new Error("the prompt has no rule id");
      const rule = Object.hasOwn(rules, id) ? rules[id] : undefined;
      if (rule === undefined) throw new Error(`the oracle has no answer for rule "${id}"`);
      return answerFor(rule, readBlock(request.prompt, close));
    },
    {
      provider: "oracle",
      model: "oracle",
      disclosure: "a scripted test oracle (nothing is sent anywhere)",
      cachesSharedPrefix: options.cachesSharedPrefix ?? false,
    },
  );
}
