import { EVIDENCE_ROLES, REVIEW_DECISIONS, STATUSES } from "../../contracts.js";
import type { CheckResult, EvidenceRole, ReviewDecision, Status } from "../../contracts.js";
import type { EvidenceView, FindingView, ReviewHistoryItem } from "../../services/views.js";
import { urls } from "../urls.js";
import { shortHash } from "../views/format.js";
import { confirmedRange, type Offsets } from "../views/highlight.js";
import {
  DECISION_HINT,
  DECISION_VERB,
  ROLE_ORDER,
  ROLE_LABEL,
  STATUS_LABEL,
  categoryLabel,
  checkKindLabel,
  checkLabel,
  checkOutcomeLabel,
  escalationMeaning,
  fallbackBasisLabel,
  roleLabel,
  statusLabel,
  statusMeaning,
} from "../views/labels.js";
import {
  Chip,
  Crumbs,
  DecisionChip,
  Heading,
  EscalationChip,
  Field,
  HighlightedText,
  QuoteCheckChip,
  RevealedText,
  ReviewChip,
  RoleChip,
  SeverityChip,
  StatusChip,
  SupportCheckChip,
  Time,
  decisionValidity,
  idPart,
  textareaValue,
} from "./components.js";
import { FIELDS, evidenceRoleField } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";

/**
 * What the reviewer had typed into the decision form when it was refused, so the page can show it
 * again and nothing typed is lost. Every field is optional: a field that is missing shows the
 * finding's own value. The route builds it from the posted form (routes/decision.ts) and keeps
 * only choices that exist and text of a bounded length.
 */
export interface DecisionDraft {
  decision?: ReviewDecision;
  reason?: string;
  status?: Status;
  discrepancy?: string;
  fallbackLanguage?: string;
  /** Labels by evidence id. */
  roles?: Readonly<Record<string, EvidenceRole>>;
}

export interface FindingPaneProps {
  chrome: Chrome;
  matterId: string;
  finding: FindingView;
  /** Shown in the decision form in place of the finding's own values, after a refused decision. */
  draft?: DecisionDraft | undefined;
  /**
   * The level of the pane's title. Beside the issue table it is a section of the page (2); on a
   * page of its own it is the page title (1). Everything inside follows from it.
   */
  level?: 1 | 2;
}

/** Said when a finding is out of date, whatever the service says, so the reason is never blank. */
export const STALE_FINDING_REASON =
  "This finding is out of date because the documents or the playbook changed. Run the review again to decide it.";
export const CANNOT_DECIDE_REASON = "You cannot decide this finding.";

/** Exactly what the unverified quote says, so a test and a reader see the same words. */
export const UNVERIFIED_QUOTE_NOTE = "not found in the document, never exported";

/**
 * Said, in place of "Quote found", when the service calls a quote verified but the position it
 * recorded does not point at that quote in the paragraph shown. The page then cannot show the
 * reader the quote in place, and says so instead of claiming it did.
 */
export const POSITION_NOT_CONFIRMED = "Position not confirmed";

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/**
 * A paragraph longer than this scrolls inside its own box, which then needs a tab stop so a
 * keyboard user can scroll it. Shorter ones show in full and add no stop.
 */
const LONG_TEXT = 1500;

type Lv = 1 | 2 | 3 | 4 | 5 | 6;

/** The paragraph, with `range` marked when there is one. `range` has been checked against the quote. */
function ParagraphText(props: { evidence: EvidenceView; range: Offsets | null }) {
  const { evidence } = props;
  if (evidence.spanText === "") {
    return <p class="muted">The text of this paragraph is not available.</p>;
  }
  const body = <HighlightedText text={evidence.spanText} offsets={props.range} />;
  return (
    <blockquote
      class={evidence.spanText.length > LONG_TEXT ? "doc-text long" : "doc-text"}
      tabindex={evidence.spanText.length > LONG_TEXT ? 0 : undefined}
    >
      {evidence.role === "superseded" ? <del class="superseded-text">{body}</del> : body}
    </blockquote>
  );
}

