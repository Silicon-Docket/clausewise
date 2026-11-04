import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { urls } from "../urls.js";
import { revealToString } from "../views/reveal.js";
import { Chip, RevealedText, type ShapeName, type Tone } from "./components.js";
import { CSRF_FIELD, FIELDS, SIGN_OUT_INTENT } from "./forms.js";

/**
 * The frame every page shares. The content security policy forbids inline script, inline style
 * and event-handler attributes, so nothing in these pages uses one: behaviour lives in
 * /assets/parol.js, appearance in /assets/parol.css, and both are read from the same origin.
 */

/** The banner is permanent and is part of the product. A test pins its exact words. */
export const DEMO_BANNER = "DEMO: synthetic documents, demo identity, not for client work";

export interface Notice {
  kind: "success" | "error" | "info";
  /** A fixed phrase written by the application. Never document text. */
  text: string;
}

/** What every page needs to know about the request, from the session and not from a form. */
export interface Chrome {
  /** The signed-in user's name, or null before sign-in. */
  userName: string | null;
  /** The token every form posts back, issued for this session. */
  csrfToken: string;
  /** A message to show once, such as the result of the last action. */
  notice?: Notice | null;
}

export interface LayoutProps {
  title: string;
  chrome: Chrome;
  children?: Child;
  /** Use the full width, for the issue table and its inspector. */
  wide?: boolean;
}

/** The hidden field every form must contain. */
export function csrfField(token: string) {
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

/** What each kind of notice is called, and the chip that says so without colour. */
const NOTICE_LOOK: Record<Notice["kind"], { label: string; tone: Tone; shape: ShapeName }> = {
  success: { label: "Done", tone: "ok", shape: "circle" },
  info: { label: "Note", tone: "info", shape: "square" },
  error: { label: "Problem", tone: "bad", shape: "triangle" },
};

export function NoticeBox({ notice }: { notice: Notice }) {
  // A route could pass a kind this list lacks; it is then a plain note, never a class from data.
  const kind: Notice["kind"] = Object.hasOwn(NOTICE_LOOK, notice.kind) ? notice.kind : "info";
  const look = NOTICE_LOOK[kind];
  return (
    <div class={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <p>
        <Chip tone={look.tone} shape={look.shape}>
          {look.label}
        </Chip>{" "}
        {notice.text}
      </p>
    </div>
  );
}

export function Layout({ title, chrome, children, wide }: LayoutProps) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <meta name="referrer" content="same-origin" />
          <meta name="robots" content="noindex" />
          <title>{`${revealToString(title)} | Parol`}</title>
          <link rel="stylesheet" href={urls.asset("parol.css")} />
          <script src={urls.asset("parol.js")} defer></script>
        </head>
        <body>
          <a class="skip-link" href="#main">
            Skip to main content
          </a>
          <div class="demo-banner" role="note">
            <strong>{DEMO_BANNER}</strong>
          </div>
          <header class="site-header">
            <div class="site-header-inner">
              <a class="brand" href={urls.matters()}>
                Parol
              </a>
              <nav aria-label="Primary">
                <ul class="nav-list">
                  <li>
                    <a href={urls.matters()}>Matters</a>
                  </li>
                </ul>
              </nav>
              {chrome.userName === null ? null : (
                <div class="whoami">
                  <span>
                    Signed in as{" "}
                    <strong>
                      <RevealedText value={chrome.userName} />
                    </strong>
                  </span>
                  <form method="post" action={urls.session()} class="inline-form">
                    {csrfField(chrome.csrfToken)}
                    <input type="hidden" name={FIELDS.intent} value={SIGN_OUT_INTENT} />
                    <button type="submit" class="button button-quiet">
                      Sign out
                    </button>
                  </form>
                </div>
              )}
            </div>
          </header>
          <main id="main" tabindex={-1} class={wide ? "page page-wide" : "page"}>
            {chrome.notice ? <NoticeBox notice={chrome.notice} /> : null}
            {children}
          </main>
          <footer class="site-footer">
            <p>
              Parol drafts findings for an attorney to review. It does not give legal advice. Every
              document here is synthetic.
            </p>
          </footer>
        </body>
      </html>
    </>
  );
}

/** Renders a page to the string a route sends. Pages are synchronous, so this never waits. */
export function render(node: { toString(): string | Promise<string> }): string {
  const out = node.toString();
  if (typeof out !== "string") throw new Error("a page rendered asynchronously");
  return out;
}
