import type { ConfigResponse } from "@clausewise/api";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { errorMessage, isAbortError } from "../api/client.js";
import { useServices } from "../services.js";

export type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: ConfigResponse }
  | { status: "error"; message: string };

/**
 * Reads `/api/config` once. It needs no token, so it can say whether to ask for one. `reload`
 * asks again, for the retry button and for after the model settings were fixed.
 */
export function useConfig(): { state: ConfigState; reload: () => void } {
  const { api } = useServices();
  const [state, setState] = useState<ConfigState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getConfig(controller.signal)
      .then((config) => {
        setState({ status: "ready", config });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      controller.abort();
    };
  }, [api, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, reload };
}

const ConfigContext = createContext<ConfigResponse | null>(null);

export function ConfigProvider(props: { config: ConfigResponse; children: ReactNode }) {
  return <ConfigContext.Provider value={props.config}>{props.children}</ConfigContext.Provider>;
}

/** The server's settings, for a screen that is only shown once they are known. */
export function useServerConfig(): ConfigResponse {
  const config = useContext(ConfigContext);
  if (config === null) throw new Error("ConfigProvider is missing above this component.");
  return config;
}