function Passage({ evidence, level }: { evidence: EvidenceView; level: Lv }) {
  const base = `passage-${idPart(evidence.evidenceId)}`;
  const superseded = evidence.role === "superseded";
  const verified = evidence.quoteCheck === "verified";
  // The service's offsets are trusted only as far as the text they cover is the quote.
  const range = verified
    ? confirmedRange(evidence.spanText, evidence.offsets, evidence.quote)
    : null;
  const placed = range !== null;
  const misplaced = verified && evidence.offsets !== null && !placed;
  const roleClass = EVIDENCE_ROLES.find((r) => r === evidence.role) ?? "unknown";
  return (
    <article
      class={`passage role-${roleClass}${superseded ? " is-superseded" : ""}`}
      aria-labelledby={`${base}-where`}
      data-passage=""
    >
      <header class="passage-head">
        <Heading level={level} id={`${base}-where`} class="location">
          <RevealedText value={evidence.location} />
        </Heading>
        <p class="chips">
          <RoleChip role={evidence.role} />
          {misplaced ? (
            <Chip
              tone="warn"
              shape="diamond"
              title="The service reports the quote as found, but the position it recorded does not point at the quote in this paragraph."
            >
              {POSITION_NOT_CONFIRMED}
            </Chip>
          ) : (
            <QuoteCheckChip check={evidence.quoteCheck} />
          )}
          <SupportCheckChip check={evidence.supportCheck} />
        </p>
      </header>

      {superseded ? (
        <p class="passage-note">
          <strong>Superseded.</strong> A later passage replaces this one, so it is struck through.
          It is shown for context and no longer applies.
        </p>
      ) : null}

      {placed ? (
        <ParagraphText evidence={evidence} range={range} />
      ) : evidence.quoteCheck === "not_found" ? (
        <>
          <p class="unverified">
            <del class="unverified-quote">
              <RevealedText value={evidence.quote} />
            </del>
          </p>
          <p class="unverified-note">
            <strong>Quote not verified:</strong> {UNVERIFIED_QUOTE_NOTE}.
          </p>
          {evidence.spanText === "" ? null : (
            <details class="disclosure">
              <summary>Show the paragraph it was cited from</summary>
              <ParagraphText evidence={evidence} range={null} />
            </details>
          )}
        </>
      ) : (
        <>
          <p class="passage-note">
            {evidence.quoteCheck === "ambiguous"
              ? "The quote appears more than once in this paragraph, so it is not highlighted."
              : misplaced
                ? "The recorded position of the quote does not match this paragraph, so it is not highlighted."
                : "The position of the quote in this paragraph was not recorded, so it is not highlighted."}
          </p>
          <p class="quoted-label">Quoted:</p>
          <blockquote class="doc-text quoted">
            {superseded ? (
              <del class="superseded-text">
                <RevealedText value={evidence.quote} />
              </del>
            ) : (
              <RevealedText value={evidence.quote} />
            )}
          </blockquote>
          <ParagraphText evidence={evidence} range={null} />
        </>
      )}
    </article>
  );
}

