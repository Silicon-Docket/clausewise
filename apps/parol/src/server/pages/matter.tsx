import { roleAllows } from "../../auth/actions.js";
import { DOC_LABELS, MATTER_ROLES } from "../../contracts.js";
import type {
  DocumentView,
  DocumentVersionView,
  MatterView,
  RunSummary,
  UploadWarningView,
  UserOption,
  WorkflowOption,
} from "../../services/views.js";
import { urls } from "../urls.js";
import { dateInputValue, formatBytes, formatDate, plural, shortHash } from "../views/format.js";
import {
  documentKindLabel,
  matterRoleLabel,
  progressStageLabel,
  runErrorMeaning,
  runStatusLabel,
  warningLabel,
  warningMeaning,
} from "../views/labels.js";
import { revealToString } from "../views/reveal.js";
import {
  Chip,
  Crumbs,
  Field,
  MatterStatusChip,
  RevealedText,
  RunStatusChip,
  ScrollBox,
  Section,
  Time,
  idPart,
} from "./components.js";
import { CONFIRM_VALUE, FIELDS } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";
import { ExportMemoForm, MemoList } from "./memos.js";
import { RetentionSection } from "./retention.js";

export interface MatterPageProps {
  chrome: Chrome;
  view: MatterView;
  /**
   * Demo identities, for the add-a-person form. Leave out to hide the form.
   */
  users?: UserOption[] | undefined;
  /**
   * Whether the signed-in user may delete the matter (its creator or an administrator). The view
   * does not say, so the route works it out from the database and passes it in.
   */
  canDelete: boolean;
}

/**
 * The words the service uses for a run in flight (START_REASONS.runInFlight in
 * services/phrases.ts). Pages may not import the services' code, so the sentence is written twice
 * and test/integration/layers.test.ts pins that the two are the same. When they are, the reason
 * the service lists is not repeated by the page.
 */
export const RUN_ALREADY_ACTIVE = "A review is already running";
const NOT_READY = "The matter is not ready for a review";

/** The URL the script polls for a run's progress. The route is in server/routes. */
export const runStatusUrl = (matterId: string, runId: string): string =>
  urls.runStatus(matterId, runId);

/**
 * The name of the select that chooses a workflow version on the start form. It is read by the
 * start route. It lives here and not in forms.ts because only this form uses it.
 */
export const WORKFLOW_FIELD = "workflow";

// ---------------------------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------------------------

function warningWhere(
  warning: UploadWarningView,
  documents: readonly { label: string; title: string }[],
): string {
  const doc = documents.find((d) => d.label === warning.documentLabel);
  const name =
    doc === undefined ? (warning.documentLabel ?? "Matter") : `${doc.title} (${doc.label})`;
  return warning.spanLabel === null ? name : `${warning.spanLabel} in ${name}`;
}

