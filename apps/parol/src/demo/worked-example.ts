import type { CategoryId } from "../contracts.js";

/**
 * What the simulated reader knows: the passages of the worked example (docs/parol/04, evaluation
 * case PAROL-D05) and what to say about them. It is data, written out here and copied from the
 * answer key and the worked example. The key is deliberately not imported: the reader is a
 * stand-in for a model, and a model does not get to read the key. A test compares this table with
 * the key and with the committed documents, so the two cannot drift apart unnoticed.
 *
 * Every party, passage and rule is synthetic. Nothing in this file is a statement of law.
 */

/** The NDA is D1 and Amendment No. 1 is D2, as the run labels them. */
export type DocLabelOfExample = "D1" | "D2";

export type PassageId =
  | "preamble"
  | "ciDefinition"
  | "exclusions"
  | "advisers"
  | "compelled"
  | "term"
  | "survival"
  | "deletion"
  | "returnDeadline"
  | "returnCopies"
  | "returnAmendment"
  | "governingLaw";

export interface KnownPassage {
  /** The document the passage is in. A clause of another document is never taken for it. */
  doc: DocLabelOfExample;
  /** Words that pick the passage out of a shown clause. */
  find: string;
  /** Words copied from the passage, for a finding or an extract answer to cite. */
  quote: string;
}

export const PASSAGES: Readonly<Record<PassageId, KnownPassage>> = {
  preamble: {
    doc: "D1",
    find: "Lanternfish Software, Inc., a Delaware corporation",
    quote: "Lanternfish Software, Inc., a Delaware corporation",
  },
  ciDefinition: {
    doc: "D1",
    find: "marked or identified as confidential at the time of disclosure",
    quote: "marked or identified as confidential at the time of disclosure",
  },
  exclusions: {
    doc: "D1",
    find: "Confidential Information does not include information that the Receiving Party can show",
    quote:
      "Confidential Information does not include information that the Receiving Party can show",
  },
  advisers: {
    doc: "D1",
    find: "professional advisers who need to know it",
    quote: "professional advisers who need to know it",
  },
  compelled: {
    doc: "D1",
    find: "requires the Receiving Party to disclose Confidential Information",
    quote: "requires the Receiving Party to disclose Confidential Information",
  },
  term: {
    doc: "D1",
    find: "shall continue for two (2) years from the date of each disclosure",
    quote: "shall continue for two (2) years from the date of each disclosure",
  },
  survival: {
    doc: "D1",
    find: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
    quote: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
  },
  deletion: {
    doc: "D2",
    find: "Section 6.1 of the Agreement is deleted in its entirety",
    quote: "Section 6.1 of the Agreement is deleted in its entirety",
  },
  // The two halves of Section 7.2 are separate passages because a finding cites them for
  // different reasons: the deadline is what the amendment changes, the copies are what it leaves.
  returnDeadline: {
    doc: "D1",
    find: "Within ten (10) business days after the Disclosing Party",
    quote: "Within ten (10) business days after the Disclosing Party",
  },
  returnCopies: {
    doc: "D1",
    find: "except for copies required by law or held in routine backup systems",
    quote: "except for copies required by law or held in routine backup systems",
  },
  returnAmendment: {
    doc: "D2",
    find: "Section 7.2 of the Agreement is amended by replacing",
    quote: 'replacing "ten (10) business days" with "thirty (30) days"',
  },
  governingLaw: {
    doc: "D1",
    find: "This Agreement is governed by the laws of the State of Delaware",
    quote: "laws of the State of Delaware",
  },
};

/**
 * How the reader tells the worked example from any other document. Two things are asked, and both
 * must hold.
 *
 *  - Every paragraph it is shown is a paragraph of the example, word for word and under the label of
 *    the document it belongs to (`KNOWN_PARAGRAPHS`). A paragraph that differs by a word, one that
 *    is added, or one from another document makes the whole block unknown, because the reader
 *    cannot tell what the difference means: an NDA that still holds the phrase "two (2) years" may
 *    have a sentence after it that takes the two years back. Matching a phrase is how it finds a
 *    passage it knows. It is not how it decides that it knows the document.
 *  - For a request that is about the rules and not about a handful of cited passages, the two
 *    parties are named in the block by their full names (`IDENTITY_NAMES`). Every clause of the
 *    example that a rule needs is shown together with a clause that names them, because a defined
 *    term brings the preamble in.
 */
export const IDENTITY_NAMES: readonly string[] = [
  "Lanternfish Software, Inc.",
  "Corvane Data Systems LLC",
];

