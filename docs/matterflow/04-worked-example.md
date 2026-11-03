# 4. Worked example

One finding traced from document text to memo. Every party, passage and rule is invented for this
project; any resemblance to a real entity is coincidental. The model outputs below are
**illustrations of the contract shapes and of the hypothesised baseline failure**, written by hand.
No model has produced them.

The example is evaluation case `MF-D05` ([document 5](05-evaluation.md#dataset)), and it is the case
the improvement cycle is built around: an amendment deletes the NDA's only time limit, and a
correct, verifiable quote from the deleted clause supports the wrong conclusion.

## The matter

| Field        | Value                                                           |
| ------------ | --------------------------------------------------------------- |
| Matter       | Lanternfish / Corvane NDA                                       |
| Our client   | Lanternfish Software, Inc.                                      |
| Counterparty | Corvane Data Systems LLC                                        |
| D1           | Mutual NDA (DOCX), version 1, stated date 2 February 2026       |
| D2           | Amendment No. 1 (TXT), version 1, stated date 15 September 2026 |
| Playbook     | `mf-nda-recipient` 1.0.0 (approved)                             |
| Associate    | A. Ruiz (demo identity)                                         |
| Reviewer     | D. Whitfield (demo identity)                                    |

## 1. Document passages

**D1, Mutual NDA (v1)**, the paragraphs that matter here:

| Span label | Clause | Text                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1-p6      | 1.2    | "Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential given its nature and the circumstances of disclosure. |
| D1-p11     | 4.1    | The Receiving Party shall use Confidential Information only to evaluate a possible commercial relationship between the Parties and shall protect it with at least the degree of care it uses for its own information of a similar nature, and no less than reasonable care.                                                                    |
| D1-p19     | 6.1    | The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.                                                                                                                                                                                         |
| D1-p20     | 6.2    | Either Party may terminate this Agreement on thirty (30) days' written notice.                                                                                                                                                                                                                                                                 |
| D1-p23     | 7.2    | Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.                                                          |
| D1-p29     | 9.3    | Sections 4, 5 and 8 survive any termination or expiration of this Agreement.                                                                                                                                                                                                                                                                   |

**D2, Amendment No. 1 (v1)**, the whole document:

| Span label | Clause | Text                                                                                                                                                                                                                                        |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2-p0      |        | AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT                                                                                                                                                                                           |
| D2-p1      |        | This Amendment No. 1 (the "Amendment") is made as of 15 September 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC, and amends the Mutual Nondisclosure Agreement between them dated 2 February 2026 (the "Agreement"). |
| D2-p2      | 1      | Capitalized terms used but not defined in this Amendment have the meanings given in the Agreement.                                                                                                                                          |
| D2-p3      | 2      | Section 6.1 of the Agreement is deleted in its entirety.                                                                                                                                                                                    |
| D2-p4      | 3      | Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".                                                                                                                                      |
| D2-p5      | 4      | Except as amended by this Amendment, the Agreement remains in full force and effect.                                                                                                                                                        |

D2-p3 is the trap. It changes the duration of every obligation, but it contains none of the words a
reader scanning for "duration" would look for: no number, no "years", no "survive".

## 2. Playbook rule

```yaml
- id: dur-1
  category: duration
  title: Duration of confidentiality obligations
  severity: high
  required: true
  standard: Obligations end three years or less after each disclosure. Continued protection of
    trade secrets for as long as they remain trade secrets is acceptable.
  fallback: Obligations end five years or less after the agreement ends.
  unacceptable: Obligations that are perpetual or have no stated end, for information that is not a
    trade secret.
  fallbackLanguage: The obligations of each Receiving Party under this Agreement shall continue for
    three (3) years from the date of each disclosure of Confidential Information, except that
    obligations with respect to any trade secret shall continue for so long as it remains a trade
    secret under applicable law.
  escalateWhen:
    - id: over-five-years
      text: The stated period is longer than the fallback but finite, which is a business decision.
```

## 3. Through the stages

**ingest** (deterministic). Spans as above, plus annotations:

```json
[
  { "kind": "cross_reference", "spanId": "dv_d2v1:p3", "target": "6.1", "verb": "deletes" },
  { "kind": "cross_reference", "spanId": "dv_d2v1:p4", "target": "7.2", "verb": "amends" },
  { "kind": "defines_term", "spanId": "dv_d1v1:p6", "term": "Confidential Information" },
  { "kind": "defines_term", "spanId": "dv_d1v1:p6", "term": "Receiving Party" },
  { "kind": "keyword_hint", "spanId": "dv_d1v1:p19", "category": "duration" },
  { "kind": "keyword_hint", "spanId": "dv_d1v1:p29", "category": "duration" }
]
```

**extract** (model, then quote check). Hypothesised locator output for `duration`: D1-p19 with the
quote "shall continue for two (2) years from the date of each disclosure" (verified). D1-p29 is a
hint the locator did not select. D2-p3 is neither located nor hinted.

**retrieve** (deterministic). The bundle for `dur-1`:

| Span   | Why included under R1 (baseline) | Under R2 (revision)                           |
| ------ | -------------------------------- | --------------------------------------------- |
| D1-p19 | located                          | located                                       |
| D1-p6  | definition of terms D1-p19 uses  | definition                                    |
| D1-p29 | keyword hint                     | keyword hint                                  |
| D2-p3  | **not included**                 | cross_reference: deletes 6.1, which D1-p19 is |

### Baseline (workflow v1: prompts P1, retrieval R1), the hypothesised failure

Analyze returns:

```json
{
  "status": "compliant",
  "evidence": [
    {
      "span": "D1-p19",
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

Verify under v1:

| Check                 | Kind          | Outcome | Why                                                                 |
| --------------------- | ------------- | ------- | ------------------------------------------------------------------- |
| `quote_exists`        | deterministic | pass    | The quote occurs once in D1-p19                                     |
| `citation_shape`      | deterministic | pass    | Compliant with one verified governing quote                         |
| `numeric_consistency` | deterministic | pass    | "two years" appears in the quote as "two (2) years"                 |
| `support`             | model         | pass    | Shown only D1-p19, the checker correctly says it supports the claim |

Result: a verified, **wrong** `compliant` on a high-severity rule, with a valid quote. Every check
did its job; none of them could see the amendment. This is why quotation validity and local support
are not enough, and why the failure is worth a controlled fix.

### Revision (workflow v2: prompts P1, retrieval R2)

The only change is retrieval: amendment spans that cross-reference a located clause are included.
Analyze returns:

```json
{
  "status": "deviation",
  "evidence": [
    {
      "span": "D2-p3",
      "quote": "Section 6.1 of the Agreement is deleted in its entirety",
      "role": "governing"
    },
    {
      "span": "D1-p19",
      "quote": "shall continue for two (2) years from the date of each disclosure",
      "role": "superseded"
    },
    {
      "span": "D1-p29",
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

Verify under v2:

| Check                 | Kind          | Outcome        | Why                                                                                    |
| --------------------- | ------------- | -------------- | -------------------------------------------------------------------------------------- |
| `quote_exists`        | deterministic | pass           | All three quotes occur once in their spans                                             |
| `span_in_bundle`      | deterministic | pass           | D2-p3, D1-p19 and D1-p29 were all in the bundle                                        |
| `citation_shape`      | deterministic | pass           | Deviation with a verified governing quote                                              |
| `precedence`          | deterministic | pass           | D2-p3 deletes 6.1; D2 is dated after D1; D1-p19 is correctly labelled superseded       |
| `numeric_consistency` | deterministic | not applicable | The discrepancy states no number; the fallback's "three (3) years" comes from the rule |
| `support`             | model         | pass           | Given D2-p3, D1-p19 and D1-p29 and nothing else, the checker says the claim follows    |
| `fallback_basis`      | deterministic | pass           | Approved text adapted: "this Agreement" became "Section 4", "6.1" prefix added         |

## 4. The finding as the issue table shows it

| Field                        | Value                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue category               | Confidentiality duration                                                                                                                                                                                                                                                                                                                                                                   |
| Supporting passage, location | "Section 6.1 of the Agreement is deleted in its entirety" (Amendment No. 1 (v1), Section 2, paragraph 3), governing. "shall continue for two (2) years from the date of each disclosure" (Mutual NDA (v1), Section 6.1, paragraph 19), superseded. "Sections 4, 5 and 8 survive any termination or expiration of this Agreement" (Mutual NDA (v1), Section 9.3, paragraph 29), supporting. |
| Applicable playbook rule     | DUR-1, MF NDA (Recipient) 1.0.0. Standard: three years or less after each disclosure. Unacceptable: no stated end for non-trade-secret information.                                                                                                                                                                                                                                        |
| Discrepancy and explanation  | As in the analysis output above.                                                                                                                                                                                                                                                                                                                                                           |
| Suggested fallback language  | As in the analysis output above. Basis: approved playbook text, adapted.                                                                                                                                                                                                                                                                                                                   |
| Review status or escalation  | Verified; no escalation. Awaiting review.                                                                                                                                                                                                                                                                                                                                                  |

## 5. Review decision

D. Whitfield opens the evidence, reads D2-p3 in place, and edits the fallback to restore the term
the parties had already agreed:

```json
{
  "decision": "edit",
  "findingContentSha256": "51be0c...",
  "edits": {
    "fallbackLanguage": "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law."
  },
  "reason": "The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists."
}
```

The decision is bound to the finding's content hash. If Corvane later sends a revised amendment and
it is uploaded as D2 version 2, this decision becomes stale and the memo cannot be exported until
the matter is re-run and the new finding decided.

## 6. Memo excerpt

The exported DOCX has a heading block, a summary table of all eight rules, one section per finding,
a list of open escalations, and a provenance appendix. The DUR-1 section reads:

> **MEMORANDUM: DRAFT FOR ATTORNEY REVIEW. SYNTHETIC DEMONSTRATION, NOT LEGAL ADVICE.**
>
> **Re:** Lanternfish / Corvane Mutual NDA and Amendment No. 1, review against MF NDA (Recipient)
> playbook 1.0.0
>
> **4. Confidentiality duration (DUR-1, high severity): deviation.** Decided by D. Whitfield on
> 3 November 2026 (edited).
>
> Amendment No. 1 deletes Section 6.1 of the Agreement in its entirety ("Section 6.1 of the
> Agreement is deleted in its entirety"; Amendment No. 1, v1, Section 2, paragraph 3). Section 6.1
> was the only time limit on the Receiving Party's obligations under Section 4 ("shall continue for
> two (2) years from the date of each disclosure"; Mutual NDA, v1, Section 6.1, paragraph 19, now
> superseded), and Section 9.3 keeps Section 4 in force after termination ("Sections 4, 5 and 8
> survive any termination or expiration of this Agreement"; Mutual NDA, v1, Section 9.3, paragraph
> 29). As amended, the obligations have no stated end for information that is not a trade secret,
> which the playbook does not accept.
>
> **Proposed language** (reviewer edit of the approved playbook text): reinstate Section 6.1 as
> follows: "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2)
> years from the date of each disclosure of Confidential Information, except that obligations with
> respect to any trade secret shall continue for so long as it remains a trade secret under
> applicable law."
>
> **Reviewer note:** The parties agreed two years in February. Three years from disclosure is the
> playbook's outer limit if Corvane resists.

From the provenance appendix:

> Run r_0142, workflow v2 (sha 4d1e...), playbook mf-nda-recipient 1.0.0 (sha a90c...), model as
> reported by the provider: `<model id>`. Inputs: Mutual NDA v1 (sha 3f2a...), Amendment No. 1 v1
> (sha 9c04...). Findings: 8; decided: 8 (accepted 5, edited 2, escalated 1). Exported by
> D. Whitfield, 3 November 2026. Each quotation above was checked against the stored document text
> at export.

## The demo playbook

The full fictional playbook, `playbooks/mf-nda-recipient.yaml`. It uses the four optional fields
proposed for `@clausewise/playbook` (`version`, `category`, `fallbackLanguage`, `escalateWhen`);
everything else is the existing format.

```yaml
name: MF NDA (Recipient)
version: 1.0.0
description: Fictional practice-group playbook for the MatterFlow demonstration. It is invented
  client policy, not a statement of law, and must not be used for a real matter.
contractTypes: [nda]
perspective: We act for the party that expects to receive most of the information under a mutual
  or one-way NDA. The client's exact legal name is given at intake. We want narrow, time-limited,
  workable obligations that bind both parties equally.
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
    fallback: Only information disclosed in writing and marked confidential, or disclosed orally
      and identified as confidential in writing within 30 days.
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
    standard: The recipient may share Confidential Information with its and its affiliates'
      employees, officers, contractors and professional advisers who need to know it for the
      purpose and are bound by confidentiality duties no less protective than the agreement.
    unacceptable: Advisers or affiliates are excluded, or each disclosure needs the discloser's
      prior written consent.
    fallbackLanguage: The Receiving Party may disclose Confidential Information to its and its
      affiliates' employees, officers, contractors and professional advisers who need to know it
      for the Purpose and who are bound by obligations of confidentiality no less protective than
      those in this Agreement.

  - id: pds-2
    category: permitted-disclosures
    title: Disclosure required by law
    severity: medium
    required: true
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
    fallback: Obligations end five years or less after the agreement ends.
    unacceptable: Obligations that are perpetual or have no stated end, for information that is
      not a trade secret.
    fallbackLanguage: The obligations of each Receiving Party under this Agreement shall continue
      for three (3) years from the date of each disclosure of Confidential Information, except that
      obligations with respect to any trade secret shall continue for so long as it remains a trade
      secret under applicable law.
    escalateWhen:
      - id: over-five-years
        text: The stated period is longer than the fallback but finite, which is a business
          decision.

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
    guidance: An officer's certificate of destruction is not a deviation on its own.

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
