import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client.js";
import { useServerConfig } from "../hooks/useConfig.js";
import { useAnnounce } from "../hooks/useAnnounce.js";
import { useServices, useTokenState } from "../services.js";

/**
 * A link to a file the server offers. When the server needs no token this is an ordinary anchor,
 * so the browser does the download and the address can be copied. When a token is needed a link
 * cannot carry it, so the file is fetched with the Authorization header and saved from memory.
 * A disabled one is a disabled button; the reason is shown by whoever places it.
 */
export function FileLink(props: {
  path: string;
  label: string;
  /** The name to save under when the server suggests none. */
  fallbackName: string;
  variant: "primary" | "secondary" | "link";
  disabled?: boolean;
  /** The id of the element that says why it is disabled. */
  describedBy?: string;
}) {
  const { path, label, fallbackName, variant, disabled = false, describedBy } = props;
  const { authRequired } = useServerConfig();
  const { api, saveFile } = useServices();
  // A token held is a token needed, whatever the settings said when the page loaded.
  const needsToken = authRequired || useTokenState().token !== null;
  const announce = useAnnounce();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const className = variant === "link" ? "link-button" : `button button-${variant}`;

  if (disabled) {
    return (
      <button
        type="button"
        className={className}
        disabled
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      >
        {label}
      </button>
    );
  }

  if (!needsToken) {
    return (
      <a className={className} href={path} download>
        {label}
      </a>
    );
  }

  const download = (): void => {
    setPending(true);
    setError(null);
    api
      .fetchFile(path)
      .then((file) => {
        saveFile(file.blob, file.fileName ?? fallbackName);
        announce(`${label}: the file was saved.`);
      })
      .catch((failure: unknown) => {
        const message = errorMessage(failure);
        if (mounted.current) setError(message);
        announce(`The file could not be downloaded. ${message}`);
      })
      .finally(() => {
        if (mounted.current) setPending(false);
      });
  };

  return (
    <span className="file-link">
      <button
        type="button"
        className={className}
        onClick={download}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Preparing the file..." : label}
      </button>
      {error === null ? null : (
        <span className="field-error" role="alert">
          The file could not be downloaded. {error}
        </span>
      )}
    </span>
  );
}
