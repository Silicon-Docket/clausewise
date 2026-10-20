import { useMemo, useSyncExternalStore } from "react";

/**
 * A hash router, small enough to read in one go. The server serves one page, so the screens live
 * after the `#`: nothing here needs the server to know about them, and a reload or a bookmark lands
 * on the same screen.
 */

export type Route =
  | { name: "start" }
  | { name: "review"; id: string }
  | { name: "playbooks" }
  | { name: "not-found" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) return { name: "start" };
  if (parts[0] === "playbooks" && parts.length === 1) return { name: "playbooks" };
  if (parts[0] === "reviews" && parts.length === 2) {
    const raw = parts[1] ?? "";
    try {
      const id = decodeURIComponent(raw);
      if (id !== "") return { name: "review", id };
    } catch {
      // A broken escape is not a review we can ask for.
    }
  }
  return { name: "not-found" };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "start":
      return "#/";
    case "review":
      return `#/reviews/${encodeURIComponent(route.id)}`;
    case "playbooks":
      return "#/playbooks";
    case "not-found":
      return "#/";
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
  };
}

const currentHash = (): string => window.location.hash;

/** The current hash, as text so that React can compare it; parse it with `parseHash`. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, currentHash, () => "");
}

export function useRoute(): Route {
  const hash = useHash();
  return useMemo(() => parseHash(hash), [hash]);
}
