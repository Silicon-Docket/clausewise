import { useEffect, useRef } from "react";

/**
 * Calls `tick` again and again while `enabled` is true: the first call comes one interval after
 * the hook is enabled, and each next call one interval after the previous one has finished, so
 * two requests are never in flight at once. When `enabled` turns false or the component goes away,
 * the pending timer is cleared and the call in progress is aborted through its signal, so nothing
 * runs or sets state after that.
 */
export function usePolling(options: {
  enabled: boolean;
  intervalMs: number;
  tick: (signal: AbortSignal) => Promise<void>;
}): void {
  const { enabled, intervalMs } = options;
  // The latest tick is read when it is called, so a new closure does not restart the timer.
  const tickRef = useRef(options.tick);
  useEffect(() => {
    tickRef.current = options.tick;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = undefined;
        void run();
      }, intervalMs);
    };
    const run = async (): Promise<void> => {
      try {
        await tickRef.current(controller.signal);
      } catch {
        // The tick reports its own failures. A throw here must not stop the polling.
      }
      if (!controller.signal.aborted) schedule();
    };

    schedule();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}
