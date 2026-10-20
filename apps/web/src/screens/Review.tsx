import type {
  Decision,
  Finding,
  ModelInfo,
  ResultRow,
  ReviewDetail,
  Severity,
} from "@clausewise/api";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { errorMessage, paths } from "../api/client.js";
import { Button } from "../components/Button.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { FileLink, type SavedFile } from "../components/FileLink.js";
import { FindingCard } from "../components/FindingCard.js";
import { Notice } from "../components/Notice.js";
import { ProgressBar } from "../components/ProgressBar.js";
import { SeverityBadge, SeverityIcon } from "../components/SeverityBadge.js";
import { useAnnounce } from "../hooks/useAnnounce.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle.js";
import { useReview } from "../hooks/useReview.js";
import {
  countBySeverity,
  countDecisions,
  describeNotShown,
  groupBySeverity,
} from "../lib/findings.js";
import {
  RULE_STATUS_LABEL,
  SEVERITY_LABEL,
  disclosureSentence,
  formatDateTime,
  plural,
  redlineFileName,
} from "../lib/format.js";
import { navigate } from "../router.js";
import { useServices } from "../services.js";

export function ReviewScreen(props: { reviewId: string }) {
  const review = useReview(props.reviewId);
  const { load } = review;
  useDocumentTitle(load.status === "ready" ? load.detail.documentName : "Review");

  // The progress panel, with the Cancel button, goes away when the review ends. If the focus was
  // in it, it falls to the top of the page; it goes to the review's own heading instead.
  const heading = useRef<HTMLHeadingElement>(null);
  const wasActive = useRef(false);
  const status = load.status === "ready" ? load.detail.status : null;
  useEffect(() => {
    const active = status === "queued" || status === "running";
    if (wasActive.current && !active && status !== null) {
      const focused = document.activeElement;
      if (focused === null || focused === document.body) heading.current?.focus();
    }
    wasActive.current = active;
  }, [status]);

  if (load.status === "loading") {
    return (
      <div>
        <BackLink />
        <p className="muted" aria-busy="true">
          Opening the review...
        </p>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div>
        <BackLink />
        <h1>This review could not be opened</h1>
        <Notice kind="error">
          <p>{load.message}</p>
        </Notice>
      </div>
    );
  }

  const { detail } = load;
  return (
    <div className="review">
      <BackLink />
      <ReviewHeader detail={detail} headingRef={heading} />
      {detail.status === "queued" || detail.status === "running" ? (
        <ActiveReview detail={detail} review={review} />
      ) : null}
      {detail.status === "failed" ? (
        <Notice kind="error" title="The review did not finish">
          <p className="message-text">
            {detail.error ?? "The server did not say why. Start the review again."}
          </p>
          <p>
            <a href="#/">Go back and start it again</a>
          </p>
        </Notice>
      ) : null}
      {detail.status === "cancelled" ? (
        <Notice kind="info" title="This review was cancelled">
          <p className="message-text">
            {detail.error ?? "It was stopped before it finished, so there are no findings to show."}
          </p>
          <p>
            <a href="#/">Go back and start a new one</a>
          </p>
        </Notice>
      ) : null}
      {detail.status === "done" ? <FinishedReview detail={detail} review={review} /> : null}
      {detail.status === "queued" || detail.status === "running" ? null : (
        <RemovePanel detail={detail} />
      )}
    </div>
  );
}

type ReviewState = ReturnType<typeof useReview>;

/**
 * Takes the contract off the server, with its reviews and findings. The text of a contract is
 * confidential, so getting rid of it is a button on the page and not a task for whoever runs the
 * server.
 */
