import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isAbortError } from "../api/client.js";

export type LoadState<T> =
  { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/**
 * Runs a read when the screen opens and again whenever `deps` change or `reload` is called. An
 * answer that arrives after the screen has moved on is dropped: the previous read is aborted.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      controller.abort();
    };
    // `deps` is the caller's list of what the read depends on, so the list is spread on purpose.
  }, [...deps, attempt]);

  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload };
}
