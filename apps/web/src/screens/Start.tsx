import { LIMITS, type DocumentSummary, type ReviewSummary } from "@clausewise/api";
import { useId, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { ApiClientError, errorMessage } from "../api/client.js";
import { Notice } from "../components/Notice.js";
import { useAnnounce } from "../hooks/useAnnounce.js";
import { useServerConfig } from "../hooks/useConfig.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle.js";
import { useLoad, type LoadState } from "../hooks/useLoad.js";
import {
  REVIEW_STATUS_LABEL,
  disclosureSentence,
  formatBytes,
  formatDateTime,
  startDisclosure,
} from "../lib/format.js";
import { hrefFor, navigate } from "../router.js";
import { useServices } from "../services.js";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What is wrong with the chosen file, in words, or null. Checked before anything is uploaded. */
export function checkFile(file: File, maxUploadBytes: number): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".doc")) {
    return "That is an old Word format (.doc), which cannot be read. Open it in Word, choose Save As, and save a .docx copy.";
  }
  if (!name.endsWith(".docx")) {
    return "That is not a Word .docx file. Clausewise reads .docx files only.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > maxUploadBytes) {
    return `That file is ${formatBytes(file.size)}, and the largest this server accepts is ${formatBytes(maxUploadBytes)}.`;
  }
  return null;
}

type Phase = "idle" | "uploading" | "starting";