/**
 * The paragraphs of the two committed documents, as a SHA-256 of each paragraph with its white space
 * folded to single spaces (the form the reader sees it in), by the label the run gives the
 * document. The text itself is not copied: a fingerprint is all the reader needs to know that a
 * paragraph is the one it knows, and a test regenerates the list from the committed files, so a
 * changed file shows up there and not as a quiet change of behaviour. The comment on each line
 * gives its first words and nothing else.
 */
export const KNOWN_PARAGRAPHS: Readonly<Record<DocLabelOfExample, readonly string[]>> = {
  D1: [
    "5506b54c5e981a03f5f525f37c7680d9cc131ba0ca92072edac29840f660dbd8", // MUTUAL NONDISCLOSURE AGREEMENT
    "24e0a0607671789332fdec1fbe70577045364a4ccb8a5db6d53c67857d670bc6", // This Mutual Nondisclosure Agreement
    "352bbc8feb06e64c8862dc69a365b01a5361fc1517171e3902669c7f00072ce4", // The Parties wish to
    "54376bf016bcf4f0a472dc1ba9be39e88daebdb00c5b304034c403a7756d47fb", // 1. Definitions
    "577841d18b35c879ffe3e9c7908d517a13dc84d3d49040fc96a011ab76025599", // 1.1 "Affiliate" means an
    "fa3f97204ce6366271668e4e3eba800beda723d5775b4c3cb41527ee3e2e8bd2", // 1.2 "Confidential Information" means
    "2bac975d6b932edb676fe66cf17d2e5334623110b92aefd7a0437b61eb4d8fcc", // 2. Exclusions
    "4086c07f16b4e331a75dec663e2131c238ce3afe729fa2aa9a7ac2b6b0dff16f", // 2.1 Confidential Information does
    "8aeb8fae93933bcc9b2017038b7987ab010edd1b7ea4d17aeb0715ed679aac56", // 3. Ownership
    "0a39618af00cf5291b2e34162919e2289e118ab7ae015781b2b53d017ae85057", // 3.1 Confidential Information remains
    "d20d3373ef9f26b2e8a9668e9a6ef3c338b337b1b3bf24e7804e689c444be087", // 4. Obligations of the
    "3a09f637f5ad4b2f04e990badd74747ef0673bb1685769f1fbd324a762b20360", // 4.1 The Receiving Party
    "d31af864783cef88c0e8abd0b8841261966e4eb80f606d1a1132cface1f809b3", // 4.2 The Receiving Party
    "9c027ad3f9aedf3e1b5c42a7b08be07c41a17a807a229c879201ea3c34df8d72", // 4.3 The Receiving Party
    "0a89f36da084d6af7478907b7b71da78c139a3063e90602eb8e3fab8b2729aba", // 5. Permitted Disclosures
    "363120166088a885415019b21921a96b4f6604d733793a1c5ff6feb8eca00b03", // 5.1 The Receiving Party
    "05a1a0729048ca01bf12e0d9c9acc894aa796a18e6e59fdeefe8f7b64151efc6", // 5.2 If law, regulation
    "07790a04d9a5b005a1a3b823d1f4bb5bfe13b67adbbdd69adec656821cd8041b", // 5.3 A disclosure that
    "158fcd55ad74688e5e7280242e26b0ed209474a3f24f145f1f4662231bd6ee29", // 6. Term and Termination
    "f0f376f50b05d711a4193d727f9e1ae5413ebffaa5f7d0b9995bb24bc617138e", // 6.1 The obligations of
    "6cf12d591ef00341bbf1f425b896ef1ae1dae02cb2f28160b1c320e0b9c59b6d", // 6.2 Either Party may
    "c8d85940e76721d869b85ffecd38e7feb5910d521ce176d738015666480b5e5e", // 7. Return of Information
    "781ee6f41e900d344682f1b0ed666ee536afd10120202c1f64f122c93b95c597", // 7.1 The Receiving Party
    "fcb7d215615f2d01c7e8f9dace2070da666e20d55aa730bec10e3fec8fb6fd9e", // 7.2 Within ten (10)
    "bb2b06af48bbd0d1b7567ca899ce4c219c1354a8c960722b19b491c48ff7e897", // 8. Governing Law
    "1b0b9bf7eb8408d4df2e9e3f336559083ab10ad9db040748b1ee5d2735987768", // 8.1 This Agreement is
    "27c68bca32d5d1a4ef79ae2d2d45cfe9eae35f88454f8a63bbc93837af4398b4", // 9. General
    "a73deeb1d142d83dd8651157783af585ae6d72c4b2ff7de3103407dda7800c9f", // 9.1 This Agreement is
    "134eabc389ea3b68d0ff3497d194a8d20657d706327d72638ef0e93f2cd6fd4e", // 9.2 A change to
    "ab4c5867863020792e88b0d30b365921c88ce32562648cc24c5a3a0f6bafd847", // 9.3 Sections 4, 5
    "eca3fa91a235b426ca6ca00831a8f12a5de1f066fe1663d406fcd3cef5fa2316", // Lanternfish Software, Inc.
    "8cb7bf29cf0f8fab5d749cbe6c37a16a349cf2d4a592556b96715e01b0eb0700", // By: ______________________
    "12b78fb22d3b42bec10cce78f584cfd37095eac327706eca10d68ec152f07605", // Name and title:
    "a989c89fa44ec79d06e99c63570db67c9dabde3dd00fb5f68cf78406f6e79e70", // Corvane Data Systems LLC
  ],
  D2: [
    "44c89b546466aa67a1654275272fbaaf1fc97d84139275a354dd371b7841c60f", // AMENDMENT NO. 1 TO
    "931bcd5895a130c1f32c2bce16757b09858afe74cc0321c46bff3580202b5263", // This Amendment No. 1
    "2022601dc305c9fbf586990e66c6834b0e299488b99844b650ff2576da00b1b4", // 1. Capitalized terms used
    "80ff245ba34e5879528497972a8f184fc3af6b2a2ee893a3abb6631abad0ab8f", // 2. Section 6.1 of
    "725c8e7e5b56a118c81c35a25a34d7adc77a69b5a4525d11abbc30463e3a3b48", // 3. Section 7.2 of
    "affa342703da8d74bb4246b2f5647c2a777676fe7ae2e8131559a330c200f5d7", // 4. Except as amended
  ],
};

