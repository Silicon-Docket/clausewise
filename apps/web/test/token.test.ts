// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY, createTokenStore, type TokenStorage } from "../src/api/token.js";
import { memoryStorage } from "./support.js";

describe("token store", () => {
  it("starts with the token the tab already holds", () => {
    const storage = memoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, "kept-from-before");
    const store = createTokenStore(() => storage);
    expect(store.get()).toBe("kept-from-before");
    expect(store.getState()).toEqual({
      token: "kept-from-before",
      refused: false,
      demanded: false,
    });
  });

  it("starts with no token when none is kept", () => {
    expect(createTokenStore(() => memoryStorage()).get()).toBeNull();
  });

  it("keeps a new token in memory and in the tab's storage, without the spaces around it", () => {
    const storage = memoryStorage();
    const store = createTokenStore(() => storage);
    store.set("  secret-token-value \n");
    expect(store.get()).toBe("secret-token-value");
    expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe("secret-token-value");
  });

  it("ignores an empty token", () => {
    const storage = memoryStorage();
    const store = createTokenStore(() => storage);
    store.set("   ");
    expect(store.get()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("forgets the token everywhere on clear", () => {
    const storage = memoryStorage();
    const store = createTokenStore(() => storage);
    store.set("secret-token-value");
    store.clear();
    expect(store.get()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("forgets a refused token and remembers that it was refused", () => {
    const storage = memoryStorage();
    const store = createTokenStore(() => storage);
    store.set("old-token-value");
    store.reject();
    expect(store.getState()).toEqual({ token: null, refused: true, demanded: true });
    expect(storage.data.size).toBe(0);
    store.set("new-token-value");
    expect(store.getState()).toEqual({ token: "new-token-value", refused: false, demanded: false });
  });

  it("keeps the note that the token was refused when a second request is refused as well", () => {
    // Two requests are in flight when the server turns the token down; both come back with 401.
    const store = createTokenStore(() => memoryStorage());
    store.set("old-token-value");
    store.reject();
    store.reject();
    expect(store.getState()).toEqual({ token: null, refused: true, demanded: true });
  });

  it("does not call a token refused that was never held, but still demands one", () => {
    const store = createTokenStore(() => memoryStorage());
    store.reject();
    expect(store.getState()).toEqual({ token: null, refused: false, demanded: true });
  });

  it("tells listeners about a change, and only about a change", () => {
    const store = createTokenStore(() => memoryStorage());
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.set("secret-token-value");
    expect(listener).toHaveBeenCalledTimes(1);
    store.set("secret-token-value");
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    store.set("another-token-value");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("gives the same state object until something changes", () => {
    const store = createTokenStore(() => memoryStorage());
    expect(store.getState()).toBe(store.getState());
    const before = store.getState();
    store.clear();
    expect(store.getState()).toBe(before);
  });
});

describe("token store when storage fails", () => {
  const throwing: TokenStorage = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  it("works from memory when every storage call throws", () => {
    const store = createTokenStore(() => throwing);
    expect(store.get()).toBeNull();
    store.set("secret-token-value");
    expect(store.get()).toBe("secret-token-value");
    store.reject();
    expect(store.get()).toBeNull();
    store.set("secret-token-value");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("works when even looking up the storage throws", () => {
    const store = createTokenStore(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    store.set("secret-token-value");
    expect(store.get()).toBe("secret-token-value");
  });

  it("works when there is no storage at all", () => {
    const store = createTokenStore(() => null);
    store.set("secret-token-value");
    expect(store.get()).toBe("secret-token-value");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("uses the tab's sessionStorage by default", () => {
    window.sessionStorage.clear();
    const store = createTokenStore();
    store.set("secret-token-value");
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("secret-token-value");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(document.cookie).not.toContain("secret-token-value");
    window.sessionStorage.clear();
  });
});
