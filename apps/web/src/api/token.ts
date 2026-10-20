/**
 * Where the access token lives: in memory, and in sessionStorage so that a reload of the tab does
 * not ask again. Never a cookie, because a cookie would be sent with a request from another site;
 * and never localStorage, so that closing the tab forgets it. Storage can be missing or throw
 * (private windows, blocked site data), and the app must work without it.
 */

export interface TokenState {
  /** The token to send, or null. */
  token: string | null;
  /** The server refused the token that was held. Cleared when a new token is entered. */
  refused: boolean;
  /** The server answered 401, so the app has to ask for a token whatever the settings said. */
  demanded: boolean;
}

export interface TokenStore {
  get(): string | null;
  getState(): TokenState;
  set(token: string): void;
  /** Forgets the token. */
  clear(): void;
  /** The server answered 401: forget the token, and remember that it was refused if there was one. */
  reject(): void;
  subscribe(listener: () => void): () => void;
}

/** The part of `Storage` that the store uses. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The sessionStorage key. Exported so that a test can look at what is kept. */
export const TOKEN_STORAGE_KEY = "clausewise.access-token";

function defaultStorage(): TokenStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** `getStorage` is called at each use and every use is guarded, since even reading the property can throw. */
export function createTokenStore(
  getStorage: () => TokenStorage | null = defaultStorage,
): TokenStore {
  const read = (): string | null => {
    try {
      const value = getStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
      return value === null || value === "" ? null : value;
    } catch {
      return null;
    }
  };
  const write = (token: string | null): void => {
    try {
      const storage = getStorage();
      if (storage === null) return;
      if (token === null) storage.removeItem(TOKEN_STORAGE_KEY);
      else storage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // The token then lives in memory only, which is the point of the fallback.
    }
  };

  let state: TokenState = { token: read(), refused: false, demanded: false };
  const listeners = new Set<() => void>();
  const update = (next: TokenState): void => {
    if (
      next.token === state.token &&
      next.refused === state.refused &&
      next.demanded === state.demanded
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => state.token,
    getState: () => state,
    set(token) {
      const trimmed = token.trim();
      if (trimmed === "") return;
      write(trimmed);
      update({ token: trimmed, refused: false, demanded: false });
    },
    clear() {
      write(null);
      update({ token: null, refused: false, demanded: false });
    },
    reject() {
      // Several requests are usually in flight, and each one's 401 arrives here: the first one
      // takes the token away, and the others must not undo the note that it was refused.
      const refused = state.refused || state.token !== null;
      write(null);
      update({ token: null, refused, demanded: true });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