/**
 * The locator's answer. For each category, the passages of the NDA it selects. The omissions are
 * the point, and they are the hypothesis H1 of docs/parol/05:
 *
 *  - Duration: the term clause (Section 6.1) is selected. The amendment clause that deletes it is
 *    not, because it has no word of the category: no number, no "years", no "survive". Nor is the
 *    survival clause, which is left to the keyword hints.
 *  - Return: Section 7.2 is selected, and the amendment clause that changes its deadline is not,
 *    for the same reason.
 *
 * A locator that read the NDA before the amendment, and looked for the words of each category,
 * would do exactly this. It is a table here, not a model.
 */
export const EXTRACT_TABLE: readonly { category: CategoryId; passages: readonly PassageId[] }[] = [
  { category: "parties", passages: ["preamble"] },
  { category: "ci-definition", passages: ["ciDefinition"] },
  { category: "exclusions", passages: ["exclusions"] },
  { category: "permitted-disclosures", passages: ["advisers", "compelled"] },
  { category: "duration", passages: ["term"] },
  { category: "return-destruction", passages: ["returnDeadline"] },
  { category: "governing-law", passages: ["governingLaw"] },
];

// ---------------------------------------------------------------------------------------------
// The rules that read one clause
// ---------------------------------------------------------------------------------------------

export interface SimpleRule {
  /** The clause that settles the rule. */
  passage: PassageId;
  /** What the rule is about, for a sentence saying it was not found. */
  topic: string;
  /** What the clause says, in the words of a finding. */
  compliantExplanation: string;
}

/** The six rules whose answer the key gives from a single clause of the NDA. */
export const SIMPLE_RULES: Readonly<Record<string, SimpleRule>> = {
  "pty-1": {
    passage: "preamble",
    topic: "the parties",
    compliantExplanation:
      "The preamble names the client with its full legal name and entity type, and names the other party in full. Each party's role is clear from the agreement being mutual.",
  },
  "def-1": {
    passage: "ciDefinition",
    topic: "the definition of Confidential Information",
    compliantExplanation:
      "Section 1.2 defines Confidential Information as non-public information that is marked or identified as confidential, or that a reasonable person would understand to be confidential. That is the playbook standard.",
  },
  "exc-1": {
    passage: "exclusions",
    topic: "the exclusions from Confidential Information",
    compliantExplanation:
      "Section 2.1 takes out information that is public, already known, independently developed or received from a third party, which are the four standard exclusions, and it asks for no written records.",
  },
  "pds-1": {
    passage: "advisers",
    topic: "disclosure to representatives",
    compliantExplanation:
      "Section 5.1 lets the Receiving Party pass information to its and its Affiliates' employees, officers, contractors and professional advisers who need to know it and are bound by confidentiality obligations no less protective. That is the playbook standard.",
  },
  "pds-2": {
    passage: "compelled",
    topic: "disclosure required by law",
    compliantExplanation:
      "Section 5.2 is a dedicated clause that lets the Receiving Party disclose what law, regulation or the order of a court or authority requires, with prompt written notice where legally permitted and reasonably practicable.",
  },
  "gov-1": {
    passage: "governingLaw",
    topic: "the governing law and forum",
    compliantExplanation:
      "Section 8.1 chooses the law and the courts of Delaware, which are on the approved list.",
  },
};

