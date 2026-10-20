import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "./api/client.js";
import {
  createTokenStore,
  type TokenState,
  type TokenStorage,
  type TokenStore,
} from "./api/token.js";
import { saveBlob, type SaveFile } from "./lib/download.js";

/**
 * What the screens share: the API client, the token, and the way a fetched file is saved. They are
 * built once at start and handed in, so that a test can give the app a fake fetch and a spy for
 * saving.
 */
export interface Services {
  api: ApiClient;
  tokens: TokenStore;
  saveFile: SaveFile;
}

export function createServices(options: {
  fetch: typeof globalThis.fetch;
  /** Where the token is kept between reloads. Default: this tab's sessionStorage. */
  storage?: () => TokenStorage | null;
  saveFile?: SaveFile;
}): Services {
  const tokens =
    options.storage === undefined ? createTokenStore() : createTokenStore(options.storage);
  const api = createApiClient({
    fetch: options.fetch,
    getToken: () => tokens.get(),
    onUnauthorized: () => {
      tokens.reject();
    },
  });
  return { api, tokens, saveFile: options.saveFile ?? saveBlob };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider(props: { services: Services; children: ReactNode }) {
  return (
    <ServicesContext.Provider value={props.services}>{props.children}</ServicesContext.Provider>
  );
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("ServicesProvider is missing above this component.");
  return services;
}

export function useTokenState(): TokenState {
  const { tokens } = useServices();
  return useSyncExternalStore(
    (listener) => tokens.subscribe(listener),
    () => tokens.getState(),
  );
}