function RemovePanel(props: { detail: ReviewDetail }) {
  const { detail } = props;
  const { api } = useServices();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    api
      .deleteDocument(detail.documentId)
      .then(() => {
        announce(`${detail.documentName} was deleted from the server.`);
        navigate({ name: "start" });
      })
      .catch((failure: unknown) => {
        // The notice below is an alert, which is read out by itself.
        setError(errorMessage(failure));
        setBusy(false);
      });
  };

  return (
    <section className="remove" aria-label="Delete this contract">
      {error === null ? null : (
        <Notice kind="error" title="The contract was not deleted">
          <p className="message-text">{error}</p>
        </Notice>
      )}
      <ConfirmButton
        label="Delete the contract and its reviews"
        question={`Delete "${detail.documentName}" and every review of it from this server? This can not be undone.`}
        confirmLabel="Delete everything"
        keepLabel="Keep it"
        busy={busy}
        onConfirm={remove}
      />
      <p className="hint">
        Removes the uploaded file, its reviews and your decisions from the server. Files you have
        downloaded stay where they are.
      </p>
    </section>
  );
}

function BackLink() {
  return (
    <p className="back-link">
      <a href="#/">All reviews</a>
    </p>
  );
}

function modelLine(model: ModelInfo): string {
  return `Model: ${model.model} (${model.provider}). ${disclosureSentence(model.disclosure)}`;
}