export function StartScreen() {
  useDocumentTitle("");
  const { api } = useServices();
  const config = useServerConfig();
  const announce = useAnnounce();

  const playbooks = useLoad((signal) => api.listPlaybooks(signal), [api]);
  const recent = useLoad((signal) => api.listReviews(signal), [api]);

  const fileId = useId();
  const playbookFieldId = useId();
  const clientId = useId();
  const clientHintId = useId();
  const reasonId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [chosenPlaybook, setChosenPlaybook] = useState("");
  const [client, setClient] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // A file that was uploaded already is not uploaded again when only the review failed to start.
  const uploaded = useRef<{ file: File; document: DocumentSummary } | null>(null);
  // Set at once, where the phase state would only change on the next render.
  const inFlight = useRef(false);

  const model = config.model;
  const configured = model.configured;
  const playbookList = playbooks.state.status === "ready" ? playbooks.state.data : [];
  const builtIn = playbookList.filter((p) => p.source === "builtin");
  const custom = playbookList.filter((p) => p.source === "custom");
  const playbookId = chosenPlaybook !== "" ? chosenPlaybook : (playbookList[0]?.id ?? "");
  const busy = phase !== "idle";

  const choose = (candidate: File | null): void => {
    setError(null);
    if (candidate === null) {
      setFile(null);
      setFileProblem(null);
      return;
    }
    const problem = checkFile(candidate, config.maxUploadBytes);
    setFileProblem(problem);
    setFile(problem === null ? candidate : null);
    if (problem !== null) announce(problem);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    choose(event.target.files?.[0] ?? null);
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    choose(event.dataTransfer.files[0] ?? null);
  };
  const clearFile = (): void => {
    choose(null);
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  // The first thing that stops the review from starting, said out loud next to the button.
  const blocker = !configured
    ? "The model is not set up, so reviews cannot start yet."
    : file === null
      ? "Choose a contract to start."
      : playbookId === ""
        ? "There is no playbook to review against. Add one under Playbooks."
        : null;

  const start = async (): Promise<void> => {
    if (file === null || playbookId === "" || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      let document = uploaded.current?.file === file ? uploaded.current.document : null;
      if (document === null) {
        setPhase("uploading");
        document = await api.uploadDocument(file);
        uploaded.current = { file, document };
      }
      setPhase("starting");
      const trimmed = client.trim();
      const review: ReviewSummary = await api.createReview({
        documentId: document.id,
        playbookId,
        ...(trimmed === "" ? {} : { client: trimmed }),
      });
      navigate({ name: "review", id: review.id });
    } catch (failure) {
      // The stored copy is gone or was refused; the next try uploads the file again.
      if (failure instanceof ApiClientError && failure.status === 404) uploaded.current = null;
      const message = errorMessage(failure);
      setError(message);
      announce(`The review did not start. ${message}`);
      setPhase("idle");
      inFlight.current = false;
    }
  };
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (blocker === null) void start();
  };

  return (
    <div>
      <h1>Review a contract</h1>

      {model.configured ? (
        <p className="model-line">
          Model: {model.model} ({model.provider}). {disclosureSentence(model.disclosure)}
        </p>
      ) : (
        <Notice kind="error" title="The model is not set up">
          <p>{model.problem}</p>
          <p>
            Fix this in the settings of the server that runs Clausewise, restart it, and reload this
            page.
          </p>
        </Notice>
      )}

      <form className="start-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <span className="field-label" id={`${fileId}-label`}>
            Contract
          </span>
          <div
            className={`dropzone${dragging ? " dropzone-active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input
              ref={fileInput}
              id={fileId}
              className="visually-hidden file-input"
              type="file"
              accept={`.docx,${DOCX_TYPE}`}
              disabled={busy}
              aria-describedby={fileProblem === null ? undefined : `${fileId}-problem`}
              onChange={onFileInput}
            />
            {file === null ? (
              <p className="dropzone-text">Drop a Word file (.docx) here, or</p>
            ) : (
              <p className="dropzone-text">
                <strong>{file.name}</strong> ({formatBytes(file.size)})
              </p>
            )}
            <div className="dropzone-actions">
              <label htmlFor={fileId} className="button">
                {file === null ? "Choose a Word file" : "Choose a different file"}
              </label>
              {file === null ? null : (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={clearFile}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          {fileProblem === null ? null : (
            <p id={`${fileId}-problem`} className="field-error" role="alert">
              {fileProblem}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={playbookFieldId}>
            Playbook
          </label>
          {playbooks.state.status === "error" ? (
            <Notice kind="error">
              <p>The playbooks could not be loaded. {playbooks.state.message}</p>
              <button type="button" className="button" onClick={playbooks.reload}>
                Try again
              </button>
            </Notice>
          ) : (
            <select
              id={playbookFieldId}
              className="input"
              value={playbookId}
              disabled={busy || playbooks.state.status === "loading"}
              onChange={(event) => setChosenPlaybook(event.target.value)}
            >
              {playbooks.state.status === "loading" ? <option value="">Loading...</option> : null}
              {builtIn.length === 0 ? null : (
                <optgroup label="Built in">
                  {builtIn.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.ruleCount} rules)
                    </option>
                  ))}
                </optgroup>
              )}
              {custom.length === 0 ? null : (
                <optgroup label="Yours">
                  {custom.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.ruleCount} rules)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={clientId}>
            Who are you acting for? (optional)
          </label>
          <input
            id={clientId}
            className="input"
            type="text"
            value={client}
            maxLength={LIMITS.maxClientChars}
            placeholder="Fabrikam Labs LLC, the Recipient"
            aria-describedby={clientHintId}
            disabled={busy}
            onChange={(event) => setClient(event.target.value)}
          />
          <p id={clientHintId} className="hint">
            Playbooks say "we". This says who that is, in your words, and the findings are better
            for it.
          </p>
        </div>

        {error === null ? null : (
          <Notice kind="error" title="The review did not start">
            <p>{error}</p>
          </Notice>
        )}

        <div className="start-actions">
          {model.configured ? (
            <p className="start-disclosure">{startDisclosure(model.disclosure)}</p>
          ) : null}
          <button
            type="submit"
            className="button button-primary button-large"
            disabled={blocker !== null || busy}
            aria-describedby={blocker === null ? undefined : reasonId}
            aria-busy={busy}
          >
            {phase === "uploading"
              ? "Uploading the contract..."
              : phase === "starting"
                ? "Starting the review..."
                : "Start review"}
          </button>
          {blocker === null ? null : (
            <p id={reasonId} className="hint">
              {blocker}
            </p>
          )}
        </div>
      </form>

      <RecentReviews state={recent.state} reload={recent.reload} />
    </div>
  );
}

function RecentReviews(props: { state: LoadState<ReviewSummary[]>; reload: () => void }) {
  const { state, reload } = props;
  const headingId = useId();
  return (
    <section className="recent" aria-labelledby={headingId}>
      <h2 id={headingId}>Recent reviews</h2>
      {state.status === "loading" ? <p className="muted">Loading...</p> : null}
      {state.status === "error" ? (
        <Notice kind="error">
          <p>The recent reviews could not be loaded. {state.message}</p>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
        </Notice>
      ) : null}
      {state.status === "ready" && state.data.length === 0 ? (
        <p className="empty">No reviews yet. The ones you start will be listed here.</p>
      ) : null}
      {state.status === "ready" && state.data.length > 0 ? (
        <ul className="review-list">
          {state.data.map((review) => (
            <li key={review.id}>
              <a className="review-link" href={hrefFor({ name: "review", id: review.id })}>
                {review.documentName}
              </a>
              <span className={`status status-${review.status}`}>
                {REVIEW_STATUS_LABEL[review.status]}
                {review.status === "running" && review.progress.total > 0
                  ? `, ${review.progress.done} of ${review.progress.total} rules`
                  : ""}
              </span>
              <span className="meta">
                {review.playbookName}. {formatDateTime(review.createdAt)}.
                {review.open === null
                  ? ""
                  : ` Open: ${review.open.high} high, ${review.open.medium} medium, ${review.open.low} low.`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