function EvidenceSection({ finding, level }: { finding: FindingView; level: Lv }) {
  const sorted = [...finding.evidence].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  const conflicting = sorted.filter((e) => e.role === "conflicting");
  const others = sorted.filter((e) => e.role !== "conflicting");
  return (
    <section class="pane-section" aria-labelledby="evidence-heading">
      <Heading level={level} id="evidence-heading">
        Evidence
      </Heading>
      {sorted.length === 0 ? (
        <p class="empty">This finding cites no passage.</p>
      ) : (
        <>
          {others.length === 0 ? null : (
            <div class="passages">
              {others.map((evidence) => (
                <Passage evidence={evidence} level={(level + 1) as Lv} />
              ))}
            </div>
          )}
          {conflicting.length === 0 ? null : (
            <div class="conflict-group">
              <p class="conflict-lead">
                <strong>These passages disagree.</strong> They are shown side by side. The documents
                do not settle which one governs.
              </p>
              <div class="passages passages-conflict">
                {conflicting.map((evidence) => (
                  <Passage evidence={evidence} level={(level + 1) as Lv} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Checks, rule, suggestion
// ---------------------------------------------------------------------------------------------

function CheckItem({ check }: { check: CheckResult }) {
  const look =
    check.outcome === "pass"
      ? ({ tone: "ok", shape: "circle" } as const)
      : check.outcome === "fail"
        ? ({ tone: "bad", shape: "triangle" } as const)
        : ({ tone: "neutral", shape: "bar" } as const);
  return (
    <li class="check-item">
      <Chip tone={look.tone} shape={look.shape}>
        {checkOutcomeLabel(check.outcome)}
      </Chip>
      <div class="check-body">
        <p class="check-name">{checkLabel(check.id)}</p>
        <p class="check-kind">{checkKindLabel(check.kind)}</p>
        {check.detail === "" ? null : (
          <p class="technical">
            <RevealedText value={check.detail} />
          </p>
        )}
      </div>
    </li>
  );
}

function ChecksSection({ checks, level }: { checks: CheckResult[]; level: Lv }) {
  const passed = checks.filter((c) => c.outcome === "pass").length;
  const failed = checks.filter((c) => c.outcome === "fail").length;
  const skipped = checks.length - passed - failed;
  return (
    <section class="pane-section" aria-labelledby="checks-heading">
      <Heading level={level} id="checks-heading">
        Checks
      </Heading>
      {checks.length === 0 ? (
        <p class="empty">No checks were recorded for this finding.</p>
      ) : (
        <>
          <p class="muted">
            {passed} passed, {failed} failed, {skipped} not applicable.
          </p>
          <ul class="checks">
            {checks.map((check) => (
              <CheckItem check={check} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RuleSection({ finding, level }: { finding: FindingView; level: Lv }) {
  const { rule } = finding;
  return (
    <section class="pane-section" aria-labelledby="rule-heading">
      <Heading level={level} id="rule-heading">
        Playbook rule (<RevealedText value={`${rule.playbook.slug} ${rule.playbook.version}`} />)
      </Heading>
      <dl class="facts">
        <dt>Standard</dt>
        <dd>
          <RevealedText value={rule.standard} />
        </dd>
        {rule.fallback === null ? null : (
          <>
            <dt>Fallback</dt>
            <dd>
              <RevealedText value={rule.fallback} />
            </dd>
          </>
        )}
        {rule.unacceptable === null ? null : (
          <>
            <dt>Unacceptable</dt>
            <dd>
              <RevealedText value={rule.unacceptable} />
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function FindingSection({ finding, level }: { finding: FindingView; level: Lv }) {
  const { issue } = finding;
  return (
    <section class="pane-section" aria-labelledby="found-heading">
      <Heading level={level} id="found-heading">
        What the review found
      </Heading>
      <p class="muted">{statusMeaning(issue.status)}</p>
      <dl class="facts">
        <dt>Discrepancy</dt>
        <dd class="prose">
          {finding.discrepancy === "" ? (
            <span class="muted">None stated.</span>
          ) : (
            <RevealedText value={finding.discrepancy} />
          )}
        </dd>
        <dt>Explanation</dt>
        <dd class="prose">
          {finding.explanation === "" ? (
            <span class="muted">None stated.</span>
          ) : (
            <RevealedText value={finding.explanation} />
          )}
        </dd>
        {finding.conflict === null ? null : (
          <>
            <dt>Conflict</dt>
            <dd class="prose">
              <RevealedText value={finding.conflict} />
            </dd>
          </>
        )}
        {finding.abstainReason === null ? null : (
          <>
            <dt>Why no status was given</dt>
            <dd class="prose">
              <RevealedText value={finding.abstainReason} />
            </dd>
          </>
        )}
      </dl>
      {issue.escalations.length === 0 ? null : (
        <div class="escalations">
          <Heading level={(level + 1) as Lv}>Flags for the reviewer</Heading>
          <ul class="escalation-list">
            {issue.escalations.map((escalation) => (
              <li>
                <EscalationChip code={escalation.code} />
                <p class="flag-meaning">{escalationMeaning(escalation.code)}</p>
                {escalation.detail === "" ? null : (
                  <p class="technical">
                    <RevealedText value={escalation.detail} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SuggestionSection({ finding, level }: { finding: FindingView; level: Lv }) {
  const approved = finding.rule.fallbackLanguage;
  return (
    <section class="pane-section" aria-labelledby="suggestion-heading">
      <Heading level={level} id="suggestion-heading">
        Suggested language
      </Heading>
      {finding.fallbackLanguage === null ? (
        <p class="empty">No language is suggested for this finding.</p>
      ) : (
        <>
          <blockquote class="doc-text suggestion">
            <RevealedText value={finding.fallbackLanguage} />
          </blockquote>
          <p class="basis">
            <strong>Basis:</strong> {fallbackBasisLabel(finding.fallbackBasis)}.
          </p>
        </>
      )}
      {approved === null ? null : (
        <details class="disclosure">
          <summary>Approved wording from the playbook</summary>
          <blockquote class="doc-text">
            <RevealedText value={approved} />
          </blockquote>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------

function DecisionForm({ chrome, matterId, finding, draft }: FindingPaneProps) {
  const { issue } = finding;
  const current = finding.reviews.find((r) => r.validity === "current");
  return (
    <form
      method="post"
      action={urls.review(matterId, issue.findingId)}
      class="stack decision-form"
      data-decision-form=""
    >
      {csrfField(chrome.csrfToken)}
      <input type="hidden" name={FIELDS.findingContentSha256} value={finding.contentSha256} />

      {current === undefined ? null : (
        <p class="hint">
          Currently <strong>{statusFor(current.decision)}</strong> by{" "}
          <RevealedText value={current.reviewerName} />. Saving a new decision replaces it.
        </p>
      )}

      <fieldset class="choices">
        <legend>Your decision</legend>
        {REVIEW_DECISIONS.map((decision) => (
          <div class="choice">
            <input
              type="radio"
              id={`decision-${decision}`}
              name={FIELDS.decision}
              value={decision}
              checked={draft?.decision === decision}
              required
              aria-describedby={`decision-${decision}-hint`}
            />
            <label for={`decision-${decision}`}>{DECISION_VERB[decision]}</label>
            <p class="hint" id={`decision-${decision}-hint`}>
              {DECISION_HINT[decision]}
            </p>
          </div>
        ))}
      </fieldset>

      <Field
        id="decision-reason"
        label="Reason"
        hint="Required for edit, reject and escalate. It is kept with the decision and printed in the memo."
      >
        <textarea
          id="decision-reason"
          name={FIELDS.reason}
          rows={3}
          aria-describedby="decision-reason-hint"
        >
          {textareaValue(draft?.reason ?? "")}
        </textarea>
      </Field>

      <fieldset class="edits">
        <legend>Edits, used only when you choose Edit</legend>
        <Field id="edit-status" label="Status">
          <select id="edit-status" name={FIELDS.status}>
            {STATUSES.map((status) => (
              <option value={status} selected={status === (draft?.status ?? issue.status)}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </Field>
        {/* The edit fields hold the text exactly as stored, direction controls included, because
            whatever is shown here is posted back and compared with the finding. The rest of the
            pane prints those characters as visible markers. A browser posts every line break as
            CR LF, so a route passes each posted field through normalizeNewlines (forms.ts) before
            it compares it with the finding. */}
        <Field id="edit-discrepancy" label="Discrepancy">
          <textarea id="edit-discrepancy" name={FIELDS.discrepancy} rows={5}>
            {textareaValue(draft?.discrepancy ?? finding.discrepancy)}
          </textarea>
        </Field>
        <Field id="edit-fallback" label="Fallback language">
          <textarea id="edit-fallback" name={FIELDS.fallbackLanguage} rows={6}>
            {textareaValue(draft?.fallbackLanguage ?? finding.fallbackLanguage ?? "")}
          </textarea>
        </Field>
        {finding.evidence.length === 0 ? null : (
          <fieldset class="roles">
            <legend>How each passage is labelled</legend>
            {finding.evidence.map((evidence) => {
              const id = `role-${idPart(evidence.evidenceId)}`;
              return (
                <div class="field field-inline">
                  <label for={id}>
                    <RevealedText value={evidence.location} />
                  </label>
                  <select id={id} name={evidenceRoleField(evidence.evidenceId)}>
                    {EVIDENCE_ROLES.map((role) => (
                      <option
                        value={role}
                        selected={role === (draft?.roles?.[evidence.evidenceId] ?? evidence.role)}
                      >
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </fieldset>
        )}
      </fieldset>

      <p class="binding">
        You are deciding{" "}
        <strong>
          <RevealedText value={issue.ruleKey} />
        </strong>{" "}
        as shown (content hash{" "}
        <code class="hash" title={finding.contentSha256}>
          {shortHash(finding.contentSha256, 12)}
        </code>
        ). The decision is bound to this exact finding. If the documents or the playbook change, it
        becomes stale: it no longer counts and has to be made again.
      </p>
      <div class="actions">
        <button type="submit" class="button button-primary">
          Save decision
        </button>
      </div>
    </form>
  );
}

const statusFor = (decision: ReviewDecision): string =>
  ({ accept: "accepted", edit: "edited", reject: "rejected", escalate: "escalated" })[decision] ??
  "decided";

function DecisionSection(props: FindingPaneProps & { sectionLevel: Lv }) {
  const { finding } = props;
  const stale = finding.issue.validity === "stale";
  const allowed = finding.canDecide.allowed && !stale;
  // The service gives a fixed phrase; a blank one would leave the reader with no explanation.
  const given = finding.canDecide.reason;
  const reason = stale
    ? STALE_FINDING_REASON
    : given !== null && given.trim() !== ""
      ? given
      : CANNOT_DECIDE_REASON;
  return (
    <section class="pane-section" id="decision" aria-labelledby="decision-heading">
      <Heading level={props.sectionLevel} id="decision-heading">
        Decision
      </Heading>
      {allowed ? (
        <DecisionForm {...props} />
      ) : (
        <p class="decision-blocked" role="note">
          <strong>This finding cannot be decided here.</strong> <RevealedText value={reason} />
        </p>
      )}
    </section>
  );
}

function EditSummary(props: { item: ReviewHistoryItem; finding: FindingView }) {
  const { edits } = props.item;
  if (edits === null) return null;
  const roleChanges = edits.evidenceRoles ?? [];
  return (
    <ul class="edit-list">
      {edits.status === undefined ? null : <li>Status set to {statusLabel(edits.status)}.</li>}
      {edits.discrepancy === undefined ? null : (
        <li>
          Discrepancy changed to:
          <blockquote class="doc-text">
            <RevealedText value={edits.discrepancy} />
          </blockquote>
        </li>
      )}
      {edits.fallbackLanguage === undefined ? null : (
        <li>
          Fallback language changed to:
          <blockquote class="doc-text">
            <RevealedText value={edits.fallbackLanguage} />
          </blockquote>
        </li>
      )}
      {roleChanges.map((change) => {
        const where = props.finding.evidence.find((e) => e.evidenceId === change.evidenceId);
        return (
          <li>
            {where === undefined ? "A passage" : <RevealedText value={where.location} />} relabelled{" "}
            {roleLabel(change.role)}.
          </li>
        );
      })}
    </ul>
  );
}

function HistorySection({ finding, level }: { finding: FindingView; level: Lv }) {
  return (
    <section class="pane-section" aria-labelledby="history-heading">
      <Heading level={level} id="history-heading">
        Review history
      </Heading>
      {finding.reviews.length === 0 ? (
        <p class="empty">Nobody has decided this finding yet.</p>
      ) : (
        <ol class="history">
          {finding.reviews.map((item) => (
            <li class={item.validity === "stale" ? "is-stale" : ""}>
              <p>
                <DecisionChip decision={item.decision} />{" "}
                {item.validity === "stale" ? (
                  <Chip
                    tone="neutral"
                    shape="bar"
                    title="The documents or playbook changed after this was decided."
                  >
                    Out of date
                  </Chip>
                ) : (
                  <Chip tone="info" shape="circle">
                    Current
                  </Chip>
                )}
              </p>
              <p class="muted">
                <RevealedText value={item.reviewerName} />, <Time value={item.at} />
              </p>
              {item.reason === null ? null : (
                <blockquote class="doc-text reason">
                  <RevealedText value={item.reason} />
                </blockquote>
              )}
              <EditSummary item={item} finding={finding} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------------------------

/**
 * The evidence inspector and the decision form for one finding. It stands beside the issue table
 * and can also be the body of a page of its own.
 */
export function FindingPane(props: FindingPaneProps) {
  const { finding } = props;
  const { issue } = finding;
  const decidable = finding.canDecide.allowed && issue.validity === "current";
  const title: Lv = props.level ?? 2;
  const level = (title + 1) as Lv;
  return (
    <article class="finding-pane" aria-labelledby="finding-heading" data-finding={issue.findingId}>
      <header class="pane-head">
        <p class="eyebrow">
          {categoryLabel(issue.category)}, rule{" "}
          <code class="rule-key">
            <RevealedText value={issue.ruleKey} />
          </code>
        </p>
        <Heading level={title} id="finding-heading">
          <RevealedText value={issue.ruleTitle} />
        </Heading>
        <p class="chips">
          <SeverityChip severity={issue.severity} />
          <StatusChip status={issue.status} />
          <ReviewChip
            decision={issue.review?.decision ?? null}
            validity={decisionValidity(issue)}
          />
        </p>
        {issue.escalations.length === 0 ? null : (
          <p class="chips">
            {issue.escalations.map((escalation) => (
              <EscalationChip code={escalation.code} />
            ))}
          </p>
        )}
        {issue.validity === "stale" ? (
          <p class="banner banner-stale">
            <strong>Out of date.</strong> {STALE_FINDING_REASON}
          </p>
        ) : null}
        {decidable ? (
          <p>
            <a href="#decision">Go to the decision</a>
          </p>
        ) : null}
      </header>
      <EvidenceSection finding={finding} level={level} />
      <FindingSection finding={finding} level={level} />
      <ChecksSection checks={finding.checks} level={level} />
      <RuleSection finding={finding} level={level} />
      <SuggestionSection finding={finding} level={level} />
      <DecisionSection {...props} sectionLevel={level} />
      <HistorySection finding={finding} level={level} />
    </article>
  );
}

/** The finding on a page of its own, for the finding URL. */
export function FindingPage(props: FindingPaneProps & { matterName: string }) {
  return (
    <Layout title={props.finding.issue.ruleTitle} chrome={props.chrome}>
      <Crumbs
        items={[
          { label: "Matters", href: urls.matters() },
          { label: props.matterName, href: urls.matter(props.matterId) },
          { label: props.finding.issue.ruleTitle },
        ]}
      />
      <FindingPane
        chrome={props.chrome}
        matterId={props.matterId}
        finding={props.finding}
        draft={props.draft}
        level={1}
      />
    </Layout>
  );
}
