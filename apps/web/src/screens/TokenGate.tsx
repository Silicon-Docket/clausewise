import { useId, useState, type FormEvent } from "react";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/Button.js";
import { Notice } from "../components/Notice.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle.js";
import { useServices, useTokenState } from "../services.js";

/**
 * Asks for the access token. The token is tried against the server before it is kept, so a wrong
 * one is said so here and not as an error on some other screen. It is kept in this tab only.
 */
export function TokenGate() {
  useDocumentTitle("Access token");
  const { api, tokens } = useServices();
  const state = useTokenState();
  const fieldId = useId();
  const hintId = useId();
  const problemId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const token = value.trim();
    if (token === "") {
      setProblem("Enter the access token.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (await api.checkToken(token)) {
        tokens.set(token);
      } else {
        setProblem("That token was not accepted. Check it and try again.");
      }
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="token-gate">
      <h1>This server asks for an access token</h1>
      <p>
        Whoever runs Clausewise set a token that every request must carry. Ask them for it, or find
        it in the settings of the server (CLAUSEWISE_ACCESS_TOKEN).
      </p>
      {state.refused ? (
        <Notice kind="warning">
          <p>The server did not accept the token this page was using. Enter it again.</p>
        </Notice>
      ) : null}
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label className="field-label" htmlFor={fieldId}>
            Access token
          </label>
          <input
            id={fieldId}
            className="input"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            aria-describedby={problem === null ? hintId : `${hintId} ${problemId}`}
            aria-invalid={problem !== null}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
          />
          <p id={hintId} className="hint">
            The token is kept in this browser tab until you close it. It is never stored in a
            cookie.
          </p>
        </div>
        {problem === null ? null : (
          <p id={problemId} className="field-error message-text" role="alert">
            {problem}
          </p>
        )}
        <Button type="submit" className="button button-primary" unavailable={busy} aria-busy={busy}>
          {busy ? "Checking..." : "Continue"}
        </Button>
      </form>
    </div>
  );
}
