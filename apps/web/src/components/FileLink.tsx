import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client.js";
import { useAnnounce } from "../hooks/useAnnounce.js";
import { useServices } from "../services.js";
import { Button } from "./Button.js";

/** What a finished download tells the screen. */
export interface SavedFile {
  /** The name the file was saved under. */
  fileName: string;
  /** Notes from the server about this file, in its words. Empty when there are none. */
  warnings: string[];
}

/**
 * A button that downloads a file the server offers. There is one way to do it, whether or not the
 * server asks for a token: the file is fetched with the Authorization header when a token is held,
 * the notes the server sent with it are read from the answer's headers, and the file is saved from
 * memory under the name the server suggested. A plain link could do neither of the last two. A
 * failed download shows the server's message next to the button and saves nothing.
 *
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
  /** Called once the file has been handed to the browser. */
  onSaved?: (saved: SavedFile) => void;
}) {
  const { path, label, fallbackName, variant, disabled = false, describedBy, onSaved } = props;
  const { api, saveFile } = useServices();
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

  const download = (): void => {
    setPending(true);
    setError(null);
    api
      .fetchFile(path)
      .then((file) => {
        const fileName = file.fileName ?? fallbackName;
        saveFile(file.blob, fileName);
        if (!mounted.current) return;
        onSaved?.({ fileName, warnings: file.warnings });
        // With notes to read the screen's own notice says so, in a live region that is already in
        // the page; saying it twice would talk over it.
        if (file.warnings.length === 0) announce(`The file was saved as ${fileName}.`);
      })
      .catch((failure: unknown) => {
        // The message is shown in an alert next to the button, which is read out by itself.
        if (mounted.current) setError(errorMessage(failure));
      })
      .finally(() => {
        if (mounted.current) setPending(false);
      });
  };

  return (
    <span className="file-link">
      <Button className={className} onClick={download} unavailable={pending} aria-busy={pending}>
        {pending ? "Preparing the file..." : label}
      </Button>
      {error === null ? null : (
        <span className="field-error message-text" role="alert">
          The file could not be downloaded. {error}
        </span>
      )}
    </span>
  );
}