// ---------------------------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------------------------

export const DURATION = {
  ruleKey: "dur-1",
  topic: "the duration of the obligations",
  /** The reader of an NDA that never saw the amendment: the term is two years and that is fine. */
  baselineExplanation:
    "Section 6.1 limits the obligations to two years from each disclosure, within the three-year standard.",
  /** From docs/parol/04, section 3. */
  deviationDiscrepancy:
    "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
  /** The same finding when the survival clause is not among the passages shown. */
  deviationDiscrepancyWithoutSurvival:
    "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4 that the passages shown contain. As amended, the passages shown give the obligations no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
  deviationExplanation:
    "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
  deviationExplanationWithoutSurvival:
    "The original two-year term in Section 6.1 no longer applies. Nothing in the passages shown limits how long the Section 4 obligations last.",
  /** Where the approved fallback text is adapted: the clause it restates and the words it names. */
  adaptation: { clausePrefix: "6.1 ", from: "under this Agreement", to: "under Section 4" },
  deletionWithoutTerm: {
    explanation:
      "The amendment deletes Section 6.1, but that clause is not among the passages shown, so what the deletion removes cannot be judged.",
    abstainReason:
      "The amendment deletes a clause of the NDA that is not shown, so the rule cannot be applied.",
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------------------------

export const RETURN = {
  ruleKey: "ret-1",
  topic: "the return or destruction of information",
  /** With the amendment shown: the key's answer. */
  curedExplanation:
    "Amendment No. 1 replaces the ten business day deadline in Section 7.2 with thirty days, which meets the playbook standard. The rest of Section 7.2 still lets the Receiving Party keep copies required by law or held in routine backups, which remain confidential.",
  /** Without it: what the NDA alone says. */
  deviationDiscrepancy:
    "Section 7.2 sets a deadline of ten business days, which is shorter than the thirty days the playbook standard allows.",
  deviationExplanation:
    "The only deadline in the passages shown is the ten business days in Section 7.2, and nothing shown changes it.",
  /** The approved text is offered under the clause it would replace. */
  adaptation: { clausePrefix: "7.2 " },
  amendmentWithoutClause: {
    explanation:
      "The amendment changes the deadline in Section 7.2, but that clause is not among the passages shown, so the resulting deadline cannot be judged.",
    abstainReason:
      "The amendment changes a clause of the NDA that is not shown, so the rule cannot be applied.",
  },
} as const;

// ---------------------------------------------------------------------------------------------
// When the amendment cannot be ordered after the NDA
// ---------------------------------------------------------------------------------------------

export const UNORDERED = {
  explanation:
    "An amendment clause appears to change a clause of the NDA, but the stated dates do not show that the amendment is later than the NDA, so it is not clear which governs.",
  conflict:
    "The amendment changes a clause of the NDA, but its stated date is missing or earlier than the NDA's.",
  abstainReason: "The stated dates do not show that the amendment governs the clause it changes.",
} as const;

// ---------------------------------------------------------------------------------------------
// What the reader says when it cannot read
// ---------------------------------------------------------------------------------------------

export const NOT_THE_EXAMPLE = {
  reason:
    "The simulated reader only knows the worked example (the Lanternfish and Corvane NDA with Amendment No. 1), and these documents are not it.",
  support:
    "The simulated reader only knows the worked example, and these passages are not from it.",
} as const;

export const UNKNOWN_RULE = {
  reason:
    "The simulated reader only knows the rules of the demonstration playbook, and this is not one of them.",
} as const;

export const NOT_SHOWN = {
  /** When the passages are a selection, a missing clause may be in a paragraph that is not shown. */
  selection: (topic: string): string =>
    `The passages shown do not include a clause on ${topic}, and other paragraphs of the documents are not shown, so the rule cannot be applied.`,
  /** When every paragraph is shown, the clause is not there. */
  absent: (topic: string): string => `No clause in the documents deals with ${topic}.`,
} as const;