function ReviewHeader(props: {
  detail: ReviewDetail;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { detail, headingRef } = props;
  return (
    <div className="review-head">
      <h1 ref={headingRef} tabIndex={-1}>
        {detail.documentName}
      </h1>
      <p className="meta">
        Playbook: {detail.playbookName}
        {detail.client === null ? "" : `. Acting for: ${detail.client}`}. Started{" "}
        {formatDateTime(detail.createdAt)}.
      </p>
      {detail.model === null ? null : <p className="meta">{modelLine(detail.model)}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// While it runs
// ---------------------------------------------------------------------------------------------

function ActiveReview(props: { detail: ReviewDetail; review: ReviewState }) {
  const { detail, review } = props;
  const headingId = useId();
  const { done, total } = detail.progress;
  const queued = detail.status === "queued";
  const text = queued
    ? "Waiting for its turn. This page updates by itself."
    : total > 0
      ? `${done} of ${total} rules checked`
      : "Reading the contract...";

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{queued ? "Waiting to start" : "Review in progress"}</h2>
      <ProgressBar done={done} total={queued ? 0 : total} label="Rules checked" />
      <p className="progress-text">{text}</p>
      {review.pollProblem === null ? null : (
        <Notice kind="warning">
          <p className="message-text">{review.pollProblem}</p>
        </Notice>
      )}
      {review.cancelError === null ? null : (
        <Notice kind="error">
          <p className="message-text">{review.cancelError}</p>
        </Notice>
      )}
      <ConfirmButton
        label="Cancel review"
        question="Stop this review? What has been checked so far is thrown away."
        confirmLabel="Stop the review"
        keepLabel="Keep going"
        busy={review.cancelBusy}
        onConfirm={() => {
          void review.cancel();
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// When it is done
// ---------------------------------------------------------------------------------------------

/** Notes the server sent with the files saved from this screen, by kind of file. */
type DownloadNotesByKind = Readonly<Record<string, SavedFile>>;

function FinishedReview(props: { detail: ReviewDetail; review: ReviewState }) {
  const { detail, review } = props;
  const { findings } = detail;
  const { decide, saveEdit, reset, bulk, rowBusy, rowErrors, bulkBusy, bulkError } = review;
  const saving = bulkBusy || rowBusy.size > 0;
  const notShown = describeNotShown(detail.notShown);
  const errors = detail.results.filter((row) => row.status === "error");
  const quiet = detail.results.filter((row) => row.status !== "error");
  // Recomputed only when the findings change, so the sections below get lists that stay the same
  // across the many small changes of state while a decision is saved.
  const groups = useMemo(() => groupBySeverity(findings), [findings]);

  // What the server said about the files saved here stays until the lawyer dismisses it. A newer
  // file of the same kind replaces the notes about the older one, which no longer describe the
  // file that is wanted.
  const [notes, setNotes] = useState<DownloadNotesByKind>({});
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const noteSaved = useCallback((kind: string, saved: SavedFile): void => {
    setNotes((current) => ({ ...current, [kind]: saved }));
  }, []);
  const dismissNotes = useCallback((kind: string): void => {
    setNotes((current) => {
      const rest: Record<string, SavedFile> = { ...current };
      delete rest[kind];
      return rest;
    });
    // The notice takes the button with it. The summary is where the download buttons are, and the
    // next press of Tab lands on the first of them.
    summaryHeading.current?.focus();
  }, []);

  return (
    <>
      <Summary detail={detail} headingRef={summaryHeading}>
        {findings.length === 0 ? null : (
          <DownloadBlock detail={detail} saving={saving} onSaved={noteSaved} />
        )}
        <DownloadNotes notes={notes} onDismiss={dismissNotes} />
      </Summary>
      {detail.warnings.length === 0 ? null : (
        <Notice kind="warning" title="Read these first">
          <ul>
            {detail.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      {notShown.length === 0 ? null : (
        <Notice kind="info" title="Not shown to the model">
          <p>
            The model did not read these parts of the file: {notShown.join(", ")}. Check them
            yourself.
          </p>
        </Notice>
      )}
      {errors.length === 0 ? null : <CouldNotCheck rows={errors} />}
      {findings.length === 0 ? (
        <p className="empty">
          {errors.length === 0
            ? "No findings. Nothing in this contract departs from the playbook."
            : "No findings, but some rules could not be checked."}
        </p>
      ) : (
        <>
          <BulkBar
            findings={findings}
            busy={saving}
            error={bulkError}
            onBulk={(decision) => void bulk(decision)}
          />
          {groups.map((group) => (
            <SeveritySection
              key={group.severity}
              severity={group.severity}
              findings={group.findings}
              busy={saving}
              bulkBusy={bulkBusy}
              rowBusy={rowBusy}
              rowErrors={rowErrors}
              onBulk={bulk}
              onDecide={decide}
              onSaveEdit={saveEdit}
              onReset={reset}
            />
          ))}
        </>
      )}
      {quiet.length === 0 ? null : <QuietRules rows={quiet} />}
      <FilesPanel detail={detail} onSaved={noteSaved} />
    </>
  );
}

function Summary(props: {
  detail: ReviewDetail;
  headingRef: RefObject<HTMLHeadingElement | null>;
  children?: ReactNode;
}) {
  const { detail, headingRef, children } = props;
  const headingId = useId();
  const bySeverity = countBySeverity(detail.findings);
  const decisions = countDecisions(detail.findings);
  const counts = detail.counts;
  const checked =
    counts === null ? detail.results.length + detail.findings.length : sum(Object.values(counts));

  return (
    <section className="panel summary" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        Summary
      </h2>
      <p>
        {plural(checked, "rule")} checked.{" "}
        <strong>{plural(detail.findings.length, "finding")}</strong>
        {detail.findings.length === 0
          ? ""
          : ` for you to look at: ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low`}
        .
        {counts === null
          ? ""
          : ` ${counts.compliant} met the playbook, ${counts.not_applicable} did not apply, ${counts.error} could not be checked.`}
      </p>
      {detail.findings.length === 0 ? null : (
        <p>
          {decisions.accepted} accepted, {decisions.rejected} rejected, {decisions.pending} not
          decided.
        </p>
      )}
      {children}
    </section>
  );
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/** The download buttons, kept inside the summary so that the first finding is not pushed off the screen. */
function DownloadBlock(props: {
  detail: ReviewDetail;
  saving: boolean;
  onSaved: (kind: string, saved: SavedFile) => void;
}) {
  const { detail, saving, onSaved } = props;
  const reasonId = useId();
  const accepted = detail.findings.filter((f) => f.decision === "accepted").length;
  const notRejected = detail.findings.filter((f) => f.decision !== "rejected").length;
  const name = redlineFileName(detail.documentName);

  const reason = saving
    ? "Your last change is still being saved. Download when it is."
    : accepted === 0
      ? "Accept at least one suggestion to download a redline."
      : null;

  return (
    <div className="download-block" role="group" aria-label="Download">
      <div className="download-row">
        <FileLink
          variant="primary"
          path={paths.docx(detail.id, "accepted")}
          label={`Download redline (${accepted} accepted)`}
          fallbackName={name}
          disabled={reason !== null}
          describedBy={reasonId}
          onSaved={(saved) => onSaved(REDLINE, saved)}
        />
        <FileLink
          variant="link"
          path={paths.docx(detail.id, "all")}
          label="Download with everything not rejected"
          fallbackName={name}
          disabled={saving || notRejected === 0}
          describedBy={reasonId}
          onSaved={(saved) => onSaved(REDLINE, saved)}
        />
      </div>
      {reason === null ? null : (
        <p id={reasonId} className="hint">
          {reason}
        </p>
      )}
      <p className="hint">
        The redline is your contract with the accepted suggestions as Word tracked changes and
        comments. Your original is never changed.
      </p>
    </div>
  );
}

const REDLINE = "redline";

/**
 * What the server noted while building a file, kept on the screen until the lawyer dismisses it.
 * The box is always in the page and the notice is put into it, which is what makes a screen reader
 * read a notice that appears. It is a status and not an alert: the file was saved, and nothing
 * here needs to cut in on what the lawyer is doing.
 */
function DownloadNotes(props: { notes: DownloadNotesByKind; onDismiss: (kind: string) => void }) {
  const { notes, onDismiss } = props;
  const shown = Object.entries(notes).filter(([, saved]) => saved.warnings.length > 0);
  return (
    <div role="status" className="download-notes">
      {shown.map(([kind, saved]) => {
        const many = saved.warnings.length > 1;
        return (
          <Notice
            key={kind}
            kind="warning"
            title={`Saved, with ${plural(saved.warnings.length, "note")} to read`}
          >
            <p className="message-text">
              {`"${saved.fileName}" was still saved. The server noted ${many ? "these things" : "this"} while building it:`}
            </p>
            <ul>
              {saved.warnings.map((warning, index) => (
                <li key={index} className="message-text">
                  {warning}
                </li>
              ))}
            </ul>
            <Button
              className="button button-small"
              aria-label={`Dismiss the notes about ${saved.fileName}`}
              onClick={() => onDismiss(kind)}
            >
              Dismiss
            </Button>
          </Notice>
        );
      })}
    </div>
  );
}

function BulkBar(props: {
  findings: Finding[];
  busy: boolean;
  error: string | null;
  onBulk: (decision: Decision) => void;
}) {
  const { findings, busy, error, onBulk } = props;
  const acceptAll = useRef<HTMLButtonElement>(null);
  const clearPressed = useRef(false);
  const showClear = findings.some((f) => f.decision !== "pending");

  // "Clear all decisions" goes away when nothing is left to clear, and the focus would go with it.
  useEffect(() => {
    if (clearPressed.current && !showClear) {
      clearPressed.current = false;
      acceptAll.current?.focus();
    }
  }, [showClear]);
  useEffect(() => {
    if (!busy) clearPressed.current = false;
  }, [busy]);

  return (
    <div className="bulk-bar">
      <div className="bulk-actions" role="group" aria-label="All findings">
        <Button
          ref={acceptAll}
          className="button"
          unavailable={busy}
          onClick={() => onBulk("accepted")}
        >
          Accept all findings
        </Button>
        <Button className="button" unavailable={busy} onClick={() => onBulk("rejected")}>
          Reject all findings
        </Button>
        {showClear ? (
          <Button
            className="button button-quiet"
            unavailable={busy}
            onClick={() => {
              clearPressed.current = true;
              onBulk("pending");
            }}
          >
            Clear all decisions
          </Button>
        ) : null}
      </div>
      {error === null ? null : (
        <p className="field-error message-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SeveritySection(props: {
  severity: Severity;
  findings: Finding[];
  /** Something is being saved, so the bulk buttons wait. */
  busy: boolean;
  bulkBusy: boolean;
  rowBusy: ReadonlySet<string>;
  rowErrors: Readonly<Record<string, string>>;
  onBulk: ReviewState["bulk"];
  onDecide: ReviewState["decide"];
  onSaveEdit: ReviewState["saveEdit"];
  onReset: ReviewState["reset"];
}) {
  const { severity, findings, busy, bulkBusy, rowBusy, rowErrors } = props;
  const { onBulk, onDecide, onSaveEdit, onReset } = props;
  const headingId = useId();
  const word = SEVERITY_LABEL[severity].toLowerCase();
  return (
    <section className="severity-section" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId} className={`severity-heading severity-heading-${severity}`}>
          <SeverityIcon severity={severity} />
          <span className="section-title">{SEVERITY_LABEL[severity]} severity</span>
          <span className="count">({findings.length})</span>
        </h2>
        <div className="section-actions" role="group" aria-label={`All ${word} severity findings`}>
          <Button
            className="button button-small"
            unavailable={busy}
            onClick={() => void onBulk("accepted", [severity])}
          >
            Accept all {word}
          </Button>
          <Button
            className="button button-small"
            unavailable={busy}
            onClick={() => void onBulk("rejected", [severity])}
          >
            Reject all {word}
          </Button>
        </div>
      </div>
      <div className="finding-list">
        {findings.map((finding) => (
          <FindingCard
            key={finding.ruleId}
            finding={finding}
            busy={bulkBusy || rowBusy.has(finding.ruleId)}
            error={rowErrors[finding.ruleId] ?? null}
            onDecide={onDecide}
            onSaveEdit={onSaveEdit}
            onReset={onReset}
          />
        ))}
      </div>
    </section>
  );
}

function CouldNotCheck(props: { rows: ResultRow[] }) {
  const headingId = useId();
  return (
    <section className="panel panel-warning" aria-labelledby={headingId}>
      <h2 id={headingId}>Rules that could not be checked</h2>
      <p>
        These rules were not reviewed. A missing finding for them is not a pass: check them by hand.
      </p>
      <ul className="rule-list">
        {props.rows.map((row) => (
          <li key={row.ruleId}>
            <SeverityBadge severity={row.severity} /> <strong>{row.title}</strong>
            <p>{row.error ?? row.explanation}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuietRules(props: { rows: ResultRow[] }) {
  const { rows } = props;
  return (
    <details className="quiet-rules">
      <summary>Rules with nothing to change ({rows.length})</summary>
      <ul className="rule-list">
        {rows.map((row) => (
          <li key={row.ruleId}>
            <strong>{row.title}</strong>
            <span className="muted">
              {" "}
              {RULE_STATUS_LABEL[row.status]}
              {row.clauseNumbers.length === 0
                ? ""
                : `. ${row.clauseNumbers.length === 1 ? "Clause" : "Clauses"} ${row.clauseNumbers.join(", ")}`}
            </span>
            <p>{row.explanation}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function FilesPanel(props: {
  detail: ReviewDetail;
  onSaved: (kind: string, saved: SavedFile) => void;
}) {
  const { detail, onSaved } = props;
  const stem = detail.documentName.replace(/\.docx$/i, "");
  return (
    <section className="files" aria-label="Other files">
      <ul className="inline-list">
        <li>
          <FileLink
            variant="link"
            path={paths.document(detail.documentId)}
            label="Download the original file"
            fallbackName={detail.documentName}
            onSaved={(saved) => onSaved("original", saved)}
          />
        </li>
        <li>
          <FileLink
            variant="link"
            path={paths.report(detail.id, "md")}
            label="Download the report (Markdown)"
            fallbackName={`${stem} (report).md`}
            onSaved={(saved) => onSaved("report", saved)}
          />
        </li>
      </ul>
    </section>
  );
}