/** Warnings in plain words. `documents` lets a warning name the document it is about. */
export function WarningList(props: {
  warnings: UploadWarningView[];
  documents: readonly { label: string; title: string }[];
}) {
  if (props.warnings.length === 0) return null;
  return (
    <ul class="warning-list">
      {props.warnings.map((warning) => (
        <li class="warning">
          <Chip tone="warn" shape="triangle">
            {warningLabel(warning.code)}
          </Chip>
          <p>
            <strong>
              <RevealedText value={warningWhere(warning, props.documents)} />.
            </strong>{" "}
            {warningMeaning(warning.code)}
          </p>
          {warning.detail === "" ? null : (
            <p class="technical">
              Detail: <RevealedText value={warning.detail} />
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

function VersionRows(props: { doc: DocumentView; canWrite: boolean }) {
  const { doc } = props;
  return (
    <>
      {doc.versions.map((version) => {
        const dateFormId = `date-form-${idPart(version.versionId)}`;
        const radioId = `operative-${idPart(version.versionId)}`;
        const dateId = `stated-${idPart(version.versionId)}`;
        return (
          <tr>
            <td>
              {props.canWrite ? (
                <>
                  <input
                    type="radio"
                    id={radioId}
                    name={FIELDS.versionId}
                    value={version.versionId}
                    checked={version.operative}
                  />
                  <label for={radioId} class="sr-only">
                    {`Make version ${version.versionNo} of ${doc.label} operative`}
                  </label>
                </>
              ) : null}
              {version.operative ? (
                <Chip tone="info" shape="square">
                  Operative
                </Chip>
              ) : (
                <span class="muted">Not operative</span>
              )}
            </td>
            <th scope="row">Version {version.versionNo}</th>
            <td>
              {version.mediaType.toUpperCase()}, {formatBytes(version.byteSize)}
              <br />
              <span class="muted">sha </span>
              <code class="hash" title={version.fileSha256}>
                {shortHash(version.fileSha256)}
              </code>
            </td>
            <td>
              {props.canWrite ? (
                <div class="inline-edit">
                  <label for={dateId} class="sr-only">
                    {`Stated date of version ${version.versionNo} of ${doc.label}`}
                  </label>
                  <input
                    type="date"
                    id={dateId}
                    name={FIELDS.statedDate}
                    value={dateInputValue(version.statedDate)}
                    form={dateFormId}
                  />
                  <button
                    type="submit"
                    class="button button-small"
                    form={dateFormId}
                    aria-label={`Save stated date of version ${version.versionNo} of ${doc.label}`}
                  >
                    Save date
                  </button>
                </div>
              ) : version.statedDate === null ? (
                <span class="muted">Not entered</span>
              ) : (
                formatDate(version.statedDate)
              )}
            </td>
            <td>
              <Time value={version.uploadedAt} />
              <br />
              <span class="muted">
                by <RevealedText value={version.uploadedByName} />
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function DocumentCard(props: {
  chrome: Chrome;
  matterId: string;
  doc: DocumentView;
  canWrite: boolean;
  /**
   * Whether the service will take this document out. It refuses while a later document stands,
   * because the documents are labelled D1, D2, D3 in order and a gap cannot be read, so only the
   * last one is offered for removal.
   */
  removable: boolean;
}) {
  const { doc, matterId, chrome, canWrite } = props;
  const headingId = `doc-${idPart(doc.documentId)}-heading`;
  const operativeFormId = `operative-form-${idPart(doc.documentId)}`;
  const versionsTable = (
    <ScrollBox label={`Versions of ${doc.label}`}>
      <table class="data-table">
        <caption class="sr-only">{`Versions of ${doc.label} ${revealToString(doc.title)}`}</caption>
        <thead>
          <tr>
            <th scope="col">Operative</th>
            <th scope="col">Version</th>
            <th scope="col">File</th>
            <th scope="col">Stated date</th>
            <th scope="col">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          <VersionRows doc={doc} canWrite={canWrite} />
        </tbody>
      </table>
    </ScrollBox>
  );
  return (
    <article class="document" aria-labelledby={headingId}>
      <header class="document-head">
        <h3 id={headingId}>
          <span class="doc-label">{doc.label}</span> <RevealedText value={doc.title} />
        </h3>
        <Chip tone="neutral" shape="square">
          {documentKindLabel(doc.kind)}
        </Chip>
      </header>
      {canWrite ? (
        <form id={operativeFormId} method="post" action={urls.operative(matterId, doc.documentId)}>
          {csrfField(chrome.csrfToken)}
          {versionsTable}
          <div class="actions">
            <button type="submit" class="button">
              {`Save operative version of ${doc.label}`}
            </button>
          </div>
        </form>
      ) : (
        versionsTable
      )}
      {canWrite ? (
        <>
          {/* A form cannot sit inside the operative form, so the date forms follow it and the
              date fields in the table join them through the form attribute. */}
          {doc.versions.map((version) => (
            <DateForm chrome={chrome} matterId={matterId} version={version} />
          ))}
          <details class="disclosure">
            <summary>Upload a new version of {doc.label}</summary>
            <form
              method="post"
              enctype="multipart/form-data"
              action={urls.versions(matterId, doc.documentId)}
              class="stack"
            >
              {csrfField(chrome.csrfToken)}
              <Field id={`newver-file-${idPart(doc.documentId)}`} label="File (.docx or .txt)">
                <input
                  type="file"
                  id={`newver-file-${idPart(doc.documentId)}`}
                  name={FIELDS.file}
                  accept=".docx,.txt"
                  required
                />
              </Field>
              <Field
                id={`newver-date-${idPart(doc.documentId)}`}
                label="Stated date"
                hint="Uploading a new version makes any earlier review out of date."
              >
                <input
                  type="date"
                  id={`newver-date-${idPart(doc.documentId)}`}
                  name={FIELDS.statedDate}
                  aria-describedby={`newver-date-${idPart(doc.documentId)}-hint`}
                />
              </Field>
              <div class="actions">
                <button type="submit" class="button">
                  Upload new version
                </button>
              </div>
            </form>
          </details>
          {props.removable ? (
            <details class="disclosure disclosure-danger">
              <summary>Remove {doc.label} from this matter</summary>
              <form
                method="post"
                action={urls.documentRemove(matterId, doc.documentId)}
                class="stack"
              >
                {csrfField(chrome.csrfToken)}
                <div class="check">
                  <input
                    type="checkbox"
                    id={`remove-confirm-${idPart(doc.documentId)}`}
                    name={FIELDS.confirm}
                    value={CONFIRM_VALUE}
                    required
                  />
                  <label for={`remove-confirm-${idPart(doc.documentId)}`}>
                    {`I want to remove ${doc.label} and all its versions`}
                  </label>
                </div>
                <div class="actions">
                  <button type="submit" class="button button-danger">
                    Remove document
                  </button>
                </div>
              </form>
            </details>
          ) : (
            <p class="hint">{`To remove ${doc.label}, remove the documents after it first.`}</p>
          )}
        </>
      ) : null}
    </article>
  );
}

function DateForm(props: { chrome: Chrome; matterId: string; version: DocumentVersionView }) {
  const formId = `date-form-${idPart(props.version.versionId)}`;
  return (
    <form
      id={formId}
      method="post"
      action={urls.statedDate(props.matterId, props.version.versionId)}
    >
      {csrfField(props.chrome.csrfToken)}
    </form>
  );
}

function AddDocumentForm(props: { chrome: Chrome; view: MatterView }) {
  const { documents } = props.view;
  const hasNda = documents.some((d) => d.kind === "nda");
  const amendments = documents.filter((d) => d.kind === "amendment").length;
  const canAddNda = !hasNda && documents.length < DOC_LABELS.length;
  // The service refuses an amendment before the NDA (it would take the label D1), so it is not offered.
  const canAddAmendment = hasNda && amendments < 2 && documents.length < DOC_LABELS.length;
  if (!canAddNda && !canAddAmendment) {
    return (
      <p class="hint">
        A matter holds one NDA and up to two amendments. Remove a document to add another.
      </p>
    );
  }
  return (
    <form
      method="post"
      enctype="multipart/form-data"
      action={urls.documents(props.view.matter.id)}
      class="stack form-panel"
    >
      {csrfField(props.chrome.csrfToken)}
      <Field id="add-title" label="Document title" hint="What people call it, such as Mutual NDA.">
        <input
          type="text"
          id="add-title"
          name={FIELDS.title}
          required
          maxlength={200}
          autocomplete="off"
          aria-describedby="add-title-hint"
        />
      </Field>
      <Field id="add-kind" label="Kind">
        <select id="add-kind" name={FIELDS.kind}>
          {canAddNda ? <option value="nda">NDA</option> : null}
          {canAddAmendment ? <option value="amendment">Amendment</option> : null}
        </select>
      </Field>
      <Field
        id="add-date"
        label="Stated date"
        hint="The date the document bears. Parol uses it to tell which document is later, and never reads a date out of the text."
      >
        <input
          type="date"
          id="add-date"
          name={FIELDS.statedDate}
          aria-describedby="add-date-hint"
        />
      </Field>
      <Field id="add-file" label="File (.docx or .txt)">
        <input type="file" id="add-file" name={FIELDS.file} accept=".docx,.txt" required />
      </Field>
      <div class="actions">
        <button type="submit" class="button button-primary">
          Add document
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

function ActiveRun(props: {
  chrome: Chrome;
  matterId: string;
  run: RunSummary;
  canStart: boolean;
}) {
  const { run } = props;
  const progress = run.progress;
  return (
    <Section id="active-run" title="Review in progress">
      <div
        class="progress-box"
        role="status"
        aria-live="polite"
        data-run-live=""
        data-status-url={runStatusUrl(props.matterId, run.id)}
        data-run-status={run.status}
        data-run-stage={progress === null ? "" : progress.stage}
      >
        <p>
          <RunStatusChip status={run.status} />{" "}
          {progress === null ? (
            <span data-role="stage">{runStatusLabel(run.status)}</span>
          ) : (
            <>
              <span data-role="stage">{progressStageLabel(progress.stage)}</span>:{" "}
              <span data-role="done">{progress.done}</span> of{" "}
              <span data-role="total">{progress.total}</span>
            </>
          )}
        </p>
        <progress
          aria-label="Review progress"
          data-role="bar"
          value={progress === null ? undefined : progress.done}
          max={progress === null ? undefined : Math.max(progress.total, 1)}
        ></progress>
      </div>
      <p class="muted">
        Started by <RevealedText value={run.startedByName} /> on <Time value={run.startedAt} />.
        This page checks for progress every few seconds; you can also reload it.
      </p>
      {props.canStart ? (
        <form method="post" action={urls.runCancel(props.matterId, run.id)} class="inline-form">
          {csrfField(props.chrome.csrfToken)}
          <button type="submit" class="button">
            Cancel the review
          </button>
        </form>
      ) : null}
    </Section>
  );
}

function RunsTable(props: {
  chrome: Chrome;
  matterId: string;
  runs: RunSummary[];
  canStart: boolean;
}) {
  if (props.runs.length === 0) return <p class="empty">No review has been run yet.</p>;
  return (
    <ScrollBox label="Reviews run on this matter">
      <table class="data-table">
        <caption class="sr-only">Reviews run on this matter</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Status</th>
            <th scope="col">Findings</th>
            <th scope="col">Workflow and playbook</th>
            <th scope="col">Model</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((run) => (
            <tr>
              <th scope="row">
                <a href={urls.run(props.matterId, run.id)}>
                  <Time value={run.startedAt} />
                </a>
                <br />
                <span class="muted">
                  by <RevealedText value={run.startedByName} />
                </span>
              </th>
              <td>
                <RunStatusChip status={run.status} />
                {run.current ? (
                  <>
                    {" "}
                    <Chip tone="info" shape="circle">
                      Current
                    </Chip>
                  </>
                ) : run.status === "succeeded" ? (
                  <>
                    {" "}
                    <Chip tone="neutral" shape="bar">
                      Out of date
                    </Chip>
                  </>
                ) : null}
                {run.status === "failed" && run.errorKind !== null ? (
                  <p class="technical">{runErrorMeaning(run.errorKind)}</p>
                ) : null}
              </td>
              <td>
                {run.status === "succeeded" || run.findingCount > 0
                  ? plural(run.findingCount, "finding")
                  : "None yet"}
              </td>
              <td>
                <RevealedText value={run.workflowLabel} />
                <br />
                <span class="muted">
                  <RevealedText value={`${run.playbook.slug} ${run.playbook.version}`} />
                </span>
              </td>
              <td>
                <RevealedText
                  value={`${run.model.provider}, ${run.model.reported ?? run.model.requested}`}
                />
              </td>
              <td>
                {props.canStart && run.status === "failed" && (run.resumable ?? run.current) ? (
                  <form method="post" action={urls.runResume(props.matterId, run.id)}>
                    {csrfField(props.chrome.csrfToken)}
                    <button type="submit" class="button button-small">
                      Resume
                    </button>
                  </form>
                ) : props.canStart && run.status === "failed" ? (
                  <span class="muted">
                    {run.current
                      ? "Started on another model, start a new review"
                      : "Out of date, start a new review"}
                  </span>
                ) : (
                  <span class="muted">None</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollBox>
  );
}

/** `v2 (candidate)`, `v1 (pilot, default)`: the label, then what a person needs to choose by. */
function workflowOptionText(workflow: WorkflowOption): string {
  const notes = [workflow.status, ...(workflow.isDefault ? ["default"] : [])];
  return revealToString(`${workflow.label} (${notes.join(", ")})`);
}

function StartSection(props: { chrome: Chrome; view: MatterView; canStart: boolean }) {
  const { view } = props;
  const matterId = view.matter.id;
  const reasons = [...view.start.reasons];
  if (!view.start.ready && reasons.length === 0) reasons.push(NOT_READY);
  if (view.activeRun !== null && !reasons.includes(RUN_ALREADY_ACTIVE))
    reasons.push(RUN_ALREADY_ACTIVE);
  const blocked = reasons.length > 0;
  const hasEarlierRun = view.runs.length > 0;
  // A review with findings on it, started again, makes them stale and takes the decisions with them
  // (docs/parol/03). A matter that is already out of date has been told so by its banner.
  const replacesResults =
    view.matter.status === "in_review" ||
    view.matter.status === "review_complete" ||
    view.matter.status === "exported";
  return (
    <Section id="start" title={hasEarlierRun ? "Run the review again" : "Start the review"}>
      <p class="destination">
        <strong>Where document text is sent.</strong> <RevealedText value={view.destination} />
      </p>
      {props.canStart ? (
        <form method="post" action={urls.runs(matterId)} class="stack">
          {csrfField(props.chrome.csrfToken)}
          {blocked ? (
            <div class="reasons" id="start-reasons">
              <p>The review cannot start yet:</p>
              <ul>
                {reasons.map((reason) => (
                  <li>{reason}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p class="hint">
              Everything needed is in place. The review reads the operative documents and applies
              each playbook rule.
            </p>
          )}
          {replacesResults ? (
            <p class="hint" id="start-replaces">
              Running the review again replaces the findings on this matter. Decisions already made
              on them stop counting, and the new findings have to be decided again before a memo can
              be exported.
              {view.matter.status === "exported"
                ? " The memo already exported stays on record as the memo of the earlier review."
                : ""}
            </p>
          ) : null}
          {view.workflows !== undefined && view.workflows.length > 1 ? (
            <Field
              id="start-workflow"
              label="Workflow version"
              hint="The review records which workflow version made it, so two reviews can be compared."
            >
              <select
                id="start-workflow"
                name={WORKFLOW_FIELD}
                aria-describedby="start-workflow-hint"
              >
                {view.workflows.map((workflow) => (
                  <option value={workflow.label} selected={workflow.isDefault}>
                    {workflowOptionText(workflow)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div class="actions">
            <button
              type="submit"
              class="button button-primary"
              disabled={blocked}
              aria-describedby={blocked ? "start-reasons" : undefined}
            >
              {hasEarlierRun ? "Re-run review" : "Start review"}
            </button>
          </div>
        </form>
      ) : (
        <p class="hint">Only the associate on the matter can start a review.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// People and settings
// ---------------------------------------------------------------------------------------------

function SettingsSection(props: { chrome: Chrome; view: MatterView; canUpdate: boolean }) {
  const { view } = props;
  const matter = view.matter;
  const chosen = view.playbooks.find(
    (p) =>
      matter.playbook !== null &&
      p.slug === matter.playbook.slug &&
      p.version === matter.playbook.version,
  );
  if (!props.canUpdate) {
    return (
      <Section id="settings" title="Client and playbook">
        <dl class="facts">
          <dt>Our client</dt>
          <dd>
            <RevealedText value={matter.clientLegalName} />
          </dd>
          <dt>Playbook</dt>
          <dd>
            {matter.playbook === null ? (
              "None chosen"
            ) : (
              <RevealedText value={`${matter.playbook.slug} ${matter.playbook.version}`} />
            )}
          </dd>
        </dl>
      </Section>
    );
  }
  return (
    <Section id="settings" title="Client and playbook">
      <form method="post" action={urls.matterSettings(matter.id)} class="stack form-panel">
        {csrfField(props.chrome.csrfToken)}
        <Field
          id="settings-client"
          label="Our client"
          hint="The exact legal name. Changing the client or the playbook makes earlier results out of date."
        >
          <input
            type="text"
            id="settings-client"
            name={FIELDS.clientLegalName}
            value={matter.clientLegalName}
            required
            maxlength={300}
            autocomplete="off"
            aria-describedby="settings-client-hint"
          />
        </Field>
        <Field id="settings-playbook" label="Playbook">
          <select id="settings-playbook" name={FIELDS.playbookVersionId}>
            {chosen === undefined ? <option value="">Choose a playbook</option> : null}
            {view.playbooks.map((playbook) => (
              <option value={playbook.versionId} selected={playbook === chosen}>
                {revealToString(`${playbook.name} ${playbook.version}`)}, approved{" "}
                {formatDate(playbook.approvedAt)}, {plural(playbook.ruleCount, "rule")}
              </option>
            ))}
          </select>
        </Field>
        <div class="actions">
          <button type="submit" class="button">
            Save settings
          </button>
        </div>
      </form>
    </Section>
  );
}

function PeopleSection(props: {
  chrome: Chrome;
  view: MatterView;
  users: UserOption[] | undefined;
  canAdd: boolean;
}) {
  const { view } = props;
  const memberIds = new Set(view.members.map((m) => m.userId));
  const candidates = (props.users ?? []).filter((u) => !memberIds.has(u.userId));
  return (
    <Section
      id="people"
      title="People"
      note={
        view.segregationRelaxed
          ? "One person may both prepare and review on this matter, and the memo says so."
          : "The reviewing attorney is a different person from the associate."
      }
    >
      <ScrollBox label="People on this matter">
        <table class="data-table">
          <caption class="sr-only">People on this matter</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {view.members.map((member) => (
              <tr>
                <th scope="row">
                  <RevealedText value={member.displayName} />
                </th>
                <td>{matterRoleLabel(member.role)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
      {props.canAdd && candidates.length > 0 ? (
        <form method="post" action={urls.members(view.matter.id)} class="stack form-panel">
          {csrfField(props.chrome.csrfToken)}
          <Field id="member-user" label="Add a person">
            <select id="member-user" name={FIELDS.memberUserId} required>
              {candidates.map((user) => (
                <option value={user.userId}>{revealToString(user.displayName)}</option>
              ))}
            </select>
          </Field>
          <Field id="member-role" label="Role on this matter">
            <select id="member-role" name={FIELDS.memberRole}>
              {MATTER_ROLES.map((role) => (
                <option value={role} selected={role === "reviewer"}>
                  {matterRoleLabel(role)}
                </option>
              ))}
            </select>
          </Field>
          <div class="actions">
            <button type="submit" class="button">
              Add person
            </button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

export function MatterPage(props: MatterPageProps) {
  const { chrome, view } = props;
  const matter = view.matter;
  const role = matter.role;
  const relaxed = view.segregationRelaxed;
  const canWrite = roleAllows(role, "document.write");
  const canStart = roleAllows(role, "run.start");
  const canUpdate = roleAllows(role, "matter.update");
  const canAddMember = roleAllows(role, "member.add");
  const canExport = roleAllows(role, "memo.export", { relaxedSegregation: relaxed });

  const canRerun = canStart && view.start.ready && view.activeRun === null;

  // Why the memo cannot be exported right now, in the order a person would fix it.
  let exportBlocked: string | null = null;
  // Out of date comes first: a review that a new document made stale is not the current one, and
  // "no current review" would read as if nothing had ever been run.
  if (matter.status === "stale")
    exportBlocked = "The results are out of date. Run the review again first.";
  else if (view.currentRun === null) exportBlocked = "There is no current review to export.";
  else if (matter.status === "in_review")
    exportBlocked = "Every finding needs a current decision before the memo can be exported.";
  else if (matter.status !== "review_complete" && matter.status !== "exported")
    exportBlocked = "The review is not ready to export yet.";

  return (
    <Layout title={matter.name} chrome={chrome}>
      <Crumbs items={[{ label: "Matters", href: urls.matters() }, { label: matter.name }]} />
      <header class="matter-head">
        <h1>
          <RevealedText value={matter.name} />
        </h1>
        <p class="matter-meta">
          <MatterStatusChip status={matter.status} />{" "}
          <span>
            Our client:{" "}
            <strong>
              <RevealedText value={matter.clientLegalName} />
            </strong>
          </span>
          <span>Your role: {matterRoleLabel(role)}</span>
          {matter.synthetic ? null : (
            <Chip tone="warn" shape="triangle">
              Not marked synthetic
            </Chip>
          )}
        </p>
      </header>

      {view.staleReason === null ? null : (
        <section class="banner banner-stale" aria-labelledby="stale-heading">
          <h2 id="stale-heading">Results are out of date</h2>
          <p>{view.staleReason}</p>
          {view.runs.some((r) => r.findingCount > 0) ? (
            <p>
              Earlier decisions no longer apply and the memo cannot be exported until the review is
              run again and the new findings are decided.
            </p>
          ) : (
            <p>
              The review was stopped before it saved any findings, so there are no decisions to
              lose. Run it again to review the documents as they are now.
            </p>
          )}
          {canRerun ? (
            <form method="post" action={urls.runs(matter.id)}>
              {csrfField(chrome.csrfToken)}
              <button type="submit" class="button button-primary">
                Re-run review
              </button>
            </form>
          ) : canStart ? (
            <p class="hint">
              The review can be run again once everything needed is in place (see below).
            </p>
          ) : null}
        </section>
      )}

      {view.activeRun === null ? null : (
        <ActiveRun chrome={chrome} matterId={matter.id} run={view.activeRun} canStart={canStart} />
      )}

      <Section
        id="documents"
        title="Documents"
        note="Choose which version of each document is operative. Only operative versions are reviewed."
      >
        {view.documents.length === 0 ? (
          <p class="empty">No documents yet. Add the NDA first.</p>
        ) : (
          <div class="documents">
            {view.documents.map((doc, index) => (
              <DocumentCard
                chrome={chrome}
                matterId={matter.id}
                doc={doc}
                canWrite={canWrite}
                removable={index === view.documents.length - 1}
              />
            ))}
          </div>
        )}
        {canWrite ? (
          <>
            <h3>Add a document</h3>
            <AddDocumentForm chrome={chrome} view={view} />
          </>
        ) : null}
      </Section>

      {view.warnings.length === 0 ? null : (
        <Section
          id="warnings"
          title="Warnings"
          note="These do not stop a review. They point at things a person should look at."
        >
          <WarningList warnings={view.warnings} documents={view.documents} />
        </Section>
      )}

      <SettingsSection chrome={chrome} view={view} canUpdate={canUpdate} />

      <StartSection chrome={chrome} view={view} canStart={canStart} />

      <Section id="runs" title="Reviews">
        {view.currentRun === null ? null : (
          <p>
            <a class="button button-primary" href={urls.run(matter.id, view.currentRun.id)}>
              Open the issue table
            </a>{" "}
            <span class="muted">
              {plural(view.currentRun.findingCount, "finding")} in the current review
            </span>
          </p>
        )}
        <RunsTable chrome={chrome} matterId={matter.id} runs={view.runs} canStart={canStart} />
      </Section>

      <Section id="memos" title="Memos">
        <MemoList
          matterId={matter.id}
          memos={view.memos}
          currentRunId={view.currentRun?.id ?? null}
        />
        {canExport ? (
          <ExportMemoForm chrome={chrome} matterId={matter.id} blockedReason={exportBlocked} />
        ) : (
          <p class="hint">Only the reviewing attorney can export a memo.</p>
        )}
      </Section>

      <PeopleSection chrome={chrome} view={view} users={props.users} canAdd={canAddMember} />

      <RetentionSection
        chrome={chrome}
        matterId={matter.id}
        retention={view.retention}
        canUpdate={canUpdate}
      />

      {props.canDelete ? (
        <Section id="delete" title="Delete this matter">
          <p>
            This removes the matter, its documents, its findings and decisions, and its memos. It
            cannot be undone.
          </p>
          <details class="disclosure disclosure-danger">
            <summary>Delete this matter</summary>
            <form method="post" action={urls.matterDelete(matter.id)} class="stack">
              {csrfField(chrome.csrfToken)}
              <div class="check">
                <input
                  type="checkbox"
                  id="delete-confirm"
                  name={FIELDS.confirm}
                  value={CONFIRM_VALUE}
                  required
                />
                <label for="delete-confirm">
                  I want to delete this matter and everything in it
                </label>
              </div>
              <div class="actions">
                <button type="submit" class="button button-danger">
                  Delete matter
                </button>
              </div>
            </form>
          </details>
        </Section>
      ) : null}
    </Layout>
  );
}
