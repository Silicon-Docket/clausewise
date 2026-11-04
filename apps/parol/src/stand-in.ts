/**
 * Providers that are programs and not language models: the scripted generator that tests use and
 * the simulated reader of the demonstration (src/demo). Whatever such a reader says is not an
 * analysis of a document by any model, and a person looking at a finding or a memo must be able to
 * tell. The pages and the memo both read this one list, so the two cannot disagree about which
 * readers need the warning.
 */
export const STAND_IN_PROVIDERS: readonly string[] = ["scripted", "simulated"];

export function isStandInProvider(provider: string): boolean {
  return STAND_IN_PROVIDERS.includes(provider);
}

/** The words that go with a stand-in reader, on the review page. Fixed text, no caller input. */
export const STAND_IN_HEADING = "Read by a scripted stand-in, not a language model";
export const STAND_IN_TEXT =
  "A built-in program made this review from a script. Its findings are not an analysis of these documents by any model, and they say nothing about how well any model reads an NDA.";

/** The same, for the provenance appendix of a memo. */
export const STAND_IN_MEMO_TEXT =
  "The findings in this memorandum were produced by a scripted stand-in program, not a language model. They are not an analysis of these documents by any model.";
