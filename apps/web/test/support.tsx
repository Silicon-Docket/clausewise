import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../src/App.js";
import type { TokenStorage } from "../src/api/token.js";
import { createServices, type Services } from "../src/services.js";
import { createFakeServer, type FakeOptions, type FakeServer } from "./fakeServer.js";

export interface Harness {
  server: FakeServer;
  services: Services;
  /** Files the app saved through the Blob path, as name and text. */
  saved: Array<{ name: string; blob: Blob }>;
  view: RenderResult;
}

/** A sessionStorage stand-in that a test can break. */
export function memoryStorage(): TokenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

export function installCommonHooks(): void {
  beforeEach(() => {
    window.location.hash = "";
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (globalThis as unknown as { jest?: unknown }).jest;
    vi.restoreAllMocks();
    window.location.hash = "";
    window.sessionStorage.clear();
  });
}

/**
 * Renders the whole app against a fake server, on the screen named by `hash`. The tests go through
 * the router, the services and the real client, so a wrong path or header fails them.
 */
export function renderApp(
  hash: string,
  options: FakeOptions & {
    server?: FakeServer;
    storage?: () => TokenStorage | null;
    userOptions?: Parameters<typeof userEvent.setup>[0];
  } = {},
): Harness & { user: ReturnType<typeof userEvent.setup> } {
  const server = options.server ?? createFakeServer(options);
  const saved: Harness["saved"] = [];
  const services = createServices({
    fetch: server.fetch,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    saveFile: (blob, name) => {
      saved.push({ name, blob });
    },
  });
  window.location.hash = hash;
  const user = userEvent.setup(options.userOptions ?? {});
  const view = render(<App services={services} />);
  return { server, services, saved, view, user };
}

/**
 * Fake timers for a test that waits on polling. setImmediate stays real, because the body of a
 * fetch response is read through it.
 */
export function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  // Testing Library moves the clock on by itself, but only when it finds a global called jest. Without
  // this, every user.click and findBy call under fake timers waits for a timer that never fires.
  const bridge = globalThis as unknown as { jest?: { advanceTimersByTime: (ms: number) => void } };
  bridge.jest = { advanceTimersByTime: (ms) => void vi.advanceTimersByTime(ms) };
}

/** Moves the fake clock on and lets everything that was waiting for it, React included, finish. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The text of the live region that announces changes to a screen reader. The page has one of
 * these outside its main content; the notices inside it that are statuses are not this one.
 */
export function announcer(): HTMLElement {
  const region = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
    (element) => element.closest("main") === null,
  );
  if (region === undefined) throw new Error("The page has no announcer.");
  return region;
}

export function announced(): string {
  return announcer().textContent ?? "";
}

/**
 * Counts the changes made to the announcer from now on, which is what a screen reader reacts to.
 * Records are collected as the observer delivers them and also taken from its queue, so that a
 * change is counted whether or not the browser has got round to delivering it yet.
 */
export function watchAnnouncer(): { changes: () => number; stop: () => void } {
  let seen = 0;
  const watch = new MutationObserver((records) => {
    seen += records.length;
  });
  watch.observe(announcer(), { childList: true, characterData: true, subtree: true });
  return {
    changes: () => {
      seen += watch.takeRecords().length;
      const total = seen;
      seen = 0;
      return total;
    },
    stop: () => {
      watch.disconnect();
    },
  };
}
