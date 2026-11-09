# 4. Worked example

One finding traced from document text to memo. Every party, passage and rule is invented for this
project; any resemblance to a real entity is coincidental.

**Implementation status.** Built: every step this example walks through (Word and plain text
upload, ingest, extract, retrieval R1 and R2, the checks of set C1, the review decision, the Word
memo). It runs end to end on case `PAROL-D05` in `apps/parol`, and the stage output below is taken
from such a run. The reader in that run was the scripted simulated reader, which is not a language
model: its answers were written from the earlier draft of this document, so they show the machinery
and say nothing about any model, and H1 (a real model fails this way) is untested. Never run live.
Not pinned by any workflow version: the model support check and the `superseded_evidence` check
(set C2). Departures from the earlier draft are marked **Deviation**.

The analysis outputs below are **what the scripted simulated reader returned** when the application
ran the documents through the stages (source: `apps/parol/src/demo`, workflow versions v1 and v2).
The span tables, annotation counts and verify tables were read again from a seeded database on 8
November 2026; the memo excerpt in section 6 comes from one demo run on 4 November 2026. They
illustrate the contract shapes and the hypothesised baseline failure. A real
model has not produced them.

The example is evaluation case `PAROL-D05` ([document 5](05-evaluation.md#dataset)), and it is the
case the improvement cycle is built around: an amendment deletes the NDA's only time limit, and a
correct, verifiable quote from the deleted clause supports the wrong conclusion. Its files are
`fixtures/parol/files/parol-d05-nda.docx` and `fixtures/parol/files/parol-d05-amendment-1.txt`, and
the demo seed (`pnpm parol:seed`) loads the same two documents into the Lanternfish / Corvane
matter.

## The matter

| Field        | Value                                                           |
| ------------ | --------------------------------------------------------------- |
| Matter       | Lanternfish / Corvane NDA                                       |
| Our client   | Lanternfish Software, Inc.                                      |
| Counterparty | Corvane Data Systems LLC                                        |
| D1           | Mutual NDA (DOCX), version 1, stated date 2 February 2026       |
| D2           | Amendment No. 1 (TXT), version 1, stated date 15 September 2026 |
| Playbook     | `parol-nda-recipient` 1.0.1 (approved)                          |
| Associate    | Alex Ruiz (demo identity)                                       |
| Reviewer     | Dana Whitfield, reviewing attorney (demo identity)              |

**Deviation.** The playbook is 1.0.1 and not 1.0.0, and the reviewer is named in full: the playbook
text changed while it was built (see [The demo playbook](#the-demo-playbook)), and the demo users
have the names above.

## 1. Document passages

Paragraphs are counted from 0 across the whole file, headings and signature lines included, and a
span is named by document and paragraph: `D1-p19`. That is the label people read. The model reads
and cites a different label, `c<N>`, counted from 1 across the documents of the run in the order D1,
D2, and the code maps every label it cites back to a span. The stored text of a span begins with
the clause number as typed in the document ("6.1 The obligations ..."); the Text column leaves the
number out because the Clause column has it.

**D1, Mutual NDA (v1)**, the paragraphs that matter here (36 paragraphs in all, p0 to p35):

| Span label | Model label | Clause | Text                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1-p5      | c6          | 1.2    | "Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential given its nature and the circumstances of disclosure. |
| D1-p11     | c12         | 4.1    | The Receiving Party shall use Confidential Information only to evaluate a possible commercial relationship between the Parties and shall protect it with at least the degree of care it uses for its own information of a similar nature, and no less than reasonable care.                                                                    |
| D1-p19     | c20         | 6.1    | The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.                                                                                                                                                                                         |
| D1-p20     | c21         | 6.2    | Either Party may terminate this Agreement on thirty (30) days' written notice.                                                                                                                                                                                                                                                                 |
| D1-p23     | c24         | 7.2    | Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.                                                          |
| D1-p29     | c30         | 9.3    | Sections 4, 5 and 8 survive any termination or expiration of this Agreement.                                                                                                                                                                                                                                                                   |

**Deviation.** Clause 1.2 is `D1-p5`; the earlier draft said p6. A heading paragraph precedes every
section, so 1.2 at p6 and 4.1 at p11 cannot both hold, and the indices from 4.1 onward were kept.

**D2, Amendment No. 1 (v1)**, the whole document (6 paragraphs):

| Span label | Model label | Clause | Text                                                                                                                                                                                                                                        |
| ---------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2-p0      | c37         |        | AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT                                                                                                                                                                                           |
| D2-p1      | c38         |        | This Amendment No. 1 (the "Amendment") is made as of 15 September 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC, and amends the Mutual Nondisclosure Agreement between them dated 2 February 2026 (the "Agreement"). |
| D2-p2      | c39         | 1      | Capitalized terms used but not defined in this Amendment have the meanings given in the Agreement.                                                                                                                                          |
| D2-p3      | c40         | 2      | Section 6.1 of the Agreement is deleted in its entirety.                                                                                                                                                                                    |
| D2-p4      | c41         | 3      | Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".                                                                                                                                      |
| D2-p5      | c42         | 4      | Except as amended by this Amendment, the Agreement remains in full force and effect.                                                                                                                                                        |

D2-p3 is the trap. It changes the duration of every obligation, but it contains none of the words a
reader scanning for "duration" would look for: no number, no "years", no "survive".

## 2. Playbook rule

The rule `dur-1`, as it stands in `apps/parol/playbooks/parol-nda-recipient.yaml` (version 1.0.1):

```yaml
- id: dur-1
  category: duration
  title: Duration of confidentiality obligations
  severity: high
  required: true
  standard: Obligations end three years or less after each disclosure. Continued protection of
    trade secrets for as long as they remain trade secrets is acceptable.
  fallback: Obligations end five years or less after each disclosure, or five years or less
    after the agreement ends.
  unacceptable: Obligations that are perpetual or have no stated end, for information that is
    not a trade secret.
  fallbackLanguage: The obligations of each Receiving Party under this Agreement shall continue
    for three (3) years from the date of each disclosure of Confidential Information, except that
    obligations with respect to any trade secret shall continue for so long as it remains a trade
    secret under applicable law.
  escalateWhen:
    - id: over-five-years
      text: The stated period is longer than five years, counted from whichever event the clause
        uses, but finite, which is a business decision.
  guidance: Copies kept under the return or destruction clause are covered. Protection of them
    for as long as they are held, with no end, is the unacceptable case, while copies that
    remain subject to the agreement stay subject to its own period.
```

## 3. Through the stages

**ingest** (deterministic). Spans as above, plus annotations: 121 for these two documents (68
`uses_term`, 34 `keyword_hint`, 11 `defines_term`, 8 `cross_reference`), and no ingest warning. A
span id is `<document version id>:p<paragraph>`; version ids are random for each upload (`ver_` and
16 hex digits), so they are written `ver_D1` and `ver_D2` here. The ones this example turns on:

```json
[
  { "kind": "cross_reference", "spanId": "ver_D2:p3", "target": "6.1", "verb": "deletes" },
  { "kind": "cross_reference", "spanId": "ver_D2:p4", "target": "7.2", "verb": "amends" },
  { "kind": "defines_term", "spanId": "ver_D1:p5", "term": "Confidential Information" },
  { "kind": "defines_term", "spanId": "ver_D1:p5", "term": "Receiving Party" },
  { "kind": "keyword_hint", "spanId": "ver_D1:p19", "category": "duration" },
  { "kind": "keyword_hint", "spanId": "ver_D1:p29", "category": "duration" }
]
```

The heading `D1-p18` ("6. Term and Termination") and Section 6.2 (`D1-p20`) also carry a `duration`
hint, and `D2-p3` carries no hint of any category. A hint of the `permitted-disclosures` category
carries a `topic` as well (`representatives` or `legal-compulsion`), which a playbook rule can
select with `hintTopics`; the duration hints have none.

**Deviation.** The earlier draft listed six annotations and a `spanId` of `dv_d2v1:p3`. These are
the annotations that matter, with the real span id form, and the hint `topic` field exists because
two rules of the playbook share the `permitted-disclosures` category.

**extract** (model, then quote check). The simulated reader's answer for `duration` names clause
`c20` (`D1-p19`) with the quote "shall continue for two (2) years from the date of each disclosure",
and the quote check confirms it, so `D1-p19` is located. `D1-p18`, `D1-p20` and `D1-p29` are hints
that extract did not select. `D2-p3` is neither located nor hinted.

**retrieve** (deterministic). The bundle for `dur-1`:

| Span   | Why included under R1 (baseline)                                     | Under R2 (revision)                           |
| ------ | -------------------------------------------------------------------- | --------------------------------------------- |
| D1-p1  | definition (the preamble defines Party, which D1-p19 uses)           | definition                                    |
| D1-p5  | definition (Confidential Information and Receiving Party, also used) | definition                                    |
| D1-p18 | keyword hint (the heading "6. Term and Termination")                 | keyword hint                                  |
| D1-p19 | located                                                              | located                                       |
| D1-p20 | keyword hint (Section 6.2)                                           | keyword hint                                  |
| D1-p29 | keyword hint (the survival clause)                                   | keyword hint                                  |
| D2-p3  | **not included**                                                     | cross_reference: deletes 6.1, which D1-p19 is |

The retrieval stage's own size estimate for the bundle (one token per three characters, an estimate
and not a count from any model) is 841 under R1 and 886 under R2, against the workflow's budget of
12,000.

**Deviation.** The earlier draft listed four spans. The real bundle also holds the preamble (a
definition), the heading and Section 6.2 (both keyword hints), which do not change the story.

### Baseline (workflow v1: prompts P1, retrieval R1), the failure as the simulated reader reproduces it

Analyze returns (source: the scripted simulated reader; prompts P1 are the registry's `extract.p1`
and `analyze.p1`). The model cites `c20`, which is `D1-p19`:

```json
{
  "status": "compliant",
  "evidence": [
    {
      "span": "c20",
      "quote": "shall continue for two (2) years from the date of each disclosure",
      "role": "governing"
    }
  ],
  "discrepancy": "",
  "explanation": "Section 6.1 limits the obligations to two years from each disclosure, within the three-year standard.",
  "fallbackLanguage": null,
  "escalateWhenMatched": [],
  "conflict": null,
  "abstainReason": null
}
```

**Deviation.** The earlier draft showed `"span": "D1-p19"`. The model-facing schema takes the `c<N>`
label shown in the prompt, and the code turns it into a span id before verification, so a model is
never trusted to write an id.

Verify under v1 and v2 (the trail the inspector shows; the detail column is the v2 finding's):

| Check                   | Kind          | v1             | v2             | Detail, v2                                                                       |
| ----------------------- | ------------- | -------------- | -------------- | -------------------------------------------------------------------------------- |
| `quote_exists`          | deterministic | pass           | pass           | 3 verified, 0 ambiguous                                                          |
| `span_in_bundle`        | deterministic | pass           | pass           | 3 cited spans all in the bundle                                                  |
| `evidence_set`          | deterministic | pass           | pass           | 3 passages cited                                                                 |
| `citation_shape`        | deterministic | pass           | pass           | status deviation is cited as it requires                                         |
| `numeric_consistency`   | deterministic | pass           | pass           | 1 figure stated, each in a verified quote or the rule: 2 years                   |
| `precedence_labels`     | deterministic | pass           | pass           | roles agree with the precedence rules over 3 cited (3 verified)                  |
| `parties`               | deterministic | not applicable | not applicable | the rule is not in the parties category                                          |
| `missing_confirmation`  | deterministic | not applicable | not applicable | status deviation claims no absence                                               |
| `playbook_escalation`   | deterministic | not applicable | not applicable | the analysis matched no escalation condition                                     |
| `defined_term`          | deterministic | pass           | pass           | every defined term in 3 quotes is defined                                        |
| `instruction_like_text` | deterministic | pass           | pass           | 3 cited passages, none in a paragraph that reads like an instruction to software |
| `model_abstained`       | deterministic | pass           | pass           | the analysis stated status deviation                                             |
| `fallback_basis`        | deterministic | not applicable | pass           | approved_adapted, similarity 0.94 against 0.60                                   |

Under v1 the quote occurs once in `D1-p19`, the figures stated (two years in the quote, three in the
rule) are in the verified quote or the rule, and nothing cites the amendment, so no row fails.
Result: a verified, **wrong** `compliant` on a high-severity rule, with a valid quote and no
escalation. Every check did its job; none of them could see the amendment. This is why quotation
validity and local support are not enough, and why the failure is worth a controlled fix.

**Deviation.** The earlier draft had a model `support` row that passed because the checker "is
shown only D1-p19", and called the precedence row `precedence`. The checks have the names above;
seven more exist than the earlier draft's table had (`evidence_set`, `parties`,
`missing_confirmation`, `playbook_escalation`, `defined_term`, `instruction_like_text` and
`model_abstained`; all sixteen check ids are listed in
[document 3](03-data-model-and-contracts.md#deterministic-checks-and-model-judgment)); and neither v1 nor v2 pins the support prompt, so no
`support` row appears and every cited passage reads "Support not checked".
The support check is wired (`createSupportChecker`, prompt `support.p1`), and a test with a scripted
checker shows what the earlier draft said: given only `D1-p19`, it agrees. Its error rates are to be
measured on a calibration set before it is relied on
([document 5](05-evaluation.md#support-calibration-set)), and that set is not built.

The deterministic defence the design calls candidate v3 is built as check set C2
(`superseded_evidence`) and no workflow version enables it. A test (`verify-worked-example.test.ts`)
runs the v1 finding through C1 and C2: C1 leaves it verified, and C2 escalates it with
`superseded_evidence`, detail "evidence 1 (D1-p19), clause 6.1, is changed by D2-p3 (deletes), which
the finding does not cite".

### Revision (workflow v2: prompts P1, retrieval R2)

The only change is retrieval: amendment spans that cross-reference a located clause are included.
Analyze returns (source: the scripted simulated reader; `c40` is `D2-p3`, `c20` is `D1-p19` and
`c30` is `D1-p29`):

```json
{
  "status": "deviation",
  "evidence": [
    {
      "span": "c40",
      "quote": "Section 6.1 of the Agreement is deleted in its entirety",
      "role": "governing"
    },
    {
      "span": "c20",
      "quote": "shall continue for two (2) years from the date of each disclosure",
      "role": "superseded"
    },
    {
      "span": "c30",
      "quote": "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
      "role": "supporting"
    }
  ],
  "discrepancy": "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
  "explanation": "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
  "fallbackLanguage": "6.1 The obligations of each Receiving Party under Section 4 shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
  "escalateWhenMatched": [],
  "conflict": null,
  "abstainReason": null
}
```

The verify table above shows the v2 trail: all thirteen rows pass or do not apply (ten pass and
three do not apply; under v1 the finding's thirteen rows are nine passes and four that do not
apply). Both counts were read from the database of a seeded run. `precedence_labels`
passes because `D2-p3` deletes 6.1, the amendment is dated after the NDA (15 September against
2 February 2026), and `D1-p19` is labelled superseded. `fallback_basis` passes because the
fallback is the playbook's approved text with "this Agreement" changed to "Section 4" and the clause
number "6.1" added.

### The same gap the other way: RET-1

The amendment's Section 3 (`D2-p4`) cures the return deadline of Section 7.2, and it has no word of
the category either. Under R1 the simulated reader never sees it and flags the deadline; under R2
the retrieval stage adds `D2-p4` (it amends 7.2, which is in the bundle) and the finding changes:

| Workflow | Status      | What the finding cites                                                                                    |
| -------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| v1       | `deviation` | `D1-p23` (Section 7.2), "Within ten (10) business days after the Disclosing Party"                        |
| v2       | `compliant` | `D2-p4` governing (ten business days replaced by thirty days), `D1-p23` supporting (the copies carve-out) |

This is a false alarm under v1 and the expected answer under v2 (the answer key for `ret-1` in
`PAROL-D05` is `compliant` through the amendment). The scripted reader shows it by construction,
and it is the side effect that hypothesis H2 of [EXP-001](experiments/EXP-001.md) expects of a real
model.

## 4. The finding as the issue table and the inspector show it

The issue table has one row per rule, with five columns, and the inspector beside it shows the rest.

| Table column      | Value for this finding                                    |
| ----------------- | --------------------------------------------------------- |
| Severity          | High                                                      |
| Category and rule | Duration of confidentiality obligations (Duration, dur-1) |
| Status            | Deviation                                                 |
| Review            | Not decided                                               |
| Flags             | None                                                      |

| Inspector field             | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence, location          | "Section 6.1 of the Agreement is deleted in its entirety" (Amendment No. 1 (v1), Section 2, paragraph 3), governing. "shall continue for two (2) years from the date of each disclosure" (Mutual NDA (v1), Section 6.1, paragraph 19), superseded and struck through. "Sections 4, 5 and 8 survive any termination or expiration of this Agreement" (Mutual NDA (v1), Section 9.3, paragraph 29), supporting. |
| Discrepancy and explanation | As in the analysis output above.                                                                                                                                                                                                                                                                                                                                                                              |
| Checks                      | 10 passed, 0 failed, 3 not applicable. Each cited passage reads "Quote found" and "Support not checked".                                                                                                                                                                                                                                                                                                      |
| Applicable playbook rule    | DUR-1, Parol NDA (Recipient) 1.0.1. Standard: three years or less after each disclosure. Unacceptable: no stated end for non-trade-secret information.                                                                                                                                                                                                                                                        |
| Suggested fallback language | As in the analysis output above. Basis: approved playbook text, adapted to these documents.                                                                                                                                                                                                                                                                                                                   |
| Review status or escalation | Verified; no escalation. Not decided. Only the reviewing attorney sees the decision form.                                                                                                                                                                                                                                                                                                                     |

**Deviation.** The design put all of these fields in one table row. The row is a summary
(`IssueRow`) and the rest is a second request (`FindingView`), so that a table of eight rules stays
readable on a narrow screen and the evidence sits beside it.

## 5. Review decision

Dana Whitfield opens the evidence, reads D2-p3 in place, and edits the fallback to restore the term
the parties had already agreed. The decision is the body of
`POST /api/matters/:matterId/findings/:findingId/reviews`, or the form on the finding page:

```json
{
  "decision": "edit",
  "findingContentSha256": "<contentSha256 of the finding as the reviewer saw it>",
  "edits": {
    "fallbackLanguage": "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law."
  },
  "reason": "The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists."
}
```

The decision is bound to the finding's content hash. If Corvane later sends a revised amendment and
it is uploaded as D2 version 2, the new version becomes the operative one at once, the review made
on the old text is marked out of date, this decision no longer counts, and the memo cannot be
exported ("The results are out of date. Run the review again first.") until the matter is run again
and the new finding decided. An end-to-end test walks this through over HTTP.

## 6. Memo excerpt

The exported DOCX has a heading block (title, Re, Client, Date), a "Document warnings" section when
an upload raised warnings (counts and locations only, and none for this example), an Open items
section, a summary table of all eight rules, one section per finding, "Appendix A. Considered and
rejected" and "Appendix B. Provenance". The text below is the DUR-1 section and the provenance appendix of the
memo the application produced from the v2 review after the edit above and acceptance of the other
seven findings (source: the simulated reader; the matter and run ids and the dates are those of one
run on 4 November 2026 and differ in every run):

> **MEMORANDUM: DRAFT FOR ATTORNEY REVIEW. SYNTHETIC DEMONSTRATION, NOT LEGAL ADVICE.**
>
> **Re:** Lanternfish / Corvane NDA, Mutual NDA (v1) and Amendment No. 1 (v1), review against Parol
> NDA (Recipient) playbook 1.0.1
>
> **6. Duration of confidentiality obligations (DUR-1, high severity): deviation.**
>
> **Decision:** Edited by Dana Whitfield (reviewing attorney) on 4 November 2026.
>
> **Status:** Deviation.
>
> **Discrepancy:** Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in
> Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations
> have no stated end for information that is not a trade secret, which the playbook lists as
> unacceptable.
>
> **Explanation:** The original two-year term in Section 6.1 no longer applies. Nothing else in the
> Agreement or the Amendment limits how long the Section 4 obligations last.
>
> **Cited passages:**
>
> Governing. "Section 6.1 of the Agreement is deleted in its entirety"
> Location: Amendment No. 1 (v1), Section 2, paragraph 3
>
> Supporting. "Sections 4, 5 and 8 survive any termination or expiration of this Agreement"
> Location: Mutual NDA (v1), Section 9.3, paragraph 29
>
> Superseded. "shall continue for two (2) years from the date of each disclosure"
> Location: Mutual NDA (v1), Section 6.1, paragraph 19
>
> **Proposed language** (edited by the reviewer; the workflow's version was approved playbook text,
> adapted): "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2)
> years from the date of each disclosure of Confidential Information, except that obligations with
> respect to any trade secret shall continue for so long as it remains a trade secret under
> applicable law."
>
> Original before edit: "6.1 The obligations of each Receiving Party under Section 4 shall continue
> for three (3) years from the date of each disclosure of Confidential Information, except that
> obligations with respect to any trade secret shall continue for so long as it remains a trade
> secret under applicable law."
>
> **Reviewer note:** The parties agreed two years in February. Propose reinstating it; three years
> from disclosure is the playbook's outer limit if Corvane resists.
>
> **Flagged by the workflow:** nothing.

From the provenance appendix (each field is a line of its own in the memo, and file hashes are
shortened here):

> **Matter:** mat_9147c382ab77b604. **Run:** run_2c61fe2a90b26065, started 4 November 2026.
> **Workflow:** v2, hash 272aaf6a51b7. **Playbook:** parol-nda-recipient 1.0.1 (Parol NDA
> (Recipient)), hash 19ad95165bb5. **Model:** requested simulated parol-simulated-reader; reported
> by the provider: not reported. **Stand-in reader:** The findings in this memorandum were produced
> by a scripted stand-in program, not a language model. They are not an analysis of these documents
> by any model. **Documents:** D1: Mutual NDA, version 1, stated date 2 February 2026, file hash
> 328e84747e99...; D2: Amendment No. 1, version 1, stated date 15 September 2026, file hash
> 28b25c4e42fd.... **Findings:** 8; decided: 8 (accepted 7, edited 1, rejected 0, escalated 0).
> **Exported by:** Dana Whitfield (reviewing attorney) on 4 November 2026 (UTC). Each quotation in
> this memorandum was checked against the stored document text at export. 11 quotation(s) are shown.

**Deviation.** The earlier draft showed a prose paragraph under the heading "4. Confidentiality
duration", a decision by "D. Whitfield", and a provenance count of 5 accepted, 2 edited and 1
escalated. The memo prints labelled fields under the rule's own title and number in playbook order,
carries a "Stand-in reader" line whenever the findings came from a scripted program (the file is
what leaves the system, and the page that said so does not travel with it), and counts what was
decided in the run above.

## The demo playbook

The full fictional playbook, `apps/parol/playbooks/parol-nda-recipient.yaml`, version 1.0.1
(SHA-256 beginning `19ad95165bb5`), copied verbatim. It uses five optional fields that
`@clausewise/playbook` now accepts (`version`, `category`, `fallbackLanguage`, `escalateWhen` and
`hintTopics`); everything else is the existing format.

**Deviation.** The first draft of this document gave version 1.0.0 and no `hintTopics`. Seven
wordings changed while the playbook was built: the `perspective` (where the NDA is mutual,
obligations that bind both parties equally); the `def-1` fallback; the `pds-1` fallback language,
where "for the Purpose" became "for the purposes permitted by this Agreement" because "Purpose" is a
capitalised term the playbook never defines; the `dur-1` fallback; the `over-five-years` text; new
`dur-1` guidance about copies kept under the return clause; and a sentence added to the `ret-1`
guidance. `hintTopics` on `pds-1` and `pds-2` keep a hint raised by advisers from counting for the
compelled-disclosure rule and the reverse, since both rules share the `permitted-disclosures`
category.

```yaml
name: Parol NDA (Recipient)
version: 1.0.1
description: Fictional practice-group playbook for the Parol demonstration. It is invented
  client policy, not a statement of law, and must not be used for a real matter.
contractTypes: [nda]
perspective: We act for the party that expects to receive most of the information under a mutual
  or one-way NDA. The client's exact legal name is given at intake. We want narrow, time-limited,
  workable obligations and, where the NDA is mutual, obligations that bind both parties equally.
rules:
  - id: pty-1
    category: parties
    title: Parties correctly identified
    severity: medium
    required: true
    standard: The agreement names each party by its full legal name and entity type, our client's
      name matches the name given at intake exactly, and it is clear which party discloses and
      which receives, or that both do.
    unacceptable: Our client is named as a different entity, such as a parent or affiliate, or
      affiliates of either party are made parties without being listed by name.
    fallbackLanguage: '[Client legal name], a [jurisdiction] [entity type] ("[Short name]")'
    escalateWhen:
      - id: entity-differs
        text: The agreement names a different entity in our client's group from the one given at
          intake.
    guidance: Correct the entity name in the preamble and the signature block. Never guess an
      entity type.

  - id: def-1
    category: ci-definition
    title: Scope of Confidential Information
    severity: medium
    required: true
    standard: Confidential Information is information marked or identified as confidential, or
      that a reasonable person would understand to be confidential from its nature or the
      circumstances of disclosure.
    fallback: Non-public information disclosed for the purpose of the agreement, whether or not it
      is marked or identified as confidential.
    unacceptable: All information of any kind, in any form, whether or not marked or identified as
      confidential.
    fallbackLanguage: '"Confidential Information" means non-public information disclosed by the
      Disclosing Party to the Receiving Party that is marked or identified as confidential at the
      time of disclosure, or that a reasonable person would understand to be confidential given its
      nature and the circumstances of disclosure.'

  - id: exc-1
    category: exclusions
    title: Four standard exclusions
    severity: high
    required: true
    standard: Confidential Information excludes information that (a) is or becomes public through
      no fault of the recipient, (b) the recipient already knew without a duty of confidence, (c)
      the recipient develops independently without using the discloser's information, and (d) the
      recipient receives from a third party without a duty of confidence.
    unacceptable: Any of the four is missing, or an exclusion requires proof by contemporaneous
      written records only.
    fallbackLanguage: Confidential Information does not include information that (a) is or becomes
      generally available to the public other than through a breach of this Agreement by the
      Receiving Party; (b) was known to the Receiving Party without a duty of confidentiality
      before disclosure; (c) is independently developed by the Receiving Party without use of the
      Disclosing Party's Confidential Information; or (d) is received by the Receiving Party from a
      third party without a duty of confidentiality.

  - id: pds-1
    category: permitted-disclosures
    title: Disclosure to representatives
    severity: medium
    required: true
    hintTopics: [representatives]
    standard: The recipient may share Confidential Information with its and its affiliates'
      employees, officers, contractors and professional advisers who need to know it for the
      purpose and are bound by confidentiality duties no less protective than the agreement.
    unacceptable: Advisers or affiliates are excluded, or each disclosure needs the discloser's
      prior written consent.
    fallbackLanguage: The Receiving Party may disclose Confidential Information to its and its
      affiliates' employees, officers, contractors and professional advisers who need to know it
      for the purposes permitted by this Agreement and who are bound by obligations of
      confidentiality no less protective than those in this Agreement.

  - id: pds-2
    category: permitted-disclosures
    title: Disclosure required by law
    severity: medium
    required: true
    hintTopics: [legal-compulsion]
    standard: A dedicated clause lets the recipient disclose what law, regulation or court order
      requires, with prompt notice to the discloser where legally permitted and reasonably
      practicable.
    unacceptable: No right to make a legally required disclosure, or a duty to resist disclosure at
      the recipient's own cost.
    fallbackLanguage: The Receiving Party may disclose Confidential Information to the extent
      required by law, regulation or order of a court or governmental authority, provided that,
      where legally permitted and reasonably practicable, it gives the Disclosing Party prompt
      notice so that the Disclosing Party may seek a protective order at its own cost.
    guidance: A general duty of confidence elsewhere in the agreement is not such a clause.

  - id: dur-1
    category: duration
    title: Duration of confidentiality obligations
    severity: high
    required: true
    standard: Obligations end three years or less after each disclosure. Continued protection of
      trade secrets for as long as they remain trade secrets is acceptable.
    fallback: Obligations end five years or less after each disclosure, or five years or less
      after the agreement ends.
    unacceptable: Obligations that are perpetual or have no stated end, for information that is
      not a trade secret.
    fallbackLanguage: The obligations of each Receiving Party under this Agreement shall continue
      for three (3) years from the date of each disclosure of Confidential Information, except that
      obligations with respect to any trade secret shall continue for so long as it remains a trade
      secret under applicable law.
    escalateWhen:
      - id: over-five-years
        text: The stated period is longer than five years, counted from whichever event the clause
          uses, but finite, which is a business decision.
    guidance: Copies kept under the return or destruction clause are covered. Protection of them
      for as long as they are held, with no end, is the unacceptable case, while copies that
      remain subject to the agreement stay subject to its own period.

  - id: ret-1
    category: return-destruction
    title: Return or destruction of information
    severity: low
    required: false
    standard: On written request the recipient returns or destroys Confidential Information within
      30 days or longer, and may keep copies required by law or held in routine backups, which
      remain confidential.
    unacceptable: A deadline shorter than 30 days, or a duty to purge routine backups.
    fallbackLanguage: Within thirty (30) days after the Disclosing Party's written request, the
      Receiving Party shall return or destroy the Disclosing Party's Confidential Information,
      except that it may retain copies required by law or held in routine backup systems, which
      remain subject to this Agreement.
    guidance: An officer's certificate of destruction is not a deviation on its own. How long
      retained copies stay protected is tested under dur-1, not here.

  - id: gov-1
    category: governing-law
    title: Governing law and forum
    severity: medium
    required: true
    standard: The agreement is governed by the law of Delaware, New York, or England and Wales, and
      any exclusive forum is in one of those places.
    unacceptable: A governing law or an exclusive forum outside the approved list.
    fallbackLanguage: This Agreement is governed by the laws of the State of Delaware, and the
      parties submit to the exclusive jurisdiction of the state and federal courts located in
      Delaware.
    escalateWhen:
      - id: forum-outside-list
        text: The governing law or exclusive forum is outside the approved list. Forum is a
          business decision for the responsible attorney.
```
