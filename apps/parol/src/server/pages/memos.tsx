import type { MatterSummary, MemoSummary, RatingView } from "../../services/views.js";
import { urls } from "../urls.js";
import { shortHash } from "../views/format.js";
import { Chip, Crumbs, RevealedText, ScrollBox, Section, Time } from "./components.js";
import { RatingSection, type RatingDraft } from "./feedback.js";
import { Layout, csrfField, type Chrome } from "./layout.js";

/**
 * The memos of a matter. The newest is current; one made before the documents or playbook changed
 * stays on record and is marked superseded, because it no longer describes the matter.
 *
 * A review started again on unchanged documents leaves the memo of the earlier review current
 * until the new review is exported (docs/parol/06, gate 5), so "current" alone would read as "the
 * review on screen was exported". When `currentRunId` is given, a current memo that belongs to any
 * other run is labelled as the record of an earlier review, and the page says why. A page that does
 * not know which review is on screen leaves `currentRunId` out and gets the plain labels.
 */
export function MemoList(props: {
  matterId: string;
  memos: MemoSummary[];
  /** The review the matter shows now, or null when there is none yet. */
  currentRunId?: string | null | undefined;
}) {
  if (props.memos.length === 0) {
    return <p class="empty">No memo has been exported yet.</p>;
  }
  const earlier = (memo: MemoSummary): boolean =>
    memo.status === "current" &&
    props.currentRunId !== undefined &&
    memo.runId !== props.currentRunId;
  return (
    <>
      <ScrollBox label="Exported memos">
        <table class="data-table">
          <caption class="sr-only">Exported memos</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Exported</th>
              <th scope="col">By</th>
              <th scope="col">Review</th>
              <th scope="col">Fingerprint</th>
            </tr>
          </thead>
          <tbody>
            {props.memos.map((memo) => (
              <tr>
                <th scope="row">
                  <a href={urls.memoFile(props.matterId, memo.memoId)} download>
                    <RevealedText value={memo.fileName} />
                  </a>
                </th>
                <td>
                  {earlier(memo) ? (
                    <Chip
                      tone="warn"
                      shape="diamond"
                      title="A newer review of these documents has not been exported."
                    >
                      Earlier review
                    </Chip>
                  ) : memo.status === "current" ? (
                    <Chip tone="ok" shape="circle">
                      Current
                    </Chip>
                  ) : (
                    <Chip
                      tone="neutral"
                      shape="bar"
                      title="The documents or playbook changed after this memo was made."
                    >
                      Superseded
                    </Chip>
                  )}
                </td>
                <td>
                  <Time value={memo.exportedAt} />
                </td>
                <td>
                  <RevealedText value={memo.exportedByName} />
                </td>
                <td>
                  <a href={urls.run(props.matterId, memo.runId)}>
                    {earlier(memo) ? "Open the earlier review" : "Open the review"}
                  </a>
                </td>
                <td>
                  <code class="hash" title={memo.fileSha256}>
                    {shortHash(memo.fileSha256, 12)}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
      {props.memos.some(earlier) ? (
        <p class="hint">
          A memo marked Earlier review records a previous review of these documents. A newer review
          has been started and has not been exported.
        </p>
      ) : null}
    </>
  );
}

/** The export button. When it cannot work the reason is printed beside it, not hidden in a hover. */
export function ExportMemoForm(props: {
  chrome: Chrome;
  matterId: string;
  /** Null when the button works; otherwise a fixed phrase saying why not. */
  blockedReason: string | null;
}) {
  const reasonId = "export-reason";
  return (
    <form method="post" action={urls.memos(props.matterId)} class="stack">
      {csrfField(props.chrome.csrfToken)}
      <div class="actions">
        <button
          type="submit"
          class="button button-primary"
          disabled={props.blockedReason !== null}
          aria-describedby={props.blockedReason === null ? undefined : reasonId}
        >
          Export memo
        </button>
      </div>
      {props.blockedReason === null ? (
        <p class="hint">
          The export checks that every current finding has a current decision, and re-checks every
          quotation against the stored text.
        </p>
      ) : (
        <p class="hint" id={reasonId}>
          {props.blockedReason}
        </p>
      )}
    </form>
  );
}

export interface MemosPageProps {
  chrome: Chrome;
  matter: MatterSummary;
  memos: MemoSummary[];
  /** Whether the signed-in user may export. */
  canExport: boolean;
  /** Why the export button is disabled, as a fixed phrase, or null. */
  exportBlockedReason: string | null;
  /** The review the matter shows now, or null when there is none. See `MemoList`. */
  currentRunId?: string | null | undefined;
  /**
   * The rating section (package W2.6a), shown to every member, not only to those who can export.
   * `given` is the signed-in person's own rating and nobody else's; `runId` is the review the newest
   * memo was made from. A page made without it has no rating section.
   */
  rating?:
    | {
        hasMemo: boolean;
        given: RatingView | null;
        runId: string | null;
        draft?: RatingDraft | undefined;
      }
    | undefined;
}

export function MemosPage(props: MemosPageProps) {
  return (
    <Layout title={`Memos for ${props.matter.name}`} chrome={props.chrome}>
      <Crumbs
        items={[
          { label: "Matters", href: urls.matters() },
          { label: props.matter.name, href: urls.matter(props.matter.id) },
          { label: "Memos" },
        ]}
      />
      <h1>Memos</h1>
      <Section id="memo-list" title="Exported memos">
        <MemoList
          matterId={props.matter.id}
          memos={props.memos}
          currentRunId={props.currentRunId}
        />
      </Section>
      {props.canExport ? (
        <Section id="export" title="Export a memo">
          <ExportMemoForm
            chrome={props.chrome}
            matterId={props.matter.id}
            blockedReason={props.exportBlockedReason}
          />
        </Section>
      ) : null}
      {props.rating === undefined ? null : (
        <RatingSection
          chrome={props.chrome}
          matterId={props.matter.id}
          hasMemo={props.rating.hasMemo}
          given={props.rating.given}
          runId={props.rating.runId}
          draft={props.rating.draft}
        />
      )}
    </Layout>
  );
}
